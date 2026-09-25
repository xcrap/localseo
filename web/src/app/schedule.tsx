import { useEffect, useRef, useState } from "react";
import { CalendarClock } from "lucide-react";
import { api, type ScheduleInterval, type SiteSchedule } from "../api";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue, toast } from "@/components/ui";
import { cn } from "@/lib/utils";
import { InfoTip, ReportSection, formatDate } from "./shared";

export const scheduleIntervalOptions: { value: ScheduleInterval; label: string }[] = [
  { value: "off", label: "Off" },
  { value: "daily", label: "Daily" },
  { value: "weekly", label: "Weekly" },
  { value: "monthly", label: "Monthly" },
];

export const scheduleRuntimeNote =
  "Scheduled runs only happen while this local app is running. A run that comes due while the app is closed starts the next time it is open.";

function isInterval(value: string): value is ScheduleInterval {
  return scheduleIntervalOptions.some((option) => option.value === value);
}

export function scheduleIntervalLabel(value?: string | null) {
  return scheduleIntervalOptions.find((option) => option.value === value)?.label || "Off";
}

export function nextRunLabel(interval: string | null | undefined, nextAt: string | null | undefined) {
  if (!interval || interval === "off") return "Not scheduled";
  return nextAt ? `Next ${formatDate(nextAt)}` : "Next run pending";
}

export function ScheduleSelect({
  value,
  onChange,
  disabled,
  label,
  className,
}: {
  value: ScheduleInterval;
  onChange: (value: ScheduleInterval) => void;
  disabled?: boolean;
  /** Accessible name of the select. */
  label: string;
  className?: string;
}) {
  return (
    <Select value={value} onValueChange={(next) => isInterval(next) && onChange(next)} disabled={disabled}>
      <SelectTrigger className={cn("h-8 w-[132px] text-xs", className)} aria-label={label}>
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {scheduleIntervalOptions.map((option) => (
          <SelectItem key={option.value} value={option.value}>
            {option.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

// Loads the site's schedule (scan + rank trackers) and saves changes. A
// schedule endpoint that is unavailable leaves `error` set instead of guessing.
export function useSiteSchedule(siteId: string) {
  const [schedule, setSchedule] = useState<SiteSchedule | null>(null);
  const [error, setError] = useState("");
  const [saving, setSaving] = useState("");
  const tokenRef = useRef(0);

  async function reload() {
    const token = ++tokenRef.current;
    try {
      const next = await api.siteSchedule(siteId);
      if (token !== tokenRef.current) return;
      setSchedule(next);
      setError("");
    } catch (err) {
      if (token !== tokenRef.current) return;
      setSchedule(null);
      setError(err instanceof Error ? err.message : "Could not load the schedule");
    }
  }

  useEffect(() => {
    setSchedule(null);
    setError("");
    reload();
  }, [siteId]);

  async function setScanInterval(interval: ScheduleInterval) {
    setSaving("scan");
    try {
      const next = await api.setSiteScanSchedule(siteId, interval);
      if (next?.scan) setSchedule(next);
      else await reload();
      toast.success(interval === "off" ? "Scheduled scans turned off." : `Site scans scheduled ${scheduleIntervalLabel(interval).toLowerCase()}.`);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not save the scan schedule");
    } finally {
      setSaving("");
    }
  }

  async function setTrackerInterval(trackerId: string, interval: ScheduleInterval) {
    setSaving(`tracker:${trackerId}`);
    try {
      await api.setTrackerSchedule(trackerId, interval);
      await reload();
      toast.success(interval === "off" ? "Scheduled rank checks turned off." : `Rank checks scheduled ${scheduleIntervalLabel(interval).toLowerCase()}.`);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not save the rank check schedule");
    } finally {
      setSaving("");
    }
  }

  return { schedule, error, saving, reload, setScanInterval, setTrackerInterval };
}

// Compact "Auto-scan" control for page headers: interval select plus the next
// run time.
export function ScanScheduleInline({ siteId }: { siteId: string }) {
  const { schedule, error, saving, setScanInterval } = useSiteSchedule(siteId);
  if (error) return null;
  const scan = schedule?.scan;
  return (
    <div className="flex items-center gap-2 text-xs text-muted-foreground">
      <CalendarClock aria-hidden className="size-3.5 shrink-0" />
      <span className="whitespace-nowrap">Auto-scan</span>
      <ScheduleSelect
        value={scan?.interval || "off"}
        onChange={setScanInterval}
        disabled={!schedule || saving === "scan"}
        label="Scheduled site scan interval"
        className="w-[112px]"
      />
      <span className="hidden whitespace-nowrap sm:inline">{schedule ? nextRunLabel(scan?.interval, scan?.nextRunAt) : "Loading…"}</span>
      <InfoTip label="About scheduled scans">{scheduleRuntimeNote}</InfoTip>
    </div>
  );
}

// Schedule card for the site overview: scan interval, next and last run.
export function SiteScheduleCard({ siteId }: { siteId: string }) {
  const { schedule, error, saving, setScanInterval } = useSiteSchedule(siteId);
  const scan = schedule?.scan;
  const scheduledTrackers = (schedule?.trackers || []).filter((tracker) => tracker.interval && tracker.interval !== "off");
  return (
    <ReportSection title="Schedule" description={scheduleRuntimeNote}>
      {error ? (
        <p className="text-sm text-muted-foreground">Scheduling is unavailable: {error}</p>
      ) : (
        <div className="space-y-3">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="min-w-0">
              <div className="text-sm font-medium">Site scan</div>
              <div className="text-xs text-muted-foreground">
                {schedule ? (
                  <>
                    {nextRunLabel(scan?.interval, scan?.nextRunAt)}
                    {scan?.lastRunAt ? ` · last ${formatDate(scan.lastRunAt)}` : " · no scheduled run yet"}
                  </>
                ) : (
                  "Loading…"
                )}
              </div>
            </div>
            <ScheduleSelect
              value={scan?.interval || "off"}
              onChange={setScanInterval}
              disabled={!schedule || saving === "scan"}
              label="Scheduled site scan interval"
            />
          </div>
          {schedule ? (
            <p className="text-xs text-muted-foreground">
              {scheduledTrackers.length
                ? `${scheduledTrackers.length} rank ${scheduledTrackers.length === 1 ? "tracker checks" : "trackers check"} on a schedule. Change them on Rank tracking.`
                : schedule.trackers.length
                  ? "Rank trackers are checked manually. Schedule them on Rank tracking."
                  : "No rank trackers yet."}
            </p>
          ) : null}
        </div>
      )}
    </ReportSection>
  );
}
