import { all, get, jsonParse } from "./db";
import { badRequest } from "./errors";
import { ensureGscRows, type GscImportRecord } from "./gsc";
import { requireDate } from "./input";
import { pageUrlKey } from "./page-url";

// Reads stored Search Console batches (API syncs and CSV imports in
// gsc_imports/gsc_rows) as per-page metrics for a date window. Nothing is
// estimated: a window is answered only by a batch whose own window is exactly
// that window, or by a batch with the date dimension whose dates cover it.

export type GscWindow = { startDate: string; endDate: string };

export type GscPageMetrics = {
  url: string;
  clicks: number | null;
  impressions: number | null;
  ctr: number | null;
  position: number | null;
};

export type GscBatchMatch = {
  record: GscImportRecord;
  dimensions: string[];
  source: "api" | "csv";
  // The dates the rows answer: the requested window, else the batch's own.
  range: { startDate: string | null; endDate: string | null };
  // Set when only the rows inside the window are read (date-dimension batch).
  dateFilter: GscWindow | null;
};

export type GscPageData = GscBatchMatch & {
  // Page totals summed from query+page rows leave out anonymized queries.
  fromQueryRows: boolean;
  pages: Map<string, GscPageMetrics>;
};

export function optionalWindow(start: unknown, end: unknown, names: [string, string] = ["startDate", "endDate"]) {
  if (!start && !end) return null;
  const startDate = requireDate(start, names[0]);
  const endDate = requireDate(end, names[1]);
  if (startDate > endDate) throw badRequest(`${names[0]} must be on or before ${names[1]}.`);
  return { startDate, endDate };
}

export function shiftDate(date: string, days: number) {
  const value = new Date(`${date}T00:00:00Z`);
  value.setUTCDate(value.getUTCDate() + days);
  return value.toISOString().slice(0, 10);
}

// Days from startDate to endDate, both included.
export function dayCount(startDate: string, endDate: string) {
  return Math.round((Date.parse(`${endDate}T00:00:00Z`) - Date.parse(`${startDate}T00:00:00Z`)) / 86_400_000) + 1;
}

