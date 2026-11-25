import { useEffect, useMemo, useRef, useState, type ComponentProps, type SyntheticEvent, type ReactNode } from "react";
import { Link, useNavigate } from "react-router-dom";
import { ArrowUpRight, Bot, FileSearch, Pencil, Plus, Trash2 } from "lucide-react";
import { api, type ScanRow, type Site } from "../../api";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle, Button, Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, Input, Select, SelectContent, SelectItem, SelectTrigger, SelectValue, Table, TableBody, TableCell, TableHead, TableHeader, TableRow, Textarea, toast } from "@/components/ui";
import { CountUp, EmptyState, Field, Hint, JobTable, cleanSiteDomain, KeywordToolDefaultsPanel, PageHeader, ReportSection, ScanPlanPreview, StatusDot, crawlHostOptions, crawlPreferenceLabel, crawlProtocolOptions, crawlRobotsOptions, crawlSpeedOptions, defaultCrawlHostFromConfig, defaultCrawlProtocolFromConfig, defaultKeywordLanguageCode, defaultKeywordLocationCode, defaultLanguageCodeFromConfig, defaultLocationCodeFromConfig, formatDate, formatMs, formatNumber, keywordToolDefaultsLabel, knownNumber, preferredScanUrl, scanIsActive, scanLiveProgress, scanPhaseKey, scanPhaseLabel, scanSeverityCounts, scanSpeedMetrics, scanStatusLabel, scanUrlCountLabel, scanUrlShortDetail, scoreTone, setSelectedScanId, SiteAvatar, siteDisplayName, sortScanRows, timestampMs, upsertScanRow } from "../shared";
import { cn } from "@/lib/utils";
import { ScanTable } from "./scans/scan-table";
import { CwvOverviewCard } from "../cwv";
import { SiteScheduleCard } from "../schedule";

