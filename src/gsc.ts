import { randomBytes, randomUUID } from "node:crypto";
import { appUrl, getConfigValue } from "./config";
import { type CsvRow, csvRow, csvText, parseCsvNumber, parseCsvRows } from "./csv";
import { all, get, jsonParse, run, transaction } from "./db";
import { HttpError, badRequest, notFound } from "./errors";
import { requireDate } from "./input";
import { getSite } from "./seo";

const GSC_SCOPE = "https://www.googleapis.com/auth/webmasters.readonly";
const GSC_CALLBACK_PATH = "/api/gsc/callback";
const GOOGLE_TIMEOUT_MS = 30_000;
const OAUTH_STATE_TTL_MS = 10 * 60 * 1000;
// Google caps one Search Analytics response at 25,000 rows; syncs page with
// startRow until a short page. The page cap only guards against a runaway loop.
const GSC_MAX_ROW_LIMIT = 25_000;
const GSC_MAX_SYNC_PAGES = 200;

type GscConnection = {
  id: string;
  site_id: string;
  site_url: string;
  access_token: string;
  refresh_token: string;
  expires_at: number;
  auth_error: string;
};

export type GscImportRecord = {
  id: string;
  site_id: string;
  site_url: string;
  source_name: string;
  source: string;
  dimensions_json: string;
  row_count: number;
  totals_json: string;
  rows_json: string;
  start_date: string | null;
  end_date: string | null;
  created_at: string;
};

// Metrics stay null when a CSV cell is empty or unparseable instead of
// becoming a made-up zero.
type ImportedGscPerformanceRow = {
  keys: string[];
  clicks: number | null;
  impressions: number | null;
  ctr: number | null;
  position: number | null;
};

const DIMENSION_ALIASES: Record<string, string[]> = {
  query: ["query", "queries", "top query", "top queries", "keyword", "keywords"],
  page: ["page", "pages", "top page", "top pages", "url", "landing page", "landing pages"],
  country: ["country", "countries"],
  device: ["device", "devices"],
  date: ["date", "day"],
};

const DIMENSION_ORDER = ["query", "page", "country", "device", "date"];
const METRIC_ALIASES = {
  clicks: ["clicks"],
  impressions: ["impressions"],
  ctr: ["ctr", "click through rate", "click-through rate"],
  position: ["position", "avg position", "average position"],
};

function googleClientConfig() {
  return {
    clientId: getConfigValue("google_client_id"),
    clientSecret: getConfigValue("google_client_secret"),
  };
}

// The one redirect URI to register on the Google OAuth client:
// APP_URL + /api/gsc/callback (http://localhost:5173/api/gsc/callback by default).
export function gscRedirectUri() {
  return `${appUrl().replace(/\/$/, "")}${GSC_CALLBACK_PATH}`;
}

// Redirect URI used before the fixed one: the callback path with ?siteId=.
function legacyRedirectUri(siteId: string) {
  return `${gscRedirectUri()}?siteId=${encodeURIComponent(siteId)}`;
}

function getConnection(siteId: string) {
  return get<GscConnection>("SELECT * FROM gsc_connections WHERE site_id = ?", [siteId]);
}

function hasTokens(connection: GscConnection | undefined) {
  return Boolean(connection?.refresh_token || connection?.access_token);
}

export function gscStatus(siteId: string) {
  const connection = getConnection(siteId);
  const config = googleClientConfig();
  return {
    configured: Boolean(config.clientId && config.clientSecret),
    connected: hasTokens(connection) && !connection?.auth_error,
    // Google rejected the saved grant (revoked, expired, or missing refresh
    // token): the connection exists but must be reconnected before any query.
    needsReconnect: Boolean(connection && (connection.auth_error || !hasTokens(connection))),
    authError: connection?.auth_error || "",
    redirectUri: gscRedirectUri(),
    // No Google account email: the only OAuth scope is webmasters.readonly,
    // which does not reveal who signed in.
    connection: connection
      ? {
          siteId,
          siteUrl: connection.site_url,
          expiresAt: connection.expires_at,
        }
      : null,
  };
}

