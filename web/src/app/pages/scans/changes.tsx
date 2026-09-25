import { useEffect, useRef, useState, type ReactNode } from "react";
import { Link } from "react-router-dom";
import { FileSearch } from "lucide-react";
import { api } from "../../../api";
import { Badge, Button, Select, SelectContent, SelectItem, SelectTrigger, SelectValue, Skeleton, SortableTableHead, Table, TableBody, TableCell, TableHeader, TableRow } from "@/components/ui";
import { CountUp, EmptyState, MetricTile, MetricTileGrid, ReportSection, formatDate, formatNumber, scanIsActive, scanStatusLabel } from "../../shared";
import { FilteredRows } from "../../data-table";
import { ScanSection, humanizeIssueType, severityVariant } from "./common";
import { issueTypeTitle, type IssueCatalog } from "./issue-catalog";

const PREVIOUS_SCAN = "__previous";

// Regressions reported by the comparison: the backend may send a list, an
// object with rows, or only a summary count; page changes flagged as
// regressions are the fallback evidence.
export function comparisonRegressions(comparison: any) {
  const value = comparison?.regressions;
  const rows: any[] = Array.isArray(value)
    ? value
    : Array.isArray(value?.rows)
      ? value.rows
      : Array.isArray(value?.items)
        ? value.items
        : (comparison?.pageChanges || []).filter((change: any) => change.regression);
  const count = Number(
    (value && !Array.isArray(value) ? value.count ?? value.total : undefined) ?? comparison?.summary?.regressions ?? rows.length,
  ) || 0;
  const newHighIssues = (comparison?.newIssues || []).filter((issue: any) => issue.severity === "high");
  return { rows, count, newHighIssues };
}

