import { useEffect, useRef, useState, type ReactNode, type SyntheticEvent } from "react";
import { Link, useLocation, useNavigate, useParams, useSearchParams } from "react-router-dom";
import { CheckCircle2, Download, ExternalLink, FileSearch, Plus, RefreshCw, Trash2 } from "lucide-react";
import { api, isNotFoundError, type ScanRow, type Site } from "../../../api";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle, Badge, Button, Input, Popover, PopoverContent, PopoverTrigger, Select, SelectContent, SelectItem, SelectTrigger, SelectValue, toast } from "@/components/ui";
import { EmptyState, Field, Hint, PageHeader, ReportSection, StatusDot, clearSelectedScanId, formatDate, formatNumber, getSelectedScanId, hostFromUrl, preferredScanUrl, scanCrawlLabel, scanIsActive, scanPhaseLabel, scanStatusLabel, scanTime, scanUrlShortDetail, scoreMeaning, scoreTone, scoreVerdict, setSelectedScanId, sortScanRows, upsertScanRow } from "../../shared";
import { ScanScheduleInline } from "../../schedule";
import { cn } from "@/lib/utils";
import { CancelScanButton, ScanReportSkeleton, TabCard, defaultScanTab, scanStatusTone } from "./common";
import { ScanDetail, isScanTab } from "./detail";
import { ScanTable } from "./scan-table";

const POLL_MS = 1500;
// While a scan runs, lite list rows carry live progress every tick; the full
// report (pages, issues, links) is refetched less often to keep polling cheap.
const FULL_REFRESH_EVERY = 3;

type DetailState = {
  id: string;
  status: "loading" | "ready" | "missing" | "error" | "other-site";
  message?: string;
  siteName?: string;
};

function mergeLiteRow(full: any, lite: ScanRow) {
  return {
    ...full,
    status: lite.status,
    score: lite.score,
    pages_crawled: lite.pages_crawled,
    issue_count: lite.issue_count,
    error: lite.error,
    updated_at: lite.updated_at,
    result: {
      ...(full.result || {}),
      phase: lite.result?.phase ?? full.result?.phase,
      progress: lite.result?.progress ?? full.result?.progress,
      summary: lite.result?.summary ?? full.result?.summary,
      limits: lite.result?.limits ?? full.result?.limits,
    },
  };
}