// The OAuth state is a random single-use value stored server-side with the
// site it belongs to, so the callback trusts neither the URL's siteId nor a
// state it did not issue.
export function createGscAuthUrl(siteId: string) {
  const config = googleClientConfig();
  if (!config.clientId || !config.clientSecret) {
    throw badRequest("Google client id and secret are required.");
  }
  if (!getSite(siteId)) throw notFound("Site not found.");
  const state = randomBytes(32).toString("base64url");
  const redirectUri = gscRedirectUri();
  run("DELETE FROM gsc_oauth_states WHERE expires_at < ?", [Date.now()]);
  run("INSERT INTO gsc_oauth_states (state, site_id, redirect_uri, expires_at) VALUES (?, ?, ?, ?)", [
    state,
    siteId,
    redirectUri,
    Date.now() + OAUTH_STATE_TTL_MS,
  ]);
  const url = new URL("https://accounts.google.com/o/oauth2/v2/auth");
  url.searchParams.set("client_id", config.clientId);
  url.searchParams.set("redirect_uri", redirectUri);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", GSC_SCOPE);
  url.searchParams.set("access_type", "offline");
  url.searchParams.set("prompt", "consent");
  url.searchParams.set("state", state);
  return url.toString();
}

// legacySiteId is set when Google redirects to the old per-site callback
// (?siteId=...); it must agree with the site stored for the state.
export async function handleGscCallback(input: {
  state: string;
  code: string;
  error?: string;
  legacySiteId?: string;
}) {
  const stored = input.state
    ? get<{ site_id: string; redirect_uri: string; expires_at: number }>(
        "SELECT * FROM gsc_oauth_states WHERE state = ?",
        [input.state],
      )
    : undefined;
  if (stored) run("DELETE FROM gsc_oauth_states WHERE state = ?", [input.state]);
  if (!stored || stored.expires_at < Date.now()) {
    throw badRequest("This Google sign-in link is invalid or expired. Start the Search Console connection again.");
  }
  if (input.legacySiteId && input.legacySiteId !== stored.site_id) {
    throw badRequest("The Google sign-in response does not match the site that started it.");
  }
  if (input.error) throw badRequest(`Google did not grant access: ${input.error}`);
  if (!input.code) throw badRequest("Google did not return an authorization code.");
  const config = googleClientConfig();
  if (!config.clientId || !config.clientSecret) {
    throw badRequest("Google client id and secret are required.");
  }
  const { response, data: token } = await googleRequest("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code: input.code,
      client_id: config.clientId,
      client_secret: config.clientSecret,
      redirect_uri: input.legacySiteId ? legacyRedirectUri(stored.site_id) : stored.redirect_uri,
      grant_type: "authorization_code",
    }),
  });
  if (!response.ok) {
    throw new HttpError(502, `Google OAuth failed: ${JSON.stringify(token).slice(0, 300)}`);
  }
  saveGscConnection({
    siteId: stored.site_id,
    accessToken: String(token.access_token || ""),
    refreshToken: String(token.refresh_token || ""),
    expiresIn: Number(token.expires_in || 3600),
  });
  return gscStatus(stored.site_id);
}

function saveGscConnection(input: {
  siteId: string;
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
}) {
  const existing = getConnection(input.siteId);
  const refreshToken = input.refreshToken || existing?.refresh_token || "";
  run(
    `
    INSERT INTO gsc_connections
      (id, site_id, access_token, refresh_token, expires_at, auth_error, updated_at)
    VALUES (?, ?, ?, ?, ?, '', CURRENT_TIMESTAMP)
    ON CONFLICT(site_id) DO UPDATE SET
      access_token = excluded.access_token,
      refresh_token = excluded.refresh_token,
      expires_at = excluded.expires_at,
      auth_error = '',
      updated_at = CURRENT_TIMESTAMP
    `,
    [
      existing?.id || randomUUID(),
      input.siteId,
      input.accessToken,
      refreshToken,
      Date.now() + input.expiresIn * 1000,
    ],
  );
}

