import { Fragment, useEffect, useRef, useState, type ReactNode } from "react";
import { Link } from "react-router-dom";
import { ChevronDown, ChevronRight, Gauge, LoaderCircle, RefreshCw } from "lucide-react";
import { api, type CwvFieldMetrics, type CwvResult, type CwvStatus, type CwvStrategy } from "../api";
import {
  Badge,
  Button,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Skeleton,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
  Textarea,
  toast,
} from "@/components/ui";
import { cn } from "@/lib/utils";
import { EmptyState, InfoTip, ReportSection, StatusDot, formatDate, formatNumber } from "./shared";

const POLL_MS = 3000;

export type CwvRating = "good" | "needs-improvement" | "poor";

type Threshold = { good: number; poor: number; higherIsBetter?: boolean };

// Google's published thresholds (web.dev/vitals). Lab TBT and the Lighthouse
// performance score use Lighthouse's own scoring bands.
const thresholds = {
  lcpMs: { good: 2500, poor: 4000 },
  inpMs: { good: 200, poor: 500 },
  cls: { good: 0.1, poor: 0.25 },
  fcpMs: { good: 1800, poor: 3000 },
  ttfbMs: { good: 800, poor: 1800 },
  tbtMs: { good: 200, poor: 600 },
  speedIndexMs: { good: 3400, poor: 5800 },
  performanceScore: { good: 90, poor: 50, higherIsBetter: true },
} satisfies Record<string, Threshold>;

type MetricKey = keyof typeof thresholds;

const ratingLabels: Record<CwvRating, string> = {
  good: "Good",
  "needs-improvement": "Needs improvement",
  poor: "Poor",
};

const ratingVariant: Record<CwvRating, "good" | "warn" | "bad"> = {
  good: "good",
  "needs-improvement": "warn",
  poor: "bad",
};

