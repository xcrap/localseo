import { useEffect, useRef, useState, type ChangeEvent, type SyntheticEvent, type ReactNode } from "react";
import { Link } from "react-router-dom";
import { Activity, CheckCircle2, ChevronLeft, ChevronRight, Download, RefreshCw, Search, Tags, Trash2 } from "lucide-react";
import { api, type KeywordResult, type Site } from "../../api";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle, Badge, Button, Checkbox, Input, Select, SelectContent, SelectItem, SelectTrigger, SelectValue, Table, TableBody, TableCell, TableHead, TableHeader, TableRow, toast } from "@/components/ui";
import { EmptyState, Field, HistoryList, HistoryTable, InfoTip, PageHeader, ReportSection, SiteDomainField, StatusDot, TagList, formatMetricStatus, formatNumber, keywordMetricClass, sourceLabel, sourceVariant } from "../shared";

function SourceMeta({ source, extra }: { source?: string; extra?: ReactNode }) {
  return (
    <span className="inline-flex flex-wrap items-center gap-x-1.5 gap-y-1">
      <StatusDot tone={sourceVariant(source) as any} />
      <span>{sourceLabel(source)}</span>
      {extra}
    </span>
  );
}

// The backend returns between 5 and 100 suggestions per research run.
const MIN_RESEARCH_LIMIT = 5;
const MAX_RESEARCH_LIMIT = 100;

function researchLimit(value: string) {
  const number = Math.round(Number(value));
  return Number.isFinite(number) && value.trim() ? Math.max(MIN_RESEARCH_LIMIT, Math.min(MAX_RESEARCH_LIMIT, number)) : 25;
}

export function KeywordsPage({ site }: { site: Site }) {
  const [query, setQuery] = useState(site.domain || "");
  // Raw text while typing ("1" on the way to "10"); clamped on blur and submit.
  const [limitInput, setLimitInput] = useState("25");
  const [result, setResult] = useState<any>(null);
  const [loading, setLoading] = useState(false);
  const [selected, setSelected] = useState<Record<string, boolean>>({});
  const selectedCount = Object.values(selected).filter(Boolean).length;

  useEffect(() => {
    setQuery(site.domain || "");
  }, [site.id, site.domain]);

  async function submit(event: SyntheticEvent) {
    event.preventDefault();
    setLoading(true);
    try {
      const limit = researchLimit(limitInput);
      setLimitInput(String(limit));
      const data = await api.researchKeywords({ siteId: site.id, query, limit });
      setResult(data);
      setSelected(Object.fromEntries(data.rows.slice(0, 10).map((row) => [row.keyword, true])));
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Keyword research failed");
    } finally {
      setLoading(false);
    }
  }

  async function saveSelected() {
    const rows = (result?.rows || []).filter((row: KeywordResult) => selected[row.keyword]);
    if (!rows.length) return;
    try {
      await api.saveKeywords({ siteId: site.id, keywords: rows, source: result?.source || "research" });
      toast.success(`Saved ${rows.length} keywords.`);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not save selected keywords");
    }
  }

  return (
    <>
      <PageHeader title="Keyword research" description="Find real keyword suggestions. Volume, CPC, and difficulty stay unavailable unless you import real metrics later." />
      <section className="rounded-2xl border border-border/70 bg-card p-5">
        <form className="grid gap-3 lg:grid-cols-[minmax(0,1fr)_140px_auto] lg:items-end" onSubmit={submit}>
          <Field label="Seed keyword">
            <Input value={query} onChange={(e) => setQuery(e.target.value)} placeholder={site.domain || "seed keyword"} />
          </Field>
          <Field label="Suggestion limit">
            <Input
              value={limitInput}
              type="number"
              min={MIN_RESEARCH_LIMIT}
              max={MAX_RESEARCH_LIMIT}
              onChange={(e) => setLimitInput(e.target.value)}
              onBlur={() => setLimitInput(String(researchLimit(limitInput)))}
            />
          </Field>
          <Button disabled={loading || !query.trim()}><Search /> {loading ? "Researching" : "Research"}</Button>
        </form>
      </section>
      <div className="mt-6">
        {result ? (
          <ReportSection
            title="Results"
            meta={
              <SourceMeta
                source={result.source}
                extra={
                  <>
                    <span>· {formatNumber(result.rows?.length || 0)} suggestions</span>
                    {result.warning ? <InfoTip label="Result warning">{result.warning}</InfoTip> : null}
                  </>
                }
              />
            }
            action={
              <Button variant="secondary" size="sm" onClick={saveSelected} disabled={!result.rows?.length || selectedCount === 0}>
                <CheckCircle2 /> Save {selectedCount || "selected"}
              </Button>
            }
          >
            {result.rows?.length ? <KeywordTable rows={result.rows} selected={selected} setSelected={setSelected} /> : <EmptyState title="No keyword suggestions" text={result.warning || "No suggestions came back for this seed."} />}
          </ReportSection>
        ) : (
          <EmptyState title="No research run" text="Enter a seed keyword to build the first keyword set." />
        )}
      </div>
    </>
  );
}

