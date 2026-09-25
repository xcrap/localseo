import { useMemo, useState } from "react";
import { ChevronRight, ExternalLink, Eye, EyeOff, LayoutList, ListChecks, PanelRightOpen } from "lucide-react";
import { Badge, Button, Popover, PopoverContent, PopoverTrigger, Select, SelectContent, SelectItem, SelectTrigger, SelectValue, Table, TableBody, TableCell, TableHead, TableHeader, TableRow, ToggleGroup, ToggleGroupItem } from "@/components/ui";
import { EmptyState, formatNumber, issueCategoryLabel } from "../../shared";
import { cn } from "@/lib/utils";
import { TabCard, humanizeIssueType, severityVariant } from "./common";
import { issueGuidance, issueTypeTitle, type IssueCatalog } from "./issue-catalog";

export type IssueGroupMode = "type" | "page";

export type IssueFilters = {
  severity: string;
  category: string;
  type: string;
  checkLabel: string;
  checkTypes: string[];
  page: string;
  showIgnored: boolean;
  groupMode: IssueGroupMode;
};

export type IgnoreScope = "site" | "page" | "page-all";

const ISSUE_SEVERITY_RANK: Record<string, number> = { high: 3, medium: 2, low: 1 };

function worseSeverity(a: string, b: string) {
  return (ISSUE_SEVERITY_RANK[a] || 0) >= (ISSUE_SEVERITY_RANK[b] || 0) ? a : b;
}

export function filterIssues(issues: any[], filters: IssueFilters) {
  return issues.filter((issue: any) => {
    if (filters.severity !== "all" && issue.severity !== filters.severity) return false;
    if (filters.category !== "all" && issue.category !== filters.category) return false;
    if (filters.type !== "all" && issue.type !== filters.type) return false;
    if (filters.checkTypes.length && !filters.checkTypes.includes(issue.type)) return false;
    if (filters.page && issue.url !== filters.page) return false;
    return true;
  });
}

