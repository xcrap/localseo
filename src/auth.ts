import { createHash, createHmac, pbkdf2, randomBytes, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";
import { getStoredConfigValue, setConfigValue } from "./config";
import { get, run } from "./db";
import { badRequest } from "./errors";

const pbkdf2Async = promisify(pbkdf2);

export type AdminUser = {
  id: string;
  email: string;
  password_hash: string;
  salt: string;
  created_at: string;
  updated_at: string;
};

export type PublicAdminUser = {
  id: string;
  email: string;
};

export type AuthConfig = {
  sessionSecret: string;
  sessionCookieName: string;
  sessionTtlSeconds: number;
  rememberSessionTtlSeconds: number;
};

export function getAuthConfig(): AuthConfig {
  return {
    sessionSecret: getSessionSecret(),
    sessionCookieName: "local_seo_session",
    sessionTtlSeconds: Number(process.env.AUTH_SESSION_TTL_SECONDS || 60 * 60 * 24 * 7),
    rememberSessionTtlSeconds: Number(
      process.env.AUTH_SESSION_REMEMBER_TTL_SECONDS || 60 * 60 * 24 * 30,
    ),
  };
}

function getSessionSecret() {
  const stored = getStoredConfigValue("auth_session_secret");
  if (stored) return stored;

  const sessionSecret = randomBytes(32).toString("hex");
  setConfigValue("auth_session_secret", sessionSecret);
  return sessionSecret;
}

export function publicUser(user: AdminUser): PublicAdminUser {
  return { id: user.id, email: user.email };
}

export function getAdminUserCount(): number {
  const row = get<{ count: number }>("SELECT count(*) AS count FROM admin_users");
  return Number(row?.count || 0);
}

export function getAdminByEmail(email: string): AdminUser | undefined {
  return get<AdminUser>("SELECT * FROM admin_users WHERE lower(email) = lower(?)", [
    email.trim(),
  ]);
}

export function getAdminById(id: string): AdminUser | undefined {
  return get<AdminUser>("SELECT * FROM admin_users WHERE id = ?", [id]);
}

// Constant-time string comparison for secrets (bearer tokens). Hashing first
// makes both sides the same length, so the comparison leaks neither content nor length.
export function secretsEqual(actual: string, expected: string) {
  const left = createHash("sha256").update(actual).digest();
  const right = createHash("sha256").update(expected).digest();
  return timingSafeEqual(left, right);
}

// Async so a login (210k PBKDF2 rounds) does not block every other request.
export async function hashPassword(password: string, salt = randomBytes(16).toString("hex")) {
  const hash = (await pbkdf2Async(password, salt, 210_000, 32, "sha256")).toString("hex");
  return { salt, hash };
}

export async function verifyPassword(user: AdminUser, password: string): Promise<boolean> {
  const { hash } = await hashPassword(password, user.salt);
  const expected = Buffer.from(user.password_hash, "hex");
  const actual = Buffer.from(hash, "hex");
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

// Creating the admin or changing its password signs out every existing session.
export async function createOrReplaceAdmin(email: string, password: string): Promise<PublicAdminUser> {
  const normalizedEmail = email.trim().toLowerCase();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(normalizedEmail)) {
    throw badRequest("A valid email is required.");
  }
  if (password.length < 10) {
    throw badRequest("Password must be at least 10 characters.");
  }
  const id = "local-admin";
  const { salt, hash } = await hashPassword(password);
  run(
    `
    INSERT INTO admin_users (id, email, password_hash, salt, updated_at)
    VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(id) DO UPDATE SET
      email = excluded.email,
      password_hash = excluded.password_hash,
      salt = excluded.salt,
      updated_at = CURRENT_TIMESTAMP
    `,
    [id, normalizedEmail, hash, salt],
  );
  run("DELETE FROM admin_sessions WHERE user_id = ?", [id]);
  const user = getAdminById(id);
  if (!user) throw new Error("Failed to save admin user.");
  return publicUser(user);
}

// A session is a row in admin_sessions; the cookie carries its id signed with
// the local session secret. Deleting the row (logout, password change) revokes
// the cookie immediately even though it has not expired yet.
export function createSessionToken(
  userId: string,
  config = getAuthConfig(),
  ttlSeconds = config.sessionTtlSeconds,
): string {
  const sessionId = randomBytes(32).toString("hex");
  const expiresAt = Date.now() + ttlSeconds * 1000;
  run("DELETE FROM admin_sessions WHERE expires_at < ?", [Date.now()]);
  run("INSERT INTO admin_sessions (id, user_id, expires_at) VALUES (?, ?, ?)", [sessionId, userId, expiresAt]);
  const payload = Buffer.from(JSON.stringify({ sid: sessionId, uid: userId, exp: expiresAt })).toString("base64url");
  return `${payload}.${sign(payload, config)}`;
}

function sign(payload: string, config: AuthConfig) {
  return createHmac("sha256", config.sessionSecret).update(payload).digest("base64url");
}

function readSessionToken(token: string | undefined, config: AuthConfig) {
  if (!token) return null;
  const [payload, signature] = token.split(".");
  if (!payload || !signature) return null;
  const expectedBuf = Buffer.from(sign(payload, config));
  const signatureBuf = Buffer.from(signature);
  if (expectedBuf.length !== signatureBuf.length || !timingSafeEqual(expectedBuf, signatureBuf)) {
    return null;
  }
  try {
    const parsed = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as {
      sid?: string;
      uid?: string;
      exp?: number;
    };
    if (!parsed.sid || !parsed.uid || !parsed.exp || parsed.exp < Date.now()) return null;
    return { sessionId: parsed.sid, userId: parsed.uid };
  } catch {
    return null;
  }
}

export function verifySessionToken(
  token: string | undefined,
  config = getAuthConfig(),
): string | null {
  const session = readSessionToken(token, config);
  if (!session) return null;
  const row = get<{ user_id: string }>(
    "SELECT user_id FROM admin_sessions WHERE id = ? AND expires_at > ?",
    [session.sessionId, Date.now()],
  );
  return row?.user_id === session.userId ? session.userId : null;
}

export function revokeSessionToken(token: string | undefined, config = getAuthConfig()) {
  const session = readSessionToken(token, config);
  if (session) run("DELETE FROM admin_sessions WHERE id = ?", [session.sessionId]);
}

// In-memory brute-force guard for the login form: after too many failed
// attempts for one email, further attempts (even correct ones) wait until the
// window resets. An attempt counts as failed from the moment it starts (before
// the slow password check), so parallel attempts cannot all slip under the
// limit; a successful sign-in clears the count.
const LOGIN_MAX_FAILURES = 5;
const LOGIN_WINDOW_MS = 15 * 60 * 1000;
const loginFailures = new Map<string, { count: number; resetAt: number }>();

function loginKey(email: string) {
  return email.trim().toLowerCase();
}

// Seconds to wait when the limit is reached (the attempt is not counted), else
// 0 after counting this attempt.
export function beginLoginAttempt(email: string) {
  const key = loginKey(email);
  const now = Date.now();
  const entry = loginFailures.get(key);
  if (!entry || entry.resetAt <= now) {
    loginFailures.set(key, { count: 1, resetAt: now + LOGIN_WINDOW_MS });
    return 0;
  }
  if (entry.count >= LOGIN_MAX_FAILURES) return Math.ceil((entry.resetAt - now) / 1000);
  entry.count += 1;
  return 0;
}

export function clearLoginFailures(email: string) {
  loginFailures.delete(loginKey(email));
}
