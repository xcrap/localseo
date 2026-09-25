import { useEffect, useMemo, useState, type ReactNode } from "react";
import { Link } from "react-router-dom";
import { api, type GscCrawlInsights, type GscCrawlSectionKey, type InsightRow, type ScanRow, type Site } from "../../../api";
import { Badge, Select, SelectContent, SelectItem, SelectTrigger, SelectValue, SortableTableHead, Table, TableBody, TableCell, TableHeader, TableRow } from "@/components/ui";
import { recentDateRange, type DateRange } from "../../date-picker";
import { FilteredRows, type CsvColumn } from "../../data-table";
import { Field, MetricTile, MetricTileGrid, ReportSection, formatDate, formatNumber, sortScanRows } from "../../shared";
import { InsightError, InsightSkeleton, InsightUnavailable, InsightUrl, RangeControls, formatAvgPosition, formatCount, formatCtr, formatRange, gscSourceLabel, hasValue, useInsightQuery } from "./common";

const LATEST_SCAN = "__latest";

type GscCrawlQuery = { scanId?: string; startDate?: string; endDate?: string };

const sections: { key: GscCrawlSectionKey; title: string; why: string }[] = [
  {
    key: "impressionsNotIndexable",
    title: "Impressions on non-indexable pages",
    why: "Pages Google shows in search that the crawl found non-indexable (noindex, canonicalised elsewhere, or error status). Either the page should be indexable or Google is surfacing a URL you meant to hide.",
  },
  {
    key: "indexableNoImpressions",
    title: "Indexable pages without impressions",
    why: "Indexable crawled pages with no Search Console impressions in the range: possible thin, orphaned, or undiscovered content.",
  },
  {
    key: "gscPagesNotCrawled",
    title: "Search Console pages the crawl missed",
    why: "URLs getting impressions that this crawl never reached: often orphaned, only linked externally, or beyond the crawl limit.",
  },
  {
    key: "gscPagesNotInSitemap",
    title: "Search Console pages missing from sitemaps",
    why: "Pages earning impressions that no XML sitemap lists. Listing them helps search engines recrawl and trust the canonical URL.",
  },
  {
    key: "ctrOutliers",
    title: "Low CTR for their position",
    why: "Pages whose CTR is well below this site's own median CTR for their position: title and description rewrite candidates.",
  },
];

function rowCrawled(row: InsightRow) {
  return hasValue(row.status) || typeof row.indexable === "boolean";
}

// The backend lists at most 500 rows per section (highest impressions first);
// `counts` carries the full total.
function sectionTotal(data: GscCrawlInsights, key: GscCrawlSectionKey, rows: InsightRow[]) {
  const count = Number(data.counts?.[key]);
  return Number.isFinite(count) && count >= rows.length ? count : rows.length;
}

