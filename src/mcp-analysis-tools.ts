import { cwvStatus, startCwvRun } from "./cwv";
import { get } from "./db";
import { badRequest, notFound } from "./errors";
import { listGscRows, syncGscPerformance } from "./gsc";
import { optionalChoice, optionalInt } from "./input";
import { cannibalization, contentDecay, gscCrawlInsights } from "./insights";
import { listNotifications } from "./notifications";
import { latestCompletedScanId, queryScanIssues, requireScan, SEVERITIES, scanOverview } from "./scan-summary";
import {
  cancelScan,
  compareScans,
  createIssueIgnore,
  deleteIssueIgnore,
  getScanPage,
  listAllScans,
  listIssueIgnores,
  listScans,
  scanIssueTypeList,
} from "./scans";
import { getSiteSchedule, SCHEDULE_INTERVALS, setScanSchedule, setTrackerSchedule } from "./scheduler";
import { getSite } from "./seo";

// MCP tools for scans, Search Console analyses, PageSpeed, schedules, and
// notifications. Each one calls the same functions as the HTTP API.

export type ToolDefinition = {
  name: string;
  description: string;
  inputSchema: { type: string; properties: Record<string, any>; required?: string[] };
};

const siteIdInput = { siteId: { type: "string", description: "Local site id." } };
const scanIdInput = { scanId: { type: "string", description: "Saved scan id." } };
const dateInput = (description: string) => ({ type: "string", description: `${description} (YYYY-MM-DD).` });
const intervalInput = { type: "string", enum: [...SCHEDULE_INTERVALS] };

