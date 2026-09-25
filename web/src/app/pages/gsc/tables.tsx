import { LoaderCircle, TableProperties } from "lucide-react";
import type { GscBatch, GscLegacyRow } from "../../../api";
import { Badge, Button, Checkbox, SortableTableHead, Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui";
import { StatsBand, formatDate, formatNumber } from "../../shared";
import { cn } from "@/lib/utils";

const gscDimensionLabels: Record<string, string> = {
  query: "Query",
  page: "Page",
  country: "Country",
  device: "Device",
  date: "Date",
  searchAppearance: "Search appearance",
};

export function gscDimensionLabel(dimension: string) {
  return gscDimensionLabels[dimension] || dimension || "Key";
}

// Dimensions stored as columns for every saved batch (CSV imports and API syncs).
export const storedGscDimensions = ["query", "page", "country", "device", "date"] as const;
export type StoredGscDimension = (typeof storedGscDimensions)[number];

function metricNumber(value: unknown) {
  if (value === null || value === undefined || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

// CTR is a 0–1 fraction. Missing values stay "-" instead of reading as 0%.
export function formatGscCtr(value: unknown) {
  const number = metricNumber(value);
  return number === null ? "-" : `${(number * 100).toFixed(1)}%`;
}

export function formatGscPosition(value: unknown) {
  const number = metricNumber(value);
  return number === null || number <= 0 ? "-" : number.toFixed(1);
}

export function gscSourceLabel(source?: string) {
  if (source === "api") return "Search Console API";
  if (source === "csv") return "CSV import";
  return source || "Unknown source";
}

export function gscWindowLabel(batch: Pick<GscBatch, "startDate" | "endDate">) {
  if (batch.startDate && batch.endDate) return `${formatDate(batch.startDate)} – ${formatDate(batch.endDate)}`;
  return "Not stated";
}

export function gscBatchLabel(batch: GscBatch) {
  return `${batch.sourceName || gscSourceLabel(batch.source)} · ${formatDate(batch.createdAt)}`;
}

export function DimensionCheckboxes({
  value,
  onChange,
  idPrefix,
}: {
  value: string[];
  onChange: (value: string[]) => void;
  idPrefix: string;
}) {
  return (
    <fieldset className="space-y-2">
      <legend className="text-sm font-medium">Dimensions</legend>
      <div className="flex flex-wrap gap-x-4 gap-y-2">
        {storedGscDimensions.map((dimension) => {
          const checked = value.includes(dimension);
          const id = `${idPrefix}-${dimension}`;
          return (
            <label key={dimension} htmlFor={id} className="inline-flex items-center gap-2 text-sm">
              <Checkbox
                id={id}
                checked={checked}
                // At least one dimension stays selected.
                disabled={checked && value.length === 1}
                onCheckedChange={(next) =>
                  onChange(
                    next === true
                      ? storedGscDimensions.filter((item) => item === dimension || value.includes(item))
                      : value.filter((item) => item !== dimension),
                  )
                }
              />
              {gscDimensionLabel(dimension)}
            </label>
          );
        })}
      </div>
    </fieldset>
  );
}

export function GscImportHistory({
  rows,
  openId,
  loadingId,
  onOpen,
  onBrowse,
}: {
  rows: GscBatch[];
  openId?: string;
  loadingId?: string;
  onOpen: (row: GscBatch) => void;
  onBrowse: (row: GscBatch) => void;
}) {
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>Batch</TableHead>
          <TableHead>Source</TableHead>
          <TableHead>Dates covered</TableHead>
          <TableHead>Dimensions</TableHead>
          <TableHead>Rows</TableHead>
          <TableHead>Clicks</TableHead>
          <TableHead>Impressions</TableHead>
          <TableHead>Saved</TableHead>
          <TableHead><span className="sr-only">Actions</span></TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {rows.map((row) => (
          <TableRow key={row.id} className={cn("cursor-pointer", openId === row.id ? "bg-accent/45" : "")} onClick={() => onOpen(row)}>
            <TableCell className="min-w-48 font-medium">
              <button
                type="button"
                className="inline-flex items-center gap-1.5 rounded-sm text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/60"
                onClick={(event) => {
                  event.stopPropagation();
                  onOpen(row);
                }}
              >
                {loadingId === row.id ? <LoaderCircle aria-hidden className="size-3.5 animate-spin motion-reduce:animate-none" /> : null}
                {row.sourceName || "Search Console rows"}
              </button>
              <div className="mt-0.5 break-all text-xs text-muted-foreground">{row.siteUrl || "No property label"}</div>
            </TableCell>
            <TableCell>
              <Badge variant={row.source === "api" ? "good" : "outline"}>{gscSourceLabel(row.source)}</Badge>
            </TableCell>
            <TableCell className="whitespace-nowrap text-muted-foreground">{gscWindowLabel(row)}</TableCell>
            <TableCell className="text-muted-foreground">{row.dimensions?.length ? row.dimensions.map(gscDimensionLabel).join(", ") : "-"}</TableCell>
            <TableCell className="nums">{formatNumber(row.rowCount)}</TableCell>
            <TableCell className="nums">{formatNumber(row.totals?.clicks)}</TableCell>
            <TableCell className="nums">{formatNumber(row.totals?.impressions)}</TableCell>
            <TableCell className="whitespace-nowrap text-muted-foreground">{formatDate(row.createdAt)}</TableCell>
            <TableCell>
              <Button
                type="button"
                size="sm"
                variant="ghost"
                className="h-7 text-xs text-muted-foreground hover:text-foreground"
                onClick={(event) => {
                  event.stopPropagation();
                  onBrowse(row);
                }}
              >
                <TableProperties /> Paged rows
              </Button>
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}

// Totals over the rows on screen. A metric no row carries stays unavailable
// instead of summing to zero.
export function GscPerformanceSummary({ rows }: { rows: GscLegacyRow[] }) {
  let clicks: number | null = null;
  let impressions: number | null = null;
  let weightedPosition = 0;
  let weightedImpressions = 0;
  for (const row of rows) {
    const rowClicks = metricNumber(row.clicks);
    const rowImpressions = metricNumber(row.impressions);
    const rowPosition = metricNumber(row.position);
    if (rowClicks !== null) clicks = (clicks ?? 0) + rowClicks;
    if (rowImpressions !== null) impressions = (impressions ?? 0) + rowImpressions;
    if (rowPosition !== null && rowImpressions) {
      weightedPosition += rowPosition * rowImpressions;
      weightedImpressions += rowImpressions;
    }
  }
  const ctr = clicks !== null && impressions ? clicks / impressions : null;
  const position = weightedImpressions ? weightedPosition / weightedImpressions : null;
  return (
    <StatsBand
      items={[
        { title: "Clicks", value: clicks },
        { title: "Impressions", value: impressions },
        { title: "CTR %", value: ctr === null ? null : Number((ctr * 100).toFixed(1)), detail: "Clicks divided by impressions across these rows." },
        { title: "Avg. position", value: position === null ? null : Number(position.toFixed(1)), detail: "Impression-weighted average position." },
      ]}
    />
  );
}

export const gscSortValues: Record<string, (row: GscLegacyRow) => unknown> = {
  key: (row) => row.keys?.join(" / ") || "",
};

export function GscPerformanceTable({ rows, dimensions }: { rows: GscLegacyRow[]; dimensions: string[] }) {
  const label = dimensions.length ? dimensions.map(gscDimensionLabel).join(" / ") : "Key";
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <SortableTableHead sortKey="key">{label}</SortableTableHead>
          <SortableTableHead sortKey="clicks">Clicks</SortableTableHead>
          <SortableTableHead sortKey="impressions">Impressions</SortableTableHead>
          <SortableTableHead sortKey="ctr">CTR</SortableTableHead>
          <SortableTableHead sortKey="position">Position</SortableTableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {rows.map((row, index) => (
          <TableRow key={`${row.keys?.join(":") || index}:${index}`}>
            <TableCell className="max-w-xl break-all font-medium">{row.keys?.join(" / ") || "-"}</TableCell>
            <TableCell className="nums">{formatNumber(row.clicks)}</TableCell>
            <TableCell className="nums">{formatNumber(row.impressions)}</TableCell>
            <TableCell className="nums">{formatGscCtr(row.ctr)}</TableCell>
            <TableCell className="nums">{formatGscPosition(row.position)}</TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}

function gscVerdictTone(value?: string) {
  if (/pass|indexed|verdict_pass/i.test(value || "")) return "good";
  if (/partial|neutral|unspecified/i.test(value || "")) return "warn";
  return value ? "bad" : "outline";
}

export function GscInspectionResults({ rows }: { rows: any[] }) {
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>URL</TableHead>
          <TableHead>Verdict</TableHead>
          <TableHead>Coverage</TableHead>
          <TableHead>Indexing</TableHead>
          <TableHead>Fetch</TableHead>
          <TableHead>Robots</TableHead>
          <TableHead>Canonical evidence</TableHead>
          <TableHead>Rich results</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {rows.map((row) => {
          const index = row.result?.indexStatusResult || {};
          const rich = row.result?.richResultsResult || {};
          return (
            <TableRow key={row.inspectionUrl}>
              <TableCell className="max-w-sm break-all font-medium">
                <div>{row.inspectionUrl}</div>
                <div className="mt-1 text-xs text-muted-foreground">{index.lastCrawlTime ? `Last crawl ${formatDate(index.lastCrawlTime)}` : "Last crawl unavailable"}</div>
              </TableCell>
              <TableCell>
                <Badge variant={gscVerdictTone(index.verdict || row.error) as any}>{row.error ? "Error" : index.verdict || "Unknown"}</Badge>
              </TableCell>
              <TableCell className={cn("max-w-xs text-sm", row.error ? "text-destructive" : "text-muted-foreground")}>
                {row.error || index.coverageState || "Coverage state unavailable"}
              </TableCell>
              <TableCell className="text-muted-foreground">{index.indexingState || "-"}</TableCell>
              <TableCell className="text-muted-foreground">{index.pageFetchState || "-"}</TableCell>
              <TableCell className="text-muted-foreground">{index.robotsTxtState || "-"}</TableCell>
              <TableCell className="max-w-sm text-sm text-muted-foreground">
                <div className="break-all">Google: {index.googleCanonical || "-"}</div>
                <div className="mt-1 break-all">User: {index.userCanonical || "-"}</div>
              </TableCell>
              <TableCell className="text-muted-foreground">{rich.verdict || "-"}</TableCell>
            </TableRow>
          );
        })}
      </TableBody>
    </Table>
  );
}
