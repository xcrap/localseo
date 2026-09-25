import { Link } from "react-router-dom";
import { ArrowUpRight, GitCompareArrows, Trash2 } from "lucide-react";
import { Button } from "@/components/ui";
import { ProgressBar, StatusDot, formatDate, formatNumber, scanCrawlLabel, scanIsActive, scanLiveProgress, scanPhaseLabel, scanSeverityCounts, scanSiteName, scanStatusLabel, scoreMeaning, scoreTone, setSelectedScanId } from "../../shared";
import { cn } from "@/lib/utils";
import { scanStatusTone } from "./common";

// Saved scan history rows. Each row keeps the URL readable at phone widths:
// the severity summary and progress bar move into the subtitle below `sm`/`md`.
export function ScanTable({
  rows,
  showSite,
  activeSiteId,
  selectedId,
  onInspect,
  onDelete,
  onCompare,
}: {
  rows: any[];
  showSite?: boolean;
  activeSiteId?: string;
  selectedId?: string;
  onInspect?: (id: string, row: any) => void;
  onDelete?: (id: string, row: any) => void;
  /** Compare the open scan against this row. Offered on finished rows only. */
  onCompare?: (row: any) => void;
}) {
  return (
    <div className="divide-y divide-border/60">
      {rows.map((row) => {
        const counts = scanSeverityCounts(row);
        const running = scanIsActive(row);
        const completed = row.status === "completed";
        const score = Number(row.score || 0);
        const showSiteName = Boolean(showSite && (!activeSiteId || row.site_id !== activeSiteId));
        const countsText = `${formatNumber(counts.high)} high · ${formatNumber(counts.medium)} med · ${formatNumber(counts.low)} low · ${formatNumber(row.pages_crawled || 0)} pages`;
        const live = running ? scanLiveProgress(row) : null;
        const scanCell = (
          <>
            <div className="truncate font-medium">{row.url}</div>
            <div className="mt-0.5 flex min-w-0 flex-wrap items-center gap-x-1.5 text-xs text-muted-foreground">
              <span className="whitespace-nowrap">{formatDate(row.created_at || row.updated_at)}</span>
              {showSiteName ? <span className="truncate">· {scanSiteName(row)}</span> : null}
              {completed ? <span className="md:hidden">· {countsText}</span> : null}
              {running ? <span className="sm:hidden">· {scanPhaseLabel(row)} · {scanCrawlLabel(row)}</span> : null}
            </div>
          </>
        );
        const canCompare = Boolean(onCompare && selectedId && row.id !== selectedId && !running);
        return (
          <div
            key={row.id}
            className={cn(
              "relative flex items-center gap-2 rounded-xl px-3 py-3 transition-colors sm:gap-3",
              onInspect ? "hover:bg-accent/60" : "",
              selectedId === row.id
                ? "bg-accent before:absolute before:bottom-2.5 before:left-0 before:top-2.5 before:w-[3px] before:rounded-full before:bg-primary"
                : "",
            )}
          >
            {onInspect ? (
              <button
                type="button"
                className="min-w-0 flex-1 cursor-pointer rounded-sm text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/60"
                title={`Open scan report for ${row.url}`}
                aria-current={selectedId === row.id ? "true" : undefined}
                onClick={() => onInspect(row.id, row)}
              >
                {scanCell}
              </button>
            ) : (
              <div className="min-w-0 flex-1">{scanCell}</div>
            )}
            {running && live ? (
              <div className="hidden w-32 shrink-0 sm:block">
                <div className="flex items-center gap-1.5 whitespace-nowrap text-xs text-muted-foreground">
                  <StatusDot tone="warn" /> {scanPhaseLabel(row)}
                </div>
                {live.crawlPercent != null ? (
                  <div className="mt-1.5" title={scanCrawlLabel(row)}>
                    <ProgressBar value={live.crawlPercent} />
                  </div>
                ) : (
                  <div className="mt-1 text-xs text-muted-foreground">{scanCrawlLabel(row)}</div>
                )}
              </div>
            ) : completed ? (
              <div className="flex shrink-0 items-baseline gap-2.5">
                <span className="metric shrink-0 text-right text-xl leading-none sm:w-12" style={{ color: scoreTone(score) }} title={`${score}% · ${scoreMeaning}`}>
                  {formatNumber(score)}
                  <span className="sr-only">% {scoreMeaning.toLowerCase()}</span>
                </span>
                <span className="hidden w-56 shrink-0 truncate whitespace-nowrap text-xs text-muted-foreground md:inline">{countsText}</span>
              </div>
            ) : (
              <span className="flex shrink-0 items-center gap-1.5 whitespace-nowrap text-xs font-medium">
                <StatusDot tone={scanStatusTone(row.status)} /> {scanStatusLabel(row.status)}
              </span>
            )}
            {onInspect || onDelete || canCompare ? (
              <div className="flex shrink-0 items-center">
                {canCompare ? (
                  <Button
                    size="icon"
                    variant="ghost"
                    className="size-8 text-muted-foreground hover:text-foreground"
                    aria-label={`Compare the open scan with the scan from ${formatDate(row.created_at || row.updated_at)}`}
                    title="Compare the open scan with this one"
                    onClick={() => onCompare?.(row)}
                  >
                    <GitCompareArrows />
                  </Button>
                ) : null}
                {onInspect ? (
                  <Button asChild size="icon" variant="ghost" className="hidden size-8 text-muted-foreground hover:text-foreground sm:inline-flex">
                    <Link
                      to={`/scans/${row.id}`}
                      aria-label={`Open scan report for ${row.url}`}
                      onClick={(event) => {
                        event.stopPropagation();
                        if (row.site_id) setSelectedScanId(row.site_id, row.id);
                      }}
                    >
                      <ArrowUpRight />
                    </Link>
                  </Button>
                ) : null}
                {onDelete ? (
                  <Button
                    size="icon"
                    variant="ghost"
                    className="size-8 text-muted-foreground hover:text-destructive"
                    aria-label={`Delete scan report for ${row.url}`}
                    onClick={(event) => {
                      event.stopPropagation();
                      onDelete(row.id, row);
                    }}
                  >
                    <Trash2 />
                  </Button>
                ) : null}
              </div>
            ) : null}
          </div>
        );
      })}
    </div>
  );
}
