import { useState } from "react";
import { RefreshCw } from "lucide-react";
import { api, type GscStatus, type GscSyncResult } from "../../../api";
import { Button, toast } from "@/components/ui";
import { ReportSection, formatNumber } from "../../shared";
import { DateRangeFields, recentDateRange, type DateRange } from "../../date-picker";
import { gscLiveProperty } from "./connection";
import { DimensionCheckboxes } from "./tables";

// Fetches every Search Analytics row for the range and dimensions and saves it
// locally as one batch, read afterwards like a CSV import.
export function GscSyncPanel({
  siteId,
  status,
  onSynced,
  onOpenConnection,
}: {
  siteId: string;
  status: GscStatus | null;
  onSynced: (result: GscSyncResult) => void;
  onOpenConnection: () => void;
}) {
  // Search Console data lags by about two days, so the default window ends then.
  const [range, setRange] = useState<DateRange>(() => recentDateRange(28, 2));
  const [dimensions, setDimensions] = useState<string[]>(["query", "page"]);
  const [syncing, setSyncing] = useState(false);
  const property = gscLiveProperty(status);
  const blocker = status?.needsReconnect
    ? "Google needs you to reconnect before syncing."
    : !status?.connected
      ? "Connect Google on the Connection tab to sync rows."
      : !property
        ? "Choose the Search Console property for this site on the Connection tab."
        : "";

  async function sync() {
    setSyncing(true);
    try {
      const result = await api.gscSync(siteId, { ...range, dimensions });
      toast.success(`Saved ${formatNumber(result.rowCount)} rows (${formatNumber(result.pagesFetched)} API ${result.pagesFetched === 1 ? "page" : "pages"}).`);
      if (result.truncated) {
        toast.warning("Google returned more rows than the sync limit; the saved batch is incomplete. Sync a shorter range or fewer dimensions.");
      }
      onSynced(result);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not sync from Google Search Console");
    } finally {
      setSyncing(false);
    }
  }

  return (
    <ReportSection
      title="Sync from Google"
      description="Fetches every row Google returns for the range and dimensions, and saves them in local SQLite as one batch. Each sync is a new batch; earlier ones stay saved."
      meta={property ? `Property ${property}` : undefined}
    >
      <div className="space-y-4">
        <div className="grid gap-3 sm:grid-cols-2 lg:max-w-2xl">
          <DateRangeFields value={range} onChange={setRange} />
        </div>
        <DimensionCheckboxes value={dimensions} onChange={setDimensions} idPrefix="gsc-sync-dimension" />
        <p className="text-xs leading-5 text-muted-foreground">
          More dimensions mean more rows: query + page + date can reach Google's limits on large sites. Rows with fewer dimensions keep totals that match the Search Console UI more closely.
        </p>
        <div className="flex flex-wrap items-center gap-3">
          <Button onClick={sync} disabled={Boolean(blocker) || syncing || !dimensions.length} aria-busy={syncing}>
            <RefreshCw className={syncing ? "animate-spin motion-reduce:animate-none" : undefined} /> {syncing ? "Syncing" : "Sync from Google"}
          </Button>
          {blocker ? (
            <span className="text-[13px] text-muted-foreground">
              {blocker}{" "}
              <Button type="button" variant="link" className="h-auto p-0 text-[13px]" onClick={onOpenConnection}>
                Open connection
              </Button>
            </span>
          ) : null}
        </div>
      </div>
    </ReportSection>
  );
}
