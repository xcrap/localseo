import { CheckCircle2, EyeOff } from "lucide-react";
import { Badge, Button } from "@/components/ui";
import { CountUp, EmptyState, Hint, MetricTile, MetricTileGrid, ReportSection, ScoreDial, StatusDot, formatDate, formatMs, formatNumber, issueCategoryLabel, scanCoverageMetrics, scanIsActive, scoreMeaning, scoreVerdict, type MetricTileProps } from "../../shared";
import { cn } from "@/lib/utils";
import { comparisonRegressions } from "./changes";
import { PrioritiseWithCodexButton } from "./codex-prioritise";
import { humanizeIssueType, severityVariant } from "./common";
import { issueGuidance, issueTypeTitle, type IssueCatalog } from "./issue-catalog";

export function ScanReportOverview({
  scan,
  result,
  summary,
  coverage,
  severityCounts,
  activeSeverity,
  onSeveritySelect,
}: {
  scan: any;
  result: any;
  summary: any;
  coverage: ReturnType<typeof scanCoverageMetrics>;
  severityCounts: { high: number; medium: number; low: number };
  activeSeverity: string;
  onSeveritySelect: (severity: string) => void;
}) {
  const isActive = scanIsActive(scan);
  const isCompleted = scan.status === "completed";
  const isFailed = scan.status === "failed";
  const finalScore = Number(scan.score || 0);
  const dialColor = isFailed ? "var(--bad)" : undefined;
  const sourceUrl = result.startUrl || scan.url;
  const metaIssues = Number(summary.missingTitles || 0) + Number(summary.missingDescriptions || 0);
  const imageAltIssues = Number(summary.missingAlt || 0) + Number(summary.imagesMissingDimensions || 0);
  const resourceFailures = coverage.brokenLinks || coverage.brokenImages || coverage.brokenAssets;
  const openIssues = severityCounts.high + severityCounts.medium + severityCounts.low;

  const tiles: MetricTileProps[] = [
    {
      label: "Pages crawled",
      value: <CountUp value={coverage.pages} />,
      hint: `${formatNumber(coverage.indexablePages)} indexable · ${formatNumber(coverage.nonIndexablePages)} noindex · ${formatNumber(coverage.sitemapUrls)} in sitemap`,
    },
    {
      label: "Links checked",
      value: <CountUp value={coverage.checkedLinks} />,
      tone: coverage.brokenLinks ? "bad" : coverage.unverifiedLinks || coverage.redirectedLinkTargets ? "warn" : "default",
      hint: `${formatNumber(coverage.brokenLinks)} broken · ${formatNumber(coverage.unverifiedLinks)} unverified · ${formatNumber(coverage.redirectedLinkTargets)} redirect targets affecting ${formatNumber(coverage.redirectedLinkPages)} pages`,
    },
    {
      label: "Images checked",
      value: <CountUp value={coverage.checkedImages} />,
      tone: coverage.brokenImages ? "bad" : coverage.unverifiedImages || coverage.largeImages ? "warn" : "default",
      hint: `${formatNumber(coverage.brokenImages)} broken · ${formatNumber(coverage.unverifiedImages)} unverified · ${formatNumber(coverage.largeImages || 0)} large`,
    },
    {
      label: "Avg response",
      value: coverage.measuredPageLoads ? <CountUp value={coverage.averagePageLoadMs} format={formatMs} /> : "—",
      tone: coverage.verySlowPages ? "bad" : coverage.slowPages ? "warn" : "default",
      hint: coverage.measuredPageLoads
        ? `p95 ${formatMs(coverage.p95PageLoadMs)} · ${formatNumber(coverage.slowPages)} slow pages`
        : "No timing captured yet",
    },
    {
      label: "Metadata gaps",
      value: <CountUp value={metaIssues} />,
      tone: metaIssues ? "warn" : "default",
      hint: `${formatNumber(summary.titleLengthIssues || 0)} title · ${formatNumber(summary.descriptionLengthIssues || 0)} description length`,
    },
    {
      label: "Image alt/size",
      value: <CountUp value={imageAltIssues} />,
      tone: imageAltIssues ? "warn" : "default",
      hint: `${formatNumber(summary.imagesMissingLazyLoading || 0)} lazy · ${formatNumber(summary.cssImageResources || 0)} CSS images`,
    },
  ];

  return (
    <ReportSection
      title="Scan health"
      description="The dial is the share of crawled pages without high-severity issues. Medium and low findings never lower it, so check the open issue counts beside it too."
    >
      <div className="grid gap-6 xl:grid-cols-[248px_minmax(0,1fr)]">
        <div className="flex flex-col items-center gap-4 pb-6 text-center xl:pb-0 xl:pr-6">
          {isActive ? (
            <div className="flex flex-col items-center justify-center gap-2.5 py-10 text-center">
              <StatusDot tone="warn" />
              <p className="text-sm font-medium">Scan in progress</p>
              <p className="max-w-[210px] text-xs leading-5 text-muted-foreground">
                The score appears once the crawl, resource checks, and report build finish. Follow it live on the Progress tab.
              </p>
            </div>
          ) : (
            <div className="w-full space-y-4">
              <div className="flex flex-col items-center gap-2">
                <ScoreDial
                  score={finalScore}
                  size={148}
                  color={dialColor}
                  suffix="%"
                  label={isCompleted ? scoreVerdict(finalScore) : scan.status === "cancelled" ? "partial" : "score"}
                />
                <p className="text-xs font-medium text-muted-foreground">{scoreMeaning}</p>
              </div>
              <div>
                <div className="eyebrow-muted mb-2">Open issues</div>
                <div className="flex items-start justify-center gap-7">
                  {[
                    { key: "high", label: "High", count: severityCounts.high, labelClass: "text-bad" },
                    { key: "medium", label: "Medium", count: severityCounts.medium, labelClass: "text-warn" },
                    { key: "low", label: "Low", count: severityCounts.low, labelClass: "text-muted-foreground" },
                  ].map((item) => (
                    <button
                      key={item.key}
                      type="button"
                      onClick={() => onSeveritySelect(item.key)}
                      aria-pressed={activeSeverity === item.key}
                      className="group rounded-md text-center focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/60"
                    >
                      <span className="metric block text-xl leading-none">
                        <CountUp value={item.count} />
                      </span>
                      <span
                        className={cn(
                          "mt-1 block text-[11px] font-semibold uppercase tracking-[0.08em] underline-offset-4 transition-colors",
                          item.labelClass,
                          activeSeverity === item.key ? "underline decoration-2" : "group-hover:underline",
                        )}
                      >
                        {item.label}
                      </span>
                    </button>
                  ))}
                </div>
              </div>
              <p className="text-xs leading-5 text-muted-foreground">
                <Hint tip="Tap a severity to filter the issue list.">
                  {formatNumber(openIssues)} open issues · {formatNumber(coverage.pages)} pages
                </Hint>
              </p>
            </div>
          )}
          {scan.error ? <p className="w-full rounded-lg bg-bad-soft/60 p-3 text-left text-xs text-destructive">{scan.error}</p> : null}
        </div>

        <div className="space-y-3">
          <MetricTileGrid>
            {tiles.map((tile) => (
              <MetricTile key={tile.label} {...tile} />
            ))}
          </MetricTileGrid>
          <p className="text-xs leading-5 text-muted-foreground">
            {resourceFailures
              ? `Resource failures detected — ${formatNumber(coverage.brokenLinks)} links, ${formatNumber(coverage.brokenImages)} images and ${formatNumber(coverage.brokenAssets)} assets need attention. `
              : coverage.unverifiedLinks || coverage.unverifiedImages || coverage.unverifiedAssets
                ? `${formatNumber(coverage.unverifiedLinks)} link, ${formatNumber(coverage.unverifiedImages)} image and ${formatNumber(coverage.unverifiedAssets)} asset certificates could not be verified; these are not counted as broken resources. `
                : "All checked links, images and assets responded. "}
            Crawl started at <span className="break-all font-medium">{sourceUrl}</span>.
          </p>
        </div>
      </div>
    </ReportSection>
  );
}

