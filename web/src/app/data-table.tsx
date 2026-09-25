import { useDeferredValue, useMemo, useState, type ReactNode } from "react";
import { ChevronLeft, ChevronRight, Download } from "lucide-react";
import { Button, Input, TableSortContext, type TableSortDirection } from "@/components/ui";
import { EmptyState, downloadFile, fileSlug, formatNumber } from "./shared";

export type CsvColumn<T> = { label: string; value: (row: T) => unknown };

type SortState = { key: string; direction: TableSortDirection } | null;

const DEFAULT_PAGE_SIZE = 150;

// The filter input carries this attribute so the global "/" shortcut can find
// and focus the table filter on the current screen.
export const tableFilterSelector = "[data-table-filter]";

export function readPath(row: unknown, path: string): unknown {
  let value: any = row;
  for (const part of path.split(".")) {
    if (value == null) return undefined;
    value = value[part];
  }
  return value;
}

// Only values are searched — never keys — so typing "url" does not match every
// row. Top-level strings/numbers plus arrays of them (e.g. source pages) count.
function rowSearchText(row: unknown) {
  if (row == null) return "";
  if (typeof row !== "object") return String(row).toLowerCase();
  const parts: string[] = [];
  for (const value of Object.values(row as Record<string, unknown>)) {
    if (typeof value === "string" || typeof value === "number") parts.push(String(value));
    else if (Array.isArray(value)) {
      for (const item of value) {
        if (typeof item === "string" || typeof item === "number") parts.push(String(item));
      }
    }
  }
  return parts.join("\n").toLowerCase();
}

function sortableValue(value: unknown): string | number | null {
  if (value == null || value === "") return null;
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "boolean") return value ? 1 : 0;
  if (Array.isArray(value)) return value.length;
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed && Number.isFinite(Number(trimmed)) ? Number(trimmed) : trimmed.toLowerCase();
  }
  return String(value);
}

const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });

function compareSortable(a: string | number | null, b: string | number | null, direction: TableSortDirection) {
  // Missing values always sink to the bottom, whatever the direction.
  if (a === null && b === null) return 0;
  if (a === null) return 1;
  if (b === null) return -1;
  const result = typeof a === "number" && typeof b === "number" ? a - b : collator.compare(String(a), String(b));
  return direction === "asc" ? result : -result;
}

