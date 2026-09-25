import { useEffect, useMemo, useState } from "react";
import { useLocation, useNavigate, useSearchParams } from "react-router-dom";
import { api } from "../../../api";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue, Tabs, TabsContent, TabsList, TabsTrigger, toast } from "@/components/ui";
import { EmptyState, ScanLinksTable, formatNumber, ignorePageKey, scanCoverageMetrics, scanSeverityCounts, scanTabs, type ScanCheckRowModel } from "../../shared";
import { FilteredRows } from "../../data-table";
import { CwvPanel } from "../../cwv";
import { TabCard, ScanSection } from "./common";
import { ScanChangesTab } from "./changes";
import { ScanCheckMatrix } from "./checks";
import { ScanCrawlEvidence, ScanRawEvidence, ScanRedirectImpact, ScanSpeedReport } from "./evidence";
import { useIssueCatalog, issueTypeTitle } from "./issue-catalog";
import { ScanIssuesTab, filterIssues, type IgnoreScope, type IssueFilters } from "./issues";
import { ScanActionBoard, ScanRegressionsCard, ScanReportOverview } from "./overview";
import { ScanPageDrawer } from "./page-drawer";
import { ScanProgressPanel } from "./progress";
import { ScanStructuredDataSummary } from "./structured-data";
import { ScanAssetsTable, ScanImageInventoryTable, ScanImageSummaryTable, ScanImagesTable, ScanLinkInventoryTable, ScanMetadataTable, ScanPagesTable, ScanParameterUrlsTable, imageSummarySortValues, pageCsvColumns, pageSortValues } from "./tables";

const scanTabValues = new Set<string>(scanTabs.map((tab) => tab.value));

export function isScanTab(value: string | null): value is string {
  return Boolean(value && scanTabValues.has(value));
}

const severityValues = new Set(["high", "medium", "low"]);

// Issue filters live in the URL so filtered views can be bookmarked and Back
// returns to the previous view instead of leaving the scan.
function filtersFromParams(params: URLSearchParams): IssueFilters {
  const severity = params.get("sev") || "";
  return {
    severity: severityValues.has(severity) ? severity : "all",
    category: params.get("cat") || "all",
    type: params.get("type") || "all",
    checkLabel: params.get("check") || "",
    checkTypes: (params.get("checkTypes") || "").split(",").map((type) => type.trim()).filter(Boolean),
    page: params.get("issuePage") || "",
    showIgnored: params.get("ignored") === "1",
    groupMode: params.get("group") === "page" ? "page" : "type",
  };
}

function filterParams(changes: Partial<IssueFilters>) {
  const params: Record<string, string | null> = {};
  if ("severity" in changes) params.sev = changes.severity && changes.severity !== "all" ? changes.severity : null;
  if ("category" in changes) params.cat = changes.category && changes.category !== "all" ? changes.category : null;
  if ("type" in changes) params.type = changes.type && changes.type !== "all" ? changes.type : null;
  if ("checkLabel" in changes) params.check = changes.checkLabel || null;
  if ("checkTypes" in changes) params.checkTypes = changes.checkTypes?.length ? changes.checkTypes.join(",") : null;
  if ("page" in changes) params.issuePage = changes.page || null;
  if ("showIgnored" in changes) params.ignored = changes.showIgnored ? "1" : null;
  if ("groupMode" in changes) params.group = changes.groupMode === "page" ? "page" : null;
  return params;
}

const clearedIssueFilters: Partial<IssueFilters> = {
  severity: "all",
  category: "all",
  type: "all",
  checkLabel: "",
  checkTypes: [],
  page: "",
};

