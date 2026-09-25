import * as React from "react";
import { ArrowDown, ArrowUp, ArrowUpDown } from "lucide-react";
import { cn } from "@/lib/utils";

function Table({ className, ...props }: React.ComponentProps<"table">) {
  return (
    <div data-slot="table-container" className="relative w-full overflow-x-auto">
      <table data-slot="table" className={cn("w-full caption-bottom border-collapse text-sm", className)} {...props} />
    </div>
  );
}

function TableHeader({ className, ...props }: React.ComponentProps<"thead">) {
  return <thead data-slot="table-header" className={cn("[&_tr]:border-b [&_tr]:border-border", className)} {...props} />;
}

function TableBody({ className, ...props }: React.ComponentProps<"tbody">) {
  return <tbody data-slot="table-body" className={cn("[&_tr:last-child]:border-0", className)} {...props} />;
}

function TableRow({ className, ...props }: React.ComponentProps<"tr">) {
  return (
    <tr
      data-slot="table-row"
      className={cn("border-b border-border/70 transition-colors hover:bg-accent/45 data-[state=selected]:bg-accent/60", className)}
      {...props}
    />
  );
}

function TableHead({ className, ...props }: React.ComponentProps<"th">) {
  return (
    <th
      data-slot="table-head"
      className={cn(
        "h-9 px-3 text-left align-middle text-[0.6875rem] font-semibold uppercase tracking-[0.13em] text-muted-foreground/80",
        className,
      )}
      {...props}
    />
  );
}

function TableCell({ className, ...props }: React.ComponentProps<"td">) {
  return <td data-slot="table-cell" className={cn("px-3 py-2.5 align-middle", className)} {...props} />;
}

type TableSortDirection = "asc" | "desc";

type TableSortState = {
  sortKey: string;
  direction: TableSortDirection;
  toggleSort: (key: string) => void;
};

// Provided by a filtered/paged table wrapper. Tables rendered outside such a
// wrapper keep plain, non-interactive headers.
const TableSortContext = React.createContext<TableSortState | null>(null);

function SortableTableHead({
  sortKey,
  className,
  children,
  ...props
}: React.ComponentProps<"th"> & { sortKey: string }) {
  const sort = React.useContext(TableSortContext);
  if (!sort) {
    return (
      <TableHead className={className} {...props}>
        {children}
      </TableHead>
    );
  }
  const active = sort.sortKey === sortKey;
  const Icon = active ? (sort.direction === "asc" ? ArrowUp : ArrowDown) : ArrowUpDown;
  return (
    <TableHead
      className={className}
      aria-sort={active ? (sort.direction === "asc" ? "ascending" : "descending") : "none"}
      {...props}
    >
      <button
        type="button"
        onClick={() => sort.toggleSort(sortKey)}
        className={cn(
          "-mx-1 inline-flex items-center gap-1 rounded-sm px-1 uppercase tracking-[inherit] transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/60",
          active ? "text-foreground" : "",
        )}
      >
        {children}
        <Icon aria-hidden className={cn("size-3", active ? "opacity-90" : "opacity-40")} />
      </button>
    </TableHead>
  );
}

export { Table, TableHeader, TableBody, TableHead, TableRow, TableCell, SortableTableHead, TableSortContext };
export type { TableSortDirection, TableSortState };
