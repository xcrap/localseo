import { fetchWithRedirectTrace, localHostFirst } from "./http";
import { type CrawlRobotsMode, crawlRobotsGate, crawlRobotsMode, readRobots } from "./robots";
import type { CrawlHost, CrawlProtocol } from "./seo";

type SavedSiteScanUrlPlan = {
  domain: string;
  crawl_protocol?: CrawlProtocol | string;
  crawl_host?: CrawlHost | string;
  crawl_robots?: CrawlRobotsMode | string;
};

const PROBE_TIMEOUT_MS = 3500;

// Checks that a scan URL answers and returns the URL its redirects land on.
// With robots "respect" the host's robots.txt is read first and nothing it
// disallows for the crawler is requested: a disallowed start URL is not
// probed (the robots.txt answer stands in for it), and a redirect to a
// disallowed URL stops there. The scan then reports why nothing was crawled.
export async function probeScanUrl(url: string, robots: CrawlRobotsMode = "respect") {
  let blocked: ReturnType<typeof crawlRobotsGate> | null = null;
  if (robots === "respect") {
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      return null;
    }
    const file = await readRobots(parsed.origin, AbortSignal.timeout(PROBE_TIMEOUT_MS));
    // No answer at all: the host is unreachable.
    if (file.status === null) return null;
    blocked = crawlRobotsGate({ mode: "respect", files: [file] });
    if (await blocked(parsed.href)) return { status: file.status, finalUrl: parsed.href };
  }
  const gate = blocked;

  async function request(method: "HEAD" | "GET") {
    const trace = await fetchWithRedirectTrace(
      url,
      {
        method,
        signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
        headers: {
          "user-agent": "LocalSEO/0.1 (+local scan)",
          accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
          ...(method === "GET" ? { range: "bytes=0-2048" } : {}),
        },
      },
      20,
      gate ? async (targetUrl) => Boolean(await gate(targetUrl)) : undefined,
    );
    await trace.response.body?.cancel().catch(() => undefined);
    if (trace.redirectError) throw new Error(trace.redirectError);
    return { status: trace.finalStatus, finalUrl: trace.finalUrl };
  }

  try {
    const head = await request("HEAD");
    // Same fallback statuses as the crawler's resource checks: some servers
    // answer HEAD with 403/404/405/501 but serve the page on GET.
    if (![403, 404, 405, 501].includes(head.status)) return head;
  } catch {
    // Try GET below. Some hosts reject or time out HEAD.
  }

  try {
    return await request("GET");
  } catch {
    return null;
  }
}

function normalizeCrawlProtocol(value: unknown) {
  return value === "https" || value === "http" || value === "both" ? value : "auto";
}

function normalizeCrawlHost(value: unknown) {
  return value === "root" || value === "www" || value === "both" ? value : "auto";
}

function scanHostCandidates(domain: string, crawlHost: string) {
  const rootDomain = domain.replace(/^www\./i, "");
  if (!rootDomain || localHostFirst(rootDomain)) return [rootDomain];
  const wwwDomain = `www.${rootDomain}`;
  if (crawlHost === "root") return [rootDomain];
  if (crawlHost === "www") return [wwwDomain];
  return [rootDomain, wwwDomain];
}

function scanProtocolCandidates(domain: string, crawlProtocol: string) {
  if (crawlProtocol === "https") return ["https"];
  if (crawlProtocol === "http") return ["http"];
  return localHostFirst(domain) ? ["http", "https"] : ["https", "http"];
}

export function siteScanUrlCandidates(site: SavedSiteScanUrlPlan) {
  const cleanDomain = site.domain.trim().replace(/^https?:\/\//i, "").replace(/\/.*$/, "");
  const crawlProtocol = normalizeCrawlProtocol(site.crawl_protocol);
  const crawlHost = normalizeCrawlHost(site.crawl_host);
  const hosts = scanHostCandidates(cleanDomain, crawlHost);
  const urls: string[] = [];
  for (const protocol of scanProtocolCandidates(cleanDomain, crawlProtocol)) {
    for (const host of hosts) {
      if (host) urls.push(`${protocol}://${host}`);
    }
  }
  return [...new Set(urls)];
}

// Returns "" when no candidate URL answers at all (DNS/connection/timeout).
// Callers must refuse to start a scan in that case instead of crawling a
// dead URL and saving an empty "completed" report.
export async function resolveSavedSiteScanUrl(site: SavedSiteScanUrlPlan) {
  const candidates = siteScanUrlCandidates(site);
  let firstAnswered = "";
  for (const candidate of candidates) {
    const probe = await probeScanUrl(candidate, crawlRobotsMode(site.crawl_robots));
    if (!probe) continue;
    firstAnswered ||= probe.finalUrl || candidate;
    if (probe.status < 400) return probe.finalUrl || candidate;
  }
  return firstAnswered;
}

export function unreachableScanUrlError(domain: string) {
  return new Error(
    `Could not reach ${domain} on any crawl URL. Check the website address (DNS, TLS, firewall) — the scan was not started.`,
  );
}
