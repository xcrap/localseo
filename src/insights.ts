import { all, get } from "./db";
import { badRequest, notFound } from "./errors";
import {
  dayCount,
  findGscBatch,
  type GscPageData,
  type GscPageMetrics,
  type GscWindow,
  gscPageData,
  gscRangeView,
  mergePageRows,
  optionalWindow,
  pageDataRange,
  readMetricRows,
  shiftDate,
} from "./gsc-pages";
import { optionalInt } from "./input";
import { pageUrlKey } from "./page-url";
import { scanPages, siteCompletedScan } from "./scan-summary";
import { compareScans, sameSiteUrl } from "./scans";
import { getSite } from "./seo";

// Search Console × crawl analyses. Every number comes from stored Search
// Console rows (API syncs or CSV imports) and saved crawl evidence; when either
// is missing the answer is `available: false` with the reason.

const MAX_ROWS = 500;
// CTR outliers compare a page with the site's own median CTR at the same
// rounded position. The median uses pages with at least 10 impressions; a
// bucket needs 5 of them; an outlier needs 100 impressions and a CTR under half
// the median.
const CTR_CURVE_MIN_IMPRESSIONS = 10;
const CTR_MIN_BUCKET_PAGES = 5;
const CTR_OUTLIER_MIN_IMPRESSIONS = 100;
const CTR_OUTLIER_RATIO = 0.5;
// Search Console's performance export lists at most 1,000 rows.
const GSC_EXPORT_ROW_CAP = 1000;
// Content decay compares 28 days with the 28 before; with less stored data
// the days that exist are split into two halves of at least 7 days.
const DECAY_WINDOW_DAYS = 28;
const DECAY_MIN_WINDOW_DAYS = 7;

function requireSite(siteId: string) {
  const site = getSite(siteId);
  if (!site) throw notFound("Site not found.");
  return site;
}

