import { Fragment, useEffect, useRef, useState, type SyntheticEvent } from "react";
import { Link } from "react-router-dom";
import { ChevronDown, ChevronRight, LoaderCircle, Plus, RefreshCw, Target, Trash2, Upload } from "lucide-react";
import { api, isNotFoundError, type RankRun, type RankRunsPage, type RankSnapshot, type RankTracker, type Site } from "../../api";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle, Badge, Button, Checkbox, Input, SortableTableHead, Table, TableBody, TableCell, TableHead, TableHeader, TableRow, Tabs, TabsContent, TabsList, TabsTrigger, Textarea, toast } from "@/components/ui";
import { EmptyState, Field, InfoTip, PageHeader, ProgressBar, ReportSection, formatDate, formatMetricStatus, formatNumber, keywordMetricClass, sourceLabel, sourceVariant } from "../shared";
import { FilteredRows, ServerPagedRows, type CsvColumn } from "../data-table";
import { ScheduleSelect, nextRunLabel, scheduleRuntimeNote, useSiteSchedule } from "../schedule";

const RANK_POLL_MS = 1500;
const RUNS_PAGE_SIZE = 25;
const RUN_ERROR_PREVIEW = 5;

function runIsActive(run?: RankRun | null) {
  return run?.status === "running" || run?.status === "queued";
}

function latestRankRun(tracker?: RankTracker | null) {
  return tracker?.runs?.[0] || null;
}

function runStatusVariant(status: string) {
  if (status === "completed") return "good";
  if (status === "partial") return "warn";
  if (status === "failed") return "bad";
  return "outline";
}

function runCheckedLabel(run: RankRun) {
  return `${formatNumber(run.checked_count ?? 0)} of ${formatNumber(run.keyword_count ?? 0)}`;
}

// A missing position only means "not found within the results that were
// actually checked", so the depth is always stated.
function rankPositionLabel(row: RankSnapshot) {
  if (row.position != null) return formatNumber(row.position);
  return row.depth_checked ? `Not in top ${formatNumber(row.depth_checked)} checked` : "Not found";
}

// Snapshot sources look like "duckduckgo:us-en" or "openserp:google:us-en":
// the provider (and OpenSERP engine) is the label, the rest is the locale.
function splitSnapshotSource(source?: string | null) {
  const parts = String(source || "").split(":").filter(Boolean);
  if (!parts.length) return { key: "", locale: "" };
  const providerParts = parts[0] === "openserp" ? 2 : 1;
  return { key: parts.slice(0, providerParts).join(":"), locale: parts.slice(providerParts).join(":") };
}

function SnapshotSource({ source }: { source?: string | null }) {
  const { key, locale } = splitSnapshotSource(source);
  if (!key) return <span className="text-xs text-muted-foreground">Not recorded</span>;
  return (
    <span className="inline-flex flex-wrap items-center gap-1.5">
      <Badge variant={sourceVariant(key) as any}>{sourceLabel(key)}</Badge>
      {locale ? <span className="text-xs text-muted-foreground">{locale}</span> : null}
    </span>
  );
}

function announceRun(domain: string, run: RankRun) {
  if (run.status === "completed") {
    toast.success(`Rank check for ${domain} finished: ${formatNumber(run.checked_count ?? 0)} keywords checked.`);
  } else if (run.status === "partial") {
    toast.warning(
      `Rank check for ${domain}: checked ${runCheckedLabel(run)} keywords; ${formatNumber(run.error_count ?? run.errors?.length ?? 0)} failed.`,
    );
  } else {
    toast.error(`Rank check for ${domain} failed${run.message ? `: ${run.message}` : "."}`);
  }
}