function siteBatches(siteId: string) {
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

// Newest batch that has every `include` dimension and none of `exclude`, and
// that answers the window (any window when none is asked for).
export function findGscBatch(
  siteId: string,
  input: { include: string[]; exclude?: string[]; window: GscWindow | null },
): GscBatchMatch | null {
  for (const { record, dimensions } of siteBatches(siteId)) {
    if (!input.include.every((dimension) => dimensions.includes(dimension))) continue;
    if ((input.exclude || []).some((dimension) => dimensions.includes(dimension))) continue;
    const range = batchRange(record, dimensions);
    const source = record.source === "api" ? "api" : "csv";
    const window = input.window;
    if (!window) {
      ensureGscRows(record);
      return { record, dimensions, source, range, dateFilter: null };
    }
    if (range.startDate === window.startDate && range.endDate === window.endDate) {
      ensureGscRows(record);
      return { record, dimensions, source, range: window, dateFilter: null };
    }
    const covers =
      dimensions.includes("date") &&
      Boolean(range.startDate && range.endDate) &&
      String(range.startDate) <= window.startDate &&
      String(range.endDate) >= window.endDate;
    if (covers) {
      ensureGscRows(record);
      return { record, dimensions, source, range: window, dateFilter: window };
    }
  }
  return null;
}

// Summed metrics per stored page (and query) group. Position is averaged
// weighted by impressions, the way Search Console aggregates it.
const METRIC_COLUMNS = `
  SUM(clicks) AS clicks,
  SUM(impressions) AS impressions,
  SUM(CASE WHEN position IS NOT NULL AND impressions > 0 THEN position * impressions END) AS weightedPosition,
  SUM(CASE WHEN position IS NOT NULL AND impressions > 0 THEN impressions END) AS positionWeight,
  MAX(ctr) AS ctr,
  MAX(position) AS position,
  COUNT(*) AS rowCount
`;

type MetricRow = {
  page: string;
  query?: string;
  clicks: number | null;
  impressions: number | null;
  weightedPosition: number | null;
  positionWeight: number | null;
  ctr: number | null;
  position: number | null;
  rowCount: number;
};

export function readMetricRows(match: GscBatchMatch, groupBy: "page" | "query, page") {
  const dateWhere = match.dateFilter ? "AND date BETWEEN ? AND ?" : "";
  const queryWhere = groupBy === "page" ? "" : "AND query IS NOT NULL AND query != ''";
  const params: unknown[] = [match.record.id];
  if (match.dateFilter) params.push(match.dateFilter.startDate, match.dateFilter.endDate);
  return all<MetricRow>(
    `
    SELECT ${groupBy}, ${METRIC_COLUMNS}
    FROM gsc_rows
    WHERE import_id = ? AND page IS NOT NULL AND page != '' ${queryWhere} ${dateWhere}
    GROUP BY ${groupBy}
    `,
    params,
  );
}

function addNullable(left: number | null, right: number | null) {
  if (left === null) return right;
  return right === null ? left : left + right;
}

// One entry per page identity (http/https, www, and trailing-slash variants
// merge). A single stored row keeps its own CTR and position.
export function mergePageRows(rows: MetricRow[]) {
  const merged = new Map<
    string,
    { url: string; urlImpressions: number; clicks: number | null; impressions: number | null; weighted: number; weight: number; rowCount: number; ctr: number | null; position: number | null }
  >();
  for (const row of rows) {
    const key = pageUrlKey(row.page);
    const existing = merged.get(key);
    const impressions = row.impressions ?? 0;
    if (!existing) {
      merged.set(key, {
        url: row.page,
        urlImpressions: impressions,
        clicks: row.clicks,
        impressions: row.impressions,
        weighted: row.weightedPosition ?? 0,
        weight: row.positionWeight ?? 0,
        rowCount: row.rowCount,
        ctr: row.ctr,
        position: row.position,
      });
      continue;
    }
    if (impressions > existing.urlImpressions) {
      existing.url = row.page;
      existing.urlImpressions = impressions;
    }
    existing.clicks = addNullable(existing.clicks, row.clicks);
    existing.impressions = addNullable(existing.impressions, row.impressions);
    existing.weighted += row.weightedPosition ?? 0;
    existing.weight += row.positionWeight ?? 0;
    existing.rowCount += row.rowCount;
  }
  const pages = new Map<string, GscPageMetrics>();
  for (const [key, page] of merged) {
    const single = page.rowCount === 1;
    pages.set(key, {
      url: page.url,
      clicks: page.clicks,
      impressions: page.impressions,
      ctr: page.impressions && page.clicks !== null ? page.clicks / page.impressions : single ? page.ctr : null,
      position: page.weight > 0 ? page.weighted / page.weight : single ? page.position : null,
    });
  }
  return pages;
}

// Per-page metrics for a window (or the newest page batch when no window is
// given). Batches without the query dimension come first because query+page
// rows leave anonymized queries out of page totals.
export function gscPageData(
  siteId: string,
  window: GscWindow | null,
  options: { allowQueryRows: boolean },
): GscPageData | null {
  const pageOnly = findGscBatch(siteId, { include: ["page"], exclude: ["query"], window });
  const match = pageOnly || (options.allowQueryRows ? findGscBatch(siteId, { include: ["page", "query"], window }) : null);
  if (!match) return null;
  return { ...match, fromQueryRows: !pageOnly, pages: mergePageRows(readMetricRows(match, "page")) };
}

// Public description of the rows an analysis read.
export function gscRangeView(data: GscPageData) {
  return {
    startDate: data.range.startDate,
    endDate: data.range.endDate,
    source: data.source,
    importId: data.record.id,
    dimensions: data.dimensions,
    ...(data.fromQueryRows
      ? {
          note: "Page totals are summed from query + page rows, which leave out anonymized queries, so they can be lower than Search Console's page report.",
        }
      : {}),
  };
}

// The dates stored page data (without the query dimension) can answer by
// default. The newest page + date batch answers from the start of the window it
// was synced or imported for (else its first row date) to its last row date:
// Search Console's final data stops a few days before a sync's end date, and
// those trailing days have no rows rather than zero clicks. Without such a
// batch only the latest page window's end is known (startDate null).
export function pageDataRange(siteId: string) {
  const batches = siteBatches(siteId).filter(
    ({ dimensions }) => dimensions.includes("page") && !dimensions.includes("query"),
  );
  const dated = batches.find(({ dimensions }) => dimensions.includes("date"));
  if (dated) {
    ensureGscRows(dated.record);
    const rows = get<{ firstDate: string | null; lastDate: string | null }>(
      "SELECT min(date) AS firstDate, max(date) AS lastDate FROM gsc_rows WHERE import_id = ? AND date IS NOT NULL AND date != ''",
      [dated.record.id],
    );
    if (rows?.firstDate && rows.lastDate) {
      const { start_date: requestedStart, end_date: requestedEnd } = dated.record;
      const requested = requestedStart && requestedEnd ? { startDate: requestedStart, endDate: requestedEnd } : null;
      return {
        startDate: requested?.startDate ?? rows.firstDate,
        endDate: requested && requested.endDate < rows.lastDate ? requested.endDate : rows.lastDate,
        requestedEndDate: requested?.endDate ?? null,
      };
    }
  }
  const ends = batches.map(({ record }) => record.end_date).filter((date): date is string => Boolean(date));
  const endDate = ends.sort().at(-1);
  return endDate ? { startDate: null, endDate, requestedEndDate: null } : null;
}