export function ScanRegressionsCard({
  comparison,
  onOpenChanges,
  onOpenPage,
}: {
  comparison: any;
  onOpenChanges: () => void;
  onOpenPage: (url: string) => void;
}) {
  if (!comparison?.available) return null;
  const { rows, count, newHighIssues } = comparisonRegressions(comparison);
  const fixed = Number(comparison.summary?.fixedIssues || 0);
  const preview = rows.slice(0, 5);
  return (
    <ReportSection
      title="Regressions"
      description="Pages that got worse since the previous scan: became non-indexable, started erroring or redirecting elsewhere, left the sitemap, or dropped out of the crawl."
      meta={comparison.previousCreatedAt ? `vs ${formatDate(comparison.previousCreatedAt)}` : undefined}
      action={
        <Button size="sm" variant="outline" onClick={onOpenChanges}>
          View all changes
        </Button>
      }
    >
      <MetricTileGrid>
        <MetricTile label="Regressions" value={<CountUp value={count} />} tone={count ? "bad" : "good"} hint="Page-level changes for the worse" />
        <MetricTile label="New high issues" value={<CountUp value={newHighIssues.length} />} tone={newHighIssues.length ? "bad" : "default"} hint="High-severity findings not in the previous scan" />
        <MetricTile label="Fixed issues" value={<CountUp value={fixed} />} tone={fixed ? "good" : "default"} hint="Previous findings absent from this scan" />
      </MetricTileGrid>
      {preview.length ? (
        <div className="mt-4 divide-y divide-border/60 rounded-xl border border-border/60">
          {preview.map((row: any, index: number) => (
            <div key={`${row.type}:${row.url}:${index}`} className="flex flex-wrap items-center gap-x-3 gap-y-1 px-3.5 py-2.5 text-sm">
              <Badge variant="bad">{row.label || String(row.type || "regression").replaceAll("-", " ")}</Badge>
              {row.url ? (
                <button
                  type="button"
                  className="min-w-0 flex-1 break-all rounded-sm text-left text-muted-foreground hover:text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/60"
                  onClick={() => onOpenPage(row.url)}
                >
                  {row.url}
                </button>
              ) : null}
              {row.before != null || row.after != null ? (
                <span className="text-xs text-muted-foreground">
                  {String(row.before ?? "-")} → {String(row.after ?? "-")}
                </span>
              ) : null}
            </div>
          ))}
          {rows.length > preview.length ? (
            <div className="px-3.5 py-2 text-xs text-muted-foreground">
              {formatNumber(rows.length - preview.length)} more on the Changes tab.
            </div>
          ) : null}
        </div>
      ) : null}
    </ReportSection>
  );
}

