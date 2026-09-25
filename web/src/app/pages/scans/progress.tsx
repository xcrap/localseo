import { MetricTile, MetricTileGrid, ProgressBar, ReportSection, StatusEvidenceTable, formatDuration, formatNumber, scanCoverageMetrics, scanCrawlLabel, scanIsActive, scanLiveProgress, scanPhaseKey, scanPhaseLabel } from "../../shared";
import { robotsFileSummary } from "./robots";

type ScanStepState = "complete" | "running" | "pending" | "failed" | "cancelled" | "skipped";

function scanStepIndex(scan: any) {
  const order: Record<string, number> = {
    resolve: 0,
    queued: 0,
    robots: 1,
    crawl: 2,
    links: 3,
    images: 4,
    assets: 5,
    report: 6,
    completed: 6,
  };
  const key = scanPhaseKey(scan);
  if (key === "failed" || key === "cancelled") {
    // Locate the step the crawl stopped in from the last saved phase.
    const phase = String(scan?.result?.progress?.phase || scan?.result?.phase || scan?.result?.summary?.phase || "").toLowerCase();
    if (phase.includes("deduplicating")) return 6;
    if (phase.includes("assets")) return 5;
    if (phase.includes("images") || phase.includes("css images")) return 4;
    if (phase.includes("links")) return 3;
    if (phase.includes("crawl")) return 2;
    if (phase.includes("robots")) return 1;
    return 0;
  }
  return order[key] ?? 0;
}

function scanStepState(scan: any, index: number): ScanStepState {
  if (scan?.status === "completed") return "complete";
  const activeIndex = scanStepIndex(scan);
  if (scan?.status === "failed") return index < activeIndex ? "complete" : index === activeIndex ? "failed" : "pending";
  if (scan?.status === "cancelled") return index < activeIndex ? "complete" : index === activeIndex ? "cancelled" : "skipped";
  if (index < activeIndex) return "complete";
  if (index === activeIndex) return "running";
  return "pending";
}

const scanStepStatusLabel: Record<ScanStepState, string> = {
  complete: "Done",
  running: "Running",
  pending: "Pending",
  failed: "Failed",
  cancelled: "Cancelled",
  skipped: "Skipped",
};

const scanStepStatusTone: Record<ScanStepState, "good" | "warn" | "bad" | "outline"> = {
  complete: "good",
  running: "warn",
  pending: "outline",
  failed: "bad",
  cancelled: "outline",
  skipped: "outline",
};

