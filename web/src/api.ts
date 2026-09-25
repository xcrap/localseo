export type Site = {
  id: string;
  name: string;
  domain: string;
  notes: string;
  location_code: number;
  language_code: string;
  crawl_protocol: "auto" | "https" | "http" | "both";
  crawl_host: "auto" | "root" | "www" | "both";
  crawl_speed: "auto" | "polite" | "fast";
  crawl_max_pages: number;
};

export type KeywordResult = {
  keyword: string;
  searchVolume: number | null;
  difficulty: number | null;
  cpc: number | null;
  intent: string;
};

export class ApiError extends Error {
  status: number;
  data: unknown;
  constructor(message: string, status: number, data: unknown) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.data = data;
  }
}

function parseBody(text: string) {
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function errorMessage(data: unknown, response: Response) {
  if (data && typeof data === "object") {
    const body = data as { error?: unknown; message?: unknown };
    const message = body.error || body.message;
    if (typeof message === "string" && message.trim()) return message;
  }
  if (typeof data === "string" && data.trim() && !/^\s*</.test(data)) return data.trim();
  return `${response.status} ${response.statusText || "Request failed"}`.trim();
}

async function request<T>(path: string, options: RequestInit = {}): Promise<T> {
  const response = await fetch(path, {
    credentials: "include",
    ...options,
    headers: {
      "Content-Type": "application/json",
      ...(options.headers || {}),
    },
  });
  const data = parseBody(await response.text());
  if (!response.ok) {
    throw new ApiError(errorMessage(data, response), response.status, data);
  }
  return data as T;
}

export function isNotFoundError(error: unknown) {
  return error instanceof ApiError && error.status === 404;
}

// Scan list endpoints return lite rows: scan columns plus a result that only
// carries scanVersion, phase, startUrl, limits, summary and live progress.
// Anything that needs pages/issues/links must load the full scan by id.
export type ScanStatus = "queued" | "running" | "completed" | "failed" | "cancelled";

export type ScanProgress = {
  currentUrl?: string;
  pagesCrawled?: number;
  queued?: number;
  startedAt?: string;
  elapsedMs?: number;
  pagesPerSecond?: number;
  phase?: string;
};

export type ScanRow = {
  id: string;
  site_id: string | null;
  url: string;
  status: ScanStatus | string;
  score: number | null;
  pages_crawled: number;
  issue_count: number;
  error?: string | null;
  created_at: string;
  updated_at: string;
  site_name?: string;
  site_domain?: string;
  result?: {
    scanVersion?: number;
    phase?: string;
    startUrl?: string;
    limits?: { maxPages?: number; [key: string]: unknown };
    summary?: Record<string, any>;
    progress?: ScanProgress;
    [key: string]: any;
  } | null;
};

export type ScanIssueType = {
  type: string;
  title: string;
  category: string;
  severity: string;
  why: string;
  fix: string;
};

export type ScanPageDetail = {
  page: any;
  issues: any[];
  inlinks: { from: string; anchor?: string; nofollow?: boolean }[];
  outlinks: any[];
  images: any[];
  previous: { url: string; changes: any[] } | null;
};

// Rank tracking. A check runs in the background: POST .../check answers at
// once and the run is polled until its status leaves "running".
export type RankRunStatus = "queued" | "running" | "completed" | "partial" | "failed";

export type RankRunError = { keywordId: string; keyword: string; error: string };

export type RankRun = {
  id: string;
  tracker_id: string;
  status: RankRunStatus | string;
  message: string;
  started_at: string;
  finished_at: string | null;
  keyword_count: number;
  checked_count: number;
  error_count: number;
  errors: RankRunError[];
};

export type RankSnapshot = {
  id: string;
  run_id: string;
  tracker_id: string;
  keyword_id: string | null;
  keyword: string;
  position: number | null;
  url: string;
  title: string;
  checked_at: string;
  /** How deep the results went; a null position means "not in the top N checked". */
  depth_checked: number | null;
  source: string;
};

export type RankTracker = {
  id: string;
  site_id: string;
  domain: string;
  location_code: number;
  language_code: string;
  device: string;
  serp_depth: number;
  created_at: string;
  keywords: any[];
  /** The newest runs (capped server-side); runCount is the full total. */
  runs: RankRun[];
  runCount: number;
  /** Latest snapshot per keyword, from completed runs only. */
  latest: RankSnapshot[];
};

export type RankCheckStart = { runId: string; alreadyRunning: boolean; run: RankRun; tracker: RankTracker };

export type RankRunsPage = { runs: RankRun[]; total: number; limit: number; offset: number; hasMore: boolean };

// Search Console. Import/sync history is metadata only; rows load on demand.
export type GscStatus = {
  configured: boolean;
  connected: boolean;
  /** A saved grant Google rejected (revoked/expired): reconnect before querying. */
  needsReconnect: boolean;
  authError: string;
  /** The exact OAuth redirect URI to register in Google Cloud. */
  redirectUri: string;
  connection: { siteId: string; siteUrl: string; accountEmail: string; expiresAt: string | number | null } | null;
};

export type GscBatch = {
  id: string;
  siteId: string;
  siteUrl: string;
  sourceName: string;
  source: "csv" | "api" | string;
  dimensions: string[];
  rowCount: number;
  totals: Record<string, number | null>;
  startDate: string | null;
  endDate: string | null;
  createdAt: string;
};

export type GscLegacyRow = {
  keys: string[];
  clicks: number | null;
  impressions: number | null;
  ctr: number | null;
  position: number | null;
};

export type GscBatchWithRows = GscBatch & { rows: GscLegacyRow[] };

export type GscSyncResult = GscBatch & { pagesFetched: number; truncated: boolean };

export type GscStoredRow = {
  query: string | null;
  page: string | null;
  country: string | null;
  device: string | null;
  date: string | null;
  clicks: number | null;
  impressions: number | null;
  ctr: number | null;
  position: number | null;
};

export type GscRowsPage = {
  batch: GscBatch | null;
  rows: GscStoredRow[];
  total: number;
  limit: number;
  offset: number;
  hasMore: boolean;
};

export type GscRowsQuery = {
  dimensions?: string[];
  startDate?: string;
  endDate?: string;
  importId?: string;
  limit?: number;
  offset?: number;
};

// Insights join stored Search Console rows with local crawl evidence.
export type InsightRow = {
  url: string;
  clicks: number | null;
  impressions: number | null;
  ctr: number | null;
  position: number | null;
  status?: number | null;
  indexable?: boolean | null;
  reason?: string | null;
  canonical?: string | null;
  inSitemap?: boolean | null;
  expectedCtr?: number | null;
};

export type GscCrawlSectionKey =
  | "impressionsNotIndexable"
  | "indexableNoImpressions"
  | "gscPagesNotCrawled"
  | "gscPagesNotInSitemap"
  | "ctrOutliers";

export type GscCrawlInsights = {
  available: boolean;
  reason?: string;
  scan: { id: string; created_at: string } | null;
  gscRange: { startDate: string; endDate: string; source: "api" | "csv" | string } | null;
  sections: Partial<Record<GscCrawlSectionKey, InsightRow[]>>;
  ctrCurve: { position: number; medianCtr: number | null; pages: number }[];
};

export type CannibalizationPage = {
  url: string;
  clicks: number | null;
  impressions: number | null;
  ctr: number | null;
  position: number | null;
};

export type CannibalizationInsights = {
  available: boolean;
  reason?: string;
  range: { startDate: string; endDate: string } | null;
  rows: { query: string; totalImpressions: number; totalClicks: number; pages: CannibalizationPage[]; rankUrls: string[] }[];
};

export type DecayMetrics = { clicks: number | null; impressions: number | null; position: number | null };

export type DecayInsights = {
  available: boolean;
  reason?: string;
  current: { startDate: string; endDate: string } | null;
  previous: { startDate: string; endDate: string } | null;
  rows: {
    url: string;
    current: DecayMetrics;
    previous: DecayMetrics;
    deltaClicks: number | null;
    deltaImpressions: number | null;
    deltaPosition: number | null;
    scanChanges: { field: string; before: unknown; after: unknown }[];
  }[];
};

// Schedules only run while the local app process is running.
export type ScheduleInterval = "off" | "daily" | "weekly" | "monthly";

export type SiteSchedule = {
  scan: { interval: ScheduleInterval; nextRunAt: string | null; lastRunAt: string | null };
  trackers: { id: string; name: string; interval: ScheduleInterval; nextCheckAt: string | null; lastRunAt: string | null }[];
};

export type NotificationType = "scan-regression" | "rank-run-problem" | "scan-failed";

export type AppNotification = {
  id: string;
  site_id: string | null;
  site_name: string | null;
  type: NotificationType | string;
  title: string;
  body: string;
  data: Record<string, any> | null;
  created_at: string;
  read_at: string | null;
};

export type NotificationList = { rows: AppNotification[]; unreadCount: number };

// Core Web Vitals: field data is Chrome UX Report (28-day real users), lab
// data is one Lighthouse run. The two are never mixed.
export type CwvStrategy = "mobile" | "desktop";

export type CwvFieldMetrics = {
  lcpMs: number | null;
  inpMs: number | null;
  cls: number | null;
  fcpMs: number | null;
  ttfbMs: number | null;
  overall: string | null;
};

export type CwvLabMetrics = {
  performanceScore: number | null;
  lcpMs: number | null;
  cls: number | null;
  tbtMs: number | null;
  fcpMs: number | null;
  speedIndexMs: number | null;
};

export type CwvResult = {
  url: string;
  strategy: CwvStrategy | string;
  fetchedAt: string | null;
  field: CwvFieldMetrics | null;
  originField: CwvFieldMetrics | null;
  lab: CwvLabMetrics | null;
  error: string | null;
};

export type CwvStatus = { keyConfigured: boolean; running: boolean; latest: CwvResult[]; runs: any[] };

export type RobotsTestResult = {
  allowed: boolean;
  matchedRule: { type: string; path: string } | null;
  userAgentGroup: string | null;
  robotsUrl: string;
  source: "live" | "provided";
  fetchedStatus: number | null;
};

export type AiJob = {
  id: string;
  type: string;
  prompt: string;
  status: string;
  message?: string;
  result_text?: string | null;
  error?: string | null;
  site_id?: string | null;
  created_at: string;
  started_at?: string | null;
  finished_at?: string | null;
};

function queryString(params: Record<string, unknown>) {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value == null || value === "") continue;
    search.set(key, Array.isArray(value) ? value.join(",") : String(value));
  }
  const text = search.toString();
  return text ? `?${text}` : "";
}

