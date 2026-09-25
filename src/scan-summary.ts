import { get, jsonParse } from "./db";
import { badRequest, notFound } from "./errors";
import { pageUrlKey } from "./page-url";
import { getScan, scanIssueTypes } from "./scans";

// Read-only views of saved scans shared by the report, the Codex context,
// Search Console insights, PageSpeed defaults, and MCP tools.

const severityRank: Record<string, number> = { high: 3, medium: 2, low: 1 };
export const SEVERITIES = ["high", "medium", "low"] as const;

// A saved scan with ignore rules applied (ignored issues carry ignored: true).
export function requireScan(scanId: string) {
  const scan = getScan(scanId);
  if (!scan) throw notFound("Scan not found.");
  return scan;
}

// The raw saved crawl evidence (pages, sitemap, limits) without ignore rules,
// for analyses that do not read issues.
function readScanEvidence(scanId: string) {
  const row = get<any>(
    `SELECT scans.id, scans.site_id, scans.url, scans.status, scans.created_at, scans.updated_at, scan_results.result_json
     FROM scans LEFT JOIN scan_results ON scan_results.scan_id = scans.id WHERE scans.id = ?`,
    [scanId],
  );
  if (!row) return null;
  const { result_json, ...rest } = row;
  return { ...rest, result: jsonParse<any>(result_json, null) };
}

// The site's newest completed scan, or the newest one saved before beforeScanId.
export function latestCompletedScanId(siteId: string, beforeScanId?: string) {
  const row = beforeScanId
    ? get<{ id: string }>(
        "SELECT id FROM scans WHERE site_id = ? AND status = 'completed' AND rowid < (SELECT rowid FROM scans WHERE id = ?) ORDER BY rowid DESC LIMIT 1",
        [siteId, beforeScanId],
      )
    : get<{ id: string }>("SELECT id FROM scans WHERE site_id = ? AND status = 'completed' ORDER BY rowid DESC LIMIT 1", [
        siteId,
      ]);
  return row?.id ?? null;
}

// The scan an analysis reads: the one asked for (it must belong to the site
// and be completed), else the site's latest completed scan, else null.
export function siteCompletedScan(siteId: string, scanId?: string) {
  if (scanId) {
    const scan = readScanEvidence(scanId);
    if (!scan || scan.site_id !== siteId) throw notFound("Scan not found.");
    if (scan.status !== "completed") throw badRequest(`That scan is ${scan.status}; choose a completed scan.`);
    return scan;
  }
  const latestId = latestCompletedScanId(siteId);
  return latestId ? readScanEvidence(latestId) : null;
}

export function scanPages(scan: any): any[] {
  return Array.isArray(scan?.result?.pages) ? scan.result.pages : [];
}

export function activeIssues(scan: any): any[] {
  return (Array.isArray(scan?.result?.issues) ? scan.result.issues : []).filter((issue: any) => !issue.ignored);
}

// Crawled HTML pages that answered 200 and are indexable.
export function indexableHtmlPages(scan: any) {
  return scanPages(scan).filter(
    (page) => page.indexable === true && Number(page.status) === 200 && page.isHtml !== false,
  );
}

// Issue groups named and explained by the issue-type catalog, most severe
// first. `pages` counts distinct URLs, `issues` every finding.
export function scanIssueGroups(issues: any[], exampleLimit: number) {
  const groups = new Map<string, any>();
  for (const issue of issues) {
    const type = String(issue.type || "");
    const info = scanIssueTypes[type];
    let group = groups.get(type);
    if (!group) {
      group = {
        type,
        category: info?.category || issue.category || "",
        severity: issue.severity || info?.severity || "low",
        title: info?.title || issue.message || type,
        why: info?.why || "",
        fix: info?.fix || issue.recommendation || "",
        issues: 0,
        urls: new Set<string>(),
        examples: [] as string[],
      };
      groups.set(type, group);
    }
    group.issues += 1;
    if ((severityRank[issue.severity] || 0) > (severityRank[group.severity] || 0)) group.severity = issue.severity;
    if (issue.url && !group.urls.has(issue.url)) {
      group.urls.add(issue.url);
      if (group.examples.length < exampleLimit) group.examples.push(issue.url);
    }
  }
  return [...groups.values()]
    .map(({ urls, ...group }) => ({ ...group, pages: urls.size }))
    .sort(
      (a, b) =>
        (severityRank[b.severity] || 0) - (severityRank[a.severity] || 0) || b.pages - a.pages || b.issues - a.issues,
    );
}

export function issueCounts(issues: any[]) {
  const bySeverity = { high: 0, medium: 0, low: 0 } as Record<string, number>;
  const byCategory: Record<string, number> = {};
  for (const issue of issues) {
    bySeverity[issue.severity] = (bySeverity[issue.severity] || 0) + 1;
    const category = String(issue.category || "other");
    byCategory[category] = (byCategory[category] || 0) + 1;
  }
  return { total: issues.length, bySeverity, byCategory };
}

