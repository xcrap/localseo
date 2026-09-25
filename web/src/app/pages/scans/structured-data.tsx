import { useMemo } from "react";
import { Badge, SortableTableHead, Table, TableBody, TableCell, TableHeader, TableRow } from "@/components/ui";
import { EmptyState, ReportSection, formatNumber } from "../../shared";
import { FilteredRows } from "../../data-table";
import { structuredDataTypeLabel } from "./page-drawer-sections";
import { PageLinkButton } from "./tables";

type MissingPropertyRow = {
  url: string;
  title: string;
  type: string;
  format: string;
  missingRequired: string[];
  missingRecommended: string[];
};

function stringList(value: unknown): string[] {
  return Array.isArray(value) ? value.map((item) => String(item)).filter(Boolean) : [];
}

const missingSortValues: Record<string, (row: MissingPropertyRow) => unknown> = {
  page: (row) => row.title || row.url,
  missingRequired: (row) => row.missingRequired.length,
  missingRecommended: (row) => row.missingRecommended.length,
};

const missingCsvColumns = [
  { label: "url", value: (row: MissingPropertyRow) => row.url },
  { label: "type", value: (row: MissingPropertyRow) => row.type },
  { label: "format", value: (row: MissingPropertyRow) => row.format },
  { label: "missing_required", value: (row: MissingPropertyRow) => row.missingRequired },
  { label: "missing_recommended", value: (row: MissingPropertyRow) => row.missingRecommended },
];

// Structured data found by the crawler: which schema types appear and which
// pages carry items missing required properties. Pages crawled before this
// evidence existed have no structuredData array and are not counted as empty.
export function ScanStructuredDataSummary({ pages, onOpenPage }: { pages: any[]; onOpenPage: (url: string) => void }) {
  const model = useMemo(() => {
    const collected = pages.filter((page) => Array.isArray(page.structuredData));
    const typePages = new Map<string, Set<string>>();
    const missing: MissingPropertyRow[] = [];
    let pagesWithItems = 0;
    for (const page of collected) {
      if (page.structuredData.length) pagesWithItems += 1;
      for (const item of page.structuredData) {
        const type = structuredDataTypeLabel(item);
        const urls = typePages.get(type) || new Set<string>();
        urls.add(String(page.url));
        typePages.set(type, urls);
        const missingRequired = stringList(item?.missingRequired);
        if (missingRequired.length) {
          missing.push({
            url: String(page.url || ""),
            title: String(page.title || ""),
            type,
            format: String(item?.format || ""),
            missingRequired,
            missingRecommended: stringList(item?.missingRecommended),
          });
        }
      }
    }
    const types = Array.from(typePages.entries())
      .map(([type, urls]) => ({ type, pages: urls.size }))
      .sort((a, b) => b.pages - a.pages || a.type.localeCompare(b.type));
    return { collected: collected.length, pagesWithItems, types, missing };
  }, [pages]);

  if (!pages.length) return null;
  if (!model.collected) {
    return (
      <ReportSection title="Structured data" description="Schema types found on crawled pages and items missing required properties.">
        <EmptyState title="No structured data details in this scan" text="Rescan to collect structured data details for each page." />
      </ReportSection>
    );
  }
  return (
    <ReportSection
      title="Structured data"
      description="Schema types found on crawled pages and items missing properties the type requires or recommends."
      meta={`${formatNumber(model.pagesWithItems)} of ${formatNumber(model.collected)} pages have structured data`}
    >
      <div className="space-y-4">
        {model.types.length ? (
          <div className="flex flex-wrap gap-1.5">
            {model.types.map((row) => (
              <Badge key={row.type} variant="secondary">
                {row.type}
                <span className="nums text-muted-foreground">· {formatNumber(row.pages)} {row.pages === 1 ? "page" : "pages"}</span>
              </Badge>
            ))}
          </div>
        ) : (
          <p className="text-sm text-muted-foreground">No structured data items were found on the crawled pages.</p>
        )}
        {model.missing.length ? (
          <FilteredRows
            rows={model.missing}
            placeholder="Filter structured data gaps…"
            csvName="structured-data-missing-properties"
            csvColumns={missingCsvColumns}
            sortValues={missingSortValues}
          >
            {(rows) => (
              <Table>
                <TableHeader>
                  <TableRow>
                    <SortableTableHead sortKey="page">Page</SortableTableHead>
                    <SortableTableHead sortKey="type">Type</SortableTableHead>
                    <SortableTableHead sortKey="missingRequired">Missing required</SortableTableHead>
                    <SortableTableHead sortKey="missingRecommended">Missing recommended</SortableTableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {rows.map((row, index) => (
                    <TableRow key={`${row.url}:${row.type}:${index}`}>
                      <TableCell className="max-w-sm">
                        <PageLinkButton page={row} onOpenPage={onOpenPage} />
                      </TableCell>
                      <TableCell className="whitespace-nowrap">
                        <span className="font-medium">{row.type}</span>
                        {row.format ? <span className="ml-1.5 text-xs text-muted-foreground">{row.format}</span> : null}
                      </TableCell>
                      <TableCell>
                        <div className="flex flex-wrap gap-1">
                          {row.missingRequired.map((property) => <Badge key={property} variant="bad">{property}</Badge>)}
                        </div>
                      </TableCell>
                      <TableCell>
                        {row.missingRecommended.length ? (
                          <div className="flex flex-wrap gap-1">
                            {row.missingRecommended.map((property) => <Badge key={property} variant="warn">{property}</Badge>)}
                          </div>
                        ) : (
                          <span className="text-muted-foreground">-</span>
                        )}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
          </FilteredRows>
        ) : model.types.length ? (
          <p className="text-sm text-good">Every structured data item has its required properties.</p>
        ) : null}
      </div>
    </ReportSection>
  );
}