function KeywordTable({
  rows,
  selected,
  setSelected,
}: {
  rows: KeywordResult[];
  selected?: Record<string, boolean>;
  setSelected?: (value: Record<string, boolean>) => void;
}) {
  return (
    <Table>
      <TableHeader>
        <TableRow>
          {selected && <TableHead className="w-10"><span className="sr-only">Select</span></TableHead>}
          <TableHead>Keyword</TableHead>
          <TableHead>Volume</TableHead>
          <TableHead>Difficulty</TableHead>
          <TableHead>CPC</TableHead>
          <TableHead>Intent</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {rows.map((row) => (
          <TableRow key={row.keyword}>
            {selected && setSelected && (
              <TableCell>
                <Checkbox aria-label={`Select ${row.keyword}`} checked={Boolean(selected[row.keyword])} onCheckedChange={(checked) => setSelected({ ...selected, [row.keyword]: checked === true })} />
              </TableCell>
            )}
            <TableCell className="font-medium">{row.keyword}</TableCell>
            <TableCell className={keywordMetricClass(row.searchVolume)}>{formatMetricStatus(row.searchVolume)}</TableCell>
            <TableCell className={keywordMetricClass(row.difficulty)}>{formatMetricStatus(row.difficulty)}</TableCell>
            <TableCell className={keywordMetricClass(row.cpc)}>{formatMetricStatus(row.cpc)}</TableCell>
            <TableCell><Badge variant="outline">{row.intent}</Badge></TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}

const SAVED_PAGE_SIZE = 100;

export function SavedPage({ site }: { site: Site }) {
  const [rows, setRows] = useState<any[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [tags, setTags] = useState<any[]>([]);
  const [metricImports, setMetricImports] = useState<any[]>([]);
  const [search, setSearch] = useState("");
  const [tagFilter, setTagFilter] = useState("");
  const [tagInput, setTagInput] = useState("");
  const [selected, setSelected] = useState<Record<string, boolean>>({});
  const [loading, setLoading] = useState(false);
  const [importing, setImporting] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const requestRef = useRef(0);
  const selectedIds = Object.entries(selected).filter(([, checked]) => checked).map(([id]) => id);
  const pageCount = Math.max(1, Math.ceil(total / SAVED_PAGE_SIZE));

  async function load(nextPage = page) {
    const token = ++requestRef.current;
    setLoading(true);
    try {
      const data = await api.querySavedKeywords(site.id, {
        search,
        tagNames: tagFilter ? [tagFilter] : [],
        page: nextPage,
        pageSize: SAVED_PAGE_SIZE,
        sort: "created_at",
        order: "desc",
      });
      if (token !== requestRef.current) return;
      const nextTotal = Number(data.total ?? data.rows?.length ?? 0);
      const lastPage = Math.max(1, Math.ceil(nextTotal / SAVED_PAGE_SIZE));
      // After deletes the current page can fall past the end; step back once.
      if (nextPage > lastPage && nextTotal > 0) {
        await load(lastPage);
        return;
      }
      setRows(data.rows || []);
      setTotal(nextTotal);
      setPage(Number(data.page || nextPage));
      const [nextTags, nextImports] = await Promise.all([
        data.tags ? Promise.resolve(data.tags) : api.keywordTags(site.id),
        api.keywordMetricImports(site.id),
      ]);
      if (token !== requestRef.current) return;
      setTags(nextTags);
      setMetricImports(nextImports);
      setSelected({});
    } catch (err) {
      if (token === requestRef.current) toast.error(err instanceof Error ? err.message : "Could not load saved keywords");
    } finally {
      if (token === requestRef.current) setLoading(false);
    }
  }

  useEffect(() => {
    load(1).catch(console.error);
  }, [site.id]);

  async function applyTags(mode: "add" | "remove") {
    if (!selectedIds.length || !tagInput.trim()) return;
    try {
      await api.updateKeywordTags(site.id, {
        savedKeywordIds: selectedIds,
        ...(mode === "add" ? { addTags: tagInput.split(/\n|,/) } : { removeTagNames: tagInput.split(/\n|,/) }),
      });
      toast.success(mode === "add" ? "Tags added." : "Tags removed.");
      setTagInput("");
      await load();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not update tags");
    }
  }

  async function removeSelected() {
    if (!selectedIds.length) return;
    setDeleting(true);
    try {
      await api.removeSavedKeywords(site.id, selectedIds);
      toast.success(`Deleted ${formatNumber(selectedIds.length)} keywords.`);
      setConfirmDelete(false);
      await load();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not delete selected keywords");
    } finally {
      setDeleting(false);
    }
  }

  async function importMetricsCsv(event: ChangeEvent<HTMLInputElement>) {
    const input = event.currentTarget;
    const file = input.files?.[0];
    if (!file) return;
    setImporting(true);
    try {
      const csv = await file.text();
      const imported = await api.importKeywordMetrics({
        siteId: site.id,
        sourceName: file.name,
        csv,
      });
      toast.success(`Imported ${formatNumber(imported.rowCount || imported.row_count || 0)} keyword metric rows from ${file.name}.`);
      await load();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not import keyword metrics CSV");
    } finally {
      input.value = "";
      setImporting(false);
    }
  }

  return (
    <>
      <PageHeader
        title="Saved keywords"
        description="The local canonical keyword list for clustering, rank tracking, MCP tools, and Codex briefs."
        action={
          <div className="flex flex-wrap gap-2">
            <Button asChild variant="secondary">
              <a href={api.savedKeywordsCsvUrl(site.id)}>
                <Download />
                Export CSV
              </a>
            </Button>
            <Button variant="outline" onClick={() => load()} disabled={loading}><RefreshCw /> {loading ? "Refreshing" : "Refresh"}</Button>
          </div>
        }
      />
      <section className="mb-6 rounded-2xl border border-border/70 bg-card p-5">
        <div className="grid gap-3 lg:grid-cols-[minmax(0,1fr)_220px_auto] lg:items-end">
          <Field label="Search keywords">
            <Input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search saved keywords" />
          </Field>
          <Field label="Tag filter">
            <Select value={tagFilter || "__all"} onValueChange={(value) => setTagFilter(value === "__all" ? "" : value)}>
              <SelectTrigger><SelectValue placeholder="Tag" /></SelectTrigger>
              <SelectContent>
                <SelectItem value="__all">All tags</SelectItem>
                {tags.map((tag) => <SelectItem key={tag.id} value={tag.name}>{tag.name}</SelectItem>)}
              </SelectContent>
            </Select>
          </Field>
          <Button onClick={() => load(1)} disabled={loading}><Search /> {loading ? "Loading" : "Apply"}</Button>
        </div>
        <div className="mt-4 flex flex-wrap items-center justify-between gap-x-6 gap-y-3 border-t border-border/60 pt-4">
          <div className="min-w-0 space-y-1">
            <div className="flex items-center gap-1.5 text-sm font-medium">
              <span>Keyword metrics</span>
              <InfoTip label="About keyword metrics imports">
                Import real keyword, volume, difficulty, CPC, and intent columns. Rows update the saved keyword list and matching rank tracker keywords.
              </InfoTip>
            </div>
            <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
              <StatusDot tone={metricImports.length ? "good" : "outline"} />
              <span>{metricImports.length ? `${formatNumber(metricImports.length)} imports saved` : "No metrics imported yet"}</span>
            </div>
          </div>
          <div className="w-full sm:w-80">
            <Field label="Import metrics CSV">
              <Input type="file" accept=".csv,text/csv" onChange={importMetricsCsv} disabled={importing} />
            </Field>
          </div>
        </div>
      </section>
      {selectedIds.length > 0 && (
        <section className="mb-6 rounded-2xl border border-primary/25 bg-primary/[0.03] p-5 sm:p-6">
          <div className="grid gap-3 lg:grid-cols-[minmax(0,1fr)_auto_auto_auto] lg:items-end">
            <Field label="Tag names">
              <Input value={tagInput} onChange={(event) => setTagInput(event.target.value)} placeholder="tag names, comma separated" />
            </Field>
            <Button variant="secondary" onClick={() => applyTags("add")}><Tags /> Add tags</Button>
            <Button variant="outline" onClick={() => applyTags("remove")}>Remove tags</Button>
            <Button variant="destructive" onClick={() => setConfirmDelete(true)} disabled={deleting}><Trash2 /> Delete {formatNumber(selectedIds.length)}</Button>
          </div>
        </section>
      )}
      <ReportSection
        title="Saved keyword list"
        meta={
          total > rows.length
            ? `${formatNumber(total)} saved · showing ${formatNumber((page - 1) * SAVED_PAGE_SIZE + 1)}–${formatNumber((page - 1) * SAVED_PAGE_SIZE + rows.length)}`
            : `${formatNumber(total)} saved`
        }
      >
        {rows.length ? (
          <div className="space-y-3">
            <SavedKeywordsTable rows={rows} selected={selected} setSelected={setSelected} />
            {pageCount > 1 ? (
              <div className="flex flex-wrap items-center justify-between gap-2 text-[13px] text-muted-foreground">
                <span className="nums">Page {formatNumber(page)} of {formatNumber(pageCount)}</span>
                <div className="flex items-center gap-1.5">
                  <Button size="sm" variant="outline" disabled={loading || page <= 1} onClick={() => load(page - 1)} aria-label="Previous page of saved keywords">
                    <ChevronLeft /> Prev
                  </Button>
                  <Button size="sm" variant="outline" disabled={loading || page >= pageCount} onClick={() => load(page + 1)} aria-label="Next page of saved keywords">
                    Next <ChevronRight />
                  </Button>
                </div>
              </div>
            ) : null}
          </div>
        ) : (
          <EmptyState
            title={loading ? "Loading keywords" : "No saved keywords"}
            text={loading ? "Reading the local keyword list." : "Save keywords from research or through the MCP tool."}
            action={!loading ? <Button asChild><Link to="/keywords"><Search /> Research keywords</Link></Button> : undefined}
          />
        )}
      </ReportSection>
      <div className="mt-6">
        <HistoryList title="Keyword metric imports" rows={metricImports} labelKey="sourceName" labelTitle="Source file" />
      </div>
      <AlertDialog open={confirmDelete} onOpenChange={(open) => !deleting && setConfirmDelete(open)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete {formatNumber(selectedIds.length)} saved {selectedIds.length === 1 ? "keyword" : "keywords"}?</AlertDialogTitle>
            <AlertDialogDescription>
              This permanently removes the selected keywords and their tag assignments from the saved keyword list in local SQLite. Export a CSV first if you may need them again.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={deleting}>Keep keywords</AlertDialogCancel>
            <AlertDialogAction type="button" onClick={removeSelected} disabled={deleting}>
              {deleting ? "Deleting keywords" : `Delete ${formatNumber(selectedIds.length)}`}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}

function SavedKeywordsTable({
  rows,
  selected,
  setSelected,
}: {
  rows: any[];
  selected: Record<string, boolean>;
  setSelected: (value: Record<string, boolean>) => void;
}) {
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead className="w-10"><span className="sr-only">Select</span></TableHead>
          <TableHead>Keyword</TableHead>
          <TableHead>Volume</TableHead>
          <TableHead>Difficulty</TableHead>
          <TableHead>CPC</TableHead>
          <TableHead>Intent</TableHead>
          <TableHead>Tags</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {rows.map((row) => (
          <TableRow key={row.id}>
            <TableCell>
              <Checkbox aria-label={`Select ${row.keyword}`} checked={Boolean(selected[row.id])} onCheckedChange={(checked) => setSelected({ ...selected, [row.id]: checked === true })} />
            </TableCell>
            <TableCell className="font-medium">{row.keyword}</TableCell>
            <TableCell className={keywordMetricClass(row.search_volume)}>{formatMetricStatus(row.search_volume)}</TableCell>
            <TableCell className={keywordMetricClass(row.difficulty)}>{formatMetricStatus(row.difficulty)}</TableCell>
            <TableCell className={keywordMetricClass(row.cpc)}>{formatMetricStatus(row.cpc)}</TableCell>
            <TableCell><Badge variant="outline">{row.intent}</Badge></TableCell>
            <TableCell><TagList tags={row.tags || []} /></TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}

export function SerpPage({ site }: { site: Site }) {
  const [keyword, setKeyword] = useState("");
  const [domain, setDomain] = useState(site.domain);
  const [result, setResult] = useState<any>(null);
  const [runs, setRuns] = useState<any[]>([]);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    setDomain(site.domain);
  }, [site.id, site.domain]);

  async function load() {
    try {
      setRuns(await api.serpRuns(site.id));
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not load SERP history");
    }
  }
  useEffect(() => {
    load().catch(console.error);
  }, [site.id]);

  async function submit(event: SyntheticEvent) {
    event.preventDefault();
    setLoading(true);
    try {
      const data = await api.analyzeSerp({ siteId: site.id, keyword, domain, depth: 20 });
      setResult(data);
      await load();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "SERP analysis failed");
    } finally {
      setLoading(false);
    }
  }

  return (
    <>
      <PageHeader title="SERP analysis" description="Inspect ranking pages, active-site ownership, intent mix, and content opportunities for one query." />
      <section className="rounded-2xl border border-border/70 bg-card p-5">
        <form className="grid gap-3 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_auto] lg:items-end" onSubmit={submit}>
          <Field label="Search query">
            <Input value={keyword} onChange={(event) => setKeyword(event.target.value)} placeholder="best local seo tool" required />
          </Field>
          <SiteDomainField
            label="Ranking domain"
            value={domain}
            siteDomain={site.domain}
            hint="Use the active site to check its rankings, or enter a competitor domain to compare."
            onChange={setDomain}
          />
          <Button disabled={loading || !keyword.trim()}><Activity /> {loading ? "Analyzing" : "Analyze SERP"}</Button>
        </form>
      </section>
      <div className="mt-6 grid gap-6 2xl:grid-cols-[minmax(0,1fr)_460px]">
        <ReportSection
          title="Ranking pages"
          meta={
            result ? (
              <SourceMeta
                source={result.source}
                extra={
                  <>
                    <span>· Active site position: {result.domainPosition || "not found"}</span>
                    {result.warning ? <InfoTip label="Result warning">{result.warning}</InfoTip> : null}
                  </>
                }
              />
            ) : undefined
          }
        >
          {result?.rows?.length ? <SerpTable rows={result.rows} /> : <EmptyState title="No SERP yet" text="Analyze a keyword to save a local SERP run." />}
        </ReportSection>
        <ReportSection title="SERP history" meta={`${formatNumber(runs.length)} saved`}>
          {runs.length ? (
            <HistoryTable rows={runs} labelKey="keyword" labelTitle="Query" />
          ) : (
            <EmptyState title="No history" text="Analyze a keyword to create the first saved SERP run." />
          )}
        </ReportSection>
      </div>
    </>
  );
}

function SerpTable({ rows }: { rows: any[] }) {
  return (
    <Table>
      <TableHeader><TableRow><TableHead>Rank</TableHead><TableHead>Domain</TableHead><TableHead>Title</TableHead><TableHead>URL</TableHead></TableRow></TableHeader>
      <TableBody>
        {rows.map((row) => (
          <TableRow key={`${row.rank}:${row.url}`} className={row.isDomain ? "bg-accent/45" : ""}>
            <TableCell className="nums font-medium">{row.rank}</TableCell>
            <TableCell>{row.domain}</TableCell>
            <TableCell className="max-w-md truncate">{row.title}</TableCell>
            <TableCell className="max-w-xs truncate text-muted-foreground">{row.url}</TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}
