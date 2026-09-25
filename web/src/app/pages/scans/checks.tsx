import { ListChecks } from "lucide-react";
import { Button, Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui";
import { InfoTip, ReportSection, StatusDot, formatNumber, issueTypeCount, issueTypesCount, knownNumber, scanCoverageMetrics, type ScanCheckRowModel, type ScanCheckSectionModel } from "../../shared";
import { humanizeIssueType } from "./common";
import type { IssueCatalog } from "./issue-catalog";

export function ScanCheckMatrix({
  summary,
  coverage,
  issues,
  catalog,
  onSelectCheck,
}: {
  summary: any;
  coverage: ReturnType<typeof scanCoverageMetrics>;
  issues: any[];
  catalog: IssueCatalog;
  onSelectCheck: (row: ScanCheckRowModel) => void;
}) {
  // Whole-category rows take their issue types from the /api/scan-issue-types
  // catalog (plus any type this scan's issues carry), so newer checks are
  // included and a row's count always equals the issues its button opens.
  const categoryTypes = (category: string, exclude: string[] = []) =>
    Array.from(
      new Set([
        ...Array.from(catalog.values()).filter((entry) => entry.category === category).map((entry) => entry.type),
        ...issues.filter((issue) => issue.category === category).map((issue) => String(issue.type || "")),
      ]),
    )
      .filter((type) => type && !exclude.includes(type))
      .sort();
  const categoryRow = (label: string, severity: string, category: string, exclude: string[] = []): ScanCheckRowModel => {
    const types = categoryTypes(category, exclude);
    return { label, value: issueTypesCount(issues, types), problem: true, severity, category, types };
  };
  const langTypes = ["html-lang-missing", "html-lang-invalid", "charset-missing"];
  const sections: ScanCheckSectionModel[] = [
    {
      title: "Metadata",
      text: "Titles, descriptions, snippets",
      rows: [
        { label: "Missing titles", value: summary.missingTitles, problem: true, severity: "bad", category: "metadata", types: ["title-missing"] },
        { label: "Title length", value: summary.titleLengthIssues, problem: true, severity: "warn", category: "metadata", types: ["title-length"] },
        { label: "Multiple title tags", value: issueTypeCount(issues, "title-multiple"), problem: true, severity: "warn", category: "metadata", types: ["title-multiple"] },
        { label: "Duplicate titles", value: issueTypeCount(issues, "duplicate-title"), problem: true, severity: "warn", category: "metadata", types: ["duplicate-title"] },
        { label: "Missing descriptions", value: summary.missingDescriptions, problem: true, severity: "bad", category: "metadata", types: ["description-missing"] },
        { label: "Description length", value: summary.descriptionLengthIssues, problem: true, severity: "warn", category: "metadata", types: ["description-length"] },
        { label: "Multiple descriptions", value: issueTypeCount(issues, "description-multiple"), problem: true, severity: "warn", category: "metadata", types: ["description-multiple"] },
        { label: "Duplicate descriptions", value: issueTypeCount(issues, "duplicate-description"), problem: true, severity: "warn", category: "metadata", types: ["duplicate-description"] },
        { label: "Missing favicon", value: issueTypeCount(issues, "favicon-missing"), problem: true, severity: "warn", category: "metadata", types: ["favicon-missing"] },
      ] satisfies ScanCheckRowModel[],
    },
    {
      title: "Content",
      text: "Headings, body copy, duplication",
      rows: [
        { label: "H1 problems", value: issueTypeCount(issues, "h1-count"), problem: true, severity: "warn", category: "headings", types: ["h1-count"] },
        { label: "Empty headings", value: issueTypesCount(issues, ["h1-empty", "heading-empty"]), problem: true, severity: "warn", category: "headings", types: ["h1-empty", "heading-empty"] },
        { label: "Heading jumps", value: issueTypeCount(issues, "heading-hierarchy-jump"), problem: true, severity: "warn", category: "headings", types: ["heading-hierarchy-jump"] },
        { label: "Missing H2 sections", value: issueTypeCount(issues, "h2-missing"), problem: true, severity: "warn", category: "headings", types: ["h2-missing"] },
        { label: "Thin pages", value: summary.thinPages, problem: true, severity: "warn", category: "content", types: ["thin-content"] },
        { label: "Duplicate H1", value: summary.duplicateH1Pages, problem: true, severity: "warn", category: "headings", types: ["duplicate-h1"] },
        { label: "Duplicate content", value: summary.duplicateContentPages, problem: true, severity: "bad", category: "content", types: ["duplicate-content"] },
      ],
    },
    {
      title: "Images",
      text: "Tags, alts, sources, files",
      rows: [
        { label: "Image tags", value: coverage.imageTags },
        { label: "Checked image URLs", value: coverage.checkedImages },
        { label: "CSS images checked", value: summary.cssImageResources },
        { label: "Picture sources checked", value: summary.pictureSourceImages },
        { label: "Missing src", value: issueTypeCount(issues, "image-src-missing"), problem: true, severity: "bad", category: "images", types: ["image-src-missing"] },
        { label: "Missing picture fallback", value: issueTypeCount(issues, "image-fallback-src-missing"), problem: true, severity: "warn", category: "images", types: ["image-fallback-src-missing"] },
        { label: "Invalid srcset", value: issueTypeCount(issues, "image-srcset-invalid"), problem: true, severity: "bad", category: "images", types: ["image-srcset-invalid"] },
        { label: "Missing or empty alt", value: summary.missingAlt, problem: true, severity: "warn", category: "images", types: ["image-alt-missing", "image-alt-empty"] },
        { label: "Generic alt", value: summary.genericAlt, problem: true, severity: "warn", category: "images", types: ["image-alt-generic"] },
        { label: "Alt too long", value: summary.longAlt, problem: true, severity: "warn", category: "images", types: ["image-alt-too-long"] },
        { label: "Duplicate alt", value: issueTypeCount(issues, "image-alt-duplicate"), problem: true, severity: "warn", category: "images", types: ["image-alt-duplicate"] },
        { label: "Missing size", value: summary.imagesMissingDimensions, problem: true, severity: "warn", category: "images", types: ["image-dimensions-missing"] },
        { label: "Missing srcset", value: summary.imagesMissingSrcset, problem: true, severity: "warn", category: "images", types: ["image-srcset-missing"] },
        { label: "No lazy loading", value: summary.imagesMissingLazyLoading, problem: true, severity: "warn", category: "performance", types: ["image-lazy-loading-missing"] },
        { label: "Broken image URLs", value: coverage.brokenImages, problem: true, severity: "bad", category: "images", types: ["broken-image"] },
        { label: "Unverified image certificates", value: coverage.unverifiedImages, problem: true, severity: "warn", category: "images", types: ["image-certificate-error"] },
        { label: "Redirecting image URLs", value: coverage.redirectedImages, problem: true, severity: "warn", category: "images", types: ["image-redirects"] },
        { label: "Large images", value: coverage.largeImages, problem: true, severity: "warn", category: "images", types: ["large-image"] },
        { label: "Wrong content type", value: issueTypeCount(issues, "image-invalid-content-type"), problem: true, severity: "bad", category: "images", types: ["image-invalid-content-type"] },
        { label: "Extension mismatch", value: summary.imageExtensionMismatches, problem: true, severity: "warn", category: "images", types: ["image-extension-mismatch"] },
        { label: "Mixed image content", value: issueTypeCount(issues, "mixed-content-images"), problem: true, severity: "bad", category: "images", types: ["mixed-content-images"] },
      ],
    },
    {
      title: "Links",
      text: "URLs, anchors, redirects",
      rows: [
        { label: "Links found", value: coverage.linkTags },
        { label: "Checked links", value: coverage.checkedLinks },
        { label: "Broken links", value: coverage.brokenLinks, problem: true, severity: "bad", category: "links", types: ["broken-internal-link", "broken-external-link", "link-redirect-loop"] },
        { label: "Unverified certificates", value: coverage.unverifiedLinks, problem: true, severity: "warn", category: "links", types: ["internal-link-certificate-error", "external-link-certificate-error"] },
        { label: "Pages linking to redirects", value: coverage.redirectedLinkPages, problem: true, severity: "warn", category: "links", types: ["internal-link-redirects", "external-link-redirects"] },
        { label: "Empty anchors", value: summary.emptyAnchorLinks, problem: true, severity: "warn", category: "links", types: ["empty-anchor-text"] },
        { label: "Internal nofollow", value: summary.internalNofollowLinks, problem: true, severity: "warn", category: "links", types: ["internal-nofollow"] },
        { label: "Tracked internal links", value: issueTypeCount(issues, "internal-links-with-tracking-parameters"), problem: true, severity: "warn", category: "links", types: ["internal-links-with-tracking-parameters"] },
        { label: "Mixed content links", value: issueTypeCount(issues, "mixed-content-links"), problem: true, severity: "warn", category: "links", types: ["mixed-content-links"] },
        { label: "Unsafe new-tab links", value: issueTypeCount(issues, "external-blank-missing-noopener"), problem: true, severity: "warn", category: "security", types: ["external-blank-missing-noopener"] },
        { label: "Too many links", value: issueTypeCount(issues, "too-many-links"), problem: true, severity: "warn", category: "links", types: ["too-many-links"] },
        { label: "No internal links", value: issueTypeCount(issues, "no-internal-links"), problem: true, severity: "warn", category: "links", types: ["no-internal-links"] },
      ],
    },
    {
      title: "Indexability",
      text: "Robots, canonicals, language",
      rows: [
        { label: "Noindex pages", value: issueTypeCount(issues, "noindex"), problem: true, severity: "bad", category: "indexability", types: ["noindex"] },
        { label: "Page nofollow", value: issueTypeCount(issues, "meta-robots-nofollow"), problem: true, severity: "warn", category: "indexability", types: ["meta-robots-nofollow"] },
        { label: "Snippet restrictions", value: issueTypeCount(issues, "restrictive-snippet-directive"), problem: true, severity: "warn", category: "indexability", types: ["restrictive-snippet-directive"] },
        categoryRow("Canonical issues", "warn", "canonicals"),
        { label: "HTTP pages", value: issueTypeCount(issues, "page-not-https"), problem: true, severity: "bad", category: "security", types: ["page-not-https"] },
        // Lang and charset checks span two categories (indexability, localization).
        { label: "Lang or charset issues", value: issueTypesCount(issues, langTypes), problem: true, severity: "warn", types: langTypes },
        categoryRow("Hreflang issues", "warn", "localization", langTypes),
      ],
    },
    {
      title: "Crawl",
      text: "Sitemap, robots, discovery",
      rows: [
        { label: "Pages crawled", value: coverage.pages },
        { label: "Page crawl failures", value: issueTypesCount(issues, ["crawl-failed", "page-http-error", "non-html-page", "redirect-failed"]), problem: true, severity: "bad", category: "crawl", types: ["crawl-failed", "page-http-error", "non-html-page", "redirect-failed"] },
        { label: "Redirected pages", value: issueTypesCount(issues, ["redirected-url", "temporary-redirect"]), problem: true, severity: "warn", category: "crawl", types: ["redirected-url", "temporary-redirect"] },
        { label: "Redirect chains", value: issueTypeCount(issues, "redirect-chain"), problem: true, severity: "warn", category: "crawl", types: ["redirect-chain"] },
        { label: "Redirect loops", value: issueTypeCount(issues, "redirect-loop"), problem: true, severity: "bad", category: "crawl", types: ["redirect-loop"] },
        { label: "Meta refresh", value: issueTypeCount(issues, "meta-refresh"), problem: true, severity: "warn", category: "crawl", types: ["meta-refresh"] },
        { label: "Long URLs", value: issueTypeCount(issues, "url-too-long"), problem: true, severity: "warn", category: "crawl", types: ["url-too-long"] },
        { label: "Tracked URLs", value: issueTypeCount(issues, "tracking-parameters-in-url"), problem: true, severity: "warn", category: "crawl", types: ["tracking-parameters-in-url"] },
        { label: "Orphan pages", value: coverage.orphanPages, problem: true, severity: "warn", category: "crawl", types: ["orphan-page"] },
        { label: "Deep pages", value: coverage.deepPages, problem: true, severity: "warn", category: "crawl", types: ["crawl-depth-deep"] },
        { label: "Missing from sitemap", value: coverage.pagesMissingFromSitemap, problem: true, severity: "warn", category: "sitemap", types: ["page-missing-from-sitemap"] },
        { label: "Noindex in sitemap", value: summary.noindexPagesInSitemap, problem: true, severity: "warn", category: "sitemap", types: ["noindex-page-in-sitemap"] },
        categoryRow("Robots issues", "warn", "robots"),
        categoryRow("Sitemap issues", "warn", "sitemap"),
      ],
    },
    {
      title: "Speed",
      text: "Performance and CSS/JS",
      rows: [
        { label: "Slow pages", value: issueTypesCount(issues, ["slow-page", "page-response-slow"]), problem: true, severity: "warn", category: "performance", types: ["slow-page", "page-response-slow"] },
        { label: "Viewport issues", value: issueTypesCount(issues, ["viewport-missing", "viewport-not-responsive"]), problem: true, severity: "warn", category: "performance", types: ["viewport-missing", "viewport-not-responsive"] },
        { label: "Heavy HTML", value: issueTypesCount(issues, ["heavy-html", "html-compression-missing"]), problem: true, severity: "warn", category: "performance", types: ["heavy-html", "html-compression-missing"] },
        { label: "Broken CSS/JS", value: coverage.brokenAssets, problem: true, severity: "bad", category: "assets", types: ["broken-css", "broken-javascript"] },
        { label: "Unverified asset certificates", value: coverage.unverifiedAssets, problem: true, severity: "warn", category: "assets", types: ["asset-certificate-error"] },
        { label: "Wrong CSS/JS type", value: issueTypesCount(issues, ["css-invalid-content-type", "javascript-invalid-content-type"]), problem: true, severity: "warn", category: "assets", types: ["css-invalid-content-type", "javascript-invalid-content-type"] },
        { label: "Large CSS/JS", value: summary.largeAssets, problem: true, severity: "warn", category: "assets", types: ["large-css", "large-javascript"] },
        { label: "Render-blocking JS", value: summary.renderBlockingScripts, problem: true, severity: "warn", category: "performance", types: ["render-blocking-javascript"] },
        { label: "Too many CSS/JS files", value: issueTypeCount(issues, "too-many-assets"), problem: true, severity: "warn", category: "performance", types: ["too-many-assets"] },
      ],
    },
    {
      title: "Structured",
      text: "Schema, social tags, sharing",
      rows: [
        categoryRow("Schema issues", "warn", "structured-data"),
        { label: "Open Graph issues", value: issueTypesCount(issues, ["open-graph-incomplete", "open-graph-image-missing", "open-graph-image-invalid"]), problem: true, severity: "warn", category: "social", types: ["open-graph-incomplete", "open-graph-image-missing", "open-graph-image-invalid"] },
        { label: "Twitter/X card missing", value: issueTypeCount(issues, "twitter-card-missing"), problem: true, severity: "warn", category: "social", types: ["twitter-card-missing"] },
        categoryRow("Security issues", "bad", "security"),
      ],
    },
  ];
  // Issue types the curated rows above do not name (new crawler checks, for
  // example) still get a row each, so no finding is left out of the matrix.
  const coveredTypes = new Set(sections.flatMap((section) => section.rows.flatMap((row) => row.types || [])));
  const otherTypes = new Map<string, { count: number; category: string; severity: string }>();
  for (const issue of issues) {
    const type = String(issue.type || "");
    if (!type || coveredTypes.has(type)) continue;
    const entry = otherTypes.get(type) || { count: 0, category: String(issue.category || ""), severity: String(issue.severity || "") };
    entry.count += 1;
    if (issue.severity === "high") entry.severity = "high";
    otherTypes.set(type, entry);
  }
  if (otherTypes.size) {
    sections.push({
      title: "Other",
      text: "Further checks from this scan",
      rows: Array.from(otherTypes.entries())
        .sort((a, b) => b[1].count - a[1].count)
        .map(([type, entry]) => ({
          label: catalog.get(type)?.title || humanizeIssueType(type),
          value: entry.count,
          problem: true,
          severity: (catalog.get(type)?.severity || entry.severity) === "high" ? "bad" : "warn",
          category: entry.category || catalog.get(type)?.category || undefined,
          types: [type],
        })),
    });
  }
  const rows = sections.flatMap((section) =>
    section.rows.map((row) => ({
      ...row,
      area: section.title,
      areaText: section.text,
      // What the Issues tab will list for this row: its types among open issues.
      issueCount: row.types?.length ? issueTypesCount(issues, row.types) : 0,
    })),
  );

  return (
    <ReportSection title="Scan checks" description="Every local check grouped into one readable table. Use the issue buttons to open the matching rows.">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Area</TableHead>
            <TableHead>Check</TableHead>
            <TableHead>Count</TableHead>
            <TableHead>Status</TableHead>
            <TableHead className="text-right">Action</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map((row) => <ScanCheckRow key={`${row.area}:${row.label}`} row={row} catalog={catalog} onSelect={onSelectCheck} />)}
        </TableBody>
      </Table>
    </ReportSection>
  );
}

