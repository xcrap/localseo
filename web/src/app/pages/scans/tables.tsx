import { CheckCircle2, EyeOff, PanelRightOpen } from "lucide-react";
import { Badge, Button, SortableTableHead, Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui";
import { IndexabilityBadge, LengthBadge, formatBytes, formatMs, formatNumber, ignorePageKey, pageH1Status, pageIssueTypeCount, pageIssueTypesCount } from "../../shared";

function activePageIssues(page: any) {
  return (Array.isArray(page?.issues) ? page.issues : []).filter((issue: any) => !issue.ignored);
}

// Sort accessors for page-table columns whose value is derived, not a row path.
export const pageSortValues: Record<string, (page: any) => unknown> = {
  page: (page) => page.title || page.url,
  links: (page) => Number(page.internalLinks || 0) + Number(page.externalLinks || 0),
  issues: (page) => {
    const issues = activePageIssues(page);
    // High issues dominate, then medium, then low, so "most severe" sorts first.
    return (
      issues.filter((issue: any) => issue.severity === "high").length * 1_000_000 +
      issues.filter((issue: any) => issue.severity === "medium").length * 1_000 +
      issues.filter((issue: any) => issue.severity === "low").length
    );
  },
  timingIssues: (page) => pageIssueTypesCount(page, ["slow-page", "page-response-slow"]),
};

// CSV columns for page rows: flat evidence, with issues summarized by severity
// instead of dumping the nested issue objects.
export const pageCsvColumns = [
  { label: "url", value: (page: any) => page.url },
  { label: "final_url", value: (page: any) => page.finalUrl },
  { label: "requested_url", value: (page: any) => page.requestedUrl },
  { label: "title", value: (page: any) => page.title },
  { label: "description", value: (page: any) => page.description },
  { label: "h1", value: (page: any) => page.h1 },
  { label: "status", value: (page: any) => page.status },
  { label: "source_status", value: (page: any) => page.sourceStatus },
  { label: "indexable", value: (page: any) => page.indexable },
  { label: "indexability_reason", value: (page: any) => page.indexabilityReason },
  { label: "canonical", value: (page: any) => page.canonical },
  { label: "sitemap_listed", value: (page: any) => page.sitemapListed },
  { label: "depth", value: (page: any) => page.depth },
  { label: "internal_inlinks", value: (page: any) => page.internalInlinks },
  { label: "discovery", value: (page: any) => page.discovery },
  { label: "load_ms", value: (page: any) => page.loadMs },
  { label: "content_length", value: (page: any) => page.contentLength },
  { label: "word_count", value: (page: any) => page.wordCount },
  { label: "internal_links", value: (page: any) => page.internalLinks },
  { label: "external_links", value: (page: any) => page.externalLinks },
  { label: "images", value: (page: any) => page.images },
  { label: "high_issues", value: (page: any) => activePageIssues(page).filter((issue: any) => issue.severity === "high").length },
  { label: "medium_issues", value: (page: any) => activePageIssues(page).filter((issue: any) => issue.severity === "medium").length },
  { label: "low_issues", value: (page: any) => activePageIssues(page).filter((issue: any) => issue.severity === "low").length },
];

export function PageLinkButton({ page, onOpenPage }: { page: any; onOpenPage?: (url: string) => void }) {
  const content = (
    <>
      <div className="truncate font-medium">{page.title || page.url}</div>
      <div className="truncate text-xs text-muted-foreground">{page.url}</div>
    </>
  );
  if (!onOpenPage) return content;
  return (
    <button
      type="button"
      className="group block w-full min-w-0 rounded-sm text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/60"
      onClick={() => onOpenPage(page.url)}
      title={`Open page details for ${page.url}`}
    >
      <div className="flex min-w-0 items-center gap-1.5">
        <span className="truncate font-medium group-hover:text-primary">{page.title || page.url}</span>
        <PanelRightOpen aria-hidden className="size-3.5 shrink-0 text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100 group-focus-visible:opacity-100" />
      </div>
      <div className="truncate text-xs text-muted-foreground">{page.url}</div>
    </button>
  );
}

export function ScanMetadataTable({ rows, onOpenPage }: { rows: any[]; onOpenPage?: (url: string) => void }) {
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <SortableTableHead sortKey="page">Page</SortableTableHead>
          <SortableTableHead sortKey="titleLength">Title</SortableTableHead>
          <SortableTableHead sortKey="descriptionLength">Description</SortableTableHead>
          <SortableTableHead sortKey="h1Count">H1</SortableTableHead>
          <SortableTableHead sortKey="canonical">Canonical</SortableTableHead>
          <SortableTableHead sortKey="indexable">Indexable</SortableTableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {rows.map((page) => {
          const h1 = pageH1Status(page);
          return (
            <TableRow key={page.url}>
              <TableCell className="max-w-xs">
                <PageLinkButton page={page} onOpenPage={onOpenPage} />
              </TableCell>
              <TableCell className="min-w-64">
                <div className="line-clamp-2 text-sm">{page.title || "Missing"}</div>
                <LengthBadge value={page.title} savedLength={page.titleLength} min={30} max={60} />
              </TableCell>
              <TableCell className="min-w-72">
                <div className="line-clamp-2 text-sm">{page.description || "Missing"}</div>
                <LengthBadge value={page.description} savedLength={page.descriptionLength} min={70} max={160} />
              </TableCell>
              <TableCell className="min-w-56">
                <div className="line-clamp-2 text-sm">{h1.label}</div>
                <Badge variant={h1.variant as any}>{h1.badge}</Badge>
              </TableCell>
              <TableCell className="max-w-xs">
                <div className="truncate text-xs text-muted-foreground">{page.canonical || "Missing"}</div>
                <Badge variant={page.canonical ? "good" : "warn"}>{page.canonicalCount || 0}</Badge>
              </TableCell>
              <TableCell><IndexabilityBadge page={page} /></TableCell>
            </TableRow>
          );
        })}
      </TableBody>
    </Table>
  );
}

