import { get } from "./db";
import { gscPageData } from "./gsc-pages";
import { activeIssues, issueCounts, pagesWithoutHighIssues, requireScan, SEVERITIES, scanIssueGroups } from "./scan-summary";

// A single self-contained HTML report for one saved scan, for sharing with a
// client: inline CSS, no scripts or external assets, print friendly. Every
// value comes from the saved scan (and stored Search Console rows, when any);
// every piece of text is HTML-escaped.

const EXAMPLE_URLS = 10;
const TOP_GSC_PAGES = 10;

function esc(value: unknown) {
  return String(value ?? "").replace(
    /[&<>"']/g,
    (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char] as string,
  );
}

// SQLite CURRENT_TIMESTAMP values are UTC without a zone.
function parseTime(value: unknown) {
  const text = String(value || "");
  const date = new Date(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(text) ? `${text.replace(" ", "T")}Z` : text);
  return Number.isNaN(date.getTime()) ? null : date;
}

function formatTime(value: unknown) {
  const date = parseTime(value);
  if (!date) return "Unknown";
  return `${date.toLocaleString("en-GB", { dateStyle: "medium", timeStyle: "short", timeZone: "UTC" })} UTC`;
}

function formatDuration(start: unknown, end: unknown) {
  const from = parseTime(start);
  const to = parseTime(end);
  if (!from || !to || to < from) return "Unknown";
  const seconds = Math.round((to.getTime() - from.getTime()) / 1000);
  const minutes = Math.floor(seconds / 60);
  return minutes ? `${minutes} min ${seconds % 60} s` : `${seconds} s`;
}

function formatNumber(value: unknown) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.round(number).toLocaleString("en-US") : "—";
}

function label(value: string) {
  const text = value.replaceAll("-", " ");
  return text.charAt(0).toUpperCase() + text.slice(1);
}

function urlText(url: string) {
  return /^https?:\/\//i.test(url) ? `<a href="${esc(url)}">${esc(url)}</a>` : esc(url);
}

const COMPARISON_REASONS: Record<string, string> = {
  "no-previous-scan": "This is the first completed scan of this start URL, so there is nothing to compare with yet.",
  "incompatible-version": "The previous scan was made by an older crawler version, so the two are not compared.",
  "scope-changed": "The previous scan used a different page limit, so the two are not compared.",
};

function regressionsSection(scan: any) {
  const comparison = scan.result?.comparison;
  if (!comparison) return `<p class="muted">No comparison was saved with this scan.</p>`;
  if (!comparison.available) {
    return `<p class="muted">${esc(COMPARISON_REASONS[comparison.reason] || "No comparable previous scan.")}</p>`;
  }
  const regressions = comparison.regressions || {};
  const since = `the previous scan on ${esc(formatTime(comparison.previousCreatedAt))}`;
  if (!regressions.total) return `<p>No regressions compared with ${since}.</p>`;
  const counts = [
    ["New high-severity issues", regressions.newHighIssues],
    ["New medium-severity issues", regressions.newMediumIssues],
    ["Pages that became non-indexable", regressions.becameNonIndexable],
    ["Pages that stopped answering HTTP 200", regressions.becameNon200],
  ]
    .map(([name, count]) => `<tr><th scope="row">${esc(name)}</th><td class="num">${formatNumber(count)}</td></tr>`)
    .join("");
  const pages = (regressions.pages || [])
    .map(
      (row: any) =>
        `<tr><td class="url">${urlText(String(row.url || ""))}</td><td>${esc(label(String(row.change || "")))}</td><td>${esc(row.before)} → ${esc(row.after)}</td></tr>`,
    )
    .join("");
  return `
    <p>${formatNumber(regressions.total)} regressions compared with ${since}.</p>
    <table class="compact"><tbody>${counts}</tbody></table>
    ${pages ? `<table><thead><tr><th>Page</th><th>Change</th><th>Before → after</th></tr></thead><tbody>${pages}</tbody></table>` : ""}
  `;
}