export function ScanIssuesTab({
  scan,
  filters,
  onFiltersChange,
  onResetFilters,
  catalog,
  categories,
  categoryCounts,
  issueTypes,
  activeIssues,
  ignoredIssues,
  filteredIssues,
  ignoreRules,
  onIgnore,
  onRestore,
  onRestoreRules,
  onOpenPage,
}: {
  scan: any;
  filters: IssueFilters;
  onFiltersChange: (changes: Partial<IssueFilters>) => void;
  onResetFilters: () => void;
  catalog: IssueCatalog;
  categories: string[];
  categoryCounts: Record<string, number>;
  issueTypes: string[];
  activeIssues: any[];
  ignoredIssues: any[];
  filteredIssues: any[];
  ignoreRules: any[];
  onIgnore: (issue: any, scope: IgnoreScope) => void;
  onRestore: (issue: any) => void;
  onRestoreRules: (rules: any[]) => void;
  onOpenPage: (url: string) => void;
}) {
  const activeFilterLabels = [
    filters.severity !== "all" ? `${filters.severity} severity` : "",
    filters.category !== "all" ? issueCategoryLabel(filters.category) : "",
    filters.type !== "all" ? issueTypeTitle(catalog, filters.type) : "",
    filters.checkLabel,
    filters.page,
  ].filter(Boolean);
  return (
    <TabCard className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <ToggleGroup
          type="single"
          value={filters.severity}
          onValueChange={(value) => onFiltersChange({ severity: value || "all", category: "all", type: "all", checkLabel: "", checkTypes: [], page: "" })}
          aria-label="Filter by severity"
        >
          {["all", "high", "medium", "low"].map((severity) => (
            <ToggleGroupItem key={severity} value={severity} aria-label={severity === "all" ? "All severities" : `${severity} severity`}>
              {severity === "all" ? "All severities" : severity}
            </ToggleGroupItem>
          ))}
        </ToggleGroup>
        <Select value={filters.category} onValueChange={(category) => onFiltersChange({ category, type: "all", checkLabel: "", checkTypes: [], page: "" })}>
          <SelectTrigger className="h-8 w-44 text-xs" aria-label="Filter by category"><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All categories</SelectItem>
            {categories.map((category) => (
              <SelectItem key={category} value={category}>
                {issueCategoryLabel(category)}
                {categoryCounts[category] ? ` (${formatNumber(categoryCounts[category])})` : ""}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Select value={filters.type} onValueChange={(type) => onFiltersChange({ type, checkLabel: "", checkTypes: [] })}>
          <SelectTrigger className="h-8 w-56 text-xs" aria-label="Filter by issue type"><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All issue types</SelectItem>
            {issueTypes.map((type) => (
              <SelectItem key={type} value={type}>{issueTypeTitle(catalog, type)}</SelectItem>
            ))}
          </SelectContent>
        </Select>
        {filters.checkLabel ? <Badge variant="outline">Showing {filters.checkLabel}</Badge> : null}
        <ToggleGroup
          type="single"
          value={filters.groupMode}
          onValueChange={(value) => value && onFiltersChange({ groupMode: value as IssueGroupMode })}
          aria-label="Group issues"
        >
          <ToggleGroupItem value="type" aria-label="Group issues by type" className="gap-1.5 text-xs">
            <ListChecks /> By type
          </ToggleGroupItem>
          <ToggleGroupItem value="page" aria-label="Group issues by page" className="gap-1.5 text-xs">
            <LayoutList /> By page
          </ToggleGroupItem>
        </ToggleGroup>
        {ignoredIssues.length || ignoreRules.length ? (
          <Button
            size="sm"
            variant={filters.showIgnored ? "secondary" : "outline"}
            className="h-8 text-xs"
            aria-pressed={filters.showIgnored}
            onClick={() =>
              // Entering/leaving the ignored view drops the other filters — a
              // leftover page or check filter would silently hide most rows.
              onFiltersChange({ showIgnored: !filters.showIgnored, severity: "all", category: "all", type: "all", checkLabel: "", checkTypes: [], page: "" })
            }
          >
            <EyeOff /> Ignored ({formatNumber(ignoredIssues.length)})
          </Button>
        ) : null}
        <div className="ml-auto flex items-center gap-1.5 text-[13px] text-muted-foreground">
          <span aria-live="polite">
            {filters.showIgnored
              ? `Showing ${formatNumber(filteredIssues.length)} of ${formatNumber(ignoredIssues.length)} ignored issues`
              : `Showing ${formatNumber(filteredIssues.length)} of ${formatNumber(activeIssues.length)} saved issues`}
            {activeFilterLabels.length ? ` for ${activeFilterLabels.join(" · ")}` : ""}
            {!filters.showIgnored && ignoredIssues.length ? ` · ${formatNumber(ignoredIssues.length)} ignored` : ""}
          </span>
          {activeFilterLabels.length ? (
            <Button size="sm" variant="ghost" className="h-7 px-2 text-xs" onClick={onResetFilters}>
              Clear filters
            </Button>
          ) : null}
        </div>
      </div>
      {filters.showIgnored && ignoreRules.length ? (
        <div className="rounded-lg border border-border/60 px-3.5 py-2.5">
          <p className="text-xs font-medium text-muted-foreground">
            Saved ignore rules for this site — restored issues count for reports and scoring again.
          </p>
          <div className="mt-2 space-y-1.5">
            {ignoreRules.map((rule) => (
              <div key={rule.id} className="flex flex-wrap items-center gap-2 text-xs">
                <Badge variant="outline">{rule.issue_type ? issueTypeTitle(catalog, rule.issue_type) : "all issues"}</Badge>
                <span className="break-all text-muted-foreground">{rule.url || "Whole site"}</span>
                <Button size="sm" variant="ghost" className="h-6 px-2 text-xs" onClick={() => onRestoreRules([rule])}>
                  Restore
                </Button>
              </div>
            ))}
          </div>
        </div>
      ) : null}
      {filteredIssues.length ? (
        <ScanGroupedIssues
          issues={filteredIssues}
          mode={filters.groupMode}
          catalog={catalog}
          showingIgnored={filters.showIgnored}
          onIgnore={onIgnore}
          onRestore={onRestore}
          onOpenPage={onOpenPage}
        />
      ) : (
        <EmptyState
          title={filters.showIgnored ? "No ignored issues" : "No matching issues"}
          text={
            filters.showIgnored
              ? "Issues you ignore stay saved here so you can restore them anytime."
              : scan.status === "completed" ? "This filter has no issues." : "Issues will appear while the scan runs."
          }
        />
      )}
    </TabCard>
  );
}

// Group the already-filtered issue list into collapsible sections — one row per
// issue type ("fix this everywhere") or one row per page ("fix this page").
function buildIssueGroups(issues: any[], mode: IssueGroupMode) {
  const map = new Map<string, any>();
  for (const issue of issues) {
    const key = mode === "type" ? String(issue.type || "issue") : String(issue.url || "—");
    const group = map.get(key) || {
      key,
      severity: "low",
      category: issue.category,
      type: issue.type,
      recommendation: issue.recommendation,
      items: [] as any[],
    };
    if (worseSeverity(group.severity, issue.severity || "low") !== group.severity) {
      group.severity = issue.severity || "low";
    }
    group.items.push(issue);
    map.set(key, group);
  }
  return [...map.values()]
    .map((group) => ({ ...group, count: group.items.length }))
    .sort(
      (a, b) =>
        (ISSUE_SEVERITY_RANK[b.severity] || 0) - (ISSUE_SEVERITY_RANK[a.severity] || 0) || b.count - a.count,
    );
}

const GROUP_ITEM_STEP = 50;

function IssueGuidance({ why, fix }: { why: string; fix: string }) {
  if (!why && !fix) return null;
  return (
    <div className="grid gap-3 border-b border-border/40 px-3.5 py-3 pl-10 text-[13px] leading-5 sm:grid-cols-2">
      {why ? (
        <div>
          <div className="eyebrow-muted mb-1">Why it matters</div>
          <p className="text-muted-foreground">{why}</p>
        </div>
      ) : null}
      {fix ? (
        <div>
          <div className="eyebrow-muted mb-1">How to fix</div>
          <p className="text-muted-foreground">{fix}</p>
        </div>
      ) : null}
    </div>
  );
}

export function ScanGroupedIssues({
  issues,
  mode,
  catalog,
  showingIgnored,
  onIgnore,
  onRestore,
  onOpenPage,
}: {
  issues: any[];
  mode: IssueGroupMode;
  catalog: IssueCatalog;
  showingIgnored?: boolean;
  onIgnore?: (issue: any, scope: IgnoreScope) => void;
  onRestore?: (issue: any) => void;
  onOpenPage?: (url: string) => void;
}) {
  const groups = useMemo(() => buildIssueGroups(issues, mode), [issues, mode]);
  const [expanded, setExpanded] = useState<Record<string, number>>({});
  const toggle = (key: string) =>
    setExpanded((prev) => {
      const next = { ...prev };
      if (next[key]) delete next[key];
      else next[key] = GROUP_ITEM_STEP;
      return next;
    });
  return (
    <div className="divide-y divide-border/60 overflow-hidden rounded-xl border border-border/60">
      {groups.map((group) => {
        const visibleCount = expanded[group.key] || 0;
        const open = visibleCount > 0;
        const unit = mode === "type" ? (group.count === 1 ? "page" : "pages") : group.count === 1 ? "issue" : "issues";
        const title = mode === "type" ? issueTypeTitle(catalog, group.type) : group.key;
        const guidance = mode === "type" ? issueGuidance(catalog, group.type, group.recommendation) : null;
        const panelId = `issue-group-${encodeURIComponent(group.key)}`;
        return (
          <div key={group.key}>
            <div className="flex items-center gap-3 px-3.5 py-3 hover:bg-accent/40">
              <button
                type="button"
                className="flex min-w-0 flex-1 items-center gap-3 rounded-sm text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/60"
                onClick={() => toggle(group.key)}
                aria-expanded={open}
                aria-controls={panelId}
              >
                <ChevronRight aria-hidden className={cn("size-4 shrink-0 text-muted-foreground transition-transform", open && "rotate-90")} />
                <Badge variant={severityVariant(group.severity) as any} className="shrink-0 text-[10.5px] font-semibold uppercase">
                  {group.severity}
                </Badge>
                <div className="min-w-0">
                  <div className={cn("font-medium", mode === "type" ? "truncate" : "break-all")}>{title}</div>
                  <div className="truncate text-xs text-muted-foreground">
                    {mode === "type" ? `${issueCategoryLabel(group.category)} · ${humanizeIssueType(group.type)}` : `${formatNumber(group.count)} ${unit} on this page`}
                  </div>
                </div>
              </button>
              <span className="metric shrink-0 whitespace-nowrap text-sm text-muted-foreground">
                {formatNumber(group.count)} {unit}
              </span>
              {mode === "page" && onOpenPage ? (
                <Button
                  size="icon"
                  variant="ghost"
                  className="size-7 shrink-0 text-muted-foreground hover:text-foreground"
                  aria-label={`Open page details for ${group.key}`}
                  onClick={() => onOpenPage(group.key)}
                >
                  <PanelRightOpen />
                </Button>
              ) : null}
              {!showingIgnored && onIgnore ? (
                <Button
                  size="sm"
                  variant="ghost"
                  className="h-7 shrink-0 px-2 text-xs"
                  aria-label={mode === "type" ? `Ignore ${title} for the whole site` : `Ignore every issue on ${group.key}`}
                  onClick={() =>
                    mode === "type"
                      ? onIgnore(group.items[0], "site")
                      : onIgnore({ type: "", url: group.key }, "page-all")
                  }
                >
                  <EyeOff /> Ignore
                </Button>
              ) : null}
            </div>
            {open ? (
              <div id={panelId} className="border-t border-border/50 bg-muted/20">
                {guidance ? <IssueGuidance why={guidance.why} fix={guidance.fix} /> : null}
                <div className="divide-y divide-border/40">
                  {group.items.slice(0, visibleCount).map((item: any, index: number) => (
                    <IssueItemRow
                      key={`${group.key}:${index}`}
                      item={item}
                      mode={mode}
                      catalog={catalog}
                      onIgnore={onIgnore}
                      onRestore={onRestore}
                      onOpenPage={onOpenPage}
                    />
                  ))}
                </div>
                {group.items.length > visibleCount ? (
                  <div className="px-3.5 py-2 pl-10">
                    <Button
                      size="sm"
                      variant="ghost"
                      className="h-7 px-2 text-xs"
                      onClick={() => setExpanded((prev) => ({ ...prev, [group.key]: visibleCount + GROUP_ITEM_STEP }))}
                    >
                      Show {formatNumber(Math.min(GROUP_ITEM_STEP, group.items.length - visibleCount))} more of {formatNumber(group.items.length - visibleCount)} remaining
                    </Button>
                  </div>
                ) : null}
              </div>
            ) : null}
          </div>
        );
      })}
    </div>
  );
}

function IssueItemRow({
  item,
  mode,
  catalog,
  onIgnore,
  onRestore,
  onOpenPage,
}: {
  item: any;
  mode: IssueGroupMode;
  catalog: IssueCatalog;
  onIgnore?: (issue: any, scope: IgnoreScope) => void;
  onRestore?: (issue: any) => void;
  onOpenPage?: (url: string) => void;
}) {
  const fix = mode === "page" ? issueGuidance(catalog, item.type, item.recommendation).fix : "";
  return (
    <div className="flex items-start gap-3 px-3.5 py-2.5 pl-10 text-sm">
      <div className="min-w-0 flex-1 space-y-1">
        {mode === "type" ? (
          <>
            {item.url && onOpenPage ? (
              <button
                type="button"
                className="block max-w-full break-all rounded-sm text-left font-medium hover:text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/60"
                onClick={() => onOpenPage(item.url)}
                title={`Open page details for ${item.url}`}
              >
                {item.url}
              </button>
            ) : (
              <div className="break-all font-medium">{item.url || "Site-wide"}</div>
            )}
            {item.message ? <div className="text-xs text-muted-foreground">{item.message}</div> : null}
          </>
        ) : (
          <>
            <div className="flex flex-wrap items-center gap-2">
              <Badge variant={severityVariant(item.severity) as any} className="text-[10px] uppercase">{item.severity}</Badge>
              <span className="font-medium">{issueTypeTitle(catalog, item.type)}</span>
            </div>
            {item.message ? <div className="text-xs text-muted-foreground">{item.message}</div> : null}
            {fix ? <div className="text-xs text-muted-foreground"><span className="font-medium text-foreground/80">Fix:</span> {fix}</div> : null}
          </>
        )}
        <EvidenceList evidence={item.evidence} />
      </div>
      <div className="flex shrink-0 items-center gap-1">
        {item.url ? (
          <Button asChild size="icon" variant="ghost" className="size-7 text-muted-foreground hover:text-foreground">
            <a href={item.url} target="_blank" rel="noreferrer" aria-label={`Open ${item.url} in a new tab`}><ExternalLink /></a>
          </Button>
        ) : null}
        {item.ignored && onRestore ? (
          <Button size="sm" variant="secondary" className="h-7 gap-1.5 px-2 text-xs" onClick={() => onRestore(item)}>
            <Eye /> Restore
          </Button>
        ) : !item.ignored && onIgnore ? (
          <Button
            size="sm"
            variant="ghost"
            className="h-7 gap-1.5 px-2 text-xs text-muted-foreground"
            aria-label="Ignore this issue on this page"
            onClick={() => onIgnore(item, "page")}
          >
            <EyeOff /> Ignore
          </Button>
        ) : null}
      </div>
    </div>
  );
}

function evidenceText(value: unknown) {
  if (value == null || value === "") return "-";
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

// Every saved evidence field, in full. Long lists scroll inside their cell
// instead of being cut to a sample.
export function EvidenceList({ evidence }: { evidence: unknown }) {
  const entries = evidence && typeof evidence === "object" ? Object.entries(evidence as Record<string, unknown>) : [];
  if (!entries.length) return null;
  return (
    <dl className="grid gap-x-3 gap-y-1 text-xs leading-5 text-muted-foreground sm:grid-cols-[minmax(6rem,max-content)_minmax(0,1fr)]">
      {entries.map(([key, value]) => (
        <div key={key} className="contents">
          <dt className="font-medium text-foreground/80">{key}</dt>
          <dd className="min-w-0">
            <EvidenceValue value={value} />
          </dd>
        </div>
      ))}
    </dl>
  );
}

function EvidenceValue({ value }: { value: unknown }) {
  if (value == null || value === "") return <span>-</span>;
  if (Array.isArray(value)) {
    const items = value.map((item) => evidenceText(item)).filter((item) => item !== "-");
    if (!items.length) return <span>-</span>;
    return (
      <span className={cn("block space-y-0.5", items.length > 8 ? "max-h-40 overflow-y-auto pr-1" : "")}>
        {items.map((item, index) => (
          <span key={`${item}:${index}`} className="block break-all">{item}</span>
        ))}
        {items.length > 8 ? <span className="sr-only">{formatNumber(items.length)} items</span> : null}
      </span>
    );
  }
  return <span className="break-all">{evidenceText(value)}</span>;
}

export function ScanIssuesTable({
  rows,
  catalog,
  onIgnore,
  onRestore,
  onOpenPage,
}: {
  rows: any[];
  catalog: IssueCatalog;
  onIgnore?: (issue: any, scope: IgnoreScope) => void;
  onRestore?: (issue: any) => void;
  onOpenPage?: (url: string) => void;
}) {
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>Severity</TableHead>
          <TableHead>Issue</TableHead>
          <TableHead>Fix</TableHead>
          <TableHead>Evidence</TableHead>
          <TableHead className="text-right">Open</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {rows.map((issue, index) => (
          <TableRow key={issue.id || `${issue.url}:${issue.message}:${index}`}>
            <TableCell className="align-top"><Badge variant={severityVariant(issue.severity) as any}>{issue.severity}</Badge></TableCell>
            <TableCell className="min-w-72 max-w-lg align-top">
              <div className="font-medium">{issueTypeTitle(catalog, issue.type)}</div>
              {issue.message ? <div className="mt-0.5 text-xs text-muted-foreground">{issue.message}</div> : null}
              {issue.url && onOpenPage ? (
                <button
                  type="button"
                  className="mt-1 block break-all rounded-sm text-left text-xs leading-5 text-muted-foreground hover:text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/60"
                  onClick={() => onOpenPage(issue.url)}
                >
                  {issue.url}
                </button>
              ) : (
                <div className="mt-1 break-all text-xs leading-5 text-muted-foreground">{issue.url || "No page URL saved"}</div>
              )}
              <div className="mt-1.5 text-xs text-muted-foreground">{issueCategoryLabel(issue.category)} · {humanizeIssueType(issue.type)}</div>
            </TableCell>
            <TableCell className="min-w-64 max-w-sm align-top text-sm leading-6 text-muted-foreground">
              {issueGuidance(catalog, issue.type, issue.recommendation).fix || "Inspect this item and update the affected page."}
            </TableCell>
            <TableCell className="min-w-72 max-w-md align-top">
              {issue.evidence && Object.keys(issue.evidence).length ? <EvidenceList evidence={issue.evidence} /> : <span className="text-xs text-muted-foreground">-</span>}
            </TableCell>
            <TableCell className="align-top text-right">
              <div className="flex items-center justify-end gap-1.5">
                {issue.url ? (
                  <Button asChild size="sm" variant="outline">
                    <a href={issue.url} target="_blank" rel="noreferrer">
                      <ExternalLink /> Page
                    </a>
                  </Button>
                ) : null}
                {onRestore && issue.ignored ? (
                  <Button size="sm" variant="outline" onClick={() => onRestore(issue)}>
                    Restore
                  </Button>
                ) : null}
                {onIgnore && !issue.ignored ? (
                  <Popover>
                    <PopoverTrigger asChild>
                      <Button size="sm" variant="ghost" aria-label="Ignore this issue">
                        <EyeOff />
                      </Button>
                    </PopoverTrigger>
                    <PopoverContent align="end" className="w-72 space-y-1 p-2">
                      <p className="px-2 py-1.5 text-xs leading-5 text-muted-foreground">
                        Ignored issues are hidden from this site's reports and scoring. The rule is saved locally and can be restored anytime.
                      </p>
                      {issue.url ? (
                        <Button size="sm" variant="ghost" className="w-full justify-start" onClick={() => onIgnore(issue, "page")}>
                          Ignore on this page only
                        </Button>
                      ) : null}
                      <Button size="sm" variant="ghost" className="w-full justify-start" onClick={() => onIgnore(issue, "site")}>
                        Ignore this issue type site-wide
                      </Button>
                      {issue.url ? (
                        <Button size="sm" variant="ghost" className="w-full justify-start" onClick={() => onIgnore(issue, "page-all")}>
                          Ignore every issue on this page
                        </Button>
                      ) : null}
                    </PopoverContent>
                  </Popover>
                ) : null}
              </div>
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}