// Every Google call gets a timeout so a stalled request cannot hang a route.
async function googleRequest(url: string, init: RequestInit = {}) {
  let response: Response;
  try {
    response = await fetch(url, { ...init, signal: AbortSignal.timeout(GOOGLE_TIMEOUT_MS) });
  } catch (error) {
    if (error instanceof Error && error.name === "TimeoutError") {
      throw new HttpError(504, `Google did not respond within ${GOOGLE_TIMEOUT_MS / 1000} seconds.`);
    }
    throw error;
  }
  const data = await response.json().catch(() => ({}));
  return { response, data: data as any };
}

function reconnectError(connection: GscConnection) {
  return new HttpError(
    409,
    `Google Search Console access was revoked or expired (${connection.auth_error || "no refresh token"}). Reconnect Google Search Console.`,
  );
}

async function getAccessToken(siteId: string) {
  const connection = getConnection(siteId);
  if (!connection) throw badRequest("Google Search Console is not connected.");
  if (connection.auth_error) throw reconnectError(connection);
  if (connection.access_token && connection.expires_at > Date.now() + 60_000) {
    return connection.access_token;
  }
  if (!connection.refresh_token) {
    run("UPDATE gsc_connections SET auth_error = ? WHERE site_id = ?", ["Missing Google refresh token.", siteId]);
    throw reconnectError({ ...connection, auth_error: "Missing Google refresh token." });
  }
  const config = googleClientConfig();
  const { response, data: token } = await googleRequest("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: config.clientId,
      client_secret: config.clientSecret,
      refresh_token: connection.refresh_token,
      grant_type: "refresh_token",
    }),
  });
  if (!response.ok) {
    // invalid_grant: the refresh token was revoked, expired, or belongs to a
    // different client. Only a new consent fixes it.
    if (token?.error === "invalid_grant" || token?.error === "unauthorized_client") {
      const reason = String(token.error_description || token.error);
      run("UPDATE gsc_connections SET auth_error = ?, updated_at = CURRENT_TIMESTAMP WHERE site_id = ?", [reason, siteId]);
      throw reconnectError({ ...connection, auth_error: reason });
    }
    throw new HttpError(502, `Google token refresh failed: ${JSON.stringify(token).slice(0, 300)}`);
  }
  saveGscConnection({
    siteId,
    accessToken: String(token.access_token || ""),
    refreshToken: connection.refresh_token,
    expiresIn: Number(token.expires_in || 3600),
  });
  return String(token.access_token || "");
}

// Calls a Google API with the site's token. A 401 means the access token was
// rejected early, so it is dropped and the call retried once after a refresh.
async function authorizedGoogleRequest(siteId: string, url: string, init: RequestInit = {}) {
  for (const attempt of [1, 2]) {
    const accessToken = await getAccessToken(siteId);
    const result = await googleRequest(url, {
      ...init,
      headers: { ...(init.headers || {}), Authorization: `Bearer ${accessToken}` },
    });
    if (result.response.status !== 401 || attempt === 2) return result;
    run("UPDATE gsc_connections SET expires_at = 0 WHERE site_id = ?", [siteId]);
  }
  throw new Error("Unreachable");
}

export async function listGscSites(siteId: string) {
  const { response, data } = await authorizedGoogleRequest(siteId, "https://www.googleapis.com/webmasters/v3/sites");
  if (!response.ok) throw new HttpError(502, `GSC sites failed: ${JSON.stringify(data).slice(0, 300)}`);
  return data.siteEntry || [];
}

export function setGscSite(siteId: string, siteUrl: unknown) {
  const property = typeof siteUrl === "string" ? siteUrl.trim() : "";
  if (!property || property === "undefined") throw badRequest("Choose a Search Console property.");
  if (!getConnection(siteId)) throw badRequest("Google Search Console is not connected.");
  run(
    "UPDATE gsc_connections SET site_url = ?, updated_at = CURRENT_TIMESTAMP WHERE site_id = ?",
    [property, siteId],
  );
  return gscStatus(siteId);
}

function dateWindow(input: { startDate?: unknown; endDate?: unknown }) {
  const startDate = requireDate(input.startDate, "startDate");
  const endDate = requireDate(input.endDate, "endDate");
  if (startDate > endDate) throw badRequest("startDate must be on or before endDate.");
  return { startDate, endDate };
}