export function ScanActionBoard({
  scan,
  issueGroups,
  catalog,
  onSelectGroup,
  onIgnoreGroup,
}: {
  scan: any;
  issueGroups: any[];
  catalog: IssueCatalog;
  onSelectGroup: (group: any) => void;
  onIgnoreGroup?: (group: any) => void;
}) {
  const priorityGroups = issueGroups
    .filter((group) => group.severity === "high" || group.severity === "medium")
    .sort((a, b) => (a.severity === b.severity ? Number(b.count || 0) - Number(a.count || 0) : a.severity === "high" ? -1 : 1));
  return (
    <ReportSection
      title="Fix first"
      description="Grouped issues with the highest crawl and search impact — ranked by severity, then reach."
      action={<PrioritiseWithCodexButton scan={scan} />}
    >
      {priorityGroups.length ? (
        <div className="divide-y divide-border/60">
          {priorityGroups.map((group, index) => {
            const title = issueTypeTitle(catalog, group.type, group.title);
            const guidance = issueGuidance(catalog, group.type, group.recommendation);
            return (
              <div key={group.key} className="flex flex-col gap-4 py-5 first:pt-0 last:pb-0 lg:flex-row lg:items-center lg:justify-between">
                <div className="flex min-w-0 gap-4">
                  <div className="metric flex size-7.5 shrink-0 items-center justify-center rounded-[9px] border border-border/70 bg-muted text-[13px] text-muted-foreground">
                    {index + 1}
                  </div>
                  <div className="min-w-0">
                    <div className="mb-1.5 flex flex-wrap items-center gap-2.5">
                      <Badge variant={severityVariant(group.severity) as any} className="text-[10.5px] font-semibold uppercase tracking-[0.06em]">
                        {group.severity}
                      </Badge>
                      <span className="text-[15px] font-semibold leading-snug tracking-[-0.01em]">{title}</span>
                    </div>
                    {guidance.why ? <p className="max-w-3xl text-[13px] leading-5 text-muted-foreground">{guidance.why}</p> : null}
                    {guidance.fix ? (
                      <p className="mt-1 max-w-3xl text-[13px] leading-5 text-muted-foreground">
                        <span className="font-medium text-foreground/80">Fix: </span>
                        {guidance.fix}
                      </p>
                    ) : null}
                    <p className="mt-1 text-[11.5px] text-muted-foreground/60">
                      {issueCategoryLabel(group.category)} · {humanizeIssueType(group.type)}
                    </p>
                  </div>
                </div>
                <div className="flex shrink-0 items-center gap-4 lg:flex-col lg:items-end lg:gap-3">
                  <div className="text-right leading-none">
                    <div className="metric text-[26px] font-bold"><CountUp value={group.count} /></div>
                    <div className="mt-1 text-[10px] font-semibold uppercase tracking-[0.1em] text-muted-foreground">Affected</div>
                  </div>
                  <div className="flex items-center gap-1.5">
                    {onIgnoreGroup ? (
                      <Button size="sm" variant="ghost" aria-label={`Ignore ${title} for this site`} onClick={() => onIgnoreGroup(group)}>
                        <EyeOff /> Ignore
                      </Button>
                    ) : null}
                    <Button size="sm" variant="outline" onClick={() => onSelectGroup(group)}>
                      Show issues
                    </Button>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      ) : (
        <EmptyState
          icon={CheckCircle2}
          title="No priority blockers"
          text={scan.status === "completed" ? "High and medium issue groups are clear." : "Priority issues appear while the scan runs."}
        />
      )}
    </ReportSection>
  );
}