export function ScansPage({ site, switchSite }: { site: Site; switchSite?: (siteId: string) => boolean }) {
  const navigate = useNavigate();
  const location = useLocation();
  const { scanId: routeScanId = "" } = useParams();
  const [searchParams] = useSearchParams();
  const [url, setUrl] = useState(preferredScanUrl(site));
  const [scans, setScans] = useState<ScanRow[]>([]);
  const [listLoaded, setListLoaded] = useState(false);
  const [listError, setListError] = useState("");
  const [detail, setDetail] = useState<any>(null);
  const [detailState, setDetailState] = useState<DetailState>({ id: "", status: "loading" });
  const [deletingScan, setDeletingScan] = useState<any>(null);
  const [deletePending, setDeletePending] = useState(false);
  const [clearingScans, setClearingScans] = useState(false);
  const [confirmClearScans, setConfirmClearScans] = useState(false);
  const [starting, setStarting] = useState(false);
  const [showCustomUrl, setShowCustomUrl] = useState(false);
  // The scan the user just started from this page, so a finished run can be
  // announced while another report stays open.
  const [startedScanId, setStartedScanId] = useState("");
  const listToken = useRef(0);
  const detailToken = useRef(0);
  const detailRef = useRef<any>(detail);
  detailRef.current = detail;
  const routeScanIdRef = useRef(routeScanId);
  routeScanIdRef.current = routeScanId;
  const seededTab = useRef({ id: "", tab: "overview" });
  // Scans whose full report answered 404 (deleted mid-run). They are dropped
  // from the list so the poller never keeps tracking a scan that is gone.
  const missingIds = useRef(new Set<string>());

  function forgetScan(id: string) {
    missingIds.current.add(id);
    setScans((rows) => rows.filter((row) => row.id !== id));
    setDetail((prev: any) => (prev?.id === id ? null : prev));
    setDetailState({ id, status: "missing" });
  }

  async function loadList() {
    const token = ++listToken.current;
    try {
      const rows = sortScanRows(await api.scans(site.id)).filter((row) => !missingIds.current.has(row.id));
      if (token !== listToken.current) return null;
      setScans(rows);
      setListError("");
      setListLoaded(true);
      return rows;
    } catch (err) {
      if (token === listToken.current) {
        setListError(err instanceof Error ? err.message : "Could not load saved scans");
        setListLoaded(true);
      }
      return null;
    }
  }

  function loadDetail(id: string) {
    const token = ++detailToken.current;
    setDetailState({ id, status: "loading" });
    api
      .scan(id)
      .then((row) => {
        if (token !== detailToken.current) return;
        if (!row) {
          setDetail(null);
          setDetailState({ id, status: "missing" });
          return;
        }
        if (row.site_id && row.site_id !== site.id) {
          // A deep link to another site's scan: switch the workspace to that
          // site (the page remounts under it) instead of showing a different
          // scan under this URL.
          if (switchSite?.(row.site_id)) return;
          setDetail(null);
          setDetailState({ id, status: "other-site", siteName: row.site_name || row.site_domain || hostFromUrl(row.url) });
          return;
        }
        setDetail(row);
        setDetailState({ id, status: "ready" });
        setSelectedScanId(site.id, row.id);
      })
      .catch((err) => {
        if (token !== detailToken.current) return;
        setDetail(null);
        setDetailState({
          id,
          status: isNotFoundError(err) ? "missing" : "error",
          message: err instanceof Error ? err.message : "Could not load this scan report",
        });
      });
  }

  function refresh() {
    loadList();
    if (routeScanIdRef.current) loadDetail(routeScanIdRef.current);
  }

  // The lite list loads per site and again whenever the bare /scans route is
  // visited, which then resolves to the remembered or newest scan.
  const onIndexRoute = !routeScanId;
  useEffect(() => {
    let cancelled = false;
    loadList().then((rows) => {
      if (cancelled || !rows || routeScanIdRef.current) return;
      const remembered = getSelectedScanId(site.id);
      const target = rows.find((row) => row.id === remembered) || rows[0];
      if (target) navigate({ pathname: `/scans/${target.id}`, search: location.search }, { replace: true });
    });
    return () => {
      cancelled = true;
    };
  }, [site.id, onIndexRoute]);

  useEffect(() => {
    if (!routeScanId) return;
    if (detailRef.current?.id === routeScanId) {
      setDetailState({ id: routeScanId, status: "ready" });
      return;
    }
    loadDetail(routeScanId);
  }, [routeScanId, site.id]);

  useEffect(() => {
    setUrl(preferredScanUrl(site));
    setShowCustomUrl(false);
  }, [site.id, site.domain, site.crawl_protocol, site.crawl_host]);

  const viewed = detail && detail.id === routeScanId ? detail : null;
  const hasActive = scans.some(scanIsActive) || scanIsActive(viewed);

  // One poller while this site has an active scan. Each request is scheduled
  // after the previous one settles, so requests never overlap.
  useEffect(() => {
    if (!hasActive) return;
    let cancelled = false;
    let timer = 0;
    let tick = 0;
    const poll = async () => {
      const rows = await loadList();
      if (cancelled) return;
      const current = detailRef.current;
      if (rows && current && current.id === routeScanIdRef.current) {
        const lite = rows.find((row) => row.id === current.id);
        tick += 1;
        const finished = Boolean(lite) && scanIsActive(current) && !scanIsActive(lite);
        // An active scan that left the list was probably deleted: check once
        // right away instead of waiting for the next full refresh.
        const vanished = !lite && scanIsActive(current);
        if (finished || vanished || (scanIsActive(lite || current) && tick % FULL_REFRESH_EVERY === 0)) {
          const token = detailToken.current;
          try {
            const full = await api.scan(current.id);
            if (!cancelled && token === detailToken.current && current.id === detailRef.current?.id) {
              if (full?.id) setDetail(full);
              else forgetScan(current.id);
            }
          } catch (err) {
            // A scan deleted mid-run stops being tracked; other errors retry
            // on the next tick while the lite row keeps showing progress.
            if (!cancelled && token === detailToken.current && isNotFoundError(err)) forgetScan(current.id);
          }
        } else if (lite && scanIsActive(lite)) {
          setDetail((prev: any) => (prev?.id === lite.id ? mergeLiteRow(prev, lite) : prev));
        }
      }
      if (!cancelled) timer = window.setTimeout(poll, POLL_MS);
    };
    timer = window.setTimeout(poll, POLL_MS);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [site.id, hasActive]);

  // A freshly started scan opens right away on its Progress tab.
  function openStartedScan(scan: any) {
    if (!scan?.id) return;
    detailToken.current += 1;
    setScans((rows) => upsertScanRow(rows, scan));
    setStartedScanId(scan.id);
    setDetail(scan);
    setDetailState({ id: scan.id, status: "ready" });
    setSelectedScanId(site.id, scan.id);
    navigate(`/scans/${scan.id}`);
  }
  async function start(event: SyntheticEvent) {
    event.preventDefault();
    setStarting(true);
    try {
      const scan = await api.startScan({ siteId: site.id, url });
      openStartedScan(scan);
      setShowCustomUrl(false);
      loadList();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not start scan");
    } finally {
      setStarting(false);
    }
  }
  async function startSelectedSite() {
    if (!site.domain) return;
    setStarting(true);
    try {
      const result = await api.scanSite(site.id);
      openStartedScan(result.scan);
      loadList();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not start site scan");
    } finally {
      setStarting(false);
    }
  }
  function inspect(id: string) {
    setSelectedScanId(site.id, id);
    if (id !== routeScanId) navigate(`/scans/${id}`);
  }
  async function remove(scan: any) {
    const siteId = scan?.site_id || site.id;
    setDeletePending(true);
    try {
      await api.deleteScan(siteId, scan.id);
      if (getSelectedScanId(siteId) === scan.id) clearSelectedScanId(siteId);
      setDeletingScan(null);
      if (scan.id === routeScanId) {
        setDetail(null);
        navigate("/scans", { replace: true });
      } else {
        await loadList();
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not delete the saved scan.");
    } finally {
      setDeletePending(false);
    }
  }
  async function clearHistory() {
    setClearingScans(true);
    try {
      await api.clearScans(site.id);
      clearSelectedScanId(site.id);
      setDetail(null);
      setConfirmClearScans(false);
      if (routeScanId) navigate("/scans", { replace: true });
      else await loadList();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not clear scan history");
    } finally {
      setClearingScans(false);
    }
  }

  if (viewed && seededTab.current.id !== viewed.id) {
    seededTab.current = { id: viewed.id, tab: defaultScanTab(viewed) };
  }
  const defaultTab = viewed ? seededTab.current.tab : "overview";
  const urlTab = searchParams.get("tab");
  const effectiveTab = isScanTab(urlTab) ? urlTab : defaultTab;
  const barScan = viewed || scans.find((row) => row.id === routeScanId) || null;
  const runningOther = scans.find((row) => scanIsActive(row) && row.id !== routeScanId) || null;
  const startedScan = startedScanId ? scans.find((row) => row.id === startedScanId) : null;
  const startedFinished = startedScan && !scanIsActive(startedScan) && startedScan.id !== routeScanId ? startedScan : null;
  const newerCount = barScan ? scans.filter((row) => scanTime(row) > scanTime(barScan)).length : 0;
  const detailFailed = Boolean(routeScanId && !viewed && detailState.id === routeScanId && detailState.status !== "loading" && detailState.status !== "ready");
  // Scan history lives on the Overview tab only — the context bar's switcher
  // already moves between scans everywhere else.
  const showHistory = listLoaded && (!routeScanId || detailFailed || effectiveTab === "overview");
  const compareFromHistory =
    viewed && !scanIsActive(viewed)
      ? (row: any) => navigate(`/scans/${viewed.id}?tab=changes&compare=${row.id}`)
      : undefined;

  let reportBody: ReactNode;
  if (routeScanId) {
    if (viewed) {
      reportBody = <ScanDetail scan={viewed} defaultTab={defaultTab} siteRows={scans} />;
    } else if (detailFailed && detailState.status === "missing") {
      reportBody = (
        <TabCard>
          <EmptyState
            title="Scan not found"
            text="This saved scan no longer exists in local SQLite. Pick another scan from the history below."
            action={<Button asChild variant="secondary"><Link to="/scans"><FileSearch /> Open the latest scan</Link></Button>}
          />
        </TabCard>
      );
    } else if (detailFailed && detailState.status === "other-site") {
      reportBody = (
        <TabCard>
          <EmptyState
            title="This scan belongs to another site"
            text={`The scan in this link was saved for ${detailState.siteName || "a different site"}, which is not in your site list. Scans for ${site.name} are listed below.`}
            action={<Button asChild variant="secondary"><Link to="/scans"><FileSearch /> Open {site.name} scans</Link></Button>}
          />
        </TabCard>
      );
    } else if (detailFailed) {
      reportBody = (
        <TabCard>
          <EmptyState
            title="Could not load this scan report"
            text={detailState.message || "The local API did not return the saved report."}
            action={<Button variant="secondary" onClick={() => loadDetail(routeScanId)}><RefreshCw /> Retry</Button>}
          />
        </TabCard>
      );
    } else {
      reportBody = <ScanReportSkeleton />;
    }
  } else if (!listLoaded || scans.length) {
    reportBody = <ScanReportSkeleton />;
  } else {
    reportBody = (
      <TabCard>
        <EmptyState
          title={listError ? "Could not load saved scans" : "No scan report yet"}
          text={listError || "Start a local site scan to fill this report with crawl evidence."}
          action={
            listError ? (
              <Button variant="secondary" onClick={() => loadList()}><RefreshCw /> Retry</Button>
            ) : site.domain ? (
              <Button onClick={startSelectedSite} disabled={starting}>
                <FileSearch /> {starting ? "Starting" : "Scan website"}
              </Button>
            ) : (
              <Button asChild><Link to="/"><Plus /> Add site</Link></Button>
            )
          }
        />
      </TabCard>
    );
  }

  return (
    <>
      <PageHeader
        title="Site scans"
        description="Scan the active site's saved crawl URL and open the report when it completes."
        meta={site.domain ? (
          <div className="space-y-2">
            <span className="flex flex-wrap items-center gap-x-2">
              <span>{site.domain}</span>
              <span className="text-border">·</span>
              <Hint tip={`Crawl starts at ${preferredScanUrl(site)}`}>{scanUrlShortDetail(site)}</Hint>
            </span>
            <ScanScheduleInline siteId={site.id} />
          </div>
        ) : (
          "No website address yet"
        )}
        action={
          <>
            {site.domain ? (
              <Button disabled={starting} onClick={startSelectedSite}>
                <FileSearch /> {starting ? "Starting" : `Scan ${site.domain}`}
              </Button>
            ) : (
              <Button asChild><Link to="/"><Plus /> Add site</Link></Button>
            )}
            <Popover open={showCustomUrl} onOpenChange={setShowCustomUrl}>
              <PopoverTrigger asChild>
                <Button type="button" variant="outline">Specific URL</Button>
              </PopoverTrigger>
              <PopoverContent align="end" className="w-96 max-w-[calc(100vw-2rem)]">
                <form className="space-y-3" onSubmit={start}>
                  <Field label="URL to scan">
                    <Input value={url} onChange={(e) => setUrl(e.target.value)} placeholder={`${preferredScanUrl(site) || "https://example.com"}/page`} />
                  </Field>
                  <Button className="w-full" variant="secondary" disabled={starting || !url.trim()}>
                    <FileSearch /> {starting ? "Starting" : "Scan URL"}
                  </Button>
                </form>
              </PopoverContent>
            </Popover>
          </>
        }
      />
      {listError && scans.length ? (
        <p className="mb-6 rounded-lg bg-bad-soft/50 px-3.5 py-2.5 text-sm text-destructive">{listError}</p>
      ) : null}
      <div className="space-y-8">
        <section>
          {runningOther ? (
            <NewScanBanner
              tone="running"
              title="Another scan is running"
              detailText={`${runningOther.url} · ${scanPhaseLabel(runningOther)} · ${scanCrawlLabel(runningOther)}`}
              onView={() => inspect(runningOther.id)}
            />
          ) : startedFinished ? (
            <NewScanBanner
              tone="done"
              title={startedFinished.status === "completed" ? "Your new scan finished" : `Your new scan ${scanStatusLabel(startedFinished.status)}`}
              detailText={`${startedFinished.url} · ${formatNumber(Number(startedFinished.score || 0))}% ${scoreMeaning.toLowerCase()} · ${formatNumber(startedFinished.pages_crawled || 0)} pages`}
              onView={() => inspect(startedFinished.id)}
              onDismiss={() => setStartedScanId("")}
            />
          ) : null}
          {barScan ? (
            <ScanContextBar
              scan={barScan}
              siteRows={scans}
              newerCount={newerCount}
              onSwitch={inspect}
              onCancelled={refresh}
            />
          ) : null}
          {reportBody}
        </section>
        {showHistory ? (
          <ReportSection
            title="Scan history"
            meta={`${formatNumber(scans.length)} saved for this site`}
            action={scans.length ? (
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="text-muted-foreground hover:text-bad"
                onClick={() => setConfirmClearScans(true)}
                disabled={clearingScans}
              >
                <Trash2 /> Delete scans for this site
              </Button>
            ) : undefined}
          >
            {scans.length ? (
              <ScanTable
                rows={scans}
                activeSiteId={site.id}
                selectedId={routeScanId}
                onInspect={inspect}
                onCompare={compareFromHistory}
                onDelete={(id) => setDeletingScan(scans.find((scan) => scan.id === id) || { id })}
              />
            ) : (
              <EmptyState
                title="No scans yet"
                text={site.domain ? "Start a technical scan for this site." : "Add a website address before running a scan."}
                action={site.domain ? (
                  <Button onClick={startSelectedSite} disabled={starting}>
                    <FileSearch /> {starting ? "Starting" : "Scan website"}
                  </Button>
                ) : (
                  <Button asChild><Link to="/"><Plus /> Add site</Link></Button>
                )}
              />
            )}
          </ReportSection>
        ) : null}
      </div>
      <AlertDialog open={Boolean(deletingScan)} onOpenChange={(nextOpen) => !nextOpen && !deletePending && setDeletingScan(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete scan?</AlertDialogTitle>
            <AlertDialogDescription>
              This removes the saved report for {deletingScan?.url || "this scan"} from local SQLite. Other scans for the same site stay available.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={deletePending}>Cancel</AlertDialogCancel>
            <AlertDialogAction type="button" disabled={deletePending} onClick={() => deletingScan && remove(deletingScan)}>
              {deletePending ? "Deleting scan" : "Delete scan"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
      <AlertDialog open={confirmClearScans} onOpenChange={(nextOpen) => !clearingScans && setConfirmClearScans(nextOpen)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete scans for this site?</AlertDialogTitle>
            <AlertDialogDescription>
              This removes all saved scan reports for {site.domain || site.name} from local SQLite. The saved site, keywords, rankings, and settings stay in place.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={clearingScans}>Keep scans</AlertDialogCancel>
            <AlertDialogAction type="button" onClick={clearHistory} disabled={clearingScans}>
              {clearingScans ? "Deleting scans" : "Delete scans for this site"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}

function ScanContextBar({
  scan,
  siteRows,
  newerCount,
  onSwitch,
  onCancelled,
}: {
  scan: any;
  siteRows: any[];
  newerCount: number;
  onSwitch: (id: string) => void;
  onCancelled: () => void;
}) {
  const running = scanIsActive(scan);
  const completed = scan.status === "completed";
  const score = Number(scan.score || 0);
  return (
    <div className="mb-4 flex flex-wrap items-center justify-between gap-3 rounded-xl border border-border/60 bg-card/40 px-4 py-3">
      <div className="min-w-0">
        <div className="flex items-center gap-2 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
          Viewing scan
          {newerCount > 0 ? (
            <Badge variant="warn">{newerCount} newer {newerCount === 1 ? "scan" : "scans"}</Badge>
          ) : (
            <Badge variant="outline">Latest</Badge>
          )}
        </div>
        <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-sm">
          <span className="min-w-0 max-w-full break-all font-medium">{scan.url}</span>
          <span className="text-border">·</span>
          <span className="inline-flex items-center gap-1.5 whitespace-nowrap text-muted-foreground">
            <StatusDot tone={scanStatusTone(scan.status)} />
            {scanStatusLabel(scan.status)} · {formatDate(scan.created_at || scan.updated_at)}
          </span>
        </div>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        {running ? (
          <>
            <span className="inline-flex items-center gap-1.5 whitespace-nowrap text-xs text-muted-foreground">
              <StatusDot tone="warn" /> {scanPhaseLabel(scan)} · {scanCrawlLabel(scan)}
            </span>
            <CancelScanButton scan={scan} onCancelled={onCancelled} />
          </>
        ) : completed ? (
          <Hint tip={`${scoreMeaning}. Open issue counts are on the Overview tab.`} className="whitespace-nowrap text-sm text-muted-foreground">
            <span className="metric text-lg leading-none" style={{ color: scoreTone(score) }}>{formatNumber(score)}%</span>
            {" · "}
            {scoreVerdict(score)}
          </Hint>
        ) : null}
        {!running ? (
          <>
            <Button asChild size="sm" variant="outline">
              <a href={api.scanReportUrl(scan.id, true)} download>
                <Download /> Download report
              </a>
            </Button>
            <Button asChild size="sm" variant="ghost" className="text-muted-foreground hover:text-foreground">
              <a href={api.scanReportUrl(scan.id)} target="_blank" rel="noreferrer">
                <ExternalLink /> Open printable report
              </a>
            </Button>
          </>
        ) : null}
        {siteRows.length > 1 ? (
          <Select value={scan.id} onValueChange={onSwitch}>
            <SelectTrigger className="h-8 w-auto min-w-[190px]" aria-label="Switch to another saved scan">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {siteRows.map((row) => (
                <SelectItem key={row.id} value={row.id}>
                  {formatDate(row.created_at || row.updated_at)} · {row.status === "completed" ? `${formatNumber(Number(row.score || 0))}%` : scanStatusLabel(row.status)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        ) : null}
      </div>
    </div>
  );
}

function NewScanBanner({
  tone,
  title,
  detailText,
  onView,
  onDismiss,
}: {
  tone: "running" | "done";
  title: string;
  detailText: string;
  onView: () => void;
  onDismiss?: () => void;
}) {
  return (
    <div
      role="status"
      className={cn(
        "mb-3 flex flex-wrap items-center justify-between gap-3 rounded-xl border px-4 py-2.5 text-sm",
        tone === "done" ? "border-good/30 bg-good-soft" : "border-warn/30 bg-warn-soft",
      )}
    >
      <div className="flex min-w-0 items-center gap-2">
        {tone === "done" ? <CheckCircle2 aria-hidden className="size-4 shrink-0 text-good" /> : <StatusDot tone="warn" />}
        <span className="min-w-0">
          <span className="font-medium">{title}</span>
          <span className="ml-2 break-all text-muted-foreground">{detailText}</span>
        </span>
      </div>
      <div className="flex shrink-0 items-center gap-2">
        <Button size="sm" variant={tone === "done" ? "default" : "outline"} onClick={onView}>
          {tone === "done" ? "Open report" : "View progress"}
        </Button>
        {onDismiss ? (
          <Button size="sm" variant="ghost" onClick={onDismiss}>Dismiss</Button>
        ) : null}
      </div>
    </div>
  );
}