function canonicalDimension(value: string) {
  const normalized = normalizeHeader(value);
  return DIMENSION_ORDER.find((dimension) =>
    [dimension, ...(DIMENSION_ALIASES[dimension] || [])].some(
      (alias) => normalizeHeader(alias) === normalized,
    ),
  );
}

function dimensionList(value: unknown) {
  if (Array.isArray(value)) return value.map(String);
  return String(value ?? "")
    .split(/[,|]/)
    .map((item) => item.trim())
    .filter(Boolean);
}

// Requested API dimensions in a fixed order (query, page, country, device,
// date), so "page,query" and "query,page" name the same row set.
function apiDimensions(value: unknown, fallback = ["query"]) {
  const raw = dimensionList(value);
  const dimensions = raw.map(canonicalDimension);
  const unknown = raw.filter((_, index) => !dimensions[index]);
  if (unknown.length) throw badRequest(`Unsupported Search Console dimension: ${unknown.join(", ")}.`);
  const set = new Set(dimensions as string[]);
  return set.size ? DIMENSION_ORDER.filter((dimension) => set.has(dimension)) : fallback;
}

function gscPropertyFor(siteId: string, siteUrl?: unknown) {
  const property = (typeof siteUrl === "string" && siteUrl.trim()) || getConnection(siteId)?.site_url || "";
  if (!property) throw badRequest("Choose a Search Console property first.");
  return property;
}

async function searchAnalyticsPage(
  siteId: string,
  property: string,
  body: { startDate: string; endDate: string; dimensions: string[]; rowLimit: number; startRow: number },
) {
  const { response, data } = await authorizedGoogleRequest(
    siteId,
    `https://www.googleapis.com/webmasters/v3/sites/${encodeURIComponent(property)}/searchAnalytics/query`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    },
  );
  if (!response.ok) {
    throw new HttpError(502, `GSC performance failed: ${JSON.stringify(data).slice(0, 300)}`);
  }
  return data;
}

// One live page of Search Analytics, not stored. Use syncGscPerformance to
// fetch every row and save it locally.
export async function queryGscPerformance(input: {
  siteId?: string;
  siteUrl?: string;
  startDate?: unknown;
  endDate?: unknown;
  dimensions?: unknown;
  rowLimit?: unknown;
  startRow?: unknown;
}) {
  const siteId = String(input.siteId || "");
  if (!siteId) throw badRequest("Site id is required.");
  const { startDate, endDate } = dateWindow(input);
  const property = gscPropertyFor(siteId, input.siteUrl);
  const rowLimit = Math.max(1, Math.min(GSC_MAX_ROW_LIMIT, Math.round(Number(input.rowLimit)) || 1000));
  const startRow = Math.max(0, Math.round(Number(input.startRow)) || 0);
  const data = await searchAnalyticsPage(siteId, property, {
    startDate,
    endDate,
    dimensions: apiDimensions(input.dimensions),
    rowLimit,
    startRow,
  });
  const rows = Array.isArray(data.rows) ? data.rows : [];
  return { ...data, rows, startRow, rowLimit, hasMore: rows.length === rowLimit };
}