export function ScanProgressPanel({
  scan,
  result,
  coverage,
}: {
  scan: any;
  result: any;
  coverage: ReturnType<typeof scanCoverageMetrics>;
}) {
  const active = scanIsActive(scan);
  const live = scanLiveProgress(scan);
  const robotsLabel = result.robots ? robotsFileSummary(result.robots).label : "";
  const robotsFound = robotsLabel ? `robots.txt ${robotsLabel.charAt(0).toLowerCase()}${robotsLabel.slice(1)}` : "robots.txt not read yet";
  const sitemapFiles = Array.isArray(result.sitemap?.sitemaps) ? result.sitemap.sitemaps.length : 0;
  const pagesCrawled = Math.max(live.crawled, coverage.pages);
  const steps = [
    {
      label: "Resolve start URL",
      detail: result.startUrl || scan.url,
      evidence: "Saved scan URL and crawl scope.",
    },
    {
      label: "Read robots and sitemap",
      detail: `${robotsFound} · ${formatNumber(sitemapFiles)} sitemap files`,
      evidence: `${formatNumber(coverage.sitemapUrls)} sitemap URLs available for discovery${coverage.sitemapUrlsNotCrawled != null ? ` · ${formatNumber(coverage.sitemapUrlsNotCrawled)} not crawled` : ""}.`,
    },
    {
      label: "Crawl pages",
      detail: live.limit ? `${formatNumber(pagesCrawled)} of ${formatNumber(live.limit)} max pages crawled` : `${formatNumber(pagesCrawled)} pages crawled`,
      evidence: `${formatNumber(coverage.linkTags)} link tags · ${formatNumber(coverage.imageTags)} image tags · ${formatNumber(coverage.assetTags)} CSS/JS refs.`,
    },
    {
      label: "Check links",
      detail: `${formatNumber(coverage.checkedLinks)} unique URLs checked`,
      evidence: `${formatNumber(coverage.brokenLinks)} broken · ${formatNumber(coverage.unverifiedLinks)} certificate-unverified · ${formatNumber(coverage.redirectedLinkTargets)} redirect targets affecting ${formatNumber(coverage.redirectedLinkPages)} pages.`,
    },
    {
      label: "Check images",
      detail: `${formatNumber(coverage.checkedImages)} image URLs checked`,
      evidence: `${formatNumber(coverage.brokenImages)} failing · ${formatNumber(coverage.unverifiedImages)} certificate-unverified · ${formatNumber(coverage.redirectedImages)} redirecting · ${formatNumber(coverage.largeImages)} large.`,
    },
    {
      label: "Check CSS/JS",
      detail: `${formatNumber(coverage.checkedAssets)} assets checked`,
      evidence: `${formatNumber(coverage.brokenAssets)} failing · ${formatNumber(coverage.unverifiedAssets)} certificate-unverified · ${formatNumber(coverage.cssImageResources)} CSS image URLs found.`,
    },
    {
      label: "Build report",
      detail:
        scan.status === "completed"
          ? `Score ${formatNumber(scan.score || 0)}`
          : scan.status === "failed"
            ? "Report did not finish"
            : scan.status === "cancelled"
              ? "Stopped before the report finished"
              : "Grouping issues",
      evidence: `${formatNumber(scan.issue_count || 0)} issues saved in local SQLite.`,
    },
  ];
  return (
    <ReportSection
      title="Scan progress"
      meta={`${scanPhaseLabel(scan)} · ${formatNumber(pagesCrawled)} pages · ${formatNumber(scan.issue_count || 0)} issues`}
    >
      {active ? (
        <div className="space-y-4" aria-live="polite">
          <MetricTileGrid>
            <MetricTile label="Pages crawled" value={formatNumber(live.crawled)} hint={live.limit ? `of ${formatNumber(live.limit)} max pages for this scan` : "Page limit not reported"} />
            <MetricTile label="Queued" value={live.queued != null ? formatNumber(live.queued) : "—"} hint="Discovered URLs waiting to be crawled" />
            <MetricTile
              label="Pages / sec"
              value={live.pagesPerSecond != null ? live.pagesPerSecond.toFixed(live.pagesPerSecond < 10 ? 1 : 0) : "—"}
              hint="Average crawl rate so far"
            />
            <MetricTile label="Elapsed" value={live.elapsedMs != null ? formatDuration(live.elapsedMs) : "—"} hint={scanPhaseLabel(scan)} />
          </MetricTileGrid>
          {live.crawlPercent != null ? (
            <div className="space-y-1.5">
              <ProgressBar value={live.crawlPercent} />
              <p className="text-xs text-muted-foreground">
                {scanCrawlLabel(scan)}. Crawling stops at the limit or when no URLs remain; link, image and CSS/JS checks follow the crawl.
              </p>
            </div>
          ) : null}
          <div className="rounded-lg bg-muted/40 px-3.5 py-2.5 text-sm">
            <span className="text-muted-foreground">{live.currentUrl ? "Now fetching " : "Start URL "}</span>
            <span className="break-all font-medium">{live.currentUrl || result.startUrl || scan.url}</span>
          </div>
        </div>
      ) : (
        <p className="break-all text-sm text-muted-foreground">
          {result.startUrl || scan.url}
          {live.elapsedMs != null ? ` · ran for ${formatDuration(live.elapsedMs)}` : ""}
        </p>
      )}
      <div className="mt-4">
        <StatusEvidenceTable
          rows={steps.map((step, index) => {
            const state = scanStepState(scan, index);
            return {
              title: step.label,
              status: scanStepStatusLabel[state],
              tone: scanStepStatusTone[state],
              text: <span className="break-words">{step.detail} — {step.evidence}</span>,
            };
          })}
        />
      </div>
    </ReportSection>
  );
}