// Severity counts with visible dots plus text for assistive tech, so the counts
// are never conveyed by color alone.
export function SeverityInline({ issues }: { issues: any[] }) {
  const list = (Array.isArray(issues) ? issues : []).filter((issue: any) => !issue.ignored);
  const high = list.filter((issue: any) => issue.severity === "high").length;
  const med = list.filter((issue: any) => issue.severity === "medium").length;
  const low = list.filter((issue: any) => issue.severity === "low").length;
  if (!high && !med && !low) {
    return <span className="inline-flex items-center gap-1 text-xs text-good"><CheckCircle2 aria-hidden className="size-3.5" /> clean</span>;
  }
  return (
    <span className="flex items-center gap-2.5 whitespace-nowrap text-xs tabular-nums">
      {high ? (
        <span className="inline-flex items-center gap-1 font-medium text-bad" title={`${high} high`}>
          <span aria-hidden className="size-1.5 rounded-full bg-bad" />
          {high}
          <span className="sr-only"> high,</span>
        </span>
      ) : null}
      {med ? (
        <span className="inline-flex items-center gap-1 font-medium text-warn" title={`${med} medium`}>
          <span aria-hidden className="size-1.5 rounded-full bg-warn" />
          {med}
          <span className="sr-only"> medium,</span>
        </span>
      ) : null}
      {low ? (
        <span className="inline-flex items-center gap-1 text-muted-foreground" title={`${low} low`}>
          <span aria-hidden className="size-1.5 rounded-full bg-muted-foreground/50" />
          {low}
          <span className="sr-only"> low</span>
        </span>
      ) : null}
    </span>
  );
}

