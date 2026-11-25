import { all, get, jsonParse, run, transaction } from "./db";
import { notFound } from "./errors";

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
export type ImportedGscPerformanceRow = {
  keys: string[];
  clicks: number | null;
  impressions: number | null;
  ctr: number | null;
  position: number | null;
};

export type GscWindow = { startDate: string; endDate: string };

export type GscBatchMatch = {
  record: GscImportRecord;
  dimensions: string[];
  source: "api" | "csv";
  // The dates the rows answer: the requested window, else the batch's own.
  range: { startDate: string | null; endDate: string | null };
  // Set when only the rows inside the window are read (date-dimension batch).
  dateFilter: GscWindow | null;
};

export const DIMENSION_ORDER = ["query", "page", "country", "device", "date"];
export const GSC_ROW_COLUMNS = "query, page, country, device, date, clicks, impressions, ctr, position";

export function insertGscRows(importId: string, siteId: string, dimensions: string[], rows: ImportedGscPerformanceRow[]) {
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

export function requireGscImport(siteId: string, importId: string) {
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

export function siteBatches(siteId: string) {
  return all<GscImportRecord>("SELECT * FROM gsc_imports WHERE site_id = ? ORDER BY created_at DESC, rowid DESC", [
    siteId,
  ]).map((record) => ({ record, dimensions: jsonParse<string[]>(record.dimensions_json, []) }));
}

// A batch's own window: the one it was synced or imported for, or — for a
// date-dimension CSV imported without one — the dates its rows hold.
function batchRange(record: GscImportRecord, dimensions: string[]) {
  if (record.start_date && record.end_date) return { startDate: record.start_date, endDate: record.end_date };
  if (!dimensions.includes("date")) return { startDate: null, endDate: null };
  ensureGscRows(record);
  const row = get<{ startDate: string | null; endDate: string | null }>(
    "SELECT min(date) AS startDate, max(date) AS endDate FROM gsc_rows WHERE import_id = ? AND date IS NOT NULL AND date != ''",
    [record.id],
  );
  return { startDate: row?.startDate ?? null, endDate: row?.endDate ?? null };
}

// An undated aggregate answers only its exact declared window. Dated rows
// can answer a subwindow, including a range inferred from a CSV's row dates.
export function matchGscWindow(record: GscImportRecord, dimensions: string[], window: GscWindow | null): GscBatchMatch | null {
  const range = batchRange(record, dimensions);
  const dated = dimensions.includes("date");
  if (window) {
    if (!range.startDate || !range.endDate || range.startDate > window.startDate || range.endDate < window.endDate) return null;
    if (!dated && (range.startDate !== window.startDate || range.endDate !== window.endDate)) return null;
  }
  ensureGscRows(record);
  return {
    record, dimensions, source: record.source === "api" ? "api" : "csv",
    range: window ?? range,
    dateFilter: dated && range.startDate && range.endDate ? window ?? { startDate: range.startDate, endDate: range.endDate } : null,
  };
}

export function findGscBatch(
  siteId: string,
  input: { include: string[]; exclude?: string[]; exactDimensions?: boolean; window: GscWindow | null; siteUrl?: string },
): GscBatchMatch | null {
  for (const { record, dimensions } of siteBatches(siteId)) {
    if (input.siteUrl && record.site_url !== input.siteUrl) continue;
    if (input.exactDimensions && dimensions.length !== input.include.length) continue;
    if (!input.include.every((dimension) => dimensions.includes(dimension))) continue;
    if (input.exclude?.some((dimension) => dimensions.includes(dimension))) continue;
    const match = matchGscWindow(record, dimensions, input.window);
    if (match) return match;
  }
  return null;
}

export function batchRowsFilter(importId: string, window: GscWindow | null) {
  return window
    ? { where: "import_id = ? AND date BETWEEN ? AND ?", params: [importId, window.startDate, window.endDate] }
    : { where: "import_id = ?", params: [importId] };
}

type Totals = { clicks: number | null; impressions: number | null; ctr: number | null; position: number | null };

// A total is known only if every contributing row supplied its metric.
export function queryGscTotals(importId: string, window: GscWindow | null) {
  const { where, params } = batchRowsFilter(importId, window);
  return get<Totals & { count: number }>(`
    SELECT count(*) AS count,
      CASE WHEN count(clicks) = count(*) THEN round(total(clicks)) END AS clicks,
      CASE WHEN count(impressions) = count(*) THEN round(total(impressions)) END AS impressions,
      CASE WHEN count(clicks) = count(*) AND count(impressions) = count(*)
        THEN total(clicks) / nullif(total(impressions), 0) END AS ctr,
      total(position * impressions) / nullif(sum(CASE WHEN position IS NOT NULL THEN impressions END), 0) AS position
    FROM gsc_rows WHERE ${where}
  `, params)!;
}

// Refresh totals cached by older versions from the original rows on first
// read. Preserve legacy summary-only batches when their evidence is absent.
export function storedGscTotals(record: GscImportRecord) {
  const cached = jsonParse<Record<string, number | null>>(record.totals_json, {});
  const { version, ...previous } = cached;
  if (version === 2) return previous;
  ensureGscRows(record);
  const { count, ...totals } = queryGscTotals(record.id, null);
  if (count !== record.row_count) return previous;
  run("UPDATE gsc_imports SET totals_json = ? WHERE id = ?", [JSON.stringify({ version: 2, ...totals }), record.id]);
  return totals;
}