export function Overview({
  site,
  reloadSites,
  selectSite,
}: {
  site: Site;
  reloadSites: () => Promise<void>;
  selectSite: (id: string) => void;
}) {
  const [summary, setSummary] = useState<any>(null);
  const [scanning, setScanning] = useState(false);
  const [editOpen, setEditOpen] = useState(false);
  const [scanError, setScanError] = useState("");
  const [firstDomain, setFirstDomain] = useState("");
  const [firstName, setFirstName] = useState("");
  const [firstCrawlProtocol, setFirstCrawlProtocol] = useState<Site["crawl_protocol"]>("auto");
  const [firstCrawlHost, setFirstCrawlHost] = useState<Site["crawl_host"]>("auto");
  const [firstScanError, setFirstScanError] = useState("");
  const navigate = useNavigate();
  // Dashboard scan rows are lite (no pages/issues arrays); the full report is
  // loaded on the scans page.
  const scanLedgerRows = useMemo(
    () => sortScanRows((summary?.latestScans || []).filter((row: any) => row.site_id === site.id)),
    [summary, site.id],
  );

  useEffect(() => {
    let cancelled = false;
    api
      .dashboard(site.id)
      .then((data) => {
        if (!cancelled) setSummary(data);
      })
      .catch(console.error);
    return () => {
      cancelled = true;
    };
  }, [site.id]);

  useEffect(() => {
    let cancelled = false;
    api.config()
      .then((data) => {
        if (cancelled) return;
        setFirstCrawlProtocol(defaultCrawlProtocolFromConfig(data));
        setFirstCrawlHost(defaultCrawlHostFromConfig(data));
      })
      .catch(console.error);
    return () => {
      cancelled = true;
    };
  }, []);

  async function scanSite() {
    setScanning(true);
    setScanError("");
    try {
      const result = await api.scanSite(site.id);
      if (result.scan?.id) {
        setSelectedScanId(site.id, result.scan.id);
        navigate(`/scans/${result.scan.id}`);
      } else {
        navigate("/scans");
      }
    } catch (err) {
      setScanError(err instanceof Error ? err.message : "Could not start site scan");
    } finally {
      setScanning(false);
    }
  }

  function openScanReport(scanId: string, row?: any) {
    setSelectedScanId(row?.site_id || site.id, scanId);
    navigate(`/scans/${scanId}`);
  }

  async function createSiteAndScan(event: SyntheticEvent) {
    event.preventDefault();
    const domain = firstDomain.trim();
    if (!domain) return;
    setScanning(true);
    setFirstScanError("");
    try {
      const created = await api.createSite({
        name: firstName.trim() || domain,
        domain,
        crawlProtocol: firstCrawlProtocol,
        crawlHost: firstCrawlHost,
      } as any);
      selectSite(created.id);
      await reloadSites();
      const result = await api.scanSite(created.id);
      if (result.scan?.id) {
        setSelectedScanId(created.id, result.scan.id);
      }
      if (result.scan?.id) navigate(`/scans/${result.scan.id}`);
      else navigate("/scans");
    } catch (err) {
      setFirstScanError(err instanceof Error ? err.message : "Could not start the first scan");
    } finally {
      setScanning(false);
    }
  }

  const firstScanPlan = {
    domain: firstDomain,
    crawl_protocol: firstCrawlProtocol,
    crawl_host: firstCrawlHost,
  };

  return (
    <>
      <PageHeader
        title={siteDisplayName(site)}
        description={site.domain ? undefined : "Add a site to unlock scans, reports, rankings, and Search Console."}
        meta={
          site.domain ? (
            <span className="flex flex-wrap items-center gap-x-2">
              <span>{site.domain}</span>
              <span className="text-border">·</span>
              <Hint
                tip={
                  <span className="space-y-1">
                    <span className="block">Crawl starts at {preferredScanUrl(site)}</span>
                    <span className="block">Keyword tools: {keywordToolDefaultsLabel(site)}</span>
                  </span>
                }
              >
                {scanUrlShortDetail(site)}
              </Hint>
            </span>
          ) : (
            "No website address yet"
          )
        }
        action={
          site.domain ? (
            <>
              <Button variant="ghost" size="sm" className="text-muted-foreground" onClick={() => setEditOpen(true)}>
                <Pencil /> Edit site
              </Button>
              <Button size="sm" onClick={scanSite} disabled={scanning}>
                <FileSearch /> {scanning ? "Starting" : "Scan website"}
              </Button>
            </>
          ) : undefined
        }
      />
      {!site.domain ? (
        <section className="mb-6 rounded-2xl border border-primary/25 bg-primary/[0.03] p-5 sm:p-6">
          <div className="mb-4">
            <h2 className="text-lg font-semibold">Start with a site scan</h2>
            <p className="mt-1 text-sm leading-6 text-muted-foreground">Add the website address once. The scan report opens automatically and stays saved locally.</p>
          </div>
          <form className="space-y-3" onSubmit={createSiteAndScan}>
            <div className="grid gap-3 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_auto] lg:items-end">
              <Field label="Website address">
                <Input value={firstDomain} onChange={(event) => setFirstDomain(event.target.value)} placeholder="example.com" required />
              </Field>
              <Field label="Site name">
                <Input value={firstName} onChange={(event) => setFirstName(event.target.value)} placeholder="Site name (optional)" />
              </Field>
              <Button type="submit" disabled={scanning} className="lg:mb-px">
                <FileSearch /> {scanning ? "Starting" : "Add site and scan"}
              </Button>
            </div>
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="Scan protocol">
                <Select value={firstCrawlProtocol} onValueChange={(value) => setFirstCrawlProtocol(value as Site["crawl_protocol"])}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    {crawlProtocolOptions.map((option) => <SelectItem key={option.value} value={option.value}>{option.label}</SelectItem>)}
                  </SelectContent>
                </Select>
              </Field>
              <Field label="Host variant">
                <Select value={firstCrawlHost} onValueChange={(value) => setFirstCrawlHost(value as Site["crawl_host"])}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    {crawlHostOptions.map((option) => <SelectItem key={option.value} value={option.value}>{option.label}</SelectItem>)}
                  </SelectContent>
                </Select>
              </Field>
            </div>
            <ScanPlanPreview site={firstScanPlan} />
          </form>
          {firstScanError && <p className="mt-3 rounded-lg bg-bad-soft/50 px-3.5 py-2.5 text-sm text-destructive">{firstScanError}</p>}
        </section>
      ) : null}
      {scanError && <p className="mb-6 rounded-lg bg-bad-soft/50 px-3.5 py-2.5 text-sm text-destructive">{scanError}</p>}
      <div className="mb-8">
        <SiteCommandCenter summary={summary} />
      </div>
      {site.domain ? (
        <div className="mb-8 grid gap-x-8 gap-y-8 xl:grid-cols-[minmax(0,0.8fr)_minmax(0,1.2fr)]">
          <SiteScheduleCard siteId={site.id} />
          <CwvOverviewCard siteId={site.id} />
        </div>
      ) : null}
      <div className="grid gap-x-8 gap-y-8 2xl:grid-cols-[minmax(0,1.1fr)_minmax(520px,0.9fr)]">
        <ReportSection title="Scan history" meta={`${formatNumber(scanLedgerRows.length)} saved`}>
          {scanLedgerRows.length ? (
            <ScanTable rows={scanLedgerRows} activeSiteId={site.id} onInspect={openScanReport} />
          ) : (
            <EmptyState
              icon={FileSearch}
              title="No scans yet"
              text={site.domain ? "Start a technical scan for this site." : "Add a website address to start scanning."}
              action={
                site.domain ? (
                  <Button onClick={scanSite} disabled={scanning}>
                    <FileSearch /> {scanning ? "Starting" : "Scan website"}
                  </Button>
                ) : (
                  <Button asChild><Link to="/"><Plus /> Add site</Link></Button>
                )
              }
            />
          )}
        </ReportSection>
        <ReportSection title="Codex jobs" description="Local AI work runs through the Codex CLI with medium reasoning.">
          {summary?.latestAiJobs?.length ? (
            <JobTable rows={summary.latestAiJobs} />
          ) : (
            <EmptyState
              icon={Bot}
              title="No AI jobs yet"
              text="Start a local Codex workflow when you need analysis or prioritization."
              action={<Button asChild variant="secondary"><Link to="/ai"><Bot /> Open AI lab</Link></Button>}
            />
          )}
        </ReportSection>
      </div>
      <EditSiteDialog site={site} open={editOpen} onOpenChange={setEditOpen} onSaved={reloadSites} />
    </>
  );
}

type ControlTileModel = {
  key: string;
  label: string;
  to: string;
  value: ReactNode;
  status: string;
  tone: ComponentProps<typeof StatusDot>["tone"];
  tip?: ReactNode;
};