export const auth = {
  me: () => request<{ authenticated: boolean; setupRequired: boolean; user?: { email: string } }>("/api/auth/me"),
  setup: (email: string, password: string) =>
    request("/api/auth/setup", { method: "POST", body: JSON.stringify({ email, password }) }),
  login: (email: string, password: string, remember: boolean) =>
    request("/api/auth/login", { method: "POST", body: JSON.stringify({ email, password, remember }) }),
  logout: () => request("/api/auth/logout", { method: "POST" }),
};

export const api = {
  dashboard: (siteId?: string) => request<any>(siteId ? `/api/dashboard?siteId=${encodeURIComponent(siteId)}` : "/api/dashboard"),
  config: () => request<any>("/api/config"),
  saveConfig: (body: Record<string, string>) =>
    request<any>("/api/config", { method: "PUT", body: JSON.stringify(body) }),
  sites: () => request<Site[]>("/api/sites"),
  createSite: (body: Partial<Site>) =>
    request<Site>("/api/sites", { method: "POST", body: JSON.stringify(body) }),
  updateSite: (id: string, body: Partial<Site>) =>
    request<Site>(`/api/sites/${id}`, { method: "PUT", body: JSON.stringify(body) }),
  deleteSite: (id: string) =>
    request<any>(`/api/sites/${id}`, { method: "DELETE" }),
  scanSite: (id: string) =>
    request<any>(`/api/sites/${id}/scan`, { method: "POST" }),
  researchKeywords: (body: any) =>
    request<{ id: string; source: string; rows: KeywordResult[] }>("/api/keywords/research", {
      method: "POST",
      body: JSON.stringify(body),
    }),
  saveKeywords: (body: any) =>
    request<any>("/api/keywords/save", { method: "POST", body: JSON.stringify(body) }),
  querySavedKeywords: (siteId: string, body: any) =>
    request<any>(`/api/sites/${siteId}/keywords/query`, { method: "POST", body: JSON.stringify(body) }),
  keywordTags: (siteId: string) => request<any[]>(`/api/sites/${siteId}/keyword-tags`),
  updateKeywordTags: (siteId: string, body: any) =>
    request<any>(`/api/sites/${siteId}/keywords/tags`, { method: "POST", body: JSON.stringify(body) }),
  updateKeywordTag: (siteId: string, tagId: string, body: any) =>
    request<any>(`/api/sites/${siteId}/keyword-tags/${tagId}`, { method: "PUT", body: JSON.stringify(body) }),
  deleteKeywordTag: (siteId: string, tagId: string) =>
    request<any>(`/api/sites/${siteId}/keyword-tags/${tagId}`, { method: "DELETE" }),
  removeSavedKeywords: (siteId: string, savedKeywordIds: string[]) =>
    request<any>(`/api/sites/${siteId}/keywords/remove`, {
      method: "POST",
      body: JSON.stringify({ savedKeywordIds }),
    }),
  savedKeywordsCsvUrl: (siteId: string) => `/api/sites/${siteId}/keywords.csv`,
  keywordMetricImports: (siteId: string) => request<any[]>(`/api/sites/${siteId}/keyword-metric-imports`),
  importKeywordMetrics: (body: any) =>
    request<any>("/api/keywords/import-metrics", { method: "POST", body: JSON.stringify(body) }),
  serpRuns: (siteId: string) => request<any[]>(`/api/sites/${siteId}/serp`),
  analyzeSerp: (body: any) =>
    request<any>("/api/serp/analyze", { method: "POST", body: JSON.stringify(body) }),
  rankTrackers: (siteId: string) => request<RankTracker[]>(`/api/sites/${siteId}/rank-trackers`),
  createRankTracker: (body: any) =>
    request<any>("/api/rank-trackers", { method: "POST", body: JSON.stringify(body) }),
  addRankKeywords: (trackerId: string, keywords: string[]) =>
    request<any>(`/api/rank-trackers/${trackerId}/keywords`, {
      method: "POST",
      body: JSON.stringify({ keywords }),
    }),
  removeRankKeywords: (trackerId: string, keywordIds: string[]) =>
    request<any>(`/api/rank-trackers/${trackerId}/keywords/remove`, {
      method: "POST",
      body: JSON.stringify({ keywordIds }),
    }),
  syncRankMetrics: (trackerId: string) =>
    request<any>(`/api/rank-trackers/${trackerId}/sync-metrics`, { method: "POST" }),
  runRankCheck: (trackerId: string) =>
    request<RankCheckStart>(`/api/rank-trackers/${trackerId}/check`, { method: "POST" }),
  rankRun: (trackerId: string, runId: string) =>
    request<RankRun>(`/api/rank-trackers/${trackerId}/runs/${runId}`),
  rankRuns: (trackerId: string, options: { limit?: number; offset?: number } = {}) =>
    request<RankRunsPage>(`/api/rank-trackers/${trackerId}/runs${queryString(options)}`),
  setTrackerSchedule: (trackerId: string, interval: ScheduleInterval) =>
    request<any>(`/api/rank-trackers/${trackerId}/schedule`, { method: "PUT", body: JSON.stringify({ interval }) }),
  domainOverview: (body: any) =>
    request<any>("/api/domain/overview", { method: "POST", body: JSON.stringify(body) }),
  domainSnapshots: (siteId: string) => request<any[]>(`/api/sites/${siteId}/domain-snapshots`),
  domainKeywords: (body: any) =>
    request<any>("/api/domain/keywords", { method: "POST", body: JSON.stringify(body) }),
  domainPages: (body: any) =>
    request<any>("/api/domain/pages", { method: "POST", body: JSON.stringify(body) }),
  importOrganicResearch: (body: any) =>
    request<any>("/api/domain/import", { method: "POST", body: JSON.stringify(body) }),
  backlinksOverview: (body: any) =>
    request<any>("/api/backlinks/overview", { method: "POST", body: JSON.stringify(body) }),
  backlinkSnapshots: (siteId: string) => request<any[]>(`/api/sites/${siteId}/backlink-snapshots`),
  backlinksProfile: (body: any) =>
    request<any>("/api/backlinks/profile", { method: "POST", body: JSON.stringify(body) }),
  importBacklinks: (body: any) =>
    request<any>("/api/backlinks/import", { method: "POST", body: JSON.stringify(body) }),
  brandLookupRuns: (siteId: string) => request<any[]>(`/api/sites/${siteId}/brand-lookup`),
  brandLookup: (body: any) =>
    request<any>("/api/brand-lookup", { method: "POST", body: JSON.stringify(body) }),
  promptExplorerRuns: (siteId: string) => request<any[]>(`/api/sites/${siteId}/prompt-explorer`),
  promptExplorer: (body: any) =>
    request<any>("/api/prompt-explorer", { method: "POST", body: JSON.stringify(body) }),
  allScans: () => request<ScanRow[]>("/api/scans"),
  scans: (siteId: string) => request<ScanRow[]>(`/api/sites/${siteId}/scans`),
  scan: (id: string) => request<any>(`/api/scans/${id}`),
  scanPage: (id: string, url: string) =>
    request<ScanPageDetail>(`/api/scans/${id}/page?url=${encodeURIComponent(url)}`),
  compareScans: (id: string, baseId: string) =>
    request<any>(`/api/scans/${id}/compare/${baseId}`),
  cancelScan: (id: string) =>
    request<any>(`/api/scans/${id}/cancel`, { method: "POST" }),
  scanIssueTypes: () => request<ScanIssueType[]>("/api/scan-issue-types"),
  scanAiContext: (id: string) => request<{ text: string }>(`/api/scans/${id}/ai-context`),
  /** Standalone HTML report; `download` makes the server send it as an attachment. */
  scanReportUrl: (id: string, download = false) => `/api/scans/${id}/report.html${download ? "?download=1" : ""}`,
  startScan: (body: any) =>
    request<any>("/api/scans", { method: "POST", body: JSON.stringify(body) }),
  clearScans: (siteId: string) =>
    request<any>(`/api/sites/${siteId}/scans`, { method: "DELETE" }),
  deleteScan: (siteId: string, scanId: string) =>
    request<any>(`/api/sites/${siteId}/scans/${scanId}`, { method: "DELETE" }),
  issueIgnores: (siteId: string) => request<any[]>(`/api/sites/${siteId}/issue-ignores`),
  createIssueIgnore: (siteId: string, body: any) =>
    request<any>(`/api/sites/${siteId}/issue-ignores`, { method: "POST", body: JSON.stringify(body) }),
  deleteIssueIgnore: (siteId: string, ignoreId: string) =>
    request<any>(`/api/sites/${siteId}/issue-ignores/${ignoreId}`, { method: "DELETE" }),
  clearIssueIgnores: (siteId: string) =>
    request<{ deleted: number }>(`/api/sites/${siteId}/issue-ignores`, { method: "DELETE" }),
  aiPrompts: () => request<any[]>("/api/ai/prompts"),
  /** With a site: that site's jobs plus jobs saved without a site. */
  aiJobs: (siteId?: string) => request<AiJob[]>(`/api/ai/jobs${queryString({ siteId })}`),
  aiJob: (id: string) => request<AiJob>(`/api/ai/jobs/${id}`),
  createAiJob: (body: { type: string; prompt: string; siteId?: string; scanId?: string }) =>
    request<AiJob>("/api/ai/jobs", { method: "POST", body: JSON.stringify(body) }),
  gscStatus: (siteId: string) => request<GscStatus>(`/api/gsc/status/${siteId}`),
  /** Import and sync history: metadata and totals only. */
  gscImports: (siteId: string) => request<GscBatch[]>(`/api/gsc/imports/${siteId}`),
  gscImportRows: (siteId: string, importId: string) =>
    request<GscBatchWithRows>(`/api/gsc/imports/${siteId}/${importId}`),
  gscStart: (siteId: string) =>
    request<{ url: string; redirectUri: string }>("/api/gsc/start", { method: "POST", body: JSON.stringify({ siteId }) }),
  gscSync: (siteId: string, body: { startDate: string; endDate: string; dimensions: string[] }) =>
    request<GscSyncResult>(`/api/sites/${siteId}/gsc/sync`, { method: "POST", body: JSON.stringify(body) }),
  gscRows: (siteId: string, query: GscRowsQuery = {}) =>
    request<GscRowsPage>(`/api/sites/${siteId}/gsc/rows${queryString(query)}`),
  gscSites: (siteId: string) => request<any[]>(`/api/gsc/sites/${siteId}`),
  gscSetSite: (siteId: string, siteUrl: string) =>
    request<any>("/api/gsc/site", { method: "POST", body: JSON.stringify({ siteId, siteUrl }) }),
  gscPerformance: (body: any) =>
    request<any>("/api/gsc/performance", { method: "POST", body: JSON.stringify(body) }),
  gscImport: (body: any) =>
    request<any>("/api/gsc/import", { method: "POST", body: JSON.stringify(body) }),
  gscInspect: (body: any) =>
    request<any>("/api/gsc/inspect", { method: "POST", body: JSON.stringify(body) }),
  gscDisconnect: (siteId: string) =>
    request<any>("/api/gsc/disconnect", { method: "POST", body: JSON.stringify({ siteId }) }),
  mcpTools: () => request<any>("/api/mcp/tools"),
  gscCrawlInsights: (siteId: string, query: { scanId?: string; startDate?: string; endDate?: string } = {}) =>
    request<GscCrawlInsights>(`/api/sites/${siteId}/insights/gsc-crawl${queryString(query)}`),
  cannibalizationInsights: (siteId: string, query: { startDate?: string; endDate?: string; minImpressions?: number } = {}) =>
    request<CannibalizationInsights>(`/api/sites/${siteId}/insights/cannibalization${queryString(query)}`),
  decayInsights: (
    siteId: string,
    query: { currentStart?: string; currentEnd?: string; previousStart?: string; previousEnd?: string } = {},
  ) => request<DecayInsights>(`/api/sites/${siteId}/insights/decay${queryString(query)}`),
  siteSchedule: (siteId: string) => request<SiteSchedule>(`/api/sites/${siteId}/schedule`),
  setSiteScanSchedule: (siteId: string, scanInterval: ScheduleInterval) =>
    request<SiteSchedule>(`/api/sites/${siteId}/schedule`, { method: "PUT", body: JSON.stringify({ scanInterval }) }),
  notifications: (query: { siteId?: string; unread?: boolean; limit?: number } = {}) =>
    request<NotificationList>(`/api/notifications${queryString({ ...query, unread: query.unread ? 1 : undefined })}`),
  markNotificationRead: (id: string) => request<unknown>(`/api/notifications/${id}/read`, { method: "POST" }),
  markAllNotificationsRead: (siteId?: string) =>
    request<unknown>("/api/notifications/read-all", { method: "POST", body: JSON.stringify(siteId ? { siteId } : {}) }),
  deleteNotification: (id: string) => request<unknown>(`/api/notifications/${id}`, { method: "DELETE" }),
  cwvStatus: (siteId: string) => request<CwvStatus>(`/api/sites/${siteId}/cwv`),
  runCwv: (siteId: string, body: { urls?: string[]; strategy?: CwvStrategy; limit?: number } = {}) =>
    request<{ runId: string; status: string }>(`/api/sites/${siteId}/cwv`, { method: "POST", body: JSON.stringify(body) }),
  robotsTest: (siteId: string, body: { url: string; userAgent?: string; robotsTxt?: string }) =>
    request<RobotsTestResult>(`/api/sites/${siteId}/robots-test`, { method: "POST", body: JSON.stringify(body) }),
};
