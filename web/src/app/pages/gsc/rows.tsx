import { useEffect, useMemo, useRef, useState } from "react";
import { RefreshCw, Upload } from "lucide-react";
import { api, type GscBatch, type GscRowsPage, type GscStoredRow } from "../../../api";
import { Badge, Button, Select, SelectContent, SelectItem, SelectTrigger, SelectValue, SortableTableHead, Table, TableBody, TableCell, TableHeader, TableRow } from "@/components/ui";
import { EmptyState, Field, ReportSection, formatDate, formatNumber } from "../../shared";
import { ServerPagedRows, type CsvColumn } from "../../data-table";
import { DateRangeFields, recentDateRange, type DateRange } from "../../date-picker";
import {
  DimensionCheckboxes,
  formatGscCtr,
  formatGscPosition,
  gscBatchLabel,
  gscDimensionLabel,
  gscSourceLabel,
  gscWindowLabel,
  storedGscDimensions,
  type StoredGscDimension,
} from "./tables";

// Batch picker value meaning "the newest batch with these dimensions and dates".
export const MATCH_BATCH = "__match";
const pageSizes = [100, 500];

function batchColumns(batch: GscBatch | null, fallback: string[]): StoredGscDimension[] {
  const dimensions = batch?.dimensions?.length ? batch.dimensions : fallback;
  return storedGscDimensions.filter((dimension) => dimensions.includes(dimension));
}

