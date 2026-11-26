import { useEffect, useState, type SyntheticEvent } from "react";
import { ExternalLink, Sparkles } from "lucide-react";
import { api, type Site } from "../../api";
import { Button, Input, Table, TableBody, TableCell, TableHead, TableHeader, TableRow, Textarea, toast } from "@/components/ui";
import { EmptyState, Field, HistoryList, PageHeader, ProviderNotice, ReportSection, SourceBadge, StatsBand, formatNumber } from "../shared";

export function BrandLookupPage({ site }: { site: Site }) {
  const [query, setQuery] = useState(site.domain || site.name);
  const [competitors, setCompetitors] = useState("");
  const [result, setResult] = useState<any>(null);
  const [runs, setRuns] = useState<any[]>([]);
  const [loading, setLoading] = useState(false);

  async function load() {
    setRuns(await api.brandLookupRuns(site.id));
  }
  useEffect(() => {
    setQuery(site.domain || site.name);
    setResult(null);
    load().catch(console.error);
  }, [site.id, site.domain, site.name]);

  async function submit(event: SyntheticEvent) {
    event.preventDefault();
    setLoading(true);
    try {
      const data = await api.brandLookup({ siteId: site.id, query, competitors });
      setResult(data);
      await load();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not run the brand lookup.");
    } finally {
      setLoading(false);
    }
  }

  return (
    <>
      <PageHeader
        title="Brand lookup"
        description="Check real web-search evidence for a brand or domain. The app does not invent answer-model visibility."
        meta={`${formatRunCount(runs.length)} saved`}
      />
      <div className="grid gap-6 2xl:grid-cols-[460px_minmax(0,1fr)]">
        <ReportSection title="Lookup" description="Competitors can be comma-separated or one per line. Each run compares real search evidence and is saved in SQLite.">
          <form className="space-y-4" onSubmit={submit}>
            <Field label="Brand or domain"><Input value={query} onChange={(event) => setQuery(event.target.value)} required /></Field>
            <Field label="Competitors"><Textarea value={competitors} onChange={(event) => setCompetitors(event.target.value)} placeholder="competitor.com, otherbrand" /></Field>
            <Button disabled={loading}><Sparkles /> {loading ? "Looking up" : "Run lookup"}</Button>
          </form>
        </ReportSection>
        <div className="space-y-6">
          {result ? <BrandLookupResult result={result} /> : <EmptyState title="No lookup yet" text="Run a brand lookup to save local visibility evidence." />}
          <HistoryList title="Lookup history" rows={runs} labelKey="query" labelTitle="Brand or domain" />
        </div>
      </div>
    </>
  );
}

function formatRunCount(count: number) {
  return count === 1 ? "1 run" : `${count} runs`;
}

type BrandResultCount = {
  label: string;
  isPrimary?: boolean;
  resultCount: number | null;
  maxResults?: number | null;
  error?: string;
};

// Exact-phrase web results per name, out of the first N results checked. A raw
// count from one search, not a share of voice or a visibility score.
function BrandResultCounts({ rows }: { rows: BrandResultCount[] }) {
  if (!rows.length) {
    return <EmptyState title="No result counts" text="This lookup saved no per-name search counts." />;
  }
  return (
    <div className="space-y-3">
      {rows.map((row) => {
        const max = Number(row.maxResults || 0);
        const count = row.resultCount;
        return (
          <div key={row.label} className="space-y-1">
            <div className="flex flex-wrap items-center justify-between gap-2 text-sm">
              <span className={row.isPrimary ? "font-semibold" : ""}>
                {row.label}
                {row.isPrimary ? <span className="ml-1.5 text-xs font-normal text-muted-foreground">looked up</span> : null}
              </span>
              {count == null ? (
                <span className="text-xs text-bad">Search failed</span>
              ) : (
                <span className="nums">
                  {formatNumber(count)}
                  {max ? <span className="text-muted-foreground"> of first {formatNumber(max)}</span> : null}
                </span>
              )}
            </div>
            {count != null && max ? (
              <div className="h-2 rounded-full bg-muted" aria-hidden>
                <div className="h-2 rounded-full bg-primary" style={{ width: `${Math.min(100, (count / max) * 100)}%` }} />
              </div>
            ) : null}
            {count == null && row.error ? <p className="text-xs text-muted-foreground">{row.error}</p> : null}
          </div>
        );
      })}
    </div>
  );
}

