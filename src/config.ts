import { dbPath, get, run } from "./db";

type ConfigRow = {
  key: string;
  value: string;
  secret: number;
  updated_at: string;
};

const SECRET_KEYS = new Set([
  "auth_session_secret",
  "google_client_secret",
  "mcp_token",
  "pagespeed_api_key",
]);

const APP_PREFERENCE_KEYS = new Set([
  "codex_model",
  "codex_reasoning_effort",
  "default_location_code",
  "default_language_code",
  "default_crawl_protocol",
  "default_crawl_host",
  "default_crawl_speed",
  "default_crawl_max_pages",
]);

export function isAppPreferenceKey(key: string) {
  return APP_PREFERENCE_KEYS.has(key);
}

export function getConfigValue(key: string): string {
  const envKey = key.toUpperCase();
  const envValue =
    process.env[envKey] ||
    (key === "google_client_id" ? process.env.GOOGLE_CLIENT_ID : undefined) ||
    (key === "google_client_secret" ? process.env.GOOGLE_CLIENT_SECRET : undefined) ||
    (key === "mcp_token" ? process.env.MCP_TOKEN : undefined);
  if (envValue) return envValue.trim();
  const row = get<ConfigRow>("SELECT * FROM app_config WHERE key = ?", [key]);
  return row?.value?.trim() || "";
}

export function getStoredConfigValue(key: string): string {
  const row = get<ConfigRow>("SELECT * FROM app_config WHERE key = ?", [key]);
  return row?.value?.trim() || "";
}

export function setConfigValue(key: string, value: string) {
  run(
    `
    INSERT INTO app_config (key, value, secret, updated_at)
    VALUES (?, ?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(key) DO UPDATE SET
      value = excluded.value,
      secret = excluded.secret,
      updated_at = CURRENT_TIMESTAMP
    `,
    [key, value.trim(), SECRET_KEYS.has(key) ? 1 : 0],
  );
}

export function listPublicConfig(): Record<string, string | boolean | number> {
  const keys = [
    "google_client_id",
    "google_client_secret",
    "mcp_token",
    "pagespeed_api_key",
    "openserp_url",
    "searxng_url",
    "codex_model",
    "codex_reasoning_effort",
    "default_location_code",
    "default_language_code",
    "default_crawl_protocol",
    "default_crawl_host",
    "default_crawl_speed",
    "default_crawl_max_pages",
  ];
  const config: Record<string, string | boolean> = Object.fromEntries(
    keys.map((key) => {
      const value = isAppPreferenceKey(key) ? getStoredConfigValue(key) : getConfigValue(key);
      return [key, SECRET_KEYS.has(key) ? Boolean(value) : value];
    }),
  );
  return {
    ...config,
    local_db_path: dbPath,
    local_site_count: get<{ count: number }>("SELECT count(*) AS count FROM sites")?.count || 0,
    local_scan_count: get<{ count: number }>("SELECT count(*) AS count FROM scans")?.count || 0,
    local_gsc_import_count: get<{ count: number }>("SELECT count(*) AS count FROM gsc_imports")?.count || 0,
  };
}

// The URL the browser app is opened on (the Vite dev server in development,
// the API itself in production). OAuth redirects and CORS use it.
export function appUrl() {
  return process.env.APP_URL?.trim() || "http://localhost:5173";
}

export function codexModel() {
  return getConfigValue("codex_model") || process.env.CODEX_MODEL || "";
}

export function codexReasoningEffort() {
  return (
    getConfigValue("codex_reasoning_effort") ||
    process.env.CODEX_REASONING_EFFORT ||
    "medium"
  );
}

// Optional Google API key for PageSpeed Insights (PAGESPEED_API_KEY). PSI also
// answers without a key, with a small shared quota.
export function pageSpeedApiKey() {
  return getConfigValue("pagespeed_api_key");
}

// PAGESPEED_API_URL points PageSpeed requests elsewhere (the smoke test uses a
// local fixture).
export function pageSpeedApiUrl() {
  return process.env.PAGESPEED_API_URL?.trim() || "https://www.googleapis.com/pagespeedonline/v5/runPagespeed";
}