function csvCell(value: unknown) {
  if (value == null) return "";
  let text: string;
  if (Array.isArray(value)) {
    text = value.map((item) => (item !== null && typeof item === "object" ? JSON.stringify(item) : String(item ?? ""))).join(" | ");
  } else if (typeof value === "object") {
    text = JSON.stringify(value);
  } else {
    text = String(value);
  }
  // Keep spreadsheet apps from evaluating crawled text as a formula.
  if (typeof value === "string" && /^[=+@\t\r]/.test(text)) text = `'${text}`;
  if (typeof value === "string" && /^-/.test(text) && !Number.isFinite(Number(text))) text = `'${text}`;
  return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

export function rowsToCsv<T>(rows: T[], columns?: CsvColumn<T>[]) {
  const resolved: CsvColumn<T>[] = columns?.length
    ? columns
    : (() => {
        const keys: string[] = [];
        const seen = new Set<string>();
        for (const row of rows) {
          if (!row || typeof row !== "object") continue;
          for (const key of Object.keys(row)) {
            if (!seen.has(key)) {
              seen.add(key);
              keys.push(key);
            }
          }
        }
        return keys.map((key) => ({ label: key, value: (row: T) => (row as any)?.[key] }));
      })();
  const lines = [resolved.map((column) => csvCell(column.label)).join(",")];
  for (const row of rows) {
    lines.push(resolved.map((column) => csvCell(column.value(row))).join(","));
  }
  return `﻿${lines.join("\r\n")}\r\n`;
}

// Column sort shared by the client-side and server-paged tables. Clicking a
// header cycles ascending → descending → original order.
function useRowSort<T>(rows: T[], sortValues: Record<string, (row: T) => unknown> | undefined, onSortChange?: () => void) {
  const [sort, setSort] = useState<SortState>(null);
  const sorted = useMemo(() => {
    if (!sort) return rows;
    const accessor = sortValues?.[sort.key] || ((row: T) => readPath(row, sort.key));
    return rows
      .map((row, index) => ({ row, index, value: sortableValue(accessor(row)) }))
      .sort((a, b) => compareSortable(a.value, b.value, sort.direction) || a.index - b.index)
      .map((entry) => entry.row);
  }, [rows, sort, sortValues]);
  const sortContext = useMemo(
    () => ({
      sortKey: sort?.key || "",
      direction: sort?.direction || ("asc" as TableSortDirection),
      toggleSort: (key: string) => {
        onSortChange?.();
        setSort((current) => {
          if (!current || current.key !== key) return { key, direction: "asc" };
          if (current.direction === "asc") return { key, direction: "desc" };
          return null;
        });
      },
    }),
    [sort],
  );
  return { sorted, sortContext };
}

function PagerControls({
  start,
  shown,
  total,
  page,
  pageCount,
  disabled,
  onPage,
}: {
  start: number;
  shown: number;
  total: number;
  page: number;
  pageCount: number;
  disabled?: boolean;
  onPage: (page: number) => void;
}) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-2 text-[13px] text-muted-foreground">
      <span className="nums">
        Rows {formatNumber(shown ? start + 1 : 0)}–{formatNumber(start + shown)} of {formatNumber(total)}
      </span>
      <div className="flex items-center gap-1.5">
        <Button
          type="button"
          size="sm"
          variant="outline"
          disabled={disabled || page <= 1}
          onClick={() => onPage(page - 1)}
          aria-label="Previous page of rows"
        >
          <ChevronLeft /> Prev
        </Button>
        <span className="nums px-1">
          Page {formatNumber(page)} of {formatNumber(pageCount)}
        </span>
        <Button
          type="button"
          size="sm"
          variant="outline"
          disabled={disabled || page >= pageCount}
          onClick={() => onPage(page + 1)}
          aria-label="Next page of rows"
        >
          Next <ChevronRight />
        </Button>
      </div>
    </div>
  );
}

// Rows paged by the API (offset/limit). The server decides the order; a column
// sort only reorders the page on screen, and the CSV holds that page's rows.
export function ServerPagedRows<T = any>({
  rows,
  total,
  offset,
  limit,
  loading = false,
  onOffsetChange,
  csvName,
  csvColumns,
  sortValues,
  orderNote,
  children,
}: {
  rows: T[];
  total: number;
  offset: number;
  limit: number;
  loading?: boolean;
  onOffsetChange: (offset: number) => void;
  csvName: string;
  csvColumns?: CsvColumn<T>[];
  sortValues?: Record<string, (row: T) => unknown>;
  /** How the server orders rows, e.g. "Sorted by clicks". */
  orderNote?: string;
  children: (rows: T[]) => ReactNode;
}) {
  const { sorted, sortContext } = useRowSort(rows, sortValues);
  const pageSize = Math.max(1, limit);
  const page = Math.floor(offset / pageSize) + 1;
  const pageCount = Math.max(1, Math.ceil(total / pageSize));
  const downloadCsv = () => {
    const suffix = pageCount > 1 ? `-page-${page}` : "";
    downloadFile(`${fileSlug(csvName)}${suffix}.csv`, rowsToCsv(sorted, csvColumns), "text/csv;charset=utf-8");
  };
  return (
    <div className="space-y-3" aria-busy={loading}>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <span className="text-[13px] text-muted-foreground">
          {orderNote ? `${orderNote}. ` : ""}
          {pageCount > 1 ? "Column sorting reorders this page only." : ""}
        </span>
        <div className="flex items-center gap-2">
          <span className="whitespace-nowrap text-[13px] text-muted-foreground" aria-live="polite">
            {loading ? "Loading…" : `${formatNumber(total)} rows`}
          </span>
          <Button
            type="button"
            size="sm"
            variant="ghost"
            className="h-8 text-xs text-muted-foreground hover:text-foreground"
            disabled={!sorted.length}
            onClick={downloadCsv}
            title={pageCount > 1 ? "Download the rows on this page as CSV" : "Download every row as CSV"}
          >
            <Download /> {pageCount > 1 ? "CSV (this page)" : "CSV"}
          </Button>
        </div>
      </div>
      <TableSortContext.Provider value={sortContext}>{children(sorted)}</TableSortContext.Provider>
      {pageCount > 1 ? (
        <PagerControls
          start={offset}
          shown={rows.length}
          total={total}
          page={page}
          pageCount={pageCount}
          disabled={loading}
          onPage={(next) => onOffsetChange((next - 1) * pageSize)}
        />
      ) : null}
    </div>
  );
}