export function GscCrawlTab({ site }: { site: Site }) {
  const { status, data, error, query, run, retry } = useInsightQuery<GscCrawlQuery, GscCrawlInsights>(
    site.id,
    (next) => api.gscCrawlInsights(site.id, next),
    {},
  );
  const [scans, setScans] = useState<ScanRow[]>([]);
  const [range, setRange] = useState<DateRange>(() => recentDateRange(28, 2));

  useEffect(() => {
    let cancelled = false;
    api
      .scans(site.id)
      .then((rows) => {
        if (!cancelled) setScans(sortScanRows(rows.filter((row) => row.status === "completed")));
      })
      .catch(() => {
        if (!cancelled) setScans([]);
      });
    return () => {
      cancelled = true;
    };
  }, [site.id]);

  // Without explicit dates the backend picks the stored range; show it in the pickers.
  useEffect(() => {
    if (!query.startDate && data?.gscRange?.startDate && data.gscRange.endDate) {
      setRange({ startDate: data.gscRange.startDate, endDate: data.gscRange.endDate });
    }
  }, [data]);

  const loading = status === "loading";
  const scanId = data?.scan?.id || "";
  const controls = (
    <ReportSection title="Data used" description="Pick a saved scan and a Search Console date range. Without dates, the latest stored Search Console data is used.">
      <RangeControls
        ranges={[{ value: range, onChange: setRange }]}
        busy={loading}
        onApply={() => run({ ...query, startDate: range.startDate, endDate: range.endDate })}
        onReset={() => run({ scanId: query.scanId })}
      >
        <Field label="Scan">
          <Select
            value={query.scanId || LATEST_SCAN}
            onValueChange={(value) => run({ ...query, scanId: value === LATEST_SCAN ? undefined : value })}
            disabled={loading}
          >
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={LATEST_SCAN}>Latest completed scan</SelectItem>
              {scans.map((scan) => (
                <SelectItem key={scan.id} value={scan.id}>
                  {formatDate(scan.created_at)} · {formatNumber(scan.pages_crawled)} pages
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </Field>
      </RangeControls>
      {data?.available ? (
        <p className="mt-4 flex flex-wrap items-center gap-x-2 gap-y-1 text-[13px] text-muted-foreground">
          <span>
            Scan{" "}
            {data.scan ? (
              <Link to={`/scans/${data.scan.id}`} className="text-primary underline-offset-4 hover:underline">
                {formatDate(data.scan.created_at)}
              </Link>
            ) : (
              "none"
            )}
          </span>
          <span className="text-border">·</span>
          <span>Search Console {formatRange(data.gscRange)}</span>
          {data.gscRange ? <Badge variant="outline">{gscSourceLabel(data.gscRange.source)}</Badge> : null}
          {loading ? <span>· Updating…</span> : null}
        </p>
      ) : null}
    </ReportSection>
  );

  let body: ReactNode;
  if (status === "error") body = <InsightError message={error} onRetry={retry} />;
  else if (!data) body = <InsightSkeleton />;
  else if (!data.available) body = <InsightUnavailable reason={data.reason} />;
  else {
    body = (
      <div className="space-y-5">
        <MetricTileGrid>
          {sections.map((section) => {
            const rows = data.sections?.[section.key];
            if (!Array.isArray(rows)) return <MetricTile key={section.key} label={section.title} value="-" hint="Not reported by the API" />;
            const total = sectionTotal(data, section.key, rows);
            return (
              <MetricTile
                key={section.key}
                label={section.title}
                value={formatNumber(total)}
                tone={total ? "warn" : "default"}
                hint={total > rows.length ? `Top ${formatNumber(rows.length)} listed below` : undefined}
              />
            );
          })}
        </MetricTileGrid>
        {sections.map((section) => {
          const rows = data.sections?.[section.key];
          return Array.isArray(rows) ? (
            <InsightSection key={section.key} title={section.title} why={section.why} rows={rows} total={sectionTotal(data, section.key, rows)} scanId={scanId} />
          ) : null;
        })}
        <CtrCurve rows={data.ctrCurve || []} />
      </div>
    );
  }

  return (
    <div className="space-y-5">
      {controls}
      {body}
    </div>
  );
}

function InsightSection({ title, why, rows, total, scanId }: { title: string; why: string; rows: InsightRow[]; total: number; scanId: string }) {
  // Columns follow the fields the backend sent: a section whose rows carry no
  // `indexable` field (CTR outliers, pages the crawl missed) shows no badge.
  const columns = useMemo(
    () => ({
      status: rows.some((row) => hasValue(row.status)),
      indexable: rows.some((row) => "indexable" in row),
      reason: rows.some((row) => Boolean(row.reason) && row.reason !== "indexable"),
      canonical: rows.some((row) => Boolean(row.canonical)),
      sitemap: rows.some((row) => typeof row.inSitemap === "boolean"),
      expectedCtr: rows.some((row) => hasValue(row.expectedCtr)),
    }),
    [rows],
  );
  const csvColumns = useMemo(() => {
    const list: CsvColumn<InsightRow>[] = [
      { label: "url", value: (row) => row.url },
      { label: "clicks", value: (row) => row.clicks },
      { label: "impressions", value: (row) => row.impressions },
      { label: "ctr", value: (row) => row.ctr },
      { label: "position", value: (row) => row.position },
    ];
    if (columns.expectedCtr) list.push({ label: "site_median_ctr_for_position", value: (row) => row.expectedCtr });
    if (columns.status) list.push({ label: "status", value: (row) => row.status });
    if (columns.indexable) list.push({ label: "indexable", value: (row) => row.indexable });
    if (columns.reason) list.push({ label: "reason", value: (row) => row.reason });
    if (columns.canonical) list.push({ label: "canonical", value: (row) => row.canonical });
    if (columns.sitemap) list.push({ label: "in_sitemap", value: (row) => row.inSitemap });
    return list;
  }, [columns]);

  return (
    <ReportSection title={title} meta={`${formatNumber(total)} ${total === 1 ? "page" : "pages"}`}>
      <p className="mb-3 text-[13px] leading-5 text-muted-foreground">{why}</p>
      {total > rows.length ? (
        <p className="mb-3 text-[13px] leading-5 text-muted-foreground">
          Showing the {formatNumber(rows.length)} pages with the most impressions out of {formatNumber(total)}. Filters and the CSV cover these {formatNumber(rows.length)} rows only.
        </p>
      ) : null}
      {rows.length ? (
        <FilteredRows rows={rows} placeholder="Filter URLs…" csvName={title} csvColumns={csvColumns}>
          {(visible) => (
            <Table>
              <TableHeader>
                <TableRow>
                  <SortableTableHead sortKey="url">URL</SortableTableHead>
                  <SortableTableHead sortKey="clicks">Clicks</SortableTableHead>
                  <SortableTableHead sortKey="impressions">Impressions</SortableTableHead>
                  <SortableTableHead sortKey="ctr">CTR</SortableTableHead>
                  {columns.expectedCtr ? <SortableTableHead sortKey="expectedCtr">Site median CTR</SortableTableHead> : null}
                  <SortableTableHead sortKey="position">Position</SortableTableHead>
                  {columns.status ? <SortableTableHead sortKey="status">Status</SortableTableHead> : null}
                  {columns.indexable ? <SortableTableHead sortKey="indexable">Indexable</SortableTableHead> : null}
                  {columns.reason ? <SortableTableHead sortKey="reason">Why</SortableTableHead> : null}
                  {columns.canonical ? <SortableTableHead sortKey="canonical">Canonical</SortableTableHead> : null}
                  {columns.sitemap ? <SortableTableHead sortKey="inSitemap">Sitemap</SortableTableHead> : null}
                </TableRow>
              </TableHeader>
              <TableBody>
                {visible.map((row, index) => (
                  <TableRow key={`${row.url}:${index}`}>
                    <TableCell className="min-w-64 max-w-md">
                      <InsightUrl url={row.url} scanId={scanId} crawled={rowCrawled(row)} />
                    </TableCell>
                    <TableCell className="nums">{formatCount(row.clicks)}</TableCell>
                    <TableCell className="nums">{formatCount(row.impressions)}</TableCell>
                    <TableCell className="nums">{formatCtr(row.ctr)}</TableCell>
                    {columns.expectedCtr ? <TableCell className="nums text-muted-foreground">{formatCtr(row.expectedCtr)}</TableCell> : null}
                    <TableCell className="nums">{formatAvgPosition(row.position)}</TableCell>
                    {columns.status ? (
                      <TableCell>
                        {hasValue(row.status) ? (
                          <Badge variant={Number(row.status) >= 400 ? "bad" : Number(row.status) >= 300 ? "warn" : "good"}>{row.status}</Badge>
                        ) : (
                          <span className="text-muted-foreground">-</span>
                        )}
                      </TableCell>
                    ) : null}
                    {columns.indexable ? (
                      <TableCell>
                        {typeof row.indexable === "boolean" ? (
                          <Badge variant={row.indexable ? "good" : "bad"}>{row.indexable ? "Yes" : "No"}</Badge>
                        ) : "indexable" in row ? (
                          <Badge variant="outline">Unknown</Badge>
                        ) : (
                          <span className="text-muted-foreground">-</span>
                        )}
                      </TableCell>
                    ) : null}
                    {columns.reason ? (
                      <TableCell className="min-w-56 max-w-sm break-words text-xs text-muted-foreground">
                        {row.reason && row.reason !== "indexable" ? row.reason : "-"}
                      </TableCell>
                    ) : null}
                    {columns.canonical ? <TableCell className="max-w-xs break-all text-xs text-muted-foreground">{row.canonical || "-"}</TableCell> : null}
                    {columns.sitemap ? (
                      <TableCell>
                        {typeof row.inSitemap === "boolean" ? (
                          <Badge variant={row.inSitemap ? "good" : "warn"}>{row.inSitemap ? "Listed" : "Not listed"}</Badge>
                        ) : (
                          <span className="text-muted-foreground">-</span>
                        )}
                      </TableCell>
                    ) : null}
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </FilteredRows>
      ) : (
        <p className="text-sm text-muted-foreground">No pages in this group for the selected scan and range.</p>
      )}
    </ReportSection>
  );
}

function CtrCurve({ rows }: { rows: GscCrawlInsights["ctrCurve"] }) {
  const maxCtr = Math.max(0, ...rows.map((row) => (hasValue(row.medianCtr) ? Number(row.medianCtr) : 0)));
  return (
    <ReportSection title="CTR by position" meta={`${formatNumber(rows.length)} positions`}>
      <p className="mb-3 text-[13px] leading-5 text-muted-foreground">
        This site's own median CTR by position (from your Search Console data), not an industry benchmark. The low-CTR list above compares each page to these medians.
      </p>
      {rows.length ? (
        <Table>
          <TableHeader>
            <TableRow>
              <SortableTableHead sortKey="position" className="w-24">Position</SortableTableHead>
              <SortableTableHead sortKey="medianCtr">Median CTR</SortableTableHead>
              <SortableTableHead sortKey="pages" className="w-28">Pages</SortableTableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((row) => {
              const known = hasValue(row.medianCtr);
              const width = known && maxCtr > 0 ? (Number(row.medianCtr) / maxCtr) * 100 : 0;
              return (
                <TableRow key={row.position}>
                  <TableCell className="nums font-medium">{formatNumber(row.position)}</TableCell>
                  <TableCell>
                    <div className="flex items-center gap-3">
                      <div className="h-2 min-w-24 flex-1 overflow-hidden rounded-full bg-muted" aria-hidden>
                        {known ? <div className="h-full rounded-full bg-primary" style={{ width: `${Math.max(2, width)}%` }} /> : null}
                      </div>
                      <span className="nums w-14 shrink-0 text-right text-sm">{formatCtr(row.medianCtr)}</span>
                    </div>
                  </TableCell>
                  <TableCell className="nums text-muted-foreground">{formatCount(row.pages)}</TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      ) : (
        <p className="text-sm text-muted-foreground">No positions with enough Search Console rows to compute a median.</p>
      )}
    </ReportSection>
  );
}