// Fetches every Search Analytics row for the window (paging with startRow)
// and stores them as one gsc_imports batch with source 'api', so API syncs and
// CSV imports are read the same way through listGscRows.
export async function syncGscPerformance(input: {
  siteId?: string;
  siteUrl?: string;
  startDate?: unknown;
  endDate?: unknown;
  dimensions?: unknown;
}) {
  const siteId = String(input.siteId || "");
  const site = getSite(siteId);
  if (!site) throw notFound("Site not found.");
  const { startDate, endDate } = dateWindow(input);
  const dimensions = apiDimensions(input.dimensions);
  const property = gscPropertyFor(siteId, input.siteUrl);
  const rows: ImportedGscPerformanceRow[] = [];
  let pagesFetched = 0;
  let truncated = false;
  while (true) {
    if (pagesFetched >= GSC_MAX_SYNC_PAGES) {
      truncated = true;
      break;
    }
    const data = await searchAnalyticsPage(siteId, property, {
      startDate,
      endDate,
      dimensions,
      rowLimit: GSC_MAX_ROW_LIMIT,
      startRow: rows.length,
    });
    pagesFetched += 1;
    const page = Array.isArray(data.rows) ? data.rows : [];
    for (const row of page) {
      rows.push({
        keys: (Array.isArray(row.keys) ? row.keys : []).map((key: unknown) => String(key ?? "")),
        clicks: finiteOrNull(row.clicks),
        impressions: finiteOrNull(row.impressions),
        ctr: finiteOrNull(row.ctr),
        position: finiteOrNull(row.position),
      });
    }
    if (page.length < GSC_MAX_ROW_LIMIT) break;
  }
  const batch = saveGscBatch({
    siteId,
    siteUrl: property,
    sourceName: `Search Console API ${startDate} to ${endDate}`,
    source: "api",
    dimensions,
    startDate,
    endDate,
    rows,
  });
  return { ...batch, pagesFetched, truncated };
}

function finiteOrNull(value: unknown) {
  const number = Number(value);
  return value !== null && value !== undefined && Number.isFinite(number) ? number : null;
}

function normalizeHeader(value: string) {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "");
}

function parseCtr(value: unknown) {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  const raw = String(value ?? "").trim();
  const number = parseCsvNumber(raw);
  if (number === null) return null;
  return raw.includes("%") || number > 1 ? number / 100 : number;
}

function inferGscDimensions(rows: Record<string, unknown>[]) {
  const sample = rows[0] || {};
  if (Array.isArray((sample as { keys?: unknown }).keys)) return ["query"];
  const headers = new Set(Object.keys(sample).map(normalizeHeader));
  const dimensions = DIMENSION_ORDER.filter((dimension) =>
    DIMENSION_ALIASES[dimension].some((alias) => headers.has(normalizeHeader(alias))),
  );
  return dimensions.length ? dimensions : ["query"];
}

function normalizeGscDimensions(
  dimensions: unknown,
  rows: Record<string, unknown>[],
) {
  const canonical = dimensionList(dimensions).map(canonicalDimension).filter(Boolean) as string[];
  return canonical.length ? [...new Set(canonical)] : inferGscDimensions(rows);
}

function csvMetric(row: CsvRow, raw: Record<string, unknown>, metric: keyof typeof METRIC_ALIASES) {
  const direct = raw[metric];
  if (typeof direct === "number") return Number.isFinite(direct) ? direct : null;
  return metric === "ctr"
    ? parseCtr(direct ?? csvText(row, METRIC_ALIASES.ctr))
    : parseCsvNumber(direct ?? csvText(row, METRIC_ALIASES[metric]));
}

function normalizeGscImportRow(
  raw: Record<string, unknown>,
  dimensions: string[],
): ImportedGscPerformanceRow {
  const row = csvRow(raw);
  const keys = Array.isArray((raw as { keys?: unknown[] }).keys)
    ? ((raw as { keys: unknown[] }).keys || []).map((key) => String(key ?? "").trim())
    : dimensions.map((dimension) => csvText(row, DIMENSION_ALIASES[dimension] || [dimension]));
  return {
    keys,
    clicks: csvMetric(row, raw, "clicks"),
    impressions: csvMetric(row, raw, "impressions"),
    ctr: csvMetric(row, raw, "ctr"),
    position: csvMetric(row, raw, "position"),
  };
}

function rowHasGscEvidence(row: ImportedGscPerformanceRow) {
  return row.keys.some(Boolean) || [row.clicks, row.impressions, row.ctr, row.position].some((value) => value !== null);
}

function computeGscTotals(rows: ImportedGscPerformanceRow[]) {
  let clicks = 0;
  let impressions = 0;
  let weightedPosition = 0;
  let weightedImpressions = 0;
  for (const row of rows) {
    clicks += row.clicks ?? 0;
    impressions += row.impressions ?? 0;
    if (row.position !== null && row.impressions !== null) {
      weightedPosition += row.position * row.impressions;
      weightedImpressions += row.impressions;
    }
  }
  return {
    clicks: Math.round(clicks),
    impressions: Math.round(impressions),
    ctr: impressions ? clicks / impressions : null,
    position: weightedImpressions ? weightedPosition / weightedImpressions : null,
  };
}