export const analysisTools: ToolDefinition[] = [
  {
    name: "list_scans",
    description: "List saved scans newest first as small rows (status, counts, crawl summary) without crawl evidence. All sites unless siteId is given.",
    inputSchema: { type: "object", properties: { siteId: { type: "string", description: "Optional local site id." } } },
  },
  {
    name: "get_scan_summary",
    description:
      "Read one scan's summary: status, crawl limits and counts, regressions vs the previous scan, and issue groups with example URLs. No per-page or per-issue arrays.",
    inputSchema: { type: "object", properties: scanIdInput, required: ["scanId"] },
  },
  {
    name: "get_scan_issues",
    description: "List a scan's issues, filtered by severity, category, issue type, or URL substring, paged (limit up to 200). Returns the matching total.",
    inputSchema: {
      type: "object",
      properties: {
        ...scanIdInput,
        severity: { type: "string", enum: [...SEVERITIES] },
        category: { type: "string", description: "Issue category, e.g. metadata, links, indexability." },
        type: { type: "string", description: "Issue type from list_issue_types, e.g. title-missing." },
        url: { type: "string", description: "Case-insensitive URL substring." },
        includeIgnored: { type: "boolean", description: "Include issues hidden by ignore rules (default false)." },
        limit: { type: "number", minimum: 1, maximum: 200 },
        offset: { type: "number", minimum: 0 },
      },
      required: ["scanId"],
    },
  },
  {
    name: "get_scan_page",
    description: "Read one crawled page of a scan: its evidence, issues, inlinks, and changes since the previous completed scan.",
    inputSchema: {
      type: "object",
      properties: { ...scanIdInput, url: { type: "string", description: "Page URL as crawled." } },
      required: ["scanId", "url"],
    },
  },
  {
    name: "compare_scans",
    description: "Compare a scan with an older scan of the same site (default: the previous completed scan): new, fixed, and changed issues, page changes, and regressions.",
    inputSchema: {
      type: "object",
      properties: { ...scanIdInput, baseScanId: { type: "string", description: "Older scan to compare with." } },
      required: ["scanId"],
    },
  },
  {
    name: "cancel_scan",
    description: "Cancel a queued or running scan; the pages crawled so far are kept.",
    inputSchema: { type: "object", properties: scanIdInput, required: ["scanId"] },
  },
  {
    name: "list_issue_types",
    description: "List every scan issue type with its title, category, usual severity, why it matters, and how to fix it.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "list_issue_ignores",
    description: "List a site's issue ignore rules.",
    inputSchema: { type: "object", properties: siteIdInput, required: ["siteId"] },
  },
  {
    name: "create_issue_ignore",
    description: "Ignore an issue type site-wide, every issue on one URL, or one issue type on one URL. Saved scans keep their evidence; ignored issues leave counts.",
    inputSchema: {
      type: "object",
      properties: {
        ...siteIdInput,
        type: { type: "string", description: "Issue type to ignore (omit to ignore every issue on url)." },
        url: { type: "string", description: "Page URL (omit to ignore the type on every page)." },
        note: { type: "string" },
      },
      required: ["siteId"],
    },
  },
  {
    name: "delete_issue_ignore",
    description: "Delete an issue ignore rule so its issues count again.",
    inputSchema: {
      type: "object",
      properties: { ...siteIdInput, ignoreId: { type: "string" } },
      required: ["siteId", "ignoreId"],
    },
  },
  {
    name: "gsc_sync",
    description:
      "Fetch every Google Search Console row for a window and dimensions (e.g. page, query+page, page+date) through the site's OAuth connection and store it locally.",
    inputSchema: {
      type: "object",
      properties: {
        ...siteIdInput,
        startDate: dateInput("First day"),
        endDate: dateInput("Last day"),
        dimensions: { type: "array", items: { type: "string" }, description: "query, page, country, device, date." },
        siteUrl: { type: "string", description: "Search Console property; defaults to the connected one." },
      },
      required: ["siteId", "startDate", "endDate"],
    },
  },
  {
    name: "gsc_rows",
    description:
      "Read stored Search Console rows (CSV imports and API syncs) for a saved site, paged. Pick the batch by dimensions (e.g. query and page) and date window, or by importId.",
    inputSchema: {
      type: "object",
      properties: {
        ...siteIdInput,
        dimensions: { type: "array", items: { type: "string" } },
        startDate: { type: "string" },
        endDate: { type: "string" },
        importId: { type: "string" },
        limit: { type: "number", minimum: 1, maximum: 10000 },
        offset: { type: "number", minimum: 0 },
      },
      required: ["siteId"],
    },
  },
  {
    name: "gsc_crawl_insights",
    description:
      "Match stored Search Console pages with a completed crawl: pages with impressions that are not indexable, indexable pages without impressions, Search Console pages the crawl never reached or that are missing from the sitemap, and CTR outliers against the site's own median CTR by position.",
    inputSchema: {
      type: "object",
      properties: {
        ...siteIdInput,
        scanId: { type: "string", description: "Completed scan (default: the latest)." },
        startDate: dateInput("Window start (default: latest stored page window)"),
        endDate: dateInput("Window end"),
      },
      required: ["siteId"],
    },
  },
  {
    name: "cannibalization",
    description: "Queries where two or more pages each earn at least 10% of the impressions, from stored query + page Search Console rows, with the URLs rank checks recorded for the same keyword.",
    inputSchema: {
      type: "object",
      properties: {
        ...siteIdInput,
        startDate: dateInput("Window start"),
        endDate: dateInput("Window end"),
        minImpressions: {
          type: "number",
          minimum: 0,
          description: "Minimum total impressions of the query across all its pages, not per page (default 10).",
        },
      },
      required: ["siteId"],
    },
  },
  {
    name: "content_decay",
    description:
      "Pages that lost clicks or impressions between two windows of stored Search Console page data (default: the last 28 days that have rows vs the 28 before, or two equal halves when fewer than 56 days are stored, explained in `note`), with page changes between the latest completed scans on or before each window's end.",
    inputSchema: {
      type: "object",
      properties: {
        ...siteIdInput,
        currentStart: dateInput("Current window start"),
        currentEnd: dateInput("Current window end"),
        previousStart: dateInput("Previous window start"),
        previousEnd: dateInput("Previous window end"),
        limit: { type: "number", minimum: 1, maximum: 1000 },
      },
      required: ["siteId"],
    },
  },
  {
    name: "cwv_run",
    description:
      "Start a Google PageSpeed Insights run in the background for up to 25 URLs (default: the latest scan's most linked indexable pages). Poll cwv_results.",
    inputSchema: {
      type: "object",
      properties: {
        ...siteIdInput,
        urls: { type: "array", items: { type: "string" } },
        strategy: { type: "string", enum: ["mobile", "desktop"] },
        limit: { type: "number", minimum: 1, maximum: 25, description: "Default URL count (default 5)." },
      },
      required: ["siteId"],
    },
  },
  {
    name: "cwv_results",
    description: "Read the latest PageSpeed Insights result per URL (Chrome UX Report field data when Google has it, Lighthouse lab data) and recent runs.",
    inputSchema: { type: "object", properties: siteIdInput, required: ["siteId"] },
  },
  {
    name: "get_schedule",
    description: "Read a site's scheduled scan and rank tracker schedules (off unless set).",
    inputSchema: { type: "object", properties: siteIdInput, required: ["siteId"] },
  },
  {
    name: "set_scan_schedule",
    description: "Set how often the site is scanned automatically while the app runs: off, daily, weekly, or monthly.",
    inputSchema: {
      type: "object",
      properties: { ...siteIdInput, interval: intervalInput },
      required: ["siteId", "interval"],
    },
  },
  {
    name: "set_tracker_schedule",
    description: "Set how often a rank tracker checks its keywords automatically while the app runs: off, daily, weekly, or monthly.",
    inputSchema: {
      type: "object",
      properties: { trackerId: { type: "string" }, interval: intervalInput },
      required: ["trackerId", "interval"],
    },
  },
  {
    name: "list_notifications",
    description: "List notifications (scan regressions, failed scheduled scans, failed or partial scheduled rank checks) with the unread count.",
    inputSchema: {
      type: "object",
      properties: {
        siteId: { type: "string", description: "Optional local site id." },
        unread: { type: "boolean", description: "Only unread notifications." },
        limit: { type: "number", minimum: 1, maximum: 500 },
      },
    },
  },
];