function SiteCommandCenter({
  summary,
}: {
  summary: any;
}) {
  const latestScan = sortScanRows<any>(summary?.latestScans || [])[0];
  const latestScanSummary = latestScan?.result?.summary || {};
  const latestScanSpeed = latestScan ? scanSpeedMetrics(latestScan) : null;
  const latestSeverity = latestScan ? scanSeverityCounts(latestScan) : null;
  const latestGscImport = summary?.latestGscImport;
  const gscSourceText = latestGscImport?.source === "api" ? "API sync" : latestGscImport?.source === "csv" ? "CSV import" : "import";
  // The date range arrives as startDate/endDate (or a nested range object).
  const gscRange = latestGscImport?.range || latestGscImport;
  const gscRangeText =
    gscRange?.startDate || gscRange?.endDate ? ` covering ${formatDate(gscRange.startDate)} – ${formatDate(gscRange.endDate)}` : "";
  const gscClicks = knownNumber(latestGscImport?.totals?.clicks);
  const brokenLinks = knownNumber(latestScanSummary.brokenLinks);
  // The dashboard sends at most 10 recent jobs, so a full list is a lower bound.
  const aiJobs: any[] = summary?.latestAiJobs || [];
  // The tile color follows what the scan found, not merely that one exists.
  const technicalTone: ControlTileModel["tone"] = !latestScan
    ? "warn"
    : latestScan.status === "failed"
      ? "bad"
      : latestScan.status !== "completed"
        ? "warn"
        : latestSeverity?.high
          ? "bad"
          : latestSeverity?.medium
            ? "warn"
            : "good";
  const tiles: ControlTileModel[] = [
    {
      key: "scan",
      label: "Technical scan",
      to: latestScan ? `/scans/${latestScan.id}` : "/scans",
      value: latestScan ? <CountUp value={latestScan.issue_count} /> : "—",
      status: !latestScan
        ? "Needs scan"
        : latestScan.status === "completed" && latestSeverity
          ? `${formatNumber(latestSeverity.high)} high · ${formatNumber(latestSeverity.medium)} med · ${formatNumber(latestScan.pages_crawled)} pages`
          : `${scanStatusLabel(latestScan.status)} · ${formatNumber(latestScan.pages_crawled)} pages`,
      tone: technicalTone,
      tip: latestScan
        ? `Open issues found across ${formatNumber(latestScan.pages_crawled)} crawled pages${latestSeverity ? ` — ${formatNumber(latestSeverity.high)} high, ${formatNumber(latestSeverity.medium)} medium, ${formatNumber(latestSeverity.low)} low` : ""}, with ${formatNumber(latestScanSummary.checkedLinks)} links checked. Opens the full scan report.`
        : "No crawl evidence saved yet. Run a scan to build the technical report.",
    },
    {
      key: "speed",
      label: "Page speed",
      to: latestScanSpeed?.measuredPageLoads && latestScan ? `/scans/${latestScan.id}?tab=speed` : "/scans",
      value: latestScanSpeed?.measuredPageLoads ? <CountUp value={latestScanSpeed.averagePageLoadMs} format={formatMs} /> : "—",
      status: latestScanSpeed?.measuredPageLoads
        ? `${formatNumber(latestScanSpeed.measuredPageLoads)} pages timed · ${formatNumber(latestScanSpeed.slowPages)} slow`
        : "Needs scan",
      tone: latestScanSpeed?.measuredPageLoads ? (latestScanSpeed.slowPages ? "warn" : "good") : "warn",
      tip: latestScanSpeed?.measuredPageLoads
        ? `Average response across timed pages. p95 ${formatMs(latestScanSpeed.p95PageLoadMs)} · slowest ${formatMs(latestScanSpeed.slowestPageLoadMs)}. Opens the speed report.`
        : "Run a site scan to record response timings for every crawled HTML page.",
    },
    {
      key: "links",
      label: "Links",
      to: "/links",
      value: latestScan ? <CountUp value={latestScanSummary.linkTags} /> : "—",
      status: latestScan ? (brokenLinks === null ? "broken links not recorded" : `${formatNumber(brokenLinks)} broken`) : "Needs scan",
      tone: latestScan ? (brokenLinks ? "bad" : brokenLinks === null ? "outline" : "good") : "warn",
      tip: latestScan
        ? "Link tags found in the last crawl. Opens the local link graph."
        : "Run a site scan to build the local link graph.",
    },
    {
      key: "organic",
      label: "Organic research",
      to: "/domain",
      value: <CountUp value={summary?.savedKeywordCount} />,
      status: summary?.savedKeywordCount ? "keywords saved" : "ready for research",
      tone: summary?.savedKeywordCount ? "good" : "outline",
      tip: "Saved keywords in the local list. Local crawl pages feed the organic research screen.",
    },
    {
      key: "rank",
      label: "Rank tracking",
      to: "/rank",
      value: <CountUp value={summary?.trackerCount} />,
      status: `${formatNumber(summary?.serpRunCount)} SERP runs`,
      tone: summary?.trackerCount ? "good" : "outline",
      tip: "Tracked keywords and saved SERP position checks for this site.",
    },
    {
      key: "gsc",
      label: "Search Console",
      to: "/gsc",
      value: <CountUp value={summary?.gscImportCount} />,
      status: summary?.gscImportCount
        ? `latest ${gscSourceText}: ${formatNumber(latestGscImport?.rowCount)} rows`
        : "ready for import",
      tone: summary?.gscImportCount ? "good" : "outline",
      tip: summary?.gscImportCount
        ? `Search Console API syncs and CSV imports saved locally. The latest ${gscSourceText}${gscRangeText} has ${formatNumber(latestGscImport?.rowCount)} rows${gscClicks !== null ? ` and ${formatNumber(gscClicks)} clicks` : ""}.`
        : "Import a Search Console CSV locally, or connect Google for live performance and inspection.",
    },
    {
      key: "ai",
      label: "AI lab",
      to: "/ai",
      value: !summary ? "—" : <CountUp value={summary.aiJobCount ?? aiJobs.length} />,
      status: aiJobs.length ? "recent jobs saved" : "ready for Codex",
      tone: aiJobs.length ? "good" : "outline",
      tip: "Saved Codex jobs for this site. Runs locally through the Codex CLI with medium reasoning.",
    },
  ];

  return (
    <section aria-label="Site control">
      <h2 className="sr-only">Site control</h2>
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-[repeat(auto-fit,minmax(11rem,1fr))]">
        {tiles.map((tile) => (
          <Link
            key={tile.key}
            to={tile.to}
            className="group min-w-0 rounded-2xl border border-border/70 bg-card px-4 py-4 transition-colors duration-150 hover:border-primary/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/60"
          >
            <div className="flex items-center justify-between gap-2">
              <span className="eyebrow-muted truncate">{tile.label}</span>
              <ArrowUpRight className="size-3.5 shrink-0 text-primary opacity-0 transition-opacity group-hover:opacity-100" />
            </div>
            <div className="metric mt-2 text-[1.7rem] leading-none">{tile.value}</div>
            <div className="mt-2 flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground">
              <StatusDot tone={tile.tone} />
              {tile.tip ? <Hint tip={tile.tip} className="truncate">{tile.status}</Hint> : <span className="truncate">{tile.status}</span>}
            </div>
          </Link>
        ))}
      </div>
    </section>
  );
}

