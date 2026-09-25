import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { useNavigate } from "react-router-dom";
import { Bot, CalendarClock, CheckCheck, Download, FileSearch, Gauge, Globe, LayoutGrid, Lightbulb, ListTree, Printer, RefreshCw, Search, Settings } from "lucide-react";
import { api, type ScanRow, type Site } from "../api";
import { Dialog, DialogContent, DialogDescription, DialogTitle, Input, toast } from "@/components/ui";
import { cn } from "@/lib/utils";
import { tableFilterSelector } from "./data-table";
import { announceNotificationsChanged } from "./notifications";
import { formatDate, formatNumber, getSelectedScanId, insightTabs, navItems, scanStatusLabel, scanTabs, siteDisplayName, sortScanRows } from "./shared";

type Command = {
  id: string;
  group: string;
  label: string;
  detail?: string;
  keywords?: string;
  icon: any;
  run: () => void;
};

const RECENT_SCAN_COUNT = 8;

export function shortcutLabel() {
  const platform = typeof navigator !== "undefined" ? navigator.platform || navigator.userAgent : "";
  return /mac|iphone|ipad/i.test(platform) ? "⌘K" : "Ctrl K";
}

function isEditableTarget(target: EventTarget | null) {
  const element = target as HTMLElement | null;
  if (!element) return false;
  const tag = element.tagName;
  return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || element.isContentEditable;
}

