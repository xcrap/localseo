import { useEffect, useRef, useState, type ChangeEvent, type ReactNode } from "react";
import { useSearchParams } from "react-router-dom";
import { BarChart3, ExternalLink, RefreshCw, TableProperties, Upload } from "lucide-react";
import { api, type GscBatch, type GscLegacyRow, type GscStatus, type Site } from "../../../api";
import { Button, Input, Select, SelectContent, SelectItem, SelectTrigger, SelectValue, Tabs, TabsContent, TabsList, TabsTrigger, Textarea, toast } from "@/components/ui";
import { EmptyState, Field, PageHeader, ReportSection, StatusDot, StatusEvidenceTable, cleanSiteDomain, formatDate, formatNumber, preferredScanUrl } from "../../shared";
import { FilteredRows } from "../../data-table";
import { DateRangeFields, recentDateRange, type DateRange } from "../../date-picker";
import { GscConnectionPanel, gscConnectionState, gscLiveProperty } from "./connection";
import { GscStoredRows } from "./rows";
import { GscSyncPanel } from "./sync";
import { GscImportHistory, GscInspectionResults, GscPerformanceSummary, GscPerformanceTable, gscSortValues, gscSourceLabel, gscWindowLabel } from "./tables";

// Batches up to this size open automatically in the Performance tab; larger
// ones (typically API syncs) are browsed page by page in Stored rows.
const AUTO_OPEN_ROWS = 5000;
const LIVE_ROW_LIMIT = 100;
const gscTabValues = new Set(["performance", "rows", "sync", "import", "inspection", "connection"]);

type PerformanceView =
  | { source: "import"; batch: GscBatch; rows: GscLegacyRow[]; dimensions: string[] }
  | { source: "live"; range: DateRange; rows: GscLegacyRow[]; dimensions: string[]; hasMore: boolean };

