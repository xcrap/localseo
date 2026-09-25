import * as cheerio from "cheerio";
import { XMLParser } from "fast-xml-parser";
import { createHash, randomUUID } from "node:crypto";
import { getConfigValue } from "./config";
import { all, get, jsonParse, run, transaction } from "./db";
import { fetchText, fetchWithRedirectTrace, type KnownResponse, localHostFirst } from "./http";
import {
  CRAWLER_ROBOTS_AGENT,
  type CrawlRobotsMode,
  crawlRobotsGate,
  crawlRobotsMode,
  MAX_ROBOTS_BYTES,
  parseRobots,
  type RobotsBlock,
  type RobotsVerdict,
  readRobots,
  robotsMatcher,
  robotsResponseAllowsAll,
  testRobots,
} from "./robots";
import { probeScanUrl, unreachableScanUrlError } from "./site-scan-url";
import { readStructuredData } from "./structured-data";

export { parseRobots, testRobots };

// Version 3: link-first crawl order, one issue per affected source page for
// resource checks, and page issues stored once in result.issues.
// Version 4: robots.txt rules per URL, canonical/hreflang/sitemap URL checks,
// soft 404 probe, near-duplicate content, and structured data validation.
// Version 5: concurrent page fetches with link depth settled over the whole
// crawl graph, near-duplicates within 8 simhash bits, percent-escape
// insensitive URL keys, per-page outlinks (pageLinks), and page-limit based
// sitemap coverage.
// Version 6: robots.txt is respected by default — URLs it disallows for
// LocalSEO are skipped (result.robotsSkipped) instead of fetched, so the
// crawled page set differs from earlier scans (limits.robots records the mode).
// Scans are only compared with scans that share the same crawl semantics.
const SCAN_RESULT_VERSION = 6;

// Thrown for request problems the API should answer with a 4xx status.
export class ScanRequestError extends Error {
  constructor(
    readonly status: 400 | 404,
    message: string,
  ) {
    super(message);
  }
}

function getSite(siteId: string) {
  return get<any>("SELECT * FROM sites WHERE id = ?", [siteId]);
}

function siteIgnoreRules(siteId: string) {
  return all<any>("SELECT * FROM scan_issue_ignores WHERE site_id = ?", [siteId]);
}

// Views derived from result.issues on read, for scans of every version: issue
// groups named by the issue-type catalog. Page issues are stored once, in
// result.issues (by issue.url), and are not copied onto every page row; the
// per-page outlink index is served by getScanPage only.
function withIssueViews(row: any) {
  const result = row?.result;
  if (!result || !Array.isArray(result.issues)) return row;
  const { pageLinks: _pageLinks, ...rest } = result;
  return {
    ...row,
    result: {
      ...rest,
      issueGroups: groupIssueSummary(result.issues.filter((issue: any) => !issue.ignored)),
    },
  };
}

// The full saved result lives in scan_results, apart from the small scans row.
function readScanResult(scanId: string) {
  return jsonParse<any>(get<{ result_json: string }>("SELECT result_json FROM scan_results WHERE scan_id = ?", [scanId])?.result_json, null);
}

// Parsed results of finished scans, for the page drawer's repeated reads. The
// cached objects are shared, so callers must not mutate them. Keyed by scan id
// and updated_at, so a rewritten result is never served stale; running scans
// are not cached (their updated_at has one-second resolution).
const parsedResultCache = new Map<string, { updatedAt: string; result: any }>();
const PARSED_RESULT_CACHE_SIZE = 4;

function cachedScanResult(row: { id: string; status: string; updated_at: string }) {
  if (row.status === "queued" || row.status === "running") return readScanResult(row.id);
  const cached = parsedResultCache.get(row.id);
  const result = cached && cached.updatedAt === row.updated_at ? cached.result : readScanResult(row.id);
  // Re-inserting keeps the most recently used entries at the end.
  parsedResultCache.delete(row.id);
  parsedResultCache.set(row.id, { updatedAt: row.updated_at, result });
  while (parsedResultCache.size > PARSED_RESULT_CACHE_SIZE) {
    parsedResultCache.delete(parsedResultCache.keys().next().value as string);
  }
  return result;
}

function publicScanRow(row: any) {
  if (!row) return null;
  const { site_id: siteId, site_name: siteName, site_domain: siteDomain, result_json, summary_json: _summary, ...rest } = row;
  const publicRow = applyIssueIgnores(
    {
      ...rest,
      site_id: siteId,
      ...(siteName ? { site_name: siteName } : {}),
      ...(siteDomain ? { site_domain: siteDomain } : {}),
      result: jsonParse(result_json, null),
    },
    siteIgnoreRules(siteId),
  );
  return withIssueViews(publicRow);
}

// Ignore rules match by page identity, not raw URL string. The same page can be
// recorded with a different URL between scans — a toggled trailing slash, www,
// http/https, or a redirect that appends session/query params (e.g. a booking
// engine's ?idchain=...). Raw string equality silently drops the ignore on the
// next scan; comparing the normalized, query-stripped key keeps it applied.
function ignoreUrlKey(value: string) {
  try {
    const url = new URL(value);
    url.search = "";
    url.hash = "";
    return normalizedUrlKey(url.toString());
  } catch {
    return String(value || "");
  }
}

// A rule with no issue_type ignores every issue on its URL; a rule with no
// URL ignores its issue type site-wide.
function issueMatchesIgnore(issue: any, rules: any[]) {
  const issueKey = ignoreUrlKey(String(issue?.url || ""));
  return rules.some(
    (rule) =>
      (!rule.issue_type || rule.issue_type === issue.type) &&
      (!rule.url || ignoreUrlKey(String(rule.url)) === issueKey),
  );
}

function filterComparison(comparison: any, rules: any[]) {
  const keep = (rows: any[] = []) => rows.filter((issue: any) => !issueMatchesIgnore(issue, rules));
  const newIssues = keep(comparison.newIssues);
  const fixedIssues = keep(comparison.fixedIssues);
  const severityChanges = keep(comparison.severityChanges);
  if (
    newIssues.length === (comparison.newIssues || []).length &&
    fixedIssues.length === (comparison.fixedIssues || []).length &&
    severityChanges.length === (comparison.severityChanges || []).length
  ) {
    return comparison;
  }
  return {
    ...comparison,
    summary: {
      ...(comparison.summary || {}),
      newIssues: newIssues.length,
      fixedIssues: fixedIssues.length,
      severityChanges: severityChanges.length,
    },
    newIssues,
    fixedIssues,
    severityChanges,
    ...(comparison.regressions ? { regressions: comparisonRegressions(newIssues, comparison.pageChanges || []) } : {}),
  };
}

// Saved scan evidence stays untouched in SQLite; ignore rules are applied when
// scans are read, so restoring a rule instantly brings the issues and their
// score impact back on every saved report.
function applyIssueIgnores(row: any, rules: any[]) {
  const result = row?.result;
  if (!result || !Array.isArray(result.issues) || !rules.length) return row;
  const issues = result.issues.map((issue: any) =>
    issueMatchesIgnore(issue, rules) ? { ...issue, ignored: true } : issue,
  );
  const activeIssues = issues.filter((issue: any) => !issue.ignored);
  const ignoredCount = issues.length - activeIssues.length;
  const comparison = result.comparison ? filterComparison(result.comparison, rules) : null;
  if (!ignoredCount && comparison === result.comparison) return row;
  const pages = Array.isArray(result.pages) ? result.pages : [];
  return {
    ...row,
    // Cancelled scans are scored on the pages they crawled (summary.partial).
    score: row.status === "completed" || row.status === "cancelled" ? healthScore(pages, activeIssues) : row.score,
    issue_count: activeIssues.length,
    ignored_issue_count: ignoredCount,
    result: {
      ...result,
      // Crawl-derived counts stay as saved; only issue-derived counts change.
      summary: { ...(result.summary || {}), ...issueSummary(activeIssues) },
      issues,
      ...(comparison ? { comparison } : {}),
    },
  };
}

// Scan lists never parse result_json. Each row keeps a small precomputed
// summary (summary_json) with the ignore rules already applied, rewritten on
// every progress save and whenever the site's ignore rules change.
function liteScanResult(result: any) {
  if (!result) return null;
  return {
    scanVersion: result.scanVersion ?? null,
    phase: result.phase || "",
    ...(result.startUrl ? { startUrl: result.startUrl } : {}),
    limits: result.limits || null,
    summary: result.summary || null,
    progress: result.progress || null,
  };
}

function storedScanSummary(publicRow: any) {
  return JSON.stringify({
    score: publicRow.score,
    issueCount: publicRow.issue_count,
    ignoredIssueCount: Number(publicRow.ignored_issue_count || 0),
    result: liteScanResult(publicRow.result),
  });
}

function refreshScanSummary(scanId: string, rules: any[]) {
  const row = get<any>("SELECT * FROM scans WHERE id = ?", [scanId]);
  if (!row) return;
  const publicRow = applyIssueIgnores({ ...row, result: readScanResult(scanId) }, rules);
  run("UPDATE scans SET summary_json = ? WHERE id = ?", [storedScanSummary(publicRow), scanId]);
}

function refreshSiteScanSummaries(siteId: string) {
  const rules = siteIgnoreRules(siteId);
  for (const row of all<{ id: string }>("SELECT id FROM scans WHERE site_id = ?", [siteId])) {
    refreshScanSummary(row.id, rules);
  }
}

// Scans saved before summary_json existed get their summary computed once, on
// the first list read, then stay on the fast path.
function backfillScanSummaries() {
  const rows = all<{ id: string; site_id: string }>("SELECT id, site_id FROM scans WHERE summary_json IS NULL");
  const rulesBySite = new Map<string, any[]>();
  for (const row of rows) {
    const rules = rulesBySite.get(row.site_id) || siteIgnoreRules(row.site_id);
    rulesBySite.set(row.site_id, rules);
    refreshScanSummary(row.id, rules);
  }
}

const scanListColumns = `
  scans.id, scans.site_id, scans.url, scans.status, scans.score, scans.pages_crawled,
  scans.issue_count, scans.error, scans.created_at, scans.updated_at, scans.summary_json
`;

function liteScanRow(row: any) {
  const { summary_json, site_name: siteName, site_domain: siteDomain, ...rest } = row;
  const stored = jsonParse<any>(summary_json, null);
  return {
    ...rest,
    ...(siteName ? { site_name: siteName } : {}),
    ...(siteDomain ? { site_domain: siteDomain } : {}),
    score: stored?.score ?? rest.score,
    issue_count: stored?.issueCount ?? rest.issue_count,
    ignored_issue_count: stored?.ignoredIssueCount ?? 0,
    result: stored?.result ?? null,
  };
}

export function listIssueIgnores(siteId: string) {
  const site = getSite(siteId);
  if (!site) throw new Error("Site not found.");
  return all<any>("SELECT * FROM scan_issue_ignores WHERE site_id = ? ORDER BY created_at DESC", [site.id]);
}

export function createIssueIgnore(siteId: string, input: { type?: string; url?: string; note?: string }) {
  const site = getSite(siteId);
  if (!site) throw new Error("Site not found.");
  const issueType = String(input?.type || "").trim();
  const url = String(input?.url || "").trim();
  if (!issueType && !url) throw new Error("An issue type or a page URL is required.");
  const note = String(input?.note || "").trim();
  run(
    `
    INSERT INTO scan_issue_ignores (id, site_id, issue_type, url, note)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(site_id, issue_type, url) DO UPDATE SET note = excluded.note
    `,
    [randomUUID(), site.id, issueType, url, note],
  );
  refreshSiteScanSummaries(site.id);
  return get<any>("SELECT * FROM scan_issue_ignores WHERE site_id = ? AND issue_type = ? AND url = ?", [
    site.id,
    issueType,
    url,
  ]);
}

export function deleteIssueIgnore(siteId: string, ignoreId: string) {
  const site = getSite(siteId);
  if (!site) throw new Error("Site not found.");
  const info = run("DELETE FROM scan_issue_ignores WHERE id = ? AND site_id = ?", [ignoreId, site.id]);
  const deleted = Number(info.changes || 0) > 0;
  if (deleted) refreshSiteScanSummaries(site.id);
  return { deleted };
}

export function clearIssueIgnores(siteId: string) {
  const site = getSite(siteId);
  if (!site) throw new Error("Site not found.");
  const info = run("DELETE FROM scan_issue_ignores WHERE site_id = ?", [site.id]);
  const deleted = Number(info.changes || 0);
  if (deleted) refreshSiteScanSummaries(site.id);
  return { deleted };
}

export function listScans(siteId: string) {
  backfillScanSummaries();
  return all<any>(`SELECT ${scanListColumns} FROM scans WHERE site_id = ? ORDER BY created_at DESC`, [siteId]).map(
    liteScanRow,
  );
}

export function listAllScans() {
  backfillScanSummaries();
  return all<any>(`
    SELECT
      ${scanListColumns},
      sites.name AS site_name,
      sites.domain AS site_domain
    FROM scans
    LEFT JOIN sites ON sites.id = scans.site_id
    ORDER BY scans.created_at DESC
  `).map(liteScanRow);
}

export function getScan(scanId: string) {
  const row = get<any>(
    `
    SELECT scans.*, sites.name AS site_name, sites.domain AS site_domain, scan_results.result_json
    FROM scans
    LEFT JOIN sites ON sites.id = scans.site_id
    LEFT JOIN scan_results ON scan_results.scan_id = scans.id
    WHERE scans.id = ?
    `,
    [scanId],
  );
  return publicScanRow(row);
}

// Scan execution lives in this process. Each queued or running scan keeps an
// abort controller so cancel/delete can stop its crawl and in-flight requests.
const runningScans = new Map<string, { controller: AbortController; done: Promise<void> }>();

export async function cancelScan(scanId: string) {
  const row = get<any>("SELECT id, status FROM scans WHERE id = ?", [scanId]);
  if (!row) throw new ScanRequestError(404, "Scan not found.");
  if (row.status !== "queued" && row.status !== "running") {
    throw new ScanRequestError(400, `Only queued or running scans can be cancelled (this scan is ${row.status}).`);
  }
  const running = runningScans.get(scanId);
  running?.controller.abort();
  run("UPDATE scans SET status = 'cancelled', updated_at = CURRENT_TIMESTAMP WHERE id = ?", [scanId]);
  // Aborting stops in-flight requests at once; wait for the crawler to save
  // its partial results so the response is the final cancelled scan.
  await running?.done;
  const lite = get<any>(`SELECT ${scanListColumns} FROM scans WHERE id = ?`, [scanId]);
  return lite ? liteScanRow(lite) : null;
}

export function deleteScan(siteId: string, scanId: string) {
  const site = getSite(siteId);
  if (!site) throw new Error("Site not found.");
  const info = run("DELETE FROM scans WHERE id = ? AND site_id = ?", [scanId, site.id]);
  const deleted = Number(info.changes || 0) > 0;
  if (deleted) runningScans.get(scanId)?.controller.abort();
  return { deleted };
}

export function clearScans(siteId: string) {
  const site = getSite(siteId);
  if (!site) throw new Error("Site not found.");
  const ids = all<{ id: string }>("SELECT id FROM scans WHERE site_id = ?", [site.id]);
  const info = run("DELETE FROM scans WHERE site_id = ?", [site.id]);
  for (const row of ids) runningScans.get(row.id)?.controller.abort();
  return { deleted: Number(info.changes || 0) };
}

// options.reachable: the caller already probed this URL and it answered
// (resolveSavedSiteScanUrl), so it is not probed a second time.
export async function startScan(siteId: string, url: string, options: { reachable?: boolean } = {}) {
  const site = getSite(siteId);
  if (!site) throw new Error("Site not found.");
  const startUrl = /^https?:\/\//i.test(url.trim()) ? url.trim() : `https://${url.trim()}`;
  if (!options.reachable && !(await probeScanUrl(startUrl, crawlRobotsMode(site.crawl_robots)))) {
    throw unreachableScanUrlError(startUrl);
  }
  const scanId = randomUUID();
  run(
    "INSERT INTO scans (id, site_id, url, status, updated_at) VALUES (?, ?, ?, 'queued', CURRENT_TIMESTAMP)",
    [scanId, site.id, url.trim()],
  );
  const controller = new AbortController();
  // Runs on the next microtask, after startScan has returned the queued row.
  const done = Promise.resolve()
    .then(() => runLocalScan(scanId, controller.signal))
    .catch((error) => {
      // A cancelled or deleted scan already has its final state.
      if (controller.signal.aborted) return;
      run(
        "UPDATE scans SET status = 'failed', error = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?",
        [error instanceof Error ? error.message : "Scan failed", scanId],
      );
    })
    .finally(() => runningScans.delete(scanId));
  runningScans.set(scanId, { controller, done });
  return getScan(scanId);
}

export function scanIssueTypeList() {
  return Object.entries(scanIssueTypes).map(([type, info]) => ({ type, ...info }));
}

type ScanIssueSeverity = "high" | "medium" | "low";
type ScanIssueCategory =
  | "indexability"
  | "metadata"
  | "headings"
  | "content"
  | "links"
  | "images"
  | "assets"
  | "canonicals"
  | "structured-data"
  | "social"
  | "performance"
  | "security"
  | "localization"
  | "sitemap"
  | "robots"
  | "crawl";

type ScanIssueTypeInfo = {
  title: string;
  category: ScanIssueCategory;
  severity: ScanIssueSeverity;
  why: string;
  fix: string;
};

