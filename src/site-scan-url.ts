import type { CrawlHost, CrawlProtocol } from "./seo";

type SavedSiteScanUrlPlan = {
  domain: string;
  crawl_protocol?: CrawlProtocol | string;
  crawl_host?: CrawlHost | string;
};

export function localHostFirst(domain: string) {
  const host = (
    domain.startsWith("[") && domain.includes("]")
      ? domain.slice(1, domain.indexOf("]"))
      : domain.split(":")[0]
  )?.toLowerCase() || "";
  if (host === "localhost" || host === "127.0.0.1" || host === "::1") return true;
  // .localhost, .test, and .internal are reserved for local use; .local is
  // mDNS. None of them resolve on the public internet.
  return [".localhost", ".test", ".local", ".internal"].some((suffix) => host.endsWith(suffix));
}

// Bun's fetch validates TLS against its bundled roots and never reads the OS
// keychain, so a locally-trusted dev CA (mkcert, Caddy internal) fails with
// "unable to get local issuer certificate" even though browsers accept it.
// Local hosts are this machine — skip verification there only, and keep
// strict TLS for every real site.
export function localFetchTls(url: string): { tls?: { rejectUnauthorized: boolean } } {
  try {
    return localHostFirst(new URL(url).hostname) ? { tls: { rejectUnauthorized: false } } : {};
  } catch {
    return {};
  }
}

export async function probeScanUrl(url: string) {
  async function request(method: "HEAD" | "GET") {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 3500);
    try {
      const response = await fetch(url, {
        method,
        redirect: "follow",
        signal: controller.signal,
        headers: {
          "user-agent": "LocalSEO/0.1 (+local scan)",
          accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
          ...(method === "GET" ? { range: "bytes=0-2048" } : {}),
        },
        ...localFetchTls(url),
      });
      return { status: response.status, finalUrl: response.url || url };
    } finally {
      clearTimeout(timeout);
    }
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
    const probe = await probeScanUrl(candidate);
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