export function ScanChangesTab({
  scan,
  savedComparison,
  siteRows,
  compareId,
  catalog,
  onCompareChange,
}: {
  scan: any;
  savedComparison: any;
  siteRows: any[];
  compareId: string;
  catalog: IssueCatalog;
  onCompareChange: (baseId: string) => void;
}) {
  const [custom, setCustom] = useState<{ baseId: string; data?: any; error?: string } | null>(null);
  const requestRef = useRef(0);
  const customBaseId = compareId && compareId !== scan.id ? compareId : "";
  useEffect(() => {
    const token = ++requestRef.current;
    if (!customBaseId || scanIsActive(scan)) {
      setCustom(null);
      return;
    }
    setCustom({ baseId: customBaseId });
    api
      .compareScans(scan.id, customBaseId)
      .then((data) => {
        if (token === requestRef.current) setCustom({ baseId: customBaseId, data });
      })
      .catch((err) => {
        if (token === requestRef.current) {
          setCustom({ baseId: customBaseId, error: err instanceof Error ? err.message : "Could not compare these scans" });
        }
      });
  }, [scan.id, customBaseId, scan.status]);

  const baseOptions = siteRows.filter((row) => row.id !== scan.id && !scanIsActive(row));
  const baseRow = customBaseId ? siteRows.find((row) => row.id === customBaseId) : null;
  const picker = baseOptions.length ? (
    <div className="flex flex-wrap items-center gap-2">
      <span className="text-[13px] text-muted-foreground">Compare against</span>
      <Select value={customBaseId || PREVIOUS_SCAN} onValueChange={(value) => onCompareChange(value === PREVIOUS_SCAN ? "" : value)}>
        <SelectTrigger className="h-8 w-auto min-w-[240px] max-w-full text-xs" aria-label="Scan to compare against">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value={PREVIOUS_SCAN}>Previous scan (saved with this report)</SelectItem>
          {baseOptions.map((row) => (
            <SelectItem key={row.id} value={row.id}>
              {formatDate(row.created_at || row.updated_at)} · {row.status === "completed" ? `score ${formatNumber(Number(row.score || 0))}` : scanStatusLabel(row.status)} · {formatNumber(row.pages_crawled || 0)} pages
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  ) : null;

  let body: ReactNode;
  if (scanIsActive(scan)) {
    body = <EmptyState title="Comparison pending" text="New, fixed, and regressed findings appear after this scan finishes." />;
  } else if (customBaseId && custom?.error) {
    body = <EmptyState title="Could not compare these scans" text={custom.error} />;
  } else if (customBaseId && !custom?.data) {
    body = (
      <div className="space-y-3" role="status" aria-busy="true" aria-label="Comparing scans">
        <Skeleton className="h-24 rounded-xl" />
        <Skeleton className="h-40 rounded-xl" />
      </div>
    );
  } else {
    body = (
      <ScanChangesReport
        scan={scan}
        comparison={customBaseId ? custom?.data : savedComparison}
        baseLabel={baseRow ? `Compared with the scan from ${formatDate(baseRow.created_at || baseRow.updated_at)}` : undefined}
        baseScanId={customBaseId || undefined}
        catalog={catalog}
      />
    );
  }
  return (
    <div className="space-y-4">
      {picker}
      {body}
    </div>
  );
}

function ScanChangesReport({
  scan,
  comparison,
  baseLabel,
  baseScanId,
  catalog,
}: {
  scan: any;
  comparison: any;
  baseLabel?: string;
  baseScanId?: string;
  catalog: IssueCatalog;
}) {
  if (!comparison?.available) {
    const emptyCopy = !scan.result?.scanVersion
      ? {
          title: "Comparison unavailable for this saved scan",
          text: "This report predates versioned crawl comparisons. Fresh scans remain readable, and two new scans will establish a safe baseline.",
        }
      : comparison?.reason === "incompatible-version"
        ? {
            title: baseScanId ? "These scans cannot be compared" : "Comparison starts with this scan",
            text: "The other report uses older crawl semantics. Run one more scan to get an honest like-for-like comparison.",
          }
        : comparison?.reason === "scope-changed"
          ? {
              title: "Crawl scope changed",
              text: "The scans used different page limits. Compare scans with the same scope for a like-for-like result.",
            }
          : {
              title: baseScanId ? "No comparison available" : "First scan for this URL",
              text: baseScanId
                ? "The selected scan has no comparable crawl evidence."
                : "Run another scan to compare issues, indexability, metadata, content, redirects, and sitemap membership.",
            };
    return <EmptyState title={emptyCopy.title} text={emptyCopy.text} />;
  }

  const summary = comparison.summary || {};
  const issueChanges = [
    ...(comparison.newIssues || []),
    ...(comparison.fixedIssues || []),
    ...(comparison.severityChanges || []),
  ];
  const pageChanges = comparison.pageChanges || [];
  const otherScanId = baseScanId || comparison.previousScanId;
  return (
    <div className="space-y-4">
      <ReportSection
        title={baseScanId ? "Compared scans" : "Since the previous scan"}
        description="Saved crawl evidence compared by normalized page URL and stable issue identity."
        meta={baseLabel || (comparison.previousCreatedAt ? `Previous scan · ${formatDate(comparison.previousCreatedAt)}` : undefined)}
      >
        <MetricTileGrid>
          <MetricTile label="New issues" value={<CountUp value={summary.newIssues || 0} />} tone={summary.newIssues ? "warn" : "default"} hint="Issue identities not present in the other scan" />
          <MetricTile label="Fixed issues" value={<CountUp value={summary.fixedIssues || 0} />} hint="Findings from the other scan absent from this one" />
          <MetricTile label="Regressions" value={<CountUp value={summary.regressions || 0} />} tone={summary.regressions ? "bad" : "default"} hint="Indexability, status, redirect, sitemap, or removed-page regressions" />
          <MetricTile label="Page changes" value={<CountUp value={summary.pageChanges || 0} />} hint="Metadata, content, status, discovery, and sitemap changes" />
        </MetricTileGrid>
        {otherScanId ? (
          <Button asChild variant="outline" size="sm" className="mt-4">
            <Link to={`/scans/${otherScanId}`}><FileSearch /> Open {baseScanId ? "compared" : "previous"} scan</Link>
          </Button>
        ) : null}
      </ReportSection>

      <ScanSection title="Issue changes" text="New and fixed findings, plus issues whose severity changed.">
        {issueChanges.length ? (
          <FilteredRows rows={issueChanges} placeholder="Filter issue changes…" csvName="issue-changes">
            {(rows) => <ScanIssueChangesTable rows={rows} catalog={catalog} />}
          </FilteredRows>
        ) : <EmptyState title="No issue changes" text="The saved issue identities match the other scan." />}
      </ScanSection>

      <ScanSection title="Page changes" text="Indexability, HTTP status, redirect destination, title, description, H1, word count, sitemap, and crawl membership changes.">
        {pageChanges.length ? (
          <FilteredRows rows={pageChanges} placeholder="Filter page changes…" csvName="page-changes">
            {(rows) => <ScanPageChangesTable rows={rows} />}
          </FilteredRows>
        ) : <EmptyState title="No page changes" text="The crawled page evidence matches the other scan." />}
      </ScanSection>
    </div>
  );
}

function ScanIssueChangesTable({ rows, catalog }: { rows: any[]; catalog: IssueCatalog }) {
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <SortableTableHead sortKey="change">Change</SortableTableHead>
          <SortableTableHead sortKey="severity">Severity</SortableTableHead>
          <SortableTableHead sortKey="type">Issue</SortableTableHead>
          <SortableTableHead sortKey="url">Page</SortableTableHead>
          <SortableTableHead sortKey="previousSeverity">Before → after</SortableTableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {rows.map((row, index) => (
          <TableRow key={`${row.change}:${row.type}:${row.url}:${index}`}>
            <TableCell><Badge variant={row.change === "fixed" ? "good" : row.change === "new" ? "warn" : "outline"}>{String(row.change || "changed").replaceAll("-", " ")}</Badge></TableCell>
            <TableCell><Badge variant={severityVariant(row.severity)}>{row.severity || "low"}</Badge></TableCell>
            <TableCell className="min-w-64">
              <div className="font-medium">{issueTypeTitle(catalog, row.type, row.message)}</div>
              {row.message ? <div className="text-xs text-muted-foreground">{row.message}</div> : null}
              <div className="text-xs text-muted-foreground/70">{humanizeIssueType(row.type)}</div>
              {row.subject ? <div className="mt-1 max-w-md break-all text-xs text-muted-foreground">Target: {row.subject}</div> : null}
            </TableCell>
            <TableCell className="max-w-sm break-all text-sm text-muted-foreground">{row.url || "-"}</TableCell>
            <TableCell className="text-sm text-muted-foreground">
              {row.change === "severity-changed" ? `${row.previousSeverity || "-"} → ${row.currentSeverity || row.severity || "-"}` : "-"}
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}

export function ScanPageChangesTable({ rows }: { rows: any[] }) {
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <SortableTableHead sortKey="label">Change</SortableTableHead>
          <SortableTableHead sortKey="url">Page</SortableTableHead>
          <SortableTableHead sortKey="field">Field</SortableTableHead>
          <SortableTableHead sortKey="before">Before</SortableTableHead>
          <SortableTableHead sortKey="after">After</SortableTableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {rows.map((row, index) => (
          <TableRow key={`${row.type}:${row.url}:${row.field}:${index}`}>
            <TableCell><Badge variant={row.regression ? "bad" : row.type === "became-indexable" || row.type === "page-added-to-sitemap" ? "good" : "outline"}>{row.label || String(row.type || "changed").replaceAll("-", " ")}</Badge></TableCell>
            <TableCell className="max-w-sm break-all font-medium">{row.url}</TableCell>
            <TableCell className="whitespace-nowrap text-muted-foreground">{row.field}</TableCell>
            <TableCell className="max-w-md"><div className="line-clamp-3 break-words text-sm text-muted-foreground">{String(row.before ?? "-") || "-"}</div></TableCell>
            <TableCell className="max-w-md"><div className="line-clamp-3 break-words text-sm">{String(row.after ?? "-") || "-"}</div></TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}
