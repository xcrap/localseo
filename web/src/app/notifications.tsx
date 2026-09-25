import { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { AlertTriangle, Bell, BellRing, CheckCheck, FileWarning, Target, Trash2, TrendingDown } from "lucide-react";
import { api, type AppNotification, type ScanRegressionNotificationData } from "../api";
import { Button, Popover, PopoverContent, PopoverTrigger, Tooltip, TooltipContent, TooltipTrigger, toast } from "@/components/ui";
import { cn } from "@/lib/utils";
import { formatDate, formatNumber, knownNumber } from "./shared";

const POLL_MS = 60_000;
const LIST_LIMIT = 30;
const desktopAlertsKey = "local-seo:desktop-alerts";

// Other screens (e.g. the command palette) dispatch this after changing
// notification state so the bell refreshes at once instead of on the next poll.
export const notificationsChangedEvent = "local-seo:notifications-changed";

export function announceNotificationsChanged() {
  window.dispatchEvent(new Event(notificationsChangedEvent));
}

const typeIcons: Record<string, any> = {
  "scan-regression": TrendingDown,
  "scan-failed": FileWarning,
  "rank-run-problem": Target,
};

// Where a notification leads. Scan regressions open the Changes tab compared
// against the scan the regression was measured from.
export function notificationPath(notification: AppNotification) {
  const data = notification.data || {};
  const scanId = typeof data.scanId === "string" ? data.scanId : "";
  if (notification.type === "scan-regression" && scanId) {
    const baseId = typeof data.baseScanId === "string" ? data.baseScanId : "";
    return `/scans/${scanId}?tab=changes${baseId ? `&compare=${encodeURIComponent(baseId)}` : ""}`;
  }
  if (notification.type === "scan-failed" && scanId) return `/scans/${scanId}`;
  if (notification.type === "rank-run-problem") return "/rank";
  return scanId ? `/scans/${scanId}` : "/overview";
}

function plural(count: number, word: string) {
  return `${formatNumber(count)} ${word}${count === 1 ? "" : "s"}`;
}

// Counts for a scan-regression notice, each labelled on its own: regressed
// pages never include new issues. Older notices only stored a `regressions`
// object whose total mixed pages and issues, so their page count stays unknown.
function scanRegressionCounts(data: ScanRegressionNotificationData | null | undefined) {
  const legacy = data?.regressions;
  const pages = knownNumber(data?.pageRegressions);
  const high = knownNumber(data?.newHighIssues) ?? knownNumber(legacy?.newHighIssues);
  const medium = knownNumber(data?.newMediumIssues) ?? knownNumber(legacy?.newMediumIssues);
  return [
    pages !== null ? plural(pages, "regressed page") : "",
    high ? plural(high, "new high issue") : "",
    medium ? plural(medium, "new medium issue") : "",
  ].filter(Boolean);
}

function desktopAlertsSupported() {
  return typeof window !== "undefined" && "Notification" in window;
}

function readDesktopPreference() {
  try {
    return localStorage.getItem(desktopAlertsKey) === "on";
  } catch {
    return false;
  }
}

function writeDesktopPreference(on: boolean) {
  try {
    if (on) localStorage.setItem(desktopAlertsKey, "on");
    else localStorage.removeItem(desktopAlertsKey);
  } catch {
    // Browser storage can be unavailable; the toggle then lasts for this tab only.
  }
}

export function NotificationBell({
  onSelectSite,
}: {
  /** Switches the workspace to a notification's site before opening it. */
  onSelectSite?: (siteId: string, options?: { keepPath?: boolean }) => void;
}) {
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  const [rows, setRows] = useState<AppNotification[]>([]);
  const [unreadCount, setUnreadCount] = useState(0);
  const [error, setError] = useState("");
  const [confirmDelete, setConfirmDelete] = useState("");
  const [desktopOn, setDesktopOn] = useState(
    () => desktopAlertsSupported() && Notification.permission === "granted" && readDesktopPreference(),
  );
  const seenIds = useRef<Set<string> | null>(null);
  const desktopRef = useRef(desktopOn);
  desktopRef.current = desktopOn;
  const openRef = useRef<(notification: AppNotification) => void>(() => {});

  async function load() {
    try {
      const data = await api.notifications({ limit: LIST_LIMIT });
      const nextRows = Array.isArray(data?.rows) ? data.rows : [];
      setRows(nextRows);
      setUnreadCount(Number(data?.unreadCount || 0));
      setError("");
      // Desktop alerts fire only for unread items that arrive while the app is
      // open, never for the backlog found on the first load.
      const seen = seenIds.current;
      if (seen && desktopRef.current && desktopAlertsSupported() && Notification.permission === "granted") {
        for (const row of nextRows) {
          if (row.read_at || seen.has(row.id)) continue;
          const alert = new Notification(row.title, { body: row.body, tag: row.id });
          alert.onclick = () => {
            window.focus();
            openRef.current(row);
            alert.close();
          };
        }
      }
      seenIds.current = new Set([...(seen || []), ...nextRows.map((row) => row.id)]);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not load notifications");
    }
  }

  // One sequential poller; it pauses while the tab is hidden and refreshes as
  // soon as the tab is visible again.
  useEffect(() => {
    let cancelled = false;
    let timer = 0;
    const schedule = () => {
      window.clearTimeout(timer);
      if (!cancelled && document.visibilityState === "visible") timer = window.setTimeout(tick, POLL_MS);
    };
    const tick = async () => {
      await load();
      schedule();
    };
    const onVisibility = () => {
      if (document.visibilityState === "visible") tick();
      else window.clearTimeout(timer);
    };
    const onChanged = () => {
      load();
    };
    tick();
    document.addEventListener("visibilitychange", onVisibility);
    window.addEventListener(notificationsChangedEvent, onChanged);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
      document.removeEventListener("visibilitychange", onVisibility);
      window.removeEventListener(notificationsChangedEvent, onChanged);
    };
  }, []);

  useEffect(() => {
    if (open) load();
    else setConfirmDelete("");
  }, [open]);

  async function markRead(notification: AppNotification) {
    if (notification.read_at) return;
    setRows((current) => current.map((row) => (row.id === notification.id ? { ...row, read_at: new Date().toISOString() } : row)));
    setUnreadCount((count) => Math.max(0, count - 1));
    try {
      await api.markNotificationRead(notification.id);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not mark the notification read");
      load();
    }
  }

  function openNotification(notification: AppNotification) {
    setOpen(false);
    markRead(notification);
    if (notification.site_id) onSelectSite?.(notification.site_id, { keepPath: true });
    navigate(notificationPath(notification));
  }
  openRef.current = openNotification;

  async function markAllRead() {
    try {
      await api.markAllNotificationsRead();
      await load();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not mark notifications read");
    }
  }

  async function remove(notification: AppNotification) {
    setConfirmDelete("");
    try {
      await api.deleteNotification(notification.id);
      await load();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not delete the notification");
    }
  }

  async function toggleDesktopAlerts() {
    if (!desktopAlertsSupported()) return;
    if (desktopOn) {
      writeDesktopPreference(false);
      setDesktopOn(false);
      return;
    }
    const permission = Notification.permission === "default" ? await Notification.requestPermission() : Notification.permission;
    if (permission !== "granted") {
      toast.error("Desktop alerts are blocked for this app in the browser settings.");
      return;
    }
    writeDesktopPreference(true);
    setDesktopOn(true);
    toast.success("Desktop alerts on. They appear for new items while this app is open.");
  }

  const badge = unreadCount > 9 ? "9+" : String(unreadCount);
  const permissionDenied = desktopAlertsSupported() && Notification.permission === "denied";
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <Tooltip>
        <TooltipTrigger asChild>
          <PopoverTrigger asChild>
            <Button
              variant="ghost"
              size="icon"
              className="relative size-8 text-muted-foreground hover:text-foreground"
              aria-label={unreadCount ? `Notifications, ${unreadCount} unread` : "Notifications"}
            >
              {unreadCount ? <BellRing /> : <Bell />}
              {unreadCount ? (
                <span className="nums absolute -right-0.5 -top-0.5 inline-flex h-4 min-w-4 items-center justify-center rounded-full bg-primary px-1 text-[10px] font-semibold leading-none text-primary-foreground">
                  {badge}
                </span>
              ) : null}
            </Button>
          </PopoverTrigger>
        </TooltipTrigger>
        <TooltipContent>Notifications</TooltipContent>
      </Tooltip>
      <PopoverContent align="end" className="w-[min(24rem,calc(100vw-1.5rem))] p-0">
        <div className="flex items-center justify-between gap-2 border-b border-border/70 px-3.5 py-2.5">
          <div className="text-sm font-semibold">
            Notifications
            {unreadCount ? <span className="ml-1.5 font-normal text-muted-foreground">{unreadCount} unread</span> : null}
          </div>
          <Button size="sm" variant="ghost" className="h-7 px-2 text-xs" onClick={markAllRead} disabled={!unreadCount}>
            <CheckCheck /> Mark all read
          </Button>
        </div>
        <div className="max-h-[min(60vh,26rem)] overflow-y-auto">
          {error && !rows.length ? (
            <p className="px-3.5 py-6 text-center text-sm text-muted-foreground">
              <AlertTriangle className="mx-auto mb-2 size-4" />
              {error}
            </p>
          ) : rows.length ? (
            <ul className="divide-y divide-border/60">
              {rows.map((row) => {
                const Icon = typeIcons[row.type] || Bell;
                const unread = !row.read_at;
                const counts = row.type === "scan-regression" ? scanRegressionCounts(row.data) : [];
                return (
                  <li key={row.id} className={cn("group flex items-start gap-2.5 px-3.5 py-2.5", unread ? "bg-primary/[0.04]" : "")}>
                    <Icon aria-hidden className={cn("mt-0.5 size-4 shrink-0", unread ? "text-primary" : "text-muted-foreground")} />
                    <button
                      type="button"
                      onClick={() => openNotification(row)}
                      className="min-w-0 flex-1 rounded-sm text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/60"
                    >
                      <span className={cn("block text-sm leading-5", unread ? "font-semibold" : "font-medium text-foreground/85")}>
                        {unread ? <span className="sr-only">Unread: </span> : null}
                        {row.title}
                      </span>
                      {row.body ? <span className="mt-0.5 line-clamp-2 block text-xs leading-5 text-muted-foreground">{row.body}</span> : null}
                      {counts.length ? <span className="nums mt-0.5 block text-xs font-medium text-foreground/80">{counts.join(" · ")}</span> : null}
                      <span className="mt-1 block text-[11px] text-muted-foreground/80">
                        {row.site_name ? `${row.site_name} · ` : ""}
                        {formatDate(row.created_at)}
                      </span>
                    </button>
                    {confirmDelete === row.id ? (
                      <Button size="sm" variant="destructive" className="h-7 px-2 text-xs" onClick={() => remove(row)} onBlur={() => setConfirmDelete("")}>
                        Delete
                      </Button>
                    ) : (
                      <Button
                        size="icon"
                        variant="ghost"
                        className="size-7 shrink-0 text-muted-foreground opacity-60 hover:text-bad group-hover:opacity-100"
                        aria-label={`Delete notification: ${row.title}`}
                        onClick={() => setConfirmDelete(row.id)}
                      >
                        <Trash2 />
                      </Button>
                    )}
                  </li>
                );
              })}
            </ul>
          ) : (
            <p className="px-3.5 py-8 text-center text-sm text-muted-foreground">
              No notifications. Scan regressions, failed scans, and rank check problems appear here.
            </p>
          )}
        </div>
        {desktopAlertsSupported() ? (
          <div className="flex flex-wrap items-center justify-between gap-2 border-t border-border/70 px-3.5 py-2 text-[11px] text-muted-foreground">
            <span>
              {permissionDenied
                ? "Desktop alerts are blocked in browser settings."
                : desktopOn
                  ? "Desktop alerts on while this app is open."
                  : "Get a desktop alert for new items while the app is open."}
            </span>
            {!permissionDenied ? (
              <Button size="sm" variant="ghost" className="h-7 px-2 text-xs" onClick={toggleDesktopAlerts}>
                {desktopOn ? "Turn off" : "Enable desktop alerts"}
              </Button>
            ) : null}
          </div>
        ) : null}
      </PopoverContent>
    </Popover>
  );
}