export function RankPage({ site }: { site: Site }) {
  const [trackers, setTrackers] = useState<RankTracker[]>([]);
  const [form, setForm] = useState({ domain: site.domain, keywords: "" });
  const [keywordDrafts, setKeywordDrafts] = useState<Record<string, string>>({});
  const [selectedKeywords, setSelectedKeywords] = useState<Record<string, Record<string, boolean>>>({});
  // Pending actions are tracked per tracker, so one tracker's work never
  // enables or disables another's buttons.
  const [busy, setBusy] = useState<Record<string, boolean>>({});
  // Rank checks run in the background: trackerId → run id being watched, and
  // the newest polled state of that run for live progress.
  const [watched, setWatched] = useState<Record<string, string>>({});
  const [liveRuns, setLiveRuns] = useState<Record<string, RankRun>>({});
  const [runsRefresh, setRunsRefresh] = useState(0);
  const watchedRef = useRef(watched);
  watchedRef.current = watched;
  const trackersRef = useRef(trackers);
  trackersRef.current = trackers;
  const [confirmRemove, setConfirmRemove] = useState<{ trackerId: string; domain: string; ids: string[] } | null>(null);
  const { schedule, error: scheduleError, saving: scheduleSaving, reload: reloadSchedule, setTrackerInterval } = useSiteSchedule(site.id);

  useEffect(() => {
    setForm((current) => ({ ...current, domain: site.domain }));
  }, [site.id, site.domain]);

  function setBusyKey(key: string, value: boolean) {
    setBusy((current) => {
      const next = { ...current };
      if (value) next[key] = true;
      else delete next[key];
      return next;
    });
  }

  function watchRun(trackerId: string, run: RankRun) {
    setWatched((current) => (current[trackerId] === run.id ? current : { ...current, [trackerId]: run.id }));
    setLiveRuns((current) => ({ ...current, [trackerId]: run }));
  }

  async function load() {
    try {
      const rows = await api.rankTrackers(site.id);
      setTrackers(rows);
      // A check started elsewhere (or before a reload) is picked up here.
      for (const tracker of rows) {
        const latest = latestRankRun(tracker);
        if (latest && runIsActive(latest) && !watchedRef.current[tracker.id]) watchRun(tracker.id, latest);
      }
      return rows;
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not load rank trackers");
      return null;
    }
  }
  useEffect(() => {
    setWatched({});
    setLiveRuns({});
    load().catch(console.error);
  }, [site.id]);

  const watching = Object.keys(watched).length > 0;
  // One sequential poller for every watched run: each tick fetches the watched
  // runs, then schedules the next tick, so requests never overlap.
  useEffect(() => {
    if (!watching) return;
    let cancelled = false;
    let timer = 0;
    const tick = async () => {
      const entries = Object.entries(watchedRef.current);
      const active: Record<string, RankRun> = {};
      const finished: { trackerId: string; runId: string; run?: RankRun }[] = [];
      await Promise.all(
        entries.map(async ([trackerId, runId]) => {
          try {
            const run = await api.rankRun(trackerId, runId);
            if (runIsActive(run)) active[trackerId] = run;
            else finished.push({ trackerId, runId, run });
          } catch (err) {
            // A deleted run or tracker stops being watched; other errors retry.
            if (isNotFoundError(err)) finished.push({ trackerId, runId });
          }
        }),
      );
      if (cancelled) return;
      if (Object.keys(active).length) setLiveRuns((current) => ({ ...current, ...active }));
      if (finished.length) {
        setWatched((current) => {
          const next = { ...current };
          for (const item of finished) if (next[item.trackerId] === item.runId) delete next[item.trackerId];
          return next;
        });
        setLiveRuns((current) => {
          const next = { ...current };
          for (const item of finished) delete next[item.trackerId];
          return next;
        });
        for (const item of finished) {
          if (!item.run) continue;
          const tracker = trackersRef.current.find((row) => row.id === item.trackerId);
          announceRun(tracker?.domain || "this tracker", item.run);
        }
        await load();
        reloadSchedule();
        setRunsRefresh((value) => value + 1);
      }
      if (!cancelled) timer = window.setTimeout(tick, RANK_POLL_MS);
    };
    timer = window.setTimeout(tick, RANK_POLL_MS);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [site.id, watching]);

  async function create(event: SyntheticEvent) {
    event.preventDefault();
    setBusyKey("create", true);
    try {
      await api.createRankTracker({
        siteId: site.id,
        domain: form.domain,
        keywords: form.keywords.split(/\n|,/).map((item) => item.trim()).filter(Boolean),
      });
      setForm({ domain: site.domain, keywords: "" });
      toast.success("Rank tracker created.");
      await load();
      reloadSchedule();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not create rank tracker");
    } finally {
      setBusyKey("create", false);
    }
  }

  function activeRun(tracker: RankTracker) {
    const latest = latestRankRun(tracker);
    return liveRuns[tracker.id] || (runIsActive(latest) ? latest : null);
  }

  async function check(tracker: RankTracker) {
    const key = `check:${tracker.id}`;
    if (busy[key] || watched[tracker.id] || runIsActive(latestRankRun(tracker))) return;
    setBusyKey(key, true);
    try {
      const result = await api.runRankCheck(tracker.id);
      const updated = result.tracker;
      if (updated?.id) setTrackers((rows) => rows.map((row) => (row.id === updated.id ? updated : row)));
      const run = result.run;
      if (run && runIsActive(run)) {
        watchRun(tracker.id, { ...run, id: result.runId || run.id });
        if (result.alreadyRunning) toast.info(`A check is already running for ${tracker.domain}. Following its progress.`);
        else toast.info(`Rank check for ${tracker.domain} started. Results appear here when it finishes.`);
      } else if (run) {
        // The run already ended (e.g. a duplicate request raced a finish).
        announceRun(tracker.domain, run);
        await load();
        setRunsRefresh((value) => value + 1);
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not start the rank check");
    } finally {
      setBusyKey(key, false);
    }
  }

  async function addKeywords(trackerId: string) {
    const keywords = (keywordDrafts[trackerId] || "").split(/\n|,/).map((item) => item.trim()).filter(Boolean);
    if (!keywords.length) return;
    const key = `add:${trackerId}`;
    setBusyKey(key, true);
    try {
      await api.addRankKeywords(trackerId, keywords);
      setKeywordDrafts((current) => ({ ...current, [trackerId]: "" }));
      toast.success(`Added ${keywords.length} keywords.`);
      await load();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not add keywords");
    } finally {
      setBusyKey(key, false);
    }
  }

  function selectedKeywordIds(trackerId: string) {
    return Object.entries(selectedKeywords[trackerId] || {}).filter(([, checked]) => checked).map(([id]) => id);
  }

  async function removeKeywords(trackerId: string, ids: string[]) {
    if (!ids.length) return;
    const key = `remove:${trackerId}`;
    setBusyKey(key, true);
    try {
      await api.removeRankKeywords(trackerId, ids);
      setSelectedKeywords((current) => ({ ...current, [trackerId]: {} }));
      toast.success(`Removed ${ids.length} keywords.`);
      setConfirmRemove(null);
      await load();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not remove keywords");
    } finally {
      setBusyKey(key, false);
    }
  }

  async function syncMetrics(trackerId: string) {
    const key = `metrics:${trackerId}`;
    setBusyKey(key, true);
    try {
      const result = await api.syncRankMetrics(trackerId);
      toast.success(`Synced imported metrics for ${formatNumber(result.updated || 0)} keywords${result.skipped ? `; ${formatNumber(result.skipped)} still need CSV metrics` : ""}.`);
      await load();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not sync keyword metrics");
    } finally {
      setBusyKey(key, false);
    }
  }

  return (
    <>
      <PageHeader title="Rank tracking" description="Track keyword positions from real search results. Checks use a connected search data source when available, OpenSERP when configured, or DuckDuckGo live results." />
      <div className="grid gap-6 2xl:grid-cols-[420px_minmax(0,1fr)]">
        <ReportSection title="New tracker">
          <form className="space-y-4" onSubmit={create}>
            <Field label="Domain"><Input value={form.domain} onChange={(e) => setForm({ ...form, domain: e.target.value })} required /></Field>
            <Field label="Keywords"><Textarea value={form.keywords} onChange={(e) => setForm({ ...form, keywords: e.target.value })} placeholder="one per line" /></Field>
            <Button type="submit" disabled={busy.create}><Plus /> {busy.create ? "Adding" : "Add tracker"}</Button>
          </form>
        </ReportSection>
        <div className="space-y-4">
          {trackers.length ? trackers.map((tracker) => {
            const running = activeRun(tracker);
            const starting = Boolean(busy[`check:${tracker.id}`]);
            const checking = Boolean(running) || starting;
            const latestRun = latestRankRun(tracker);
            const selectedIds = selectedKeywordIds(tracker.id);
            const trackerSchedule = schedule?.trackers.find((item) => item.id === tracker.id);
            const problemRun = !running && latestRun && (latestRun.status === "partial" || latestRun.status === "failed") ? latestRun : null;
            return (
            <ReportSection
              key={tracker.id}
              title={tracker.domain}
              meta={`${formatNumber(tracker.keywords.length)} keywords · depth ${tracker.serp_depth} · ${formatNumber(tracker.runCount)} ${tracker.runCount === 1 ? "run" : "runs"}`}
              action={
                <>
                  {!scheduleError && trackerSchedule ? (
                    <span className="inline-flex items-center gap-2 text-xs text-muted-foreground">
                      <ScheduleSelect
                        value={trackerSchedule.interval}
                        onChange={(interval) => setTrackerInterval(tracker.id, interval)}
                        disabled={scheduleSaving === `tracker:${tracker.id}`}
                        label={`Scheduled rank check interval for ${tracker.domain}`}
                        className="w-[112px]"
                      />
                      <span className="whitespace-nowrap">{nextRunLabel(trackerSchedule.interval, trackerSchedule.nextCheckAt)}</span>
                      <InfoTip label="About scheduled rank checks">{scheduleRuntimeNote}</InfoTip>
                    </span>
                  ) : null}
                  <Button variant="secondary" size="sm" onClick={() => check(tracker)} disabled={checking} aria-busy={checking}>
                    {checking ? <LoaderCircle className="animate-spin motion-reduce:animate-none" /> : <Target />}
                    {running ? "Check running" : starting ? "Starting" : "Run check"}
                  </Button>
                </>
              }
            >
              {running ? <RunProgress run={running} /> : null}
              {problemRun ? <RunProblem run={problemRun} /> : null}
              <Tabs defaultValue="latest">
                <TabsList>
                  <TabsTrigger value="latest">Latest</TabsTrigger>
                  <TabsTrigger value="keywords">Keywords</TabsTrigger>
                  <TabsTrigger value="runs">Runs</TabsTrigger>
                </TabsList>
                <TabsContent value="latest">
                  {tracker.latest?.length ? (
                    <FilteredRows rows={tracker.latest} placeholder="Filter positions…" csvName={`rank-positions-${tracker.domain}`} csvColumns={latestCsvColumns} sortValues={latestSortValues}>
                      {(rows) => <RankTable rows={rows} />}
                    </FilteredRows>
                  ) : (
                    <EmptyState
                      title="No completed check yet"
                      text="Positions appear after a check finishes for every keyword. Partial and failed runs are kept in Runs but never replace saved positions."
                    />
                  )}
                </TabsContent>
                <TabsContent value="keywords">
                  <div className="mb-4 space-y-3">
                    <Field label="Add tracked keywords">
                      <Textarea value={keywordDrafts[tracker.id] || ""} onChange={(event) => setKeywordDrafts({ ...keywordDrafts, [tracker.id]: event.target.value })} placeholder="add keywords, one per line" />
                    </Field>
                    <div className="flex flex-wrap gap-3">
                      <Button variant="secondary" onClick={() => addKeywords(tracker.id)} disabled={busy[`add:${tracker.id}`]}><Plus /> {busy[`add:${tracker.id}`] ? "Adding keywords" : "Add keywords"}</Button>
                      <Button variant="outline" onClick={() => syncMetrics(tracker.id)} disabled={busy[`metrics:${tracker.id}`]}><RefreshCw /> {busy[`metrics:${tracker.id}`] ? "Syncing metrics" : "Sync imported metrics"}</Button>
                      <Button asChild variant="outline"><Link to="/saved"><Upload /> Import metrics</Link></Button>
                      <Button
                        variant="destructive"
                        onClick={() => setConfirmRemove({ trackerId: tracker.id, domain: tracker.domain, ids: selectedIds })}
                        disabled={!selectedIds.length || busy[`remove:${tracker.id}`]}
                      >
                        <Trash2 /> {busy[`remove:${tracker.id}`] ? "Removing" : selectedIds.length ? `Remove ${formatNumber(selectedIds.length)} selected` : "Remove selected"}
                      </Button>
                    </div>
                  </div>
                  <RankKeywordTable
                    rows={tracker.keywords || []}
                    selected={selectedKeywords[tracker.id] || {}}
                    setSelected={(value) => setSelectedKeywords({ ...selectedKeywords, [tracker.id]: value })}
                  />
                </TabsContent>
                <TabsContent value="runs">
                  <RankRunsPanel tracker={tracker} refreshKey={runsRefresh} />
                </TabsContent>
              </Tabs>
            </ReportSection>
            );
          }) : (
            <EmptyState
              title="No rank trackers"
              text="Create a tracker for this site, add keywords, then run a local rank check."
            />
          )}
        </div>
      </div>
      <AlertDialog open={Boolean(confirmRemove)} onOpenChange={(open) => !open && !(confirmRemove && busy[`remove:${confirmRemove.trackerId}`]) && setConfirmRemove(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Remove {formatNumber(confirmRemove?.ids.length || 0)} tracked {confirmRemove?.ids.length === 1 ? "keyword" : "keywords"}?</AlertDialogTitle>
            <AlertDialogDescription>
              The selected keywords stop being tracked for {confirmRemove?.domain || "this tracker"}. Rank snapshots already saved stay in the tracker history.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={Boolean(confirmRemove && busy[`remove:${confirmRemove.trackerId}`])}>Keep keywords</AlertDialogCancel>
            <AlertDialogAction
              type="button"
              disabled={Boolean(confirmRemove && busy[`remove:${confirmRemove.trackerId}`])}
              onClick={() => confirmRemove && removeKeywords(confirmRemove.trackerId, confirmRemove.ids)}
            >
              {confirmRemove && busy[`remove:${confirmRemove.trackerId}`] ? "Removing keywords" : "Remove keywords"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}

function RunProgress({ run }: { run: RankRun }) {
  const total = Number(run.keyword_count || 0);
  const checked = Number(run.checked_count || 0);
  const failed = Number(run.error_count || 0);
  return (
    <div className="mb-4 space-y-2 rounded-xl bg-muted/40 px-3.5 py-3" role="status" aria-live="polite">
      <div className="flex flex-wrap items-center justify-between gap-2 text-sm">
        <span className="font-medium">
          {total ? `Checked ${formatNumber(checked)} of ${formatNumber(total)} keywords` : "Check queued"}
          {failed ? <span className="text-warn"> · {formatNumber(failed)} failed so far</span> : null}
        </span>
        <span className="text-xs text-muted-foreground">Started {formatDate(run.started_at)}</span>
      </div>
      {total ? <ProgressBar value={((checked + failed) / total) * 100} /> : null}
    </div>
  );
}

// The latest run could not check every keyword: say which ones and why, since
// those keywords keep their previous position.
function RunProblem({ run }: { run: RankRun }) {
  const [showAll, setShowAll] = useState(false);
  const errors = run.errors || [];
  const visible = showAll ? errors : errors.slice(0, RUN_ERROR_PREVIEW);
  return (
    <div className="mb-4 space-y-2 rounded-xl border border-border/70 bg-muted/30 px-3.5 py-3">
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <Badge variant={runStatusVariant(run.status) as any}>{run.status}</Badge>
        <span className="font-medium">
          Latest check {formatDate(run.finished_at || run.started_at)}: {runCheckedLabel(run)} keywords checked
        </span>
      </div>
      {run.message ? <p className="text-xs text-muted-foreground">{run.message}</p> : null}
      {errors.length ? (
        <>
          <RunErrorList errors={visible} />
          {errors.length > RUN_ERROR_PREVIEW ? (
            <Button size="sm" variant="ghost" className="h-7 px-2 text-xs" onClick={() => setShowAll((value) => !value)}>
              {showAll ? "Show fewer" : `Show all ${formatNumber(errors.length)} errors`}
            </Button>
          ) : null}
        </>
      ) : null}
      <p className="text-xs text-muted-foreground">Partial and failed checks never replace positions: Latest keeps each keyword's position from its last completed check.</p>
    </div>
  );
}

function RunErrorList({ errors }: { errors: RankRun["errors"] }) {
  return (
    <ul className="space-y-1 text-xs">
      {errors.map((item, index) => (
        <li key={`${item.keywordId}:${index}`} className="break-words">
          <span className="font-medium">{item.keyword}</span>
          <span className="text-muted-foreground"> — {item.error}</span>
        </li>
      ))}
    </ul>
  );
}

const latestSortValues: Record<string, (row: RankSnapshot) => unknown> = {
  source: (row) => splitSnapshotSource(row.source).key,
};

const latestCsvColumns: CsvColumn<RankSnapshot>[] = [
  { label: "keyword", value: (row) => row.keyword },
  { label: "position", value: (row) => row.position },
  { label: "depth_checked", value: (row) => row.depth_checked },
  { label: "url", value: (row) => row.url },
  { label: "title", value: (row) => row.title },
  { label: "source", value: (row) => row.source },
  { label: "checked_at", value: (row) => row.checked_at },
];

function RankTable({ rows }: { rows: RankSnapshot[] }) {
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <SortableTableHead sortKey="keyword">Keyword</SortableTableHead>
          <SortableTableHead sortKey="position">Position</SortableTableHead>
          <SortableTableHead sortKey="url">URL</SortableTableHead>
          <SortableTableHead sortKey="source">Source</SortableTableHead>
          <SortableTableHead sortKey="checked_at">Checked</SortableTableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {rows.map((row) => (
          <TableRow key={row.id || `${row.keyword}:${row.checked_at}`}>
            <TableCell className="font-medium">{row.keyword}</TableCell>
            <TableCell className={row.position != null ? "nums" : "text-xs text-muted-foreground"}>{rankPositionLabel(row)}</TableCell>
            <TableCell className="max-w-md truncate text-muted-foreground" title={row.url || undefined}>{row.url || "-"}</TableCell>
            <TableCell><SnapshotSource source={row.source} /></TableCell>
            <TableCell className="whitespace-nowrap text-muted-foreground">{formatDate(row.checked_at)}</TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}

function RankKeywordTable({
  rows,
  selected,
  setSelected,
}: {
  rows: any[];
  selected: Record<string, boolean>;
  setSelected: (value: Record<string, boolean>) => void;
}) {
  if (!rows.length) return <EmptyState title="No keywords" text="Add keywords to track positions." />;
  return (
    <Table>
      <TableHeader><TableRow><TableHead className="w-10"><span className="sr-only">Select</span></TableHead><TableHead>Keyword</TableHead><TableHead>Volume</TableHead><TableHead>KD</TableHead><TableHead>CPC</TableHead><TableHead>Metrics</TableHead></TableRow></TableHeader>
      <TableBody>
        {rows.map((row) => (
          <TableRow key={row.id}>
            <TableCell><Checkbox aria-label={`Select ${row.keyword}`} checked={Boolean(selected[row.id])} onCheckedChange={(checked) => setSelected({ ...selected, [row.id]: checked === true })} /></TableCell>
            <TableCell className="font-medium">{row.keyword}</TableCell>
            <TableCell className={keywordMetricClass(row.search_volume)}>{formatMetricStatus(row.search_volume)}</TableCell>
            <TableCell className={keywordMetricClass(row.keyword_difficulty)}>{formatMetricStatus(row.keyword_difficulty)}</TableCell>
            <TableCell className={keywordMetricClass(row.cpc)}>{formatMetricStatus(row.cpc)}</TableCell>
            <TableCell className="text-muted-foreground">{row.metrics_fetched_at ? formatDate(row.metrics_fetched_at) : "-"}</TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}

// Run history paged from the API; the tracker list only carries the newest runs.
function RankRunsPanel({ tracker, refreshKey }: { tracker: RankTracker; refreshKey: number }) {
  const [offset, setOffset] = useState(0);
  const [page, setPage] = useState<RankRunsPage | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [retry, setRetry] = useState(0);
  const tokenRef = useRef(0);

  useEffect(() => {
    const token = ++tokenRef.current;
    setLoading(true);
    api
      .rankRuns(tracker.id, { limit: RUNS_PAGE_SIZE, offset })
      .then((data) => {
        if (token !== tokenRef.current) return;
        setPage(data);
        setError("");
      })
      .catch((err) => {
        if (token === tokenRef.current) setError(err instanceof Error ? err.message : "Could not load run history");
      })
      .finally(() => {
        if (token === tokenRef.current) setLoading(false);
      });
  }, [tracker.id, offset, refreshKey, tracker.runCount, retry]);

  if (error && !page) {
    return <EmptyState title="Could not load runs" text={error} action={<Button variant="secondary" onClick={() => setRetry((value) => value + 1)}><RefreshCw /> Retry</Button>} />;
  }
  if (!page) {
    return <p className="py-4 text-sm text-muted-foreground">Loading run history…</p>;
  }
  if (!page.total) {
    return <EmptyState title="No runs" text="Run a rank check to create history." />;
  }
  return (
    <ServerPagedRows
      rows={page.runs}
      total={page.total}
      offset={page.offset}
      limit={page.limit}
      loading={loading}
      onOffsetChange={setOffset}
      csvName={`rank-runs-${tracker.domain}`}
      csvColumns={runCsvColumns}
      orderNote="Newest runs first"
    >
      {(rows) => <RankRunsTable rows={rows} />}
    </ServerPagedRows>
  );
}

const runCsvColumns: CsvColumn<RankRun>[] = [
  { label: "status", value: (row) => row.status },
  { label: "checked_count", value: (row) => row.checked_count },
  { label: "keyword_count", value: (row) => row.keyword_count },
  { label: "error_count", value: (row) => row.error_count },
  { label: "errors", value: (row) => (row.errors || []).map((item) => `${item.keyword}: ${item.error}`) },
  { label: "message", value: (row) => row.message },
  { label: "started_at", value: (row) => row.started_at },
  { label: "finished_at", value: (row) => row.finished_at },
];

function RankRunsTable({ rows }: { rows: RankRun[] }) {
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <SortableTableHead sortKey="status">Status</SortableTableHead>
          <SortableTableHead sortKey="checked_count">Checked</SortableTableHead>
          <SortableTableHead sortKey="error_count">Errors</SortableTableHead>
          <TableHead>Message</TableHead>
          <SortableTableHead sortKey="started_at">Started</SortableTableHead>
          <SortableTableHead sortKey="finished_at">Finished</SortableTableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {rows.map((row) => {
          const errorCount = Number(row.error_count ?? row.errors?.length ?? 0);
          const open = Boolean(expanded[row.id]);
          return (
            <Fragment key={row.id}>
              <TableRow>
                <TableCell>
                  <Badge variant={runStatusVariant(row.status) as any}>
                    {runIsActive(row) ? <LoaderCircle className="animate-spin motion-reduce:animate-none" /> : null}
                    {row.status}
                  </Badge>
                </TableCell>
                <TableCell className="nums whitespace-nowrap">{runCheckedLabel(row)}</TableCell>
                <TableCell>
                  {errorCount && row.errors?.length ? (
                    <Button
                      type="button"
                      size="sm"
                      variant="ghost"
                      className="h-7 px-2 text-xs"
                      aria-expanded={open}
                      onClick={() => setExpanded((current) => ({ ...current, [row.id]: !open }))}
                    >
                      {open ? <ChevronDown /> : <ChevronRight />}
                      {formatNumber(errorCount)} {errorCount === 1 ? "error" : "errors"}
                    </Button>
                  ) : (
                    <span className="nums text-muted-foreground">{formatNumber(errorCount)}</span>
                  )}
                </TableCell>
                <TableCell className="max-w-md text-sm">{row.message || "-"}</TableCell>
                <TableCell className="whitespace-nowrap text-muted-foreground">{formatDate(row.started_at)}</TableCell>
                <TableCell className="whitespace-nowrap text-muted-foreground">{row.finished_at ? formatDate(row.finished_at) : "-"}</TableCell>
              </TableRow>
              {open ? (
                <TableRow className="hover:bg-transparent">
                  <TableCell colSpan={6} className="bg-muted/30">
                    <RunErrorList errors={row.errors} />
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