type SiteEditForm = {
  name: string;
  domain: string;
  notes: string;
  location_code: number;
  language_code: string;
  crawl_protocol: Site["crawl_protocol"];
  crawl_host: Site["crawl_host"];
  crawl_speed: Site["crawl_speed"];
  crawl_max_pages: number;
  crawl_robots: Site["crawl_robots"];
};

const emptyEditForm: SiteEditForm = {
  name: "",
  domain: "",
  notes: "",
  location_code: defaultKeywordLocationCode,
  language_code: defaultKeywordLanguageCode,
  crawl_protocol: "auto",
  crawl_host: "auto",
  crawl_speed: "auto",
  crawl_max_pages: 0,
  crawl_robots: "respect",
};

// Self-contained edit dialog so "Edit site" opens in place on any page (the
// workspace overview, the site list, …) without navigating away.
export function EditSiteDialog({
  site,
  open,
  onOpenChange,
  onSaved,
}: {
  site: Site | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSaved?: () => void | Promise<void>;
}) {
  const [editForm, setEditForm] = useState<SiteEditForm>(emptyEditForm);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [ignoreCount, setIgnoreCount] = useState<number | null>(null);
  const [clearing, setClearing] = useState(false);
  const [showKeywordDefaults, setShowKeywordDefaults] = useState(false);

  useEffect(() => {
    if (!open || !site) return;
    setError("");
    setShowKeywordDefaults(false);
    setEditForm({
      name: site.name,
      domain: site.domain || "",
      notes: site.notes || "",
      location_code: site.location_code || defaultKeywordLocationCode,
      language_code: site.language_code || defaultKeywordLanguageCode,
      crawl_protocol: site.crawl_protocol || "auto",
      crawl_host: site.crawl_host || "auto",
      crawl_speed: site.crawl_speed || "auto",
      crawl_max_pages: Number(site.crawl_max_pages || 0),
      crawl_robots: site.crawl_robots === "ignore" ? "ignore" : "respect",
    });
    setIgnoreCount(null);
    api
      .issueIgnores(site.id)
      .then((rules) => setIgnoreCount(Array.isArray(rules) ? rules.length : 0))
      .catch(() => setIgnoreCount(0));
  }, [open, site?.id]);

  async function submit(event: SyntheticEvent) {
    event.preventDefault();
    if (!site) return;
    setError("");
    setSaving(true);
    try {
      const updated = await api.updateSite(site.id, editForm);
      await onSaved?.();
      onOpenChange(false);
      toast.success(`${cleanSiteDomain(updated.domain) || updated.name || "Site"} updated locally.`);
    } catch (err) {
      const message = err instanceof Error ? err.message : "Could not update site";
      setError(message);
      toast.error(message);
    } finally {
      setSaving(false);
    }
  }

  async function clearIgnores() {
    if (!site) return;
    setClearing(true);
    try {
      const result = await api.clearIssueIgnores(site.id);
      setIgnoreCount(0);
      toast.success(result.deleted === 1 ? "1 ignore rule cleared" : `${result.deleted} ignore rules cleared`);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not clear ignore rules");
    } finally {
      setClearing(false);
    }
  }

  const editScanPlan = { domain: editForm.domain, crawl_protocol: editForm.crawl_protocol, crawl_host: editForm.crawl_host };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Edit site</DialogTitle>
          <DialogDescription>Changes apply to this saved website address and future scans.</DialogDescription>
        </DialogHeader>
        <form className="space-y-4" onSubmit={submit}>
          <Field label="Site name"><Input value={editForm.name} onChange={(e) => setEditForm({ ...editForm, name: e.target.value })} required /></Field>
          <Field label="Website address"><Input value={editForm.domain} onChange={(e) => setEditForm({ ...editForm, domain: e.target.value })} /></Field>
          <KeywordToolDefaultsPanel
            expanded={showKeywordDefaults}
            locationCode={editForm.location_code}
            languageCode={editForm.language_code}
            onToggle={() => setShowKeywordDefaults((value) => !value)}
            onLocationCodeChange={(value) => setEditForm({ ...editForm, location_code: value })}
            onLanguageCodeChange={(value) => setEditForm({ ...editForm, language_code: value })}
          />
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Scan protocol">
              <Select value={editForm.crawl_protocol} onValueChange={(value) => setEditForm({ ...editForm, crawl_protocol: value as Site["crawl_protocol"] })}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  {crawlProtocolOptions.map((option) => <SelectItem key={option.value} value={option.value}>{option.label}</SelectItem>)}
                </SelectContent>
              </Select>
            </Field>
            <Field label="Host variant">
              <Select value={editForm.crawl_host} onValueChange={(value) => setEditForm({ ...editForm, crawl_host: value as Site["crawl_host"] })}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  {crawlHostOptions.map((option) => <SelectItem key={option.value} value={option.value}>{option.label}</SelectItem>)}
                </SelectContent>
              </Select>
            </Field>
            <Field label="Crawl speed">
              <Select value={editForm.crawl_speed} onValueChange={(value) => setEditForm({ ...editForm, crawl_speed: value as Site["crawl_speed"] })}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  {crawlSpeedOptions.map((option) => <SelectItem key={option.value} value={option.value}>{option.label}</SelectItem>)}
                </SelectContent>
              </Select>
            </Field>
            <Field label="Max pages per scan">
              <Input
                type="number"
                min={10}
                max={1000}
                placeholder="App default"
                value={editForm.crawl_max_pages || ""}
                onChange={(e) => setEditForm({ ...editForm, crawl_max_pages: Number(e.target.value) || 0 })}
              />
            </Field>
            <div className="space-y-1.5 sm:col-span-2">
              <Field label="robots.txt">
                <Select value={editForm.crawl_robots} onValueChange={(value) => setEditForm({ ...editForm, crawl_robots: value as Site["crawl_robots"] })}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    {crawlRobotsOptions.map((option) => <SelectItem key={option.value} value={option.value}>{option.label}</SelectItem>)}
                  </SelectContent>
                </Select>
              </Field>
              <p className="text-xs text-muted-foreground">
                {editForm.crawl_robots === "ignore"
                  ? "Scans request URLs robots.txt disallows, for example on a staging site that blocks every crawler. They are still flagged."
                  : "Scans skip URLs robots.txt disallows for LocalSEO (its own group, or * when there is none) and list them in the report."}
              </p>
            </div>
          </div>
          <ScanPlanPreview site={editScanPlan} />
          <Field label="Notes"><Textarea value={editForm.notes} onChange={(e) => setEditForm({ ...editForm, notes: e.target.value })} /></Field>
          {ignoreCount ? (
            <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-border/60 px-3.5 py-2.5">
              <div className="text-sm">
                <div className="font-medium">Ignored issues</div>
                <p className="text-xs text-muted-foreground">
                  {formatNumber(ignoreCount)} saved ignore {ignoreCount === 1 ? "rule" : "rules"} hide issues from this site's reports and scoring.
                </p>
              </div>
              <Button type="button" variant="outline" size="sm" disabled={clearing} onClick={clearIgnores}>
                <Trash2 /> {clearing ? "Clearing" : "Clear all"}
              </Button>
            </div>
          ) : null}
          {error && <p className="text-sm text-destructive">{error}</p>}
          <Button type="submit" disabled={saving}>
            <Pencil /> {saving ? "Saving changes" : "Save changes"}
          </Button>
        </form>
      </DialogContent>
    </Dialog>
  );
}

