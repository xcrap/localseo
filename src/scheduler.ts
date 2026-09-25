import { all, get, run } from "./db";
import { badRequest, notFound } from "./errors";
import { createNotification } from "./notifications";
import { getScan, startScan } from "./scans";
import { startRankCheck } from "./seo";
import { resolveSavedSiteScanUrl, unreachableScanUrlError } from "./site-scan-url";

// In-process scheduler for recurring site scans and rank checks, plus the
// notifications raised when scans or scheduled rank checks finish. All state
// lives in SQLite (next run times, notified_at checkpoints), so a restart
// resumes from the database. Every schedule is off until the user sets one.

export const SCHEDULE_INTERVALS = ["off", "daily", "weekly", "monthly"] as const;
export type ScheduleInterval = (typeof SCHEDULE_INTERVALS)[number];

const DAY_MS = 24 * 60 * 60 * 1000;

// Rank trackers were created with schedule_interval 'manual'; any value
// outside the set reads as 'off'.
export function normalizeInterval(value: unknown): ScheduleInterval {
  return SCHEDULE_INTERVALS.includes(value as ScheduleInterval) ? (value as ScheduleInterval) : "off";
}

function requireInterval(value: unknown, field: string) {
  if (!SCHEDULE_INTERVALS.includes(value as ScheduleInterval)) {
    throw badRequest(`${field} must be one of: ${SCHEDULE_INTERVALS.join(", ")}.`);
  }
  return value as ScheduleInterval;
}

function addInterval(date: Date, interval: ScheduleInterval) {
  const next = new Date(date);
  if (interval === "daily") next.setUTCDate(next.getUTCDate() + 1);
  if (interval === "weekly") next.setUTCDate(next.getUTCDate() + 7);
  if (interval === "monthly") next.setUTCMonth(next.getUTCMonth() + 1);
  return next;
}

// The first slot after `now` on the cadence that began at `from`: a job missed
// while the app was closed runs once, not once per missed slot.
function nextRunAfter(from: string | null, interval: ScheduleInterval, now: Date) {
  let next = from ? new Date(from) : now;
  if (Number.isNaN(next.getTime()) || now.getTime() - next.getTime() > 400 * DAY_MS) next = now;
  do {
    next = addInterval(next, interval);
  } while (next <= now);
  return next.toISOString();
}