export function FilteredRows<T = any>({
  rows,
  placeholder = "Filter rows…",
  minRows = 6,
  pageSize = DEFAULT_PAGE_SIZE,
  csvName,
  csvColumns,
  sortValues,
  children,
}: {
  rows: T[];
  placeholder?: string;
  minRows?: number;
  pageSize?: number;
  /** File name stem for "Download CSV"; defaults to the filter placeholder. */
  csvName?: string;
  csvColumns?: CsvColumn<T>[];
  /** Accessors for sortable columns whose value is not a plain row path. */
  sortValues?: Record<string, (row: T) => unknown>;
  children: (rows: T[]) => ReactNode;
}) {
  const [query, setQuery] = useState("");
  const [page, setPage] = useState(1);
  const deferredQuery = useDeferredValue(query.trim().toLowerCase());
  const searchIndex = useMemo(() => rows.map(rowSearchText), [rows]);
  const filtered = useMemo(
    () => (deferredQuery ? rows.filter((_, index) => searchIndex[index].includes(deferredQuery)) : rows),
    [rows, searchIndex, deferredQuery],
  );
  const { sorted, sortContext } = useRowSort(filtered, sortValues, () => setPage(1));

  if (rows.length < minRows) {
    return <TableSortContext.Provider value={sortContext}>{children(sorted)}</TableSortContext.Provider>;
  }

  const pageCount = Math.max(1, Math.ceil(sorted.length / pageSize));
  const currentPage = Math.min(page, pageCount);
  const start = (currentPage - 1) * pageSize;
  const visible = sorted.slice(start, start + pageSize);
  const filtering = Boolean(deferredQuery);
  const downloadCsv = () => {
    const stem = fileSlug(csvName || placeholder.replace(/^filter\s+/i, "").replace(/…$/, ""));
    downloadFile(`${stem}.csv`, rowsToCsv(sorted, csvColumns), "text/csv;charset=utf-8");
  };

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <Input
          value={query}
          onChange={(event) => {
            setQuery(event.target.value);
            setPage(1);
          }}
          placeholder={placeholder}
          aria-label={placeholder}
          aria-keyshortcuts="/"
          className="h-8 max-w-72 text-[13px]"
          data-table-filter=""
        />
        <div className="flex items-center gap-2">
          <span className="whitespace-nowrap text-[13px] text-muted-foreground" aria-live="polite">
            {filtering ? `${formatNumber(sorted.length)} of ${formatNumber(rows.length)}` : `${formatNumber(rows.length)} rows`}
          </span>
          <Button
            type="button"
            size="sm"
            variant="ghost"
            className="h-8 text-xs text-muted-foreground hover:text-foreground"
            disabled={!sorted.length}
            onClick={downloadCsv}
            title={filtering ? "Download the filtered rows as CSV" : "Download every row as CSV"}
          >
            <Download /> CSV
          </Button>
        </div>
      </div>
      <TableSortContext.Provider value={sortContext}>
        {visible.length ? children(visible) : <EmptyState title="No matching rows" text="Nothing in this table matches the filter." />}
      </TableSortContext.Provider>
      {pageCount > 1 ? (
        <PagerControls
          start={start}
          shown={visible.length}
          total={sorted.length}
          page={currentPage}
          pageCount={pageCount}
          onPage={setPage}
        />
      ) : null}
    </div>
  );
}
