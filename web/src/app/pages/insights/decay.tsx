import { useEffect, useState, type ReactNode } from "react";
import { api, type DecayInsights, type Site } from "../../../api";
import { Badge, SortableTableHead, Table, TableBody, TableCell, TableHeader, TableRow } from "@/components/ui";
import { recentDateRange, type DateRange } from "../../date-picker";
import { FilteredRows, type CsvColumn } from "../../data-table";
import { ReportSection, formatDateInput, formatNumber } from "../../shared";
import { InsightError, InsightSkeleton, InsightUnavailable, InsightUrl, RangeControls, formatAvgPosition, formatCount, formatRange, hasValue, useInsightQuery } from "./common";

type DecayQuery = { currentStart?: string; currentEnd?: string; previousStart?: string; previousEnd?: string };
type DecayRow = DecayInsights["rows"][number];
type ScanChange = DecayRow["scanChanges"][number];

function previousRangeBefore(range: DateRange): DateRange {
  const start = new Date(`${range.startDate}T00:00:00`);
  const end = new Date(`${range.endDate}T00:00:00`);
  const days = Math.max(1, Math.round((end.getTime() - start.getTime()) / 86_400_000) + 1);
  const previousEnd = new Date(start);
  previousEnd.setDate(previousEnd.getDate() - 1);
  const previousStart = new Date(previousEnd);
  previousStart.setDate(previousStart.getDate() - (days - 1));
  return { startDate: formatDateInput(previousStart), endDate: formatDateInput(previousEnd) };
}