function requireSite(siteId: string) {
  if (!getSite(siteId)) throw notFound("Site not found.");
}

function baseScanFor(scanId: string, baseScanId: unknown) {
  if (baseScanId) return String(baseScanId);
  const scan = get<{ site_id: string }>("SELECT site_id FROM scans WHERE id = ?", [scanId]);
  if (!scan) throw notFound("Scan not found.");
  const previous = latestCompletedScanId(scan.site_id, scanId);
  if (!previous) throw badRequest("No earlier completed scan of this site to compare with.");
  return previous;
}

export const analysisHandlers: Record<string, (args: Record<string, any>) => unknown> = {
  list_scans: (args) => {
    if (!args.siteId) return { scans: listAllScans() };
    requireSite(args.siteId);
    return { scans: listScans(args.siteId) };
  },
  get_scan_summary: (args) => scanOverview(requireScan(args.scanId)),
  get_scan_issues: (args) =>
    queryScanIssues(requireScan(args.scanId), {
      severity: args.severity ? optionalChoice(args.severity, "severity", SEVERITIES, "high") : undefined,
      category: args.category,
      type: args.type,
      url: args.url,
      includeIgnored: args.includeIgnored === true,
      limit: optionalInt(args.limit, "limit", 50, 1, 200),
      offset: optionalInt(args.offset, "offset", 0, 0, 1_000_000_000),
    }),
  get_scan_page: (args) => getScanPage(args.scanId, args.url),
  compare_scans: (args) => compareScans(args.scanId, baseScanFor(args.scanId, args.baseScanId)),
  cancel_scan: (args) => cancelScan(args.scanId),
  list_issue_types: () => ({ types: scanIssueTypeList() }),
  list_issue_ignores: (args) => ({ ignores: listIssueIgnores(args.siteId) }),
  create_issue_ignore: (args) => createIssueIgnore(args.siteId, { type: args.type, url: args.url, note: args.note }),
  delete_issue_ignore: (args) => deleteIssueIgnore(args.siteId, args.ignoreId),
  gsc_sync: (args) => syncGscPerformance(args),
  gsc_rows: (args) => listGscRows(args.siteId, args),
  gsc_crawl_insights: (args) => gscCrawlInsights(args.siteId, args),
  cannibalization: (args) => cannibalization(args.siteId, args),
  content_decay: (args) => contentDecay(args.siteId, args),
  cwv_run: (args) => startCwvRun(args.siteId, args),
  cwv_results: (args) => cwvStatus(args.siteId),
  get_schedule: (args) => getSiteSchedule(args.siteId),
  set_scan_schedule: (args) => setScanSchedule(args.siteId, { scanInterval: args.interval }),
  set_tracker_schedule: (args) => setTrackerSchedule(args.trackerId, { interval: args.interval }),
  list_notifications: (args) => listNotifications({ siteId: args.siteId, unread: args.unread === true, limit: args.limit }),
};