// Static guidance for every issue type the scanner emits. `severity` is the
// usual severity; a few checks raise or lower it from the evidence (for
// example very long titles, or plain HTTP on a local development host).
export const scanIssueTypes: Record<string, ScanIssueTypeInfo> = {
  "robots-missing": { title: "robots.txt missing", category: "robots", severity: "low", why: "Crawlers look for /robots.txt to learn crawl rules and sitemap locations.", fix: "Publish a robots.txt at the site root, even if it only lists the sitemap." },
  "robots-blocks-all": { title: "robots.txt blocks all crawling", category: "robots", severity: "high", why: "Disallow: / for all user agents stops search engines from crawling any page.", fix: "Remove the global Disallow: / unless the whole site must stay out of search." },
  "robots-sitemap-missing": { title: "robots.txt has no sitemap", category: "robots", severity: "low", why: "A Sitemap directive helps crawlers find the preferred sitemap quickly.", fix: "Add a Sitemap: line with the absolute sitemap URL to robots.txt." },
  "robots-blocked-page": { title: "Blocked by robots.txt", category: "robots", severity: "medium", why: "robots.txt disallows this URL for Googlebot, so Google cannot crawl its content.", fix: "Narrow or remove the Disallow rule if the page should be crawled; use noindex, not robots.txt, to keep a page out of search." },
  "robots-blocked-in-sitemap": { title: "Sitemap URL blocked by robots.txt", category: "robots", severity: "medium", why: "The sitemap asks Google to crawl a URL that robots.txt forbids, which sends conflicting signals.", fix: "Remove blocked URLs from the sitemap, or allow them in robots.txt." },
  "robots-blocked-linked": { title: "Links to URLs blocked by robots.txt", category: "robots", severity: "low", why: "Internal links to disallowed URLs lead crawlers to pages they may not fetch.", fix: "Confirm the blocked destinations are intentional, or link to crawlable URLs instead." },
  "robots-blocked-resource": { title: "Page resources blocked by robots.txt", category: "robots", severity: "medium", why: "robots.txt disallows CSS, JavaScript, or images this page loads, so Googlebot cannot render the page the way visitors see it.", fix: "Allow Googlebot to fetch the stylesheets, scripts, and images pages need to render; only block resources that do not affect the page." },
  "robots-blocks-start-url": { title: "Start URL blocked by robots.txt", category: "robots", severity: "high", why: "robots.txt disallows the scan's start URL for LocalSEO (its own user-agent group, or * when there is none), so the scan stopped without crawling any page. Staging and preview sites often ship Disallow: /.", fix: "Allow the start URL for LocalSEO in robots.txt (for example a User-agent: LocalSEO group with Allow: /), or set this site's robots.txt setting to Ignore to crawl disallowed URLs anyway." },
  "robots-unavailable": { title: "robots.txt could not be read", category: "robots", severity: "high", why: "robots.txt answered with a server error or HTTP 429, or not at all. Google treats that as disallowing the whole site until it answers again, and LocalSEO does the same: nothing is crawled unless the site's robots.txt setting is Ignore.", fix: "Make /robots.txt answer 200 with your rules, or 404 if there are none; check server errors, firewalls, and rate limits, then rescan." },
  "sitemap-fetch-failed": { title: "Sitemap fetch failed", category: "sitemap", severity: "medium", why: "A sitemap that errors or does not parse cannot help crawlers discover URLs.", fix: "Fix the sitemap response status, XML syntax, or the reference to it." },
  "sitemap-too-large": { title: "Sitemap too large", category: "sitemap", severity: "medium", why: "Sitemaps over the 50 MB protocol limit are rejected by search engines and were not parsed here.", fix: "Split the sitemap into smaller files listed in a sitemap index." },
  "sitemap-missing-or-empty": { title: "No sitemap URLs", category: "sitemap", severity: "medium", why: "Without an XML sitemap, crawlers rely only on links to find pages.", fix: "Publish an XML sitemap of indexable URLs and reference it from robots.txt." },
  "sitemap-too-many-urls": { title: "Sitemap lists over 50,000 URLs", category: "sitemap", severity: "medium", why: "The sitemap protocol allows at most 50,000 URLs (or child sitemaps) per file; search engines may reject larger files.", fix: "Split the sitemap into files of up to 50,000 URLs and list them in a sitemap index." },
  "sitemap-url-redirect": { title: "Redirecting URL in sitemap", category: "sitemap", severity: "medium", why: "Sitemaps should list final URLs; redirecting entries waste crawl budget and blur the preferred URL.", fix: "Replace the sitemap entry with the URL it redirects to." },
  "sitemap-url-error": { title: "Broken URL in sitemap", category: "sitemap", severity: "medium", why: "Sitemap entries that return 4xx/5xx or fail to load point crawlers at pages that cannot be indexed.", fix: "Remove the entry, restore the page, or list its live replacement." },
  "sitemap-url-canonicalized": { title: "Canonicalized URL in sitemap", category: "sitemap", severity: "medium", why: "The listed page names another URL as canonical, so the sitemap and the page disagree on the preferred URL.", fix: "List only canonical URLs in the sitemap." },
  "sitemap-larger-than-crawl-limit": { title: "Sitemap larger than crawl limit", category: "sitemap", severity: "low", why: "This local scan crawls fewer URLs than the sitemap lists, so coverage is partial.", fix: "Raise the site's crawl page limit or scan important sections separately." },
  "page-missing-from-sitemap": { title: "Page missing from sitemap", category: "sitemap", severity: "low", why: "Indexable pages left out of the sitemap may be discovered and recrawled more slowly.", fix: "Add important indexable pages to the XML sitemap." },
  "noindex-page-in-sitemap": { title: "Noindex page in sitemap", category: "sitemap", severity: "medium", why: "Sitemaps should list only pages you want indexed; noindex entries send mixed signals.", fix: "Remove noindex pages from the sitemap, or drop the noindex if the page should rank." },
  "temporary-redirect": { title: "Temporary redirect", category: "crawl", severity: "low", why: "302/307 redirects tell search engines the move is temporary, so the old URL may stay indexed.", fix: "Use 301 or 308 for permanent moves." },
  "redirected-url": { title: "Redirected URL", category: "crawl", severity: "low", why: "Crawling redirecting URLs wastes crawl budget and adds latency.", fix: "Link directly to the final URL." },
  "redirect-chain": { title: "Redirect chain", category: "crawl", severity: "medium", why: "Each extra hop slows users and crawlers, and long chains may not be followed.", fix: "Redirect straight to the final destination in one hop." },
  "redirect-loop": { title: "Redirect loop", category: "crawl", severity: "high", why: "A redirect cycle never reaches a page, so neither users nor crawlers can load it.", fix: "Break the cycle so the URL resolves to one final response." },
  "redirect-failed": { title: "Redirect failed", category: "crawl", severity: "high", why: "The redirect has an invalid or unsupported location, or too many hops, so it never resolves.", fix: "Point the redirect at a valid http(s) URL and keep the chain short." },
  "redirect-off-site": { title: "Redirect to another domain", category: "crawl", severity: "low", why: "An internal URL that leaves the site hands its visitors and link signals to another domain.", fix: "Confirm the cross-domain redirect is intentional, or link to the external URL directly." },
  "page-http-error": { title: "HTTP error page", category: "crawl", severity: "high", why: "Pages returning 4xx/5xx cannot be indexed and break user journeys.", fix: "Restore the page or redirect the URL to a live equivalent." },
  "crawl-failed": { title: "Page failed to load", category: "crawl", severity: "high", why: "The crawler could not get any response (DNS, TLS, timeout, or connection error).", fix: "Check DNS, TLS certificates, firewall rules, and server availability." },
  "non-html-page": { title: "Non-HTML URL in crawl", category: "crawl", severity: "medium", why: "A linked URL returned a non-HTML response, so it was not audited as a page.", fix: "Keep feeds, data, and files out of primary navigation unless intentionally linked." },
  "url-too-long": { title: "Long URL", category: "crawl", severity: "low", why: "Long URLs are harder to read, share, and keep stable.", fix: "Use short, descriptive paths and drop unneeded parameters." },
  "meta-refresh": { title: "Meta refresh redirect", category: "crawl", severity: "medium", why: "Client-side refresh redirects are slower and less reliable than HTTP redirects.", fix: "Replace the meta refresh with a 301/308 HTTP redirect." },
  "tracking-parameters-in-url": { title: "Tracking parameters in URL", category: "crawl", severity: "low", why: "Tracking parameters create duplicate crawlable URLs for the same content.", fix: "Strip tracking parameters from crawlable URLs and canonicalize variants." },
  "soft-404": { title: "Soft 404", category: "crawl", severity: "medium", why: "A URL that does not exist answers with a 2xx page, so missing and mistyped URLs look like real pages to search engines.", fix: "Return HTTP 404 or 410 for URLs that do not exist, instead of a 200 page or a redirect to one." },
  "crawl-depth-deep": { title: "Deep page", category: "crawl", severity: "low", why: "Pages more than three clicks from the start page get less crawl attention and link equity.", fix: "Link important pages from navigation, hubs, or higher-level pages." },
  "orphan-page": { title: "Orphan page", category: "crawl", severity: "medium", why: "The page is only in the sitemap; no crawled page links to it.", fix: "Add internal links from relevant pages." },
  "no-pages-crawled": { title: "No pages crawled", category: "crawl", severity: "high", why: "The scan found no HTML pages, so there is no evidence to audit.", fix: "Check the scan URL, redirects, DNS, TLS, and firewall rules." },
  "page-not-https": { title: "Page served over HTTP", category: "security", severity: "high", why: "Plain HTTP pages are unencrypted and marked not secure by browsers.", fix: "Serve the page over HTTPS and redirect HTTP to HTTPS." },
  "external-blank-missing-noopener": { title: "target=_blank without noopener", category: "security", severity: "low", why: "New-tab links without noopener let the opened page access window.opener.", fix: "Add rel=\"noopener\" (or noreferrer) to external target=\"_blank\" links." },
  "title-missing": { title: "Missing title", category: "metadata", severity: "high", why: "The title is the main headline in search results and browser tabs.", fix: "Add a unique, descriptive title tag." },
  "title-multiple": { title: "Multiple title tags", category: "metadata", severity: "medium", why: "Several title tags make the page title ambiguous.", fix: "Keep exactly one title tag in the document head." },
  "title-length": { title: "Title length", category: "metadata", severity: "low", why: "Very short titles under-describe the page; long ones get truncated in results.", fix: "Keep titles around 30-60 characters." },
  "description-missing": { title: "Missing meta description", category: "metadata", severity: "high", why: "Without a description, search engines pick a snippet that may not sell the page.", fix: "Add a unique meta description summarizing the page." },
  "description-multiple": { title: "Multiple meta descriptions", category: "metadata", severity: "medium", why: "Several descriptions make the intended snippet ambiguous.", fix: "Keep one meta description per page." },
  "description-length": { title: "Meta description length", category: "metadata", severity: "low", why: "Short descriptions waste snippet space; long ones get truncated.", fix: "Keep descriptions around 70-160 characters." },
  "favicon-missing": { title: "Missing favicon", category: "metadata", severity: "low", why: "Search results and browser tabs show the site icon.", fix: "Add a link rel=\"icon\" to a site icon." },
  "duplicate-title": { title: "Duplicate title", category: "metadata", severity: "medium", why: "Identical titles make pages compete and blur which one should rank.", fix: "Write a unique title for each indexable page." },
  "duplicate-description": { title: "Duplicate meta description", category: "metadata", severity: "low", why: "Repeated descriptions make results look alike and less relevant.", fix: "Write a unique description for each important page." },
  "h1-count": { title: "Missing or multiple H1", category: "headings", severity: "medium", why: "One clear H1 states the page topic for users and crawlers.", fix: "Use exactly one descriptive H1." },
  "h1-empty": { title: "Empty H1", category: "headings", severity: "low", why: "Empty headings add no meaning and confuse the outline.", fix: "Remove empty H1 tags or give them text." },
  "heading-empty": { title: "Empty headings", category: "headings", severity: "low", why: "Empty headings break the document outline for assistive tech and crawlers.", fix: "Remove empty heading tags or add text." },
  "heading-hierarchy-jump": { title: "Skipped heading levels", category: "headings", severity: "low", why: "Jumping levels (e.g. H2 to H4) makes the content structure harder to follow.", fix: "Nest headings in order without skipping levels." },
  "h2-missing": { title: "No H2 on long page", category: "headings", severity: "low", why: "Long content without sections is harder to scan and understand.", fix: "Break long content into H2 sections." },
  "duplicate-h1": { title: "Duplicate H1", category: "headings", severity: "low", why: "The same H1 on several pages suggests overlapping topics.", fix: "Give each page an H1 that reflects its unique purpose." },
  "canonical-missing": { title: "Missing canonical", category: "canonicals", severity: "medium", why: "Without a canonical, search engines guess the preferred URL among variants.", fix: "Add a self-referencing canonical, or point it at the preferred URL." },
  "canonical-invalid": { title: "Invalid canonical", category: "canonicals", severity: "medium", why: "A canonical that is not a valid URL is ignored.", fix: "Use a valid absolute or root-relative canonical URL." },
  "canonical-multiple": { title: "Multiple canonicals", category: "canonicals", severity: "medium", why: "Conflicting canonical tags are usually ignored.", fix: "Keep one canonical tag per page." },
  "canonical-http-on-https": { title: "HTTP canonical on HTTPS page", category: "canonicals", severity: "medium", why: "Canonicalizing to HTTP points search engines at the insecure version.", fix: "Point canonicals at the HTTPS URL." },
  "canonical-cross-domain": { title: "Cross-domain canonical", category: "canonicals", severity: "medium", why: "A canonical to another domain asks search engines to index that domain instead.", fix: "Confirm the cross-domain canonical is intentional." },
  "canonical-points-to-redirect": { title: "Canonical points to redirect", category: "canonicals", severity: "low", why: "Canonicals should name the final URL, not one that redirects.", fix: "Point the canonical at the final indexable URL." },
  "canonical-target-redirect": { title: "Canonical URL redirects", category: "canonicals", severity: "medium", why: "The canonical names a URL that redirects, so search engines get two conflicting preferred URLs.", fix: "Point the canonical at the final URL the redirect lands on." },
  "canonical-target-error": { title: "Canonical URL is broken", category: "canonicals", severity: "high", why: "The canonical names a URL that returns 4xx/5xx or does not load, so the hint is ignored or consolidates into a dead page.", fix: "Point the canonical at a live, indexable URL." },
  "canonical-target-noindex": { title: "Canonical URL is noindex", category: "canonicals", severity: "high", why: "The canonical names a page marked noindex, so neither page may be indexed.", fix: "Canonicalize to an indexable page, or remove noindex from the canonical URL." },
  "canonical-chain": { title: "Canonical chain", category: "canonicals", severity: "medium", why: "The canonical URL itself canonicalizes to another URL, so search engines have to follow a chain of hints.", fix: "Point every canonical directly at the final preferred URL." },
  "canonical-not-self": { title: "Canonical points elsewhere", category: "canonicals", severity: "low", why: "An indexable page canonicalizing to another URL may be dropped from the index.", fix: "Use a self-referencing canonical unless the page is intentionally consolidated." },
  noindex: { title: "Noindex page", category: "indexability", severity: "high", why: "A noindex directive keeps the page out of search results.", fix: "Remove noindex from pages that should rank." },
  "meta-robots-nofollow": { title: "Nofollow page", category: "indexability", severity: "medium", why: "Page-level nofollow stops crawlers from following any link on the page.", fix: "Remove nofollow from the robots directives unless intended." },
  "restrictive-snippet-directive": { title: "Restrictive snippet directives", category: "indexability", severity: "low", why: "noarchive/nosnippet limit how the page appears in search results.", fix: "Confirm the restriction is intentional." },
  "html-lang-missing": { title: "Missing html lang", category: "indexability", severity: "low", why: "The lang attribute tells browsers, screen readers, and crawlers the page language.", fix: "Set lang on the html element, e.g. lang=\"en\"." },
  "charset-missing": { title: "Missing charset", category: "indexability", severity: "low", why: "Without a charset declaration, text can be decoded incorrectly.", fix: "Declare <meta charset=\"utf-8\"> early in the head." },
  "html-lang-invalid": { title: "Invalid html lang", category: "localization", severity: "low", why: "An invalid language code gives no usable language signal.", fix: "Use a valid BCP 47 tag such as en, en-US, or pt-PT." },
  "hreflang-invalid": { title: "Invalid hreflang link", category: "localization", severity: "medium", why: "Hreflang entries without a code or valid URL are ignored.", fix: "Give every hreflang link a language code and a valid URL." },
  "hreflang-code-invalid": { title: "Invalid hreflang code", category: "localization", severity: "medium", why: "Unrecognized language codes break the alternate-language set.", fix: "Use valid language or language-region codes, plus x-default." },
  "hreflang-duplicate": { title: "Duplicate hreflang", category: "localization", severity: "low", why: "Two URLs for the same language code conflict.", fix: "Keep one alternate URL per hreflang value." },
  "hreflang-missing-return": { title: "Missing hreflang return link", category: "localization", severity: "medium", why: "Hreflang pairs must link to each other; an alternate page that does not link back makes search engines ignore the pair.", fix: "Add a matching hreflang link back to this page on every alternate page." },
  "hreflang-target-error": { title: "Hreflang URL not 200", category: "localization", severity: "medium", why: "Hreflang alternates should be live, final URLs; redirects and errors break the language set.", fix: "Point hreflang links at the final 200 URL of each language version." },
  "hreflang-missing-self": { title: "Missing self-referencing hreflang", category: "localization", severity: "low", why: "Each page in an hreflang set should list itself as well as its alternates.", fix: "Add an hreflang link for this page's own language pointing at its own URL." },
  "hreflang-x-default-missing": { title: "Missing hreflang x-default", category: "localization", severity: "low", why: "x-default names the fallback page for unmatched languages.", fix: "Add an x-default alternate when there is a default or selector page." },
  "viewport-missing": { title: "Missing viewport", category: "performance", severity: "medium", why: "Without a viewport tag, mobile browsers render a zoomed-out desktop layout.", fix: "Add <meta name=\"viewport\" content=\"width=device-width, initial-scale=1\">." },
  "viewport-not-responsive": { title: "Non-responsive viewport", category: "performance", severity: "low", why: "A viewport without width=device-width does not adapt to the screen.", fix: "Use width=device-width, initial-scale=1." },
  "slow-page": { title: "Page response over 4s", category: "performance", severity: "medium", why: "Slow responses hurt users and reduce how much crawlers fetch.", fix: "Investigate server time, redirects, caching, and HTML weight." },
  "page-response-slow": { title: "Page response over 2s", category: "performance", severity: "low", why: "Responses over two seconds feel slow and delay rendering.", fix: "Improve server response time and caching." },
  "heavy-html": { title: "Heavy HTML", category: "performance", severity: "low", why: "HTML over 1 MB is slow to download and parse.", fix: "Reduce markup, inline data, and unused HTML." },
  "html-compression-missing": { title: "HTML not compressed", category: "performance", severity: "low", why: "Uncompressed HTML transfers several times more bytes than needed.", fix: "Enable Brotli or gzip for HTML responses." },
  "render-blocking-javascript": { title: "Render-blocking scripts", category: "performance", severity: "low", why: "Synchronous scripts in the head delay first render.", fix: "Use defer, async, or type=module, or move scripts out of the head." },
  "too-many-assets": { title: "Too many CSS/JS assets", category: "performance", severity: "low", why: "Many separate asset requests add overhead to every page load.", fix: "Bundle, remove, or defer non-critical CSS and JavaScript." },
  "image-lazy-loading-missing": { title: "Images not lazy loaded", category: "performance", severity: "low", why: "Below-the-fold images downloaded upfront compete with critical content.", fix: "Add loading=\"lazy\" to images outside the initial viewport." },
  "thin-content": { title: "Thin content", category: "content", severity: "medium", why: "Pages with little visible text rarely satisfy search intent.", fix: "Add useful content, or noindex/consolidate pages not meant to rank." },
  "duplicate-content": { title: "Duplicate content", category: "content", severity: "medium", why: "Identical body content on several URLs splits signals between them.", fix: "Canonicalize, consolidate, or rewrite the duplicates." },
  "near-duplicate-content": { title: "Near-duplicate content", category: "content", severity: "medium", why: "Pages whose main text is almost identical compete for the same queries and may be folded together by search engines.", fix: "Differentiate the pages, or consolidate them and canonicalize to one URL." },
  "image-src-missing": { title: "Image without source", category: "images", severity: "high", why: "An img tag with no src renders a broken image.", fix: "Remove the tag or give it a valid image URL." },
  "image-fallback-src-missing": { title: "Picture missing fallback src", category: "images", severity: "low", why: "Clients that ignore <source> need the img src fallback.", fix: "Keep a valid src on the img inside picture elements." },
  "image-srcset-invalid": { title: "Invalid srcset", category: "images", severity: "medium", why: "Malformed srcset candidates cannot be loaded.", fix: "Fix the srcset URLs and descriptors." },
  "image-alt-missing": { title: "Missing alt text", category: "images", severity: "medium", why: "Alt text describes images to screen readers and image search.", fix: "Add descriptive alt text, or mark decorative images explicitly." },
  "image-alt-empty": { title: "Empty alt text", category: "images", severity: "low", why: "Empty alt hides meaningful content images from assistive tech.", fix: "Describe the image, or mark it decorative with role=\"presentation\"." },
  "image-alt-generic": { title: "Generic alt text", category: "images", severity: "low", why: "Alt like \"image\" or the file name tells users nothing.", fix: "Describe what the image shows and why it is there." },
  "image-alt-too-long": { title: "Alt text too long", category: "images", severity: "low", why: "Very long alt text is tedious for screen reader users.", fix: "Keep alt concise; put long explanations in page copy." },
  "image-alt-duplicate": { title: "Duplicate alt text", category: "images", severity: "low", why: "Different images sharing one alt text are indistinguishable.", fix: "Give each meaningful image its own alt text." },
  "image-dimensions-missing": { title: "Unsized images", category: "images", severity: "low", why: "Images without reserved space cause layout shift while loading.", fix: "Set width/height, CSS dimensions, or an aspect ratio." },
  "image-srcset-missing": { title: "Large images without srcset", category: "images", severity: "low", why: "Without responsive sources, small screens download oversized images.", fix: "Provide srcset/sizes candidates for large images." },
  "mixed-content-images": { title: "Mixed-content images", category: "images", severity: "medium", why: "HTTP images on HTTPS pages are blocked or flagged by browsers.", fix: "Serve images over HTTPS." },
  "broken-image": { title: "Broken image", category: "images", severity: "high", why: "The image URL fails, so visitors see a broken image.", fix: "Restore the image or update the URL." },
  "image-certificate-error": { title: "Image certificate error", category: "images", severity: "medium", why: "The image host's TLS certificate could not be verified.", fix: "Check the certificate in a trusted client; fix it or move the image." },
  "image-redirects": { title: "Redirecting image", category: "images", severity: "low", why: "Image redirects add a request before the image loads.", fix: "Reference the final image URL directly." },
  "image-invalid-content-type": { title: "Image wrong content type", category: "images", severity: "medium", why: "The image URL does not return an image, so it will not render.", fix: "Serve a real image file with an image/* Content-Type." },
  "image-extension-mismatch": { title: "Image extension mismatch", category: "images", severity: "low", why: "A file extension that disagrees with the Content-Type confuses caches and crawlers.", fix: "Match the file extension to the served image format." },
  "large-image": { title: "Large image", category: "images", severity: "low", why: "Images over 500 KB slow page loads, especially on mobile.", fix: "Compress, resize, or serve modern formats such as WebP/AVIF." },
  "mixed-content-links": { title: "Mixed-content links", category: "links", severity: "low", why: "HTTP links from HTTPS pages send users to insecure URLs.", fix: "Update links to their HTTPS versions." },
  "empty-anchor-text": { title: "Links without anchor text", category: "links", severity: "low", why: "Links with no text or label give no context about their destination.", fix: "Add visible anchor text or an aria-label." },
  "internal-nofollow": { title: "Nofollow internal links", category: "links", severity: "low", why: "Nofollow on internal links withholds crawl flow from your own pages.", fix: "Remove nofollow from internal links unless intended." },
  "no-internal-links": { title: "No internal links", category: "links", severity: "medium", why: "A page without internal links is a dead end for users and crawlers.", fix: "Link to related pages and navigation." },
  "too-many-links": { title: "Too many links", category: "links", severity: "low", why: "Hundreds of links dilute link equity and overwhelm users.", fix: "Keep navigation and body links focused." },
  "internal-links-with-tracking-parameters": { title: "Internal links with tracking parameters", category: "links", severity: "low", why: "Tracked internal links create duplicate URLs and skew analytics.", fix: "Link to clean URLs internally; keep tagging for inbound campaigns." },
  "broken-internal-link": { title: "Broken internal link", category: "links", severity: "high", why: "Links to failing URLs on your site waste crawl budget and frustrate users.", fix: "Fix or remove the link, or redirect the URL to a live page." },
  "broken-external-link": { title: "Broken external link", category: "links", severity: "medium", why: "Links to failing external URLs hurt user trust.", fix: "Update the link to a working URL or remove it." },
  "link-redirect-loop": { title: "Link redirect loop", category: "links", severity: "high", why: "The linked URL redirects in a cycle and never loads.", fix: "Fix the redirect cycle or link to a working final URL." },
  "internal-link-certificate-error": { title: "Internal link certificate error", category: "links", severity: "medium", why: "The linked URL's TLS certificate could not be verified.", fix: "Check the certificate in a trusted client and fix it." },
  "external-link-certificate-error": { title: "External link certificate error", category: "links", severity: "medium", why: "The external URL's TLS certificate could not be verified.", fix: "Check the certificate in a trusted client before treating the link as broken." },
  "internal-link-redirects": { title: "Redirecting internal link", category: "links", severity: "medium", why: "Internal links through redirects add latency and waste crawl budget.", fix: "Link directly to the final URL." },
  "external-link-redirects": { title: "Redirecting external link", category: "links", severity: "low", why: "External links through redirects add latency and may drift over time.", fix: "Link directly to the final destination." },
  "structured-data-missing": { title: "No structured data", category: "structured-data", severity: "low", why: "Structured data helps search engines understand entities and enables rich results.", fix: "Add relevant JSON-LD such as Organization, BreadcrumbList, or Article." },
  "structured-data-invalid": { title: "Invalid structured data", category: "structured-data", severity: "medium", why: "JSON-LD that does not parse is ignored.", fix: "Fix the JSON syntax in the JSON-LD blocks." },
  "structured-data-missing-required": { title: "Structured data missing required properties", category: "structured-data", severity: "medium", why: "Items without the properties Google requires are not eligible for rich results.", fix: "Add the listed required properties to each structured data item." },
  "structured-data-missing-recommended": { title: "Structured data missing recommended properties", category: "structured-data", severity: "low", why: "Recommended properties give search engines more detail for rich results.", fix: "Add the listed recommended properties where the information exists on the page." },
  "open-graph-incomplete": { title: "Incomplete Open Graph", category: "social", severity: "low", why: "Missing og:title/og:description make shared links render poorly.", fix: "Add og:title and og:description." },
  "open-graph-image-missing": { title: "Missing Open Graph image", category: "social", severity: "low", why: "Shared links without og:image show no preview image.", fix: "Add an og:image with an absolute URL." },
  "open-graph-image-invalid": { title: "Invalid Open Graph image", category: "social", severity: "low", why: "A relative or invalid og:image URL is not loaded by social platforms.", fix: "Use an absolute https URL for og:image." },
  "twitter-card-missing": { title: "Missing Twitter card", category: "social", severity: "low", why: "Without twitter:card, X/Twitter shows a minimal preview.", fix: "Add twitter:card metadata." },
  "mixed-content-assets": { title: "Mixed-content CSS/JS", category: "assets", severity: "medium", why: "HTTP scripts and stylesheets on HTTPS pages are blocked by browsers.", fix: "Serve CSS and JavaScript over HTTPS." },
  "broken-css": { title: "Broken CSS", category: "assets", severity: "high", why: "A failing stylesheet leaves the page unstyled or broken.", fix: "Restore the file, fix the URL, or remove the reference." },
  "broken-javascript": { title: "Broken JavaScript", category: "assets", severity: "high", why: "A failing script can break page features and rendering.", fix: "Restore the file, fix the URL, or remove the reference." },
  "asset-certificate-error": { title: "Asset certificate error", category: "assets", severity: "medium", why: "The asset host's TLS certificate could not be verified.", fix: "Check the certificate in a trusted client; fix it or move the asset." },
  "css-invalid-content-type": { title: "CSS wrong content type", category: "assets", severity: "medium", why: "Browsers refuse stylesheets served with a non-CSS Content-Type.", fix: "Serve the stylesheet as text/css." },
  "javascript-invalid-content-type": { title: "JavaScript wrong content type", category: "assets", severity: "medium", why: "Scripts served with the wrong Content-Type may be blocked.", fix: "Serve scripts with a JavaScript Content-Type." },
  "large-css": { title: "Large CSS file", category: "assets", severity: "low", why: "Stylesheets over 500 KB block rendering longer.", fix: "Split, minify, compress, or remove unused CSS." },
  "large-javascript": { title: "Large JavaScript file", category: "assets", severity: "low", why: "Scripts over 500 KB take long to download and execute.", fix: "Split, minify, compress, or defer the script." },
};

function scanIssueTitle(issue: any) {
  return scanIssueTypes[String(issue?.type || "")]?.title || String(issue?.message || issue?.type || "Issue");
}

const scanLimits = {
  maxPages: 100,
  maxQueuedUrls: 300,
  maxLinksToCheck: 700,
  maxImagesToCheck: 500,
  maxAssetsToCheck: 350,
  maxLinkInventory: 1600,
  maxImageInventory: 1200,
};

// Page requests kept in flight against the scanned site (fast crawls and
// local hosts; polite crawls of remote sites fetch one page at a time).
const PAGE_FETCH_CONCURRENCY = 3;
// Outlinks kept per page for the page drawer (result.pageLinks).
const MAX_OUTLINKS_PER_PAGE = 200;
// Running scans write their list summary at most this often, and the full
// result (every page and issue) at most every RESULT_SAVE_INTERVAL_MS.
const SUMMARY_SAVE_INTERVAL_MS = 1000;
const RESULT_SAVE_INTERVAL_MS = 10_000;

// A scan's crawl scope: its caps plus the robots.txt mode it crawled with.
type ScanLimits = typeof scanLimits & { robots: CrawlRobotsMode };

function scanLimitsFor(maxPages: number, robots: CrawlRobotsMode): ScanLimits {
  const factor = Math.max(1, maxPages / scanLimits.maxPages);
  return {
    maxPages,
    maxQueuedUrls: Math.round(scanLimits.maxQueuedUrls * factor),
    maxLinksToCheck: Math.round(scanLimits.maxLinksToCheck * factor),
    maxImagesToCheck: Math.round(scanLimits.maxImagesToCheck * factor),
    maxAssetsToCheck: Math.round(scanLimits.maxAssetsToCheck * factor),
    maxLinkInventory: Math.round(scanLimits.maxLinkInventory * factor),
    maxImageInventory: Math.round(scanLimits.maxImageInventory * factor),
    robots,
  };
}

// Resolves after ms, or right away once the scan is cancelled.
function sleep(ms: number, signal?: AbortSignal) {
  return new Promise<void>((resolve) => {
    if (signal?.aborted) return resolve();
    const timer = setTimeout(done, ms);
    function done() {
      clearTimeout(timer);
      signal?.removeEventListener("abort", done);
      resolve();
    }
    signal?.addEventListener("abort", done, { once: true });
  });
}

// Runs tasks with a global concurrency cap and a per-host cap, so resource
// checks finish quickly without sending bursts to any single server. Items are
// grouped into per-host queues once (hosts in order of first appearance, items
// in their original order), so each scheduling step only looks at hosts.
async function runBounded<T>(
  items: T[],
  hostOf: (item: T) => string,
  hostLimit: (host: string) => number,
  task: (item: T) => Promise<void>,
  signal: AbortSignal,
  concurrency = 6,
) {
  type HostQueue = { host: string; items: T[]; limit: number; active: number };
  const queues = new Map<string, HostQueue>();
  for (const item of items) {
    const host = hostOf(item);
    const queue = queues.get(host);
    if (queue) queue.items.push(item);
    else queues.set(host, { host, items: [item], limit: hostLimit(host), active: 0 });
  }
  const running = new Set<Promise<void>>();
  while (queues.size && !signal.aborted) {
    let next: HostQueue | undefined;
    if (running.size < concurrency) {
      for (const queue of queues.values()) {
        if (queue.active < queue.limit) {
          next = queue;
          break;
        }
      }
    }
    if (!next) {
      await Promise.race(running);
      continue;
    }
    const queue = next;
    const item = queue.items.shift() as T;
    if (!queue.items.length) queues.delete(queue.host);
    queue.active += 1;
    const job: Promise<void> = task(item).finally(() => {
      queue.active -= 1;
      running.delete(job);
    });
    running.add(job);
  }
  await Promise.all(running);
}

function cleanText(value: string) {
  return value.replace(/\s+/g, " ").trim();
}

function absoluteHttpUrl(value: string, baseUrl: string) {
  const trimmed = value.trim();
  if (!trimmed || /^(mailto:|tel:|javascript:|data:)/i.test(trimmed)) return null;
  try {
    const url = new URL(trimmed, baseUrl);
    if (!/^https?:$/i.test(url.protocol)) return null;
    url.hash = "";
    return url.toString();
  } catch {
    return null;
  }
}

function urlLike(value: string) {
  const trimmed = value.trim();
  return new URL(/^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`);
}

function rootEquivalentHostname(hostname: string) {
  return hostname.trim().toLowerCase().replace(/^www\./i, "");
}

function siteHostKey(value: string) {
  try {
    const url = urlLike(value);
    const hostname = rootEquivalentHostname(url.hostname);
    const renderedHost = hostname.includes(":") && !hostname.startsWith("[") ? `[${hostname}]` : hostname;
    return `${renderedHost}${url.port ? `:${url.port}` : ""}`;
  } catch {
    return "";
  }
}

export function sameSiteUrl(url: string, scope: string) {
  const targetKey = siteHostKey(url);
  const scopeKey = siteHostKey(scope);
  return Boolean(targetKey && scopeKey && targetKey === scopeKey);
}

// Percent-escapes are case-insensitive ("%c3%a9" is "%C3%A9"); URL parsing
// keeps them as written, so comparisons upper-case them.
function upperCaseEscapes(value: string) {
  return value.replace(/%[0-9a-f]{2}/gi, (sequence) => sequence.toUpperCase());
}

function withoutTrailingSlash(pathname: string) {
  return pathname !== "/" && pathname.endsWith("/") ? pathname.replace(/\/+$/, "") || "/" : pathname;
}

function normalizedUrl(value: string) {
  try {
    const url = new URL(value);
    url.hash = "";
    url.pathname = withoutTrailingSlash(url.pathname);
    return upperCaseEscapes(url.toString());
  } catch {
    return value;
  }
}

// Page identity: fragment, www, trailing slash, query parameter order, and
// percent-escape case are ignored.
function urlKey(url: URL) {
  const params = new URLSearchParams(url.search);
  params.sort();
  const query = params.toString();
  const hostname = rootEquivalentHostname(url.hostname);
  const renderedHost = hostname.includes(":") && !hostname.startsWith("[") ? `[${hostname}]` : hostname;
  return upperCaseEscapes(
    `${url.protocol.toLowerCase()}//${renderedHost}${url.port ? `:${url.port}` : ""}${withoutTrailingSlash(url.pathname)}${query ? `?${query}` : ""}`,
  );
}

function normalizedUrlKey(value: string) {
  try {
    return urlKey(new URL(value));
  } catch {
    return value;
  }
}

function hasQueryParams(value: string) {
  try {
    return new URL(value).searchParams.size > 0;
  } catch {
    return value.includes("?");
  }
}

function withoutQueryUrl(value: string) {
  try {
    const url = new URL(value);
    url.search = "";
    url.hash = "";
    return url.toString();
  } catch {
    return value;
  }
}

function isHttpOnHttpsPage(value: string, pageUrl: string) {
  try {
    return new URL(pageUrl).protocol === "https:" && new URL(value).protocol === "http:";
  } catch {
    return false;
  }
}

function isLikelyPagePath(pathname: string) {
  return !/\.(?:avif|bmp|css|csv|docx?|eot|gif|gz|ico|jpe?g|js|json|m4v|map|mov|mp3|mp4|ogg|otf|pdf|png|pptx?|rar|svg|tar|ttf|txt|wav|webm|webp|woff2?|xlsx?|xml|zip)$/i.test(pathname);
}

const ignoredCrawlPath = "/cdn-cgi/l/email-protection";

function isIgnoredCrawlUrl(value: string) {
  try {
    return new URL(value).pathname === ignoredCrawlPath;
  } catch {
    return false;
  }
}

// The URL the crawler requests for a link, and its key. Parameterized links
// are crawled without their query string, except the start URL itself.
// startKey is normalizedUrlKey(startUrl), computed once per scan.
function pageCrawlTarget(value: string, startKey: string) {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (!isLikelyPagePath(url.pathname) || url.pathname === ignoredCrawlPath) return null;
  const key = urlKey(url);
  const parameterized = url.searchParams.size > 0;
  if (!parameterized || key === startKey) return { url: value, key, parameterized };
  url.search = "";
  url.hash = "";
  return { url: url.toString(), key: urlKey(url), parameterized };
}

function parseSrcsetUrls(value: string, baseUrl: string) {
  return value
    .split(",")
    .map((candidate) => candidate.trim().split(/\s+/)[0])
    .map((candidate) => absoluteHttpUrl(candidate, baseUrl))
    .filter(Boolean) as string[];
}

function srcsetCandidateCount(value: string) {
  return value
    .split(",")
    .map((candidate) => candidate.trim())
    .filter(Boolean).length;
}