// Global keyboard shortcuts: ⌘K / Ctrl+K toggles the command palette and "/"
// focuses the filter of the table on screen.
export function useAppShortcuts(onTogglePalette: () => void) {
  const toggleRef = useRef(onTogglePalette);
  toggleRef.current = onTogglePalette;
  useEffect(() => {
    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && !event.altKey && event.key.toLowerCase() === "k") {
        event.preventDefault();
        toggleRef.current();
        return;
      }
      if (event.key === "/" && !event.metaKey && !event.ctrlKey && !event.altKey && !isEditableTarget(event.target)) {
        const filter = Array.from(document.querySelectorAll<HTMLInputElement>(tableFilterSelector)).find(
          (element) => element.offsetParent !== null,
        );
        if (filter) {
          event.preventDefault();
          filter.focus();
          filter.select();
        }
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);
}

export function CommandPalette({
  open,
  onOpenChange,
  sites,
  activeSite,
  onSelectSite,
  onScanActiveSite,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  sites: Site[];
  activeSite?: Site | null;
  onSelectSite: (id: string) => void;
  onScanActiveSite?: () => void;
}) {
  const navigate = useNavigate();
  const listId = useId();
  const [query, setQuery] = useState("");
  const [activeIndex, setActiveIndex] = useState(0);
  const [scans, setScans] = useState<ScanRow[]>([]);
  const listRef = useRef<HTMLDivElement>(null);
  const activeSiteId = activeSite?.id || "";

  useEffect(() => {
    if (!open) return;
    setQuery("");
    setActiveIndex(0);
    if (!activeSiteId) {
      setScans([]);
      return;
    }
    let cancelled = false;
    api
      .scans(activeSiteId)
      .then((rows) => {
        if (!cancelled) setScans(sortScanRows(rows));
      })
      .catch(() => {
        if (!cancelled) setScans([]);
      });
    return () => {
      cancelled = true;
    };
  }, [open, activeSiteId]);

  const commands = useMemo(() => {
    const go = (path: string) => () => navigate(path);
    const list: Command[] = [];
    for (const item of navItems) {
      list.push({ id: `page:${item.to}`, group: "Pages", label: item.label, icon: item.icon, run: go(item.to) });
    }
    list.push({ id: "page:/", group: "Pages", label: "All sites", icon: LayoutGrid, run: go("/") });
    list.push({ id: "page:/settings", group: "Pages", label: "Settings", icon: Settings, run: go("/settings") });
    for (const site of sites) {
      list.push({
        id: `site:${site.id}`,
        group: "Sites",
        label: siteDisplayName(site),
        detail: site.id === activeSiteId ? `${site.domain || "No address"} · active` : site.domain || "No address",
        keywords: site.domain,
        icon: Globe,
        run: () => {
          onSelectSite(site.id);
          navigate("/overview");
        },
      });
    }
    if (activeSiteId) {
      const scanId = getSelectedScanId(activeSiteId);
      const scanPath = (tab: string) => (scanId ? `/scans/${scanId}?tab=${tab}` : `/scans?tab=${tab}`);
      // Report actions use the scan open on the scans page when it finished,
      // else the newest completed scan.
      const reportScan =
        scans.find((scan) => scan.id === scanId && scan.status === "completed") ||
        scans.find((scan) => scan.status === "completed") ||
        null;
      if (activeSite?.domain) {
        list.push({
          id: "action:scan",
          group: "Actions",
          label: `Scan ${activeSite.domain} now`,
          keywords: "start crawl site scan run",
          icon: FileSearch,
          run: () => onScanActiveSite?.(),
        });
      }
      list.push({
        id: "action:cwv",
        group: "Actions",
        label: "Run a Core Web Vitals check",
        detail: "Speed tab",
        keywords: "cwv pagespeed lighthouse lcp inp cls performance",
        icon: Gauge,
        run: go(scanPath("speed")),
      });
      if (reportScan) {
        list.push({
          id: "action:report-download",
          group: "Actions",
          label: "Download scan report",
          detail: formatDate(reportScan.created_at),
          keywords: "client report html export",
          icon: Download,
          run: () => {
            const link = document.createElement("a");
            link.href = api.scanReportUrl(reportScan.id, true);
            link.download = "";
            document.body.appendChild(link);
            link.click();
            link.remove();
          },
        });
        list.push({
          id: "action:report-open",
          group: "Actions",
          label: "Open printable scan report",
          detail: formatDate(reportScan.created_at),
          keywords: "client report print pdf",
          icon: Printer,
          run: () => window.open(api.scanReportUrl(reportScan.id), "_blank", "noopener"),
        });
        list.push({
          id: "action:codex-prioritise",
          group: "Actions",
          label: "Prioritise fixes with Codex",
          detail: "Scan overview",
          keywords: "ai codex prioritize fixes plan",
          icon: Bot,
          run: go(`/scans/${reportScan.id}?tab=overview`),
        });
      }
      list.push({
        id: "action:schedule",
        group: "Actions",
        label: "Schedule site scans",
        detail: "Overview",
        keywords: "schedule recurring automatic daily weekly monthly",
        icon: CalendarClock,
        run: go("/overview"),
      });
      list.push({
        id: "action:gsc-sync",
        group: "Actions",
        label: "Sync Search Console from Google",
        keywords: "gsc google import performance",
        icon: RefreshCw,
        run: go("/gsc?tab=sync"),
      });
      list.push({
        id: "action:notifications-read",
        group: "Actions",
        label: "Mark all notifications read",
        keywords: "alerts bell clear",
        icon: CheckCheck,
        run: () => {
          api
            .markAllNotificationsRead()
            .then(announceNotificationsChanged)
            .catch((err) => toast.error(err instanceof Error ? err.message : "Could not mark notifications read"));
        },
      });
      for (const tab of scanTabs) {
        list.push({
          id: `tab:${tab.value}`,
          group: "Scan report",
          label: `Scan · ${tab.label}`,
          keywords: "scan report tab",
          icon: ListTree,
          run: go(scanPath(tab.value)),
        });
      }
      for (const tab of insightTabs) {
        list.push({
          id: `insights:${tab.value}`,
          group: "Insights",
          label: `Insights · ${tab.label}`,
          keywords: "search console gsc insights",
          icon: Lightbulb,
          run: go(`/insights?tab=${tab.value}`),
        });
      }
    }
    for (const scan of scans) {
      list.push({
        id: `scan:${scan.id}`,
        group: "Recent scans",
        label: scan.url,
        detail: `${formatDate(scan.created_at || scan.updated_at)} · ${scan.status === "completed" ? `${formatNumber(Number(scan.score || 0))}% · ${formatNumber(scan.issue_count || 0)} issues` : scanStatusLabel(scan.status)}`,
        keywords: "scan",
        icon: FileSearch,
        run: go(`/scans/${scan.id}`),
      });
    }
    return list;
  }, [sites, activeSiteId, activeSite?.domain, scans, navigate, onSelectSite, onScanActiveSite]);

  const results = useMemo(() => {
    const terms = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
    if (!terms.length) {
      // Without a query, recent scans are limited to the newest few; typing
      // searches every saved scan for the site.
      let recent = 0;
      return commands.filter((command) => command.group !== "Recent scans" || recent++ < RECENT_SCAN_COUNT);
    }
    return commands.filter((command) => {
      const haystack = `${command.group} ${command.label} ${command.detail || ""} ${command.keywords || ""}`.toLowerCase();
      return terms.every((term) => haystack.includes(term));
    });
  }, [commands, query]);

  const current = Math.min(activeIndex, Math.max(0, results.length - 1));

  useEffect(() => {
    listRef.current?.querySelector(`[data-index="${current}"]`)?.scrollIntoView({ block: "nearest" });
  }, [current]);

  function runCommand(command: Command | undefined) {
    if (!command) return;
    onOpenChange(false);
    command.run();
  }

  function onKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key === "ArrowDown") {
      event.preventDefault();
      setActiveIndex(results.length ? (current + 1) % results.length : 0);
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      setActiveIndex(results.length ? (current - 1 + results.length) % results.length : 0);
    } else if (event.key === "Enter") {
      event.preventDefault();
      runCommand(results[current]);
    }
  }

  let lastGroup = "";
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="top-[12vh] max-w-xl translate-y-0 gap-0 overflow-hidden p-0">
        <DialogTitle className="sr-only">Command palette</DialogTitle>
        <DialogDescription className="sr-only">Jump to a page, site, scan report section, insight, or recent scan, or run an action.</DialogDescription>
        <div className="flex items-center gap-2 border-b border-border/70 px-3.5">
          <Search aria-hidden className="size-4 shrink-0 text-muted-foreground" />
          <Input
            autoFocus
            value={query}
            onChange={(event) => {
              setQuery(event.target.value);
              setActiveIndex(0);
            }}
            onKeyDown={onKeyDown}
            placeholder="Jump to a page, site, or scan…"
            role="combobox"
            aria-expanded="true"
            aria-controls={listId}
            aria-activedescendant={results[current] ? `${listId}-${current}` : undefined}
            aria-label="Command"
            className="h-12 rounded-none border-0 bg-transparent px-0 text-[15px] hover:bg-transparent focus:bg-transparent focus-visible:ring-0"
          />
        </div>
        <div ref={listRef} id={listId} role="listbox" aria-label="Commands" className="max-h-[min(60vh,28rem)] overflow-y-auto p-1.5">
          {results.length ? (
            results.map((command, index) => {
              const showGroup = command.group !== lastGroup;
              lastGroup = command.group;
              const Icon = command.icon;
              return (
                <div key={command.id}>
                  {showGroup ? (
                    <div className="px-2.5 pb-1 pt-2.5 text-[10px] font-semibold uppercase tracking-[0.16em] text-muted-foreground/70" aria-hidden>
                      {command.group}
                    </div>
                  ) : null}
                  <div
                    id={`${listId}-${index}`}
                    role="option"
                    tabIndex={-1}
                    aria-selected={index === current}
                    data-index={index}
                    onMouseMove={() => index !== current && setActiveIndex(index)}
                    onClick={() => runCommand(command)}
                    onKeyDown={(event) => event.key === "Enter" && runCommand(command)}
                    className={cn(
                      "flex cursor-pointer items-center gap-2.5 rounded-md px-2.5 py-2 text-sm",
                      index === current ? "bg-accent text-accent-foreground" : "text-foreground/90",
                    )}
                  >
                    <Icon aria-hidden className="size-4 shrink-0 text-muted-foreground" />
                    <span className="min-w-0 flex-1 truncate">{command.label}</span>
                    {command.detail ? <span className="hidden shrink-0 truncate text-xs text-muted-foreground sm:block sm:max-w-[45%]">{command.detail}</span> : null}
                  </div>
                </div>
              );
            })
          ) : (
            <p className="px-3 py-6 text-center text-sm text-muted-foreground">No matches for “{query}”.</p>
          )}
        </div>
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1 border-t border-border/70 px-3.5 py-2 text-[11px] text-muted-foreground">
          <span>↑↓ to move · Enter to open · Esc to close</span>
          <span>Press / on a report to filter its table</span>
        </div>
      </DialogContent>
    </Dialog>
  );
}