const minuteMs = 60_000;
const hourMs = 60 * minuteMs;
const dayMs = 24 * hourMs;
const staleScanAgeMs = 30 * dayMs;
const scanAgeFormatter = new Intl.RelativeTimeFormat();

function formatScanAge(ageMs: number) {
  if (ageMs >= 365 * dayMs) return scanAgeFormatter.format(-Math.floor(ageMs / (365 * dayMs)), "year");
  if (ageMs >= staleScanAgeMs) return scanAgeFormatter.format(-Math.floor(ageMs / staleScanAgeMs), "month");
  if (ageMs >= dayMs) return scanAgeFormatter.format(-Math.floor(ageMs / dayMs), "day");
  if (ageMs >= hourMs) return scanAgeFormatter.format(-Math.floor(ageMs / hourMs), "hour");
  if (ageMs >= minuteMs) return scanAgeFormatter.format(-Math.floor(ageMs / minuteMs), "minute");
  return "Just now";
}

export function SitesManager({
  sites,
  reloadSites,
  selectSite,
}: {
  sites: Site[];
  reloadSites: () => Promise<void>;
  selectSite: (id: string) => void;
}) {
  type SiteForm = {
    name: string;
    domain: string;
    notes: string;
    locationCode: number;
    languageCode: string;
    crawlProtocol: Site["crawl_protocol"];
    crawlHost: Site["crawl_host"];
  };
  const initialSiteForm: SiteForm = {
    name: "",
    domain: "",
    notes: "",
    locationCode: defaultKeywordLocationCode,
    languageCode: defaultKeywordLanguageCode,
    crawlProtocol: "auto",
    crawlHost: "auto",
  };
  const [open, setOpen] = useState(false);
  const [showKeywordDefaults, setShowKeywordDefaults] = useState(false);
  const [siteDefaults, setSiteDefaults] = useState<SiteForm>(initialSiteForm);
  const [form, setForm] = useState<SiteForm>(initialSiteForm);
  const [editing, setEditing] = useState<Site | null>(null);
  const [deleting, setDeleting] = useState<Site | null>(null);
  const [error, setError] = useState("");
  const [scanningSiteIds, setScanningSiteIds] = useState(new Set<string>());
  const [creatingAction, setCreatingAction] = useState<"scan" | "save" | "">("");
  const [deletingSiteId, setDeletingSiteId] = useState("");
  const [allScans, setAllScans] = useState<ScanRow[]>([]);
  const [now, setNow] = useState(Date.now);
  const scanListRevision = useRef(0);
  const navigate = useNavigate();

  const activeScanCount = allScans.filter(scanIsActive).length;
  const hasActiveScans = activeScanCount > 0;

  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), minuteMs);
    return () => window.clearInterval(timer);
  }, []);

  // Lite scan rows: score and severity summary per site, no report arrays.
  useEffect(() => {
    let cancelled = false;
    let timer: number | undefined;
    async function refreshScans() {
      const revision = scanListRevision.current;
      try {
        const rows = await api.allScans();
        // A request made before a scan started may not include its row yet.
        if (!cancelled && revision === scanListRevision.current && Array.isArray(rows)) setAllScans(rows);
      } catch {
        // Keep the existing rows when a refresh fails.
      } finally {
        if (!cancelled && hasActiveScans) timer = window.setTimeout(refreshScans, 1500);
      }
    }
    void refreshScans();
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [sites.length, hasActiveScans]);

  const { healthBySite, activeScanBySite, lastScanTimeBySite } = useMemo(() => {
    const healthBySite = new Map<string, ScanRow>();
    const activeScanBySite = new Map<string, ScanRow>();
    const lastScanTimeBySite = new Map<string, number>();
    for (const scan of sortScanRows(allScans)) {
      const siteId = scan.site_id;
      if (!siteId) continue;
      if (!healthBySite.has(siteId)) healthBySite.set(siteId, scan);
      if (scanIsActive(scan) && !activeScanBySite.has(siteId)) activeScanBySite.set(siteId, scan);
      if (scan.status === "completed") {
        const completedAt = timestampMs(scan.updated_at) || timestampMs(scan.created_at);
        if (completedAt > (lastScanTimeBySite.get(siteId) ?? 0)) lastScanTimeBySite.set(siteId, completedAt);
      }
    }
    return { healthBySite, activeScanBySite, lastScanTimeBySite };
  }, [allScans]);

  useEffect(() => {
    let cancelled = false;
    api.config()
      .then((data) => {
        if (cancelled) return;
        const defaults = {
          ...initialSiteForm,
          locationCode: defaultLocationCodeFromConfig(data),
          languageCode: defaultLanguageCodeFromConfig(data),
          crawlProtocol: defaultCrawlProtocolFromConfig(data),
          crawlHost: defaultCrawlHostFromConfig(data),
        };
        setSiteDefaults(defaults);
        setForm((current) =>
          current.name || current.domain || current.notes ? current : defaults,
        );
      })
      .catch(console.error);
    return () => {
      cancelled = true;
    };
  }, []);

  async function createSite(scanAfterCreate: boolean) {
    if (!form.domain.trim()) {
      setError("Enter a website address before saving the site.");
      return;
    }
    setError("");
    setCreatingAction(scanAfterCreate ? "scan" : "save");
    try {
      const created = await api.createSite({
        ...form,
        name: form.name.trim() || form.domain.trim() || "Untitled site",
      });
      selectSite(created.id);
      setOpen(false);
      setForm(siteDefaults);
      await reloadSites();
      if (scanAfterCreate) {
        try {
          const result = await api.scanSite(created.id);
          if (result.scan?.id) {
            setSelectedScanId(created.id, result.scan.id);
            navigate(`/scans/${result.scan.id}`);
          } else {
            navigate("/scans");
          }
        } catch (err) {
          const reason = err instanceof Error ? err.message : "Could not start the crawl.";
          toast.error(`${created.name || created.domain} was saved. ${reason}`);
        }
        return;
      }
      toast.success(`${cleanSiteDomain(created.domain) || created.name || "Site"} saved locally.`);
    } catch (err) {
      const message = err instanceof Error ? err.message : scanAfterCreate ? "Could not add and scan site" : "Could not add site";
      setError(message);
      toast.error(message);
    } finally {
      setCreatingAction("");
    }
  }

  async function submit(event: SyntheticEvent) {
    event.preventDefault();
    await createSite(true);
  }

  async function deleteSite(site: Site) {
    setError("");
    setDeletingSiteId(site.id);
    try {
      const message = `${cleanSiteDomain(site.domain) || site.name || "Site"} deleted locally.`;
      await api.deleteSite(site.id);
      setDeleting(null);
      await reloadSites();
      toast.success(message);
    } catch (err) {
      const message = err instanceof Error ? err.message : "Could not delete site";
      setError(message);
      toast.error(message);
    } finally {
      setDeletingSiteId("");
    }
  }

  async function scanSite(site: Site) {
    if (!site.domain) return;
    setScanningSiteIds((ids) => new Set(ids).add(site.id));
    try {
      const { scan } = await api.scanSite(site.id);
      scanListRevision.current += 1;
      setAllScans((rows) => rows.some((row) => row.id === scan.id) ? rows : upsertScanRow(rows, scan));
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not start site scan");
    } finally {
      setScanningSiteIds((ids) => {
        const next = new Set(ids);
        next.delete(site.id);
        return next;
      });
    }
  }

  const formScanPlan = {
    domain: form.domain,
    crawl_protocol: form.crawlProtocol,
    crawl_host: form.crawlHost,
  };
  const onboarding = (
    <section className="rounded-2xl border border-dashed border-primary/35 p-6 sm:p-9">
      <div className="mx-auto max-w-2xl text-center">
        <h2 className="page-title text-[1.9rem]">Add your first website</h2>
        <p className="mx-auto mt-2 max-w-md text-sm leading-6 text-muted-foreground">
          Save the address once. The scan runs immediately and everything — score, issues, speed, links — stays on this machine.
        </p>
      </div>
      <form className="mx-auto mt-6 max-w-2xl space-y-4" onSubmit={submit}>
        <div className="grid gap-3 sm:grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)] sm:items-end">
          <Field label="Website address">
            <Input value={form.domain} onChange={(event) => setForm({ ...form, domain: event.target.value })} placeholder="example.com" required />
          </Field>
          <Field label="Site name">
            <Input value={form.name} onChange={(event) => setForm({ ...form, name: event.target.value })} placeholder="Optional" />
          </Field>
        </div>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Scan protocol">
            <Select value={form.crawlProtocol} onValueChange={(value) => setForm({ ...form, crawlProtocol: value as Site["crawl_protocol"] })}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                {crawlProtocolOptions.map((option) => <SelectItem key={option.value} value={option.value}>{option.label}</SelectItem>)}
              </SelectContent>
            </Select>
          </Field>
          <Field label="Host variant">
            <Select value={form.crawlHost} onValueChange={(value) => setForm({ ...form, crawlHost: value as Site["crawl_host"] })}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                {crawlHostOptions.map((option) => <SelectItem key={option.value} value={option.value}>{option.label}</SelectItem>)}
              </SelectContent>
            </Select>
          </Field>
        </div>
        <ScanPlanPreview site={formScanPlan} />
        <div className="flex justify-center">
          <Button type="submit" size="lg" disabled={Boolean(creatingAction)}>
            <FileSearch /> {creatingAction === "scan" ? "Starting scan…" : "Add site and scan"}
          </Button>
        </div>
      </form>
    </section>
  );

  function renderSiteRow(site: Site) {
    const scan = healthBySite.get(site.id);
    const activeScan = activeScanBySite.get(site.id);
    const lastScanTime = lastScanTimeBySite.get(site.id);
    const scanAge = lastScanTime === undefined ? null : now - lastScanTime;
    const scanIsStale = scanAge !== null && scanAge > staleScanAgeMs;
    const starting = scanningSiteIds.has(site.id);
    const liveProgress = activeScan ? scanLiveProgress(activeScan) : null;
    // Running or failed scans have no score yet: show "-", not 0.
    const score = knownNumber(scan?.score);
    const sev = scanSeverityCounts(scan);
    const openWorkspace = () => {
      selectSite(site.id);
      navigate("/overview");
    };
    const openActiveScan = () => {
      if (!activeScan?.id) return;
      selectSite(site.id);
      setSelectedScanId(site.id, activeScan.id);
      navigate(`/scans/${activeScan.id}`);
    };
    return (
      <TableRow key={site.id} className="group hover:bg-accent/35">
        <TableCell className="py-3 pr-1 pl-3 sm:py-3.5 sm:pr-3 sm:pl-4">
          <button type="button" onClick={openWorkspace} className="flex w-full items-center gap-3 text-left" title={`Open ${site.name}`}>
            <SiteAvatar site={site} className="hidden size-10 shrink-0 text-sm sm:flex" />
            <div className="min-w-0">
              <div className="flex items-center gap-2">
                <span className="font-heading text-base transition-colors group-hover:text-primary max-sm:line-clamp-2 sm:truncate sm:text-[17px]">{site.name}</span>
              </div>
              <div className="mt-0.5 truncate text-sm text-muted-foreground">
                {site.domain ? (
                  <Hint tip={`${crawlPreferenceLabel(site)} · ${scanUrlCountLabel(site)} · starts at ${preferredScanUrl(site)}`}>
                    {site.domain}
                  </Hint>
                ) : (
                  "No website address"
                )}
              </div>
              {activeScan ? (
                <div className="mt-1 flex items-center gap-1.5 text-xs font-medium text-warn md:hidden">
                  <StatusDot tone="warn" className="shrink-0 animate-pulse motion-reduce:animate-none" />
                  <span className="truncate">{scanPhaseLabel(activeScan)}</span>
                  <span className="shrink-0 text-muted-foreground">· {formatNumber(activeScan.pages_crawled || 0)} pages</span>
                </div>
              ) : null}
            </div>
          </button>
        </TableCell>

        <TableCell className="hidden px-2 md:table-cell">
          {activeScan ? (
            <div>
              <button
                type="button"
                className="block w-full rounded-md text-left focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
                aria-label={`${scanPhaseLabel(activeScan)} for ${site.name}, ${formatNumber(activeScan.pages_crawled || 0)} pages scanned. Open scan report.`}
                onClick={openActiveScan}
              >
                <span className="flex items-center justify-between gap-3 text-xs">
                  <span className="flex min-w-0 items-center gap-1.5 font-medium text-warn">
                    <StatusDot tone="warn" className="animate-pulse motion-reduce:animate-none" />
                    <span className="truncate">{scanPhaseLabel(activeScan)}</span>
                  </span>
                  <span className="shrink-0 text-muted-foreground">{formatNumber(activeScan.pages_crawled || 0)} pages</span>
                </span>
              </button>
              {liveProgress?.crawlPercent != null && scanPhaseKey(activeScan) === "crawl" ? (
                <progress
                  className="mt-1.5 block w-full accent-primary"
                  max={100}
                  value={liveProgress.crawlPercent}
                  aria-label={`Pages crawled toward the scan limit for ${site.name}`}
                  title="Crawling stops at the page limit or when no URLs remain."
                />
              ) : null}
            </div>
          ) : scan ? (
            <div className="grid grid-cols-[3.5rem_minmax(0,1fr)] items-baseline gap-3 xl:grid-cols-[4rem_minmax(0,1fr)] xl:gap-4">
              <span
                className="metric text-right text-2xl leading-none"
                style={score === null ? undefined : { color: scoreTone(score) }}
                title={scan.status === "cancelled" ? "Partial crawl: the scan was cancelled" : undefined}
              >
                {formatNumber(score)}
              </span>
              <span className="grid min-w-0 grid-cols-3 text-xs text-muted-foreground">
                <span className="grid grid-cols-[2rem_auto] items-baseline gap-1 whitespace-nowrap">
                  <span className={cn("nums text-right font-medium", sev.high ? "text-bad" : "")}>{formatNumber(sev.high)}</span>
                  <span><span className="sr-only"> high</span><span aria-hidden>high</span></span>
                </span>
                <span className="grid grid-cols-[2rem_auto] items-baseline gap-1 whitespace-nowrap">
                  <span className={cn("nums text-right font-medium", sev.medium ? "text-warn" : "")}>{formatNumber(sev.medium)}</span>
                  <span><span className="sr-only"> medium</span><span aria-hidden>med</span></span>
                </span>
                <span className="grid grid-cols-[2rem_auto] items-baseline gap-1 whitespace-nowrap">
                  <span className="nums text-right">{formatNumber(scan.pages_crawled)}</span>
                  <span><span className="sr-only"> pages</span><span aria-hidden>pages</span></span>
                </span>
              </span>
            </div>
          ) : null}
        </TableCell>

        <TableCell className="px-1.5 text-xs sm:px-3 sm:text-sm">
          {lastScanTime !== undefined && scanAge !== null ? (
            <time
              dateTime={new Date(lastScanTime).toISOString()}
              title={formatDate(lastScanTime)}
              className={scanIsStale ? "font-semibold text-bad" : "font-medium"}
            >
              {formatScanAge(scanAge)}
              {scanIsStale && <span className="sr-only"> (over 30 days old)</span>}
            </time>
          ) : (
            <span className="text-muted-foreground">Never</span>
          )}
        </TableCell>

        <TableCell className="px-2 sm:px-2.5">
          <div className="flex flex-wrap items-center justify-end gap-1.5 sm:flex-nowrap">
            {activeScan ? (
              <Button size="sm" variant="secondary" className="h-11 w-full justify-center px-1.5 sm:h-8 sm:w-28" onClick={openActiveScan}>
                <FileSearch /> View scan
              </Button>
            ) : site.domain ? (
              <Button size="sm" variant="outline" className="hidden w-28 justify-center sm:inline-flex" disabled={starting} onClick={() => scanSite(site)}>
                <FileSearch /> {starting ? "Starting…" : "Scan"}
              </Button>
            ) : null}
            <Button size="icon" variant="ghost" className="size-11 text-muted-foreground/70 hover:text-foreground sm:size-8" aria-label={`Edit ${site.name}`} onClick={() => setEditing(site)}>
              <Pencil />
            </Button>
            <Button size="icon" variant="ghost" className="size-11 text-muted-foreground/70 hover:text-destructive sm:size-8" aria-label={`Delete ${site.name}`} onClick={() => setDeleting(site)}>
              <Trash2 />
            </Button>
          </div>
        </TableCell>
      </TableRow>
    );
  }

  const addDialog = (
    <Dialog
      open={open}
      onOpenChange={(nextOpen) => {
        setOpen(nextOpen);
        if (!nextOpen) setShowKeywordDefaults(false);
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Add site</DialogTitle>
          <DialogDescription>Add the website once, choose exactly how it should be reached, and start a local scan immediately.</DialogDescription>
        </DialogHeader>
        <form className="space-y-4" onSubmit={submit}>
          <Field label="Site name"><Input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="Optional" /></Field>
          <Field label="Website address"><Input value={form.domain} onChange={(e) => setForm({ ...form, domain: e.target.value })} placeholder="example.com" required /></Field>
          <KeywordToolDefaultsPanel
            expanded={showKeywordDefaults}
            locationCode={form.locationCode}
            languageCode={form.languageCode}
            onToggle={() => setShowKeywordDefaults((value) => !value)}
            onLocationCodeChange={(value) => setForm({ ...form, locationCode: value })}
            onLanguageCodeChange={(value) => setForm({ ...form, languageCode: value })}
          />
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Scan protocol">
              <Select value={form.crawlProtocol} onValueChange={(value) => setForm({ ...form, crawlProtocol: value as Site["crawl_protocol"] })}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  {crawlProtocolOptions.map((option) => <SelectItem key={option.value} value={option.value}>{option.label}</SelectItem>)}
                </SelectContent>
              </Select>
            </Field>
            <Field label="Host variant">
              <Select value={form.crawlHost} onValueChange={(value) => setForm({ ...form, crawlHost: value as Site["crawl_host"] })}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  {crawlHostOptions.map((option) => <SelectItem key={option.value} value={option.value}>{option.label}</SelectItem>)}
                </SelectContent>
              </Select>
            </Field>
          </div>
          <ScanPlanPreview site={formScanPlan} />
          <Field label="Notes"><Textarea value={form.notes} onChange={(e) => setForm({ ...form, notes: e.target.value })} /></Field>
          {error && <p className="text-sm text-destructive">{error}</p>}
          <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
            <Button type="button" variant="secondary" disabled={Boolean(creatingAction)} onClick={() => createSite(false)}>
              <Plus /> {creatingAction === "save" ? "Saving" : "Save site only"}
            </Button>
            <Button type="submit" disabled={Boolean(creatingAction)}>
              <FileSearch /> {creatingAction === "scan" ? "Starting scan" : "Add site and scan"}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );

  const deleteDialog = (
    <AlertDialog open={Boolean(deleting)} onOpenChange={(nextOpen) => !nextOpen && setDeleting(null)}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Delete site?</AlertDialogTitle>
          <AlertDialogDescription>
            This permanently removes "{deleting?.name}" and its saved scans, keywords, trackers, Search Console imports, and local history from SQLite.
          </AlertDialogDescription>
        </AlertDialogHeader>
        {error ? <p className="text-sm text-destructive">{error}</p> : null}
        <AlertDialogFooter>
          <AlertDialogCancel disabled={Boolean(deletingSiteId)}>Cancel</AlertDialogCancel>
          <AlertDialogAction type="button" disabled={Boolean(deletingSiteId)} onClick={() => deleting && deleteSite(deleting)}>
            {deletingSiteId ? "Deleting site" : "Delete site"}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );

  return (
    <>
      <PageHeader
        title="Your sites"
        meta={`${formatNumber(sites.length)} ${sites.length === 1 ? "site" : "sites"}${activeScanCount ? ` · ${formatNumber(activeScanCount)} ${activeScanCount === 1 ? "scan" : "scans"} running` : ""} · open one to enter its workspace`}
        action={
          sites.length ? (
            <Button onClick={() => setOpen(true)}>
              <Plus /> Add site
            </Button>
          ) : undefined
        }
      />
      {sites.length === 0 ? (
        onboarding
      ) : (
        <div className="overflow-hidden rounded-xl border border-border bg-card">
          <Table aria-label="Sites" className="table-fixed">
            <TableHeader>
              <TableRow className="hover:bg-transparent">
                <TableHead scope="col" className="pl-3 sm:pl-4">Site</TableHead>
                <TableHead scope="col" className="hidden w-[17rem] px-2 md:table-cell xl:w-[21rem]">Scan health</TableHead>
                <TableHead scope="col" className="w-24 px-1.5 whitespace-nowrap sm:w-32 sm:px-3">Last scan</TableHead>
                <TableHead scope="col" className="w-28 sm:w-52"><span className="sr-only">Actions</span></TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>{sites.map((site) => renderSiteRow(site))}</TableBody>
          </Table>
        </div>
      )}
      {addDialog}
      <EditSiteDialog
        site={editing}
        open={Boolean(editing)}
        onOpenChange={(nextOpen) => !nextOpen && setEditing(null)}
        onSaved={reloadSites}
      />
      {deleteDialog}
    </>
  );
}