export function ScanDetail({
  scan: savedScan,
  defaultTab,
  siteRows,
}: {
  scan: any;
  /** Tab shown when the URL names none; seeded once per scan by the page. */
  defaultTab: string;
  siteRows: any[];
}) {
  const [searchParams, setSearchParams] = useSearchParams();
  const location = useLocation();
  const navigate = useNavigate();
  const catalog = useIssueCatalog();
  const [ignoreRules, setIgnoreRules] = useState<any[]>([]);
  // Ignore rules are applied server-side at read time, so after a rule change
  // the freshest report (score, groups, summary) comes from refetching the scan.
  const [refreshedScan, setRefreshedScan] = useState<any>(null);
  const scan =
    refreshedScan?.id === savedScan.id && String(refreshedScan.updated_at || "") >= String(savedScan.updated_at || "")
      ? refreshedScan
      : savedScan;

  const urlTab = searchParams.get("tab");
  const activeTab = isScanTab(urlTab) ? urlTab : defaultTab;
  const filters = useMemo(() => filtersFromParams(searchParams), [searchParams]);
  const compareId = searchParams.get("compare") || "";
  const drawerUrl = searchParams.get("page") || "";

  const report = useMemo(() => {
    const result = scan.result || {};
    const summary = result.summary || {};
    const pages: any[] = result.pages || [];
    const issues: any[] = result.issues || [];
    const comparison = result.comparison || {};
    const comparisonSummary = comparison.summary || {};
    return {
      result,
      summary,
      pages,
      pagesWithImages: pages.filter((page: any) => page.images > 0),
      activeIssues: issues.filter((issue: any) => !issue.ignored),
      ignoredIssues: issues.filter((issue: any) => issue.ignored),
      links: result.links || [],
      linkInventory: result.linkInventory || [],
      images: result.images || [],
      imageInventory: result.imageInventory || [],
      assets: result.assets || [],
      parameterUrls: result.parameterUrls || [],
      issueGroups: result.issueGroups || [],
      comparison,
      comparisonChangeCount: comparison.available
        ? Number(comparisonSummary.newIssues || 0) +
          Number(comparisonSummary.fixedIssues || 0) +
          Number(comparisonSummary.severityChanges || 0) +
          Number(comparisonSummary.pageChanges || 0)
        : 0,
      severityCounts: scanSeverityCounts(scan),
      coverage: scanCoverageMetrics(scan, result, summary),
      // Categories come from the saved summary plus the issues themselves, so a
      // category the summary does not know about is still filterable.
      categories: Array.from(
        new Set<string>([
          ...Object.keys(summary.byCategory || {}),
          ...issues.map((issue: any) => String(issue.category || "")).filter(Boolean),
        ]),
      ).sort(),
      categoryCounts: (summary.byCategory || {}) as Record<string, number>,
      issueTypes: Array.from(new Set<string>(issues.map((issue: any) => String(issue.type || "")).filter(Boolean))).sort(),
    };
  }, [scan]);
  const filteredIssues = useMemo(
    () => filterIssues(filters.showIgnored ? report.ignoredIssues : report.activeIssues, filters),
    [report, filters],
  );
  const ignoredPageKeys = useMemo(
    () => new Set(ignoreRules.filter((rule) => !rule.issue_type && rule.url).map((rule) => ignorePageKey(rule.url))),
    [ignoreRules],
  );
  const drawerPage = useMemo(
    () => (drawerUrl ? report.pages.find((page: any) => page.url === drawerUrl || page.finalUrl === drawerUrl || page.requestedUrl === drawerUrl) : null),
    [report.pages, drawerUrl],
  );

  useEffect(() => {
    setRefreshedScan(null);
  }, [scan.id]);
  useEffect(() => {
    let cancelled = false;
    if (!scan.site_id) return;
    api
      .issueIgnores(scan.site_id)
      .then((rows) => {
        if (!cancelled) setIgnoreRules(rows || []);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [scan.site_id]);

  function writeParams(changes: Record<string, string | null>, options: { push?: boolean; state?: unknown } = {}) {
    const next = new URLSearchParams(searchParams);
    for (const [key, value] of Object.entries(changes)) {
      if (value == null || value === "") next.delete(key);
      else next.set(key, value);
    }
    setSearchParams(next, { replace: !options.push, state: options.state });
  }
  const tabParam = (value: string) => (value === defaultTab ? null : value);
  const changeTab = (value: string) => {
    if (value !== activeTab) writeParams({ tab: tabParam(value) }, { push: true });
  };
  // Filter changes on the Issues tab replace the entry; jumping to Issues from
  // another tab pushes one so Back returns to where the user came from.
  const showIssuesWith = (changes: Partial<IssueFilters>) =>
    writeParams({ ...filterParams(changes), tab: tabParam("issues") }, { push: activeTab !== "issues" });
  const openPage = (url: string) => {
    if (url && url !== drawerUrl) writeParams({ page: url }, { push: true, state: { pageDrawer: true } });
  };
  // Moving between pages inside the open drawer replaces the entry (keeping
  // its state), so closing still returns to where the drawer was opened.
  const switchDrawerPage = (url: string) => {
    if (url && url !== drawerUrl) writeParams({ page: url }, { state: location.state });
  };
  const closePage = () => {
    if ((location.state as { pageDrawer?: boolean } | null)?.pageDrawer) navigate(-1);
    else writeParams({ page: null });
  };

  const refreshIgnoreState = async () => {
    const [rules, row] = await Promise.all([api.issueIgnores(scan.site_id), api.scan(scan.id)]);
    setIgnoreRules(rules || []);
    if (row?.id) setRefreshedScan(row);
  };
  const ignoreIssueType = async (issue: any, scope: IgnoreScope) => {
    try {
      await api.createIssueIgnore(scan.site_id, {
        type: scope === "page-all" ? "" : issue.type,
        url: scope === "site" ? "" : issue.url || "",
      });
      await refreshIgnoreState();
      const title = issueTypeTitle(catalog, issue.type);
      toast.success(
        scope === "page-all"
          ? "Ignoring every issue on this page"
          : scope === "page"
            ? `Ignoring “${title}” on this page`
            : `Ignoring “${title}” for this site`,
      );
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not save the ignore rule");
    }
  };
  const restoreIgnoreRules = async (rules: any[]) => {
    try {
      await Promise.all(rules.map((rule) => api.deleteIssueIgnore(scan.site_id, rule.id)));
      await refreshIgnoreState();
      toast.success(rules.length === 1 ? "Ignore rule removed" : `${rules.length} ignore rules removed`);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not remove the ignore rule");
    }
  };
  const restoreIssue = (issue: any) => {
    const issueKey = ignorePageKey(issue.url || "");
    return restoreIgnoreRules(
      ignoreRules.filter(
        (rule) =>
          (!rule.issue_type || rule.issue_type === issue.type) &&
          (!rule.url || ignorePageKey(rule.url) === issueKey),
      ),
    );
  };
  const togglePageIgnore = (page: any) => {
    const pageKey = ignorePageKey(page.url || "");
    const rule = ignoreRules.find((item) => !item.issue_type && item.url && ignorePageKey(item.url) === pageKey);
    if (rule) return restoreIgnoreRules([rule]);
    return ignoreIssueType({ type: "", url: page.url }, "page-all");
  };

  const selectSeverity = (severity: string) => showIssuesWith({ ...clearedIssueFilters, severity, showIgnored: false });
  const selectIssueGroup = (group: any) =>
    showIssuesWith({ ...clearedIssueFilters, category: group.category || "all", type: group.type || "all", showIgnored: false });
  const selectScanCheck = (row: ScanCheckRowModel) => {
    const types = row.types || [];
    showIssuesWith({
      ...clearedIssueFilters,
      category: row.category || "all",
      type: types.length === 1 ? types[0] : "all",
      checkTypes: types.length > 1 ? types : [],
      checkLabel: types.length > 1 ? row.label : "",
      showIgnored: false,
    });
  };
  const selectPageIssues = (page: any) => showIssuesWith({ ...clearedIssueFilters, page: String(page.url || ""), showIgnored: false });

  const { result, summary, pages, coverage } = report;
  return (
    <div className="space-y-5">
      <Tabs value={activeTab} onValueChange={changeTab} className="space-y-4">
        <div className="sm:hidden">
          <Select value={activeTab} onValueChange={changeTab}>
            <SelectTrigger aria-label="Report section">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {scanTabs.map((tab) => (
                <SelectItem key={tab.value} value={tab.value}>
                  {tab.label}
                  {tab.value === "changes" && report.comparisonChangeCount ? ` (${formatNumber(report.comparisonChangeCount)})` : ""}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <TabsList className="hidden h-auto w-full flex-wrap justify-start gap-y-1 sm:flex">
          {scanTabs.map((tab) => (
            <TabsTrigger key={tab.value} value={tab.value} className={tab.value === "changes" ? "gap-1.5" : undefined}>
              {tab.label}
              {tab.value === "changes" && report.comparisonChangeCount ? (
                <span className="inline-flex min-w-4 items-center justify-center rounded-full bg-warn-soft px-1.5 text-[10px] font-semibold text-warn">
                  {formatNumber(report.comparisonChangeCount)}
                </span>
              ) : null}
            </TabsTrigger>
          ))}
        </TabsList>
        <TabsContent value="overview" className="space-y-5">
          <ScanReportOverview
            scan={scan}
            result={result}
            summary={summary}
            coverage={coverage}
            severityCounts={report.severityCounts}
            activeSeverity={filters.severity}
            onSeveritySelect={selectSeverity}
          />
          <ScanRegressionsCard comparison={report.comparison} onOpenChanges={() => changeTab("changes")} onOpenPage={openPage} />
          <ScanActionBoard
            scan={scan}
            issueGroups={report.issueGroups}
            catalog={catalog}
            onSelectGroup={selectIssueGroup}
            onIgnoreGroup={(group) => ignoreIssueType(group, "site")}
          />
        </TabsContent>
        <TabsContent value="changes" className="space-y-4">
          <ScanChangesTab
            scan={scan}
            savedComparison={report.comparison}
            siteRows={siteRows}
            compareId={compareId}
            catalog={catalog}
            onCompareChange={(baseId) => writeParams({ compare: baseId || null })}
          />
        </TabsContent>
        <TabsContent value="progress">
          <ScanProgressPanel scan={scan} result={result} coverage={coverage} />
        </TabsContent>
        <TabsContent value="issues">
          <ScanIssuesTab
            scan={scan}
            filters={filters}
            onFiltersChange={(changes) => writeParams(filterParams(changes))}
            onResetFilters={() => writeParams(filterParams(clearedIssueFilters))}
            catalog={catalog}
            categories={report.categories}
            categoryCounts={report.categoryCounts}
            issueTypes={report.issueTypes}
            activeIssues={report.activeIssues}
            ignoredIssues={report.ignoredIssues}
            filteredIssues={filteredIssues}
            ignoreRules={ignoreRules}
            onIgnore={ignoreIssueType}
            onRestore={restoreIssue}
            onRestoreRules={restoreIgnoreRules}
            onOpenPage={openPage}
          />
        </TabsContent>
        <TabsContent value="checks">
          <ScanCheckMatrix summary={summary} coverage={coverage} issues={report.activeIssues} catalog={catalog} onSelectCheck={selectScanCheck} />
        </TabsContent>
        <TabsContent value="metadata" className="space-y-4">
          <ScanStructuredDataSummary pages={pages} onOpenPage={openPage} />
          <TabCard>
            {pages.length ? (
              <FilteredRows rows={pages} placeholder="Filter pages…" csvName="page-metadata" csvColumns={pageCsvColumns} sortValues={pageSortValues}>
                {(rows) => <ScanMetadataTable rows={rows} onOpenPage={openPage} />}
              </FilteredRows>
            ) : <EmptyState title="No metadata yet" text="Metadata appears as soon as pages are crawled." />}
          </TabCard>
        </TabsContent>
        <TabsContent value="pages">
          <TabCard>
            {pages.length ? (
              <FilteredRows rows={pages} placeholder="Filter pages…" csvName="pages" csvColumns={pageCsvColumns} sortValues={pageSortValues}>
                {(rows) => (
                  <ScanPagesTable
                    rows={rows}
                    onShowIssues={selectPageIssues}
                    onTogglePageIgnore={togglePageIgnore}
                    onOpenPage={openPage}
                    ignoredPageKeys={ignoredPageKeys}
                  />
                )}
              </FilteredRows>
            ) : <EmptyState title="No pages yet" text="Pages will appear while the scan runs." />}
          </TabCard>
        </TabsContent>
        <TabsContent value="links">
          <div className="space-y-4">
            <ScanRedirectImpact coverage={coverage} links={report.links} />
            {report.links.length ? (
              <ScanSection title="Checked links" text="Every unique HTTP URL the crawler verified, including source-page blast radius, reference count, redirect hops, and final response.">
                <FilteredRows rows={report.links} placeholder="Filter links…" csvName="checked-links">
                  {(rows) => <ScanLinksTable rows={rows} />}
                </FilteredRows>
              </ScanSection>
            ) : <EmptyState title="No links checked yet" text="Links are checked after the page crawl finishes." />}
            {report.linkInventory.length ? (
              <ScanSection title="Link inventory" text="All link tags found during the crawl, including anchor text, rel attributes, and source page.">
                <FilteredRows rows={report.linkInventory} placeholder="Filter link tags…" csvName="link-inventory">
                  {(rows) => <ScanLinkInventoryTable rows={rows} />}
                </FilteredRows>
              </ScanSection>
            ) : null}
            {report.parameterUrls.length ? (
              <ScanSection title="Parameter URLs" text="Links with query strings. They are checked as links but crawled once as their clean page URL, so they are not counted as separate pages.">
                <FilteredRows rows={report.parameterUrls} placeholder="Filter parameter URLs…" csvName="parameter-urls">
                  {(rows) => <ScanParameterUrlsTable rows={rows} />}
                </FilteredRows>
              </ScanSection>
            ) : null}
          </div>
        </TabsContent>
        <TabsContent value="images" className="space-y-4">
          {report.pagesWithImages.length ? (
            <ScanSection title="Image summary by page" text="Missing src, alt text, and size attributes grouped by affected page.">
              <FilteredRows rows={report.pagesWithImages} placeholder="Filter pages…" csvName="image-summary" sortValues={imageSummarySortValues}>
                {(rows) => <ScanImageSummaryTable rows={rows} onOpenPage={openPage} />}
              </FilteredRows>
            </ScanSection>
          ) : null}
          {report.imageInventory.length ? (
            <ScanSection title="Image tag inventory" text="Every image tag collected from the crawl, including content/decorative classification and tag-level problems.">
              <FilteredRows rows={report.imageInventory} placeholder="Filter image tags…" csvName="image-inventory">
                {(rows) => <ScanImageInventoryTable rows={rows} />}
              </FilteredRows>
            </ScanSection>
          ) : null}
          {report.images.length ? (
            <ScanSection title="Checked image URLs" text="Image resources fetched by the crawler, including Open Graph images when present.">
              <FilteredRows rows={report.images} placeholder="Filter image URLs…" csvName="checked-images">
                {(rows) => <ScanImagesTable rows={rows} />}
              </FilteredRows>
            </ScanSection>
          ) : <EmptyState title="No images checked yet" text="Images are checked after the page crawl finishes." />}
        </TabsContent>
        <TabsContent value="assets" className="space-y-4">
          {report.assets.length ? (
            <ScanSection title="Checked CSS and JavaScript" text="Stylesheet and script URLs fetched during the scan with status, content type, and size.">
              <FilteredRows rows={report.assets} placeholder="Filter assets…" csvName="css-js-assets">
                {(rows) => <ScanAssetsTable rows={rows} />}
              </FilteredRows>
            </ScanSection>
          ) : <EmptyState title="No CSS or JavaScript assets checked yet" text="Assets are checked after links and images." />}
        </TabsContent>
        <TabsContent value="speed" className="space-y-4">
          {scan.site_id ? <CwvPanel siteId={scan.site_id} suggestedUrls={[result.startUrl || scan.url]} /> : null}
          <ScanSpeedReport pages={pages} issues={report.activeIssues} assets={report.assets} summary={summary} coverage={coverage} catalog={catalog} onOpenPage={openPage} />
        </TabsContent>
        <TabsContent value="crawl" className="space-y-4">
          <ScanCrawlEvidence result={result} coverage={coverage} siteId={scan.site_id} startUrl={result.startUrl || scan.url} />
        </TabsContent>
        <TabsContent value="raw">
          <ScanRawEvidence scan={scan} result={result} />
        </TabsContent>
      </Tabs>
      <ScanPageDrawer
        scanId={scan.id}
        pageUrl={drawerUrl}
        localPage={drawerPage}
        catalog={catalog}
        onClose={closePage}
        onOpenPage={switchDrawerPage}
      />
    </div>
  );
}
