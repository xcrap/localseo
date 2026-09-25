import { Fragment, useEffect, useMemo, useState, type ReactNode } from "react";
import { ChevronDown, ChevronRight, Download } from "lucide-react";
import { api, type CannibalizationInsights, type Site } from "../../../api";
import { Badge, Button, Input, SortableTableHead, Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui";
import { recentDateRange, type DateRange } from "../../date-picker";
import { FilteredRows, rowsToCsv, type CsvColumn } from "../../data-table";
import { Field, Hint, ReportSection, downloadFile, formatNumber } from "../../shared";
import { InsightError, InsightSkeleton, InsightUnavailable, InsightUrl, RangeControls, formatAvgPosition, formatCount, formatCtr, formatRange, useInsightQuery } from "./common";

const DEFAULT_MIN_IMPRESSIONS = 10;

type CannibalizationQuery = { startDate?: string; endDate?: string; minImpressions?: number };
type QueryRow = CannibalizationInsights["rows"][number] & { pageUrls: string[] };

const queryCsvColumns: CsvColumn<QueryRow>[] = [
  { label: "query", value: (row) => row.query },
  { label: "total_impressions", value: (row) => row.totalImpressions },
  { label: "total_clicks", value: (row) => row.totalClicks },
  { label: "competing_pages", value: (row) => row.pages.length },
  { label: "pages", value: (row) => row.pageUrls },
  { label: "rank_tracker_urls", value: (row) => row.rankUrls },
];

const cannibalizationSortValues: Record<string, (row: QueryRow) => unknown> = {
  pages: (row) => row.pages.length,
};

export function CannibalizationTab({ site }: { site: Site }) {
  const { status, data, error, query, run, retry } = useInsightQuery<CannibalizationQuery, CannibalizationInsights>(
    site.id,
    (next) => api.cannibalizationInsights(site.id, next),
    {},
  );
  const [range, setRange] = useState<DateRange>(() => recentDateRange(28, 2));
  const [minImpressions, setMinImpressions] = useState(String(DEFAULT_MIN_IMPRESSIONS));
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());

  useEffect(() => {
    if (!query.startDate && data?.range?.startDate && data.range.endDate) {
      setRange({ startDate: data.range.startDate, endDate: data.range.endDate });
    }
  }, [data]);

  const rows = useMemo<QueryRow[]>(
    () =>
      (data?.rows || []).map((row) => {
        const pages = row.pages || [];
        return { ...row, pages, rankUrls: row.rankUrls || [], pageUrls: pages.map((page) => page.url) };
      }),
    [data],
  );
  const minValue = Number(minImpressions);
  const minParam = Number.isFinite(minValue) && minValue >= 0 ? Math.round(minValue) : undefined;
  const loading = status === "loading";

  function toggle(queryText: string) {
    setExpanded((current) => {
      const next = new Set(current);
      if (next.has(queryText)) next.delete(queryText);
      else next.add(queryText);
      return next;
    });
  }

  function downloadPageCsv() {
    const flat = rows.flatMap((row) =>
      row.pages.map((page) => ({
        query: row.query,
        url: page.url,
        clicks: page.clicks,
        impressions: page.impressions,
        ctr: page.ctr,
        position: page.position,
        rank_tracker_url: row.rankUrls.includes(page.url),
      })),
    );
    downloadFile("cannibalization-pages.csv", rowsToCsv(flat), "text/csv;charset=utf-8");
  }

  let body: ReactNode;
  if (status === "error") body = <InsightError message={error} onRetry={retry} />;
  else if (!data) body = <InsightSkeleton />;
  else if (!data.available) body = <InsightUnavailable reason={data.reason} />;
  else {
    body = (
      <ReportSection
        title="Queries with competing pages"
        meta={`${formatNumber(rows.length)} ${rows.length === 1 ? "query" : "queries"} · ${formatRange(data.range)}${loading ? " · updating…" : ""}`}
        action={
          rows.length ? (
            <Button type="button" size="sm" variant="ghost" className="text-xs text-muted-foreground hover:text-foreground" onClick={downloadPageCsv}>
              <Download /> Page-level CSV
            </Button>
          ) : undefined
        }
      >
        <p className="mb-3 text-[13px] leading-5 text-muted-foreground">
          Queries where two or more of your pages earn impressions. Split signals can hold both pages back; consolidate or differentiate them.
        </p>
        {rows.length ? (
          <FilteredRows rows={rows} placeholder="Filter queries or URLs…" csvName="cannibalization-queries" csvColumns={queryCsvColumns} sortValues={cannibalizationSortValues}>
            {(visible) => (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className="w-10">
                      <span className="sr-only">Expand</span>
                    </TableHead>
                    <SortableTableHead sortKey="query">Query</SortableTableHead>
                    <SortableTableHead sortKey="pages">Pages</SortableTableHead>
                    <SortableTableHead sortKey="totalImpressions">Impressions</SortableTableHead>
                    <SortableTableHead sortKey="totalClicks">Clicks</SortableTableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {visible.map((row) => {
                    const open = expanded.has(row.query);
                    const detailId = `cannibal-${encodeURIComponent(row.query)}`;
                    return (
                      <Fragment key={row.query}>
                        <TableRow className="cursor-pointer" onClick={() => toggle(row.query)}>
                          <TableCell>
                            <Button
                              type="button"
                              size="icon"
                              variant="ghost"
                              className="size-7"
                              aria-expanded={open}
                              aria-controls={detailId}
                              aria-label={`${open ? "Hide" : "Show"} pages for “${row.query}”`}
                              onClick={(event) => {
                                event.stopPropagation();
                                toggle(row.query);
                              }}
                            >
                              {open ? <ChevronDown /> : <ChevronRight />}
                            </Button>
                          </TableCell>
                          <TableCell className="max-w-md break-words font-medium">{row.query}</TableCell>
                          <TableCell className="nums">{formatNumber(row.pages.length)}</TableCell>
                          <TableCell className="nums">{formatCount(row.totalImpressions)}</TableCell>
                          <TableCell className="nums">{formatCount(row.totalClicks)}</TableCell>
                        </TableRow>
                        {open ? (
                          <TableRow id={detailId} className="hover:bg-transparent">
                            <TableCell />
                            <TableCell colSpan={4} className="pb-4">
                              <CompetingPages row={row} />
                            </TableCell>
                          </TableRow>
                        ) : null}
                      </Fragment>
                    );
                  })}
                </TableBody>
              </Table>
            )}
          </FilteredRows>
        ) : (
          <p className="text-sm text-muted-foreground">No query has more than one page above the impression threshold in this range.</p>
        )}
      </ReportSection>
    );
  }

  return (
    <div className="space-y-5">
      <ReportSection title="Data used" description="Without dates, the latest stored Search Console data with query and page rows is used.">
        <RangeControls
          ranges={[{ value: range, onChange: setRange }]}
          busy={loading}
          onApply={() => run({ startDate: range.startDate, endDate: range.endDate, minImpressions: minParam })}
          onReset={() => run({ minImpressions: minParam })}
        >
          <Field label="Minimum impressions per page">
            <Input type="number" min={0} value={minImpressions} onChange={(event) => setMinImpressions(event.target.value)} />
          </Field>
        </RangeControls>
      </ReportSection>
      {body}
    </div>
  );
}