function mapGscImport(row: GscImportRecord) {
  return {
    id: row.id,
    siteId: row.site_id,
    siteUrl: row.site_url,
    sourceName: row.source_name,
    source: row.source,
    dimensions: jsonParse<string[]>(row.dimensions_json, []),
    rowCount: row.row_count,
    totals: jsonParse<Record<string, number | null>>(row.totals_json, {}),
    startDate: row.start_date,
    endDate: row.end_date,
    createdAt: row.created_at,
  };
}

const GSC_ROW_COLUMNS = "query, page, country, device, date, clicks, impressions, ctr, position";

function saveGscBatch(input: {
  siteId: string;
  siteUrl: string;
  sourceName: string;
  source: "csv" | "api";
  dimensions: string[];
  startDate: string | null;
  endDate: string | null;
  rows: ImportedGscPerformanceRow[];
}) {
  const id = randomUUID();
  transaction(() => {
    run(
      `
      INSERT INTO gsc_imports
        (id, site_id, site_url, source_name, source, dimensions_json, row_count, totals_json, rows_json, start_date, end_date)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, '[]', ?, ?)
      `,
      [
        id,
        input.siteId,
        input.siteUrl,
        input.sourceName,
        input.source,
        JSON.stringify(input.dimensions),
        input.rows.length,
        JSON.stringify(computeGscTotals(input.rows)),
        input.startDate,
        input.endDate,
      ],
    );
    insertGscRows(id, input.siteId, input.dimensions, input.rows);
  });
  return mapGscImport(requireGscImport(input.siteId, id));
}

