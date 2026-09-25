import { Database } from "bun:sqlite";
import { existsSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";
import dotenv from "dotenv";
import { DEFAULT_KEYWORD_LANGUAGE_CODE, DEFAULT_KEYWORD_LOCATION_CODE } from "./defaults";

const runtimeDbPath = process.env.DB_PATH;

dotenv.config({ path: ".env", quiet: true });
dotenv.config({ path: ".env.local", override: true, quiet: true });

if (runtimeDbPath) {
  process.env.DB_PATH = runtimeDbPath;
}

const DB_FILE_NAME = "local-seo.sqlite";
const DB_DIR = process.env.DB_PATH?.trim() || "./database";
export const dbPath = resolve(DB_DIR, DB_FILE_NAME);

if (!existsSync(DB_DIR)) {
  mkdirSync(DB_DIR, { recursive: true });
}

export const db = new Database(dbPath);
refuseLegacyProjectDatabase();
db.exec("PRAGMA journal_mode = WAL");
db.exec("PRAGMA foreign_keys = ON");
// Background scans write progress while HTTP handlers write imports, config,
// and sessions. Without a busy timeout, any lock overlap fails immediately with
// SQLITE_BUSY; wait briefly for the current writer to finish instead.
db.exec("PRAGMA busy_timeout = 5000");

db.exec(`
  CREATE TABLE IF NOT EXISTS admin_users (
    id TEXT PRIMARY KEY,
    email TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
    salt TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS admin_sessions (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES admin_users(id) ON DELETE CASCADE,
    expires_at INTEGER NOT NULL,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS app_config (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL DEFAULT '',
    secret INTEGER NOT NULL DEFAULT 0,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS sites (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    domain TEXT NOT NULL DEFAULT '',
    notes TEXT NOT NULL DEFAULT '',
    location_code INTEGER NOT NULL DEFAULT ${DEFAULT_KEYWORD_LOCATION_CODE},
    language_code TEXT NOT NULL DEFAULT '${DEFAULT_KEYWORD_LANGUAGE_CODE}',
    crawl_protocol TEXT NOT NULL DEFAULT 'auto',
    crawl_host TEXT NOT NULL DEFAULT 'auto',
    crawl_speed TEXT NOT NULL DEFAULT 'auto',
    crawl_max_pages INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );

  CREATE INDEX IF NOT EXISTS idx_sites_created ON sites(created_at DESC);

  CREATE TABLE IF NOT EXISTS keyword_research_runs (
    id TEXT PRIMARY KEY,
    site_id TEXT NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
    query TEXT NOT NULL,
    location_code INTEGER NOT NULL,
    language_code TEXT NOT NULL,
    source TEXT NOT NULL,
    result_json TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS saved_keywords (
    id TEXT PRIMARY KEY,
    site_id TEXT NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
    keyword TEXT NOT NULL,
    location_code INTEGER NOT NULL DEFAULT ${DEFAULT_KEYWORD_LOCATION_CODE},
    language_code TEXT NOT NULL DEFAULT '${DEFAULT_KEYWORD_LANGUAGE_CODE}',
    search_volume INTEGER,
    difficulty INTEGER,
    cpc REAL,
    intent TEXT NOT NULL DEFAULT 'unknown',
    tags TEXT NOT NULL DEFAULT '[]',
    source TEXT NOT NULL DEFAULT 'manual',
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(site_id, keyword, location_code, language_code)
  );

  CREATE TABLE IF NOT EXISTS keyword_metric_imports (
    id TEXT PRIMARY KEY,
    site_id TEXT NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
    source_name TEXT NOT NULL DEFAULT '',
    row_count INTEGER NOT NULL DEFAULT 0,
    inserted_count INTEGER NOT NULL DEFAULT 0,
    updated_count INTEGER NOT NULL DEFAULT 0,
    rows_json TEXT NOT NULL DEFAULT '[]',
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );

  CREATE INDEX IF NOT EXISTS idx_keyword_metric_imports_site_created ON keyword_metric_imports(site_id, created_at DESC);

  CREATE TABLE IF NOT EXISTS rank_trackers (
    id TEXT PRIMARY KEY,
    site_id TEXT NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
    domain TEXT NOT NULL,
    location_code INTEGER NOT NULL DEFAULT ${DEFAULT_KEYWORD_LOCATION_CODE},
    language_code TEXT NOT NULL DEFAULT '${DEFAULT_KEYWORD_LANGUAGE_CODE}',
    device TEXT NOT NULL DEFAULT 'desktop',
    serp_depth INTEGER NOT NULL DEFAULT 50,
    schedule_interval TEXT NOT NULL DEFAULT 'manual',
    is_active INTEGER NOT NULL DEFAULT 1,
    next_check_at TEXT,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS rank_keywords (
    id TEXT PRIMARY KEY,
    tracker_id TEXT NOT NULL REFERENCES rank_trackers(id) ON DELETE CASCADE,
    keyword TEXT NOT NULL,
    search_volume INTEGER,
    keyword_difficulty INTEGER,
    cpc REAL,
    metrics_fetched_at TEXT,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(tracker_id, keyword)
  );

  CREATE TABLE IF NOT EXISTS rank_runs (
    id TEXT PRIMARY KEY,
    tracker_id TEXT NOT NULL REFERENCES rank_trackers(id) ON DELETE CASCADE,
    status TEXT NOT NULL,
    message TEXT NOT NULL DEFAULT '',
    started_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    finished_at TEXT,
    keyword_count INTEGER NOT NULL DEFAULT 0,
    checked_count INTEGER NOT NULL DEFAULT 0,
    error_count INTEGER NOT NULL DEFAULT 0,
    errors_json TEXT NOT NULL DEFAULT '[]'
  );

  CREATE TABLE IF NOT EXISTS rank_snapshots (
    id TEXT PRIMARY KEY,
    run_id TEXT NOT NULL REFERENCES rank_runs(id) ON DELETE CASCADE,
    tracker_id TEXT NOT NULL REFERENCES rank_trackers(id) ON DELETE CASCADE,
    keyword_id TEXT REFERENCES rank_keywords(id) ON DELETE SET NULL,
    keyword TEXT NOT NULL,
    position INTEGER,
    url TEXT NOT NULL DEFAULT '',
    title TEXT NOT NULL DEFAULT '',
    checked_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    depth_checked INTEGER,
    source TEXT NOT NULL DEFAULT ''
  );

  CREATE INDEX IF NOT EXISTS idx_rank_snapshots_tracker_keyword ON rank_snapshots(tracker_id, keyword, checked_at DESC);

  CREATE TABLE IF NOT EXISTS domain_snapshots (
    id TEXT PRIMARY KEY,
    site_id TEXT NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
    domain TEXT NOT NULL,
    source TEXT NOT NULL,
    result_json TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS organic_imports (
    id TEXT PRIMARY KEY,
    site_id TEXT NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
    domain TEXT NOT NULL,
    source_name TEXT NOT NULL DEFAULT '',
    keyword_count INTEGER NOT NULL DEFAULT 0,
    page_count INTEGER NOT NULL DEFAULT 0,
    summary_json TEXT NOT NULL DEFAULT '{}',
    keywords_json TEXT NOT NULL DEFAULT '[]',
    pages_json TEXT NOT NULL DEFAULT '[]',
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );

  CREATE INDEX IF NOT EXISTS idx_organic_imports_site_domain_created ON organic_imports(site_id, domain, created_at DESC);

  CREATE TABLE IF NOT EXISTS backlink_snapshots (
    id TEXT PRIMARY KEY,
    site_id TEXT NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
    domain TEXT NOT NULL,
    source TEXT NOT NULL,
    result_json TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS backlink_imports (
    id TEXT PRIMARY KEY,
    site_id TEXT NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
    domain TEXT NOT NULL,
    source_name TEXT NOT NULL DEFAULT '',
    row_count INTEGER NOT NULL DEFAULT 0,
    summary_json TEXT NOT NULL DEFAULT '{}',
    rows_json TEXT NOT NULL DEFAULT '[]',
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );

  CREATE INDEX IF NOT EXISTS idx_backlink_imports_site_domain_created ON backlink_imports(site_id, domain, created_at DESC);

  CREATE TABLE IF NOT EXISTS scans (
    id TEXT PRIMARY KEY,
    site_id TEXT NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
    url TEXT NOT NULL,
    status TEXT NOT NULL,
    score INTEGER NOT NULL DEFAULT 0,
    pages_crawled INTEGER NOT NULL DEFAULT 0,
    issue_count INTEGER NOT NULL DEFAULT 0,
    summary_json TEXT,
    error TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );

  -- The full saved crawl result of a scan (several MB on large sites). Kept
  -- out of the scans row so scan lists and status updates never page through it.
  CREATE TABLE IF NOT EXISTS scan_results (
    scan_id TEXT PRIMARY KEY REFERENCES scans(id) ON DELETE CASCADE,
    result_json TEXT
  );

  CREATE TABLE IF NOT EXISTS scan_issue_ignores (
    id TEXT PRIMARY KEY,
    site_id TEXT NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
    issue_type TEXT NOT NULL,
    url TEXT NOT NULL DEFAULT '',
    note TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(site_id, issue_type, url)
  );

  CREATE TABLE IF NOT EXISTS gsc_connections (
    id TEXT PRIMARY KEY,
    site_id TEXT NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
    site_url TEXT NOT NULL DEFAULT '',
    access_token TEXT NOT NULL DEFAULT '',
    refresh_token TEXT NOT NULL DEFAULT '',
    expires_at INTEGER NOT NULL DEFAULT 0,
    account_email TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    auth_error TEXT NOT NULL DEFAULT '',
    UNIQUE(site_id)
  );

  CREATE TABLE IF NOT EXISTS gsc_oauth_states (
    state TEXT PRIMARY KEY,
    site_id TEXT NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
    redirect_uri TEXT NOT NULL,
    expires_at INTEGER NOT NULL,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS ai_jobs (
    id TEXT PRIMARY KEY,
    type TEXT NOT NULL,
    prompt TEXT NOT NULL,
    status TEXT NOT NULL,
    message TEXT NOT NULL DEFAULT '',
    result_text TEXT NOT NULL DEFAULT '',
    result_json TEXT,
    error TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    started_at TEXT,
    finished_at TEXT,
    site_id TEXT REFERENCES sites(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS ai_prompts (
    key TEXT PRIMARY KEY,
    label TEXT NOT NULL,
    template TEXT NOT NULL,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS cache_entries (
    key TEXT PRIMARY KEY,
    value_json TEXT NOT NULL,
    expires_at INTEGER NOT NULL,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS serp_runs (
    id TEXT PRIMARY KEY,
    site_id TEXT NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
    keyword TEXT NOT NULL,
    domain TEXT NOT NULL DEFAULT '',
    location_code INTEGER NOT NULL DEFAULT ${DEFAULT_KEYWORD_LOCATION_CODE},
    language_code TEXT NOT NULL DEFAULT '${DEFAULT_KEYWORD_LANGUAGE_CODE}',
    source TEXT NOT NULL,
    result_json TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );

  CREATE INDEX IF NOT EXISTS idx_serp_runs_site_created ON serp_runs(site_id, created_at DESC);

  CREATE TABLE IF NOT EXISTS brand_lookup_runs (
    id TEXT PRIMARY KEY,
    site_id TEXT NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
    query TEXT NOT NULL,
    competitors TEXT NOT NULL DEFAULT '[]',
    source TEXT NOT NULL,
    result_json TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );

  CREATE INDEX IF NOT EXISTS idx_brand_lookup_site_created ON brand_lookup_runs(site_id, created_at DESC);

  CREATE TABLE IF NOT EXISTS prompt_explorer_runs (
    id TEXT PRIMARY KEY,
    site_id TEXT NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
    prompt TEXT NOT NULL,
    highlight_brand TEXT NOT NULL DEFAULT '',
    models TEXT NOT NULL DEFAULT '[]',
    source TEXT NOT NULL,
    result_json TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );

  CREATE INDEX IF NOT EXISTS idx_prompt_explorer_site_created ON prompt_explorer_runs(site_id, created_at DESC);

  CREATE TABLE IF NOT EXISTS saved_keyword_tags (
    id TEXT PRIMARY KEY,
    site_id TEXT NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    color TEXT NOT NULL DEFAULT 'slate',
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(site_id, name)
  );

  CREATE INDEX IF NOT EXISTS idx_saved_keyword_tags_site ON saved_keyword_tags(site_id, name);

  CREATE TABLE IF NOT EXISTS gsc_imports (
    id TEXT PRIMARY KEY,
    site_id TEXT NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
    site_url TEXT NOT NULL DEFAULT '',
    source_name TEXT NOT NULL DEFAULT '',
    dimensions_json TEXT NOT NULL DEFAULT '[]',
    row_count INTEGER NOT NULL DEFAULT 0,
    totals_json TEXT NOT NULL DEFAULT '{}',
    rows_json TEXT NOT NULL DEFAULT '[]',
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    source TEXT NOT NULL DEFAULT 'csv',
    start_date TEXT,
    end_date TEXT
  );

  CREATE INDEX IF NOT EXISTS idx_gsc_imports_site_created ON gsc_imports(site_id, created_at DESC);

  -- One row per Search Console row of a CSV import or API sync (gsc_imports is
  -- the batch: property, dimensions, date window, source, created_at). Columns
  -- for dimensions that were not requested stay NULL.
  CREATE TABLE IF NOT EXISTS gsc_rows (
    id INTEGER PRIMARY KEY,
    import_id TEXT NOT NULL REFERENCES gsc_imports(id) ON DELETE CASCADE,
    site_id TEXT NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
    query TEXT,
    page TEXT,
    country TEXT,
    device TEXT,
    date TEXT,
    clicks REAL,
    impressions REAL,
    ctr REAL,
    position REAL
  );

  -- In-app notices (scan regressions, failed scheduled jobs). Kept until the
  -- user deletes them; read_at only marks them seen.
  CREATE TABLE IF NOT EXISTS notifications (
    id TEXT PRIMARY KEY,
    site_id TEXT REFERENCES sites(id) ON DELETE CASCADE,
    type TEXT NOT NULL,
    title TEXT NOT NULL,
    body TEXT NOT NULL DEFAULT '',
    data_json TEXT NOT NULL DEFAULT '{}',
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    read_at TEXT
  );

  -- PageSpeed Insights runs: one row per request batch, one result per URL
  -- and strategy with only the values PSI returned.
  CREATE TABLE IF NOT EXISTS cwv_runs (
    id TEXT PRIMARY KEY,
    site_id TEXT NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
    strategy TEXT NOT NULL,
    status TEXT NOT NULL,
    message TEXT NOT NULL DEFAULT '',
    urls_json TEXT NOT NULL DEFAULT '[]',
    url_count INTEGER NOT NULL DEFAULT 0,
    done_count INTEGER NOT NULL DEFAULT 0,
    error_count INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    finished_at TEXT
  );

  CREATE TABLE IF NOT EXISTS cwv_results (
    id TEXT PRIMARY KEY,
    site_id TEXT NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
    run_id TEXT NOT NULL REFERENCES cwv_runs(id) ON DELETE CASCADE,
    url TEXT NOT NULL,
    strategy TEXT NOT NULL,
    fetched_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    field_json TEXT,
    origin_field_json TEXT,
    lab_json TEXT,
    error TEXT
  );
`);

// Explicit migrations for databases created before these columns existed.
const siteColumns = new Set(
  (db.prepare("PRAGMA table_info(sites)").all() as { name: string }[]).map((column) => column.name),
);
if (!siteColumns.has("crawl_speed")) {
  db.exec("ALTER TABLE sites ADD COLUMN crawl_speed TEXT NOT NULL DEFAULT 'auto'");
}
if (!siteColumns.has("crawl_max_pages")) {
  db.exec("ALTER TABLE sites ADD COLUMN crawl_max_pages INTEGER NOT NULL DEFAULT 0");
}
const scanColumns = new Set(
  (db.prepare("PRAGMA table_info(scans)").all() as { name: string }[]).map((column) => column.name),
);
if (!scanColumns.has("summary_json")) {
  // Small per-scan list summary. Existing rows are filled from the saved result
  // the first time scans are listed (src/scans.ts backfillScanSummaries).
  db.exec("ALTER TABLE scans ADD COLUMN summary_json TEXT");
}
if (scanColumns.has("result_json")) {
  moveScanResultsOutOfScans();
}
// Finds rows still waiting for a summary.
db.exec("CREATE INDEX IF NOT EXISTS idx_scans_summary_missing ON scans(site_id, id) WHERE summary_json IS NULL");

// Full scan results used to live in scans.result_json, ahead of the small list
// columns, so every list query paged through megabytes of overflow. They move
// to scan_results in one transaction: copy, verify every row arrived intact,
// then drop the old column (or clear it where DROP COLUMN is unavailable).
// Reruns are safe: nothing is copied twice and a migrated database is skipped.
function moveScanResultsOutOfScans() {
  const count = (sql: string) => (db.prepare(sql).get() as { count: number }).count;
  transaction(() => {
    const legacyRows = count("SELECT COUNT(*) AS count FROM scans WHERE result_json IS NOT NULL");
    if (legacyRows) {
      db.exec(`
        INSERT INTO scan_results (scan_id, result_json)
        SELECT id, result_json FROM scans WHERE result_json IS NOT NULL
        ON CONFLICT(scan_id) DO UPDATE SET result_json = excluded.result_json
      `);
      const copied = count(`
        SELECT COUNT(*) AS count FROM scans
        JOIN scan_results ON scan_results.scan_id = scans.id
        WHERE scans.result_json IS NOT NULL AND scan_results.result_json = scans.result_json
      `);
      if (copied !== legacyRows) {
        throw new Error(`Moving saved scan results verified ${copied} of ${legacyRows} rows; ${dbPath} was left unchanged.`);
      }
    }
    try {
      db.exec("ALTER TABLE scans DROP COLUMN result_json");
    } catch {
      if (legacyRows) db.exec("UPDATE scans SET result_json = NULL WHERE result_json IS NOT NULL");
    }
    if (legacyRows) console.log(`Moved ${legacyRows} saved scan result(s) to the scan_results table.`);
  });
}

// Columns added after the first release. Each is added once, in place, with a
// default that keeps existing rows valid.
function ensureColumn(table: string, column: string, definition: string) {
  if (!db.prepare("SELECT 1 FROM pragma_table_info(?) WHERE name = ?").get(table, column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }
}
ensureColumn("ai_jobs", "site_id", "TEXT REFERENCES sites(id) ON DELETE CASCADE");
ensureColumn("rank_runs", "keyword_count", "INTEGER NOT NULL DEFAULT 0");
ensureColumn("rank_runs", "checked_count", "INTEGER NOT NULL DEFAULT 0");
ensureColumn("rank_runs", "error_count", "INTEGER NOT NULL DEFAULT 0");
ensureColumn("rank_runs", "errors_json", "TEXT NOT NULL DEFAULT '[]'");
ensureColumn("rank_snapshots", "depth_checked", "INTEGER");
ensureColumn("rank_snapshots", "source", "TEXT NOT NULL DEFAULT ''");
ensureColumn("gsc_connections", "auth_error", "TEXT NOT NULL DEFAULT ''");
ensureColumn("gsc_imports", "source", "TEXT NOT NULL DEFAULT 'csv'");
ensureColumn("gsc_imports", "start_date", "TEXT");
ensureColumn("gsc_imports", "end_date", "TEXT");
// Scheduled scans (off by default). Times are ISO 8601 UTC strings.
ensureColumn("sites", "scan_schedule", "TEXT NOT NULL DEFAULT 'off'");
ensureColumn("sites", "scan_next_run_at", "TEXT");
ensureColumn("sites", "scan_last_run_at", "TEXT");
ensureColumn("scans", "scheduled", "INTEGER NOT NULL DEFAULT 0");
ensureColumn("rank_runs", "scheduled", "INTEGER NOT NULL DEFAULT 0");
ensureColumn("rank_runs", "notified_at", "TEXT");
// Day of the month (1-31) a schedule was set on: monthly runs land on it,
// clamped to shorter months. NULL (schedules set before this column) keeps
// the day of the previous run.
ensureColumn("sites", "scan_schedule_day", "INTEGER");
ensureColumn("rank_trackers", "schedule_day", "INTEGER");
ensureColumn("ai_jobs", "scan_id", "TEXT REFERENCES scans(id) ON DELETE SET NULL");
// Whether the Codex job ran with web search. Jobs whose prompt carries crawled
// page text (scan jobs, jobs built from `context`) run without it.
ensureColumn("ai_jobs", "web_search", "INTEGER NOT NULL DEFAULT 1");
// notified_at marks finished scans the scheduler has already checked for
// notifications. Scans finished before this column existed count as checked,
// so upgrading does not raise notices for old history.
if (!db.prepare("SELECT 1 FROM pragma_table_info('scans') WHERE name = 'notified_at'").get()) {
  db.exec("ALTER TABLE scans ADD COLUMN notified_at TEXT");
  db.exec("UPDATE scans SET notified_at = updated_at WHERE status NOT IN ('queued', 'running')");
}

// Indexes for the lookups the API actually runs. Created after the column
// migrations above because some cover columns that older databases only gain there.
db.exec(`
  CREATE INDEX IF NOT EXISTS idx_admin_sessions_user ON admin_sessions(user_id);
  CREATE INDEX IF NOT EXISTS idx_scans_site_created ON scans(site_id, created_at DESC);
  CREATE INDEX IF NOT EXISTS idx_saved_keywords_site_created ON saved_keywords(site_id, created_at DESC);
  CREATE INDEX IF NOT EXISTS idx_saved_keywords_site_keyword_lower ON saved_keywords(site_id, lower(keyword));
  CREATE INDEX IF NOT EXISTS idx_keyword_research_runs_site_created ON keyword_research_runs(site_id, created_at DESC);
  CREATE INDEX IF NOT EXISTS idx_rank_trackers_site_created ON rank_trackers(site_id, created_at DESC);
  CREATE INDEX IF NOT EXISTS idx_rank_runs_tracker_started ON rank_runs(tracker_id, started_at DESC);
  CREATE INDEX IF NOT EXISTS idx_rank_snapshots_run ON rank_snapshots(run_id);
  CREATE INDEX IF NOT EXISTS idx_rank_snapshots_keyword_checked ON rank_snapshots(keyword_id, checked_at DESC);
  CREATE INDEX IF NOT EXISTS idx_domain_snapshots_site_created ON domain_snapshots(site_id, created_at DESC);
  CREATE INDEX IF NOT EXISTS idx_backlink_snapshots_site_created ON backlink_snapshots(site_id, created_at DESC);
  CREATE INDEX IF NOT EXISTS idx_ai_jobs_created ON ai_jobs(created_at DESC);
  CREATE INDEX IF NOT EXISTS idx_ai_jobs_site_created ON ai_jobs(site_id, created_at DESC);
  CREATE INDEX IF NOT EXISTS idx_gsc_rows_import_query ON gsc_rows(import_id, query);
  CREATE INDEX IF NOT EXISTS idx_gsc_rows_import_page ON gsc_rows(import_id, page);
  CREATE INDEX IF NOT EXISTS idx_gsc_rows_site ON gsc_rows(site_id);
  CREATE INDEX IF NOT EXISTS idx_scans_notify_pending ON scans(id) WHERE notified_at IS NULL;
  CREATE INDEX IF NOT EXISTS idx_rank_runs_notify_pending ON rank_runs(id) WHERE scheduled = 1 AND notified_at IS NULL;
  CREATE INDEX IF NOT EXISTS idx_notifications_site_created ON notifications(site_id, created_at DESC);
  CREATE INDEX IF NOT EXISTS idx_notifications_unread ON notifications(created_at DESC) WHERE read_at IS NULL;
  CREATE INDEX IF NOT EXISTS idx_cwv_runs_site_created ON cwv_runs(site_id, created_at DESC);
  CREATE INDEX IF NOT EXISTS idx_cwv_results_site_url ON cwv_results(site_id, url, strategy, fetched_at DESC);
`);

// Databases from the old "projects" era keyed everything by project_id (plus
// an audits table and target columns). This schema cannot run against them —
// it used to crash with "no such column: site_id". Stop with a clear message
// before touching the file (no WAL switch, no new tables).
function refuseLegacyProjectDatabase() {
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as { name: string }[];
  const legacyTables = tables
    .map((table) => table.name)
    .filter((table) => {
      const columns = db.prepare("SELECT name FROM pragma_table_info(?)").all(table) as { name: string }[];
      const names = new Set(columns.map((column) => column.name));
      return names.has("project_id") && !names.has("site_id");
    });
  if (!legacyTables.length) return;
  db.close();
  throw new Error(
    `${dbPath} was created by an older Local SEO version that stored data by project (project_id in: ${legacyTables.join(", ")}). ` +
      "This version cannot open it and has not modified the file. Move it aside or point DB_PATH at a new directory, then run `bun run db:init` to start a fresh database.",
  );
}

export function transaction<T>(work: () => T): T {
  return db.transaction(work)();
}

export function all<T = Record<string, unknown>>(sql: string, params: any[] = []): T[] {
  return db.prepare(sql).all(...params) as T[];
}

export function get<T = Record<string, unknown>>(sql: string, params: any[] = []): T | undefined {
  return db.prepare(sql).get(...params) as T | undefined;
}

export function run(sql: string, params: any[] = []) {
  return db.prepare(sql).run(...params);
}

export function nowIso() {
  return new Date().toISOString();
}

export function jsonParse<T>(value: string | null | undefined, fallback: T): T {
  if (!value) return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

// Scan, AI-job, and rank-check execution lives only in the running process. If
// the server restarts mid-run, those rows would stay 'running'/'queued' forever
// and the UI would poll them indefinitely — mark them failed on boot so they resolve.
export function recoverInterruptedJobs() {
  const scans = db
    .prepare(
      "UPDATE scans SET status = 'failed', error = CASE WHEN error = '' THEN 'Interrupted by a server restart before the scan finished.' ELSE error END, updated_at = CURRENT_TIMESTAMP WHERE status IN ('queued', 'running')",
    )
    .run();
  const jobs = db
    .prepare(
      "UPDATE ai_jobs SET status = 'failed', error = CASE WHEN error = '' THEN 'Interrupted by a server restart before the job finished.' ELSE error END, finished_at = CURRENT_TIMESTAMP WHERE status IN ('queued', 'running')",
    )
    .run();
  const rankRuns = db
    .prepare(
      "UPDATE rank_runs SET status = 'failed', message = 'Interrupted by a server restart before the rank check finished.', finished_at = CURRENT_TIMESTAMP WHERE status IN ('queued', 'running')",
    )
    .run();
  const cwvRuns = db
    .prepare(
      "UPDATE cwv_runs SET status = 'failed', message = 'Interrupted by a server restart before the PageSpeed run finished.', finished_at = CURRENT_TIMESTAMP WHERE status IN ('queued', 'running')",
    )
    .run();
  return { scans: scans.changes, jobs: jobs.changes, rankRuns: rankRuns.changes, cwvRuns: cwvRuns.changes };
}

if (import.meta.main) {
  console.log(`Database initialized at ${dbPath}`);
}