function round(value: number | null, digits: number) {
  if (value === null || !Number.isFinite(value)) return null;
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function percent(value: number) {
  return `${(value * 100).toFixed(1)}%`;
}

function metricsRow(metrics: GscPageMetrics) {
  return {
    url: metrics.url,
    clicks: metrics.clicks,
    impressions: metrics.impressions,
    ctr: round(metrics.ctr, 4),
    position: round(metrics.position, 2),
  };
}

function median(values: number[]) {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

const byImpressions = (a: { impressions: number | null }, b: { impressions: number | null }) =>
  (b.impressions ?? 0) - (a.impressions ?? 0);

// Why a crawled page cannot be the indexed URL for its Search Console row.
function indexabilityProblem(page: any, viaRedirect: boolean) {
  if (viaRedirect) return `Redirects${page.sourceStatus ? ` (HTTP ${page.sourceStatus})` : ""} to ${page.url}`;
  if (page.robotsBlocked === true || /robots/i.test(String(page.indexabilityReason || ""))) {
    return "Blocked by robots.txt";
  }
  if (page.status === null || page.status === undefined) return `Crawl failed${page.error ? `: ${page.error}` : ""}`;
  if (page.redirectLoop) return "Redirect loop";
  if (page.redirectError) return `Redirect failed: ${page.redirectError}`;
  if (Number(page.status) !== 200) return `HTTP ${page.status}`;
  if (page.indexabilityReason === "noindex") return "noindex (robots meta tag or X-Robots-Tag)";
  if (page.canonical && pageUrlKey(page.canonical) !== pageUrlKey(page.url)) return `Canonicalized to ${page.canonical}`;
  if (page.indexable === false) return `Not indexable (${page.indexabilityReason || "reason not recorded"})`;
  return null;
}

function emptySections() {
  return {
    impressionsNotIndexable: [] as any[],
    indexableNoImpressions: [] as any[],
    gscPagesNotCrawled: [] as any[],
    gscPagesNotInSitemap: [] as any[],
    ctrOutliers: [] as any[],
  };
}

// Crawl evidence vs Search Console pages for one scan and one window.
export function gscCrawlInsights(siteId: string, input: { scanId?: unknown; startDate?: unknown; endDate?: unknown }) {
  requireSite(siteId);
  const window = optionalWindow(input.startDate, input.endDate);
  const scan = siteCompletedScan(siteId, input.scanId ? String(input.scanId) : undefined);
  const gsc = gscPageData(siteId, window, { allowQueryRows: true });
  const empty = {
    scan: scan ? { id: scan.id, created_at: scan.created_at } : null,
    gscRange: gsc ? gscRangeView(gsc) : null,
    sections: emptySections(),
    ctrCurve: [] as { position: number; medianCtr: number; pages: number }[],
  };
  if (!scan) return { available: false, reason: "No completed scan for this site yet. Run a site scan first.", ...empty };
  if (!gsc) {
    return {
      available: false,
      reason: window
        ? `No stored Search Console page data covers ${window.startDate} to ${window.endDate}. Sync Search Console for that window with the page dimension, or import a Pages CSV for it.`
        : "No Search Console page data is stored for this site. Sync Search Console with the page dimension, or import a Pages CSV.",
      ...empty,
    };
  }

  const pages = scanPages(scan);
  const maxPages = Number(scan.result?.limits?.maxPages || 0);
  const limitReached = maxPages > 0 && pages.length >= maxPages;
  const sitemapFound = Number(scan.result?.sitemap?.urlCount ?? scan.result?.sitemap?.urls?.length ?? 0) > 0;
  const startUrl = String(scan.result?.startUrl || scan.url || "");
  // Final URLs first; redirect sources (requestedUrl) only when no page owns them.
  const byUrl = new Map<string, any>();
  const byRedirectSource = new Map<string, any>();
  for (const page of pages) {
    const key = pageUrlKey(String(page.url || ""));
    if (!byUrl.has(key)) byUrl.set(key, page);
  }
  for (const page of pages) {
    const key = page.requestedUrl ? pageUrlKey(String(page.requestedUrl)) : "";
    if (key && !byUrl.has(key) && !byRedirectSource.has(key)) byRedirectSource.set(key, page);
  }
  // URLs the crawler did not request because robots.txt disallows them for it.
  const robotsSkipped = Array.isArray(scan.result?.robotsSkipped?.urls) ? scan.result.robotsSkipped.urls : [];
  const robotsSkippedKeys = new Set(robotsSkipped.map((row: any) => pageUrlKey(String(row?.url || ""))));

  const sections = emptySections();
  for (const [key, metrics] of gsc.pages) {
    const hasImpressions = (metrics.impressions ?? 0) > 0;
    const page = byUrl.get(key) || byRedirectSource.get(key);
    if (!page) {
      sections.gscPagesNotCrawled.push({
        ...metricsRow(metrics),
        reason: !sameSiteUrl(metrics.url, startUrl)
          ? `Outside the crawled host (the scan started at ${startUrl}).`
          : robotsSkippedKeys.has(key)
            ? "Not crawled: robots.txt disallows it for the LocalSEO crawler."
            : limitReached
              ? `Not reached: the crawl stopped at its ${maxPages}-page limit, so this page may exist beyond it.`
              : "Not reached by the crawl through internal links or the sitemap.",
      });
      continue;
    }
    const viaRedirect = !byUrl.has(key);
    const problem = indexabilityProblem(page, viaRedirect);
    if (problem && hasImpressions) {
      sections.impressionsNotIndexable.push({
        ...metricsRow(metrics),
        status: (viaRedirect ? page.sourceStatus : page.status) ?? null,
        indexable: viaRedirect ? false : (page.indexable ?? null),
        reason: problem,
        canonical: page.canonical || null,
      });
    } else if (!problem && hasImpressions && sitemapFound && page.sitemapListed === false) {
      sections.gscPagesNotInSitemap.push({
        ...metricsRow(metrics),
        status: page.status ?? null,
        indexable: page.indexable ?? null,
        inSitemap: false,
        reason: "Indexable page with impressions is not listed in the XML sitemap.",
      });
    }
  }

  const exportCapped = gsc.source === "csv" && gsc.record.row_count >= GSC_EXPORT_ROW_CAP;
  for (const page of pages) {
    const key = pageUrlKey(String(page.url || ""));
    if (byUrl.get(key) !== page || page.indexable !== true || Number(page.status) !== 200 || page.isHtml === false) continue;
    if (indexabilityProblem(page, false)) continue;
    const metrics = gsc.pages.get(key);
    if (metrics && (metrics.impressions ?? 0) > 0) continue;
    sections.indexableNoImpressions.push({
      url: page.url,
      clicks: metrics ? metrics.clicks : null,
      impressions: metrics ? metrics.impressions : null,
      ctr: null,
      position: null,
      status: 200,
      indexable: true,
      inSitemap: sitemapFound ? page.sitemapListed === true : null,
      reason: metrics
        ? "0 impressions in this window."
        : exportCapped
          ? "No row in the Search Console export, which lists at most 1,000 pages; this page may be beyond the export."
          : "No Search Console impressions recorded in this window.",
    });
  }

  const buckets = new Map<number, GscPageMetrics[]>();
  for (const metrics of gsc.pages.values()) {
    if (metrics.position === null || metrics.ctr === null || (metrics.impressions ?? 0) < CTR_CURVE_MIN_IMPRESSIONS) continue;
    const position = Math.max(1, Math.round(metrics.position));
    if (position > 20) continue;
    buckets.set(position, [...(buckets.get(position) || []), metrics]);
  }
  const ctrCurve: { position: number; medianCtr: number; pages: number }[] = [];
  for (const [position, rows] of [...buckets].sort((a, b) => a[0] - b[0])) {
    if (rows.length < CTR_MIN_BUCKET_PAGES) continue;
    const expected = median(rows.map((row) => row.ctr as number));
    ctrCurve.push({ position, medianCtr: round(expected, 4) as number, pages: rows.length });
    if (expected <= 0) continue;
    for (const metrics of rows) {
      if ((metrics.impressions ?? 0) < CTR_OUTLIER_MIN_IMPRESSIONS || (metrics.ctr as number) >= expected * CTR_OUTLIER_RATIO) continue;
      sections.ctrOutliers.push({
        ...metricsRow(metrics),
        expectedCtr: round(expected, 4),
        reason: `CTR ${percent(metrics.ctr as number)} vs this site's median ${percent(expected)} for pages at position ${position}.`,
      });
    }
  }

  const counts = Object.fromEntries(Object.entries(sections).map(([name, rows]) => [name, rows.length]));
  for (const rows of Object.values(sections)) rows.sort(byImpressions);
  return {
    available: true,
    ...empty,
    crawl: { pages: pages.length, maxPages: maxPages || null, limitReached, sitemapFound },
    counts,
    sections: Object.fromEntries(Object.entries(sections).map(([name, rows]) => [name, rows.slice(0, MAX_ROWS)])),
    ctrCurve,
  };
}

// Queries where two or more pages each earn at least 10% of the query's
// impressions, from stored query + page rows. minImpressions applies to the
// query's total impressions across all its pages, not to each page.
export function cannibalization(
  siteId: string,
  input: { startDate?: unknown; endDate?: unknown; minImpressions?: unknown },
) {
  requireSite(siteId);
  const window = optionalWindow(input.startDate, input.endDate);
  const minImpressions = optionalInt(input.minImpressions, "minImpressions", 10, 0, 1_000_000_000);
  const filters = { minImpressions, minImpressionsAppliesTo: "query" as const };
  const match = findGscBatch(siteId, { include: ["query", "page"], window });
  if (!match) {
    return {
      available: false,
      ...filters,
      reason: window
        ? `No stored Search Console query + page rows cover ${window.startDate} to ${window.endDate}. Sync Search Console for that window with dimensions query,page.`
        : "No Search Console rows with both the query and page dimensions are stored for this site. Sync Search Console with dimensions query,page, or import a CSV with Query and Page columns.",
      range: null,
      rows: [],
    };
  }
  const byQuery = new Map<string, any[]>();
  for (const row of readMetricRows(match, "query, page")) {
    const query = String(row.query);
    byQuery.set(query, [...(byQuery.get(query) || []), row]);
  }
  const rankUrls = new Map<string, Set<string>>();
  for (const row of all<{ keyword: string; url: string }>(
    `
    SELECT DISTINCT lower(rs.keyword) AS keyword, rs.url
    FROM rank_snapshots rs
    JOIN rank_trackers rt ON rt.id = rs.tracker_id
    WHERE rt.site_id = ? AND rs.url != ''
    `,
    [siteId],
  )) {
    rankUrls.set(row.keyword, (rankUrls.get(row.keyword) || new Set()).add(row.url));
  }
  const rows: any[] = [];
  for (const [query, queryRows] of byQuery) {
    const pages = [...mergePageRows(queryRows).values()];
    const totalImpressions = pages.reduce((sum, page) => sum + (page.impressions ?? 0), 0);
    if (!totalImpressions || totalImpressions < minImpressions) continue;
    const competing = pages
      .filter((page) => (page.impressions ?? 0) / totalImpressions >= 0.1)
      .sort(byImpressions)
      .map((page) => ({ ...metricsRow(page), share: round((page.impressions ?? 0) / totalImpressions, 4) }));
    if (competing.length < 2) continue;
    rows.push({
      query,
      totalImpressions,
      totalClicks: pages.reduce((sum, page) => sum + (page.clicks ?? 0), 0),
      pages: competing,
      rankUrls: [...(rankUrls.get(query.toLowerCase()) || [])],
    });
  }
  rows.sort((a, b) => b.totalImpressions - a.totalImpressions);
  return {
    available: true,
    ...filters,
    range: { startDate: match.range.startDate, endDate: match.range.endDate },
    source: match.source,
    total: rows.length,
    rows: rows.slice(0, MAX_ROWS),
  };
}

type WindowMetrics = { clicks: number | null; impressions: number | null; position: number | null };

function windowMetrics(metrics: GscPageMetrics | undefined, data: GscPageData): WindowMetrics {
  if (metrics) return { clicks: metrics.clicks, impressions: metrics.impressions, position: round(metrics.position, 2) };
  // An API sync returns every page with impressions, so a missing page had
  // none. A CSV export may be truncated, so a missing page stays unknown.
  return data.source === "api" ? { clicks: 0, impressions: 0, position: null } : { clicks: null, impressions: null, position: null };
}

function delta(current: number | null, previous: number | null, digits = 0) {
  return current === null || previous === null ? null : round(current - previous, digits);
}

// The latest completed scan of the site that started on or before a date.
function completedScanOnOrBefore(siteId: string, date: string) {
  return (
    get<{ id: string }>(
      "SELECT id FROM scans WHERE site_id = ? AND status = 'completed' AND created_at < ? ORDER BY created_at DESC, rowid DESC LIMIT 1",
      [siteId, shiftDate(date, 1)],
    )?.id ?? null
  );
}

// Field changes per page between the scans that match the two windows: the
// latest completed scan on or before each window's end.
function windowScanChanges(siteId: string, current: GscWindow, previous: GscWindow) {
  const changes = new Map<string, { field: string; before: unknown; after: unknown }[]>();
  const scanId = completedScanOnOrBefore(siteId, current.endDate);
  const baseScanId = completedScanOnOrBefore(siteId, previous.endDate);
  const unavailable = (reason: string) => ({ scanComparison: { scanId, baseScanId, available: false, reason }, changes });
  if (!scanId) return unavailable(`No completed scan started on or before ${current.endDate}, the end of the current window.`);
  if (!baseScanId) return unavailable(`No completed scan started on or before ${previous.endDate}, the end of the previous window.`);
  if (scanId === baseScanId) {
    return unavailable(
      `No scan completed between ${previous.endDate} and ${current.endDate}: the latest scan before each window ends is the same scan.`,
    );
  }
  const comparison = compareScans(scanId, baseScanId);
  if (comparison.available) {
    for (const change of comparison.pageChanges || []) {
      const key = pageUrlKey(String(change.url || ""));
      changes.set(key, [...(changes.get(key) || []), { field: change.field, before: change.before, after: change.after }]);
    }
  }
  return {
    scanComparison: { scanId, baseScanId, available: Boolean(comparison.available), reason: comparison.reason ?? null },
    changes,
  };
}

function standardDecayWindows(endDate: string) {
  return {
    current: { startDate: shiftDate(endDate, -(DECAY_WINDOW_DAYS - 1)), endDate },
    previous: { startDate: shiftDate(endDate, -(2 * DECAY_WINDOW_DAYS - 1)), endDate: shiftDate(endDate, -DECAY_WINDOW_DAYS) },
  };
}

// Default windows inside the dates stored page data answers: the last 28 days
// vs the 28 before, or, with fewer than 56 days, two equal halves of the days
// that exist. `reason` is set when there is too little data; the windows then
// only suggest what to sync, ending three days ago (Search Console's usual delay).
function defaultDecayWindows(siteId: string) {
  const suggestion = standardDecayWindows(shiftDate(new Date().toISOString().slice(0, 10), -3));
  const syncHint = `Sync Search Console with dimensions page,date for the last ${2 * DECAY_WINDOW_DAYS} days.`;
  const range = pageDataRange(siteId);
  if (!range) {
    return {
      ...suggestion,
      note: null,
      reason: `No Search Console page data with a date range is stored for this site. ${syncHint}`,
    };
  }
  // Page batches without the date dimension answer only their exact windows.
  if (!range.startDate) return { ...standardDecayWindows(range.endDate), note: null, reason: null };
  const lagNote =
    range.requestedEndDate && range.requestedEndDate > range.endDate
      ? `Search Console rows stop at ${range.endDate}, before the synced end date ${range.requestedEndDate} (Google's reporting delay), so the current window ends at ${range.endDate}.`
      : "";
  const days = Math.max(0, dayCount(range.startDate, range.endDate));
  if (days >= 2 * DECAY_WINDOW_DAYS) return { ...standardDecayWindows(range.endDate), note: lagNote || null, reason: null };
  const stored = `${days} day${days === 1 ? "" : "s"} of page + date data (${range.startDate} to ${range.endDate})`;
  const half = Math.floor(days / 2);
  if (half < DECAY_MIN_WINDOW_DAYS) {
    return {
      ...suggestion,
      note: null,
      reason: `Only ${stored} ${days === 1 ? "is" : "are"} stored; content decay needs at least ${2 * DECAY_MIN_WINDOW_DAYS} days for two ${DECAY_MIN_WINDOW_DAYS}-day windows. ${syncHint}`,
    };
  }
  const halvesNote = `Only ${stored} are stored, fewer than the ${2 * DECAY_WINDOW_DAYS} needed for ${DECAY_WINDOW_DAYS} vs ${DECAY_WINDOW_DAYS} days, so each window is ${half} days${days % 2 ? ` and ${range.startDate} is left out` : ""}.`;
  return {
    current: { startDate: shiftDate(range.endDate, -(half - 1)), endDate: range.endDate },
    previous: { startDate: shiftDate(range.endDate, -(2 * half - 1)), endDate: shiftDate(range.endDate, -half) },
    note: [halvesNote, lagNote].filter(Boolean).join(" "),
    reason: null,
  };
}

// Pages that lost clicks or impressions between two windows of stored page
// data. Without windows, defaultDecayWindows picks them and `note` says how.
export function contentDecay(
  siteId: string,
  input: { currentStart?: unknown; currentEnd?: unknown; previousStart?: unknown; previousEnd?: unknown; limit?: unknown },
) {
  requireSite(siteId);
  const explicitCurrent = optionalWindow(input.currentStart, input.currentEnd, ["currentStart", "currentEnd"]);
  const explicitPrevious = optionalWindow(input.previousStart, input.previousEnd, ["previousStart", "previousEnd"]);
  if (Boolean(explicitCurrent) !== Boolean(explicitPrevious)) {
    throw badRequest("Pass both the current and the previous window, or neither.");
  }
  const limit = optionalInt(input.limit, "limit", 200, 1, 1000);
  const defaults = explicitCurrent ? null : defaultDecayWindows(siteId);
  const current: GscWindow = explicitCurrent || defaults!.current;
  const previous: GscWindow = explicitPrevious || defaults!.previous;
  const note = defaults?.note ?? null;
  const unavailable = (reason: string) => ({
    available: false,
    reason,
    current,
    previous,
    note,
    rows: [],
    suggestedSync: {
      dimensions: ["page", "date"],
      startDate: previous.startDate < current.startDate ? previous.startDate : current.startDate,
      endDate: previous.endDate > current.endDate ? previous.endDate : current.endDate,
    },
  });
  if (defaults?.reason) return unavailable(defaults.reason);
  const currentData = gscPageData(siteId, current, { allowQueryRows: false });
  const previousData = gscPageData(siteId, previous, { allowQueryRows: false });
  if (!currentData || !previousData) {
    const missing = [!previousData ? previous : null, !currentData ? current : null]
      .filter((window): window is GscWindow => Boolean(window))
      .map((window) => `${window.startDate} to ${window.endDate}`)
      .join(" and ");
    return unavailable(
      `Stored Search Console page data does not cover ${missing}. Sync Search Console with dimensions page,date across both windows, or sync (or import) the page dimension for exactly each window.`,
    );
  }
  const { scanComparison, changes } = windowScanChanges(siteId, current, previous);
  const rows: any[] = [];
  for (const key of new Set([...currentData.pages.keys(), ...previousData.pages.keys()])) {
    const now = windowMetrics(currentData.pages.get(key), currentData);
    const before = windowMetrics(previousData.pages.get(key), previousData);
    const deltaClicks = delta(now.clicks, before.clicks);
    const deltaImpressions = delta(now.impressions, before.impressions);
    if (!((deltaClicks ?? 0) < 0 || (deltaImpressions ?? 0) < 0)) continue;
    rows.push({
      url: (currentData.pages.get(key) || previousData.pages.get(key))?.url,
      current: now,
      previous: before,
      deltaClicks,
      deltaImpressions,
      deltaPosition: delta(now.position, before.position, 2),
      scanChanges: changes.get(key) || [],
    });
  }
  rows.sort((a, b) => (a.deltaClicks ?? 0) - (b.deltaClicks ?? 0) || (a.deltaImpressions ?? 0) - (b.deltaImpressions ?? 0));
  return {
    available: true,
    current,
    previous,
    note,
    sources: { current: gscRangeView(currentData), previous: gscRangeView(previousData) },
    scanComparison,
    total: rows.length,
    rows: rows.slice(0, limit),
  };
}
