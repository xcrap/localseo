import { randomUUID } from "node:crypto";
import { pageSpeedApiKey, pageSpeedApiUrl } from "./config";
import { all, get, jsonParse, run } from "./db";
import { badRequest, notFound } from "./errors";
import { gscPageData } from "./gsc-pages";
import { optionalChoice, optionalInt } from "./input";
import { pageUrlKey } from "./page-url";
import { indexableHtmlPages, siteCompletedScan } from "./scan-summary";
import { getSite } from "./seo";

// Core Web Vitals from Google PageSpeed Insights. Field data is the Chrome UX
// Report data PSI returns (null when it has none for the URL or origin); lab
// data is the Lighthouse run. Only values PSI actually returned are stored.

const STRATEGIES = ["mobile", "desktop"] as const;
const PSI_TIMEOUT_MS = 90_000;
const PSI_CONCURRENCY = 2;
const MAX_URLS = 25;

type FieldMetrics = {
  lcpMs: number | null;
  inpMs: number | null;
  cls: number | null;
  fcpMs: number | null;
  ttfbMs: number | null;
  overall: "FAST" | "AVERAGE" | "SLOW" | null;
};

function finite(value: unknown) {
  const number = typeof value === "number" ? value : Number.NaN;
  return Number.isFinite(number) ? number : null;
}

// loadingExperience / originLoadingExperience → CrUX p75 values. PSI reports
// the CLS percentile multiplied by 100.
function fieldMetrics(experience: any): FieldMetrics | null {
  const metrics = experience?.metrics;
  if (!metrics || typeof metrics !== "object" || !Object.keys(metrics).length) return null;
  const percentile = (name: string) => finite(metrics[name]?.percentile);
  const cls = percentile("CUMULATIVE_LAYOUT_SHIFT_SCORE");
  const overall = experience.overall_category;
  return {
    lcpMs: percentile("LARGEST_CONTENTFUL_PAINT_MS"),
    inpMs: percentile("INTERACTION_TO_NEXT_PAINT"),
    cls: cls === null ? null : cls / 100,
    fcpMs: percentile("FIRST_CONTENTFUL_PAINT_MS"),
    ttfbMs: percentile("EXPERIMENTAL_TIME_TO_FIRST_BYTE"),
    overall: overall === "FAST" || overall === "AVERAGE" || overall === "SLOW" ? overall : null,
  };
}

function labMetrics(lighthouse: any) {
  if (!lighthouse || typeof lighthouse !== "object" || lighthouse.runtimeError) return null;
  const audit = (id: string) => finite(lighthouse.audits?.[id]?.numericValue);
  const ms = (id: string) => {
    const value = audit(id);
    return value === null ? null : Math.round(value);
  };
  const score = finite(lighthouse.categories?.performance?.score);
  const cls = audit("cumulative-layout-shift");
  return {
    performanceScore: score === null ? null : Math.round(score * 100),
    lcpMs: ms("largest-contentful-paint"),
    cls: cls === null ? null : Math.round(cls * 1000) / 1000,
    tbtMs: ms("total-blocking-time"),
    fcpMs: ms("first-contentful-paint"),
    speedIndexMs: ms("speed-index"),
  };
}