function checkGuidance(catalog: IssueCatalog, types: string[] = []) {
  const entries = types.map((type) => catalog.get(type)).filter((entry) => entry != null);
  const why = entries.find((entry) => entry.why)?.why || "";
  const fixes = Array.from(new Set(entries.map((entry) => entry.fix).filter(Boolean)));
  return { why, fixes };
}

function ScanCheckRow({
  row,
  catalog,
  onSelect,
}: {
  row: ScanCheckRowModel & { area?: string; areaText?: string; issueCount: number };
  catalog: IssueCatalog;
  onSelect: (row: ScanCheckRowModel) => void;
}) {
  // A value the saved scan did not record stays "-", never 0.
  const value = knownNumber(row.value);
  const tone = value === null ? "outline" : row.problem ? (value > 0 ? (row.severity === "bad" ? "bad" : "warn") : "good") : "outline";
  const clickable = Boolean(row.problem && row.issueCount > 0);
  const guidance = checkGuidance(catalog, row.types);
  return (
    <TableRow>
      <TableCell className="min-w-40">
        <div className="font-medium">{row.area}</div>
        <div className="mt-0.5 text-xs text-muted-foreground">{row.areaText}</div>
      </TableCell>
      <TableCell className="min-w-56">
        <div className="flex items-center gap-1.5 font-medium">
          {row.label}
          {guidance.why || guidance.fixes.length ? (
            <InfoTip label={`Why ${row.label} matters and how to fix it`}>
              <span className="block max-w-xs space-y-1.5 text-left">
                {guidance.why ? (
                  <span className="block">
                    <span className="font-semibold">Why it matters: </span>
                    {guidance.why}
                  </span>
                ) : null}
                {guidance.fixes.length ? (
                  <span className="block">
                    <span className="font-semibold">How to fix: </span>
                    {guidance.fixes.join(" ")}
                  </span>
                ) : null}
              </span>
            </InfoTip>
          ) : null}
        </div>
        {row.types?.length ? (
          <div className="mt-0.5 line-clamp-3 text-xs text-muted-foreground">{row.types.map((type) => catalog.get(type)?.title || humanizeIssueType(type)).join(" · ")}</div>
        ) : null}
      </TableCell>
      <TableCell className="metric text-lg">{formatNumber(value)}</TableCell>
      <TableCell>
        <span className="inline-flex items-center gap-1.5 whitespace-nowrap text-sm">
          <StatusDot tone={tone} />
          {value === null ? "not recorded" : row.problem ? (value ? "issues" : "clear") : "evidence"}
        </span>
      </TableCell>
      <TableCell className="text-right">
        {clickable ? (
          <Button size="sm" variant="outline" onClick={() => onSelect(row)}>
            <ListChecks /> Show {formatNumber(row.issueCount)} {row.issueCount === 1 ? "issue" : "issues"}
          </Button>
        ) : null}
      </TableCell>
    </TableRow>
  );
}