export function ScanPagesTable({
  rows,
  onShowIssues,
  onTogglePageIgnore,
  onOpenPage,
  ignoredPageKeys,
}: {
  rows: any[];
  onShowIssues?: (page: any) => void;
  onTogglePageIgnore?: (page: any) => void;
  onOpenPage?: (url: string) => void;
  ignoredPageKeys?: Set<string>;
}) {
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <SortableTableHead sortKey="page">Page</SortableTableHead>
          <SortableTableHead sortKey="status">Status</SortableTableHead>
          <SortableTableHead sortKey="indexable">Indexable</SortableTableHead>
          <SortableTableHead sortKey="sitemapListed">Sitemap</SortableTableHead>
          <SortableTableHead sortKey="depth" className="text-right">Depth</SortableTableHead>
          <SortableTableHead sortKey="internalInlinks" className="text-right">Inlinks</SortableTableHead>
          <SortableTableHead sortKey="loadMs" className="text-right">Response</SortableTableHead>
          <SortableTableHead sortKey="wordCount" className="text-right">Words</SortableTableHead>
          <SortableTableHead sortKey="links" className="text-right">Links·Img</SortableTableHead>
          <SortableTableHead sortKey="issues">Issues</SortableTableHead>
          {onTogglePageIgnore ? <TableHead className="text-right"><span className="sr-only">Ignore page</span></TableHead> : null}
        </TableRow>
      </TableHeader>
      <TableBody>
        {rows.map((page) => {
          const hasActiveIssues = activePageIssues(page).length > 0;
          return (
            <TableRow key={page.url}>
              <TableCell className="max-w-sm">
                <PageLinkButton page={page} onOpenPage={onOpenPage} />
                {page.requestedUrl && page.requestedUrl !== page.url ? <div className="truncate text-xs text-warn">via {page.requestedUrl}</div> : null}
              </TableCell>
              <TableCell><Badge variant={page.status >= 400 ? "bad" : page.sourceStatus >= 300 || page.status >= 300 ? "warn" : "good"}>{page.sourceStatus != null && page.sourceStatus !== page.status ? `${page.sourceStatus} → ${page.status}` : page.status}</Badge></TableCell>
              <TableCell>
                <IndexabilityBadge page={page} />
                {page.indexabilityReason && page.indexabilityReason !== "indexable" ? <div className="mt-1 text-xs text-muted-foreground">{String(page.indexabilityReason).replaceAll("-", " ")}</div> : null}
              </TableCell>
              <TableCell>
                <Badge variant={page.sitemapListed ? "good" : "warn"}>
                  {page.sitemapListed ? "Listed" : page.sitemapSourceListed ? "Redirect source listed" : "Missing"}
                </Badge>
              </TableCell>
              <TableCell className="text-right nums tabular-nums">{page.depth != null ? formatNumber(page.depth) : "-"}</TableCell>
              <TableCell className="text-right nums tabular-nums">{formatNumber(page.internalInlinks || 0)}</TableCell>
              <TableCell className="text-right nums tabular-nums">{formatMs(page.loadMs)}</TableCell>
              <TableCell className="text-right nums tabular-nums">{formatNumber(page.wordCount)}</TableCell>
              <TableCell className="whitespace-nowrap text-right text-muted-foreground nums tabular-nums">
                {formatNumber((page.internalLinks || 0) + (page.externalLinks || 0))} · {formatNumber(page.images || 0)}
              </TableCell>
              <TableCell>
                {onShowIssues && hasActiveIssues ? (
                  <button
                    type="button"
                    className="-mx-1.5 cursor-pointer rounded-md px-1.5 py-1 hover:bg-accent/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/60"
                    title={`Show issues for ${page.url}`}
                    onClick={() => onShowIssues(page)}
                  >
                    <SeverityInline issues={page.issues} />
                    <span className="sr-only"> — show these issues</span>
                  </button>
                ) : (
                  <SeverityInline issues={page.issues} />
                )}
              </TableCell>
              {onTogglePageIgnore ? (
                <TableCell className="text-right">
                  {ignoredPageKeys?.has(ignorePageKey(page.url)) ? (
                    <Button
                      size="sm"
                      variant="secondary"
                      className="h-7 gap-1.5 text-xs"
                      title="This page is ignored — click to restore its issues"
                      aria-label={`Restore ignored issues for ${page.url}`}
                      onClick={() => onTogglePageIgnore(page)}
                    >
                      <EyeOff /> Ignored
                    </Button>
                  ) : (page.issues || []).length ? (
                    <Button
                      size="sm"
                      variant="ghost"
                      className="h-7 gap-1.5 text-xs text-muted-foreground"
                      aria-label={`Ignore all issues on ${page.url}`}
                      onClick={() => onTogglePageIgnore(page)}
                    >
                      <EyeOff /> Ignore
                    </Button>
                  ) : null}
                </TableCell>
              ) : null}
            </TableRow>
          );
        })}
      </TableBody>
    </Table>
  );
}