// Stored Search Console rows (CSV imports and API syncs), paged by the API so
// large syncs never load in one response.
export function GscStoredRows({
  siteId,
  imports,
  selection: requestedSelection,
  onSelectionChange,
  onOpenSync,
  onOpenImport,
}: {
  siteId: string;
  imports: GscBatch[];
  /** A batch id, MATCH_BATCH, or "" for the newest batch. */
  selection: string;
  onSelectionChange: (value: string) => void;
  onOpenSync: () => void;
  onOpenImport: () => void;
}) {
  const selection = requestedSelection || imports[0]?.id || MATCH_BATCH;
  const matching = selection === MATCH_BATCH;
  const [dimensions, setDimensions] = useState<string[]>(["query"]);
  const [range, setRange] = useState<DateRange>(() => recentDateRange(28, 2));
  const [pageSize, setPageSize] = useState(pageSizes[0]);
  const [offset, setOffset] = useState(0);
  const [data, setData] = useState<GscRowsPage | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [attempt, setAttempt] = useState(0);
  const tokenRef = useRef(0);
  const queryKey = matching ? `${MATCH_BATCH}:${dimensions.join(",")}:${range.startDate}:${range.endDate}` : selection;

  useEffect(() => {
    setOffset(0);
  }, [queryKey, pageSize]);

  useEffect(() => {
    const token = ++tokenRef.current;
    setLoading(true);
    setError("");
    api
      .gscRows(
        siteId,
        matching
          ? { dimensions, startDate: range.startDate, endDate: range.endDate, limit: pageSize, offset }
          : { importId: selection, limit: pageSize, offset },
      )
      .then((next) => {
        if (token === tokenRef.current) setData(next);
      })
      .catch((err) => {
        if (token !== tokenRef.current) return;
        setData(null);
        setError(err instanceof Error ? err.message : "Could not load stored Search Console rows");
      })
      .finally(() => {
        if (token === tokenRef.current) setLoading(false);
      });
  }, [siteId, queryKey, pageSize, offset, attempt]);

  const batch = data?.batch || null;
  const columns = batchColumns(batch, dimensions);
  const csvColumns = useMemo<CsvColumn<GscStoredRow>[]>(
    () => [
      ...columns.map((dimension) => ({ label: dimension, value: (row: GscStoredRow) => row[dimension] })),
      { label: "clicks", value: (row) => row.clicks },
      { label: "impressions", value: (row) => row.impressions },
      { label: "ctr", value: (row) => row.ctr },
      { label: "position", value: (row) => row.position },
    ],
    [columns.join(",")],
  );

  return (
    <ReportSection
      title="Stored rows"
      description="Every row saved from CSV imports and Google syncs, read from local SQLite one page at a time."
      meta={batch ? `${gscSourceLabel(batch.source)} · ${gscWindowLabel(batch)}` : undefined}
    >
      <div className="mb-5 space-y-4">
        <div className="grid gap-3 md:grid-cols-[minmax(0,1fr)_160px]">
          <Field label="Batch">
            <Select value={selection} onValueChange={onSelectionChange}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {imports.map((row) => (
                  <SelectItem key={row.id} value={row.id}>
                    {gscBatchLabel(row)}
                  </SelectItem>
                ))}
                <SelectItem value={MATCH_BATCH}>Newest batch matching dimensions and dates…</SelectItem>
              </SelectContent>
            </Select>
          </Field>
          <Field label="Rows per page">
            <Select value={String(pageSize)} onValueChange={(value) => setPageSize(Number(value))}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {pageSizes.map((size) => (
                  <SelectItem key={size} value={String(size)}>
                    {size}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>
        </div>
        {matching ? (
          <div className="space-y-3 rounded-xl bg-muted/40 p-4">
            <DimensionCheckboxes value={dimensions} onChange={setDimensions} idPrefix="gsc-rows-dimension" />
            <div className="grid gap-3 sm:grid-cols-2">
              <DateRangeFields value={range} onChange={setRange} />
            </div>
            <p className="text-xs leading-5 text-muted-foreground">
              Picks the newest saved batch with exactly these dimensions whose dates match this range. Batches that include the date dimension also match when they cover the range, and only rows inside it are shown.
            </p>
          </div>
        ) : null}
        {batch ? (
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 text-[13px] text-muted-foreground">
            <Badge variant={batch.source === "api" ? "good" : "outline"}>{gscSourceLabel(batch.source)}</Badge>
            <span className="break-all">{batch.siteUrl || "No property label"}</span>
            <span>· saved {formatDate(batch.createdAt)}</span>
            <span>
              · batch totals {formatNumber(batch.totals?.clicks)} clicks · {formatNumber(batch.totals?.impressions)} impressions · CTR {formatGscCtr(batch.totals?.ctr)} · avg. position {formatGscPosition(batch.totals?.position)}
            </span>
          </div>
        ) : null}
      </div>
      {error ? (
        <EmptyState
          title="Could not load stored rows"
          text={error}
          action={
            <Button variant="secondary" onClick={() => setAttempt((value) => value + 1)}>
              <RefreshCw /> Retry
            </Button>
          }
        />
      ) : data && !batch ? (
        <EmptyState
          title="No stored batch matches"
          text={
            imports.length
              ? "No saved import or sync has these dimensions for these dates. Pick a batch above, or sync this range from Google."
              : "Nothing is stored yet. Sync a date range from Google or import a Search Console CSV export."
          }
          action={
            <>
              <Button onClick={onOpenSync}>
                <RefreshCw /> Sync from Google
              </Button>
              <Button variant="secondary" onClick={onOpenImport}>
                <Upload /> Import CSV
              </Button>
            </>
          }
        />
      ) : data ? (
        data.rows.length ? (
          <ServerPagedRows
            rows={data.rows}
            total={data.total}
            offset={data.offset}
            limit={data.limit}
            loading={loading}
            onOffsetChange={setOffset}
            csvName={`search-console-${columns.join("-") || "rows"}`}
            csvColumns={csvColumns}
            orderNote="Sorted by clicks on the server"
          >
            {(rows) => <GscStoredRowsTable rows={rows} columns={columns} />}
          </ServerPagedRows>
        ) : (
          <EmptyState title="No rows in this range" text="The batch exists but has no rows for the selected dates." />
        )
      ) : (
        <p className="text-sm text-muted-foreground" role="status">
          Loading stored rows…
        </p>
      )}
    </ReportSection>
  );
}

function GscStoredRowsTable({ rows, columns }: { rows: GscStoredRow[]; columns: StoredGscDimension[] }) {
  return (
    <Table>
      <TableHeader>
        <TableRow>
          {columns.map((dimension) => (
            <SortableTableHead key={dimension} sortKey={dimension}>
              {gscDimensionLabel(dimension)}
            </SortableTableHead>
          ))}
          <SortableTableHead sortKey="clicks">Clicks</SortableTableHead>
          <SortableTableHead sortKey="impressions">Impressions</SortableTableHead>
          <SortableTableHead sortKey="ctr">CTR</SortableTableHead>
          <SortableTableHead sortKey="position">Position</SortableTableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {rows.map((row, index) => (
          <TableRow key={`${columns.map((dimension) => row[dimension]).join(":")}:${index}`}>
            {columns.map((dimension) => (
              <TableCell
                key={dimension}
                className={dimension === "query" || dimension === "page" ? "max-w-md break-all font-medium" : "whitespace-nowrap text-muted-foreground"}
              >
                {dimension === "date" && row.date ? formatDate(row.date) : row[dimension] || "-"}
              </TableCell>
            ))}
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