function cssUrlValues(value: string, baseUrl: string) {
  const urls = new Set<string>();
  const pattern = /url\(\s*(['"]?)(.*?)\1\s*\)/gi;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(value))) {
    const raw = cleanText(match[2] || "");
    if (!raw || /^(data:|about:|#)/i.test(raw)) continue;
    const absolute = absoluteHttpUrl(raw, baseUrl);
    if (absolute && isLikelyImageUrl(absolute)) urls.add(absolute);
  }
  return [...urls];
}

function isLikelyImageUrl(value: string) {
  try {
    const pathname = new URL(value).pathname.toLowerCase();
    return /\.(avif|gif|jpe?g|png|svg|webp)(?:$|\?)/i.test(pathname);
  } catch {
    return /\.(avif|gif|jpe?g|png|svg|webp)(?:$|\?)/i.test(value);
  }
}

function expectedImageMime(value: string) {
  try {
    const pathname = new URL(value).pathname.toLowerCase();
    if (/\.avif$/i.test(pathname)) return "image/avif";
    if (/\.gif$/i.test(pathname)) return "image/gif";
    if (/\.jpe?g$/i.test(pathname)) return "image/jpeg";
    if (/\.png$/i.test(pathname)) return "image/png";
    if (/\.svg$/i.test(pathname)) return "image/svg+xml";
    if (/\.webp$/i.test(pathname)) return "image/webp";
  } catch {
    return "";
  }
  return "";
}

function imageClassification(input: {
  src: string;
  width: string;
  height: string;
  role: string;
  ariaHidden: string;
}) {
  const width = Number.parseInt(input.width || "0", 10);
  const height = Number.parseInt(input.height || "0", 10);
  const src = input.src.toLowerCase();
  if (
    (width > 0 && width <= 2 && height > 0 && height <= 2) ||
    // Whole tokens only: "/collect" is a tracking endpoint, "/collections/" is not.
    /(?:^|[^a-z0-9])(?:pixel|beacon|tracking|analytics|collect|transparent|spacer)(?:[^a-z0-9]|$)/i.test(src)
  ) {
    return "tracking";
  }
  if (/^(presentation|none)$/i.test(input.role) || input.ariaHidden === "true") {
    return "decorative";
  }
  return "content";
}

// Static crawls cannot resolve external stylesheets, so CSS sizing is accepted
// from the evidence available in the HTML itself: inline styles and
// Tailwind-style utility classes. Mirrors the intent of Lighthouse's
// unsized-images audit, which passes images sized via CSS, not just attributes.
function imageIsCssSized(className: string, style: string) {
  const styleText = style.toLowerCase();
  const styleWidth = /(?:^|[;\s])width\s*:/.test(styleText);
  const styleHeight = /(?:^|[;\s])height\s*:/.test(styleText);
  const styleAspect = /aspect-ratio\s*:/.test(styleText);
  const tokens = className
    .split(/\s+/)
    .map((token) => token.split(":").pop() || "")
    .filter(Boolean);
  const hasToken = (pattern: RegExp) => tokens.some((token) => pattern.test(token));
  const classWidth = hasToken(/^(?:w-(?:\d|px|full|screen|\[)|size-)/);
  const classHeight = hasToken(/^(?:h-(?:\d|px|full|screen|\[)|size-)/);
  const classAspect = hasToken(/^aspect-/);
  const absoluteFill = hasToken(/^(?:absolute|fixed)$/) && hasToken(/^inset-/);
  return ((styleWidth || classWidth) && (styleHeight || classHeight)) || styleAspect || classAspect || absoluteFill;
}

function contentFingerprint(value: string) {
  const normalized = value
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (normalized.length < 300) return "";
  return createHash("sha1").update(normalized).digest("hex");
}

// Near-duplicate detection: a 64-bit simhash of the page's 3-word shingles,
// stored as 16 hex characters. Similar texts differ in few bits: measured on
// real crawls, 99.7%-identical pages had a median distance of 4 bits while
// unrelated pages were never closer than 19, so pairs within 8 bits match.
const SIMHASH_MIN_WORDS = 50;
const NEAR_DUPLICATE_MAX_DISTANCE = 8;

function hash32(value: string, seed: number) {
  let hash = seed;
  for (let index = 0; index < value.length; index += 1) {
    hash = Math.imul(hash ^ value.charCodeAt(index), 0x01000193);
  }
  // murmur3 finalizer, so every output bit depends on every input bit.
  hash = Math.imul(hash ^ (hash >>> 16), 0x85ebca6b);
  hash = Math.imul(hash ^ (hash >>> 13), 0xc2b2ae35);
  return (hash ^ (hash >>> 16)) >>> 0;
}

function contentSimhash(text: string) {
  const words = text.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean);
  if (words.length < SIMHASH_MIN_WORDS) return "";
  const weights = new Int32Array(64);
  for (let index = 0; index + 2 < words.length; index += 1) {
    const shingle = `${words[index]} ${words[index + 1]} ${words[index + 2]}`;
    const halves = [hash32(shingle, 0x811c9dc5), hash32(shingle, 0x2f6b1d27)];
    for (let bit = 0; bit < 64; bit += 1) {
      weights[bit] += (halves[bit >> 5] >>> (bit & 31)) & 1 ? 1 : -1;
    }
  }
  const halves = [0, 0];
  for (let bit = 0; bit < 64; bit += 1) {
    if (weights[bit] > 0) halves[bit >> 5] |= 1 << (bit & 31);
  }
  return halves.map((half) => (half >>> 0).toString(16).padStart(8, "0")).join("");
}

function bitCount32(value: number) {
  let bits = value - ((value >>> 1) & 0x55555555);
  bits = (bits & 0x33333333) + ((bits >>> 2) & 0x33333333);
  return (Math.imul((bits + (bits >>> 4)) & 0x0f0f0f0f, 0x01010101) >>> 24) & 0xff;
}

function firstH1Fingerprint(value: string) {
  return cleanText(value).toLowerCase();
}

function isGenericAltText(value: string, src: string) {
  const alt = cleanText(value).toLowerCase();
  if (!alt) return false;
  if (/^(image|photo|picture|graphic|banner|logo|icon|screenshot|thumbnail)$/i.test(alt)) return true;
  try {
    const path = new URL(src).pathname;
    const filename = decodeURIComponent(path.split("/").filter(Boolean).pop() || "")
      .replace(/\.[a-z0-9]+$/i, "")
      .replace(/[-_]+/g, " ")
      .trim()
      .toLowerCase();
    return Boolean(filename && alt === filename);
  } catch {
    return false;
  }
}

function isLikelyTrackingUrl(value: string) {
  try {
    const url = new URL(value);
    return [...url.searchParams.keys()].some((key) =>
      /^(utm_|fbclid$|gclid$|msclkid$|mc_cid$|mc_eid$|igshid$|ref$|source$)/i.test(key),
    );
  } catch {
    return false;
  }
}

function isValidLangCode(value: string) {
  return /^[a-z]{2,3}(-[a-z0-9]{2,8})*$/i.test(value);
}

// Ahrefs-style health score: (pages without errors / pages) × 100, where
// only high-severity issues count as errors. Medium and low findings
// inform the report but never move the score — matching
// https://help.ahrefs.com/en/articles/1424673
function healthScore(pages: any[], issues: any[]) {
  const pageKeys = new Set(pages.map((page) => normalizedUrlKey(page.url)));
  const highPages = new Set<string>();
  for (const issue of issues) {
    if (issue.severity !== "high") continue;
    const key = normalizedUrlKey(issue.url || "");
    if (pageKeys.has(key)) highPages.add(key);
  }
  return pages.length === 0
    ? 0
    : Math.max(0, Math.min(100, Math.round((100 * (pages.length - highPages.size)) / pages.length)));
}

function severityCounts(rows: any[]) {
  return {
    high: rows.filter((issue) => issue.severity === "high").length,
    medium: rows.filter((issue) => issue.severity === "medium").length,
    low: rows.filter((issue) => issue.severity === "low").length,
  };
}

function issuePriority(severity: ScanIssueSeverity) {
  return severity === "high" ? 3 : severity === "medium" ? 2 : 1;
}

function pushScanIssue(
  issues: any[],
  issue: {
    url: string;
    severity: ScanIssueSeverity;
    category: ScanIssueCategory;
    type: string;
    message: string;
    recommendation: string;
    evidence?: Record<string, unknown>;
  },
) {
  const row = {
    id: randomUUID(),
    ...issue,
  };
  issues.push(row);
  return row;
}

function groupDuplicateValues(pages: any[], key: string) {
  const map = new Map<string, any[]>();
  for (const page of pages) {
    const value = cleanText(String(page[key] || ""));
    if (!value) continue;
    const rows = map.get(value) || [];
    rows.push(page);
    map.set(value, rows);
  }
  return [...map.entries()].filter(([, rows]) => rows.length > 1);
}

function groupIssueSummary(issues: any[]) {
  const groups = new Map<string, any>();
  for (const issue of issues) {
    const key = `${issue.category}:${issue.type}`;
    const existing = groups.get(key) || {
      key,
      category: issue.category,
      type: issue.type,
      severity: issue.severity,
      // Groups are named by issue type, not by whichever page came first.
      title: scanIssueTitle(issue),
      message: scanIssueTitle(issue),
      recommendation: issue.recommendation,
      count: 0,
      urls: [],
    };
    existing.count += 1;
    if (issuePriority(issue.severity) > issuePriority(existing.severity)) {
      existing.severity = issue.severity;
      existing.recommendation = issue.recommendation;
    }
    if (issue.url && existing.urls.length < 8 && !existing.urls.includes(issue.url)) {
      existing.urls.push(issue.url);
    }
    groups.set(key, existing);
  }
  return [...groups.values()].sort((a, b) => {
    const severityDelta = issuePriority(b.severity) - issuePriority(a.severity);
    if (severityDelta) return severityDelta;
    return b.count - a.count;
  });
}

function issueComparisonKey(issue: any) {
  const evidence = issue?.evidence || {};
  const subject = evidence.linkedUrl || evidence.image || evidence.asset || evidence.canonical || evidence.finalUrl || "";
  return [normalizedUrlKey(String(issue?.url || "")), String(issue?.type || ""), normalizedUrlKey(String(subject))].join("|");
}

function comparisonIssue(issue: any, change: string, extra: Record<string, unknown> = {}) {
  const evidence = issue?.evidence || {};
  return {
    change,
    url: issue?.url || "",
    category: issue?.category || "",
    type: issue?.type || "",
    severity: issue?.severity || "low",
    message: issue?.message || String(issue?.type || "Issue").replaceAll("-", " "),
    subject: evidence.linkedUrl || evidence.image || evidence.asset || evidence.canonical || evidence.finalUrl || "",
    ...extra,
  };
}

// Regressions, one definition for every view (Changes tab, report,
// notifications, MCP): the pages with at least one page change flagged as a
// regression. `total` is that page count and always equals
// comparison.summary.regressions. New high/medium issues are counted
// separately and are not part of `total`. `pages` keeps one row per regressed
// page (its most serious change first), at most 20.
const regressionOrder = ["became-non-indexable", "became-non-200", "page-removed"];

function comparisonRegressions(newIssues: any[], pageChanges: any[]) {
  const isSuccess = (value: unknown) => Number(value) >= 200 && Number(value) < 300;
  const rank = (change: string) => (regressionOrder.includes(change) ? regressionOrder.indexOf(change) : regressionOrder.length);
  const byPage = new Map<string, { url: string; change: string; before: unknown; after: unknown }[]>();
  for (const change of pageChanges) {
    if (!change.regression) continue;
    const kind =
      change.type === "http-status-changed" && isSuccess(change.before) && !isSuccess(change.after) ? "became-non-200" : change.type;
    const rows = byPage.get(change.url) || [];
    rows.push({ url: change.url, change: kind, before: change.before, after: change.after });
    byPage.set(change.url, rows);
  }
  const regressedPages = [...byPage.values()];
  const pagesWith = (change: string) => regressedPages.filter((rows) => rows.some((row) => row.change === change)).length;
  return {
    total: regressedPages.length,
    newHighIssues: newIssues.filter((issue) => issue.severity === "high").length,
    newMediumIssues: newIssues.filter((issue) => issue.severity === "medium").length,
    becameNonIndexable: pagesWith("became-non-indexable"),
    becameNon200: pagesWith("became-non-200"),
    pages: regressedPages
      .map((rows) => [...rows].sort((a, b) => rank(a.change) - rank(b.change))[0])
      .sort((a, b) => rank(a.change) - rank(b.change))
      .slice(0, 20),
  };
}

function emptyScanComparison(reason: string, previousScan?: any) {
  return {
    available: false,
    reason,
    previousScanId: previousScan?.id || null,
    previousCreatedAt: previousScan?.created_at || null,
    summary: { newIssues: 0, fixedIssues: 0, severityChanges: 0, regressions: 0, pageChanges: 0 },
    regressions: comparisonRegressions([], []),
    newIssues: [],
    fixedIssues: [],
    severityChanges: [],
    pageChanges: [],
  };
}

// Field-level changes for one page that exists in both scans.
function comparePageRows(previous: any, page: any) {
  const changes: any[] = [];
  const addChange = (type: string, label: string, field: string, before: unknown, after: unknown, regression = false) => {
    changes.push({ type, label, url: page.url, field, before, after, regression });
  };
  if (typeof previous.indexable === "boolean" && typeof page.indexable === "boolean" && previous.indexable !== page.indexable) {
    addChange(
      page.indexable ? "became-indexable" : "became-non-indexable",
      page.indexable ? "Page became indexable" : "Page became non-indexable",
      "Indexability",
      previous.indexable ? "Indexable" : "Non-indexable",
      page.indexable ? "Indexable" : "Non-indexable",
      !page.indexable,
    );
  }
  const previousStatus = Number(previous.status || 0);
  const currentStatus = Number(page.status || 0);
  if (previousStatus !== currentStatus) {
    addChange(
      "http-status-changed",
      "HTTP status changed",
      "HTTP status",
      previousStatus || "Unknown",
      currentStatus || "Unknown",
      (previousStatus < 300 && (currentStatus >= 300 || !currentStatus)) || (previousStatus < 400 && currentStatus >= 400),
    );
  }
  const previousFinalUrl = normalizedUrl(String(previous.finalUrl || previous.url || ""));
  const currentFinalUrl = normalizedUrl(String(page.finalUrl || page.url || ""));
  if (previousFinalUrl !== currentFinalUrl) {
    addChange("redirect-target-changed", "Redirect destination changed", "Final URL", previousFinalUrl, currentFinalUrl, true);
  }
  const fields = [
    { key: "title", label: "Title changed", field: "Title" },
    { key: "description", label: "Meta description changed", field: "Meta description" },
    { key: "h1", label: "H1 changed", field: "H1" },
    { key: "wordCount", label: "Word count changed", field: "Word count" },
  ];
  for (const item of fields) {
    const before = previous[item.key] ?? "";
    const after = page[item.key] ?? "";
    if (String(before) !== String(after)) {
      addChange(`${item.key}-changed`, item.label, item.field, before, after);
    }
  }
  if (Boolean(previous.sitemapListed) !== Boolean(page.sitemapListed)) {
    addChange(
      page.sitemapListed ? "page-added-to-sitemap" : "page-removed-from-sitemap",
      page.sitemapListed ? "Page added to sitemap" : "Page removed from sitemap",
      "Sitemap",
      previous.sitemapListed ? "Listed" : "Not listed",
      page.sitemapListed ? "Listed" : "Not listed",
      !page.sitemapListed && page.indexable === true,
    );
  }
  return changes;
}

// previousScan carries its parsed saved result as `result`.
function buildScanComparison(
  previousScan: any,
  pages: any[],
  issues: any[],
  limits: ScanLimits,
  scanVersion = SCAN_RESULT_VERSION,
) {
  const previousResult = previousScan?.result;
  if (!previousScan || !previousResult) {
    return emptyScanComparison("no-previous-scan");
  }
  if (Number(previousResult.scanVersion || 0) !== Number(scanVersion || 0)) {
    return emptyScanComparison("incompatible-version", previousScan);
  }
  // Scans saved before limits.robots fetched every URL, as "ignore" does.
  if (
    Number(previousResult.limits?.maxPages || 0) !== Number(limits?.maxPages || 0) ||
    (previousResult.limits?.robots || "ignore") !== (limits?.robots || "ignore")
  ) {
    return emptyScanComparison("scope-changed", previousScan);
  }

  const previousPages = Array.isArray(previousResult.pages) ? previousResult.pages : [];
  const previousPageMap = new Map<string, any>(
    previousPages.map((page: any) => [normalizedUrlKey(String(page.url || "")), page]),
  );
  const currentPageMap = new Map<string, any>(
    pages.map((page: any) => [normalizedUrlKey(String(page.url || "")), page]),
  );
  const previousIssues = Array.isArray(previousResult.issues) ? previousResult.issues : [];
  const previousIssueMap = new Map<string, any>(previousIssues.map((issue: any) => [issueComparisonKey(issue), issue]));
  const currentIssueMap = new Map<string, any>(issues.map((issue: any) => [issueComparisonKey(issue), issue]));
  const newIssues = [...currentIssueMap.entries()]
    .filter(([key]) => !previousIssueMap.has(key))
    .map(([, issue]) => comparisonIssue(issue, "new"));
  const fixedIssues = [...previousIssueMap.entries()]
    .filter(([key, issue]) => {
      if (currentIssueMap.has(key)) return false;
      const pageKey = normalizedUrlKey(String(issue?.url || ""));
      return !previousPageMap.has(pageKey) || currentPageMap.has(pageKey);
    })
    .map(([, issue]) => comparisonIssue(issue, "fixed"));
  const severityChanges = [...currentIssueMap.entries()].flatMap(([key, issue]) => {
    const previous = previousIssueMap.get(key);
    if (!previous || previous.severity === issue.severity) return [];
    return [
      comparisonIssue(issue, "severity-changed", {
        previousSeverity: previous.severity || "low",
        currentSeverity: issue.severity || "low",
      }),
    ];
  });

  const pageChanges: any[] = [];
  for (const [key, page] of currentPageMap) {
    const previous = previousPageMap.get(key);
    if (previous) {
      pageChanges.push(...comparePageRows(previous, page));
    } else {
      pageChanges.push({ type: "page-added", label: "Page discovered", url: page.url, field: "Page", before: "Not crawled", after: "Crawled", regression: false });
    }
  }
  for (const [key, page] of previousPageMap) {
    if (!currentPageMap.has(key)) {
      pageChanges.push({ type: "page-removed", label: "Page no longer crawled", url: page.url, field: "Page", before: "Crawled", after: "Not crawled", regression: true });
    }
  }

  const regressions = comparisonRegressions(newIssues, pageChanges);
  return {
    available: true,
    previousScanId: previousScan.id,
    previousCreatedAt: previousScan.created_at,
    summary: {
      newIssues: newIssues.length,
      fixedIssues: fixedIssues.length,
      severityChanges: severityChanges.length,
      regressions: regressions.total,
      pageChanges: pageChanges.length,
    },
    regressions,
    newIssues,
    fixedIssues,
    severityChanges,
    pageChanges,
  };
}

// The most recent completed scan of the same site and start URL that was
// created before scanId — the baseline for "what changed" views — with its
// parsed saved result.
function previousCompletedScan(siteId: string, scanId: string, startUrl: string) {
  const startKey = normalizedUrlKey(httpStartUrl(startUrl));
  const candidate = all<any>(
    `
    SELECT id, created_at, updated_at, url, status FROM scans
    WHERE site_id = ?
      AND status = 'completed'
      AND rowid < (SELECT rowid FROM scans WHERE id = ?)
    ORDER BY rowid DESC
    LIMIT 50
    `,
    [siteId, scanId],
  ).find((row) => normalizedUrlKey(httpStartUrl(String(row.url || ""))) === startKey);
  return candidate ? { ...candidate, result: cachedScanResult(candidate) } : null;
}

function httpStartUrl(value: string) {
  return /^https?:\/\//i.test(value) ? value : `https://${value}`;
}

const selectScanRow = "SELECT id, site_id, url, status, created_at, updated_at FROM scans WHERE id = ?";

// Compare any two scans of the same site; baseId is the older baseline.
export function compareScans(scanId: string, baseId: string) {
  const current = get<any>(selectScanRow, [scanId]);
  const base = get<any>(selectScanRow, [baseId]);
  if (!current || !base) throw new ScanRequestError(404, "Scan not found.");
  if (current.site_id !== base.site_id) {
    throw new ScanRequestError(400, "Scans can only be compared within the same site.");
  }
  const result = cachedScanResult(current) || {};
  const comparison = buildScanComparison(
    { ...base, result: cachedScanResult(base) },
    Array.isArray(result.pages) ? result.pages : [],
    Array.isArray(result.issues) ? result.issues : [],
    result.limits,
    result.scanVersion,
  );
  return filterComparison(comparison, siteIgnoreRules(current.site_id));
}

// Normalized keys of a saved result's distinct outlinks, computed once per
// cached result for repeated page-drawer reads.
const outlinkKeyCache = new WeakMap<object, string[]>();

function outlinkKeys(pageLinks: { links: any[] }) {
  let keys = outlinkKeyCache.get(pageLinks);
  if (!keys) {
    keys = pageLinks.links.map((link) => normalizedUrlKey(String(link?.href || "")));
    outlinkKeyCache.set(pageLinks, keys);
  }
  return keys;
}

// The aria-label, title, or image alt that names a link without anchor text.
function accessibleNameField(link: any) {
  return link.accessibleName ? { accessibleName: String(link.accessibleName) } : {};
}

// One page of a saved scan with its issues, link graph, images, and the
// changes since the same page in the previous completed scan.
export function getScanPage(scanId: string, pageUrl: string) {
  if (!pageUrl) throw new ScanRequestError(400, "Pass the page URL as ?url=.");
  const scan = get<any>(selectScanRow, [scanId]);
  if (!scan) throw new ScanRequestError(404, "Scan not found.");
  const result = cachedScanResult(scan) || {};
  const pages: any[] = Array.isArray(result.pages) ? result.pages : [];
  // The saved page URL, then the URL it was requested as or landed on, then
  // any of those under the same normalized URL key.
  const requestedKey = normalizedUrlKey(pageUrl);
  const page =
    pages.find((row) => row.url === pageUrl) ||
    pages.find((row) => row.finalUrl === pageUrl || row.requestedUrl === pageUrl) ||
    pages.find((row) =>
      [row.url, row.finalUrl, row.requestedUrl].some((value) => value && normalizedUrlKey(String(value)) === requestedKey),
    );
  if (!page) throw new ScanRequestError(404, "Page not found in this scan.");
  const pageKeys = new Set(
    [page.url, page.finalUrl, page.requestedUrl].filter(Boolean).map((value) => normalizedUrlKey(String(value))),
  );
  const pageUrls = new Set([page.url, page.requestedUrl].filter(Boolean));
  const rules = siteIgnoreRules(scan.site_id);
  const issues = (Array.isArray(result.issues) ? result.issues : [])
    .filter((issue: any) => pageUrls.has(issue.url))
    .map((issue: any) => (issueMatchesIgnore(issue, rules) ? { ...issue, ignored: true } : issue));

  // Scans keep every page's outlinks in pageLinks (capped per page); older
  // scans only have the globally capped link inventory. Checked links add any
  // other source pages either one did not keep.
  const inlinks = new Map<string, { from: string; anchor?: string; accessibleName?: string; nofollow?: boolean }>();
  const addInlink = (from: string, link: any) =>
    inlinks.set(from, { from, anchor: link.anchor || undefined, ...accessibleNameField(link), nofollow: /\bnofollow\b/i.test(link.rel || "") });
  const pageLinks = Array.isArray(result.pageLinks?.links) ? result.pageLinks : null;
  let outlinkRows: any[];
  if (pageLinks) {
    const keys = outlinkKeys(pageLinks);
    const linksHere = (index: number) => pageLinks.links[index]?.type === "internal" && pageKeys.has(keys[index]);
    for (const [from, indexes] of Object.entries<number[]>(pageLinks.pages || {})) {
      const index = indexes.find(linksHere);
      if (index !== undefined) addInlink(from, pageLinks.links[index]);
    }
    outlinkRows = (pageLinks.pages?.[page.url] || []).map((index: number) => pageLinks.links[index]).filter(Boolean);
  } else {
    const inventory: any[] = Array.isArray(result.linkInventory) ? result.linkInventory : [];
    for (const link of inventory) {
      if (link.type !== "internal" || inlinks.has(link.from) || !pageKeys.has(normalizedUrlKey(String(link.href || "")))) continue;
      addInlink(link.from, link);
    }
    outlinkRows = inventory.filter((link) => link.from === page.url);
  }
  const checkedLinks: any[] = Array.isArray(result.links) ? result.links : [];
  for (const link of checkedLinks) {
    if (link.type !== "internal" || !pageKeys.has(normalizedUrlKey(String(link.url || "")))) continue;
    for (const from of Array.isArray(link.sourcePages) ? link.sourcePages : link.from ? [link.from] : []) {
      if (!inlinks.has(from)) inlinks.set(from, { from });
    }
  }
  const linkChecks = new Map(checkedLinks.map((link) => [link.url, link]));
  const outlinks = outlinkRows.map((link: any) => {
    const check = linkChecks.get(link.href);
    return {
      href: link.href,
      anchor: link.anchor,
      ...accessibleNameField(link),
      rel: link.rel,
      type: link.type,
      ...(check ? { ok: check.ok, status: check.status, finalStatus: check.finalStatus, finalUrl: check.finalUrl } : {}),
    };
  });
  // Every <a href> on the page, so the drawer can say when the list is capped.
  const outlinkTotal = Math.max(outlinks.length, Number(page.internalLinks || 0) + Number(page.externalLinks || 0));
  const imageChecks = new Map((Array.isArray(result.images) ? result.images : []).map((image: any) => [image.url, image]));
  const images = (Array.isArray(result.imageInventory) ? result.imageInventory : [])
    .filter((image: any) => image.from === page.url)
    .map((image: any) => {
      const check: any = imageChecks.get(image.src);
      return {
        ...image,
        ...(check ? { ok: check.ok, status: check.status, finalStatus: check.finalStatus, contentType: check.contentType, contentLength: check.contentLength } : {}),
      };
    });

  const previousScan = previousCompletedScan(scan.site_id, scan.id, result.startUrl || scan.url);
  const previousPages: any[] = Array.isArray(previousScan?.result?.pages) ? previousScan.result.pages : [];
  const previousPage = previousPages.find((row) => pageKeys.has(normalizedUrlKey(String(row.url || ""))));
  return {
    page,
    issues,
    inlinks: [...inlinks.values()],
    outlinks,
    outlinkTotal,
    outlinksTruncated: outlinks.length < outlinkTotal,
    images,
    previous: previousScan && previousPage
      ? {
          scanId: previousScan.id,
          createdAt: previousScan.created_at,
          url: previousPage.url,
          changes: comparePageRows(previousPage, page),
        }
      : null,
  };
}

export function resourceFailureKind(error: unknown) {
  const message = String(error || "");
  if (/(certificate|cert\b|issuer|self[- ]signed|ssl|tls|unable to verify)/i.test(message)) return "tls-certificate";
  if (/(abort|timeout|timed out)/i.test(message)) return "timeout";
  if (/(dns|enotfound|name.*resolve|host.*not found)/i.test(message)) return "dns";
  return "request";
}

const resourceCheckTimeoutMs = 12000;

// skipRedirect: a redirect target the check must not request (robots.txt);
// the check then ends at that redirect and names the target in
// skippedRedirect.
async function checkResource(url: string, signal?: AbortSignal, skipRedirect?: (url: string) => Promise<boolean>) {
  // Each request gets its own timeout so a slow HEAD cannot eat the GET retry.
  const requestSignal = () => {
    const timeout = AbortSignal.timeout(resourceCheckTimeoutMs);
    return signal ? AbortSignal.any([timeout, signal]) : timeout;
  };
  try {
    let trace = await fetchWithRedirectTrace(
      url,
      {
        method: "HEAD",
        signal: requestSignal(),
        headers: {
          "User-Agent": "LocalSEO/0.1 (+https://localhost)",
          Accept: "*/*",
        },
      },
      undefined,
      skipRedirect,
    );
    // Some sites serve the page on GET but return 404 for HEAD.
    // Confirm with a real content request before reporting a broken resource.
    if ([403, 404, 405, 501].includes(trace.finalStatus)) {
      await trace.response.body?.cancel().catch(() => undefined);
      trace = await fetchWithRedirectTrace(
        url,
        {
          method: "GET",
          signal: requestSignal(),
          headers: {
            "User-Agent": "LocalSEO/0.1 (+https://localhost)",
            Accept: "*/*",
            Range: "bytes=0-2048",
          },
        },
        undefined,
        skipRedirect,
      );
    }
    const { response } = trace;
    await response.body?.cancel().catch(() => undefined);
    // A ranged GET reports the partial length in Content-Length; the true total
    // is in Content-Range ("bytes 0-2048/524288"). Prefer that so size checks work.
    const rangeTotal = Number((response.headers.get("content-range") || "").split("/")[1]) || null;
    const partialLength = Number(response.headers.get("content-length") || 0) || null;
    // A redirect whose target was not requested says nothing about the
    // resource's type or size, so neither is recorded.
    const skipped = Boolean(trace.stoppedBefore);
    return {
      ok: response.status < 400 && !trace.redirectError,
      status: trace.originalStatus,
      finalStatus: trace.finalStatus,
      finalUrl: trace.finalUrl,
      redirected: trace.redirected,
      redirectChain: trace.redirectChain,
      redirectLoop: trace.redirectLoop,
      redirectError: trace.redirectError,
      contentType: skipped ? "" : response.headers.get("content-type") || "",
      contentLength: skipped ? null : response.status === 206 ? rangeTotal ?? partialLength : partialLength,
      contentEncoding: skipped ? "" : response.headers.get("content-encoding") || "",
      error: trace.redirectError,
      failureKind: trace.redirectError ? "redirect" : "",
      ...(skipped ? { skippedRedirect: trace.stoppedBefore } : {}),
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : "Request failed";
    return failedResourceCheck(url, message);
  }
}

function failedResourceCheck(url: string, message: string) {
  return {
    ok: false,
    status: null,
    finalStatus: null,
    finalUrl: url,
    redirected: false,
    redirectChain: [],
    redirectLoop: false,
    redirectError: "",
    contentType: "",
    contentLength: null,
    error: message,
    failureKind: resourceFailureKind(message),
  };
}

// Tests one URL against the site's robots.txt, fetched live or passed in as a
// draft, with the same Googlebot matcher the crawler uses.
export async function testSiteRobots(siteId: string, input: { url?: unknown; userAgent?: unknown; robotsTxt?: unknown }) {
  const site = getSite(siteId);
  if (!site) throw new ScanRequestError(404, "Site not found.");
  const url = String(input?.url || "").trim();
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new ScanRequestError(400, "Pass an absolute http(s) URL as url.");
  }
  if (!/^https?:$/.test(parsed.protocol) || !sameSiteUrl(url, site.domain)) {
    throw new ScanRequestError(400, `The URL must be on ${site.domain}.`);
  }
  const userAgent = String(input?.userAgent || "").trim() || "Googlebot";
  const robotsUrl = `${parsed.origin}/robots.txt`;
  // status: "matched" / "no-matching-rule" when rules were read; without a
  // readable file, "robots-missing" (3xx/4xx: everything allowed) or
  // "robots-unavailable" (429/5xx/network: Google treats the site as disallowed).
  const withRules = (robotsTxt: string, source: string, fetchedStatus: number | null) => {
    const verdict = testRobots(robotsTxt, url, userAgent);
    return { ...verdict, status: verdict.matchedRule ? "matched" : "no-matching-rule", robotsUrl, source, fetchedStatus };
  };
  if (typeof input?.robotsTxt === "string") return withRules(input.robotsTxt, "provided", null);
  let error = "";
  const response = await fetchText(robotsUrl, 15000, { maxBytes: MAX_ROBOTS_BYTES }).catch((reason) => {
    error = reason instanceof Error ? reason.message : "Could not fetch robots.txt";
    return null;
  });
  const fetchedStatus = response ? response.finalStatus : null;
  if (response?.ok) return withRules(response.text, "live", fetchedStatus);
  const missing = robotsResponseAllowsAll(fetchedStatus);
  return {
    allowed: missing,
    matchedRule: null,
    userAgentGroup: "",
    status: missing ? "robots-missing" : "robots-unavailable",
    ...(missing ? {} : { error: error || `robots.txt answered HTTP ${fetchedStatus}.` }),
    robotsUrl,
    source: "live",
    fetchedStatus,
  };
}

// Where the crawler found a URL it did not request because robots.txt
// disallows it (result.robotsSkipped).
type RobotsSkipSource = "start-url" | "link" | "sitemap" | "canonical" | "hreflang" | "resource" | "redirect" | "soft-404";

// Records a URL as skipped when robots.txt disallows it for the crawler and
// returns why; null means the URL may be requested.
type RobotsSkipCheck = (url: string, source: RobotsSkipSource, from?: string) => Promise<RobotsBlock | null>;

// One request for a URL that cannot exist on the site. A 2xx answer, directly
// or after redirects, means missing pages look like real pages (a soft 404).
// The path is fixed per origin so the finding keeps its identity across scans.
// It is not requested when robots.txt disallows it (robotsSkipped).
async function probeSoftNotFound(origin: string, signal: AbortSignal, skipBlocked: RobotsSkipCheck) {
  const probeUrl = `${origin}/localseo-404-check-${createHash("sha1").update(origin).digest("hex").slice(0, 12)}`;
  const block = await skipBlocked(probeUrl, "soft-404");
  if (block) {
    return { probeUrl, status: null, finalUrl: probeUrl, soft404: false, robotsSkipped: true, rule: block.rule, userAgentGroup: block.userAgentGroup };
  }
  try {
    const response = await fetchText(probeUrl, 15000, {
      signal,
      maxBytes: 64 * 1024,
      skipRedirect: async (targetUrl) => Boolean(await skipBlocked(targetUrl, "redirect", probeUrl)),
    });
    return {
      probeUrl,
      status: response.finalStatus,
      sourceStatus: response.status,
      finalUrl: response.url,
      redirectChain: response.redirectChain,
      // A redirect to a disallowed URL ends the probe without a final answer.
      ...(response.skippedRedirect ? { skippedRedirect: response.skippedRedirect } : {}),
      soft404: !response.skippedRedirect && response.finalStatus >= 200 && response.finalStatus < 300,
    };
  } catch (error) {
    return {
      probeUrl,
      status: null,
      finalUrl: probeUrl,
      soft404: false,
      error: error instanceof Error ? error.message : "Request failed",
    };
  }
}

function collectXmlLocs(node: any, locs = new Set<string>()) {
  if (!node || typeof node !== "object") return locs;
  if (typeof node.loc === "string") locs.add(node.loc.trim());
  if (Array.isArray(node.loc)) {
    for (const loc of node.loc) if (typeof loc === "string") locs.add(loc.trim());
  }
  for (const value of Object.values(node)) {
    if (Array.isArray(value)) value.forEach((item) => collectXmlLocs(item, locs));
    else if (value && typeof value === "object") collectXmlLocs(value, locs);
  }
  return locs;
}

// The sitemap protocol caps files at 50 MB uncompressed; larger files are
// rejected by search engines, so they are reported instead of half-parsed.
const MAX_SITEMAP_BYTES = 50 * 1024 * 1024;

async function readSitemaps(origin: string, robotsSitemaps: string[], signal: AbortSignal) {
  const candidates = [...new Set([
    ...robotsSitemaps.map((item) => {
      try {
        return new URL(item, origin).toString();
      } catch {
        return item;
      }
    }),
    `${origin}/sitemap.xml`,
  ])];
  const parser = new XMLParser({ ignoreAttributes: false });
  const sitemaps = [];
  const urls = new Set<string>();
  const queue = [...candidates];
  const seen = new Set<string>();
  while (queue.length > 0 && sitemaps.length < 25 && !signal.aborted) {
    const sitemapUrl = queue.shift()!;
    if (seen.has(sitemapUrl)) continue;
    seen.add(sitemapUrl);
    try {
      const response = await fetchText(sitemapUrl, 30000, { signal, maxBytes: MAX_SITEMAP_BYTES });
      if (response.ok && response.truncated) {
        sitemaps.push({
          url: sitemapUrl,
          status: response.finalStatus,
          sourceStatus: response.status,
          redirectChain: response.redirectChain,
          ok: false,
          truncated: true,
          urlCount: 0,
          error: "Sitemap is larger than 50 MB uncompressed and was not parsed.",
        });
        continue;
      }
      if (!response.ok) {
        sitemaps.push({
          url: sitemapUrl,
          status: response.finalStatus,
          sourceStatus: response.status,
          redirectChain: response.redirectChain,
          ok: false,
          urlCount: 0,
        });
        continue;
      }
      const parsed = parser.parse(response.text);
      const nestedSitemaps = [...collectXmlLocs(parsed.sitemapindex || {})].filter((loc) => /^https?:\/\//i.test(loc));
      const urlLocs = [...collectXmlLocs(parsed.urlset || {})].filter((loc) => /^https?:\/\//i.test(loc));
      const fallbackLocs = !nestedSitemaps.length && !urlLocs.length ? [...collectXmlLocs(parsed)].filter(Boolean) : [];
      for (const nested of nestedSitemaps) {
        if (!seen.has(nested) && queue.length + sitemaps.length < 25) queue.push(nested);
      }
      for (const loc of [...urlLocs, ...fallbackLocs]) {
        if (/^https?:\/\//i.test(loc)) urls.add(loc);
      }
      sitemaps.push({
        url: sitemapUrl,
        status: response.finalStatus,
        sourceStatus: response.status,
        redirectChain: response.redirectChain,
        ok: true,
        type: nestedSitemaps.length ? "index" : "urlset",
        urlCount: urlLocs.length || fallbackLocs.length,
        childSitemapCount: nestedSitemaps.length,
      });
    } catch (error) {
      sitemaps.push({
        url: sitemapUrl,
        status: null,
        ok: false,
        urlCount: 0,
        error: error instanceof Error ? error.message : "Could not parse sitemap",
      });
    }
  }
  return { sitemaps, urls: [...urls] };
}

// Summary fields derived from open issues only. Ignore rules recompute these
// on read; crawl-derived fields stay as saved.
function issueSummary(issues: any[]) {
  const byCategory = issues.reduce<Record<string, number>>((acc, issue) => {
    acc[issue.category] = (acc[issue.category] || 0) + 1;
    return acc;
  }, {});
  const countType = (...types: string[]) => issues.filter((issue) => types.includes(issue.type)).length;
  const countCategory = (...categories: string[]) => issues.filter((issue) => categories.includes(issue.category)).length;
  return {
    openIssues: issues.length,
    bySeverity: severityCounts(issues),
    byCategory,
    thinPages: countType("thin-content"),
    noH1Pages: issues.filter((issue) => issue.type === "h1-count" && /Missing H1/i.test(issue.message)).length,
    duplicateH1Pages: countType("duplicate-h1"),
    duplicateContentPages: countType("duplicate-content"),
    orphanPages: countType("orphan-page"),
    deepPages: countType("crawl-depth-deep"),
    pagesMissingFromSitemap: countType("page-missing-from-sitemap"),
    noindexPagesInSitemap: countType("noindex-page-in-sitemap"),
    largeImages: countType("large-image"),
    imageExtensionMismatches: countType("image-extension-mismatch"),
    largeAssets: countType("large-css", "large-javascript"),
    renderBlockingScripts: countType("render-blocking-javascript"),
    emptyAnchorLinks: countType("empty-anchor-text"),
    internalNofollowLinks: countType("internal-nofollow"),
    imagesMissingDimensions: countType("image-dimensions-missing"),
    imagesMissingSrcset: countType("image-srcset-missing"),
    imagesMissingLazyLoading: countType("image-lazy-loading-missing"),
    imageIssues: countCategory("images"),
    assetIssues: countCategory("assets"),
    metadataIssues: countCategory("metadata"),
    duplicateIssues: issues.filter((issue) => issue.type.startsWith("duplicate-")).length,
    missingTitles: countType("title-missing"),
    titleLengthIssues: countType("title-length"),
    missingDescriptions: countType("description-missing"),
    descriptionLengthIssues: countType("description-length"),
    missingAlt: countType("image-alt-missing", "image-alt-empty"),
    genericAlt: countType("image-alt-generic"),
    longAlt: countType("image-alt-too-long"),
    schemaIssues: countCategory("structured-data"),
    socialIssues: countCategory("social"),
    securityIssues: countCategory("security"),
    performanceIssues: countCategory("performance", "assets"),
  };
}

function scanSummary(input: {
  issues: any[];
  pages: any[];
  checkedLinks: any[];
  checkedImages: any[];
  checkedAssets: any[];
  imageInventory: any[];
  parameterUrlCount: number;
  parameterUrlTargetCount: number;
  robotsSkippedCount: number;
  phase: string;
  partial?: boolean;
}) {
  const { pages, checkedLinks, checkedImages, checkedAssets, imageInventory } = input;
  // Link counts come from every crawled page, not the capped link inventory.
  const internalLinks = pages.reduce((total, page) => total + Number(page.internalLinks || 0), 0);
  const externalLinks = pages.reduce((total, page) => total + Number(page.externalLinks || 0), 0);
  const pageLoadTimes = pages
    .map((page) => Number(page.loadMs))
    .filter((value) => Number.isFinite(value) && value >= 0)
    .sort((a, b) => a - b);
  const loadPercentile = (percentile: number) => {
    if (!pageLoadTimes.length) return 0;
    const index = Math.min(pageLoadTimes.length - 1, Math.max(0, Math.ceil((percentile / 100) * pageLoadTimes.length) - 1));
    return pageLoadTimes[index] || 0;
  };
  const averagePageLoadMs = pageLoadTimes.length
    ? Math.round(pageLoadTimes.reduce((sum, value) => sum + value, 0) / pageLoadTimes.length)
    : 0;
  const redirectingLinks = checkedLinks.filter(
    (link) => link.redirected || (link.finalUrl && link.finalUrl !== link.url),
  );
  const redirectingLinkPages = new Set(
    redirectingLinks.flatMap((link) =>
      Array.isArray(link.sourcePages) && link.sourcePages.length ? link.sourcePages : link.from ? [link.from] : [],
    ),
  );
  const unverified = (rows: any[]) => rows.filter((row) => row.ok === false && row.failureKind === "tls-certificate").length;
  const broken = (rows: any[]) => rows.filter((row) => !row.ok && row.failureKind !== "tls-certificate").length;
  return {
    phase: input.phase,
    // A cancelled scan's counts and score cover only the pages it crawled.
    ...(input.partial ? { partial: true } : {}),
    pages: pages.length,
    failedPages: pages.filter((page) => page.error).length,
    measuredPageLoads: pageLoadTimes.length,
    averagePageLoadMs,
    medianPageLoadMs: loadPercentile(50),
    p95PageLoadMs: loadPercentile(95),
    slowestPageLoadMs: pageLoadTimes[pageLoadTimes.length - 1] || 0,
    slowPages: pageLoadTimes.filter((value) => value > 2000).length,
    verySlowPages: pageLoadTimes.filter((value) => value > 4000).length,
    indexabilityKnownPages: pages.filter((page) => typeof page.indexable === "boolean").length,
    indexablePages: pages.filter((page) => page.indexable === true).length,
    nonIndexablePages: pages.filter((page) => page.indexable === false).length,
    unknownIndexabilityPages: pages.filter((page) => typeof page.indexable !== "boolean").length,
    sitemapUrls: [...new Set(pages.flatMap((page) => page.sitemapListed ? [page.url] : []))].length,
    checkedLinks: checkedLinks.length,
    brokenLinks: broken(checkedLinks),
    unverifiedLinks: unverified(checkedLinks),
    checkedImages: checkedImages.length,
    brokenImages: broken(checkedImages),
    unverifiedImages: unverified(checkedImages),
    redirectedImages: checkedImages.filter((image) => image.redirected || (image.finalUrl && image.finalUrl !== image.url)).length,
    cssImageResources: checkedImages.filter((image) => image.purpose === "css-url" || image.purpose === "external-css-url").length,
    pictureSourceImages: checkedImages.filter((image) => image.purpose === "picture-source" || image.purpose === "source-srcset").length,
    checkedAssets: checkedAssets.length,
    brokenAssets: broken(checkedAssets),
    unverifiedAssets: unverified(checkedAssets),
    redirectedLinks: redirectingLinks.length,
    redirectedLinkTargets: redirectingLinks.length,
    redirectedLinkPages: redirectingLinkPages.size,
    redirectedLinkReferences: redirectingLinks.reduce(
      (total, link) => total + Math.max(1, Number(link.referenceCount || 0)),
      0,
    ),
    linkTags: internalLinks + externalLinks,
    internalLinks,
    externalLinks,
    parameterUrls: input.parameterUrlCount,
    parameterUrlTargets: input.parameterUrlTargetCount,
    // URLs not requested because robots.txt disallows them for LocalSEO.
    robotsSkipped: input.robotsSkippedCount,
    imageTags: imageInventory.length,
    imageTagsWithIssues: imageInventory.filter((image) => image.issues?.length).length,
    ...issueSummary(input.issues),
  };
}

// Stored evidence lists that can grow with site size keep a bounded sample
// plus the true count.
const MAX_STORED_SITEMAP_URLS = 1000;
const MAX_STORED_PARAMETER_URLS = 500;
const MAX_STORED_ROBOTS_SKIPPED = 500;

function scanResult(input: {
  startUrl: string;
  origin: string;
  phase: string;
  progress: Record<string, unknown>;
  pages: any[];
  issues: any[];
  checkedLinks: any[];
  checkedImages: any[];
  checkedAssets: any[];
  imageInventory: any[];
  linkInventory: any[];
  pageLinks: { links: any[]; pages: Record<string, number[]> };
  parameterUrls: any[];
  parameterUrlCount: number;
  parameterUrlTargetCount: number;
  robots: any;
  robotsSkipped: { count: number; urls: any[] };
  sitemap: any;
  softNotFound: any;
  limits: ScanLimits;
  partial?: boolean;
  comparison?: any;
}) {
  const sortedIssues = [...input.issues].sort((a, b) => issuePriority(b.severity) - issuePriority(a.severity));
  const sitemapUrls: string[] = Array.isArray(input.sitemap?.urls) ? input.sitemap.urls : [];
  return {
    scanVersion: SCAN_RESULT_VERSION,
    startUrl: input.startUrl,
    origin: input.origin,
    phase: input.phase,
    limits: input.limits,
    progress: input.progress,
    summary: scanSummary({ ...input, robotsSkippedCount: input.robotsSkipped.count, issues: sortedIssues }),
    robots: input.robots,
    robotsSkipped: input.robotsSkipped,
    sitemap: {
      ...input.sitemap,
      urls: sitemapUrls.slice(0, MAX_STORED_SITEMAP_URLS),
      urlCount: sitemapUrls.length,
    },
    ...(input.softNotFound ? { softNotFound: input.softNotFound } : {}),
    pages: input.pages,
    issues: sortedIssues,
    issueGroups: groupIssueSummary(sortedIssues),
    links: input.checkedLinks,
    linkInventory: input.linkInventory,
    pageLinks: input.pageLinks,
    images: input.checkedImages,
    imageInventory: input.imageInventory,
    assets: input.checkedAssets,
    parameterUrls: input.parameterUrls.slice(0, MAX_STORED_PARAMETER_URLS),
    ...(input.comparison ? { comparison: input.comparison } : {}),
  };
}

// Status, counts, and the small list summary (summary_json) of a scan. The
// result only needs summary, pages, and issues here (ignore rules adjust the
// stored summary and score).
function saveScanSummary(scanId: string, siteId: string, status: string, score: number, result: any) {
  const publicRow = applyIssueIgnores(
    { status, score, issue_count: result.issues.length, site_id: siteId, result },
    siteIgnoreRules(siteId),
  );
  run(
    `
    UPDATE scans
    SET status = ?,
        score = ?,
        pages_crawled = ?,
        issue_count = ?,
        summary_json = ?,
        updated_at = CURRENT_TIMESTAMP
    WHERE id = ?
    `,
    [status, score, result.pages.length, result.issues.length, storedScanSummary(publicRow), scanId],
  );
}

// The full result plus the scans row, written together (nothing when the
// scan was deleted meanwhile).
function saveScanResult(scanId: string, siteId: string, status: string, score: number, result: any) {
  transaction(() => {
    if (!get("SELECT 1 FROM scans WHERE id = ?", [scanId])) return;
    run(
      "INSERT INTO scan_results (scan_id, result_json) VALUES (?, ?) ON CONFLICT(scan_id) DO UPDATE SET result_json = excluded.result_json",
      [scanId, JSON.stringify(result)],
    );
    saveScanSummary(scanId, siteId, status, score, result);
  });
}

// Effective robots directives for a Google-style crawler: generic rules plus
// googlebot-scoped ones. X-Robots-Tag values may carry a user-agent prefix
// ("googlebot: noindex", "otherbot: noindex, nofollow"); rules for other bots
// are ignored.
const robotsValueDirectives = new Set(["unavailable_after", "max-snippet", "max-image-preview", "max-video-preview"]);

export function robotsDirectives(metaContents: string[], xRobotsTag: string) {
  const directives: string[] = [];
  for (const content of metaContents) {
    for (const part of content.split(",")) {
      const directive = part.trim().toLowerCase();
      if (directive) directives.push(directive);
    }
  }
  let agent = "";
  for (const part of xRobotsTag.split(",")) {
    let directive = part.trim();
    const prefixed = /^([a-z0-9_.-]+)\s*:\s*(.*)$/i.exec(directive);
    if (prefixed && !robotsValueDirectives.has(prefixed[1].toLowerCase())) {
      agent = prefixed[1].toLowerCase();
      directive = prefixed[2];
    }
    directive = directive.trim().toLowerCase();
    if (directive && (!agent || agent === "googlebot")) directives.push(directive);
  }
  return directives;
}

// Post-crawl checks of the URLs crawled pages point at (canonicals, hreflang)
// and of sitemap entries. They only use responses the scan observed: crawled
// requests, checked links, crawled pages' final URLs, and URLs checked for
// these checks.
const MAX_STORED_HREFLANG = 50;
const MAX_URLS_PER_SITEMAP = 50_000;

function knownUrlResponses(crawledResources: Map<string, any>, checkedLinks: any[], pages: any[]) {
  const responses = new Map<string, any>(crawledResources);
  for (const link of checkedLinks) {
    if (!responses.has(link.url)) responses.set(link.url, link);
  }
  // A crawled page's final URL answered directly with the page's final status.
  for (const page of pages) {
    const finalUrl = page.finalUrl || page.url;
    if (typeof page.finalStatus === "number" && !page.redirectError && !responses.has(finalUrl)) {
      responses.set(finalUrl, { ok: page.finalStatus < 400, status: page.finalStatus, finalStatus: page.finalStatus, finalUrl, redirected: false, redirectChain: [] });
    }
  }
  return responses;
}

// Certificate failures are unverified, not broken (as in the link checks), so
// they never count as evidence against a URL here.
function observedResponse(responses: Map<string, any>, url: string) {
  const response = responses.get(url);
  return response && response.failureKind !== "tls-certificate" ? response : null;
}

// Audited HTML page rows by the URL that served them.
function htmlPagesByFinalUrl(pages: any[]) {
  return new Map<string, any>(pages.filter((page) => page.isHtml).map((page) => [page.finalUrl || page.url, page]));
}

function isSelfUrl(value: string, page: any) {
  return normalizedUrl(value) === normalizedUrl(page.finalUrl || page.url);
}

// The canonical of an audited page when it names another URL. A canonical
// naming a hop of the page's own redirect is reported as
// canonical-points-to-redirect instead.
function canonicalTargetUrl(page: any) {
  const canonical = String(page.canonical || "");
  if (!page.isHtml || Number(page.finalStatus) >= 400 || !/^https?:\/\//i.test(canonical) || isSelfUrl(canonical, page)) return "";
  if ((page.redirectChain || []).some((hop: any) => normalizedUrl(hop.url) === normalizedUrl(canonical))) return "";
  return canonical;
}

function responseEvidence(response: any) {
  return {
    status: response.status,
    finalStatus: response.finalStatus,
    finalUrl: response.finalUrl,
    ...(response.redirectChain?.length ? { redirectChain: response.redirectChain } : {}),
    ...(response.error ? { error: response.error, failureKind: response.failureKind } : {}),
  };
}

function pushCanonicalTargetIssues(issues: any[], pages: any[], responses: Map<string, any>, pagesByFinalUrl: Map<string, any>) {
  for (const page of pages) {
    const canonical = canonicalTargetUrl(page);
    const response = canonical ? observedResponse(responses, canonical) : null;
    if (!response) continue;
    const evidence = { canonical, ...responseEvidence(response) };
    if (!response.ok) {
      pushScanIssue(issues, {
        url: page.url,
        severity: "high",
        category: "canonicals",
        type: "canonical-target-error",
        message: response.finalStatus ? `Canonical URL returns HTTP ${response.finalStatus}` : "Canonical URL could not be loaded",
        recommendation: "Point the canonical at a live, indexable URL.",
        evidence,
      });
      continue;
    }
    if (response.redirected) {
      pushScanIssue(issues, {
        url: page.url,
        severity: "medium",
        category: "canonicals",
        type: "canonical-target-redirect",
        message: `Canonical URL redirects with HTTP ${response.status}`,
        recommendation: "Point the canonical directly at the final URL the redirect lands on.",
        evidence,
      });
      continue;
    }
    const target = pagesByFinalUrl.get(response.finalUrl);
    if (!target) continue;
    if (target.indexabilityReason === "noindex") {
      pushScanIssue(issues, {
        url: page.url,
        severity: "high",
        category: "canonicals",
        type: "canonical-target-noindex",
        message: "Canonical URL is marked noindex",
        recommendation: "Canonicalize to an indexable page, or remove noindex from the canonical URL.",
        evidence: { ...evidence, robotsMeta: target.robotsMeta, xRobotsTag: target.xRobotsTag },
      });
    }
    const targetCanonical = canonicalTargetUrl(target);
    if (targetCanonical) {
      pushScanIssue(issues, {
        url: page.url,
        severity: "medium",
        category: "canonicals",
        type: "canonical-chain",
        message: "Canonical URL canonicalizes to another URL",
        recommendation: "Point the canonical directly at the final preferred URL.",
        evidence: { ...evidence, targetCanonical },
      });
    }
  }
}

// Fills each page's hreflang rows with the alternate's status and whether a
// crawled alternate links back, then reports failing and one-way alternates.
function pushHreflangIssues(
  issues: any[],
  pages: any[],
  hreflangByPage: Map<string, { lang: string; href: string }[]>,
  responses: Map<string, any>,
  pagesByFinalUrl: Map<string, any>,
) {
  for (const page of pages) {
    const entries = hreflangByPage.get(page.url) || [];
    if (!entries.length) continue;
    const failing: any[] = [];
    const missingReturn: any[] = [];
    const rows = entries.map((entry) => {
      const response = observedResponse(responses, entry.href);
      const target = response?.ok && !response.redirected ? pagesByFinalUrl.get(response.finalUrl) : undefined;
      const returnLink = target ? (hreflangByPage.get(target.url) || []).some((link) => isSelfUrl(link.href, page)) : null;
      if (response && (!response.ok || response.redirected || response.status !== 200)) {
        failing.push({ ...entry, ...responseEvidence(response) });
      }
      if (returnLink === false) missingReturn.push(entry);
      return { lang: entry.lang, href: entry.href, targetStatus: response?.status ?? null, returnLink };
    });
    page.hreflang = rows.slice(0, MAX_STORED_HREFLANG);
    if (failing.length) {
      pushScanIssue(issues, {
        url: page.url,
        severity: "medium",
        category: "localization",
        type: "hreflang-target-error",
        message: `${failing.length} hreflang URLs do not answer HTTP 200 directly`,
        recommendation: "Point hreflang links at the final 200 URL of each language version.",
        evidence: { count: failing.length, targets: failing.slice(0, 20) },
      });
    }
    if (missingReturn.length) {
      pushScanIssue(issues, {
        url: page.url,
        severity: "medium",
        category: "localization",
        type: "hreflang-missing-return",
        message: `${missingReturn.length} hreflang alternates do not link back to this page`,
        recommendation: "Add a matching hreflang link back to this page on every alternate page.",
        evidence: { count: missingReturn.length, targets: missingReturn.slice(0, 20) },
      });
    }
  }
}

// Same-site sitemap entries with direct evidence: URLs the scan requested or
// checked, plus entries naming a crawled page under another spelling (those
// are checked so their own response is known). Nothing is inferred.
function sitemapEntriesToAudit(sitemapUrls: string[], pages: any[], responses: Map<string, any>, startUrl: string) {
  const pageKeys = new Set(
    pages.flatMap((page) => [page.url, page.finalUrl, page.requestedUrl].filter(Boolean).map((url: string) => normalizedUrlKey(url))),
  );
  return [...new Set(sitemapUrls)].filter(
    (url) => sameSiteUrl(url, startUrl) && (responses.has(url) || pageKeys.has(normalizedUrlKey(url))),
  );
}

function pushSitemapUrlIssues(issues: any[], sitemapUrls: string[], responses: Map<string, any>, pagesByFinalUrl: Map<string, any>) {
  for (const url of sitemapUrls) {
    const response = observedResponse(responses, url);
    if (!response) continue;
    const evidence = responseEvidence(response);
    if (!response.ok) {
      pushScanIssue(issues, {
        url,
        severity: "medium",
        category: "sitemap",
        type: "sitemap-url-error",
        message: response.finalStatus ? `Sitemap URL returns HTTP ${response.finalStatus}` : "Sitemap URL could not be loaded",
        recommendation: "Remove the entry, restore the page, or list its live replacement.",
        evidence,
      });
    } else if (response.redirected) {
      pushScanIssue(issues, {
        url,
        severity: "medium",
        category: "sitemap",
        type: "sitemap-url-redirect",
        message: `Sitemap URL redirects with HTTP ${response.status}`,
        recommendation: "List the final URL in the sitemap instead of the redirecting one.",
        evidence,
      });
    } else {
      const page = pagesByFinalUrl.get(response.finalUrl);
      const canonical = page ? canonicalTargetUrl(page) : "";
      if (canonical) {
        pushScanIssue(issues, {
          url,
          severity: "medium",
          category: "sitemap",
          type: "sitemap-url-canonicalized",
          message: "Sitemap URL canonicalizes to another URL",
          recommendation: "List only canonical URLs in the sitemap.",
          evidence: { ...evidence, canonical },
        });
      }
    }
  }
}

// Pairs of indexable pages whose main-text simhashes differ in at most
// NEAR_DUPLICATE_MAX_DISTANCE bits. Exact duplicates are reported as
// duplicate-content instead. Pairwise popcounts stay cheap at 1,000 pages.
function pushNearDuplicateIssues(issues: any[], pages: any[]) {
  const candidates = pages.filter((page) => page.indexable && page.contentSimhash);
  const hashes = candidates.map((page) => [
    Number.parseInt(page.contentSimhash.slice(0, 8), 16),
    Number.parseInt(page.contentSimhash.slice(8), 16),
  ]);
  const exactDuplicates = (a: any, b: any) =>
    a.contentFingerprint && a.contentFingerprint === b.contentFingerprint && a.wordCount >= 120 && b.wordCount >= 120;
  const matches = candidates.map(() => [] as { url: string; similarity: number }[]);
  for (let a = 0; a < candidates.length; a += 1) {
    for (let b = a + 1; b < candidates.length; b += 1) {
      const distance = bitCount32(hashes[a][0] ^ hashes[b][0]) + bitCount32(hashes[a][1] ^ hashes[b][1]);
      if (distance > NEAR_DUPLICATE_MAX_DISTANCE || exactDuplicates(candidates[a], candidates[b])) continue;
      const similarity = Math.round(((64 - distance) / 64) * 1000) / 1000;
      matches[a].push({ url: candidates[b].url, similarity });
      matches[b].push({ url: candidates[a].url, similarity });
    }
  }
  for (const [index, page] of candidates.entries()) {
    const duplicates = matches[index].sort((a, b) => b.similarity - a.similarity);
    if (!duplicates.length) continue;
    page.nearDuplicates = duplicates.slice(0, 20);
    pushScanIssue(issues, {
      url: page.url,
      severity: "medium",
      category: "content",
      type: "near-duplicate-content",
      message: `Main text is nearly identical to ${duplicates.length} other page${duplicates.length === 1 ? "" : "s"}`,
      recommendation: "Differentiate the pages, or consolidate them and canonicalize to one URL.",
      evidence: { duplicateCount: duplicates.length, duplicates: page.nearDuplicates },
    });
  }
}

// Googlebot's view, whatever the crawler fetched: crawled pages Googlebot may
// not crawl, page URLs the crawler skipped (robots.txt disallows them for
// LocalSEO too, so they have no page row), and blocked sitemap entries.
function pushRobotsBlockedIssues(
  issues: any[],
  pages: any[],
  skippedPageUrls: string[],
  sitemapUrls: string[],
  robotsCheck: (url: string) => RobotsVerdict | null,
  robotsUrl: string,
) {
  const verdictEvidence = (verdict: RobotsVerdict) => ({ rule: verdict.matchedRule, userAgentGroup: verdict.userAgentGroup, robotsUrl });
  const blockedPages = [
    ...pages.flatMap((page) => (page.robotsBlocked ? [{ url: page.url, crawled: true }] : [])),
    ...skippedPageUrls.map((url) => ({ url, crawled: false })),
  ];
  for (const { url, crawled } of blockedPages) {
    const verdict = robotsCheck(url);
    if (!verdict || verdict.allowed) continue;
    pushScanIssue(issues, {
      url,
      severity: "medium",
      category: "robots",
      type: "robots-blocked-page",
      message: "robots.txt disallows this URL for Googlebot",
      recommendation: "Narrow or remove the Disallow rule if the page should be crawled; use noindex, not robots.txt, to keep a page out of search.",
      evidence: { ...verdictEvidence(verdict), ...(crawled ? {} : { crawled: false }) },
    });
  }
  // Every sitemap entry is checked; issues keep a bounded sample plus the count.
  const blocked = [...new Set(sitemapUrls)].flatMap((url) => {
    const verdict = robotsCheck(url);
    return verdict && !verdict.allowed ? [{ url, verdict }] : [];
  });
  for (const { url, verdict } of blocked.slice(0, MAX_STORED_SITEMAP_URLS)) {
    pushScanIssue(issues, {
      url,
      severity: "medium",
      category: "robots",
      type: "robots-blocked-in-sitemap",
      message: "Sitemap lists a URL that robots.txt disallows for Googlebot",
      recommendation: "Remove blocked URLs from the sitemap, or allow them in robots.txt.",
      evidence: { ...verdictEvidence(verdict), blockedSitemapUrls: blocked.length },
    });
  }
}

async function runLocalScan(scanId: string, signal: AbortSignal) {
  const scan = get<any>("SELECT * FROM scans WHERE id = ?", [scanId]);
  if (!scan || signal.aborted) return;
  run("UPDATE scans SET status = 'running', updated_at = CURRENT_TIMESTAMP WHERE id = ?", [
    scanId,
  ]);
  const startUrl = /^https?:\/\//i.test(scan.url) ? scan.url : `https://${scan.url}`;
  const origin = new URL(startUrl).origin;
  const site = getSite(scan.site_id);
  const siteSpeed = site?.crawl_speed === "polite" || site?.crawl_speed === "fast" ? site.crawl_speed : "";
  const defaultSpeed = getConfigValue("default_crawl_speed") === "fast" ? "fast" : "polite";
  const crawlSpeed = siteSpeed || defaultSpeed;
  const siteMaxPages = Math.round(Number(site?.crawl_max_pages || 0));
  const defaultMaxPages = Math.round(Number(getConfigValue("default_crawl_max_pages") || 0));
  const maxPages = Math.max(10, Math.min(1000, siteMaxPages > 0 ? siteMaxPages : defaultMaxPages > 0 ? defaultMaxPages : scanLimits.maxPages));
  const robotsMode = crawlRobotsMode(site?.crawl_robots);
  const limits = scanLimitsFor(maxPages, robotsMode);
  // Pacing only matters against real remote hosts; localhost targets crawl at full speed.
  const politeTarget = crawlSpeed === "polite" && !localHostFirst(new URL(startUrl).hostname);
  const localTarget = localHostFirst(new URL(startUrl).hostname);
  // Polite crawls of remote sites fetch one page at a time with a delay; fast
  // crawls and local hosts keep a few page requests in flight.
  const pageConcurrency = politeTarget ? 1 : PAGE_FETCH_CONCURRENCY;
  let pageDelayMs = 400;
  let consecutiveRateLimits = 0;
  const startKey = normalizedUrlKey(startUrl);
  const visited = new Set<string>();
  const processedContent = new Set<string>();
  // Crawl outward from the start URL by links first. Sitemap URLs are only
  // pulled when the link queue drains and no page in flight can add links,
  // so a large sitemap cannot use up the page budget before link-discovered
  // pages are reached.
  const queued = new Set<string>([startKey]);
  const linkQueue = [startUrl];
  const sitemapTargets: { url: string; key: string }[] = [];
  let sitemapCursor = 0;
  // The internal link graph, for link depth (the shortest link path from the
  // start URL, settled once every page is in): link target keys per crawled
  // page key, and requested keys that redirected to another page key. Pages
  // reached only through the sitemap have no link depth.
  const linkTargetsByKey = new Map<string, string[]>();
  const redirectedKeys = new Map<string, string>();
  // Final responses of crawled pages by exact URL: a redirect landing on one
  // of them reuses it instead of downloading the page again.
  const crawledPageResponses = new Map<string, KnownResponse>();
  // Crawl order of each page row (fetches finish out of order).
  const pageOrder = new Map<any, number>();
  const discoveryByUrl = new Map<string, string>([[startKey, "start-url"]]);
  const internalInlinks = new Map<string, number>();
  // Responses the crawl already fetched, keyed by exact URL, so link and
  // resource checks reuse them instead of requesting the same URL again.
  const crawledResources = new Map<string, any>();
  const pages: any[] = [];
  const issues: any[] = [];
  const checkedLinks: any[] = [];
  const checkedImages: any[] = [];
  const checkedAssets: any[] = [];
  const imageInventory: any[] = [];
  const linkInventory: any[] = [];
  // Every page's outlinks for the page drawer: each distinct link once in
  // `links`, and per page URL the indexes of its links (see addPageLink).
  const pageLinks = { links: [] as any[], pages: {} as Record<string, number[]> };
  const pageLinkIndexes = new Map<string, number>();
  const parameterUrls: any[] = [];
  const parameterUrlKeys = new Set<string>();
  const parameterTargetKeys = new Set<string>();
  const linksToCheck = new Map<string, any>();
  const imagesToCheck = new Map<string, any>();
  const assetsToCheck = new Map<string, any>();
  let phase = "starting";
  let robots: any = { exists: false, sitemaps: [] };
  let sitemap: any = { sitemaps: [], urls: [] };
  let sitemapUrlSet = new Set<string>();
  let softNotFound: any = null;
  // Googlebot verdicts for URLs on the robots.txt origin, set once robots.txt
  // answered with rules (2xx) or with a status that means "no rules".
  let robotsVerdictFor: ((url: string) => RobotsVerdict) | null = null;
  const robotsVerdicts = new Map<string, RobotsVerdict | null>();
  const robotsCheck = (url: string) => {
    if (!robotsVerdictFor) return null;
    if (!robotsVerdicts.has(url)) {
      let sameOrigin = false;
      try {
        sameOrigin = new URL(url).origin === origin;
      } catch {
        sameOrigin = false;
      }
      robotsVerdicts.set(url, sameOrigin ? robotsVerdictFor(url) : null);
    }
    return robotsVerdicts.get(url) ?? null;
  };
  // The crawler's own robots.txt gate (the LocalSEO group, else `*`), set
  // once robots.txt is read; the site's other origins (www, http) are read on
  // first use. A URL it disallows is never requested: it is recorded once in
  // robotsSkipped instead and does not use the page budget.
  let crawlBlocked: (url: string) => Promise<RobotsBlock | null> = async () => null;
  const robotsSkipped = { count: 0, urls: [] as any[] };
  const robotsSkippedUrls = new Set<string>();
  // The site's other origins whose robots.txt could not be read, each
  // reported once (the start origin's is reported before the crawl).
  const unavailableRobotsUrls = new Set<string>();
  const skipBlocked: RobotsSkipCheck = async (url, source, from) => {
    const block = await crawlBlocked(url);
    if (!block || robotsSkippedUrls.has(url)) return block;
    robotsSkippedUrls.add(url);
    robotsSkipped.count += 1;
    if (!block.rule && block.robotsUrl !== robots.url && !unavailableRobotsUrls.has(block.robotsUrl)) {
      unavailableRobotsUrls.add(block.robotsUrl);
      pushScanIssue(issues, {
        url: block.robotsUrl,
        severity: "high",
        category: "robots",
        type: "robots-unavailable",
        message: `robots.txt could not be read (${block.robotsStatus ? `HTTP ${block.robotsStatus}` : "no answer"}), so URLs on ${new URL(block.robotsUrl).origin} were not crawled`,
        recommendation: "Make /robots.txt answer 200 with your rules, or 404 if there are none, then rescan.",
        evidence: { status: block.robotsStatus, error: block.robotsError, robotsMode, firstSkippedUrl: url },
      });
    }
    if (robotsSkipped.urls.length < MAX_STORED_ROBOTS_SKIPPED) {
      robotsSkipped.urls.push({
        url,
        rule: block.rule,
        userAgentGroup: block.userAgentGroup,
        source,
        ...(from ? { from } : {}),
        robotsUrl: block.robotsUrl,
        ...(block.robotsStatus !== undefined ? { robotsStatus: block.robotsStatus } : {}),
        ...(block.robotsError ? { robotsError: block.robotsError } : {}),
      });
    }
    return block;
  };
  // A redirect hop from `from` to a disallowed URL stops there.
  const skipRedirectFrom = (from: string) => async (url: string) => Boolean(await skipBlocked(url, "redirect", from));
  // Page URLs the crawl skipped, for Googlebot's robots-blocked-page check.
  const skippedPageUrls: string[] = [];
  const skippedPageKeys = new Set<string>();
  // The first crawled page linking to each page URL, as skip evidence.
  const linkedFrom = new Map<string, string>();
  // Every resolved hreflang alternate per page URL; page rows keep a capped copy.
  const hreflangByPage = new Map<string, { lang: string; href: string }[]>();
  const startedAtMs = Date.now();
  let progressUrl = startUrl;
  let pendingChecks = 0;
  const inFlight = new Set<Promise<void>>();
  let lastSummarySaveAt = 0;
  let lastResultSaveAt = 0;
  let savedResultSignature = "";
  let crawlSettled = false;

  // Page drawer outlinks: at most MAX_OUTLINKS_PER_PAGE per page and a bounded
  // number of distinct links overall; getScanPage reports truncation from the
  // page's own link counts.
  const maxDistinctPageLinks = limits.maxLinkInventory * 2;
  const addPageLink = (pageUrl: string, row: any) => {
    const indexes = (pageLinks.pages[pageUrl] ||= []);
    if (indexes.length >= MAX_OUTLINKS_PER_PAGE) return;
    const key = JSON.stringify([row.href, row.anchor, row.accessibleName, row.rel, row.target, row.type]);
    let index = pageLinkIndexes.get(key);
    if (index === undefined) {
      if (pageLinks.links.length >= maxDistinctPageLinks) return;
      index = pageLinks.links.length;
      pageLinkIndexes.set(key, index);
      const { from: _from, ...link } = row;
      pageLinks.links.push(link);
    }
    indexes.push(index);
  };

  const recordRedirectIssues = (url: string, response: any) => {
    if (response.redirected) {
      const temporaryRedirect = response.status === 302 || response.status === 307;
      pushScanIssue(issues, {
        url,
        severity: "low",
        category: "crawl",
        type: temporaryRedirect ? "temporary-redirect" : "redirected-url",
        message: temporaryRedirect
          ? `URL uses a temporary HTTP ${response.status} redirect`
          : `URL redirects with HTTP ${response.status}`,
        recommendation: temporaryRedirect
          ? "Use 301 or 308 when the move is permanent; keep the temporary redirect only when the original URL will return."
          : "Link directly to the final URL to reduce crawl waste and latency.",
        evidence: {
          status: response.status,
          finalStatus: response.finalStatus,
          finalUrl: response.url,
          redirectChain: response.redirectChain,
        },
      });
    }
    if (response.redirectChain.length > 1 && !response.redirectLoop) {
      pushScanIssue(issues, {
        url,
        severity: "medium",
        category: "crawl",
        type: "redirect-chain",
        message: `URL follows a ${response.redirectChain.length}-hop redirect chain`,
        recommendation: "Redirect directly to the final destination in one hop.",
        evidence: { finalUrl: response.url, redirectChain: response.redirectChain },
      });
    }
    if (response.redirectLoop) {
      pushScanIssue(issues, {
        url,
        severity: "high",
        category: "crawl",
        type: "redirect-loop",
        message: "URL is trapped in a redirect loop",
        recommendation: "Break the redirect cycle so the URL resolves to one final response.",
        evidence: { redirectChain: response.redirectChain, error: response.redirectError },
      });
    } else if (response.redirectError) {
      pushScanIssue(issues, {
        url,
        severity: "high",
        category: "crawl",
        type: "redirect-failed",
        message: response.redirectError,
        recommendation: "Fix the redirect location or shorten the chain so the URL reaches a final response.",
        evidence: { redirectChain: response.redirectChain, error: response.redirectError },
      });
    }
  };

  const addParameterUrl = (url: string, source: string, from?: string, crawlUrl?: string) => {
    if (!hasQueryParams(url)) return;
    const key = normalizedUrlKey(url);
    if (parameterUrlKeys.has(key)) return;
    parameterUrlKeys.add(key);
    const target = crawlUrl || withoutQueryUrl(url);
    parameterTargetKeys.add(target);
    // Counts cover every variant; only a bounded sample of rows is kept.
    if (parameterUrls.length >= MAX_STORED_PARAMETER_URLS) return;
    try {
      const parsed = new URL(url);
      parameterUrls.push({
        url,
        from,
        source,
        path: `${parsed.origin}${parsed.pathname}`,
        query: parsed.search.replace(/^\?/, ""),
        crawlUrl: target,
      });
    } catch {
      parameterUrls.push({ url, from, source, crawlUrl: target });
    }
  };

  const progress = () => {
    const elapsedMs = Date.now() - startedAtMs;
    return {
      currentUrl: progressUrl,
      pagesCrawled: pages.length,
      queued: phase === "crawling" ? linkQueue.length + sitemapTargets.length - sitemapCursor : pendingChecks,
      startedAt: new Date(startedAtMs).toISOString(),
      elapsedMs,
      pagesPerSecond: elapsedMs > 0 ? Math.round((pages.length * 100_000) / elapsedMs) / 100 : 0,
      robotsSkipped: robotsSkipped.count,
      phase,
    };
  };

  const summaryInput = () => ({
    issues,
    pages,
    checkedLinks,
    checkedImages,
    checkedAssets,
    imageInventory,
    parameterUrlCount: parameterUrlKeys.size,
    parameterUrlTargetCount: parameterTargetKeys.size,
    robotsSkippedCount: robotsSkipped.count,
    phase,
  });

  const currentResult = (comparison?: any, partial = false) =>
    scanResult({
      ...summaryInput(),
      startUrl,
      origin,
      progress: progress(),
      linkInventory,
      pageLinks,
      parameterUrls,
      robots,
      robotsSkipped,
      sitemap,
      softNotFound,
      limits,
      partial,
      comparison,
    });

  // Progress saves. The scans row (status, counts, and the list summary with
  // live progress) is written at most once a second, and right away when the
  // phase changes. The full result serializes every page and issue, so it is
  // written at most every 10 seconds and at checkpoints (the end of the setup
  // and crawl phases), and only when it gained pages, issues, or checked
  // resources since the last write. Final saves (completed/cancelled) always
  // write everything.
  const persistProgress = (mode: "tick" | "phase" | "checkpoint" = "tick") => {
    if (signal.aborted) return;
    const now = Date.now();
    const signature = [pages.length, issues.length, checkedLinks.length, checkedImages.length, checkedAssets.length, robotsSkipped.count].join("|");
    if (signature !== savedResultSignature && (mode === "checkpoint" || now - lastResultSaveAt >= RESULT_SAVE_INTERVAL_MS)) {
      if (!crawlSettled) settlePages();
      saveScanResult(scanId, scan.site_id, "running", 0, currentResult());
      savedResultSignature = signature;
      lastResultSaveAt = now;
      lastSummarySaveAt = now;
      return;
    }
    if (mode === "tick" && now - lastSummarySaveAt < SUMMARY_SAVE_INTERVAL_MS) return;
    saveScanSummary(scanId, scan.site_id, "running", 0, {
      scanVersion: SCAN_RESULT_VERSION,
      startUrl,
      phase,
      limits,
      progress: progress(),
      summary: scanSummary(summaryInput()),
      pages,
      issues,
    });
    lastSummarySaveAt = now;
  };

  // Link depth: the shortest path from the start URL over every crawled
  // page's internal links, settled over the whole graph because pages finish
  // out of order (a shorter path can turn up after a page was processed). A
  // redirect gives its target the depth of the redirecting URL.
  const linkDepths = () => {
    const depths = new Map<string, number>([[startKey, 0]]);
    const queue = [startKey];
    const reach = (key: string, depth: number) => {
      if ((depths.get(key) ?? Number.POSITIVE_INFINITY) <= depth) return;
      depths.set(key, depth);
      queue.push(key);
    };
    for (let index = 0; index < queue.length; index += 1) {
      const key = queue[index];
      const depth = depths.get(key) as number;
      const redirected = redirectedKeys.get(key);
      if (redirected) reach(redirected, depth);
      for (const target of linkTargetsByKey.get(key) || []) reach(target, depth + 1);
    }
    return depths;
  };

  // Aggregate values (inlinks, depth, discovery) keep changing while the
  // crawl runs; settle them on every page row, in crawl order, before reporting.
  const settlePages = () => {
    const depths = linkDepths();
    pages.sort((a, b) => (pageOrder.get(a) ?? 0) - (pageOrder.get(b) ?? 0));
    for (const page of pages) {
      const keys = [page.url, page.finalUrl || page.url, page.requestedUrl || page.url].map(normalizedUrlKey);
      page.internalInlinks = Math.max(Number(page.internalInlinks || 0), ...keys.map((key) => internalInlinks.get(key) || 0));
      const pageDepths = keys.map((key) => depths.get(key)).filter((depth): depth is number => depth !== undefined);
      page.depth = pageDepths.length ? Math.min(...pageDepths) : null;
      page.discovery = keys.map((key) => discoveryByUrl.get(key)).find(Boolean) || page.discovery || "internal-link";
      page.sitemapListed = sitemapUrlSet.has(keys[0]) || sitemapUrlSet.has(keys[1]);
      page.sitemapSourceListed = keys[2] !== keys[0] && sitemapUrlSet.has(keys[2]);
      const robotsVerdict = robotsCheck(page.url);
      if (robotsVerdict) page.robotsBlocked = !robotsVerdict.allowed;
    }
  };

  // Once the crawl stops (done, at its limits, or cancelled), link depth is
  // final and deep HTML pages are flagged.
  const settleCrawl = () => {
    settlePages();
    if (crawlSettled) return;
    crawlSettled = true;
    for (const page of pages) {
      if (page.isHtml !== true || !(page.depth > 3)) continue;
      pushScanIssue(issues, {
        url: page.url,
        severity: "low",
        category: "crawl",
        type: "crawl-depth-deep",
        message: `Page is ${page.depth} clicks deep`,
        recommendation: "Important pages should usually be reachable within three clicks from crawl entry points.",
        evidence: { depth: page.depth, discovery: page.discovery },
      });
    }
  };

  // After a full crawl: sitemap pages the crawl never reached count as
  // sitemap.notCrawledCount, and those robots.txt disallows for the crawler
  // as sitemap.robotsBlockedCount. When the sitemap lists more crawlable pages
  // than the page limit, the rest were left out because of the limit.
  const pushSitemapCoverageIssue = async () => {
    const notCrawled = sitemapTargets.filter((target) => !visited.has(target.key) && !processedContent.has(target.key));
    let robotsBlockedCount = 0;
    for (const target of notCrawled) {
      if (skippedPageKeys.has(target.key) || (await crawlBlocked(target.url))) robotsBlockedCount += 1;
    }
    sitemap = { ...sitemap, notCrawledCount: notCrawled.length, robotsBlockedCount };
    const crawlableCount = sitemapTargets.length - robotsBlockedCount;
    const limitedCount = notCrawled.length - robotsBlockedCount;
    if (!limitedCount || crawlableCount <= limits.maxPages) return;
    pushScanIssue(issues, {
      url: `${origin}/sitemap.xml`,
      severity: "low",
      category: "sitemap",
      type: "sitemap-larger-than-crawl-limit",
      message: `${limitedCount} of ${crawlableCount} sitemap pages were not crawled because of the ${limits.maxPages}-page limit`,
      recommendation: "Raise the site's crawl page limit for a full-site run, or scan important sections separately.",
      evidence: {
        sitemapUrls: (sitemap.urls || []).length,
        sitemapPages: crawlableCount,
        notCrawled: limitedCount,
        robotsBlocked: robotsBlockedCount,
        pageLimit: limits.maxPages,
      },
    });
  };

  // Cancel keeps whatever evidence was gathered, scored on the pages crawled
  // (summary.partial), and stops the scan.
  const throwIfCancelled = () => {
    if (!signal.aborted) return;
    settleCrawl();
    saveScanResult(scanId, scan.site_id, "cancelled", healthScore(pages, issues), currentResult(undefined, true));
    throw new Error("Scan cancelled.");
  };

  const nextCrawlUrl = () => {
    const linked = linkQueue.shift();
    if (linked) return linked;
    // Pages still in flight may queue more links; those come first.
    if (inFlight.size) return null;
    while (sitemapCursor < sitemapTargets.length) {
      const target = sitemapTargets[sitemapCursor++];
      if (visited.has(target.key) || processedContent.has(target.key)) continue;
      if (!discoveryByUrl.has(target.key)) discoveryByUrl.set(target.key, "sitemap");
      return target.url;
    }
    return null;
  };

  phase = "robots";
  robots = await readRobots(origin, signal);
  throwIfCancelled();
  // A robots.txt answering 429/5xx or not at all: Google treats the whole
  // site as disallowed, so in "respect" mode nothing is crawled.
  const robotsUnavailable = !robots.exists && !robotsResponseAllowsAll(robots.status);
  if (!robotsUnavailable) {
    robotsVerdictFor = robotsMatcher(robots.groups || [], "Googlebot");
  }
  crawlBlocked = crawlRobotsGate({ mode: robotsMode, governs: (url) => sameSiteUrl(url, startUrl), files: [robots], signal });
  const robotsDelaySeconds = Number((robots as any).crawlDelaySeconds || 0);
  if (politeTarget && robotsDelaySeconds > 0) {
    pageDelayMs = Math.max(pageDelayMs, Math.min(robotsDelaySeconds * 1000, 10_000));
  }
  sitemap = await readSitemaps(origin, robots.sitemaps || [], signal);
  throwIfCancelled();
  sitemapUrlSet = new Set((sitemap.urls || []).map((url: string) => {
    const absolute = absoluteHttpUrl(String(url), origin);
    return absolute ? pageCrawlTarget(absolute, startKey)?.key || normalizedUrlKey(absolute) : normalizedUrlKey(url);
  }));
  const sitemapTargetKeys = new Set<string>();
  for (const sitemapUrl of sitemap.urls || []) {
    const absolute = absoluteHttpUrl(String(sitemapUrl), origin);
    const target = absolute ? pageCrawlTarget(absolute, startKey) : null;
    if (absolute && target?.parameterized) addParameterUrl(absolute, "sitemap", undefined, target.url);
    if (absolute && target && sameSiteUrl(absolute, startUrl) && !sitemapTargetKeys.has(target.key)) {
      sitemapTargetKeys.add(target.key);
      sitemapTargets.push(target);
    }
  }
  if (robotsUnavailable) {
    const answer = robots.status ? `HTTP ${robots.status}` : "no answer";
    pushScanIssue(issues, {
      url: robots.url,
      severity: "high",
      category: "robots",
      type: "robots-unavailable",
      message:
        robotsMode === "respect"
          ? `robots.txt could not be read (${answer}), so no page was crawled`
          : `robots.txt could not be read (${answer}), so Google treats the whole site as disallowed`,
      recommendation: "Make /robots.txt answer 200 with your rules, or 404 if there are none, then rescan.",
      evidence: { status: robots.status, error: robots.error, robotsMode },
    });
  } else if (!robots.exists) {
    pushScanIssue(issues, {
      url: `${origin}/robots.txt`,
      severity: "low",
      category: "robots",
      type: "robots-missing",
      message: "robots.txt was not found",
      recommendation: "Add robots.txt so crawlers can discover sitemap locations and crawl rules.",
      evidence: { status: robots.status, error: robots.error },
    });
  } else if (robots.blocksAll) {
    pushScanIssue(issues, {
      url: robots.url,
      severity: "high",
      category: "robots",
      type: "robots-blocks-all",
      message: "robots.txt contains Disallow: /",
      recommendation: "Remove the global block unless the entire site should be hidden from crawlers.",
      evidence: { disallowCount: robots.disallowCount },
    });
  }
  if (robots.exists && !(robots.sitemaps || []).length) {
    pushScanIssue(issues, {
      url: robots.url,
      severity: "low",
      category: "robots",
      type: "robots-sitemap-missing",
      message: "robots.txt does not declare a sitemap",
      recommendation: "Add a Sitemap directive to robots.txt so crawlers discover the preferred sitemap location quickly.",
      evidence: { disallowCount: robots.disallowCount },
    });
  }
  for (const item of sitemap.sitemaps || []) {
    if (item.truncated) {
      pushScanIssue(issues, {
        url: item.url,
        severity: "medium",
        category: "sitemap",
        type: "sitemap-too-large",
        message: "Sitemap is larger than 50 MB uncompressed",
        recommendation: "Split the sitemap into smaller files and list them in a sitemap index.",
        evidence: { status: item.status, error: item.error },
      });
    } else if (!item.ok) {
      pushScanIssue(issues, {
        url: item.url,
        severity: "medium",
        category: "sitemap",
        type: "sitemap-fetch-failed",
        message: "Sitemap URL could not be fetched or parsed",
        recommendation: "Fix the sitemap response, XML syntax, or robots.txt sitemap reference.",
        evidence: { status: item.status, error: item.error },
      });
    } else if (item.urlCount > MAX_URLS_PER_SITEMAP || item.childSitemapCount > MAX_URLS_PER_SITEMAP) {
      pushScanIssue(issues, {
        url: item.url,
        severity: "medium",
        category: "sitemap",
        type: "sitemap-too-many-urls",
        message: `Sitemap lists ${Math.max(item.urlCount, item.childSitemapCount || 0)} ${item.type === "index" ? "sitemaps" : "URLs"}, over the 50,000 limit`,
        recommendation: "Split the sitemap into files of up to 50,000 URLs and list them in a sitemap index.",
        evidence: { urlCount: item.urlCount, childSitemapCount: item.childSitemapCount, limit: MAX_URLS_PER_SITEMAP },
      });
    }
  }
  if (!sitemap.urls.length) {
    pushScanIssue(issues, {
      url: `${origin}/sitemap.xml`,
      severity: "medium",
      category: "sitemap",
      type: "sitemap-missing-or-empty",
      message: "No sitemap URLs were found",
      recommendation: "Publish an XML sitemap and reference it from robots.txt.",
      evidence: { sitemaps: sitemap.sitemaps },
    });
  }
  // A start URL the crawler may not request stops the scan here: no page, no
  // probe, and a site-level issue explaining why (an unreadable robots.txt
  // already has one).
  const startBlock = await skipBlocked(startUrl, "start-url");
  const crawlStopped = Boolean(startBlock);
  if (startBlock) {
    skippedPageKeys.add(startKey);
    skippedPageUrls.push(startUrl);
  }
  if (startBlock?.rule) {
    pushScanIssue(issues, {
      url: startUrl,
      severity: "high",
      category: "robots",
      type: "robots-blocks-start-url",
      message: `robots.txt disallows the start URL for ${CRAWLER_ROBOTS_AGENT}, so no page was crawled`,
      recommendation: `Allow the start URL for ${CRAWLER_ROBOTS_AGENT} in robots.txt, or set this site's robots.txt setting to Ignore to crawl disallowed URLs anyway.`,
      evidence: { rule: startBlock.rule, userAgentGroup: startBlock.userAgentGroup, robotsUrl: startBlock.robotsUrl, userAgent: CRAWLER_ROBOTS_AGENT },
    });
  }
  if (!crawlStopped) softNotFound = await probeSoftNotFound(origin, signal, skipBlocked);
  throwIfCancelled();
  if (softNotFound?.soft404) {
    pushScanIssue(issues, {
      url: softNotFound.probeUrl,
      severity: "medium",
      category: "crawl",
      type: "soft-404",
      message: `A URL that does not exist answers HTTP ${softNotFound.status}`,
      recommendation: "Return HTTP 404 or 410 for URLs that do not exist, instead of a 200 page or a redirect to one.",
      evidence: {
        status: softNotFound.status,
        sourceStatus: softNotFound.sourceStatus,
        finalUrl: softNotFound.finalUrl,
        redirectChain: softNotFound.redirectChain,
      },
    });
  }
  persistProgress("checkpoint");

  phase = "crawling";
  // One page: fetch it (retrying once after a 429/503), then audit it. The
  // audit after the fetch runs without awaiting, so pages in flight never
  // interleave their updates. Never rejects: request failures become
  // crawl-failed rows, and a response arriving after a cancel is dropped (the
  // cancel save already holds every processed page).
  const crawlPage = async (requestedUrl: string, requestedKey: string, order: number) => {
    let current = requestedUrl;
    let currentKey = requestedKey;
    const pushPage = (page: any) => {
      pageOrder.set(page, order);
      pages.push(page);
    };
    const fetchPage = () =>
      fetchText(requestedUrl, 15000, {
        signal,
        knownResponse: (url) => crawledPageResponses.get(url),
        skipRedirect: skipRedirectFrom(requestedUrl),
      });

    try {
      // loadMs times the request itself: sleeps and queue waits are excluded.
      let startedAt = Date.now();
      let response = await fetchPage();
      let loadMs = Date.now() - startedAt;
      if (response.finalStatus === 429 || response.finalStatus === 503) {
        // Back off once, honoring Retry-After, before recording the response.
        const retrySeconds = Math.min(Math.max(Number(response.retryAfter) || 5, 1), 30);
        await sleep(retrySeconds * 1000, signal);
        if (signal.aborted) return;
        startedAt = Date.now();
        response = await fetchPage();
        loadMs = Date.now() - startedAt;
      }
      if (signal.aborted) return;
      consecutiveRateLimits =
        response.finalStatus === 429 || response.finalStatus === 503 ? consecutiveRateLimits + 1 : 0;
      crawledResources.set(requestedUrl, {
        ok: response.finalStatus < 400 && !response.redirectError,
        status: response.status,
        finalStatus: response.finalStatus,
        finalUrl: response.url,
        redirected: response.redirected,
        redirectChain: response.redirectChain,
        redirectLoop: response.redirectLoop,
        redirectError: response.redirectError,
        contentType: response.contentType,
        contentLength: response.contentLength,
        contentEncoding: response.contentEncoding,
        error: response.redirectError,
        failureKind: response.redirectError ? "redirect" : "",
        ...(response.skippedRedirect ? { skippedRedirect: response.skippedRedirect } : {}),
        fromCrawl: true,
      });
      // The redirect lands on a URL robots.txt disallows for the crawler: the
      // hop is evidence about this URL, the target is never requested (it is
      // in robotsSkipped) and has no page row.
      if (response.skippedRedirect) {
        recordRedirectIssues(requestedUrl, response);
        const targetKey = normalizedUrlKey(response.skippedRedirect);
        if (!skippedPageKeys.has(targetKey)) {
          skippedPageKeys.add(targetKey);
          skippedPageUrls.push(response.skippedRedirect);
        }
        persistProgress();
        return;
      }
      if (response.redirectError) {
        recordRedirectIssues(requestedUrl, response);
        const finalUrl = response.url || requestedUrl;
        pushPage({
          url: requestedUrl,
          finalUrl,
          requestedUrl,
          status: response.status,
          finalStatus: response.finalStatus,
          redirected: response.redirected,
          redirectChain: response.redirectChain,
          redirectLoop: response.redirectLoop,
          redirectError: response.redirectError,
          contentType: response.contentType,
          loadMs,
          indexable: false,
          finalIndexable: false,
          indexabilityReason: response.redirectLoop ? "redirect-loop" : "redirect-failed",
          depth: null,
          discovery: discoveryByUrl.get(requestedKey) || "internal-link",
          internalInlinks: internalInlinks.get(requestedKey) || 0,
          sitemapListed: sitemapUrlSet.has(requestedKey) || sitemapUrlSet.has(normalizedUrlKey(finalUrl)),
          internalLinks: 0,
          externalLinks: 0,
          images: 0,
          assets: 0,
        });
        persistProgress();
        return;
      }
      const finalUrl = response.url || requestedUrl;
      const finalKey = normalizedUrlKey(finalUrl);
      // An internal URL that lands on another domain is evidence about this
      // site's redirect, not a page of this site: record the hop, skip the audit.
      if (!sameSiteUrl(finalUrl, startUrl)) {
        pushScanIssue(issues, {
          url: requestedUrl,
          severity: "low",
          category: "crawl",
          type: "redirect-off-site",
          message: `URL redirects to another domain with HTTP ${response.status}`,
          recommendation: "Confirm the cross-domain redirect is intentional, or link to the external URL directly.",
          evidence: {
            status: response.status,
            finalStatus: response.finalStatus,
            finalUrl,
            redirectChain: response.redirectChain,
          },
        });
        persistProgress();
        return;
      }
      if (response.redirected) recordRedirectIssues(requestedUrl, response);
      if (finalKey !== requestedKey) redirectedKeys.set(requestedKey, finalKey);
      // A redirect to a page already crawled (reused, not downloaded again).
      if (processedContent.has(finalKey)) {
        persistProgress();
        return;
      }
      processedContent.add(finalKey);
      crawledPageResponses.set(finalUrl, {
        status: response.finalStatus,
        contentType: response.contentType,
        contentLength: response.contentLength,
        contentEncoding: response.contentEncoding,
        xRobotsTag: response.xRobotsTag || "",
      });
      if (finalKey !== requestedKey) {
        current = finalUrl;
        currentKey = finalKey;
        if (!discoveryByUrl.has(finalKey)) {
          discoveryByUrl.set(finalKey, discoveryByUrl.get(requestedKey) || "internal-link");
        }
        internalInlinks.set(
          finalKey,
          Math.max(internalInlinks.get(finalKey) || 0, internalInlinks.get(requestedKey) || 0),
        );
      }
      const isHtml =
        /text\/html|application\/xhtml\+xml/i.test(response.contentType) ||
        (!response.contentType && /<html[\s>]/i.test(response.text.slice(0, 4096)));
      const robotsHeaderDirectives = robotsDirectives([], cleanText(response.xRobotsTag || ""));
      if (!isHtml) {
        // Feeds, JSON, and files keep their status and redirect evidence, but
        // are not audited as HTML pages.
        const noindex = robotsHeaderDirectives.some((item) => item === "noindex" || item === "none");
        if (response.finalStatus >= 400) {
          pushScanIssue(issues, {
            url: current,
            severity: "high",
            category: "crawl",
            type: "page-http-error",
            message: `Page returns HTTP ${response.finalStatus}`,
            recommendation: "Fix the URL or redirect it to a live equivalent.",
            evidence: {
              status: response.status,
              finalStatus: response.finalStatus,
              requestedUrl,
              redirectChain: response.redirectChain,
            },
          });
        } else {
          pushScanIssue(issues, {
            url: current,
            severity: "medium",
            category: "crawl",
            type: "non-html-page",
            message: "Crawled URL is not HTML",
            recommendation: "Keep non-HTML files out of primary crawl paths unless they are intentionally linked.",
            evidence: { contentType: response.contentType },
          });
        }
        pushPage({
          url: current,
          finalUrl,
          requestedUrl,
          sourceStatus: response.status,
          status: response.finalStatus,
          finalStatus: response.finalStatus,
          redirected: response.redirected,
          redirectChain: response.redirectChain,
          redirectLoop: response.redirectLoop,
          contentType: response.contentType,
          contentEncoding: response.contentEncoding,
          contentLength: response.contentLength,
          loadMs,
          urlLength: current.length,
          isHtml: false,
          xRobotsTag: response.xRobotsTag || "",
          indexable: false,
          finalIndexable: false,
          indexabilityReason: response.finalStatus >= 400 ? "http-error" : noindex ? "noindex" : "non-html",
          depth: null,
          discovery: discoveryByUrl.get(currentKey) || "internal-link",
          internalInlinks: internalInlinks.get(currentKey) || 0,
          sitemapListed: sitemapUrlSet.has(currentKey) || sitemapUrlSet.has(finalKey),
          sitemapSourceListed: requestedKey !== currentKey && sitemapUrlSet.has(requestedKey),
          internalLinks: 0,
          externalLinks: 0,
          images: 0,
          assets: 0,
        });
        persistProgress();
        return;
      }
      const $ = cheerio.load(response.text);
      const baseHref = cleanText($("base[href]").first().attr("href") || "");
      const documentBaseUrl = baseHref ? absoluteHttpUrl(baseHref, finalUrl) || finalUrl : finalUrl;
      // The document title only: <title> inside inline SVG labels the graphic.
      const titleTags = $("title").filter((_, item) => $(item).closest("svg").length === 0);
      const title = cleanText(titleTags.first().text());
      const titleCount = titleTags.length;
      // Meta names are case-insensitive (NAME="ROBOTS", name="Description").
      const metaContents = (name: string) =>
        $(`meta[name="${name}" i]`).map((_, item) => cleanText($(item).attr("content") || "")).get();
      const descriptions = metaContents("description");
      const description = descriptions.find(Boolean) || "";
      const descriptionCount = descriptions.length;
      const h1s = $("h1").map((_, item) => cleanText($(item).text())).get().filter(Boolean);
      const emptyH1Count = $("h1").length - h1s.length;
      const h2Count = $("h2").length;
      const headings = $("h1,h2,h3,h4,h5,h6").map((_, item) => ({
        level: Number(item.tagName.replace(/^h/i, "")),
        text: cleanText($(item).text()),
      })).get();
      const emptyHeadingCount = headings.filter((heading) => !heading.text).length;
      const headingJumps = headings.filter((heading, index) => {
        if (index === 0) return false;
        const previous = headings[index - 1];
        return heading.level > previous.level + 1;
      });
      const canonicalRaw = $('link[rel="canonical"]').attr("href") || "";
      const canonical = canonicalRaw ? absoluteHttpUrl(canonicalRaw, documentBaseUrl) || canonicalRaw : "";
      const canonicalCount = $('link[rel="canonical"]').length;
      // Every robots and googlebot meta tag counts, not just the first one.
      const robotsMetaContents = [...metaContents("robots"), ...metaContents("googlebot")].filter(Boolean);
      const robotsMeta = robotsMetaContents.join(", ");
      const xRobotsTag = cleanText(response.xRobotsTag || "");
      const robotDirectives = [...robotsDirectives(robotsMetaContents, ""), ...robotsHeaderDirectives];
      const hasNoindexDirective = robotDirectives.some((item) => item === "noindex" || item === "none");
      const finalIndexable = !hasNoindexDirective && response.finalStatus < 400 && !response.redirectError;
      const indexable = finalIndexable;
      const lang = cleanText($("html").attr("lang") || "");
      const viewport = metaContents("viewport")[0] || "";
      const charset = cleanText($("meta[charset]").attr("charset") || $('meta[http-equiv="content-type" i]').attr("content") || "");
      const metaRefresh = cleanText($("meta").filter((_, item) => /^refresh$/i.test($(item).attr("http-equiv") || "")).first().attr("content") || "");
      const faviconCount = $('link[rel~="icon"], link[rel="shortcut icon"]').length;
      const structuredData = readStructuredData($);
      const schemaCount = structuredData.jsonLdCount;
      const schemaParseErrors = structuredData.parseErrors;
      const ogTitle = cleanText($('meta[property="og:title" i]').attr("content") || "");
      const ogDescription = cleanText($('meta[property="og:description" i]').attr("content") || "");
      const ogImageRaw = cleanText($('meta[property="og:image" i]').attr("content") || "");
      const ogImage = ogImageRaw ? absoluteHttpUrl(ogImageRaw, documentBaseUrl) || ogImageRaw : "";
      const twitterCard = metaContents("twitter:card")[0] || "";
      const hreflangs = $('link[rel="alternate"][hreflang]').map((_, item) => ({
        lang: cleanText($(item).attr("hreflang") || ""),
        href: $(item).attr("href") || "",
      })).get();
      const hreflangCount = hreflangs.length;
      const hreflangCodes = hreflangs.map((item) => item.lang.toLowerCase()).filter(Boolean);
      const hreflangTargets = hreflangs.flatMap((item) => {
        const href = item.lang ? absoluteHttpUrl(item.href, documentBaseUrl) : null;
        return href ? [{ lang: item.lang, href }] : [];
      });
      hreflangByPage.set(current, hreflangTargets);
      const imageRows: any[] = [];
      const linkRows: any[] = [];
      // Internal link targets of this page, for link depth once the crawl is done.
      const linkTargets: string[] = [];
      linkTargetsByKey.set(currentKey, linkTargets);
      const assetRows: any[] = [];

      // Resources remember every page that references them, so a failing
      // image or asset is reported on each affected page.
      const addResourceToCheck = (
        resources: Map<string, any>,
        max: number,
        url: string,
        meta: Record<string, unknown>,
      ) => {
        const existing = resources.get(url);
        if (existing) {
          if (!existing.sourcePages.includes(current)) existing.sourcePages.push(current);
          return;
        }
        if (resources.size >= max) return;
        resources.set(url, { url, from: current, sourcePages: [current], ...meta });
      };
      // CSS, JS, and images the page loads to render, for Googlebot's
      // robots-blocked-resource check (every one, not only those checked).
      const renderResources = new Map<string, "css" | "js" | "image">();
      const addAsset = (url: string, type: "css" | "js", meta: Record<string, unknown> = {}) => {
        renderResources.set(url, type);
        addResourceToCheck(assetsToCheck, limits.maxAssetsToCheck, url, { type, ...meta });
      };
      const addImageToCheck = (url: string, meta: Record<string, unknown> = {}) => {
        if (meta.purpose !== "og:image") renderResources.set(url, "image");
        addResourceToCheck(imagesToCheck, limits.maxImagesToCheck, url, meta);
      };

      if (/^https?:\/\//i.test(ogImage)) addImageToCheck(ogImage, { purpose: "og:image" });

      $("img").each((imageIndex, img) => {
        const src = $(img).attr("src") || $(img).attr("data-src") || "";
        const imgSrcsetRaw = $(img).attr("srcset") || "";
        const pictureSourceSrcsets = $(img)
          .closest("picture")
          .find("source[srcset]")
          .map((_, source) => $(source).attr("srcset") || "")
          .get()
          .filter(Boolean);
        const imgSrcsetUrls = parseSrcsetUrls(imgSrcsetRaw, documentBaseUrl);
        const pictureSrcsetUrls = pictureSourceSrcsets.flatMap((srcset) => parseSrcsetUrls(srcset, documentBaseUrl));
        const srcsetUrls = [...imgSrcsetUrls, ...pictureSrcsetUrls];
        const invalidSrcsetCandidates =
          srcsetCandidateCount(imgSrcsetRaw) +
          pictureSourceSrcsets.reduce((count, srcset) => count + srcsetCandidateCount(srcset), 0) -
          srcsetUrls.length;
        const absolute = absoluteHttpUrl(src, documentBaseUrl) || srcsetUrls[0] || null;
        const alt = $(img).attr("alt");
        const altText = cleanText(alt || "");
        const role = cleanText($(img).attr("role") || "");
        const ariaHidden = cleanText($(img).attr("aria-hidden") || "");
        const width = $(img).attr("width") || "";
        const height = $(img).attr("height") || "";
        const cssSized = imageIsCssSized($(img).attr("class") || "", $(img).attr("style") || "");
        const row = {
          from: current,
          src: absolute || src,
          alt: alt ?? null,
          altPreview: altText.slice(0, 160),
          altState: typeof alt !== "string" ? "missing" : alt.trim() ? "present" : "empty",
          width,
          height,
          loading: $(img).attr("loading") || "",
          position: imageIndex + 1,
          srcsetCount: srcsetUrls.length,
          pictureSourceCount: pictureSrcsetUrls.length,
          invalidSrcsetCandidates: Math.max(0, invalidSrcsetCandidates),
          role,
          ariaHidden,
          classification: imageClassification({ src: absolute || src, width, height, role, ariaHidden }),
          cssSized,
          snippet: "",
          issues: [] as string[],
        };
        if (!src && pictureSrcsetUrls.length) row.issues.push("missing fallback src");
        if (!row.src) {
          row.issues.push("missing src");
          row.snippet = cleanText($.html(img)).slice(0, 200);
        }
        if (row.invalidSrcsetCandidates > 0) row.issues.push("invalid srcset");
        if (row.classification === "content" && row.altState === "missing") row.issues.push("missing alt");
        if (row.classification === "content" && row.altState === "empty") row.issues.push("empty alt");
        if (row.classification === "content" && altText.length > 125) row.issues.push("alt too long");
        if (row.classification === "content" && isGenericAltText(altText, row.src || "")) row.issues.push("generic alt");
        if (row.src && (!row.width || !row.height) && !row.cssSized) row.issues.push("missing size");
        if (row.classification === "content" && imageIndex > 1 && String(row.loading).toLowerCase() !== "lazy") row.issues.push("not lazy loaded");
        if (row.classification === "content" && Number.parseInt(row.width || "0", 10) >= 600 && row.srcsetCount === 0) row.issues.push("missing srcset");
        if (row.src && isHttpOnHttpsPage(row.src, current)) row.issues.push("mixed content");
        imageRows.push(row);
        if (imageInventory.length < limits.maxImageInventory) imageInventory.push(row);
        for (const imageUrl of [absolute, ...srcsetUrls].filter(Boolean) as string[]) {
          addImageToCheck(imageUrl, { purpose: pictureSrcsetUrls.includes(imageUrl) ? "picture-source" : "img" });
        }
      });

      $("source[srcset]").each((_, source) => {
        const urls = parseSrcsetUrls($(source).attr("srcset") || "", documentBaseUrl);
        for (const imageUrl of urls) addImageToCheck(imageUrl, { purpose: "source-srcset" });
      });

      $("[style]").each((_, item) => {
        for (const imageUrl of cssUrlValues($(item).attr("style") || "", documentBaseUrl)) {
          addImageToCheck(imageUrl, { purpose: "css-url" });
        }
      });
      $("style").each((_, item) => {
        for (const imageUrl of cssUrlValues($(item).contents().text() || "", documentBaseUrl)) {
          addImageToCheck(imageUrl, { purpose: "css-url" });
        }
      });

      $("a[href]").each((_, link) => {
        const href = $(link).attr("href") || "";
        const absolute = absoluteHttpUrl(href, documentBaseUrl);
        if (!absolute) return;
        if (isIgnoredCrawlUrl(absolute)) return;
        const isInternal = sameSiteUrl(absolute, startUrl);
        const imageAlt = cleanText($(link).find("img[alt]").first().attr("alt") || "");
        const accessibleName = cleanText($(link).attr("aria-label") || $(link).attr("title") || imageAlt);
        const anchor = cleanText($(link).text());
        const row = {
          from: current,
          href: absolute,
          anchor,
          accessibleName,
          rel: cleanText($(link).attr("rel") || ""),
          target: cleanText($(link).attr("target") || ""),
          type: isInternal ? "internal" : "external",
        };
        linkRows.push(row);
        if (linkInventory.length < limits.maxLinkInventory) linkInventory.push(row);
        addPageLink(current, row);
        let linkCandidate = linksToCheck.get(absolute);
        if (!linkCandidate && linksToCheck.size < limits.maxLinksToCheck) {
          linkCandidate = {
            url: absolute,
            type: row.type,
            anchor: row.anchor,
            rel: row.rel,
            referenceCount: 0,
            sources: new Map<string, any>(),
          };
          linksToCheck.set(absolute, linkCandidate);
        }
        if (linkCandidate) {
          linkCandidate.referenceCount += 1;
          const source = linkCandidate.sources.get(current) || {
            from: current,
            anchor: row.anchor,
            rel: row.rel,
            references: 0,
          };
          source.references += 1;
          if (!source.anchor && row.anchor) source.anchor = row.anchor;
          linkCandidate.sources.set(current, source);
        }
        const target = isInternal ? pageCrawlTarget(absolute, startKey) : null;
        if (target?.parameterized) addParameterUrl(absolute, "internal-link", current, target.url);
        if (target) {
          internalInlinks.set(target.key, (internalInlinks.get(target.key) || 0) + 1);
          linkTargets.push(target.key);
          if (!discoveryByUrl.has(target.key)) discoveryByUrl.set(target.key, "internal-link");
          if (!linkedFrom.has(target.key)) linkedFrom.set(target.key, current);
        }
        if (
          target &&
          !visited.has(target.key) &&
          !queued.has(target.key) &&
          !skippedPageKeys.has(target.key) &&
          linkQueue.length + visited.size < limits.maxQueuedUrls
        ) {
          queued.add(target.key);
          linkQueue.push(target.url);
        }
      });

      $('link[rel~="stylesheet"][href]').each((_, item) => {
        const href = absoluteHttpUrl($(item).attr("href") || "", documentBaseUrl);
        if (!href) return;
        assetRows.push({ type: "css", url: href });
        addAsset(href, "css", { placement: "head" });
      });
      $("script[src]").each((_, item) => {
        const src = absoluteHttpUrl($(item).attr("src") || "", documentBaseUrl);
        if (!src) return;
        const scriptMeta = {
          type: "js",
          url: src,
          async: typeof $(item).attr("async") === "string",
          defer: typeof $(item).attr("defer") === "string",
          module: cleanText($(item).attr("type") || "").toLowerCase() === "module",
          placement: $(item).parents("head").length ? "head" : "body",
        };
        assetRows.push(scriptMeta);
        addAsset(src, "js", scriptMeta);
      });

      $("script,style,noscript,svg").remove();
      const bodyText = cleanText($("body").text());
      const wordCount = bodyText ? bodyText.split(/\s+/).filter(Boolean).length : 0;
      // Near-duplicate checks compare the main text, without site navigation
      // and footer boilerplate shared by every page.
      $("nav,footer").remove();
      const simhash = contentSimhash(cleanText($("body").text()));

      if (response.finalStatus >= 400) {
        pushScanIssue(issues, {
          url: current,
          severity: "high",
          category: "crawl",
          type: "page-http-error",
          message: `Page returns HTTP ${response.finalStatus}`,
          recommendation: "Fix the URL or redirect it to a live equivalent.",
          evidence: {
            status: response.status,
            finalStatus: response.finalStatus,
            requestedUrl,
            redirectChain: response.redirectChain,
          },
        });
      }
      if (current.length > 115) {
        pushScanIssue(issues, {
          url: current,
          severity: current.length > 160 ? "medium" : "low",
          category: "crawl",
          type: "url-too-long",
          message: `URL is ${current.length} characters`,
          recommendation: "Keep important URLs short, readable, and stable. Remove unnecessary parameters where possible.",
          evidence: { length: current.length },
        });
      }
      if (metaRefresh) {
        pushScanIssue(issues, {
          url: current,
          severity: "medium",
          category: "crawl",
          type: "meta-refresh",
          message: "Page uses a meta refresh redirect",
          recommendation: "Use an HTTP redirect instead of a client-side meta refresh.",
          evidence: { metaRefresh },
        });
      }
      if (new URL(current).protocol !== "https:") {
        // Plain HTTP is normal on localhost/.test/.local development hosts.
        pushScanIssue(issues, {
          url: current,
          severity: localTarget ? "low" : "high",
          category: "security",
          type: "page-not-https",
          message: "Page is served over HTTP",
          recommendation: localTarget
            ? "Local development host: make sure the public site serves this page over HTTPS."
            : "Serve public pages over HTTPS and redirect HTTP URLs to their HTTPS equivalents.",
          evidence: { url: current, localHost: localTarget },
        });
      }
      if (isLikelyTrackingUrl(current)) {
        pushScanIssue(issues, {
          url: current,
          severity: "low",
          category: "crawl",
          type: "tracking-parameters-in-url",
          message: "URL contains tracking parameters",
          recommendation: "Keep crawlable canonical URLs clean. Strip tracking parameters from internal links and canonicalize parameter variants.",
          evidence: { url: current },
        });
      }
      if (!title) {
        pushScanIssue(issues, {
          url: current,
          severity: "high",
          category: "metadata",
          type: "title-missing",
          message: "Missing title tag",
          recommendation: "Add a unique title tag that describes the page and primary search intent.",
        });
      } else if (titleCount > 1) {
        pushScanIssue(issues, {
          url: current,
          severity: "medium",
          category: "metadata",
          type: "title-multiple",
          message: `Multiple title tags found (${titleCount})`,
          recommendation: "Keep one title tag per page so crawlers and browsers have a single canonical title.",
          evidence: { titleCount },
        });
      } else if (title.length > 60 || title.length < 30) {
        pushScanIssue(issues, {
          url: current,
          severity: title.length > 70 ? "medium" : "low",
          category: "metadata",
          type: "title-length",
          message: `Title length is ${title.length} characters`,
          recommendation: "Keep important title copy around 30-60 characters and make every page title unique.",
          evidence: { title, length: title.length },
        });
      }
      if (!description) {
        pushScanIssue(issues, {
          url: current,
          severity: "high",
          category: "metadata",
          type: "description-missing",
          message: "Missing meta description",
          recommendation: "Add a unique meta description that summarizes the page and includes the main value.",
        });
      } else if (descriptionCount > 1) {
        pushScanIssue(issues, {
          url: current,
          severity: "medium",
          category: "metadata",
          type: "description-multiple",
          message: `Multiple meta descriptions found (${descriptionCount})`,
          recommendation: "Keep one meta description per page.",
          evidence: { descriptionCount },
        });
      } else if (description.length > 160 || description.length < 70) {
        pushScanIssue(issues, {
          url: current,
          severity: "low",
          category: "metadata",
          type: "description-length",
          message: `Meta description length is ${description.length} characters`,
          recommendation: "Use concise descriptions around 70-160 characters.",
          evidence: { description, length: description.length },
        });
      }
      if (h1s.length === 0 || h1s.length > 1) {
        pushScanIssue(issues, {
          url: current,
          severity: "medium",
          category: "headings",
          type: "h1-count",
          message: h1s.length === 0 ? "Missing H1" : `Multiple H1 tags found (${h1s.length})`,
          recommendation: "Use one descriptive H1 that matches the page intent.",
          evidence: { h1s },
        });
      }
      if (emptyH1Count > 0) {
        pushScanIssue(issues, {
          url: current,
          severity: "low",
          category: "headings",
          type: "h1-empty",
          message: `${emptyH1Count} H1 tags are empty`,
          recommendation: "Remove empty headings or add meaningful heading text.",
          evidence: { emptyH1Count },
        });
      }
      if (emptyHeadingCount > emptyH1Count) {
        pushScanIssue(issues, {
          url: current,
          severity: "low",
          category: "headings",
          type: "heading-empty",
          message: `${emptyHeadingCount - emptyH1Count} non-H1 headings are empty`,
          recommendation: "Remove empty heading tags or add meaningful text.",
          evidence: { emptyHeadingCount },
        });
      }
      if (headingJumps.length > 0) {
        pushScanIssue(issues, {
          url: current,
          severity: "low",
          category: "headings",
          type: "heading-hierarchy-jump",
          message: `${headingJumps.length} headings skip hierarchy levels`,
          recommendation: "Keep headings in a logical outline so crawlers and assistive technology can understand the page structure.",
          evidence: { samples: headingJumps },
        });
      }
      if (wordCount > 300 && h2Count === 0) {
        pushScanIssue(issues, {
          url: current,
          severity: "low",
          category: "headings",
          type: "h2-missing",
          message: "Long page has no H2 sections",
          recommendation: "Break long content into descriptive H2 sections.",
          evidence: { wordCount },
        });
      }
      if (!canonical) {
        pushScanIssue(issues, {
          url: current,
          severity: "medium",
          category: "canonicals",
          type: "canonical-missing",
          message: "Missing canonical URL",
          recommendation: "Add a canonical URL so crawlers understand the preferred version.",
        });
      } else if (canonicalRaw && !absoluteHttpUrl(canonicalRaw, documentBaseUrl)) {
        pushScanIssue(issues, {
          url: current,
          severity: "medium",
          category: "canonicals",
          type: "canonical-invalid",
          message: "Canonical URL is invalid",
          recommendation: "Use a valid absolute or root-relative canonical URL.",
          evidence: { canonical: canonicalRaw },
        });
      } else if (canonicalCount > 1) {
        pushScanIssue(issues, {
          url: current,
          severity: "medium",
          category: "canonicals",
          type: "canonical-multiple",
          message: `Multiple canonical tags found (${canonicalCount})`,
          recommendation: "Keep one canonical tag per page.",
          evidence: { canonicalCount },
        });
      } else if (isHttpOnHttpsPage(canonical, current)) {
        pushScanIssue(issues, {
          url: current,
          severity: "medium",
          category: "canonicals",
          type: "canonical-http-on-https",
          message: "Canonical URL uses HTTP on an HTTPS page",
          recommendation: "Point canonical tags to the HTTPS version of the preferred URL.",
          evidence: { canonical },
        });
      } else if (!sameSiteUrl(canonical, startUrl)) {
        pushScanIssue(issues, {
          url: current,
          severity: "medium",
          category: "canonicals",
          type: "canonical-cross-domain",
          message: "Canonical points to another domain",
          recommendation: "Confirm cross-domain canonicalization is intentional.",
          evidence: { canonical },
        });
      } else if (
        response.redirectChain.some((hop) => normalizedUrl(hop.url) === normalizedUrl(canonical))
      ) {
        pushScanIssue(issues, {
          url: current,
          severity: "low",
          category: "canonicals",
          type: "canonical-points-to-redirect",
          message: "Canonical points to a redirecting URL",
          recommendation: "Point the canonical directly to the final indexable URL.",
          evidence: { canonical, finalUrl, redirectChain: response.redirectChain },
        });
      } else if (finalIndexable && normalizedUrl(canonical) !== normalizedUrl(finalUrl)) {
        pushScanIssue(issues, {
          url: current,
          severity: "low",
          category: "canonicals",
          type: "canonical-not-self",
          message: "Indexable page canonicals to a different URL",
          recommendation: "Use a self-referencing canonical unless this page is intentionally consolidated into another URL.",
          evidence: { canonical, finalUrl },
        });
      }
      if (hasNoindexDirective) {
        pushScanIssue(issues, {
          url: current,
          severity: "high",
          category: "indexability",
          type: "noindex",
          message: "Page is marked noindex",
          recommendation: "Remove noindex directives from pages that should appear in search.",
          evidence: { robotsMeta, xRobotsTag },
        });
      }
      if (robotDirectives.includes("nofollow") || robotDirectives.includes("none")) {
        pushScanIssue(issues, {
          url: current,
          severity: "medium",
          category: "indexability",
          type: "meta-robots-nofollow",
          message: "Page tells crawlers not to follow links",
          recommendation: "Remove nofollow from page-level robots directives unless all links on this page should be excluded from crawl flow.",
          evidence: { robotsMeta, xRobotsTag },
        });
      }
      if (robotDirectives.includes("noarchive") || robotDirectives.includes("nosnippet")) {
        pushScanIssue(issues, {
          url: current,
          severity: "low",
          category: "indexability",
          type: "restrictive-snippet-directive",
          message: "Page uses restrictive snippet/archive directives",
          recommendation: "Confirm noarchive or nosnippet is intentional; these directives can reduce search-result usefulness.",
          evidence: { robotsMeta, xRobotsTag },
        });
      }
      if (!lang) {
        pushScanIssue(issues, {
          url: current,
          severity: "low",
          category: "indexability",
          type: "html-lang-missing",
          message: "HTML lang attribute is missing",
          recommendation: "Set the page language on the html element.",
        });
      } else if (!isValidLangCode(lang)) {
        pushScanIssue(issues, {
          url: current,
          severity: "low",
          category: "localization",
          type: "html-lang-invalid",
          message: "HTML lang attribute does not look valid",
          recommendation: "Use a valid BCP 47 language tag such as en, en-US, pt, or pt-PT.",
          evidence: { lang },
        });
      }
      if (!charset) {
        pushScanIssue(issues, {
          url: current,
          severity: "low",
          category: "indexability",
          type: "charset-missing",
          message: "Charset declaration is missing",
          recommendation: "Declare UTF-8 early in the document head.",
        });
      }
      if (!faviconCount) {
        pushScanIssue(issues, {
          url: current,
          severity: "low",
          category: "metadata",
          type: "favicon-missing",
          message: "Favicon link is missing",
          recommendation: "Add a site icon so browser tabs, bookmarks, and search surfaces have a clear visual identity.",
        });
      }
      if (!viewport) {
        pushScanIssue(issues, {
          url: current,
          severity: "medium",
          category: "performance",
          type: "viewport-missing",
          message: "Viewport meta tag is missing",
          recommendation: "Add a responsive viewport meta tag for mobile rendering.",
        });
      } else if (!/width\s*=\s*device-width/i.test(viewport)) {
        pushScanIssue(issues, {
          url: current,
          severity: "low",
          category: "performance",
          type: "viewport-not-responsive",
          message: "Viewport meta tag does not include width=device-width",
          recommendation: "Use a responsive viewport such as width=device-width, initial-scale=1.",
          evidence: { viewport },
        });
      }
      if (loadMs > 4000) {
        pushScanIssue(issues, {
          url: current,
          severity: "medium",
          category: "performance",
          type: "slow-page",
          message: `Page took ${loadMs}ms to respond`,
          recommendation: "Investigate server response time, redirects, heavy HTML, blocking assets, and caching.",
          evidence: { loadMs },
        });
      } else if (loadMs > 2000) {
        pushScanIssue(issues, {
          url: current,
          severity: "low",
          category: "performance",
          type: "page-response-slow",
          message: `Page response took ${loadMs}ms`,
          recommendation: "Keep important pages fast enough for users and crawlers.",
          evidence: { loadMs },
        });
      }
      if (response.contentLength && response.contentLength > 1000000) {
        pushScanIssue(issues, {
          url: current,
          severity: "low",
          category: "performance",
          type: "heavy-html",
          message: "HTML response is larger than 1 MB",
          recommendation: "Reduce server-rendered payload, unused markup, and inline data where possible.",
          evidence: { bytes: response.contentLength },
        });
      }
      if (wordCount < 150) {
        pushScanIssue(issues, {
          url: current,
          severity: "medium",
          category: "content",
          type: "thin-content",
          message: `Page has ${wordCount} visible words`,
          recommendation: "Add useful body content when this page is intended to rank or convert.",
          evidence: { wordCount },
        });
      }
      const imagesMissingSrc = imageRows.filter((image) => !image.src);
      const missingFallbackSrc = imageRows.filter((image) => image.issues.includes("missing fallback src")).length;
      const invalidSrcset = imageRows.filter((image) => image.issues.includes("invalid srcset")).length;
      const missingAlt = imageRows.filter((image) => image.classification === "content" && image.altState === "missing").length;
      const emptyAlt = imageRows.filter((image) => image.classification === "content" && image.altState === "empty").length;
      const missingDimensions = imageRows.filter((image) => image.issues.includes("missing size"));
      if (imagesMissingSrc.length > 0) {
        pushScanIssue(issues, {
          url: current,
          severity: "high",
          category: "images",
          type: "image-src-missing",
          message: `${imagesMissingSrc.length} image tags have no source`,
          recommendation: "Remove empty image tags or point them to a valid image file.",
          evidence: {
            count: imagesMissingSrc.length,
            samples: imagesMissingSrc.map((image) => (image.snippet ? `img #${image.position} · ${image.snippet}` : `img #${image.position}`)),
          },
        });
      }
      if (missingFallbackSrc > 0) {
        pushScanIssue(issues, {
          url: current,
          severity: "low",
          category: "images",
          type: "image-fallback-src-missing",
          message: `${missingFallbackSrc} picture images are missing fallback src values`,
          recommendation: "Keep a valid img src fallback inside picture elements so older clients, crawlers, and parsers still find an image.",
          evidence: { count: missingFallbackSrc },
        });
      }
      if (invalidSrcset > 0) {
        pushScanIssue(issues, {
          url: current,
          severity: "medium",
          category: "images",
          type: "image-srcset-invalid",
          message: `${invalidSrcset} image srcset entries could not be resolved`,
          recommendation: "Fix malformed srcset candidates and keep responsive image URLs valid.",
          evidence: { count: invalidSrcset },
        });
      }
      if (missingAlt > 0) {
        pushScanIssue(issues, {
          url: current,
          severity: "medium",
          category: "images",
          type: "image-alt-missing",
          message: `${missingAlt} content images are missing alt attributes`,
          recommendation: "Add useful alt text for meaningful images. Mark decorative or tracking images explicitly when they should be ignored.",
          evidence: { count: missingAlt },
        });
      }
      if (emptyAlt > 0) {
        pushScanIssue(issues, {
          url: current,
          severity: "low",
          category: "images",
          type: "image-alt-empty",
          message: `${emptyAlt} content images have empty alt text`,
          recommendation: "Add descriptive alt text or mark the image as decorative with role=\"presentation\" or aria-hidden=\"true\".",
          evidence: { count: emptyAlt },
        });
      }
      const genericAlt = imageRows.filter((image) => image.classification === "content" && image.issues.includes("generic alt"));
      if (genericAlt.length > 0) {
        pushScanIssue(issues, {
          url: current,
          severity: "low",
          category: "images",
          type: "image-alt-generic",
          message: `${genericAlt.length} content images use generic alt text`,
          recommendation: "Write alt text that describes the specific image and its purpose on the page.",
          evidence: { count: genericAlt.length, samples: genericAlt.map((image) => ({ src: image.src, alt: image.altPreview })) },
        });
      }
      const longAlt = imageRows.filter((image) => image.classification === "content" && image.issues.includes("alt too long"));
      if (longAlt.length > 0) {
        pushScanIssue(issues, {
          url: current,
          severity: "low",
          category: "images",
          type: "image-alt-too-long",
          message: `${longAlt.length} content images have very long alt text`,
          recommendation: "Keep alt text concise and useful. Move long explanations into visible page copy.",
          evidence: { count: longAlt.length, samples: longAlt.map((image) => ({ src: image.src, length: String(image.alt || "").length })) },
        });
      }
      const duplicateAltTexts = [...new Set(imageRows
        .filter((image) => image.classification === "content" && image.altPreview)
        .map((image) => image.altPreview.toLowerCase())
        .filter((alt, index, alts) => alts.indexOf(alt) !== index))];
      if (duplicateAltTexts.length > 0) {
        pushScanIssue(issues, {
          url: current,
          severity: "low",
          category: "images",
          type: "image-alt-duplicate",
          message: "Multiple content images use the same alt text",
          recommendation: "Use distinct alt text when images convey different information. Repeated decorative images should be marked decorative.",
          evidence: { duplicateAltTexts },
        });
      }
      if (missingDimensions.length > 0) {
        pushScanIssue(issues, {
          url: current,
          severity: "low",
          category: "images",
          type: "image-dimensions-missing",
          message: `${missingDimensions.length} images are not sized by attributes, inline styles, or sizing classes`,
          recommendation: "Set width/height attributes, CSS dimensions, or an aspect ratio so the browser can reserve space and avoid layout shift.",
          evidence: { count: missingDimensions.length, samples: missingDimensions.map((image) => image.src) },
        });
      }
      const missingSrcset = imageRows.filter((image) => image.issues.includes("missing srcset"));
      if (missingSrcset.length > 0) {
        pushScanIssue(issues, {
          url: current,
          severity: "low",
          category: "images",
          type: "image-srcset-missing",
          message: `${missingSrcset.length} large content images have no srcset`,
          recommendation: "Use responsive image sources so mobile users do not download oversized images.",
          evidence: { count: missingSrcset.length, samples: missingSrcset.map((image) => image.src) },
        });
      }
      const missingLazyLoading = imageRows.filter((image) => image.issues.includes("not lazy loaded"));
      if (missingLazyLoading.length > 0) {
        pushScanIssue(issues, {
          url: current,
          severity: "low",
          category: "performance",
          type: "image-lazy-loading-missing",
          message: `${missingLazyLoading.length} lower-page images are not lazy loaded`,
          recommendation: "Lazy-load images that are not needed for the initial viewport.",
          evidence: { count: missingLazyLoading.length, samples: missingLazyLoading.map((image) => image.src) },
        });
      }
      const mixedImages = imageRows.filter((image) => image.src && isHttpOnHttpsPage(image.src, current));
      if (mixedImages.length > 0) {
        pushScanIssue(issues, {
          url: current,
          severity: "medium",
          category: "images",
          type: "mixed-content-images",
          message: `${mixedImages.length} images use HTTP on an HTTPS page`,
          recommendation: "Serve image assets over HTTPS to avoid browser blocking and security warnings.",
          evidence: { count: mixedImages.length, samples: mixedImages.map((image) => image.src) },
        });
      }
      const mixedLinks = linkRows.filter((link) => isHttpOnHttpsPage(link.href, current));
      if (mixedLinks.length > 0) {
        pushScanIssue(issues, {
          url: current,
          severity: "low",
          category: "links",
          type: "mixed-content-links",
          message: `${mixedLinks.length} links use HTTP on an HTTPS page`,
          recommendation: "Update links to HTTPS versions where available.",
          evidence: { count: mixedLinks.length, samples: mixedLinks.map((link) => link.href) },
        });
      }
      const emptyAnchorLinks = linkRows.filter((link) => !link.anchor && !link.accessibleName);
      if (emptyAnchorLinks.length > 0) {
        pushScanIssue(issues, {
          url: current,
          severity: "low",
          category: "links",
          type: "empty-anchor-text",
          message: `${emptyAnchorLinks.length} links have no readable anchor text`,
          recommendation: "Add visible anchor text or accessible labels so users and crawlers understand the linked URL.",
          evidence: { count: emptyAnchorLinks.length, samples: emptyAnchorLinks.map((link) => link.href) },
        });
      }
      const internalNofollowLinks = linkRows.filter((link) => link.type === "internal" && /\bnofollow\b/i.test(link.rel));
      if (internalNofollowLinks.length > 0) {
        pushScanIssue(issues, {
          url: current,
          severity: "low",
          category: "links",
          type: "internal-nofollow",
          message: `${internalNofollowLinks.length} internal links are nofollow`,
          recommendation: "Remove nofollow from internal links unless crawl flow should intentionally be blocked.",
          evidence: { count: internalNofollowLinks.length, samples: internalNofollowLinks.map((link) => link.href) },
        });
      }
      const unsafeBlankLinks = linkRows.filter((link) => link.type === "external" && link.target.toLowerCase() === "_blank" && !/\b(noopener|noreferrer)\b/i.test(link.rel));
      if (unsafeBlankLinks.length > 0) {
        pushScanIssue(issues, {
          url: current,
          severity: "low",
          category: "security",
          type: "external-blank-missing-noopener",
          message: `${unsafeBlankLinks.length} external links open in a new tab without noopener`,
          recommendation: "Add rel=\"noopener\" or rel=\"noreferrer\" to external target=\"_blank\" links.",
          evidence: { count: unsafeBlankLinks.length, samples: unsafeBlankLinks.map((link) => link.href) },
        });
      }
      if (linkRows.filter((link) => link.type === "internal").length === 0) {
        pushScanIssue(issues, {
          url: current,
          severity: "medium",
          category: "links",
          type: "no-internal-links",
          message: "No internal links found on the page",
          recommendation: "Add internal links so users and crawlers can move through the site.",
        });
      }
      if (linkRows.length > 150) {
        pushScanIssue(issues, {
          url: current,
          severity: "low",
          category: "links",
          type: "too-many-links",
          message: `Page has ${linkRows.length} links`,
          recommendation: "Keep navigation and body links focused so crawl equity and users are not diluted by excessive targets.",
          evidence: { linkCount: linkRows.length },
        });
      }
      const robotsBlockedLinks = [...new Set(linkRows.filter((link) => link.type === "internal").map((link) => link.href))].flatMap(
        (href) => {
          const verdict = robotsCheck(href);
          return verdict && !verdict.allowed ? [{ url: href, rule: verdict.matchedRule }] : [];
        },
      );
      if (robotsBlockedLinks.length > 0) {
        pushScanIssue(issues, {
          url: current,
          severity: "low",
          category: "robots",
          type: "robots-blocked-linked",
          message: `${robotsBlockedLinks.length} internal links point to URLs robots.txt disallows for Googlebot`,
          recommendation: "Confirm the blocked destinations are intentional, or link to crawlable URLs instead.",
          evidence: { count: robotsBlockedLinks.length, blockedUrls: robotsBlockedLinks.slice(0, 20), robotsUrl: robots.url },
        });
      }
      const robotsBlockedResources = [...renderResources].flatMap(([url, kind]) => {
        const verdict = robotsCheck(url);
        return verdict && !verdict.allowed ? [{ url, kind, rule: verdict.matchedRule }] : [];
      });
      if (robotsBlockedResources.length > 0) {
        // Blocked CSS/JS changes how Google renders the page; images alone do not.
        const blocksRendering = robotsBlockedResources.some((resource) => resource.kind !== "image");
        pushScanIssue(issues, {
          url: current,
          severity: blocksRendering ? "medium" : "low",
          category: "robots",
          type: "robots-blocked-resource",
          message: `${robotsBlockedResources.length} resources this page loads are disallowed for Googlebot`,
          recommendation: "Allow Googlebot to fetch the stylesheets, scripts, and images the page needs to render.",
          evidence: { count: robotsBlockedResources.length, blockedResources: robotsBlockedResources.slice(0, 20), robotsUrl: robots.url },
        });
      }
      const trackingInternalLinks = linkRows.filter((link) => link.type === "internal" && isLikelyTrackingUrl(link.href));
      if (trackingInternalLinks.length > 0) {
        pushScanIssue(issues, {
          url: current,
          severity: "low",
          category: "links",
          type: "internal-links-with-tracking-parameters",
          message: `${trackingInternalLinks.length} internal links contain tracking parameters`,
          recommendation: "Remove tracking parameters from internal links and keep analytics tagging for inbound campaigns.",
          evidence: { samples: trackingInternalLinks.map((link) => link.href) },
        });
      }
      if (!schemaCount && !structuredData.microdataCount) {
        pushScanIssue(issues, {
          url: current,
          severity: "low",
          category: "structured-data",
          type: "structured-data-missing",
          message: "No JSON-LD or microdata structured data found",
          recommendation: "Add relevant schema such as Organization, WebSite, BreadcrumbList, Article, Product, or LocalBusiness.",
        });
      }
      const itemsMissingRequired = structuredData.items.filter((item) => item.missingRequired.length);
      if (itemsMissingRequired.length > 0) {
        pushScanIssue(issues, {
          url: current,
          severity: "medium",
          category: "structured-data",
          type: "structured-data-missing-required",
          message: `${itemsMissingRequired.length} structured data items are missing required properties`,
          recommendation: "Add the listed required properties so the items are eligible for rich results.",
          evidence: {
            count: itemsMissingRequired.length,
            items: itemsMissingRequired.map((item) => ({ type: item.type, format: item.format, missing: item.missingRequired })),
          },
        });
      }
      const itemsMissingRecommended = structuredData.items.filter((item) => item.missingRecommended.length);
      if (itemsMissingRecommended.length > 0) {
        pushScanIssue(issues, {
          url: current,
          severity: "low",
          category: "structured-data",
          type: "structured-data-missing-recommended",
          message: `${itemsMissingRecommended.length} structured data items are missing recommended properties`,
          recommendation: "Add the listed recommended properties where the page has that information.",
          evidence: {
            count: itemsMissingRecommended.length,
            items: itemsMissingRecommended.map((item) => ({ type: item.type, format: item.format, missing: item.missingRecommended })),
          },
        });
      }
      if (schemaParseErrors.length > 0) {
        pushScanIssue(issues, {
          url: current,
          severity: "medium",
          category: "structured-data",
          type: "structured-data-invalid",
          message: `${schemaParseErrors.length} JSON-LD blocks are invalid`,
          recommendation: "Fix JSON-LD syntax so search engines can parse structured data.",
          evidence: { errors: schemaParseErrors },
        });
      }
      if (!ogTitle || !ogDescription) {
        pushScanIssue(issues, {
          url: current,
          severity: "low",
          category: "social",
          type: "open-graph-incomplete",
          message: "Open Graph title or description is missing",
          recommendation: "Add Open Graph metadata so shared URLs render clearly.",
          evidence: { ogTitle: Boolean(ogTitle), ogDescription: Boolean(ogDescription) },
        });
      }
      if (!ogImage) {
        pushScanIssue(issues, {
          url: current,
          severity: "low",
          category: "social",
          type: "open-graph-image-missing",
          message: "Open Graph image is missing",
          recommendation: "Add og:image for pages that may be shared or discovered socially.",
        });
      } else if (!/^https?:\/\//i.test(ogImage)) {
        pushScanIssue(issues, {
          url: current,
          severity: "low",
          category: "social",
          type: "open-graph-image-invalid",
          message: "Open Graph image URL is invalid",
          recommendation: "Use a valid absolute Open Graph image URL.",
          evidence: { ogImage },
        });
      }
      if (!twitterCard) {
        pushScanIssue(issues, {
          url: current,
          severity: "low",
          category: "social",
          type: "twitter-card-missing",
          message: "Twitter/X card metadata is missing",
          recommendation: "Add twitter:card metadata for pages that are likely to be shared.",
        });
      }
      const invalidHreflangs = hreflangs.filter((item) => !item.lang || !absoluteHttpUrl(item.href, documentBaseUrl));
      if (invalidHreflangs.length > 0) {
        pushScanIssue(issues, {
          url: current,
          severity: "medium",
          category: "localization",
          type: "hreflang-invalid",
          message: `${invalidHreflangs.length} hreflang links are invalid`,
          recommendation: "Use valid hreflang codes and valid alternate URLs.",
          evidence: { invalidHreflangs },
        });
      }
      const malformedHreflangs = hreflangs.filter((item) => item.lang && item.lang.toLowerCase() !== "x-default" && !isValidLangCode(item.lang));
      if (malformedHreflangs.length > 0) {
        pushScanIssue(issues, {
          url: current,
          severity: "medium",
          category: "localization",
          type: "hreflang-code-invalid",
          message: `${malformedHreflangs.length} hreflang codes do not look valid`,
          recommendation: "Use valid language or language-region codes, plus x-default when needed.",
          evidence: { samples: malformedHreflangs },
        });
      }
      const duplicateHreflangCodes = [...new Set(hreflangCodes.filter((code, index) => hreflangCodes.indexOf(code) !== index))];
      if (duplicateHreflangCodes.length > 0) {
        pushScanIssue(issues, {
          url: current,
          severity: "low",
          category: "localization",
          type: "hreflang-duplicate",
          message: "Duplicate hreflang codes found",
          recommendation: "Keep one alternate URL for each hreflang value.",
          evidence: { duplicateHreflangCodes },
        });
      }
      if (hreflangTargets.length > 0 && response.finalStatus < 400 && !hreflangTargets.some((item) => normalizedUrl(item.href) === normalizedUrl(finalUrl))) {
        pushScanIssue(issues, {
          url: current,
          severity: "low",
          category: "localization",
          type: "hreflang-missing-self",
          message: "Hreflang set does not include this page",
          recommendation: "Add an hreflang link for this page's own language pointing at its own URL.",
          evidence: { hreflangCount, hreflang: hreflangTargets.slice(0, 20) },
        });
      }
      if (hreflangCount > 1 && !hreflangCodes.includes("x-default")) {
        pushScanIssue(issues, {
          url: current,
          severity: "low",
          category: "localization",
          type: "hreflang-x-default-missing",
          message: "Hreflang set has no x-default URL",
          recommendation: "Add x-default when the site has a default language selector or global fallback URL.",
          evidence: { hreflangCount },
        });
      }
      const mixedAssets = assetRows.filter((asset) => isHttpOnHttpsPage(asset.url, current));
      if (mixedAssets.length > 0) {
        pushScanIssue(issues, {
          url: current,
          severity: "medium",
          category: "assets",
          type: "mixed-content-assets",
          message: `${mixedAssets.length} CSS/JS assets use HTTP on an HTTPS page`,
          recommendation: "Serve CSS and JavaScript over HTTPS.",
          evidence: { count: mixedAssets.length, samples: mixedAssets },
        });
      }
      const renderBlockingScripts = assetRows.filter((asset) =>
        asset.type === "js" &&
        asset.placement === "head" &&
        !asset.async &&
        !asset.defer &&
        !asset.module
      );
      if (renderBlockingScripts.length > 0) {
        pushScanIssue(issues, {
          url: current,
          severity: "low",
          category: "performance",
          type: "render-blocking-javascript",
          message: `${renderBlockingScripts.length} head scripts can block rendering`,
          recommendation: "Defer, async-load, module-load, or move non-critical scripts out of the document head.",
          evidence: { samples: renderBlockingScripts.map((asset) => asset.url) },
        });
      }
      if (assetRows.length > 60) {
        pushScanIssue(issues, {
          url: current,
          severity: "low",
          category: "performance",
          type: "too-many-assets",
          message: `Page references ${assetRows.length} CSS/JS assets`,
          recommendation: "Bundle, remove, or defer non-critical CSS and JavaScript to reduce request overhead.",
          evidence: { assetCount: assetRows.length },
        });
      }
      if (response.contentLength && response.contentLength > 50000 && !response.contentEncoding) {
        pushScanIssue(issues, {
          url: current,
          severity: "low",
          category: "performance",
          type: "html-compression-missing",
          message: "Large HTML response does not advertise compression",
          recommendation: "Enable Brotli or gzip compression for HTML responses.",
          evidence: { bytes: response.contentLength },
        });
      }

      const page = {
        url: current,
        finalUrl,
        requestedUrl,
        sourceStatus: response.status,
        status: response.finalStatus,
        finalStatus: response.finalStatus,
        redirected: response.redirected,
        redirectChain: response.redirectChain,
        redirectLoop: response.redirectLoop,
        contentType: response.contentType,
        contentEncoding: response.contentEncoding,
        contentLength: response.contentLength,
        loadMs,
        urlLength: current.length,
        isHtml: true,
        title,
        titleLength: title.length,
        titleCount,
        description,
        descriptionLength: description.length,
        descriptionCount,
        h1s,
        h1: h1s[0] || "",
        h1Count: h1s.length,
        emptyH1Count,
        h2Count,
        headingCount: headings.length,
        emptyHeadingCount,
        headingJumps: headingJumps.length,
        canonical,
        canonicalCount,
        robotsMeta,
        xRobotsTag,
        indexable,
        finalIndexable,
        indexabilityReason: hasNoindexDirective ? "noindex" : response.finalStatus >= 400 ? "http-error" : "indexable",
        lang,
        viewport,
        charset,
        metaRefresh,
        faviconCount,
        wordCount,
        depth: null,
        discovery: discoveryByUrl.get(currentKey) || "internal-link",
        internalInlinks: internalInlinks.get(currentKey) || 0,
        sitemapListed:
          sitemapUrlSet.has(currentKey) || sitemapUrlSet.has(normalizedUrlKey(finalUrl)),
        sitemapSourceListed:
          requestedKey !== currentKey && sitemapUrlSet.has(requestedKey),
        contentFingerprint: contentFingerprint(bodyText),
        contentSimhash: simhash,
        schemaCount,
        schemaParseErrors,
        structuredData: structuredData.items,
        hreflangCount,
        hreflang: hreflangTargets
          .slice(0, MAX_STORED_HREFLANG)
          .map((item) => ({ ...item, targetStatus: null, returnLink: null })),
        openGraph: { title: ogTitle, description: ogDescription },
        ogImage,
        twitterCard,
        internalLinks: linkRows.filter((link) => link.type === "internal").length,
        externalLinks: linkRows.filter((link) => link.type === "external").length,
        images: imageRows.length,
        imagesMissingAlt: missingAlt,
        imagesEmptyAlt: emptyAlt,
        imagesMissingSrc: imagesMissingSrc.length,
        imagesMissingFallbackSrc: missingFallbackSrc,
        imagesInvalidSrcset: invalidSrcset,
        imagesMissingDimensions: missingDimensions.length,
        assets: assetRows.length,
        cssAssets: assetRows.filter((asset) => asset.type === "css").length,
        jsAssets: assetRows.filter((asset) => asset.type === "js").length,
      };
      pushPage(page);
      persistProgress();
    } catch (error) {
      if (signal.aborted) return;
      // A page that never answered (DNS, TLS, timeout, reset) still gets a
      // page row, so it is visible in reports and counts in the health score.
      const message = error instanceof Error ? error.message : "Failed to crawl URL";
      const failureKind = resourceFailureKind(message);
      crawledResources.set(requestedUrl, { ...failedResourceCheck(requestedUrl, message), fromCrawl: true });
      pushScanIssue(issues, {
        url: current,
        severity: "high",
        category: "crawl",
        type: "crawl-failed",
        message,
        recommendation: "Check DNS, TLS, firewall, redirects, and server availability.",
        evidence: { error: message, failureKind },
      });
      pushPage({
        url: current,
        finalUrl: current,
        requestedUrl,
        status: null,
        finalStatus: null,
        error: message,
        failureKind,
        indexable: false,
        finalIndexable: false,
        indexabilityReason: "crawl-failed",
        depth: null,
        discovery: discoveryByUrl.get(currentKey) || "internal-link",
        internalInlinks: internalInlinks.get(currentKey) || 0,
        sitemapListed: sitemapUrlSet.has(currentKey),
        internalLinks: 0,
        externalLinks: 0,
        images: 0,
        assets: 0,
      });
      persistProgress();
    }
  };

  // Up to pageConcurrency page requests in flight, taken from the queue in
  // order. The page budget counts page rows plus requests in flight, so it is
  // never overshot: URLs that redirect to a page already crawled, or off the
  // site, do not use it, and neither do URLs robots.txt disallows (never
  // requested). Total requests stay bounded by the queue limit.
  let fetchedPages = 0;
  let crawlSequence = 0;
  const pageSkipSource = (key: string): RobotsSkipSource =>
    key === startKey ? "start-url" : discoveryByUrl.get(key) === "sitemap" ? "sitemap" : "link";
  try {
    while (true) {
      throwIfCancelled();
      if (consecutiveRateLimits >= 5) {
        // Keep the evidence gathered so far with the failed scan.
        await Promise.all(inFlight);
        persistProgress("checkpoint");
        throw new Error(
          "The site keeps rate limiting the crawl (HTTP 429/503). Wait a while and scan again, or keep the polite crawl speed.",
        );
      }
      const canStart =
        !crawlStopped &&
        inFlight.size < pageConcurrency &&
        pages.length + inFlight.size < limits.maxPages &&
        visited.size < limits.maxQueuedUrls;
      const requestedUrl = canStart ? nextCrawlUrl() : null;
      if (!requestedUrl) {
        if (!inFlight.size) break;
        await Promise.race(inFlight);
        continue;
      }
      const requestedKey = normalizedUrlKey(requestedUrl);
      queued.delete(requestedKey);
      if (visited.has(requestedKey) || processedContent.has(requestedKey) || skippedPageKeys.has(requestedKey)) continue;
      if (await skipBlocked(requestedUrl, pageSkipSource(requestedKey), linkedFrom.get(requestedKey))) {
        skippedPageKeys.add(requestedKey);
        skippedPageUrls.push(requestedUrl);
        continue;
      }
      visited.add(requestedKey);
      if (politeTarget && fetchedPages > 0) {
        await sleep(pageDelayMs * (0.75 + Math.random() * 0.5), signal);
        throwIfCancelled();
      }
      fetchedPages += 1;
      progressUrl = requestedUrl;
      const job: Promise<void> = crawlPage(requestedUrl, requestedKey, crawlSequence++).finally(() => inFlight.delete(job));
      inFlight.add(job);
    }
  } finally {
    // Pages in flight finish (or drop their response after a cancel) before
    // the scan moves on or ends, so nothing writes to it afterwards.
    await Promise.all(inFlight);
  }
  settleCrawl();
  if (!crawlStopped) await pushSitemapCoverageIssue();
  persistProgress("checkpoint");

  // Resource checks: URLs the crawl already fetched reuse that response; URLs
  // robots.txt disallows for the crawler are skipped (skipAs names where each
  // was found); the rest run concurrently (6 at once, at most 2 per host, 1 at
  // a time against the scanned site when crawling politely).
  const siteKey = siteHostKey(startUrl);
  const checkResources = async (
    candidates: any[],
    skipAs: (candidate: any) => [RobotsSkipSource, string | undefined],
    afterCheck?: (candidate: any, result: any) => Promise<void>,
  ) => {
    const results: any[] = candidates.map((candidate) => crawledResources.get(candidate.url));
    const pendingIndexes: number[] = [];
    for (const [index, candidate] of candidates.entries()) {
      if (!results[index] && !(await skipBlocked(candidate.url, ...skipAs(candidate)))) pendingIndexes.push(index);
    }
    pendingChecks = pendingIndexes.length;
    persistProgress("phase");
    await runBounded(
      pendingIndexes,
      (index) => siteHostKey(candidates[index].url),
      (host) => (politeTarget && host === siteKey ? 1 : 2),
      async (index) => {
        const candidate = candidates[index];
        if (politeTarget && siteHostKey(candidate.url) === siteKey) await sleep(120 + Math.random() * 180, signal);
        if (signal.aborted) return;
        progressUrl = candidate.url;
        const result = await checkResource(candidate.url, signal, skipRedirectFrom(candidate.url));
        if (signal.aborted) return;
        if (afterCheck) await afterCheck(candidate, result);
        results[index] = result;
        pendingChecks -= 1;
        persistProgress();
      },
      signal,
    );
    return results;
  };

  // Reported once per affected source page, like the pages themselves.
  const pushForSources = (sourcePages: string[], issue: Omit<Parameters<typeof pushScanIssue>[1], "url">) => {
    for (const from of sourcePages) {
      pushScanIssue(issues, { ...issue, url: from, evidence: { ...issue.evidence, affectedPages: sourcePages.length } });
    }
  };

  phase = "checking links";
  const linkCandidates = [...linksToCheck.values()];
  const linkResults = await checkResources(linkCandidates, (candidate) => ["link", candidate.sources.keys().next().value]);
  for (const [index, candidate] of linkCandidates.entries()) {
    const result = linkResults[index];
    if (!result) continue;
    const sources = [...candidate.sources.values()];
    const sourcePages = sources.map((source) => source.from);
    const row = {
      url: candidate.url,
      type: candidate.type,
      anchor: candidate.anchor,
      rel: candidate.rel,
      from: sourcePages[0] || "",
      affectedPages: sourcePages.length,
      referenceCount: candidate.referenceCount,
      sourcePages,
      ...result,
    };
    checkedLinks.push(row);
    const internal = candidate.type === "internal";
    if (!row.ok) {
      const certificateFailure = row.failureKind === "tls-certificate";
      const redirectLoop = row.redirectLoop === true;
      for (const source of sources) {
        pushScanIssue(issues, {
          url: source.from,
          severity: certificateFailure ? "medium" : internal ? "high" : "medium",
          category: "links",
          type: redirectLoop
            ? "link-redirect-loop"
            : certificateFailure
              ? `${candidate.type}-link-certificate-error`
              : internal
                ? "broken-internal-link"
                : "broken-external-link",
          message: redirectLoop
            ? `${internal ? "Internal" : "External"} link has a redirect loop`
            : certificateFailure
              ? `${internal ? "Internal" : "External"} link certificate could not be verified`
              : `${internal ? "Internal" : "External"} link is failing`,
          recommendation: certificateFailure
            ? "Verify the destination certificate in a browser or another trusted client before treating the URL as unavailable."
            : redirectLoop
              ? "Fix the redirect cycle or link directly to a working final destination."
              : "Update the linked URL, remove the link, or redirect that URL to a live page.",
          evidence: {
            linkedUrl: candidate.url,
            status: row.status,
            finalStatus: row.finalStatus,
            error: row.error,
            failureKind: row.failureKind,
            redirectChain: row.redirectChain,
            affectedPages: sourcePages.length,
            totalReferences: row.referenceCount,
            referencesOnPage: source.references,
          },
        });
      }
    } else if (row.redirected || (row.finalUrl && row.finalUrl !== candidate.url)) {
      for (const source of sources) {
        pushScanIssue(issues, {
          url: source.from,
          severity: internal ? "medium" : "low",
          category: "links",
          type: internal ? "internal-link-redirects" : "external-link-redirects",
          message: `${internal ? "Internal" : "External"} link redirects with HTTP ${row.status}`,
          recommendation: "Link directly to the final destination when the redirect is permanent and intentional.",
          evidence: {
            linkedUrl: candidate.url,
            finalUrl: row.finalUrl,
            status: row.status,
            finalStatus: row.finalStatus,
            redirectChain: row.redirectChain,
            affectedPages: sourcePages.length,
            totalReferences: row.referenceCount,
            referencesOnPage: source.references,
          },
        });
      }
    }
  }
  throwIfCancelled();

  // Canonical and hreflang URLs and sitemap entries reuse every response the
  // scan already has; the rest are checked like links, within the link budget.
  phase = "checking canonical, hreflang, and sitemap links";
  const urlResponses = knownUrlResponses(crawledResources, checkedLinks, pages);
  const sitemapEntries = sitemapEntriesToAudit(sitemap.urls || [], pages, urlResponses, startUrl);
  // Each target URL once, with where it was first found.
  const targetSources = new Map<string, [RobotsSkipSource, string | undefined]>();
  const addTarget = (url: string, source: RobotsSkipSource, from?: string) => {
    if (url && !urlResponses.has(url) && !targetSources.has(url)) targetSources.set(url, [source, from]);
  };
  for (const page of pages) addTarget(canonicalTargetUrl(page), "canonical", page.url);
  for (const [from, entries] of hreflangByPage) {
    for (const entry of entries) addTarget(entry.href, "hreflang", from);
  }
  for (const url of sitemapEntries) addTarget(url, "sitemap");
  const targetUrls = [...targetSources.keys()].slice(0, limits.maxLinksToCheck);
  const targetResults = await checkResources(
    targetUrls.map((url) => ({ url })),
    (candidate) => targetSources.get(candidate.url) as [RobotsSkipSource, string | undefined],
  );
  for (const [index, url] of targetUrls.entries()) {
    if (targetResults[index]) urlResponses.set(url, targetResults[index]);
  }
  throwIfCancelled();
  const pagesByFinalUrl = htmlPagesByFinalUrl(pages);
  pushCanonicalTargetIssues(issues, pages, urlResponses, pagesByFinalUrl);
  pushHreflangIssues(issues, pages, hreflangByPage, urlResponses, pagesByFinalUrl);
  pushSitemapUrlIssues(issues, sitemapEntries, urlResponses, pagesByFinalUrl);

  const checkedImageUrls = new Set<string>();
  const checkQueuedImages = async () => {
    const candidates = [...imagesToCheck.values()].filter((candidate) => !checkedImageUrls.has(candidate.url));
    for (const candidate of candidates) checkedImageUrls.add(candidate.url);
    // Images found in a stylesheet were found on that stylesheet.
    const results = await checkResources(candidates, (candidate) => ["resource", candidate.css || candidate.from]);
    for (const [index, candidate] of candidates.entries()) {
      const result = results[index];
      if (!result) continue;
      const row = { ...candidate, affectedPages: candidate.sourcePages.length, ...result };
      checkedImages.push(row);
      const evidence = { image: candidate.url, purpose: candidate.purpose };
      if (!row.ok) {
        const certificateFailure = row.failureKind === "tls-certificate";
        pushForSources(candidate.sourcePages, {
          severity: certificateFailure ? "medium" : "high",
          category: "images",
          type: certificateFailure ? "image-certificate-error" : "broken-image",
          message: certificateFailure ? "Image certificate could not be verified" : "Image URL is failing",
          recommendation: certificateFailure
            ? "Verify the image host certificate in a trusted client before treating the image as unavailable."
            : "Replace the image URL or restore the missing image asset.",
          evidence: {
            ...evidence,
            status: row.status,
            finalStatus: row.finalStatus,
            error: row.error,
            failureKind: row.failureKind,
            redirectChain: row.redirectChain,
          },
        });
      } else if (row.redirected || (row.finalUrl && row.finalUrl !== candidate.url)) {
        pushForSources(candidate.sourcePages, {
          severity: "low",
          category: "images",
          type: "image-redirects",
          message: "Image URL redirects before loading",
          recommendation: "Point image tags directly at the final image URL to reduce request overhead.",
          evidence: { ...evidence, finalUrl: row.finalUrl, status: row.status },
        });
      } else if (row.contentType && !/^image\//i.test(row.contentType)) {
        pushForSources(candidate.sourcePages, {
          severity: "medium",
          category: "images",
          type: "image-invalid-content-type",
          message: "Image URL does not return an image content type",
          recommendation: "Fix the image source so it serves a valid image file.",
          evidence: { ...evidence, contentType: row.contentType },
        });
      } else {
        const expectedMime = expectedImageMime(candidate.url);
        if (expectedMime && row.contentType && !row.contentType.toLowerCase().includes(expectedMime)) {
          pushForSources(candidate.sourcePages, {
            severity: "low",
            category: "images",
            type: "image-extension-mismatch",
            message: "Image file extension does not match the response content type",
            recommendation: "Serve images with the correct file extension and Content-Type so browsers, caches, and crawlers classify them correctly.",
            evidence: { ...evidence, expectedMime, contentType: row.contentType },
          });
        }
        if (row.contentLength && row.contentLength > 500000) {
          pushForSources(candidate.sourcePages, {
            severity: "low",
            category: "images",
            type: "large-image",
            message: "Image file is larger than 500 KB",
            recommendation: "Compress, resize, or serve a modern responsive image.",
            evidence: { ...evidence, bytes: row.contentLength },
          });
        }
      }
    }
    throwIfCancelled();
  };

  phase = "checking images";
  await checkQueuedImages();

  phase = "checking assets";
  const assetCandidates = [...assetsToCheck.values()];
  // Background images referenced from stylesheets, found while checking CSS.
  const cssImageUrls = new Map<string, string[]>();
  const assetResults = await checkResources(assetCandidates, (candidate) => ["resource", candidate.from], async (candidate, result) => {
    if (
      candidate.type !== "css" ||
      !result.ok ||
      result.skippedRedirect ||
      (result.contentType && !/(text\/css|octet-stream|text\/plain)/i.test(result.contentType)) ||
      (result.contentLength && result.contentLength > 1000000)
    ) {
      return;
    }
    const cssResponse = await fetchText(candidate.url, 8000, { signal, skipRedirect: skipRedirectFrom(candidate.url) }).catch(() => null);
    if (cssResponse?.ok) cssImageUrls.set(candidate.url, cssUrlValues(cssResponse.text, cssResponse.url || candidate.url));
  });
  for (const [index, candidate] of assetCandidates.entries()) {
    const result = assetResults[index];
    if (!result) continue;
    const row = { ...candidate, affectedPages: candidate.sourcePages.length, ...result };
    checkedAssets.push(row);
    const assetLabel = String(candidate.type).toUpperCase();
    if (!row.ok) {
      const certificateFailure = row.failureKind === "tls-certificate";
      pushForSources(candidate.sourcePages, {
        severity: certificateFailure ? "medium" : "high",
        category: "assets",
        type: certificateFailure
          ? "asset-certificate-error"
          : candidate.type === "css"
            ? "broken-css"
            : "broken-javascript",
        message: certificateFailure
          ? `${assetLabel} asset certificate could not be verified`
          : `${assetLabel} asset is failing`,
        recommendation: certificateFailure
          ? "Verify the asset host certificate in a trusted client before treating the asset as unavailable."
          : "Restore the asset, fix the URL, or remove the reference.",
        evidence: {
          asset: candidate.url,
          status: row.status,
          finalStatus: row.finalStatus,
          error: row.error,
          failureKind: row.failureKind,
          redirectChain: row.redirectChain,
        },
      });
    } else if (candidate.type === "css" && row.contentType && !/(text\/css|octet-stream)/i.test(row.contentType)) {
      pushForSources(candidate.sourcePages, {
        severity: "medium",
        category: "assets",
        type: "css-invalid-content-type",
        message: "Stylesheet URL does not return CSS",
        recommendation: "Fix the stylesheet URL or response Content-Type.",
        evidence: { asset: candidate.url, contentType: row.contentType },
      });
    } else if (candidate.type === "js" && row.contentType && !/(javascript|ecmascript|octet-stream|text\/plain)/i.test(row.contentType)) {
      pushForSources(candidate.sourcePages, {
        severity: "medium",
        category: "assets",
        type: "javascript-invalid-content-type",
        message: "JavaScript URL does not return a script content type",
        recommendation: "Fix the script URL or response Content-Type.",
        evidence: { asset: candidate.url, contentType: row.contentType },
      });
    } else if (row.contentLength && row.contentLength > 500000) {
      pushForSources(candidate.sourcePages, {
        severity: "low",
        category: "assets",
        type: candidate.type === "css" ? "large-css" : "large-javascript",
        message: `${assetLabel} asset is larger than 500 KB`,
        recommendation: "Split, minify, compress, or defer heavy assets.",
        evidence: { asset: candidate.url, bytes: row.contentLength },
      });
    }
    for (const imageUrl of cssImageUrls.get(candidate.url) || []) {
      if (imagesToCheck.size >= limits.maxImagesToCheck || imagesToCheck.has(imageUrl)) continue;
      imagesToCheck.set(imageUrl, {
        url: imageUrl,
        from: candidate.from,
        sourcePages: candidate.sourcePages,
        purpose: "external-css-url",
        css: candidate.url,
      });
    }
  }
  throwIfCancelled();

  phase = "checking CSS images";
  await checkQueuedImages();

  phase = "deduplicating";
  // Each duplicate issue carries the group size and a bounded URL sample;
  // listing every URL on every issue would grow with the square of the group.
  const duplicateEvidence = (rows: any[]) => ({
    duplicateCount: rows.length,
    duplicates: rows.slice(0, 20).map((row) => row.url),
  });
  for (const [title, rows] of groupDuplicateValues(pages.filter((page) => page.indexable), "title")) {
    for (const page of rows) {
      pushScanIssue(issues, {
        url: page.url,
        severity: "medium",
        category: "metadata",
        type: "duplicate-title",
        message: "Duplicate title tag",
        recommendation: "Write a unique title for each indexable page.",
        evidence: { title, ...duplicateEvidence(rows) },
      });
    }
  }
  for (const [description, rows] of groupDuplicateValues(pages.filter((page) => page.indexable), "description")) {
    for (const page of rows) {
      pushScanIssue(issues, {
        url: page.url,
        severity: "low",
        category: "metadata",
        type: "duplicate-description",
        message: "Duplicate meta description",
        recommendation: "Write a unique description for each important page.",
        evidence: { description, ...duplicateEvidence(rows) },
      });
    }
  }
  for (const [h1, rows] of groupDuplicateValues(pages.filter((page) => page.indexable), "h1")) {
    if (!firstH1Fingerprint(h1)) continue;
    for (const page of rows) {
      pushScanIssue(issues, {
        url: page.url,
        severity: "low",
        category: "headings",
        type: "duplicate-h1",
        message: "Duplicate H1 across multiple pages",
        recommendation: "Use a distinct H1 that reflects the unique purpose of each page.",
        evidence: { h1, ...duplicateEvidence(rows) },
      });
    }
  }
  for (const [, rows] of groupDuplicateValues(pages.filter((page) => page.indexable && page.wordCount >= 120), "contentFingerprint")) {
    for (const page of rows) {
      pushScanIssue(issues, {
        url: page.url,
        severity: "medium",
        category: "content",
        type: "duplicate-content",
        message: "Page body content is duplicated",
        recommendation: "Canonicalize, consolidate, or rewrite duplicate pages so each important URL has a distinct purpose.",
        evidence: duplicateEvidence(rows),
      });
    }
  }
  pushNearDuplicateIssues(issues, pages);
  pushRobotsBlockedIssues(issues, pages, skippedPageUrls, sitemap.urls || [], robotsCheck, robots.url);
  if (sitemapUrlSet.size > 0) {
    for (const page of pages.filter((item) => item.indexable)) {
      if (!sitemapUrlSet.has(normalizedUrlKey(page.finalUrl || page.url)) && !sitemapUrlSet.has(normalizedUrlKey(page.url))) {
        pushScanIssue(issues, {
          url: page.url,
          severity: "low",
          category: "sitemap",
          type: "page-missing-from-sitemap",
          message: "Indexable crawled page is missing from sitemap",
          recommendation: "Add important indexable pages to the XML sitemap.",
        });
      }
    }
    for (const page of pages.filter((item) => item.indexabilityReason === "noindex")) {
      if (sitemapUrlSet.has(normalizedUrlKey(page.finalUrl || page.url)) || sitemapUrlSet.has(normalizedUrlKey(page.url))) {
        pushScanIssue(issues, {
          url: page.url,
          severity: "medium",
          category: "sitemap",
          type: "noindex-page-in-sitemap",
          message: "Noindex page is listed in the sitemap",
          recommendation: "Remove non-indexable pages from XML sitemaps.",
        });
      }
    }
  }
  for (const page of pages.filter((item) => item.indexable && item.discovery === "sitemap" && Number(item.internalInlinks || 0) === 0)) {
    if (normalizedUrlKey(page.url) === normalizedUrlKey(startUrl)) continue;
    pushScanIssue(issues, {
      url: page.url,
      severity: "medium",
      category: "crawl",
      type: "orphan-page",
      message: "Indexable page was found from the sitemap but has no internal inlinks",
      recommendation: "Add internal links from relevant pages so users and crawlers can discover this URL naturally.",
      evidence: { discovery: page.discovery, sitemapListed: page.sitemapListed },
    });
  }
  // Failed pages have rows, but a scan where nothing answered has no evidence.
  // A crawl robots.txt stopped already has a site-level issue saying why.
  if (!crawlStopped && !pages.some((page) => !page.error)) {
    pushScanIssue(issues, {
      url: startUrl,
      severity: "high",
      category: "crawl",
      type: "no-pages-crawled",
      message: "No HTML pages were crawled",
      recommendation: "Check the scan URL, redirects, DNS, TLS, firewall rules, and whether the URL returns crawlable HTML.",
      evidence: {
        visitedUrls: visited.size,
        failedPages: pages.length,
        sitemapUrls: (sitemap.urls || []).length,
        checkedLinks: checkedLinks.length,
        checkedImages: checkedImages.length,
        checkedAssets: checkedAssets.length,
        robotsSkipped: robotsSkipped.count,
      },
    });
  }

  phase = "completed";
  const score = healthScore(pages, issues);
  const comparison = buildScanComparison(previousCompletedScan(scan.site_id, scanId, startUrl), pages, issues, limits);
  saveScanResult(scanId, scan.site_id, "completed", score, currentResult(comparison));
}
