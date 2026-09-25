import { useState, type ReactNode } from "react";
import { CircleStop } from "lucide-react";
import { api } from "../../../api";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle, Button, Skeleton, toast } from "@/components/ui";
import { ReportSection, scanIsActive } from "../../shared";
import { cn } from "@/lib/utils";

export type ScanTone = "good" | "warn" | "bad" | "outline";

export function scanStatusTone(status?: string): ScanTone {
  if (status === "completed") return "good";
  if (status === "failed") return "bad";
  if (status === "cancelled") return "outline";
  return "warn";
}

export function severityVariant(severity: string) {
  if (severity === "high") return "bad";
  if (severity === "medium") return "warn";
  return "outline";
}

export function humanizeIssueType(type: unknown) {
  return String(type || "").replaceAll("-", " ");
}

export function defaultScanTab(scan: any) {
  return scanIsActive(scan) ? "progress" : "overview";
}

export function TabCard({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={cn("rounded-2xl border border-border/70 bg-card p-5", className)}>{children}</div>;
}

export function ScanSection({
  title,
  text,
  action,
  children,
}: {
  title: string;
  text: string;
  action?: ReactNode;
  children: ReactNode;
}) {
  return (
    <ReportSection title={title} description={text} action={action}>
      {children}
    </ReportSection>
  );
}

export function ScanReportSkeleton() {
  return (
    <div className="space-y-5" role="status" aria-busy="true" aria-label="Loading scan report">
      <div className="flex flex-wrap gap-2">
        {Array.from({ length: 6 }).map((_, index) => (
          <Skeleton key={index} className="h-8 w-20" />
        ))}
      </div>
      <div className="rounded-2xl border border-border/70 bg-card p-5">
        <Skeleton className="h-5 w-40" />
        <div className="mt-5 grid gap-6 xl:grid-cols-[248px_minmax(0,1fr)]">
          <Skeleton className="mx-auto size-[148px] rounded-full xl:mx-0" />
          <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-3">
            {Array.from({ length: 6 }).map((_, index) => (
              <Skeleton key={index} className="h-20 rounded-xl" />
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

// Stops a queued or running crawl. The saved evidence gathered so far stays in
// SQLite; the scan is marked cancelled instead of completed.
export function CancelScanButton({
  scan,
  onCancelled,
  className,
}: {
  scan: any;
  onCancelled?: () => void;
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  const [pending, setPending] = useState(false);
  if (!scanIsActive(scan)) return null;
  async function cancel() {
    setPending(true);
    try {
      await api.cancelScan(scan.id);
      toast.success("Scan cancelled. Evidence collected so far stays saved.");
      setOpen(false);
      onCancelled?.();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not cancel the scan");
    } finally {
      setPending(false);
    }
  }
  return (
    <>
      <Button
        type="button"
        size="sm"
        variant="outline"
        className={cn("text-muted-foreground hover:text-bad", className)}
        onClick={() => setOpen(true)}
        disabled={pending}
      >
        <CircleStop /> {pending ? "Cancelling" : "Cancel scan"}
      </Button>
      <AlertDialog open={open} onOpenChange={(next) => !pending && setOpen(next)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Cancel this scan?</AlertDialogTitle>
            <AlertDialogDescription>
              The crawl of {scan.url} stops now. Pages and issues collected so far stay saved locally, but the report is incomplete and marked cancelled.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={pending}>Keep scanning</AlertDialogCancel>
            <AlertDialogAction type="button" onClick={cancel} disabled={pending}>
              {pending ? "Cancelling scan" : "Cancel scan"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