function insertGscRows(importId: string, siteId: string, dimensions: string[], rows: ImportedGscPerformanceRow[]) {
  const columnIndex = Object.fromEntries(DIMENSION_ORDER.map((dimension) => [dimension, dimensions.indexOf(dimension)]));
  const keyFor = (row: ImportedGscPerformanceRow, dimension: string) =>
    columnIndex[dimension] >= 0 ? row.keys[columnIndex[dimension]] ?? null : null;
  for (const row of rows) {
    run(
      `INSERT INTO gsc_rows (import_id, site_id, ${GSC_ROW_COLUMNS}) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        importId,
        siteId,
        keyFor(row, "query"),
        keyFor(row, "page"),
        keyFor(row, "country"),
        keyFor(row, "device"),
        keyFor(row, "date"),
        row.clicks,
        row.impressions,
        row.ctr,
        row.position,
      ],
    );
  }
}

function requireGscImport(siteId: string, importId: string) {
  const record = get<GscImportRecord>("SELECT * FROM gsc_imports WHERE id = ? AND site_id = ?", [importId, siteId]);
  if (!record) throw notFound("Search Console import not found.");
  return record;
}

// Imports saved before gsc_rows existed keep their rows in rows_json. The
// first read copies them into gsc_rows (rows_json is left as it was).
export function ensureGscRows(record: GscImportRecord) {
  if (!record.row_count || get("SELECT 1 FROM gsc_rows WHERE import_id = ? LIMIT 1", [record.id])) return;
  const rows = jsonParse<ImportedGscPerformanceRow[]>(record.rows_json, []);
  if (!rows.length) return;
  transaction(() =>
    insertGscRows(record.id, record.site_id, jsonParse<string[]>(record.dimensions_json, []), rows),
  );
}

// Rows in the legacy { keys, clicks, impressions, ctr, position } shape.
function gscImportRows(record: GscImportRecord) {
  ensureGscRows(record);
  const dimensions = jsonParse<string[]>(record.dimensions_json, []);
  return all<Record<string, any>>(`SELECT ${GSC_ROW_COLUMNS} FROM gsc_rows WHERE import_id = ? ORDER BY id`, [
    record.id,
  ]).map((row) => ({
    keys: dimensions.map((dimension) => row[dimension] ?? ""),
    clicks: row.clicks,
    impressions: row.impressions,
    ctr: row.ctr,
    position: row.position,
  }));
}

// Import and sync history: metadata and totals only. Rows load on demand
// through getGscImport or listGscRows.
export function listGscImports(siteId: string) {
  return all<GscImportRecord>(
    "SELECT * FROM gsc_imports WHERE site_id = ? ORDER BY created_at DESC",
    [siteId],
  ).map(mapGscImport);
}

export function getGscImport(siteId: string, importId: string) {
  const record = requireGscImport(siteId, importId);
  return { ...mapGscImport(record), rows: gscImportRows(record) };
}

export function importGscPerformance(input: {
  siteId?: string;
  siteUrl?: string;
  sourceName?: string;
  dimensions?: unknown;
  startDate?: unknown;
  endDate?: unknown;
  csv?: unknown;
  rows?: unknown;
}) {
  const siteId = String(input.siteId || "");
  if (!siteId) throw badRequest("Site id is required.");
  const site = getSite(siteId);
  if (!site) throw notFound("Site not found.");
  const rawRows =
    typeof input.csv === "string" && input.csv.trim()
      ? parseCsvRows(input.csv, "Search Console CSV").rows
      : Array.isArray(input.rows)
        ? input.rows
        : [];
  if (!rawRows.length) {
    throw badRequest("Import file has no Search Console rows.");
  }
  const dimensions = normalizeGscDimensions(input.dimensions, rawRows);
  const rows = rawRows
    .map((row) => normalizeGscImportRow(row, dimensions))
    .filter(rowHasGscEvidence);
  if (!rows.length) {
    throw badRequest("Import must include Search Console columns such as query/page, clicks, impressions, CTR, and position.");
  }
  // A CSV export does not say which dates it covers; keep the window only
  // when the caller states it.
  const window = input.startDate || input.endDate ? dateWindow(input) : null;
  const batch = saveGscBatch({
    siteId: site.id,
    siteUrl: String(input.siteUrl || site.domain || "").trim(),
    sourceName: String(input.sourceName || "Search Console CSV").trim().slice(0, 180),
    source: "csv",
    dimensions,
    startDate: window?.startDate ?? null,
    endDate: window?.endDate ?? null,
    rows,
  });
  return { ...batch, rows: gscImportRows(requireGscImport(site.id, batch.id)) };
}

function sameDimensions(left: string[], right: string[]) {
  return left.length === right.length && left.every((dimension) => right.includes(dimension));
}

// Stored Search Console rows (CSV imports and API syncs alike), one batch at a
// time, paged. The batch is importId when given, else the newest batch with
// exactly these dimensions whose window is startDate–endDate — or, for batches
// that include the date dimension, whose window covers it (rows are then
// filtered to the requested dates).
export function listGscRows(
  siteId: string,
  input: { dimensions?: unknown; startDate?: unknown; endDate?: unknown; importId?: unknown; limit?: unknown; offset?: unknown },
) {
  if (!getSite(siteId)) throw notFound("Site not found.");
  const limit = Math.max(1, Math.min(10_000, Math.round(Number(input.limit)) || 1000));
  const offset = Math.max(0, Math.round(Number(input.offset)) || 0);
  const window = input.startDate || input.endDate ? dateWindow(input) : null;
  const dimensions = input.dimensions ? apiDimensions(input.dimensions) : null;
  let record: GscImportRecord | undefined;
  if (input.importId) {
    record = requireGscImport(siteId, String(input.importId));
  } else {
    record = all<GscImportRecord>("SELECT * FROM gsc_imports WHERE site_id = ? ORDER BY created_at DESC", [siteId]).find(
      (candidate) => {
        const candidateDimensions = jsonParse<string[]>(candidate.dimensions_json, []);
        if (dimensions && !sameDimensions(candidateDimensions, dimensions)) return false;
        if (!window) return true;
        if (candidate.start_date === window.startDate && candidate.end_date === window.endDate) return true;
        return (
          candidateDimensions.includes("date") &&
          Boolean(candidate.start_date && candidate.end_date) &&
          String(candidate.start_date) <= window.startDate &&
          String(candidate.end_date) >= window.endDate
        );
      },
    );
  }
  if (!record) return { batch: null, rows: [], total: 0, limit, offset, hasMore: false };
  ensureGscRows(record);
  const filterByDate =
    window &&
    jsonParse<string[]>(record.dimensions_json, []).includes("date") &&
    !(record.start_date === window.startDate && record.end_date === window.endDate);
  const where = filterByDate ? "import_id = ? AND date BETWEEN ? AND ?" : "import_id = ?";
  const params = filterByDate ? [record.id, window.startDate, window.endDate] : [record.id];
  const total = get<{ count: number }>(`SELECT count(*) AS count FROM gsc_rows WHERE ${where}`, params)?.count || 0;
  const rows = all(
    `SELECT ${GSC_ROW_COLUMNS} FROM gsc_rows WHERE ${where} ORDER BY clicks DESC, impressions DESC, id ASC LIMIT ? OFFSET ?`,
    [...params, limit, offset],
  );
  return { batch: mapGscImport(record), rows, total, limit, offset, hasMore: offset + rows.length < total };
}

export async function getGscPerformance(input: {
  siteId?: string;
  siteUrl?: string;
  startDate?: string;
  endDate?: string;
  dimensions?: string[];
  rowLimit?: number;
}) {
  const siteId = String(input.siteId || "");
  if (!siteId) throw badRequest("Site id is required.");
  const status = gscStatus(siteId);
  if (status.connected && (input.siteUrl || status.connection?.siteUrl)) {
    return {
      source: "google_search_console",
      ...(await queryGscPerformance({ ...input, siteId })),
    };
  }
  const latest = get<GscImportRecord>(
    "SELECT * FROM gsc_imports WHERE site_id = ? ORDER BY created_at DESC LIMIT 1",
    [siteId],
  );
  if (latest) {
    const batch = mapGscImport(latest);
    return {
      source: latest.source === "api" ? "local_gsc_sync" : "local_gsc_import",
      siteUrl: batch.siteUrl,
      dimensions: batch.dimensions,
      totals: batch.totals,
      rows: gscImportRows(latest),
      startDate: batch.startDate,
      endDate: batch.endDate,
      importedAt: batch.createdAt,
      sourceName: batch.sourceName,
    };
  }
  throw badRequest("No Search Console data yet. Connect Google or import a Search Console CSV.");
}

export function listGscConnections() {
  return all<GscConnection>("SELECT * FROM gsc_connections ORDER BY updated_at DESC").map(
    (row) => ({
      siteId: row.site_id,
      siteUrl: row.site_url,
      connected: hasTokens(row) && !row.auth_error,
      needsReconnect: Boolean(row.auth_error) || !hasTokens(row),
      expiresAt: row.expires_at,
    }),
  );
}

export function disconnectGsc(siteId: string) {
  run("DELETE FROM gsc_connections WHERE site_id = ?", [siteId]);
  return { connected: false };
}

export async function inspectGscUrls(input: {
  siteId?: string;
  urls: string[] | string;
  siteUrl?: string;
}) {
  const siteId = String(input.siteId || "");
  if (!siteId) throw badRequest("Site id is required.");
  const siteUrl = gscPropertyFor(siteId, input.siteUrl);
  const urls = (Array.isArray(input.urls) ? input.urls.map(String) : String(input.urls || "").split(/\n|,/))
    .map((url) => url.trim())
    .filter(Boolean);
  if (!urls.length) throw badRequest("Add at least one URL to inspect.");
  const rows = [];
  for (const inspectionUrl of urls.slice(0, 20)) {
    const { response, data } = await authorizedGoogleRequest(
      siteId,
      "https://searchconsole.googleapis.com/v1/urlInspection/index:inspect",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ inspectionUrl, siteUrl }),
      },
    );
    rows.push(
      response.ok
        ? { inspectionUrl, result: data.inspectionResult || data }
        : { inspectionUrl, error: data.error?.message || `HTTP ${response.status}` },
    );
  }
  return { siteUrl, rows };
}