function finite(value: unknown): number | null {
  if (value == null || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

export function cwvRating(metric: MetricKey, value: unknown): CwvRating | null {
  const number = finite(value);
  if (number == null) return null;
  const band: Threshold = thresholds[metric];
  if (band.higherIsBetter) {
    if (number >= band.good) return "good";
    return number < band.poor ? "poor" : "needs-improvement";
  }
  if (number <= band.good) return "good";
  return number > band.poor ? "poor" : "needs-improvement";
}

// PageSpeed Insights reports field categories as FAST / AVERAGE / SLOW.
function overallRating(value: string | null | undefined): CwvRating | null {
  const text = String(value || "").toLowerCase();
  if (!text) return null;
  if (text === "fast" || text === "good" || text === "passed") return "good";
  if (text === "average" || text.includes("improvement")) return "needs-improvement";
  if (text === "slow" || text === "poor" || text === "failed") return "poor";
  return null;
}

export function formatCwvValue(metric: MetricKey, value: unknown) {
  const number = finite(value);
  if (number == null) return "-";
  if (metric === "cls") return number.toFixed(2);
  if (metric === "performanceScore") return formatNumber(Math.round(number));
  if (number >= 1000) return `${(number / 1000).toFixed(1)} s`;
  return `${formatNumber(Math.round(number))} ms`;
}

function RatingText({ rating }: { rating: CwvRating | null }) {
  if (!rating) return null;
  return (
    <Badge variant={ratingVariant[rating]} className="text-[10px]">
      {ratingLabels[rating]}
    </Badge>
  );
}

function MetricCell({ metric, value, className }: { metric: MetricKey; value: unknown; className?: string }) {
  const rating = cwvRating(metric, value);
  return (
    <TableCell className={cn("whitespace-nowrap", className)}>
      <div className="nums text-sm font-medium">{formatCwvValue(metric, value)}</div>
      <div className="mt-0.5">{rating ? <RatingText rating={rating} /> : null}</div>
    </TableCell>
  );
}

function OverallCell({ field }: { field: CwvFieldMetrics }) {
  const rating = overallRating(field.overall);
  return (
    <TableCell className="whitespace-nowrap">
      {rating ? <RatingText rating={rating} /> : <span className="text-xs text-muted-foreground">{field.overall || "Not reported"}</span>}
    </TableCell>
  );
}

function cwvSummaryText(field: CwvFieldMetrics) {
  return [
    `LCP ${formatCwvValue("lcpMs", field.lcpMs)}`,
    `INP ${formatCwvValue("inpMs", field.inpMs)}`,
    `CLS ${formatCwvValue("cls", field.cls)}`,
  ].join(" · ");
}

function Detail({ label, metric, value }: { label: string; metric: MetricKey; value: unknown }) {
  const rating = cwvRating(metric, value);
  return (
    <div className="min-w-0">
      <dt className="eyebrow-muted">{label}</dt>
      <dd className="mt-1 flex flex-wrap items-center gap-1.5 text-sm">
        <span className="nums">{formatCwvValue(metric, value)}</span>
        {rating ? <RatingText rating={rating} /> : null}
      </dd>
    </div>
  );
}

function ResultDetails({ result }: { result: CwvResult }) {
  return (
    <div className="grid gap-4 py-2 md:grid-cols-3">
      <div className="space-y-2">
        <div className="text-xs font-semibold">This URL · real users (Chrome UX Report, 28 days)</div>
        {result.field ? (
          <dl className="grid grid-cols-2 gap-3">
            <Detail label="LCP" metric="lcpMs" value={result.field.lcpMs} />
            <Detail label="INP" metric="inpMs" value={result.field.inpMs} />
            <Detail label="CLS" metric="cls" value={result.field.cls} />
            <Detail label="FCP" metric="fcpMs" value={result.field.fcpMs} />
            <Detail label="TTFB" metric="ttfbMs" value={result.field.ttfbMs} />
          </dl>
        ) : (
          <p className="text-xs text-muted-foreground">No field data from Chrome UX Report for this URL.</p>
        )}
      </div>
      <div className="space-y-2">
        <div className="text-xs font-semibold">Whole origin · real users (Chrome UX Report, 28 days)</div>
        {result.originField ? (
          <dl className="grid grid-cols-2 gap-3">
            <Detail label="LCP" metric="lcpMs" value={result.originField.lcpMs} />
            <Detail label="INP" metric="inpMs" value={result.originField.inpMs} />
            <Detail label="CLS" metric="cls" value={result.originField.cls} />
            <Detail label="FCP" metric="fcpMs" value={result.originField.fcpMs} />
            <Detail label="TTFB" metric="ttfbMs" value={result.originField.ttfbMs} />
          </dl>
        ) : (
          <p className="text-xs text-muted-foreground">No origin-level field data from Chrome UX Report.</p>
        )}
      </div>
      <div className="space-y-2">
        <div className="text-xs font-semibold">Lab · one Lighthouse run</div>
        {result.lab ? (
          <dl className="grid grid-cols-2 gap-3">
            <Detail label="Performance score" metric="performanceScore" value={result.lab.performanceScore} />
            <Detail label="LCP" metric="lcpMs" value={result.lab.lcpMs} />
            <Detail label="CLS" metric="cls" value={result.lab.cls} />
            <Detail label="TBT" metric="tbtMs" value={result.lab.tbtMs} />
            <Detail label="FCP" metric="fcpMs" value={result.lab.fcpMs} />
            <Detail label="Speed Index" metric="speedIndexMs" value={result.lab.speedIndexMs} />
          </dl>
        ) : (
          <p className="text-xs text-muted-foreground">No Lighthouse lab result saved.</p>
        )}
      </div>
    </div>
  );
}

function CwvResultsTable({ rows }: { rows: CwvResult[] }) {
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  return (
    <Table>
      <TableHeader>
        <TableRow className="hover:bg-transparent">
          <TableHead rowSpan={2} className="align-bottom">URL</TableHead>
          <TableHead colSpan={4} className="border-l border-border/70 normal-case tracking-normal">
            Real users · Chrome UX Report (28 days)
          </TableHead>
          <TableHead colSpan={4} className="border-l border-border/70 normal-case tracking-normal">
            Lab · Lighthouse (one simulated load)
          </TableHead>
        </TableRow>
        <TableRow className="hover:bg-transparent">
          <TableHead className="border-l border-border/70">LCP</TableHead>
          <TableHead>INP</TableHead>
          <TableHead>CLS</TableHead>
          <TableHead>Overall</TableHead>
          <TableHead className="border-l border-border/70">Score</TableHead>
          <TableHead>LCP</TableHead>
          <TableHead>CLS</TableHead>
          <TableHead>TBT</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {rows.map((row) => {
          const key = `${row.url}:${row.strategy}`;
          const open = Boolean(expanded[key]);
          return (
            <Fragment key={key}>
              <TableRow>
                <TableCell className="min-w-64 max-w-md">
                  <button
                    type="button"
                    aria-expanded={open}
                    onClick={() => setExpanded((current) => ({ ...current, [key]: !open }))}
                    className="flex items-start gap-1.5 rounded-sm text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/60"
                  >
                    {open ? <ChevronDown className="mt-0.5 size-3.5 shrink-0" /> : <ChevronRight className="mt-0.5 size-3.5 shrink-0" />}
                    <span className="min-w-0">
                      <span className="block break-all text-sm font-medium">{row.url}</span>
                      <span className="block text-xs text-muted-foreground">
                        {row.strategy} · {row.fetchedAt ? formatDate(row.fetchedAt) : "not fetched"}
                      </span>
                    </span>
                  </button>
                </TableCell>
                {row.error && !row.field && !row.lab ? (
                  <TableCell colSpan={8} className="border-l border-border/70 text-sm text-destructive">
                    {row.error}
                  </TableCell>
                ) : (
                  <>
                    {row.field ? (
                      <>
                        <MetricCell metric="lcpMs" value={row.field.lcpMs} className="border-l border-border/70" />
                        <MetricCell metric="inpMs" value={row.field.inpMs} />
                        <MetricCell metric="cls" value={row.field.cls} />
                        <OverallCell field={row.field} />
                      </>
                    ) : (
                      <TableCell colSpan={4} className="border-l border-border/70 text-xs text-muted-foreground">
                        No field data from Chrome UX Report
                        {row.originField ? <span className="block">Origin: {cwvSummaryText(row.originField)}</span> : null}
                      </TableCell>
                    )}
                    {row.lab ? (
                      <>
                        <MetricCell metric="performanceScore" value={row.lab.performanceScore} className="border-l border-border/70" />
                        <MetricCell metric="lcpMs" value={row.lab.lcpMs} />
                        <MetricCell metric="cls" value={row.lab.cls} />
                        <MetricCell metric="tbtMs" value={row.lab.tbtMs} />
                      </>
                    ) : (
                      <TableCell colSpan={4} className="border-l border-border/70 text-xs text-muted-foreground">
                        {row.error || "No lab result"}
                      </TableCell>
                    )}
                  </>
                )}
              </TableRow>
              {open ? (
                <TableRow className="hover:bg-transparent">
                  <TableCell colSpan={9} className="bg-muted/25">
                    <ResultDetails result={row} />
                    {row.error ? <p className="pb-2 text-xs text-destructive">{row.error}</p> : null}
                  </TableCell>
                </TableRow>
              ) : null}
            </Fragment>
          );
        })}
      </TableBody>
    </Table>
  );
}

// Loads saved Core Web Vitals results and polls while a run is going.
function useCwvStatus(siteId: string) {
  const [status, setStatus] = useState<CwvStatus | null>(null);
  const [error, setError] = useState("");
  const [watching, setWatching] = useState(false);
  const tokenRef = useRef(0);

  async function load() {
    const token = ++tokenRef.current;
    try {
      const next = await api.cwvStatus(siteId);
      if (token !== tokenRef.current) return null;
      setStatus(next);
      setError("");
      return next;
    } catch (err) {
      if (token !== tokenRef.current) return null;
      setError(err instanceof Error ? err.message : "Could not load Core Web Vitals");
      return null;
    }
  }

  useEffect(() => {
    setStatus(null);
    setError("");
    setWatching(false);
    load();
  }, [siteId]);

  const running = Boolean(status?.running) || watching;
  useEffect(() => {
    if (!running) return;
    let cancelled = false;
    let timer = 0;
    const poll = async () => {
      const next = await load();
      if (cancelled) return;
      if (next && !next.running) {
        setWatching(false);
        return;
      }
      timer = window.setTimeout(poll, POLL_MS);
    };
    timer = window.setTimeout(poll, POLL_MS);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [siteId, running]);

  return { status, error, running, reload: load, startWatching: () => setWatching(true) };
}

const keylessNote =
  "No PageSpeed Insights API key is configured, so checks use Google's shared keyless quota. It is small and may be rate limited; add a key to the local app configuration to run more checks.";

// Core Web Vitals for the scan report's Speed tab: run PageSpeed Insights for
// a strategy and compare field (Chrome UX Report) with lab (Lighthouse) data.
export function CwvPanel({ siteId, suggestedUrls = [] }: { siteId: string; suggestedUrls?: string[] }) {
  const { status, error, running, reload, startWatching } = useCwvStatus(siteId);
  const [strategy, setStrategy] = useState<CwvStrategy>("mobile");
  const [limit, setLimit] = useState("10");
  const [urlsText, setUrlsText] = useState("");
  const [starting, setStarting] = useState(false);
  const results = (status?.latest || []).filter((row) => row.strategy === strategy);
  const otherStrategyCount = (status?.latest || []).length - results.length;

  async function run() {
    setStarting(true);
    try {
      const urls = urlsText.split(/\n|,/).map((item) => item.trim()).filter(Boolean);
      await api.runCwv(siteId, urls.length ? { urls, strategy } : { strategy, limit: Number(limit) });
      toast.info("Core Web Vitals check started. Results appear here as pages finish.");
      startWatching();
      await reload();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not start the Core Web Vitals check");
    } finally {
      setStarting(false);
    }
  }

  return (
    <ReportSection
      title="Core Web Vitals"
      description="Field data is what real Chrome users experienced over the last 28 days (Chrome UX Report). Lab data is one simulated Lighthouse load. Thresholds follow Google: LCP ≤ 2.5 s good, > 4 s poor; INP ≤ 200 ms good, > 500 ms poor; CLS ≤ 0.1 good, > 0.25 poor."
      meta={status ? `${formatNumber(results.length)} ${strategy} ${results.length === 1 ? "URL" : "URLs"}` : undefined}
      action={
        <>
          <Select value={strategy} onValueChange={(value) => setStrategy(value === "desktop" ? "desktop" : "mobile")}>
            <SelectTrigger className="h-8 w-[118px] text-xs" aria-label="Device strategy">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="mobile">Mobile</SelectItem>
              <SelectItem value="desktop">Desktop</SelectItem>
            </SelectContent>
          </Select>
          <Select value={limit} onValueChange={setLimit} disabled={Boolean(urlsText.trim())}>
            <SelectTrigger className="h-8 w-[118px] text-xs" aria-label="Pages to check">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {["5", "10", "25"].map((value) => (
                <SelectItem key={value} value={value}>{value} pages</SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Button size="sm" onClick={run} disabled={starting || running || Boolean(error && !status)}>
            {running ? <LoaderCircle className="animate-spin motion-reduce:animate-none" /> : <Gauge />}
            {running ? "Checking" : starting ? "Starting" : "Run check"}
          </Button>
        </>
      }
    >
      {error && !status ? (
        <EmptyState
          title="Core Web Vitals unavailable"
          text={`${error}. The local API did not return Core Web Vitals data.`}
          action={<Button variant="secondary" onClick={() => reload()}><RefreshCw /> Retry</Button>}
        />
      ) : !status ? (
        <div className="space-y-2" role="status" aria-busy="true" aria-label="Loading Core Web Vitals">
          <Skeleton className="h-8 w-full" />
          <Skeleton className="h-24 w-full" />
        </div>
      ) : (
        <div className="space-y-4">
          {!status.keyConfigured ? (
            <p className="rounded-lg border border-warn/25 bg-warn-soft px-3.5 py-2.5 text-[13px] leading-5">{keylessNote}</p>
          ) : null}
          <details className="rounded-lg border border-border/60 px-3.5 py-2.5 text-sm">
            <summary className="cursor-pointer text-[13px] text-muted-foreground">Check specific URLs instead</summary>
            <div className="mt-2 space-y-2">
              <Textarea
                value={urlsText}
                onChange={(event) => setUrlsText(event.target.value)}
                placeholder={suggestedUrls[0] || "https://example.com/page"}
                aria-label="URLs to check, one per line"
              />
              <p className="text-xs text-muted-foreground">One URL per line. Leave empty to let the app pick pages from the latest scan.</p>
            </div>
          </details>
          {running ? (
            <p className="flex items-center gap-2 text-[13px] text-muted-foreground" role="status">
              <StatusDot tone="warn" /> A check is running. Saved results refresh every few seconds.
            </p>
          ) : null}
          {results.length ? (
            <CwvResultsTable rows={results} />
          ) : (
            <EmptyState
              icon={Gauge}
              title={`No ${strategy} results yet`}
              text={
                otherStrategyCount
                  ? `${formatNumber(otherStrategyCount)} saved results use the other strategy. Switch strategy or run a ${strategy} check.`
                  : "Run a check to fetch Chrome UX Report field data and a Lighthouse lab run for your top pages."
              }
            />
          )}
          <p className="text-xs leading-5 text-muted-foreground">
            Ratings use Google's thresholds and are shown as text, not colour alone. TBT and the performance score use Lighthouse's bands (TBT ≤ 200 ms good, &gt; 600 ms poor; score ≥ 90 good, &lt; 50 poor).
          </p>
        </div>
      )}
    </ReportSection>
  );
}

function OriginVitals({ field }: { field: CwvFieldMetrics }) {
  const items: { label: string; metric: MetricKey; value: unknown }[] = [
    { label: "LCP", metric: "lcpMs", value: field.lcpMs },
    { label: "INP", metric: "inpMs", value: field.inpMs },
    { label: "CLS", metric: "cls", value: field.cls },
  ];
  return (
    <dl className="grid grid-cols-3 gap-3">
      {items.map((item) => {
        const rating = cwvRating(item.metric, item.value);
        return (
          <div key={item.label} className="min-w-0 rounded-xl border border-border/70 bg-muted px-3.5 py-3">
            <dt className="eyebrow-muted">{item.label}</dt>
            <dd className="metric mt-1 text-xl leading-none">{formatCwvValue(item.metric, item.value)}</dd>
            <dd className="mt-1.5">{rating ? <RatingText rating={rating} /> : <span className="text-xs text-muted-foreground">No data</span>}</dd>
          </div>
        );
      })}
    </dl>
  );
}

// Compact Core Web Vitals card for the site overview: origin-level field data
// from the newest saved check, linking to the full panel on the Speed tab.
export function CwvOverviewCard({ siteId }: { siteId: string }) {
  const { status, error, running } = useCwvStatus(siteId);
  const latest = status?.latest || [];
  const withOrigin = latest.find((row) => row.originField && row.strategy === "mobile") || latest.find((row) => row.originField);
  const newest = latest.reduce<CwvResult | null>(
    (best, row) => (!best || String(row.fetchedAt || "") > String(best.fetchedAt || "") ? row : best),
    null,
  );
  let body: ReactNode;
  if (error && !status) {
    body = <p className="text-sm text-muted-foreground">Core Web Vitals are unavailable: {error}</p>;
  } else if (!status) {
    body = <Skeleton className="h-20 w-full" />;
  } else if (!latest.length) {
    body = (
      <p className="text-sm text-muted-foreground">
        {running ? "A check is running." : "No Core Web Vitals check yet. Run one from the scan report's Speed tab."}
      </p>
    );
  } else if (withOrigin?.originField) {
    body = (
      <div className="space-y-2">
        <OriginVitals field={withOrigin.originField} />
        <p className="text-xs text-muted-foreground">
          Whole-site real users ({withOrigin.strategy}), Chrome UX Report, 28 days · checked {formatDate(withOrigin.fetchedAt)}
        </p>
      </div>
    );
  } else {
    body = (
      <p className="text-sm text-muted-foreground">
        No field data from Chrome UX Report for this site yet (too little real-user traffic is recorded). {formatNumber(latest.length)} lab {latest.length === 1 ? "result is" : "results are"} saved.
      </p>
    );
  }
  return (
    <ReportSection
      title="Core Web Vitals"
      description="Real-user field data from the Chrome UX Report (28 days), separate from lab Lighthouse runs."
      meta={newest?.fetchedAt ? `Last check ${formatDate(newest.fetchedAt)}` : undefined}
      action={
        <Button asChild size="sm" variant="outline">
          <Link to="/scans?tab=speed"><Gauge /> Open speed report</Link>
        </Button>
      }
    >
      <div className="space-y-2">
        {body}
        {status && !status.keyConfigured ? (
          <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
            Using the keyless PageSpeed quota
            <InfoTip label="About the keyless quota">{keylessNote}</InfoTip>
          </p>
        ) : null}
      </div>
    </ReportSection>
  );
}