function changeText(value: unknown) {
  if (value == null || value === "") return "empty";
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

function fieldLabel(field: string) {
  const spaced = String(field || "field").replace(/([a-z])([A-Z])/g, "$1 $2").replaceAll("-", " ").replaceAll("_", " ");
  return spaced.charAt(0).toUpperCase() + spaced.slice(1).toLowerCase();
}

const decayCsvColumns: CsvColumn<DecayRow>[] = [
  { label: "url", value: (row) => row.url },
  { label: "previous_clicks", value: (row) => row.previous?.clicks },
  { label: "current_clicks", value: (row) => row.current?.clicks },
  { label: "delta_clicks", value: (row) => row.deltaClicks },
  { label: "previous_impressions", value: (row) => row.previous?.impressions },
  { label: "current_impressions", value: (row) => row.current?.impressions },
  { label: "delta_impressions", value: (row) => row.deltaImpressions },
  { label: "previous_position", value: (row) => row.previous?.position },
  { label: "current_position", value: (row) => row.current?.position },
  { label: "delta_position", value: (row) => row.deltaPosition },
  { label: "crawl_changes", value: (row) => (row.scanChanges || []).map((change) => `${change.field}: ${changeText(change.before)} -> ${changeText(change.after)}`) },
];

const decaySortValues: Record<string, (row: DecayRow) => unknown> = {
  scanChanges: (row) => row.scanChanges?.length || 0,
};

export function DecayTab({ site }: { site: Site }) {
  const { status, data, error, query, run, retry } = useInsightQuery<DecayQuery, DecayInsights>(
    site.id,
    (next) => api.decayInsights(site.id, next),
    {},
  );
  const [current, setCurrent] = useState<DateRange>(() => recentDateRange(28, 2));
  const [previous, setPrevious] = useState<DateRange>(() => previousRangeBefore(recentDateRange(28, 2)));

  useEffect(() => {
    if (query.currentStart) return;
    if (data?.current?.startDate && data.current.endDate) setCurrent({ startDate: data.current.startDate, endDate: data.current.endDate });
    if (data?.previous?.startDate && data.previous.endDate) setPrevious({ startDate: data.previous.startDate, endDate: data.previous.endDate });
  }, [data]);

  const loading = status === "loading";
  const rows = data?.rows || [];

  let body: ReactNode;
  if (status === "error") body = <InsightError message={error} onRetry={retry} />;
  else if (!data) body = <InsightSkeleton />;
  else if (!data.available) body = <InsightUnavailable reason={data.reason} />;
  else {
    body = (
      <ReportSection
        title="Clicks and impressions by page, period over period"
        description="Position delta is current minus previous: a positive number means the page moved down (worse)."
        meta={`${formatNumber(rows.length)} ${rows.length === 1 ? "page" : "pages"} · ${formatRange(data.current)} vs ${formatRange(data.previous)}${loading ? " · updating…" : ""}`}
      >
        <p className="mb-3 text-[13px] leading-5 text-muted-foreground">
          Search Console clicks, impressions, and average position for each page in both periods, with the crawl changes saved between scans in these periods.
        </p>
        {rows.length ? (
          <FilteredRows rows={rows} placeholder="Filter pages…" csvName="content-decay" csvColumns={decayCsvColumns} sortValues={decaySortValues}>
            {(visible) => (
              <Table>
                <TableHeader>
                  <TableRow>
                    <SortableTableHead sortKey="url">Page</SortableTableHead>
                    <SortableTableHead sortKey="deltaClicks">Clicks</SortableTableHead>
                    <SortableTableHead sortKey="deltaImpressions">Impressions</SortableTableHead>
                    <SortableTableHead sortKey="deltaPosition">Position</SortableTableHead>
                    <SortableTableHead sortKey="scanChanges">Crawl changes between scans</SortableTableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {visible.map((row, index) => (
                    <TableRow key={`${row.url}:${index}`}>
                      <TableCell className="min-w-64 max-w-md">
                        <InsightUrl url={row.url} />
                      </TableCell>
                      <TableCell>
                        <PeriodCompare previous={formatCount(row.previous?.clicks)} current={formatCount(row.current?.clicks)} />
                        <Delta value={row.deltaClicks} higherIsBetter format={(value) => formatNumber(value)} />
                      </TableCell>
                      <TableCell>
                        <PeriodCompare previous={formatCount(row.previous?.impressions)} current={formatCount(row.current?.impressions)} />
                        <Delta value={row.deltaImpressions} higherIsBetter format={(value) => formatNumber(value)} />
                      </TableCell>
                      <TableCell>
                        <PeriodCompare previous={formatAvgPosition(row.previous?.position)} current={formatAvgPosition(row.current?.position)} />
                        <Delta value={row.deltaPosition} higherIsBetter={false} format={(value) => value.toFixed(1)} />
                      </TableCell>
                      <TableCell className="min-w-56 max-w-sm">
                        <ScanChanges changes={row.scanChanges || []} />
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
          </FilteredRows>
        ) : (
          <p className="text-sm text-muted-foreground">No pages with Search Console rows to compare between these periods.</p>
        )}
      </ReportSection>
    );
  }

  return (
    <div className="space-y-5">
      <ReportSection title="Periods compared" description="Without dates, the backend compares the latest stored Search Console period with the one before it.">
        <RangeControls
          ranges={[
            { value: current, onChange: setCurrent, startLabel: "Current period start", endLabel: "Current period end" },
            { value: previous, onChange: setPrevious, startLabel: "Previous period start", endLabel: "Previous period end" },
          ]}
          busy={loading}
          onApply={() =>
            run({
              currentStart: current.startDate,
              currentEnd: current.endDate,
              previousStart: previous.startDate,
              previousEnd: previous.endDate,
            })
          }
          onReset={() => run({})}
        />
      </ReportSection>
      {body}
    </div>
  );
}

function PeriodCompare({ previous, current }: { previous: string; current: string }) {
  return (
    <div className="nums whitespace-nowrap text-sm">
      <span className="text-muted-foreground">{previous}</span>
      <span aria-hidden className="px-1 text-muted-foreground">→</span>
      <span className="sr-only"> to </span>
      <span className="font-medium">{current}</span>
    </div>
  );
}

// Signed change with a word, so the direction never depends on color alone.
function Delta({ value, higherIsBetter, format }: { value: number | null; higherIsBetter: boolean; format: (value: number) => string }) {
  if (!hasValue(value)) return <div className="mt-1 text-xs text-muted-foreground">change -</div>;
  const number = Number(value);
  if (number === 0) {
    return (
      <Badge variant="outline" className="mt-1">
        no change
      </Badge>
    );
  }
  const improved = higherIsBetter ? number > 0 : number < 0;
  const word = higherIsBetter ? (number > 0 ? "gain" : "loss") : number > 0 ? "worse" : "better";
  return (
    <Badge variant={improved ? "good" : "bad"} className="nums mt-1">
      {number > 0 ? "+" : "−"}
      {format(Math.abs(number))} {word}
    </Badge>
  );
}

function ScanChanges({ changes }: { changes: ScanChange[] }) {
  if (!changes.length) return <span className="text-muted-foreground">-</span>;
  return (
    <details className="group text-xs">
      <summary className="cursor-pointer list-none rounded-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/60">
        <span className="flex flex-wrap gap-1">
          {changes.map((change, index) => (
            <Badge key={`${change.field}:${index}`} variant="warn">
              {fieldLabel(change.field)} changed
            </Badge>
          ))}
        </span>
        <span className="mt-1 block text-muted-foreground group-open:hidden">Show before → after</span>
      </summary>
      <ul className="mt-2 space-y-1.5">
        {changes.map((change, index) => (
          <li key={`${change.field}:${index}`} className="rounded-md border border-border/60 px-2 py-1.5">
            <div className="font-medium">{fieldLabel(change.field)}</div>
            <div className="break-words text-muted-foreground">Before: {changeText(change.before)}</div>
            <div className="break-words">After: {changeText(change.after)}</div>
          </li>
        ))}
      </ul>
    </details>
  );
}