async function fetchPageSpeed(url: string, strategy: string) {
  const endpoint = new URL(pageSpeedApiUrl());
  endpoint.searchParams.set("url", url);
  endpoint.searchParams.set("strategy", strategy);
  endpoint.searchParams.set("category", "performance");
  const key = pageSpeedApiKey();
  if (key) endpoint.searchParams.set("key", key);
  let response: Response;
  try {
    response = await fetch(endpoint, { signal: AbortSignal.timeout(PSI_TIMEOUT_MS) });
  } catch (error) {
    if (error instanceof Error && error.name === "TimeoutError") {
      throw new Error(`PageSpeed Insights did not respond within ${PSI_TIMEOUT_MS / 1000} seconds.`);
    }
    throw error;
  }
  const data: any = await response.json().catch(() => null);
  if (!response.ok) {
    throw new Error(`PageSpeed Insights HTTP ${response.status}: ${String(data?.error?.message || "request failed").slice(0, 300)}`);
  }
  if (!data || typeof data !== "object") throw new Error("PageSpeed Insights returned no JSON.");
  // With no URL-level CrUX data, PSI fills loadingExperience from the origin
  // and flags it; that is origin data, not field data for this URL.
  const experience = data.loadingExperience?.origin_fallback ? null : data.loadingExperience;
  const runtimeError = data.lighthouseResult?.runtimeError;
  return {
    field: fieldMetrics(experience),
    originField: fieldMetrics(data.originLoadingExperience),
    lab: labMetrics(data.lighthouseResult),
    error: runtimeError ? `Lighthouse: ${String(runtimeError.message || runtimeError.code || "runtime error").slice(0, 300)}` : null,
  };
}

function requireSite(siteId: string) {
  const site = getSite(siteId);
  if (!site) throw notFound("Site not found.");
  return site;
}

function requestedUrls(value: unknown) {
  if (!Array.isArray(value)) throw badRequest("urls must be an array of page URLs.");
  const urls = [...new Set(value.map((item) => String(item ?? "").trim()).filter(Boolean))];
  for (const url of urls) {
    let parsed: URL | null = null;
    try {
      parsed = new URL(url);
    } catch {
      parsed = null;
    }
    if (!parsed || !/^https?:$/.test(parsed.protocol)) throw badRequest(`Not an http(s) URL: ${url.slice(0, 200)}`);
  }
  if (!urls.length) throw badRequest("Add at least one URL.");
  if (urls.length > MAX_URLS) throw badRequest(`At most ${MAX_URLS} URLs per run.`);
  return urls;
}

// Default URLs: the latest completed scan's indexable 200 HTML pages, most
// internally linked first, then by Search Console clicks when stored.
function defaultUrls(siteId: string, limit: number) {
  const scan = siteCompletedScan(siteId);
  if (!scan) throw badRequest("Run a site scan first, or pass the URLs to test.");
  const gsc = gscPageData(siteId, null, { allowQueryRows: true });
  const clicks = (url: string) => gsc?.pages.get(pageUrlKey(url))?.clicks ?? -1;
  const pages = indexableHtmlPages(scan).sort(
    (a, b) => Number(b.internalInlinks || 0) - Number(a.internalInlinks || 0) || clicks(b.url) - clicks(a.url),
  );
  const urls = [...new Set(pages.map((page) => String(page.url)))].slice(0, limit);
  if (!urls.length) throw badRequest("The latest scan has no indexable HTML pages that answered 200.");
  return urls;
}

export function startCwvRun(siteId: string, input: { urls?: unknown; strategy?: unknown; limit?: unknown }) {
  requireSite(siteId);
  const strategy = optionalChoice(input.strategy, "strategy", STRATEGIES, "mobile");
  const limit = optionalInt(input.limit, "limit", 5, 1, MAX_URLS);
  const active = get<{ id: string; status: string }>(
    "SELECT id, status FROM cwv_runs WHERE site_id = ? AND status IN ('queued', 'running') ORDER BY created_at DESC LIMIT 1",
    [siteId],
  );
  if (active) return { runId: active.id, status: active.status, alreadyRunning: true };
  const urls = input.urls === undefined || input.urls === null ? defaultUrls(siteId, limit) : requestedUrls(input.urls);
  const runId = randomUUID();
  run(
    "INSERT INTO cwv_runs (id, site_id, strategy, status, message, urls_json, url_count) VALUES (?, ?, ?, 'running', ?, ?, ?)",
    [runId, siteId, strategy, `Testing ${urls.length} ${urls.length === 1 ? "URL" : "URLs"}`, JSON.stringify(urls), urls.length],
  );
  queueMicrotask(() => {
    executeCwvRun(runId, siteId, strategy, urls).catch((error) => {
      run("UPDATE cwv_runs SET status = 'failed', message = ?, finished_at = CURRENT_TIMESTAMP WHERE id = ?", [
        error instanceof Error ? error.message : "PageSpeed run failed",
        runId,
      ]);
    });
  });
  return { runId, status: "running", alreadyRunning: false };
}