export function GscPage({ site }: { site: Site }) {
  const defaultInspectionUrl = site.domain ? `${preferredScanUrl(site).replace(/\/$/, "")}/` : "";
  const defaultGscProperty = site.domain ? `sc-domain:${cleanSiteDomain(site.domain).replace(/^www\./i, "")}` : "";
  const [status, setStatus] = useState<GscStatus | null>(null);
  const [redirectUri, setRedirectUri] = useState("");
  const [properties, setProperties] = useState<any[]>([]);
  const [imports, setImports] = useState<GscBatch[]>([]);
  const [importsLoaded, setImportsLoaded] = useState(false);
  const [performance, setPerformance] = useState<PerformanceView | null>(null);
  const [openingId, setOpeningId] = useState("");
  const [inspectUrls, setInspectUrls] = useState(defaultInspectionUrl);
  const [inspection, setInspection] = useState<any>(null);
  const [dimension, setDimension] = useState("query");
  const [importSiteUrl, setImportSiteUrl] = useState(defaultGscProperty);
  const [loading, setLoading] = useState("");
  // The open tab lives in ?tab= so other screens can link straight to it.
  const [searchParams, setSearchParams] = useSearchParams();
  const urlTab = searchParams.get("tab") || "";
  const gscTab = gscTabValues.has(urlTab) ? urlTab : "performance";
  const setGscTab = (value: string) => {
    const next = new URLSearchParams(searchParams);
    if (value === "performance") next.delete("tab");
    else next.set("tab", value);
    setSearchParams(next, { replace: true });
  };
  const [rowsSelection, setRowsSelection] = useState("");
  const [dateRange, setDateRange] = useState<DateRange>(() => recentDateRange(28, 2));
  const openToken = useRef(0);
  const siteRef = useRef(site.id);
  siteRef.current = site.id;
  const liveProperty = gscLiveProperty(status);
  const connection = gscConnectionState(status, imports.length);
  const latestImport = imports[0];

  // Import rows load on demand: the history list carries metadata only.
  async function openImport(batch: GscBatch) {
    const token = ++openToken.current;
    setOpeningId(batch.id);
    try {
      const data = await api.gscImportRows(site.id, batch.id);
      if (token !== openToken.current) return;
      const { rows, ...meta } = data;
      setPerformance({ source: "import", batch: meta, rows: rows || [], dimensions: meta.dimensions || [] });
    } catch (err) {
      if (token === openToken.current) toast.error(err instanceof Error ? err.message : "Could not load the saved Search Console rows");
    } finally {
      if (token === openToken.current) setOpeningId("");
    }
  }

  async function loadImports() {
    const rows = await api.gscImports(site.id);
    setImports(rows);
    setImportsLoaded(true);
    return rows;
  }

  async function load() {
    const siteId = site.id;
    const [nextStatus, rows] = await Promise.all([api.gscStatus(siteId), api.gscImports(siteId)]);
    if (siteRef.current !== siteId) return;
    setStatus(nextStatus);
    setRedirectUri(nextStatus.redirectUri || "");
    setImports(rows);
    setImportsLoaded(true);
    const newest = rows[0];
    if (newest && Number(newest.rowCount || 0) <= AUTO_OPEN_ROWS) openImport(newest);
  }

  async function reloadStatus() {
    const next = await api.gscStatus(site.id);
    setStatus(next);
    setRedirectUri(next.redirectUri || "");
  }

  useEffect(() => {
    openToken.current += 1;
    setStatus(null);
    setImports([]);
    setImportsLoaded(false);
    setPerformance(null);
    setOpeningId("");
    setProperties([]);
    setInspection(null);
    setRowsSelection("");
    setImportSiteUrl(defaultGscProperty);
    setInspectUrls(defaultInspectionUrl);
    load().catch((err) => {
      setImportsLoaded(true);
      toast.error(err instanceof Error ? err.message : "Could not load Search Console data");
    });
  }, [site.id, site.domain, site.crawl_protocol, site.crawl_host]);

  const popupTimer = useRef(0);
  useEffect(() => () => window.clearInterval(popupTimer.current), []);
  async function connect() {
    try {
      const { url, redirectUri: uri } = await api.gscStart(site.id);
      if (uri) setRedirectUri(uri);
      const popup = window.open(url, "_blank", "width=680,height=780");
      if (!popup) {
        toast.error("The Google sign-in window was blocked. Allow pop-ups for this app and try again.");
        return;
      }
      // Reload the connection status once the OAuth window closes.
      window.clearInterval(popupTimer.current);
      popupTimer.current = window.setInterval(() => {
        if (!popup.closed) return;
        window.clearInterval(popupTimer.current);
        reloadStatus().catch(console.error);
      }, 500);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not start Google connection");
    }
  }
  async function loadProperties() {
    setLoading("sites");
    try {
      setProperties(await api.gscSites(site.id));
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not load Search Console properties");
      reloadStatus().catch(console.error);
    } finally {
      setLoading("");
    }
  }
  async function selectProperty(siteUrl: string) {
    setLoading("site");
    try {
      setStatus(await api.gscSetSite(site.id, siteUrl));
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not select property");
    } finally {
      setLoading("");
    }
  }
  async function queryLive() {
    setLoading("performance");
    const queryDimension = dimension;
    const range = dateRange;
    try {
      const result = await api.gscPerformance({
        siteId: site.id,
        startDate: range.startDate,
        endDate: range.endDate,
        dimensions: [queryDimension],
        rowLimit: LIVE_ROW_LIMIT,
      });
      openToken.current += 1;
      setOpeningId("");
      setPerformance({ source: "live", range, rows: result.rows || [], dimensions: [queryDimension], hasMore: Boolean(result.hasMore) });
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not query Search Console performance");
      reloadStatus().catch(console.error);
    } finally {
      setLoading("");
    }
  }
  async function importCsv(event: ChangeEvent<HTMLInputElement>) {
    const input = event.currentTarget;
    const file = input.files?.[0];
    if (!file) return;
    setLoading("import");
    try {
      const csv = await file.text();
      const result = await api.gscImport({
        siteId: site.id,
        siteUrl: importSiteUrl || site.domain,
        sourceName: file.name,
        csv,
      });
      const { rows, ...batch } = result as GscBatch & { rows?: GscLegacyRow[] };
      setImports((current) => [batch, ...current.filter((row) => row.id !== batch.id)]);
      openToken.current += 1;
      setOpeningId("");
      setPerformance({ source: "import", batch, rows: rows || [], dimensions: batch.dimensions || [] });
      toast.success(`Imported ${formatNumber(batch.rowCount)} Search Console rows.`);
      setGscTab("performance");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not import Search Console CSV");
    } finally {
      input.value = "";
      setLoading("");
    }
  }
  async function inspect() {
    setLoading("inspection");
    try {
      setInspection(await api.gscInspect({ siteId: site.id, urls: inspectUrls }));
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not inspect URLs");
    } finally {
      setLoading("");
    }
  }
  async function disconnect() {
    setLoading("disconnect");
    try {
      await api.gscDisconnect(site.id);
      setProperties([]);
      setInspection(null);
      if (performance?.source === "live") setPerformance(null);
      await reloadStatus();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not disconnect Search Console");
    } finally {
      setLoading("");
    }
  }
  function openFromHistory(batch: GscBatch) {
    openImport(batch);
    setGscTab("performance");
  }
  function browseRows(batchId: string) {
    setRowsSelection(batchId);
    setGscTab("rows");
  }

  const liveBlocker = status?.needsReconnect
    ? "Live queries are paused until you reconnect Google on the Connection tab."
    : !status?.connected
      ? "Connect Google on the Connection tab to query live data."
      : !liveProperty
        ? "Choose a Search Console property on the Connection tab to query live data."
        : "";
  const performanceMeta =
    performance?.source === "import"
      ? `Viewing ${performance.batch.sourceName || "saved batch"} · ${gscSourceLabel(performance.batch.source)} · ${gscWindowLabel(performance.batch)} · saved ${formatDate(performance.batch.createdAt)}`
      : performance?.source === "live"
        ? `Live query · ${formatDate(performance.range.startDate)} – ${formatDate(performance.range.endDate)} · not saved`
        : undefined;

  let performanceBody: ReactNode;
  if (performance?.rows.length) {
    performanceBody = (
      <div className="space-y-4">
        {performance.source === "live" ? (
          <p className="text-[13px] text-muted-foreground">
            First {formatNumber(LIVE_ROW_LIMIT)} rows straight from Google{performance.hasMore ? "; more exist" : ""}. Nothing here is saved — use Sync from Google to store every row locally.
          </p>
        ) : null}
        <GscPerformanceSummary rows={performance.rows} />
        <FilteredRows
          rows={performance.rows}
          placeholder="Filter performance rows…"
          csvName={`search-console-${performance.dimensions.join("-") || "rows"}`}
          sortValues={gscSortValues}
        >
          {(rows) => <GscPerformanceTable rows={rows} dimensions={performance.dimensions} />}
        </FilteredRows>
      </div>
    );
  } else if (openingId || (!importsLoaded && !performance)) {
    performanceBody = (
      <p className="py-6 text-center text-sm text-muted-foreground" role="status">
        Loading saved Search Console rows…
      </p>
    );
  } else if (performance) {
    performanceBody = <EmptyState title="No rows returned" text={performance.source === "live" ? "Google returned no rows for this range and dimension." : "This saved batch has no rows."} />;
  } else if (latestImport) {
    performanceBody = (
      <EmptyState
        title={`The latest batch has ${formatNumber(latestImport.rowCount)} rows`}
        text="Large batches are browsed page by page in Stored rows. You can also load every row here to filter and sort them together."
        action={
          <>
            <Button onClick={() => browseRows(latestImport.id)}>
              <TableProperties /> Browse stored rows
            </Button>
            <Button variant="secondary" onClick={() => openImport(latestImport)}>
              Load all rows here
            </Button>
          </>
        }
      />
    );
  } else {
    performanceBody = (
      <EmptyState
        title="No Search Console rows"
        text="Import a Search Console CSV export, or connect Google and sync a date range. Nothing is shown until real rows are saved."
        action={
          <>
            <Button variant="secondary" onClick={() => setGscTab("import")}>
              <Upload /> Import CSV
            </Button>
            <Button variant="secondary" onClick={() => setGscTab("sync")}>
              <RefreshCw /> Sync from Google
            </Button>
          </>
        }
      />
    );
  }

  return (
    <>
      <PageHeader
        title="Search Console"
        description="Connect Google to sync performance rows, or import a Search Console CSV into local SQLite."
        meta={
          <span className="flex flex-wrap items-center gap-x-2">
            <span className="inline-flex items-center gap-1.5">
              <StatusDot tone={connection.tone} /> {connection.label}
            </span>
            {imports.length ? (
              <>
                <span className="text-border">·</span>
                <span>
                  {formatNumber(imports.length)} saved {imports.length === 1 ? "batch" : "batches"}
                </span>
              </>
            ) : null}
          </span>
        }
      />
      <Tabs value={gscTab} onValueChange={setGscTab} className="space-y-5">
        <TabsList className="h-auto flex-wrap justify-start gap-y-1">
          <TabsTrigger value="performance">Performance</TabsTrigger>
          <TabsTrigger value="rows">Stored rows</TabsTrigger>
          <TabsTrigger value="sync">Sync from Google</TabsTrigger>
          <TabsTrigger value="import">History &amp; import</TabsTrigger>
          <TabsTrigger value="inspection">URL inspection</TabsTrigger>
          <TabsTrigger value="connection">{status?.needsReconnect ? "Connection · reconnect" : "Connection"}</TabsTrigger>
        </TabsList>
        <TabsContent value="performance" className="space-y-5">
          <ReportSection
            title="Performance rows"
            description="Clicks, impressions, CTR, and average position from a saved batch or a live query."
            meta={performanceMeta}
          >
            <div className="mb-5 space-y-2">
              <div className="grid gap-3 md:grid-cols-[1fr_1fr_180px_auto_auto]">
                <DateRangeFields value={dateRange} onChange={setDateRange} />
                <Field label="Dimension">
                  <Select value={dimension} onValueChange={setDimension}>
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="query">Queries</SelectItem>
                      <SelectItem value="page">Pages</SelectItem>
                      <SelectItem value="country">Countries</SelectItem>
                      <SelectItem value="device">Devices</SelectItem>
                    </SelectContent>
                  </Select>
                </Field>
                <div className="flex items-end">
                  <Button onClick={queryLive} disabled={Boolean(liveBlocker) || loading === "performance"}>
                    <BarChart3 /> {loading === "performance" ? "Querying" : "Query live"}
                  </Button>
                </div>
                <div className="flex items-end">
                  <Button variant="secondary" onClick={() => latestImport && openImport(latestImport)} disabled={!latestImport || Boolean(openingId)}>
                    <Upload /> {openingId ? "Loading" : "Latest batch"}
                  </Button>
                </div>
              </div>
              <p className="text-xs text-muted-foreground">
                {liveBlocker || `Query live reads the first ${formatNumber(LIVE_ROW_LIMIT)} rows from ${liveProperty} without saving them.`}
              </p>
            </div>
            {performanceBody}
          </ReportSection>
        </TabsContent>
        <TabsContent value="rows" className="space-y-5">
          {importsLoaded ? (
            <GscStoredRows
              siteId={site.id}
              imports={imports}
              selection={rowsSelection}
              onSelectionChange={setRowsSelection}
              onOpenSync={() => setGscTab("sync")}
              onOpenImport={() => setGscTab("import")}
            />
          ) : (
            <p className="text-sm text-muted-foreground" role="status">
              Loading saved batches…
            </p>
          )}
        </TabsContent>
        <TabsContent value="sync" className="space-y-5">
          <GscSyncPanel
            siteId={site.id}
            status={status}
            onOpenConnection={() => setGscTab("connection")}
            onSynced={({ pagesFetched: _pages, truncated: _truncated, ...batch }) => {
              setImports((current) => [batch, ...current.filter((row) => row.id !== batch.id)]);
              loadImports().catch(console.error);
              browseRows(batch.id);
            }}
          />
        </TabsContent>
        <TabsContent value="import" className="space-y-5">
          <ReportSection
            title="Local CSV import"
            description="Export Search Console performance as CSV and store it in this app's SQLite database. Saved imports reopen without Google OAuth."
            meta={imports.length ? `${formatNumber(imports.length)} saved` : undefined}
          >
            <div className="grid gap-4 lg:grid-cols-[minmax(260px,360px)_minmax(260px,1fr)]">
              <Field label="Property label">
                <Input value={importSiteUrl} onChange={(event) => setImportSiteUrl(event.target.value)} placeholder="sc-domain:example.com" />
              </Field>
              <Field label="CSV file">
                <Input type="file" accept=".csv,text/csv" onChange={importCsv} disabled={loading === "import"} />
              </Field>
            </div>
          </ReportSection>
          <ReportSection
            title="Imports and syncs"
            description="Every saved batch, newest first. Open one to read its rows in Performance, or browse it page by page in Stored rows."
            meta={imports.length ? `${formatNumber(imports.length)} saved` : undefined}
          >
            {imports.length ? (
              <GscImportHistory
                rows={imports}
                openId={performance?.source === "import" ? performance.batch.id : ""}
                loadingId={openingId}
                onOpen={openFromHistory}
                onBrowse={(row) => browseRows(row.id)}
              />
            ) : (
              <EmptyState title="Nothing saved yet" text="Import a Search Console CSV export or sync from Google to save real performance rows locally." />
            )}
          </ReportSection>
        </TabsContent>
        <TabsContent value="inspection" className="space-y-5">
          <ReportSection title="URL inspection" description="Inspect up to 20 URLs against a connected Google Search Console property.">
            <div className="space-y-4">
              <StatusEvidenceTable
                rows={[
                  {
                    title: "Inspection source",
                    status: status?.needsReconnect ? "Reconnect needed" : liveProperty ? "Google API ready" : "Google property required",
                    tone: liveProperty ? "good" : "warn",
                    text: status?.needsReconnect
                      ? "Google rejected the saved sign-in. Reconnect on the Connection tab to inspect URLs."
                      : liveProperty
                        ? `Live inspection uses ${liveProperty}.`
                        : "Local CSV imports cover performance rows only; live URL inspection needs a connected Google property.",
                  },
                ]}
              />
              <Field label="URLs to inspect">
                <Textarea value={inspectUrls} onChange={(event) => setInspectUrls(event.target.value)} placeholder="https://example.com/page" />
              </Field>
              <Button onClick={liveProperty ? inspect : () => setGscTab("connection")} disabled={loading === "inspection"}>
                <ExternalLink /> {loading === "inspection" ? "Inspecting" : liveProperty ? "Inspect URLs" : "Open connection"}
              </Button>
              {inspection?.rows?.length ? <GscInspectionResults rows={inspection.rows} /> : null}
            </div>
          </ReportSection>
        </TabsContent>
        <TabsContent value="connection" className="space-y-5">
          <GscConnectionPanel
            status={status}
            redirectUri={redirectUri}
            properties={properties}
            loading={loading}
            onConnect={connect}
            onLoadProperties={loadProperties}
            onSelectProperty={selectProperty}
            onDisconnect={disconnect}
          />
        </TabsContent>
      </Tabs>
    </>
  );
}