function CompetingPages({ row }: { row: QueryRow }) {
  const untracked = row.rankUrls.filter((url) => !row.pageUrls.includes(url));
  return (
    <div className="space-y-2 rounded-lg border border-border/60 bg-muted/30 p-3">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Page</TableHead>
            <TableHead>Clicks</TableHead>
            <TableHead>Impressions</TableHead>
            <TableHead>CTR</TableHead>
            <TableHead>Position</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {row.pages.map((page) => (
            <TableRow key={page.url}>
              <TableCell className="min-w-64 max-w-lg">
                <div className="flex flex-wrap items-center gap-2">
                  <InsightUrl url={page.url} />
                  {row.rankUrls.includes(page.url) ? (
                    <Hint tip="The URL your rank tracker saw ranking for this query.">
                      <Badge variant="good">Rank tracker URL</Badge>
                    </Hint>
                  ) : null}
                </div>
              </TableCell>
              <TableCell className="nums">{formatCount(page.clicks)}</TableCell>
              <TableCell className="nums">{formatCount(page.impressions)}</TableCell>
              <TableCell className="nums">{formatCtr(page.ctr)}</TableCell>
              <TableCell className="nums">{formatAvgPosition(page.position)}</TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
      {untracked.length ? (
        <p className="text-xs text-muted-foreground">
          Your rank tracker saw a different URL ranking: <span className="break-all">{untracked.join(", ")}</span>
        </p>
      ) : null}
    </div>
  );
}