async function executeCwvRun(runId: string, siteId: string, strategy: string, urls: string[]) {
  const pending = [...urls];
  let done = 0;
  let errors = 0;
  let firstError = "";
  const worker = async () => {
    while (pending.length) {
      const url = pending.shift()!;
      let result: Awaited<ReturnType<typeof fetchPageSpeed>> | null = null;
      let error: string | null = null;
      try {
        result = await fetchPageSpeed(url, strategy);
        error = result.error;
      } catch (caught) {
        error = caught instanceof Error ? caught.message : "PageSpeed request failed";
      }
      // The site or run may have been deleted meanwhile.
      if (!get("SELECT 1 FROM cwv_runs WHERE id = ?", [runId])) return;
      run(
        `
        INSERT INTO cwv_results (id, site_id, run_id, url, strategy, field_json, origin_field_json, lab_json, error)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        `,
        [
          randomUUID(),
          siteId,
          runId,
          url,
          strategy,
          result?.field ? JSON.stringify(result.field) : null,
          result?.originField ? JSON.stringify(result.originField) : null,
          result?.lab ? JSON.stringify(result.lab) : null,
          error,
        ],
      );
      done += 1;
      if (error) {
        errors += 1;
        firstError ||= error;
      }
      run("UPDATE cwv_runs SET done_count = ?, error_count = ?, message = ? WHERE id = ?", [
        done,
        errors,
        `Tested ${done} of ${urls.length}`,
        runId,
      ]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(PSI_CONCURRENCY, urls.length) }, worker));
  const status = !errors ? "completed" : errors < urls.length ? "partial" : "failed";
  const message =
    status === "completed"
      ? `Tested ${urls.length} ${urls.length === 1 ? "URL" : "URLs"}.`
      : `${errors} of ${urls.length} URLs could not be tested: ${firstError}`;
  run("UPDATE cwv_runs SET status = ?, message = ?, finished_at = CURRENT_TIMESTAMP WHERE id = ?", [status, message, runId]);
}

function publicRun(row: any) {
  return {
    id: row.id,
    status: row.status,
    strategy: row.strategy,
    message: row.message,
    urls: jsonParse<string[]>(row.urls_json, []),
    urlCount: row.url_count,
    doneCount: row.done_count,
    errorCount: row.error_count,
    createdAt: row.created_at,
    finishedAt: row.finished_at,
  };
}

// Latest result per URL and strategy, plus recent runs.
export function cwvStatus(siteId: string) {
  requireSite(siteId);
  const latest = all<any>(
    `
    SELECT * FROM (
      SELECT cwv_results.*, ROW_NUMBER() OVER (
        PARTITION BY url, strategy ORDER BY fetched_at DESC, rowid DESC
      ) AS latest_rank
      FROM cwv_results
      WHERE site_id = ?
    )
    WHERE latest_rank = 1
    ORDER BY fetched_at DESC, url ASC
    LIMIT 200
    `,
    [siteId],
  ).map((row) => ({
    url: row.url,
    strategy: row.strategy,
    fetchedAt: row.fetched_at,
    runId: row.run_id,
    field: jsonParse<FieldMetrics | null>(row.field_json, null),
    originField: jsonParse<FieldMetrics | null>(row.origin_field_json, null),
    lab: jsonParse<ReturnType<typeof labMetrics>>(row.lab_json, null),
    error: row.error || null,
  }));
  const runs = all<any>("SELECT * FROM cwv_runs WHERE site_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 10", [siteId]).map(
    publicRun,
  );
  return {
    keyConfigured: Boolean(pageSpeedApiKey()),
    running: runs.some((row) => row.status === "queued" || row.status === "running"),
    latest,
    runs,
  };
}