// Share of crawled pages with no open high-severity issue.
export function pagesWithoutHighIssues(scan: any) {
  const pages = scanPages(scan);
  if (!pages.length) return null;
  const pageKeys = new Set(pages.map((page) => pageUrlKey(String(page.url || ""))));
  const highPages = new Set<string>();
  for (const issue of activeIssues(scan)) {
    const key = pageUrlKey(String(issue.url || ""));
    if (issue.severity === "high" && pageKeys.has(key)) highPages.add(key);
  }
  const clean = pages.length - highPages.size;
  return { pages: pages.length, withoutHighIssues: clean, percent: Math.round((100 * clean) / pages.length) };
}

function comparisonOverview(comparison: any) {
  if (!comparison) return null;
  return {
    available: Boolean(comparison.available),
    ...(comparison.reason ? { reason: comparison.reason } : {}),
    previousScanId: comparison.previousScanId ?? null,
    previousCreatedAt: comparison.previousCreatedAt ?? null,
    summary: comparison.summary ?? null,
    regressions: comparison.regressions ?? null,
  };
}

// Scan row plus its crawl summary, regressions, and issue groups — without
// the per-page, per-issue, link, and image arrays.
export function scanOverview(scan: any, exampleLimit = 5) {
  const { result, ...row } = scan;
  return {
    ...row,
    result: result
      ? {
          scanVersion: result.scanVersion ?? null,
          phase: result.phase || "",
          startUrl: result.startUrl || null,
          limits: result.limits || null,
          summary: result.summary || null,
          progress: result.progress || null,
        }
      : null,
    comparison: comparisonOverview(result?.comparison),
    issueGroups: scanIssueGroups(activeIssues(scan), exampleLimit),
  };
}

// Issue rows filtered and paged for MCP clients.
export function queryScanIssues(
  scan: any,
  input: { severity?: string; category?: string; type?: string; url?: string; includeIgnored?: boolean; limit: number; offset: number },
) {
  const urlText = String(input.url || "").toLowerCase();
  const issues = (Array.isArray(scan.result?.issues) ? scan.result.issues : []).filter(
    (issue: any) =>
      (input.includeIgnored || !issue.ignored) &&
      (!input.severity || issue.severity === input.severity) &&
      (!input.category || issue.category === input.category) &&
      (!input.type || issue.type === input.type) &&
      (!urlText || String(issue.url || "").toLowerCase().includes(urlText)),
  );
  const rows = issues.slice(input.offset, input.offset + input.limit);
  return {
    scanId: scan.id,
    total: issues.length,
    limit: input.limit,
    offset: input.offset,
    hasMore: input.offset + rows.length < issues.length,
    rows,
  };
}

const AI_CONTEXT_MAX_CHARS = 6000;

function clip(value: unknown, max = 160) {
  const text = String(value ?? "");
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

// Compact plain-text brief of one scan for a Codex prioritisation prompt.
export function scanAiContext(scanId: string) {
  const scan = requireScan(scanId);
  const site = get<{ name: string; domain: string }>("SELECT name, domain FROM sites WHERE id = ?", [scan.site_id]);
  const issues = activeIssues(scan);
  const counts = issueCounts(issues);
  const health = pagesWithoutHighIssues(scan);
  const limits = scan.result?.limits;
  const regressions = scan.result?.comparison?.available ? scan.result.comparison.regressions : null;
  const lines = [
    `Site: ${clip(site?.name)} (${clip(site?.domain || scan.url)})`,
    `Scan: ${clip(scan.url)} on ${scan.created_at} UTC, status ${scan.status}.`,
    `Pages crawled: ${scan.pages_crawled}${limits?.maxPages ? ` of a ${limits.maxPages}-page limit` : ""}.`,
    health ? `Pages without high-severity issues: ${health.withoutHighIssues} of ${health.pages} (${health.percent}%).` : null,
    `Open issues: ${counts.total} (high ${counts.bySeverity.high}, medium ${counts.bySeverity.medium}, low ${counts.bySeverity.low}); ignored: ${scan.ignored_issue_count || 0}.`,
    regressions
      ? `Regressions since the previous scan: ${regressions.total} (new high issues ${regressions.newHighIssues}, new medium issues ${regressions.newMediumIssues}, pages that became non-indexable ${regressions.becameNonIndexable}, pages that stopped answering 200 ${regressions.becameNon200}).`
      : "Regressions since the previous scan: no comparable previous scan.",
    ...(regressions?.pages || [])
      .slice(0, 5)
      .map((row: any) => `- ${row.change}: ${clip(row.url)} (${clip(row.before, 40)} -> ${clip(row.after, 40)})`),
    "",
    "Issue groups (severity, pages affected, findings, example URLs):",
  ];
  let text = lines.filter((line) => line !== null).join("\n");
  let omitted = 0;
  for (const group of scanIssueGroups(issues, 3)) {
    const block = [
      `- [${group.severity}] ${group.title} (${group.type}, ${group.category}): ${group.pages} pages, ${group.issues} findings.`,
      group.fix ? `  Fix: ${clip(group.fix, 200)}` : "",
      ...group.examples.map((url: string) => `  e.g. ${clip(url)}`),
    ]
      .filter(Boolean)
      .join("\n");
    if (text.length + block.length + 80 > AI_CONTEXT_MAX_CHARS) {
      omitted += 1;
      continue;
    }
    text += `\n${block}`;
  }
  if (omitted) text += `\n(${omitted} smaller issue groups omitted for length.)`;
  return { scanId: scan.id, siteId: scan.site_id, text };
}