function searchConsoleSection(siteId: string) {
  const gsc = gscPageData(siteId, null, { allowQueryRows: true });
  if (!gsc?.pages.size) return "";
  const pages = [...gsc.pages.values()];
  const clicks = pages.reduce((sum, page) => sum + (page.clicks ?? 0), 0);
  const impressions = pages.reduce((sum, page) => sum + (page.impressions ?? 0), 0);
  const top = pages
    .sort((a, b) => (b.clicks ?? 0) - (a.clicks ?? 0) || (b.impressions ?? 0) - (a.impressions ?? 0))
    .slice(0, TOP_GSC_PAGES)
    .map(
      (page) =>
        `<tr><td class="url">${urlText(page.url)}</td><td class="num">${formatNumber(page.clicks)}</td><td class="num">${formatNumber(page.impressions)}</td><td class="num">${page.position === null ? "—" : esc(page.position.toFixed(1))}</td></tr>`,
    )
    .join("");
  const range =
    gsc.range.startDate && gsc.range.endDate
      ? `${esc(gsc.range.startDate)} to ${esc(gsc.range.endDate)}`
      : "date range not recorded for this import";
  const source = gsc.source === "api" ? "Search Console API sync" : "Search Console CSV import";
  return `
    <section>
      <h2>Search Console</h2>
      <p class="muted">${range} · ${esc(source)} · imported ${esc(formatTime(gsc.record.created_at))}</p>
      ${gsc.fromQueryRows ? `<p class="muted">Totals are summed from query + page rows, which leave out anonymized queries, so they can be lower than Search Console's own page report.</p>` : ""}
      <div class="cards">
        <div class="card"><span class="value">${formatNumber(clicks)}</span><span class="name">Clicks</span></div>
        <div class="card"><span class="value">${formatNumber(impressions)}</span><span class="name">Impressions</span></div>
        <div class="card"><span class="value">${impressions ? esc(`${((100 * clicks) / impressions).toFixed(1)}%`) : "—"}</span><span class="name">Click-through rate</span></div>
      </div>
      <h3>Top pages by clicks</h3>
      <table><thead><tr><th>Page</th><th class="num">Clicks</th><th class="num">Impressions</th><th class="num">Avg. position</th></tr></thead><tbody>${top}</tbody></table>
    </section>
  `;
}

const STYLE = `
  :root { color-scheme: light; }
  * { box-sizing: border-box; }
  body { margin: 0; background: #fff; color: #1f2328; font: 14px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; }
  main { max-width: 960px; margin: 0 auto; padding: 32px 20px 48px; }
  header { border-bottom: 2px solid #1f2328; padding-bottom: 16px; margin-bottom: 24px; }
  h1 { font-size: 26px; margin: 0 0 4px; }
  h2 { font-size: 19px; margin: 32px 0 12px; padding-bottom: 6px; border-bottom: 1px solid #d0d7de; }
  h3 { font-size: 15px; margin: 18px 0 8px; }
  p { margin: 6px 0; }
  a { color: #0b57d0; }
  .muted { color: #59636e; }
  .meta { display: grid; grid-template-columns: max-content 1fr; gap: 2px 16px; margin: 12px 0 0; }
  .meta dt { color: #59636e; }
  .meta dd { margin: 0; overflow-wrap: anywhere; }
  .cards { display: grid; grid-template-columns: repeat(auto-fit, minmax(170px, 1fr)); gap: 12px; margin: 12px 0; }
  .card { border: 1px solid #d0d7de; border-radius: 8px; padding: 12px 14px; }
  .card .value { display: block; font-size: 24px; font-weight: 650; }
  .card .name { color: #59636e; font-size: 12px; text-transform: uppercase; letter-spacing: .04em; }
  table { width: 100%; border-collapse: collapse; margin: 8px 0 12px; }
  th, td { text-align: left; vertical-align: top; padding: 6px 8px; border-bottom: 1px solid #e6e9ed; }
  thead th { font-size: 12px; color: #59636e; text-transform: uppercase; letter-spacing: .04em; }
  table.compact { width: auto; min-width: 320px; }
  .num { text-align: right; white-space: nowrap; font-variant-numeric: tabular-nums; }
  .url { overflow-wrap: anywhere; word-break: break-word; }
  .sev { display: inline-block; border-radius: 999px; padding: 0 8px; font-size: 12px; font-weight: 600; }
  .sev-high { background: #ffe1e0; color: #a40e26; }
  .sev-medium { background: #fff1c9; color: #7a4d00; }
  .sev-low { background: #eaeef2; color: #424a53; }
  .group { border: 1px solid #d0d7de; border-radius: 8px; padding: 12px 16px; margin: 12px 0; }
  .group h3 { margin: 0 0 4px; display: flex; gap: 8px; align-items: baseline; flex-wrap: wrap; }
  .group ul { margin: 6px 0 0; padding-left: 20px; }
  .group li { overflow-wrap: anywhere; }
  footer { margin-top: 40px; padding-top: 12px; border-top: 1px solid #d0d7de; color: #59636e; font-size: 12px; }
  @media print {
    body { font-size: 10.5pt; }
    main { max-width: none; padding: 0; }
    a { color: inherit; text-decoration: none; }
    h2 { break-after: avoid; }
    .group, .card, tr { break-inside: avoid; }
    @page { margin: 16mm 14mm; }
  }
`;

export function scanReport(scanId: string) {
  const scan = requireScan(scanId);
  const site = get<{ name: string; domain: string }>("SELECT name, domain FROM sites WHERE id = ?", [scan.site_id]);
  const siteName = site?.name || site?.domain || "Site";
  const issues = activeIssues(scan);
  const counts = issueCounts(issues);
  const health = pagesWithoutHighIssues(scan);
  const groups = scanIssueGroups(issues, EXAMPLE_URLS);
  const maxPages = scan.result?.limits?.maxPages;
  const startUrl = String(scan.result?.startUrl || scan.url || "");

  const severityRows = SEVERITIES.map(
    (severity) =>
      `<tr><th scope="row"><span class="sev sev-${severity}">${esc(label(severity))}</span></th><td class="num">${formatNumber(counts.bySeverity[severity] || 0)}</td></tr>`,
  ).join("");
  const categoryRows = Object.entries(counts.byCategory)
    .sort((a, b) => b[1] - a[1])
    .map(([category, count]) => `<tr><th scope="row">${esc(label(category))}</th><td class="num">${formatNumber(count)}</td></tr>`)
    .join("");
  const groupBlocks = groups
    .map(
      (group) => `
      <div class="group">
        <h3><span class="sev sev-${esc(group.severity)}">${esc(label(group.severity))}</span> ${esc(group.title)}</h3>
        <p class="muted">${esc(label(group.category))} · ${formatNumber(group.pages)} ${group.pages === 1 ? "page" : "pages"} affected · ${formatNumber(group.issues)} ${group.issues === 1 ? "finding" : "findings"}</p>
        ${group.why ? `<p><strong>Why it matters:</strong> ${esc(group.why)}</p>` : ""}
        ${group.fix ? `<p><strong>How to fix:</strong> ${esc(group.fix)}</p>` : ""}
        ${group.examples.length ? `<ul>${group.examples.map((url: string) => `<li class="url">${urlText(url)}</li>`).join("")}</ul>` : ""}
        ${group.pages > group.examples.length ? `<p class="muted">and ${formatNumber(group.pages - group.examples.length)} more</p>` : ""}
      </div>`,
    )
    .join("");
  const gscSection = searchConsoleSection(scan.site_id);

  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>SEO scan report · ${esc(siteName)} · ${esc(formatTime(scan.created_at))}</title>
<style>${STYLE}</style>
</head>
<body>
<main>
  <header>
    <h1>SEO scan report</h1>
    <p class="muted">${esc(siteName)}</p>
    <dl class="meta">
      <dt>Site</dt><dd>${esc(site?.domain || "—")}</dd>
      <dt>Start URL</dt><dd>${urlText(startUrl)}</dd>
      <dt>Scanned</dt><dd>${esc(formatTime(scan.created_at))}</dd>
      <dt>Duration</dt><dd>${esc(formatDuration(scan.created_at, scan.updated_at))}</dd>
      <dt>Status</dt><dd>${esc(label(String(scan.status || "")))}</dd>
    </dl>
  </header>

  <section>
    <h2>Summary</h2>
    <div class="cards">
      <div class="card"><span class="value">${formatNumber(scan.pages_crawled)}${maxPages ? ` <span class="muted">/ ${formatNumber(maxPages)}</span>` : ""}</span><span class="name">Pages crawled${maxPages ? " / page limit" : ""}</span></div>
      <div class="card"><span class="value">${health ? `${health.percent}%` : "—"}</span><span class="name">Pages without high-severity issues</span></div>
      <div class="card"><span class="value">${formatNumber(counts.total)}</span><span class="name">Open issues</span></div>
      <div class="card"><span class="value">${formatNumber(scan.ignored_issue_count || 0)}</span><span class="name">Ignored issues</span></div>
    </div>
    ${health ? `<p class="muted">${formatNumber(health.withoutHighIssues)} of ${formatNumber(health.pages)} crawled pages have no open high-severity issue.</p>` : ""}
    ${maxPages && Number(scan.pages_crawled) >= Number(maxPages) ? `<p class="muted">The crawl reached its ${formatNumber(maxPages)}-page limit; pages beyond it were not checked.</p>` : ""}
  </section>

  <section>
    <h2>Open issues</h2>
    <h3>By severity</h3>
    <table class="compact"><tbody>${severityRows}</tbody></table>
    ${categoryRows ? `<h3>By category</h3><table class="compact"><tbody>${categoryRows}</tbody></table>` : ""}
  </section>

  <section>
    <h2>Issues to address</h2>
    ${groupBlocks || `<p>No open issues were found in this scan.</p>`}
  </section>

  <section>
    <h2>Changes since the previous scan</h2>
    ${regressionsSection(scan)}
  </section>
  ${gscSection}
  <footer>Generated ${esc(formatTime(new Date().toISOString()))} by Local SEO from the saved crawl${gscSection ? " and stored Search Console data" : ""}. Ignored issues are left out of issue counts.</footer>
</main>
</body>
</html>
`;
  const slug = (site?.domain || siteName).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "site";
  const day = (parseTime(scan.created_at)?.toISOString() || "").slice(0, 10) || "scan";
  return { html, filename: `seo-report-${slug}-${day}.html` };
}