// SQLite CURRENT_TIMESTAMP values ("2026-01-31 10:00:00", UTC) as ISO strings.
function isoTime(value: string | null) {
  return value && /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(value) ? `${value.replace(" ", "T")}.000Z` : value;
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

export function getSiteSchedule(siteId: string) {
  const site = get<any>("SELECT id, scan_schedule, scan_next_run_at, scan_last_run_at FROM sites WHERE id = ?", [siteId]);
  if (!site) throw notFound("Site not found.");
  const interval = normalizeInterval(site.scan_schedule);
  const trackers = all<any>(
    `
    SELECT rt.id, rt.domain, rt.device, rt.schedule_interval, rt.next_check_at, rt.is_active,
      (SELECT max(started_at) FROM rank_runs rr WHERE rr.tracker_id = rt.id) AS last_run_at,
      (SELECT count(*) FROM rank_keywords rk WHERE rk.tracker_id = rt.id) AS keyword_count
    FROM rank_trackers rt
    WHERE rt.site_id = ?
    ORDER BY rt.created_at DESC
    `,
    [siteId],
  );
  return {
    scan: {
      interval,
      nextRunAt: interval === "off" ? null : site.scan_next_run_at,
      lastRunAt: site.scan_last_run_at,
    },
    trackers: trackers.map((tracker) => {
      const trackerInterval = normalizeInterval(tracker.schedule_interval);
      return {
        id: tracker.id,
        name: tracker.domain,
        device: tracker.device,
        keywordCount: tracker.keyword_count,
        active: Boolean(tracker.is_active),
        interval: trackerInterval,
        nextCheckAt: trackerInterval === "off" ? null : tracker.next_check_at,
        lastRunAt: isoTime(tracker.last_run_at),
      };
    }),
  };
}

// Setting the same interval again keeps the planned next run.
export function setScanSchedule(siteId: string, input: { scanInterval?: unknown }) {
  const site = get<any>("SELECT id, scan_schedule, scan_next_run_at FROM sites WHERE id = ?", [siteId]);
  if (!site) throw notFound("Site not found.");
  const interval = requireInterval(input.scanInterval, "scanInterval");
  const unchanged = interval === normalizeInterval(site.scan_schedule) && site.scan_next_run_at;
  const next = interval === "off" ? null : unchanged ? site.scan_next_run_at : nextRunAfter(null, interval, new Date());
  run("UPDATE sites SET scan_schedule = ?, scan_next_run_at = ? WHERE id = ?", [interval, next, siteId]);
  return getSiteSchedule(siteId);
}

export function setTrackerSchedule(trackerId: string, input: { interval?: unknown }) {
  const tracker = get<any>("SELECT id, site_id, schedule_interval, next_check_at FROM rank_trackers WHERE id = ?", [trackerId]);
  if (!tracker) throw notFound("Tracker not found.");
  const interval = requireInterval(input.interval, "interval");
  const unchanged = interval === normalizeInterval(tracker.schedule_interval) && tracker.next_check_at;
  const next = interval === "off" ? null : unchanged ? tracker.next_check_at : nextRunAfter(null, interval, new Date());
  run("UPDATE rank_trackers SET schedule_interval = ?, next_check_at = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?", [
    interval,
    next,
    trackerId,
  ]);
  return getSiteSchedule(tracker.site_id);
}

// Each due job first moves its next run time forward (only if nobody else did),
// so a slot starts at most once; a site or tracker that is already running
// skips the slot.
async function startDueScans(now: Date) {
  const due = all<any>(
    "SELECT * FROM sites WHERE scan_schedule IN ('daily', 'weekly', 'monthly') AND (scan_next_run_at IS NULL OR scan_next_run_at <= ?)",
    [now.toISOString()],
  );
  for (const site of due) {
    const claimed = run("UPDATE sites SET scan_next_run_at = ? WHERE id = ? AND scan_schedule = ? AND scan_next_run_at IS ?", [
      nextRunAfter(site.scan_next_run_at, normalizeInterval(site.scan_schedule), now),
      site.id,
      site.scan_schedule,
      site.scan_next_run_at,
    ]);
    if (!claimed.changes) continue;
    if (get("SELECT 1 FROM scans WHERE site_id = ? AND status IN ('queued', 'running')", [site.id])) continue;
    try {
      if (!site.domain) throw new Error("Set a site domain before scheduling scans.");
      const url = await resolveSavedSiteScanUrl(site);
      if (!url) throw unreachableScanUrlError(site.domain);
      const scan = await startScan(site.id, url);
      run("UPDATE scans SET scheduled = 1 WHERE id = ?", [scan.id]);
      run("UPDATE sites SET scan_last_run_at = ? WHERE id = ?", [now.toISOString(), site.id]);
    } catch (error) {
      createNotification({
        siteId: site.id,
        type: "scan-failed",
        title: `Scheduled scan could not start for ${site.name}`,
        body: errorMessage(error),
        data: { scanId: null, error: errorMessage(error) },
      });
    }
  }
}

function startDueRankChecks(now: Date) {
  const due = all<any>(
    "SELECT * FROM rank_trackers WHERE schedule_interval IN ('daily', 'weekly', 'monthly') AND is_active = 1 AND (next_check_at IS NULL OR next_check_at <= ?)",
    [now.toISOString()],
  );
  for (const tracker of due) {
    const claimed = run(
      "UPDATE rank_trackers SET next_check_at = ? WHERE id = ? AND schedule_interval = ? AND next_check_at IS ?",
      [
        nextRunAfter(tracker.next_check_at, normalizeInterval(tracker.schedule_interval), now),
        tracker.id,
        tracker.schedule_interval,
        tracker.next_check_at,
      ],
    );
    if (!claimed.changes) continue;
    try {
      const started = startRankCheck(tracker.id);
      if (!started.alreadyRunning) run("UPDATE rank_runs SET scheduled = 1 WHERE id = ?", [started.runId]);
    } catch (error) {
      createNotification({
        siteId: tracker.site_id,
        type: "rank-run-problem",
        title: `Scheduled rank check could not start for ${tracker.domain}`,
        body: errorMessage(error),
        data: { trackerId: tracker.id, runId: null, status: "not-started", error: errorMessage(error) },
      });
    }
  }
}

function plural(count: number, word: string) {
  return `${count} ${word}${count === 1 ? "" : "s"}`;
}

function notifyRegressions(row: { id: string; site_id: string; site_name: string }) {
  const comparison = getScan(row.id)?.result?.comparison;
  const regressions = comparison?.available ? comparison.regressions : null;
  if (!regressions || !(regressions.total > 0)) return;
  const parts = [
    regressions.newHighIssues ? `${plural(regressions.newHighIssues, "new high-severity issue")}` : "",
    regressions.newMediumIssues ? `${plural(regressions.newMediumIssues, "new medium-severity issue")}` : "",
    regressions.becameNonIndexable ? `${plural(regressions.becameNonIndexable, "page")} became non-indexable` : "",
    regressions.becameNon200 ? `${plural(regressions.becameNon200, "page")} stopped answering HTTP 200` : "",
  ].filter(Boolean);
  createNotification({
    siteId: row.site_id,
    type: "scan-regression",
    title: `${plural(regressions.total, "regression")} in the latest scan of ${row.site_name}`,
    body: `Compared with the previous scan: ${parts.join(", ")}.`,
    data: {
      scanId: row.id,
      baseScanId: comparison.previousScanId ?? null,
      regressions: {
        total: regressions.total,
        newHighIssues: regressions.newHighIssues,
        newMediumIssues: regressions.newMediumIssues,
        becameNonIndexable: regressions.becameNonIndexable,
        becameNon200: regressions.becameNon200,
      },
    },
  });
}

// Every finished scan (manual, MCP, or scheduled) is checked once for
// regressions; failed scheduled scans raise their own notice.
function notifyFinishedScans(now: Date) {
  const rows = all<any>(
    `
    SELECT scans.id, scans.site_id, scans.status, scans.scheduled, scans.error, sites.name AS site_name
    FROM scans
    JOIN sites ON sites.id = scans.site_id
    WHERE scans.notified_at IS NULL AND scans.status IN ('completed', 'failed', 'cancelled')
    ORDER BY scans.rowid
    LIMIT 20
    `,
  );
  for (const row of rows) {
    try {
      if (row.status === "completed") notifyRegressions(row);
      if (row.status === "failed" && row.scheduled) {
        createNotification({
          siteId: row.site_id,
          type: "scan-failed",
          title: `Scheduled scan failed for ${row.site_name}`,
          body: row.error || "The scan failed.",
          data: { scanId: row.id, error: row.error || "" },
        });
      }
    } catch (error) {
      console.error(`Scheduler could not check scan ${row.id}:`, error);
    }
    run("UPDATE scans SET notified_at = ? WHERE id = ?", [now.toISOString(), row.id]);
  }
}

function notifyScheduledRankRuns(now: Date) {
  const rows = all<any>(
    `
    SELECT rr.*, rt.site_id, rt.domain
    FROM rank_runs rr
    JOIN rank_trackers rt ON rt.id = rr.tracker_id
    WHERE rr.scheduled = 1 AND rr.notified_at IS NULL AND rr.status NOT IN ('queued', 'running')
    `,
  );
  for (const row of rows) {
    if (row.status === "failed" || row.status === "partial") {
      createNotification({
        siteId: row.site_id,
        type: "rank-run-problem",
        title: `Scheduled rank check ${row.status === "failed" ? "failed" : "was partial"} for ${row.domain}`,
        body: row.message || "",
        data: {
          trackerId: row.tracker_id,
          runId: row.id,
          status: row.status,
          keywordCount: row.keyword_count,
          checkedCount: row.checked_count,
          errorCount: row.error_count,
        },
      });
    }
    run("UPDATE rank_runs SET notified_at = ? WHERE id = ?", [now.toISOString(), row.id]);
  }
}

let tickRunning = false;

export async function runSchedulerTick(now = new Date()) {
  if (tickRunning) return;
  tickRunning = true;
  try {
    await startDueScans(now);
    startDueRankChecks(now);
    notifyFinishedScans(now);
    notifyScheduledRankRuns(now);
  } catch (error) {
    console.error("Scheduler tick failed:", error);
  } finally {
    tickRunning = false;
  }
}

let timer: ReturnType<typeof setInterval> | null = null;

// SCHEDULER_TICK_MS sets how often due jobs are checked (default 60s);
// SCHEDULER_DISABLED=1 turns the scheduler and its notifications off.
export function startScheduler() {
  if (timer || ["1", "true"].includes(String(process.env.SCHEDULER_DISABLED || "").toLowerCase())) return null;
  const tickMs = Math.max(50, Number(process.env.SCHEDULER_TICK_MS) || 60_000);
  timer = setInterval(() => void runSchedulerTick(), tickMs);
  return tickMs;
}