export const imageSummarySortValues: Record<string, (page: any) => unknown> = {
  page: (page) => page.title || page.url,
  srcsetMissing: (page) => pageIssueTypeCount(page, "image-srcset-missing"),
  lazyMissing: (page) => pageIssueTypeCount(page, "image-lazy-loading-missing"),
  brokenFiles: (page) => pageIssueTypeCount(page, "broken-image"),
};

export function ScanImageSummaryTable({ rows, onOpenPage }: { rows: any[]; onOpenPage?: (url: string) => void }) {
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <SortableTableHead sortKey="page">Page</SortableTableHead>
          <SortableTableHead sortKey="images">Images</SortableTableHead>
          <SortableTableHead sortKey="imagesMissingSrc">Missing src</SortableTableHead>
          <SortableTableHead sortKey="imagesMissingFallbackSrc">Missing fallback</SortableTableHead>
          <SortableTableHead sortKey="imagesInvalidSrcset">Invalid srcset</SortableTableHead>
          <SortableTableHead sortKey="imagesMissingAlt">Missing alt</SortableTableHead>
          <SortableTableHead sortKey="imagesEmptyAlt">Empty alt</SortableTableHead>
          <SortableTableHead sortKey="imagesMissingDimensions">Missing size</SortableTableHead>
          <SortableTableHead sortKey="srcsetMissing">Missing srcset</SortableTableHead>
          <SortableTableHead sortKey="lazyMissing">No lazy load</SortableTableHead>
          <SortableTableHead sortKey="brokenFiles">Broken files</SortableTableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {rows.map((page) => (
          <TableRow key={page.url}>
            <TableCell className="max-w-xs">
              <PageLinkButton page={page} onOpenPage={onOpenPage} />
            </TableCell>
            <TableCell className="nums">{page.images || 0}</TableCell>
            <TableCell><Badge variant={page.imagesMissingSrc ? "bad" : "good"}>{page.imagesMissingSrc || 0}</Badge></TableCell>
            <TableCell><Badge variant={page.imagesMissingFallbackSrc ? "warn" : "good"}>{page.imagesMissingFallbackSrc || 0}</Badge></TableCell>
            <TableCell><Badge variant={page.imagesInvalidSrcset ? "bad" : "good"}>{page.imagesInvalidSrcset || 0}</Badge></TableCell>
            <TableCell><Badge variant={page.imagesMissingAlt ? "warn" : "good"}>{page.imagesMissingAlt || 0}</Badge></TableCell>
            <TableCell><Badge variant={page.imagesEmptyAlt ? "warn" : "good"}>{page.imagesEmptyAlt || 0}</Badge></TableCell>
            <TableCell><Badge variant={page.imagesMissingDimensions ? "warn" : "good"}>{page.imagesMissingDimensions || 0}</Badge></TableCell>
            <TableCell><Badge variant={pageIssueTypeCount(page, "image-srcset-missing") ? "warn" : "good"}>{pageIssueTypeCount(page, "image-srcset-missing")}</Badge></TableCell>
            <TableCell><Badge variant={pageIssueTypeCount(page, "image-lazy-loading-missing") ? "warn" : "good"}>{pageIssueTypeCount(page, "image-lazy-loading-missing")}</Badge></TableCell>
            <TableCell><Badge variant={pageIssueTypeCount(page, "broken-image") ? "bad" : "good"}>{pageIssueTypeCount(page, "broken-image")}</Badge></TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}

function resourceStatus(row: any) {
  return row.finalStatus != null && row.finalStatus !== row.status
    ? `${row.status ?? "?"} → ${row.finalStatus}`
    : row.status || row.error || "failed";
}

export function ScanAssetsTable({ rows }: { rows: any[] }) {
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <SortableTableHead sortKey="url">Asset</SortableTableHead>
          <SortableTableHead sortKey="type">Type</SortableTableHead>
          <SortableTableHead sortKey="status">Status</SortableTableHead>
          <SortableTableHead sortKey="placement">Loading</SortableTableHead>
          <SortableTableHead sortKey="contentType">Content type</SortableTableHead>
          <SortableTableHead sortKey="contentLength">Size</SortableTableHead>
          <SortableTableHead sortKey="from">From</SortableTableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {rows.map((row, index) => {
          const certificateFailure = row.failureKind === "tls-certificate";
          return (
            <TableRow key={`${row.url}:${index}`}>
              <TableCell className="max-w-sm break-all font-medium">{row.url}</TableCell>
              <TableCell><Badge variant="outline">{row.type}</Badge></TableCell>
              <TableCell><Badge variant={certificateFailure ? "warn" : row.ok ? "good" : "bad"}>{resourceStatus(row)}</Badge></TableCell>
              <TableCell>
                <div className="flex flex-wrap gap-1">
                  {row.type === "js" && row.placement === "head" && !row.async && !row.defer && !row.module ? <Badge variant="warn">blocking</Badge> : null}
                  {row.async ? <Badge variant="good">async</Badge> : null}
                  {row.defer ? <Badge variant="good">defer</Badge> : null}
                  {row.module ? <Badge variant="outline">module</Badge> : null}
                  <Badge variant="outline">{row.placement || "-"}</Badge>
                </div>
              </TableCell>
              <TableCell className="text-muted-foreground">{row.contentType || "-"}</TableCell>
              <TableCell className="nums">{formatBytes(row.contentLength)}</TableCell>
              <TableCell className="max-w-xs truncate text-muted-foreground">{row.from}</TableCell>
            </TableRow>
          );
        })}
      </TableBody>
    </Table>
  );
}

export function ScanImagesTable({ rows }: { rows: any[] }) {
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <SortableTableHead sortKey="url">Image</SortableTableHead>
          <SortableTableHead sortKey="status">Status</SortableTableHead>
          <SortableTableHead sortKey="contentType">Type</SortableTableHead>
          <SortableTableHead sortKey="contentLength">Size</SortableTableHead>
          <SortableTableHead sortKey="purpose">Purpose</SortableTableHead>
          <TableHead>Final URL</TableHead>
          <SortableTableHead sortKey="from">From</SortableTableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {rows.map((row, index) => {
          const certificateFailure = row.failureKind === "tls-certificate";
          return (
            <TableRow key={`${row.url}:${index}`}>
              <TableCell className="max-w-sm break-all font-medium">{row.url}</TableCell>
              <TableCell><Badge variant={certificateFailure ? "warn" : !row.ok ? "bad" : row.redirected || row.finalUrl !== row.url ? "warn" : "good"}>{resourceStatus(row)}</Badge></TableCell>
              <TableCell className="text-muted-foreground">{row.contentType || "-"}</TableCell>
              <TableCell className="nums">{formatBytes(row.contentLength)}</TableCell>
              <TableCell><Badge variant="outline">{row.purpose || "img"}</Badge></TableCell>
              <TableCell className="max-w-xs truncate text-muted-foreground">{row.finalUrl && row.finalUrl !== row.url ? row.finalUrl : "-"}</TableCell>
              <TableCell className="max-w-xs truncate text-muted-foreground">{row.from}</TableCell>
            </TableRow>
          );
        })}
      </TableBody>
    </Table>
  );
}

export function ScanImageInventoryTable({ rows }: { rows: any[] }) {
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <SortableTableHead sortKey="src">Image</SortableTableHead>
          <SortableTableHead sortKey="issues">Problems</SortableTableHead>
          <SortableTableHead sortKey="altState">Alt</SortableTableHead>
          <SortableTableHead sortKey="classification">Class</SortableTableHead>
          <TableHead>Size attrs</TableHead>
          <SortableTableHead sortKey="srcsetCount">Sources</SortableTableHead>
          <SortableTableHead sortKey="loading">Loading</SortableTableHead>
          <SortableTableHead sortKey="from">From</SortableTableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {rows.map((row, index) => (
          <TableRow key={`${row.from}:${row.src}:${index}`}>
            <TableCell className="max-w-sm break-all font-medium">{row.src || "Missing src"}</TableCell>
            <TableCell>
              <div className="flex flex-wrap gap-1">
                {row.issues?.length ? row.issues.map((issue: string) => <Badge key={issue} variant={issue.includes("missing") || issue.includes("mixed") ? "warn" : "outline"}>{issue}</Badge>) : <Badge variant="good">Clean tag</Badge>}
              </div>
            </TableCell>
            <TableCell className="max-w-xs">
              <div className="line-clamp-2 text-sm">{row.altPreview || (row.altState === "missing" ? "Missing" : "Empty")}</div>
              <Badge variant={row.altState === "present" ? "good" : row.classification === "content" ? "warn" : "outline"}>{row.altState}</Badge>
            </TableCell>
            <TableCell><Badge variant="outline">{row.classification}</Badge></TableCell>
            <TableCell className="nums">{row.width || "-"} x {row.height || "-"}</TableCell>
            <TableCell className="nums">
              <div className="flex flex-wrap gap-1">
                <Badge variant={row.srcsetCount ? "outline" : "warn"}>{row.srcsetCount || 0} srcset</Badge>
                {row.pictureSourceCount ? <Badge variant="outline">{row.pictureSourceCount} picture</Badge> : null}
              </div>
            </TableCell>
            <TableCell className="text-muted-foreground">{row.loading || "-"}</TableCell>
            <TableCell className="max-w-xs truncate text-muted-foreground">{row.from}</TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}

export function ScanLinkInventoryTable({ rows }: { rows: any[] }) {
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <SortableTableHead sortKey="href">URL</SortableTableHead>
          <SortableTableHead sortKey="type">Type</SortableTableHead>
          <SortableTableHead sortKey="anchor">Anchor</SortableTableHead>
          <SortableTableHead sortKey="rel">Rel</SortableTableHead>
          <SortableTableHead sortKey="target">Window</SortableTableHead>
          <SortableTableHead sortKey="from">From</SortableTableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {rows.map((row, index) => (
          <TableRow key={`${row.from}:${row.href}:${index}`}>
            <TableCell className="max-w-sm break-all font-medium">{row.href}</TableCell>
            <TableCell><Badge variant="outline">{row.type}</Badge></TableCell>
            <TableCell className="max-w-xs">
              <div className="line-clamp-2 text-sm">{row.anchor || row.accessibleName || "No readable anchor"}</div>
              {!row.anchor && !row.accessibleName ? <Badge variant="warn">empty</Badge> : null}
            </TableCell>
            <TableCell className="max-w-xs truncate text-muted-foreground">{row.rel || "-"}</TableCell>
            <TableCell className="text-muted-foreground">{row.target || "-"}</TableCell>
            <TableCell className="max-w-xs truncate text-muted-foreground">{row.from}</TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}

export function ScanParameterUrlsTable({ rows }: { rows: any[] }) {
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <SortableTableHead sortKey="url">Parameterized URL</SortableTableHead>
          <SortableTableHead sortKey="query">Query</SortableTableHead>
          <SortableTableHead sortKey="crawlUrl">Crawled as</SortableTableHead>
          <SortableTableHead sortKey="source">Source</SortableTableHead>
          <SortableTableHead sortKey="from">Found on</SortableTableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {rows.map((row, index) => (
          <TableRow key={`${row.url}:${index}`}>
            <TableCell className="max-w-sm break-all font-medium">{row.url}</TableCell>
            <TableCell className="max-w-xs break-all text-muted-foreground">{row.query || "-"}</TableCell>
            <TableCell className="max-w-xs break-all text-muted-foreground">{row.crawlUrl || row.path || "-"}</TableCell>
            <TableCell><Badge variant="outline">{row.source || "-"}</Badge></TableCell>
            <TableCell className="max-w-xs truncate text-muted-foreground">{row.from || "-"}</TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}

export function speedVariant(loadMs: unknown) {
  const value = Number(loadMs);
  if (!Number.isFinite(value)) return "outline";
  if (value > 4000) return "bad";
  if (value > 2000) return "warn";
  return "good";
}

export function ScanSpeedPagesTable({ rows, onOpenPage }: { rows: any[]; onOpenPage?: (url: string) => void }) {
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <SortableTableHead sortKey="page">Page</SortableTableHead>
          <SortableTableHead sortKey="status">Status</SortableTableHead>
          <SortableTableHead sortKey="loadMs">Response</SortableTableHead>
          <SortableTableHead sortKey="contentLength">Size</SortableTableHead>
          <SortableTableHead sortKey="contentEncoding">Compression</SortableTableHead>
          <SortableTableHead sortKey="timingIssues">Timing issue</SortableTableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {rows.map((page) => {
          const timingIssues = pageIssueTypesCount(page, ["slow-page", "page-response-slow"]);
          return (
            <TableRow key={page.url}>
              <TableCell className="min-w-96">
                {onOpenPage ? (
                  <button
                    type="button"
                    className="break-all rounded-sm text-left font-medium hover:text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/60"
                    onClick={() => onOpenPage(page.url)}
                    title={`Open page details for ${page.url}`}
                  >
                    {page.url}
                  </button>
                ) : (
                  <div className="break-all font-medium">{page.url}</div>
                )}
                <div className="mt-1 text-xs text-muted-foreground">{page.title || "Untitled page"}</div>
                {page.requestedUrl && page.requestedUrl !== page.url ? <div className="mt-1 break-all text-xs text-warn">via {page.requestedUrl}</div> : null}
              </TableCell>
              <TableCell><Badge variant={page.status >= 400 ? "bad" : page.status >= 300 ? "warn" : "good"}>{page.status || "-"}</Badge></TableCell>
              <TableCell><Badge variant={speedVariant(page.loadMs) as any}>{formatMs(page.loadMs)}</Badge></TableCell>
              <TableCell className="nums">{formatBytes(page.contentLength)}</TableCell>
              <TableCell><Badge variant={page.contentEncoding ? "good" : page.contentLength ? "warn" : "outline"}>{page.contentEncoding || "not advertised"}</Badge></TableCell>
              <TableCell><Badge variant={timingIssues ? "warn" : "good"}>{timingIssues ? `${formatNumber(timingIssues)} issue${timingIssues === 1 ? "" : "s"}` : "clear"}</Badge></TableCell>
            </TableRow>
          );
        })}
      </TableBody>
    </Table>
  );
}
