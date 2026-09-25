import { useEffect, useRef, useState, type ReactNode } from "react";
import { Link } from "react-router-dom";
import { BarChart3, FileSearch, RefreshCw, RotateCcw, Upload } from "lucide-react";
import { Button, Skeleton } from "@/components/ui";
import { DateRangeFields, type DateRange } from "../../date-picker";
import { EmptyState, formatDate, formatNumber } from "../../shared";

// Insight metrics come straight from stored Search Console rows. A missing
// value stays "-"; a real 0 stays 0.
export function hasValue(value: unknown): boolean {
  return value !== null && value !== undefined && value !== "" && Number.isFinite(Number(value));
}

export function formatCount(value: unknown) {
  return hasValue(value) ? formatNumber(value) : "-";
}

/** CTR arrives as a 0–1 fraction. */
export function formatCtr(value: unknown) {
  return hasValue(value) ? `${(Number(value) * 100).toFixed(1)}%` : "-";
}

export function formatAvgPosition(value: unknown) {
  return hasValue(value) ? Number(value).toFixed(1) : "-";
}

export function formatRange(range?: { startDate?: string | null; endDate?: string | null } | null) {
  if (!range?.startDate && !range?.endDate) return "no stored range";
  return `${formatDate(range?.startDate)} – ${formatDate(range?.endDate)}`;
}

export function gscSourceLabel(source?: string | null) {
  if (source === "api") return "Search Console API";
  if (source === "csv") return "CSV import";
  return source ? String(source) : "Unknown source";
}

type QueryState<T> = { status: "loading" | "ready" | "error"; data: T | null; error: string };

// One request at a time per tab: a newer query supersedes an older response,
// and data from the previous query stays visible while the next one loads.
export function useInsightQuery<Q, T>(siteId: string, fetcher: (query: Q) => Promise<T>, initialQuery: Q) {
  const [state, setState] = useState<QueryState<T>>({ status: "loading", data: null, error: "" });
  const [query, setQuery] = useState<Q>(initialQuery);
  const tokenRef = useRef(0);

  function run(next: Q) {
    const token = ++tokenRef.current;
    setQuery(next);
    setState((current) => ({ status: "loading", data: current.data, error: "" }));
    fetcher(next)
      .then((data) => {
        if (token === tokenRef.current) setState({ status: "ready", data, error: "" });
      })
      .catch((err) => {
        if (token === tokenRef.current) {
          setState({ status: "error", data: null, error: err instanceof Error ? err.message : "Could not load these insights" });
        }
      });
  }

  useEffect(() => {
    setState({ status: "loading", data: null, error: "" });
    run(initialQuery);
  }, [siteId]);

  return { ...state, query, run, retry: () => run(query) };
}

export function InsightSkeleton() {
  return (
    <div className="space-y-4" role="status" aria-busy="true" aria-label="Loading insights">
      <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-4">
        {Array.from({ length: 4 }).map((_, index) => (
          <Skeleton key={index} className="h-20 rounded-xl" />
        ))}
      </div>
      <Skeleton className="h-56 rounded-2xl" />
    </div>
  );
}

export function InsightError({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <EmptyState
      title="Could not load these insights"
      text={`${message}. Your saved Search Console rows and scans were not changed.`}
      action={
        <Button variant="secondary" onClick={onRetry}>
          <RefreshCw /> Retry
        </Button>
      }
    />
  );
}

// Unavailable insights say why and point at the step that fills the gap,
// instead of rendering empty tables.
export function InsightUnavailable({ reason }: { reason?: string }) {
  const text = String(reason || "").toLowerCase();
  const needsScan = /scan|crawl/.test(text);
  const needsGsc = /search console|gsc|google|import|sync|impression|click|query|queries/.test(text);
  const showGsc = needsGsc || !needsScan;
  const showScan = needsScan || !needsGsc;
  return (
    <EmptyState
      icon={BarChart3}
      title="Not enough data for this insight yet"
      text={reason || "This insight needs stored Search Console rows and a completed site scan."}
      action={
        <>
          {showGsc ? (
            <>
              <Button asChild>
                <Link to="/gsc">
                  <BarChart3 /> Connect or sync Search Console
                </Link>
              </Button>
              <Button asChild variant="secondary">
                <Link to="/gsc?tab=import">
                  <Upload /> Import a CSV
                </Link>
              </Button>
            </>
          ) : null}
          {showScan ? (
            <Button asChild variant={showGsc ? "outline" : "default"}>
              <Link to="/scans">
                <FileSearch /> Run a site scan
              </Link>
            </Button>
          ) : null}
        </>
      }
    />
  );
}

export function InsightUrl({ url, scanId, crawled }: { url: string; scanId?: string | null; crawled?: boolean }) {
  if (scanId && crawled) {
    return (
      <Link
        to={`/scans/${scanId}?page=${encodeURIComponent(url)}`}
        className="break-all font-medium text-primary underline-offset-4 hover:underline"
        title="Open this page's crawl details"
      >
        {url}
      </Link>
    );
  }
  return <span className="break-all font-medium">{url}</span>;
}

// Date range pickers with an explicit Apply, plus a reset back to whatever
// range the stored data covers.
export function RangeControls({
  ranges,
  onApply,
  onReset,
  busy,
  children,
}: {
  ranges: { value: DateRange; onChange: (value: DateRange) => void; startLabel?: string; endLabel?: string }[];
  onApply: () => void;
  onReset: () => void;
  busy?: boolean;
  /** Extra controls placed before the date fields. */
  children?: ReactNode;
}) {
  const valid = ranges.every((range) => range.value.startDate && range.value.endDate && range.value.startDate <= range.value.endDate);
  return (
    <div className="space-y-3">
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-[repeat(auto-fit,minmax(12rem,1fr))]">
        {children}
        {ranges.map((range, index) => (
          <DateRangeFields
            key={index}
            value={range.value}
            onChange={range.onChange}
            startLabel={range.startLabel}
            endLabel={range.endLabel}
          />
        ))}
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <Button type="button" size="sm" onClick={onApply} disabled={busy || !valid}>
          <RefreshCw /> Apply
        </Button>
        <Button type="button" size="sm" variant="ghost" onClick={onReset} disabled={busy}>
          <RotateCcw /> Use latest stored data
        </Button>
        {!valid ? <span className="text-xs text-warn">Each start date must be on or before its end date.</span> : null}
      </div>
    </div>
  );
}
