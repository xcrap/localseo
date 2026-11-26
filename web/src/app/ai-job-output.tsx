import { Suspense, lazy } from "react";
import type { AiJob } from "../api";
import { EmptyState, StatusDot, formatDate } from "./shared";

const AiJobResult = lazy(() => import("./ai-job-result"));

export const AI_JOB_POLL_MS = 1500;

export function aiJobActive(job?: AiJob | null) {
  return job?.status === "queued" || job?.status === "running";
}

export function AiJobOutput({ job }: { job: AiJob }) {
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm" role="status">
        <span className="inline-flex items-center gap-2 font-medium capitalize">
          <StatusDot tone={job.status === "completed" ? "good" : job.status === "failed" ? "bad" : "warn"} />
          {job.status || "Unknown"}
        </span>
        <span className="text-muted-foreground">
          {job.started_at ? `· started ${formatDate(job.started_at)}` : "· not started"}
          {job.finished_at ? ` · finished ${formatDate(job.finished_at)}` : ""}
        </span>
      </div>
      {job.error ? (
        <div className="space-y-1 rounded-lg border border-bad/25 bg-bad-soft/40 px-3.5 py-3 text-sm wrap-anywhere">
          <h3 className="font-semibold text-bad">Job failed</h3>
          <p className="leading-6 whitespace-pre-wrap">{job.error}</p>
        </div>
      ) : job.result_text ? (
        <Suspense fallback={<p className="text-sm text-muted-foreground" role="status">Loading report…</p>}>
          <AiJobResult text={job.result_text} />
        </Suspense>
      ) : (
        <EmptyState title={aiJobActive(job) ? "Codex is working" : "No output yet"} text={job.message || "The saved job has not produced text yet."} />
      )}
      {job.prompt ? (
        <details className="rounded-lg border border-border/60">
          <summary className="cursor-pointer select-none px-3.5 py-2.5 text-sm font-medium text-muted-foreground hover:text-foreground">
            Prompt sent to Codex
          </summary>
          <pre className="max-h-105 overflow-auto border-t border-border/60 p-3.5 text-xs leading-5 wrap-anywhere whitespace-pre-wrap text-foreground/80">{job.prompt}</pre>
        </details>
      ) : null}
    </div>
  );
}