function BrandLookupResult({ result }: { result: any }) {
  const countRows: BrandResultCount[] = Array.isArray(result.resultCounts) ? result.resultCounts : [];
  const maxResults = countRows.find((row) => row.maxResults)?.maxResults;
  const citationRows = result.citations || [];
  const recommendationRows = result.recommendations || [];
  return (
    <div className="space-y-6">
      {result.warning ? <ProviderNotice title="Lookup warning" text={result.warning} source={result.source} /> : null}
      <ReportSection
        title="Exact-phrase web results"
        description={`How many results an exact-phrase web search returned for each name, among the first ${maxResults ? formatNumber(maxResults) : "results"} checked. A raw result count, not share of voice or visibility.`}
        meta={
          <span className="inline-flex flex-wrap items-center gap-2">
            <SourceBadge source={result.source} />
            {result.resolvedEntity ? <span>Resolved entity: {result.resolvedEntity}</span> : null}
          </span>
        }
      >
        <BrandResultCounts rows={countRows} />
      </ReportSection>
      {result.platforms?.length ? (
        <StatsBand
          title="Results by platform"
          text="Result rows returned by each search platform for the looked-up name. Counts, not percentages."
          items={(result.platforms || []).map((platform: any) => ({
            title: String(platform.platform || "platform").replaceAll("_", " "),
            value: platform.resultCount,
            detail: platform.resultCount == null ? "No result count was saved for this platform." : `${formatNumber(platform.resultCount)} results returned`,
          }))}
        />
      ) : null}
      <div className="grid gap-6 2xl:grid-cols-[minmax(0,1fr)_460px]">
        <ReportSection title="Citations" description="Real web evidence used for this lookup." meta={citationRows.length ? `${citationRows.length} ${citationRows.length === 1 ? "source" : "sources"}` : undefined}>
          {citationRows.length ? <CitationList rows={citationRows} /> : <EmptyState title="No citations" text="No citation rows came back for this lookup." />}
        </ReportSection>
        <ReportSection title="Next actions" description="Grounded recommendations saved with this lookup.">
          {recommendationRows.length ? (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="w-16">#</TableHead>
                  <TableHead>Recommended action</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
              {recommendationRows.map((item: string, index: number) => (
                <TableRow key={item}>
                  <TableCell className="nums text-muted-foreground">{index + 1}</TableCell>
                  <TableCell className="text-sm leading-6">{item}</TableCell>
                </TableRow>
              ))}
              </TableBody>
            </Table>
          ) : <EmptyState title="No recommendations" text="Recommendations appear when the lookup source returns them." />}
        </ReportSection>
      </div>
    </div>
  );
}

function CitationList({ rows }: { rows: any[] }) {
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>Citation</TableHead>
          <TableHead>URL</TableHead>
          <TableHead>Evidence</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {rows.map((citation, index) => {
          const href = citation.url || citation.link || "";
          return (
            <TableRow key={`${href || citation.title}:${index}`}>
              <TableCell className="min-w-64">
                {href ? (
                  <a
                    href={href}
                    target="_blank"
                    rel="noreferrer"
                    className="inline-flex items-baseline gap-1.5 font-medium text-primary underline-offset-4 hover:underline"
                  >
                    {citation.title || href}
                    <ExternalLink className="size-3.5 shrink-0 self-center" />
                  </a>
                ) : (
                  <span className="font-medium">{citation.title || "Citation"}</span>
                )}
              </TableCell>
              <TableCell className="min-w-64 break-all text-xs text-muted-foreground">{href || "-"}</TableCell>
              <TableCell className="min-w-80 text-sm leading-6 text-muted-foreground">
                {citation.snippet || citation.description || "-"}
              </TableCell>
            </TableRow>
          );
        })}
      </TableBody>
    </Table>
  );
}
