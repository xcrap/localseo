import { useMemo, useState } from "react";
import { Download } from "lucide-react";
import { Badge, Button, Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui";
import { CountUp, EmptyState, JsonBlock, MetricTile, MetricTileGrid, ReportSection, StatusDot, StatusEvidenceTable, downloadFile, fileSlug, formatDate, formatMs, formatNumber, scanCoverageMetrics } from "../../shared";
import { FilteredRows } from "../../data-table";
import { ScanSection } from "./common";
import { ScanIssuesTable } from "./issues";
import { RobotsGroups, RobotsTester, softNotFoundEvidenceRow } from "./robots";
import type { IssueCatalog } from "./issue-catalog";
import { ScanAssetsTable, ScanSpeedPagesTable, pageCsvColumns, pageSortValues, speedVariant } from "./tables";

export function ScanRedirectImpact({ coverage, links }: { coverage: ReturnType<typeof scanCoverageMetrics>; links: any[] }) {
  const redirectingTargets = links.filter(
    (link: any) => link.redirected || (link.finalUrl && link.finalUrl !== link.url),
  );
  const referenceHint = coverage.redirectImpactComplete
    ? "All matching anchor occurrences, aggregated before inventory caps"
    : "Matching occurrences retained by this older scan; rescan for a complete count";
  return (
    <ScanSection title="Redirect blast radius" text="Unique redirecting targets, affected source pages, and total link references are counted separately.">
      <MetricTileGrid>
        <MetricTile label="Redirecting targets" value={<CountUp value={coverage.redirectedLinkTargets} />} tone={coverage.redirectedLinkTargets ? "warn" : "default"} hint="Unique checked URLs that redirect" />
        <MetricTile label="Affected pages" value={<CountUp value={coverage.redirectedLinkPages} />} tone={coverage.redirectedLinkPages ? "warn" : "default"} hint="Distinct crawled pages linking to those targets" />
        <MetricTile label="Link references" value={<CountUp value={coverage.redirectedLinkReferences} />} tone={coverage.redirectedLinkReferences ? "warn" : "default"} hint={referenceHint} />
        <MetricTile label="Longest chain" value={<CountUp value={redirectingTargets.reduce((max: number, link: any) => Math.max(max, Number(link.redirectChain?.length || 0)), 0)} />} hint="Maximum recorded HTTP redirect hops" />
      </MetricTileGrid>
    </ScanSection>
  );
}

export function ScanCrawlEvidence({
  result,
  coverage,
  siteId,
  startUrl,
}: {
  result: any;
  coverage: ReturnType<typeof scanCoverageMetrics>;
  siteId?: string | null;
  startUrl: string;
}) {
  const sitemapRows = Array.isArray(result.sitemap?.sitemaps) ? result.sitemap.sitemaps : [];
  const evidenceRows = [
    {
      area: "Robots.txt",
      status: result.robots?.exists ? "Found" : "Missing",
      tone: result.robots?.exists ? "good" : "warn",
      evidence: result.robots?.url || `${result.origin || result.startUrl || ""}/robots.txt`,
    },
    {
      area: "Disallow rules",
      status: formatNumber(result.robots?.disallowCount || 0),
      tone: "outline",
      evidence: "Rules discovered in robots.txt.",
    },
    {
      area: "Sitemaps declared",
      status: formatNumber(result.robots?.sitemaps?.length || 0),
      tone: result.robots?.sitemaps?.length ? "good" : "warn",
      evidence: result.robots?.sitemaps?.length ? result.robots.sitemaps.join(", ") : "No sitemap directive found in robots.txt.",
    },
    {
      area: "Sitemap URLs found",
      status: formatNumber(result.sitemap?.urls?.length || 0),
      tone: result.sitemap?.urls?.length ? "good" : "warn",
      evidence: "URLs loaded from sitemap files and used for crawl discovery.",
    },
  ];
  const coverageRows = [
    { metric: "Pages crawled", count: coverage.pages, detail: `${formatNumber(coverage.sitemapUrls)} sitemap-listed pages` },
    { metric: "Indexable pages", count: coverage.indexablePages, detail: `${formatNumber(coverage.nonIndexablePages)} noindex/non-indexable · ${formatNumber(coverage.unknownIndexabilityPages)} unknown` },
    { metric: "Missing from sitemap", count: coverage.pagesMissingFromSitemap, detail: "Indexable crawled pages not listed in XML sitemaps", problem: true },
    { metric: "Noindex in sitemap", count: coverage.noindexPagesInSitemap, detail: "Non-indexable pages that still appear in XML sitemaps", problem: true },
    { metric: "Orphan pages", count: coverage.orphanPages, detail: "Sitemap-discovered pages with no internal inlinks", problem: true },
    { metric: "Deep pages", count: coverage.deepPages, detail: "Pages at crawl depth 4 or deeper", problem: true },
    { metric: "Link tags found", count: coverage.linkTags, detail: `${formatNumber(coverage.checkedLinks)} unique link URLs checked` },
    { metric: "Parameterized URLs", count: coverage.parameterUrls, detail: `${formatNumber(coverage.parameterUrlTargets)} clean page targets. Query variants are checked as links, not counted as separate pages.` },
    { metric: "Image tags found", count: coverage.imageTags, detail: `${formatNumber(coverage.checkedImages)} image URLs checked` },
    { metric: "CSS/JS refs found", count: coverage.assetTags, detail: `${formatNumber(coverage.checkedAssets)} CSS/JS assets checked` },
  ];
  return (
    <div className="space-y-4">
      <ReportSection title="Robots and sitemap evidence" description="What the crawler actually discovered before and during the page crawl.">
        <StatusEvidenceTable
          rows={[
            ...evidenceRows.map((row) => ({
              title: row.area,
              status: row.status,
              tone: row.tone as any,
              text: <span className="break-all">{row.evidence}</span>,
            })),
            softNotFoundEvidenceRow(result),
          ]}
        />
      </ReportSection>

      <RobotsGroups robots={result.robots} />

      <RobotsTester siteId={siteId} startUrl={startUrl} />

      <ReportSection title="Sitemap files" description="Each sitemap file fetched and parsed during the scan.">
        {sitemapRows.length ? (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Sitemap</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Type</TableHead>
                <TableHead>URLs</TableHead>
                <TableHead>Child sitemaps</TableHead>
                <TableHead>Error</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {sitemapRows.map((sitemap: any) => (
                <TableRow key={sitemap.url}>
                  <TableCell className="min-w-96 break-all font-medium">{sitemap.url}</TableCell>
                  <TableCell><Badge variant={sitemap.ok === false ? "bad" : "good"}>{sitemap.status || "-"}</Badge></TableCell>
                  <TableCell><Badge variant="outline">{sitemap.type || "-"}</Badge></TableCell>
                  <TableCell className="nums text-lg font-semibold">{formatNumber(sitemap.urlCount || 0)}</TableCell>
                  <TableCell className="nums">{formatNumber(sitemap.childSitemapCount || 0)}</TableCell>
                  <TableCell className="max-w-md break-all text-sm text-muted-foreground">{sitemap.error || "-"}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        ) : (
          <EmptyState title="No sitemap files parsed" text="The crawler did not find a sitemap file for this scan." />
        )}
      </ReportSection>

      <ReportSection title="Crawl coverage" description="Page discovery, indexability, sitemap fit, and resource inventory from this scan.">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Metric</TableHead>
              <TableHead>Count</TableHead>
              <TableHead>Status</TableHead>
              <TableHead>Evidence</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {coverageRows.map((row) => {
              const count = Number(row.count || 0);
              const tone = row.problem ? (count ? "warn" : "good") : "outline";
              return (
                <TableRow key={row.metric}>
                  <TableCell className="font-medium">{row.metric}</TableCell>
                  <TableCell className="metric text-lg">{formatNumber(row.count)}</TableCell>
                  <TableCell>
                    <span className="inline-flex items-center gap-1.5 whitespace-nowrap text-sm">
                      <StatusDot tone={tone as any} />
                      {row.problem ? (count ? "inspect" : "clear") : "measured"}
                    </span>
                  </TableCell>
                  <TableCell className="min-w-96 text-sm text-muted-foreground">{row.detail}</TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      </ReportSection>
    </div>
  );
}

const speedIssueTypes = [
  "slow-page",
  "page-response-slow",
  "viewport-missing",
  "viewport-not-responsive",
  "heavy-html",
  "html-compression-missing",
  "image-lazy-loading-missing",
  "broken-css",
  "broken-javascript",
  "css-invalid-content-type",
  "javascript-invalid-content-type",
  "large-css",
  "large-javascript",
  "render-blocking-javascript",
  "too-many-assets",
];

export function ScanSpeedReport({
  pages,
  issues,
  assets,
  summary,
  coverage,
  catalog,
  onOpenPage,
}: {
  pages: any[];
  issues: any[];
  assets: any[];
  summary: any;
  coverage: ReturnType<typeof scanCoverageMetrics>;
  catalog: IssueCatalog;
  onOpenPage: (url: string) => void;
}) {
  const timedPages = useMemo(
    () =>
      [...pages]
        .filter((page) => Number.isFinite(Number(page.loadMs)))
        .sort((a, b) => Number(b.loadMs || 0) - Number(a.loadMs || 0)),
    [pages],
  );
  const speedIssues = useMemo(
    () =>
      issues.filter((issue) =>
        issue.category === "performance" ||
        issue.category === "assets" ||
        speedIssueTypes.includes(String(issue.type || "")),
      ),
    [issues],
  );
  return (
    <div className="space-y-4">
      <ReportSection
        title="Page speed evidence"
        description="Crawler response timings, HTML weight, compression, and performance issues from this scan."
      >
        <StatusEvidenceTable
          rows={[
            {
              title: "Measured pages",
              status: formatNumber(coverage.measuredPageLoads),
              tone: coverage.measuredPageLoads ? "good" : "outline",
              text: `${formatNumber(coverage.pages)} pages crawled. ${formatNumber(coverage.measuredPageLoads)} HTML responses include timing evidence.`,
            },
            {
              title: "Average response",
              status: coverage.measuredPageLoads ? formatMs(coverage.averagePageLoadMs) : "not measured",
              tone: speedVariant(coverage.averagePageLoadMs) as any,
              text: `Median ${formatMs(coverage.medianPageLoadMs)} · p95 ${formatMs(coverage.p95PageLoadMs)} · slowest ${formatMs(coverage.slowestPageLoadMs)}.`,
            },
            {
              title: "Slow pages",
              status: formatNumber(coverage.slowPages),
              tone: coverage.verySlowPages ? "bad" : coverage.slowPages ? "warn" : "good",
              text: `${formatNumber(coverage.verySlowPages)} pages above 4,000 ms. ${formatNumber(coverage.slowPages)} pages above 2,000 ms.`,
            },
            {
              title: "CSS/JS requests",
              status: formatNumber(coverage.checkedAssets),
              tone: coverage.brokenAssets ? "bad" : coverage.unverifiedAssets ? "warn" : coverage.checkedAssets ? "good" : "outline",
              text: `${formatNumber(coverage.brokenAssets)} failing · ${formatNumber(coverage.unverifiedAssets)} certificate-unverified · ${formatNumber(summary.largeAssets || 0)} large · ${formatNumber(summary.renderBlockingScripts || 0)} render-blocking scripts.`,
            },
            {
              title: "Image loading",
              status: formatNumber(summary.imagesMissingLazyLoading || 0),
              tone: summary.imagesMissingLazyLoading ? "warn" : "good",
              text: "Lower-page content images without lazy loading increase page weight before users need them.",
            },
          ]}
        />
      </ReportSection>

      <ReportSection title="Page response timings" description="Slowest pages first, with response size and compression evidence.">
        {timedPages.length ? (
          <FilteredRows rows={timedPages} placeholder="Filter timed pages…" csvName="page-response-timings" csvColumns={pageCsvColumns} sortValues={pageSortValues}>
            {(rows) => <ScanSpeedPagesTable rows={rows} onOpenPage={onOpenPage} />}
          </FilteredRows>
        ) : <EmptyState title="No page timings" text="Run a fresh scan to record response timing for each HTML page." />}
      </ReportSection>

      <ReportSection title="Performance issues" description="Only speed, payload, viewport, lazy-loading, and CSS/JS findings.">
        {speedIssues.length ? (
          <FilteredRows rows={speedIssues} placeholder="Filter performance issues…" csvName="performance-issues">
            {(rows) => <ScanIssuesTable rows={rows} catalog={catalog} onOpenPage={onOpenPage} />}
          </FilteredRows>
        ) : <EmptyState title="No speed issues" text="The scan did not find slow pages or performance blockers." />}
      </ReportSection>

      {assets.length ? (
        <ReportSection title="CSS and JavaScript requests" description="Fetched stylesheet and script URLs with status, type, and size.">
          <FilteredRows rows={assets} placeholder="Filter CSS and JavaScript…" csvName="css-js-requests">
            {(rows) => <ScanAssetsTable rows={rows} />}
          </FilteredRows>
        </ReportSection>
      ) : null}
    </div>
  );
}

// The full saved payload can be many megabytes, so it is offered as a JSON
// download and only rendered inline on request.
export function ScanRawEvidence({ scan, result }: { scan: any; result: any }) {
  const [showRaw, setShowRaw] = useState(false);
  const counts = [
    { label: "pages", value: result.pages?.length },
    { label: "issues", value: result.issues?.length },
    { label: "checked links", value: result.links?.length },
    { label: "link tags", value: result.linkInventory?.length },
    { label: "checked images", value: result.images?.length },
    { label: "image tags", value: result.imageInventory?.length },
    { label: "CSS/JS assets", value: result.assets?.length },
    { label: "parameter URLs", value: result.parameterUrls?.length },
  ].filter((item) => Number(item.value) > 0);
  const download = () => {
    const stamp = String(scan.created_at || scan.updated_at || "").slice(0, 10);
    downloadFile(
      `scan-${fileSlug(scan.url)}${stamp ? `-${stamp}` : ""}.json`,
      JSON.stringify({ ...scan, result }, null, 2),
      "application/json;charset=utf-8",
    );
  };
  return (
    <ScanSection
      title="Complete scan evidence"
      text="The full saved crawl payload for export, debugging, and MCP/AI workflows."
      action={
        <Button size="sm" onClick={download}>
          <Download /> Download JSON
        </Button>
      }
    >
      <div className="space-y-3">
        <p className="text-sm text-muted-foreground">
          Saved {formatDate(scan.updated_at || scan.created_at)} · {counts.length ? counts.map((item) => `${formatNumber(item.value)} ${item.label}`).join(" · ") : "no evidence rows yet"}
        </p>
        <Button size="sm" variant="outline" onClick={() => setShowRaw((value) => !value)} aria-expanded={showRaw}>
          {showRaw ? "Hide raw JSON" : "Show raw JSON"}
        </Button>
        {showRaw ? <JsonBlock value={result} /> : null}
      </div>
    </ScanSection>
  );
}
