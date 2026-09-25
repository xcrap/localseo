import * as cheerio from "cheerio";
import { randomUUID } from "node:crypto";
import { parse as parseDomain } from "tldts";
import { createAiJob, listAiJobs } from "./codex";
import { type CsvRow, csvHasColumn, csvNumber, csvRow, csvText, normalizeCsvHeader, parseCsvRows } from "./csv";
import { all, get, jsonParse, nowIso, run, transaction } from "./db";
import { getConfigValue } from "./config";
import { DEFAULT_KEYWORD_LANGUAGE_CODE, DEFAULT_KEYWORD_LOCATION_CODE } from "./defaults";
import { badRequest, notFound } from "./errors";
import { fetchJson } from "./http";
import { clearIssueIgnores, clearScans, createIssueIgnore, deleteIssueIgnore, deleteScan, getScan, listAllScans, listIssueIgnores, listScans, sameSiteUrl, startScan } from "./scans";

export { clearIssueIgnores, clearScans, createIssueIgnore, deleteIssueIgnore, deleteScan, getScan, listAllScans, listIssueIgnores, listScans, sameSiteUrl, startScan };

export type Site = {
  id: string;
  name: string;
  domain: string;
  notes: string;
  location_code: number;
  language_code: string;
  crawl_protocol: CrawlProtocol;
  crawl_host: CrawlHost;
  crawl_speed: CrawlSpeed;
  crawl_max_pages: number;
  created_at: string;
  updated_at: string;
};

export type CrawlProtocol = "auto" | "https" | "http" | "both";
export type CrawlHost = "auto" | "root" | "www" | "both";
// "auto" follows the app-wide default crawl speed.
export type CrawlSpeed = "auto" | "polite" | "fast";

type KeywordRow = {
  keyword: string;
  searchVolume: number | null;
  difficulty: number | null;
  cpc: number | null;
  intent: string;
};

const tagColors = ["slate", "rose", "amber", "emerald", "sky", "violet", "stone"];

function stableNumber(input: string, min: number, max: number) {
  let hash = 0;
  for (let index = 0; index < input.length; index++) {
    hash = (hash * 31 + input.charCodeAt(index)) >>> 0;
  }
  return min + (hash % (max - min + 1));
}

function parseHost(value: string) {
  const raw = String(value ?? "").trim();
  if (!raw) return null;
  try {
    const url = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `https://${raw}`);
    return { hostname: url.hostname.toLowerCase().replace(/\.$/, "").replace(/^www\./, ""), port: url.port };
  } catch {
    return null;
  }
}

// A site's domain identity: the URL hostname (lowercased, no path, query, or
// trailing dot) with a leading "www." removed, so www and the bare domain are
// the same site everywhere domains are compared. A non-default port is kept
// ("localhost:4131") because it addresses a different local server; default
// ports disappear ("example.com:443" → "example.com"). Returns "" when the
// value is not a hostname.
export function normalizeDomain(value: string) {
  const host = parseHost(value);
  if (!host?.hostname) return "";
  return host.port ? `${host.hostname}:${host.port}` : host.hostname;
}

// True when a SERP result host belongs to the tracked domain: the same site
// (www and bare domain count as one, ports ignored) or a subdomain of it
// (blog.example.com counts for example.com, not the reverse). The dot-boundary
// check avoids "start.com" matching "art.com".
export function hostMatchesDomain(resultHost: string, target: string) {
  const host = parseHost(String(resultHost || ""))?.hostname || "";
  const domain = parseHost(String(target || ""))?.hostname || "";
  if (!host || !domain) return false;
  return host === domain || host.endsWith(`.${domain}`);
}

function normalizeCrawlProtocol(value: unknown): CrawlProtocol {
  return value === "https" || value === "http" || value === "both" ? value : "auto";
}

function normalizeCrawlHost(value: unknown): CrawlHost {
  return value === "root" || value === "www" || value === "both" ? value : "auto";
}

export function normalizeCrawlSpeed(value: unknown): CrawlSpeed {
  return value === "polite" || value === "fast" ? value : "auto";
}

export function normalizeCrawlMaxPages(value: unknown) {
  const pages = Math.round(Number(value));
  if (!Number.isFinite(pages) || pages <= 0) return 0;
  return Math.max(10, Math.min(1000, pages));
}

function defaultLocationCode() {
  const value = Number(getConfigValue("default_location_code") || DEFAULT_KEYWORD_LOCATION_CODE);
  return Number.isFinite(value) && value > 0 ? value : DEFAULT_KEYWORD_LOCATION_CODE;
}

function defaultLanguageCode() {
  return getConfigValue("default_language_code") || DEFAULT_KEYWORD_LANGUAGE_CODE;
}

function normalizeTagName(value: string) {
  return value.trim().replace(/\s+/g, " ").slice(0, 64);
}

function pickTagColor(name: string) {
  return tagColors[stableNumber(name, 0, tagColors.length - 1)];
}

function parseList(value: unknown): string[] {
  if (Array.isArray(value)) return value.map(String).map((item) => item.trim()).filter(Boolean);
  return String(value || "")
    .split(/\n|,/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function cleanText(value: string) {
  return value.replace(/\s+/g, " ").trim();
}

function decodeDuckDuckGoHref(href: string) {
  try {
    const url = new URL(href, "https://duckduckgo.com");
    const uddg = url.searchParams.get("uddg");
    return uddg ? decodeURIComponent(uddg) : url.toString();
  } catch {
    return href;
  }
}

type WebSearchResult = {
  rank: number;
  domain: string;
  url: string;
  title: string;
  description: string;
  source: string;
};

type SearchOptions = {
  depth: number;
  locationCode?: number;
  languageCode?: string;
};

// One provider answer. depthChecked is how many organic results were actually
// inspected — lower than the requested depth when the provider ran out of
// pages — so "not found" can be reported as "not in the top N checked".
type SearchOutcome = {
  rows: WebSearchResult[];
  source: string;
  locale: string;
  depthChecked: number;
};

// Keyword-tool markets (the Google Ads location codes offered in the app)
// mapped to ISO country codes for providers that accept a region. Unknown
// codes search without a region rather than guessing one.
const marketCountries: Record<number, string> = {
  2840: "us",
  2620: "pt",
  2826: "gb",
  2724: "es",
  2250: "fr",
  2276: "de",
  2076: "br",
  2124: "ca",
};

function searchLanguage(options: SearchOptions) {
  return String(options.languageCode || "").trim().toLowerCase().slice(0, 2);
}

function searchCountry(options: SearchOptions) {
  return marketCountries[Number(options.locationCode)] || "";
}

function maxSearchPages(depth: number) {
  return Math.min(10, Math.ceil(depth / 10) + 1);
}

function normalizeSearchResult(item: any, rank: number, source: string): WebSearchResult | null {
  const url = String(item.url || item.link || item.href || item.target || "").trim();
  if (!url) return null;
  return {
    rank,
    domain: normalizeDomain(item.domain || url),
    url,
    title: String(item.title || item.name || "").trim(),
    description: String(item.description || item.snippet || item.body || "").trim(),
    source,
  };
}

// OpenSERP takes the depth as one limit and a language; it has no region or
// device parameter.
async function searchOpenSerp(query: string, options: SearchOptions): Promise<SearchOutcome | null> {
  const base = (getConfigValue("openserp_url") || process.env.OPENSERP_URL || "").replace(/\/$/, "");
  if (!base) return null;
  const engine = "duckduckgo";
  const params = new URLSearchParams({ text: query, limit: String(options.depth) });
  const language = searchLanguage(options);
  if (language) params.set("lang", language.toUpperCase());
  const response = await fetchJson(`${base}/${engine}/search?${params}`);
  if (response.status !== 200) throw new Error(`OpenSERP returned HTTP ${response.status}.`);
  const data = response.data || {};
  const items = data.results || data.items || data.organic || data.web || data.data?.results || [];
  const rows = (Array.isArray(items) ? items : [])
    .map((item, index) => normalizeSearchResult(item, index + 1, `openserp:${engine}`))
    .filter((row): row is WebSearchResult => Boolean(row))
    .slice(0, options.depth);
  if (!rows.length) throw new Error("OpenSERP returned no results.");
  return { rows, source: `openserp:${engine}`, locale: language.toUpperCase(), depthChecked: rows.length };
}

// SearXNG pages through results with pageno and takes a language-region code
// such as "pt-PT"; it has no device parameter.
async function searchSearxng(query: string, options: SearchOptions): Promise<SearchOutcome | null> {
  const base = (getConfigValue("searxng_url") || process.env.SEARXNG_URL || "").replace(/\/$/, "");
  if (!base) return null;
  const language = searchLanguage(options);
  const country = searchCountry(options);
  const locale = language && country ? `${language}-${country.toUpperCase()}` : language;
  const rows: WebSearchResult[] = [];
  const seen = new Set<string>();
  for (let page = 1; page <= maxSearchPages(options.depth) && rows.length < options.depth; page += 1) {
    const params = new URLSearchParams({ q: query, format: "json", pageno: String(page) });
    if (locale) params.set("language", locale);
    let data: any;
    try {
      const response = await fetchJson(`${base}/search?${params}`);
      if (response.status !== 200) throw new Error(`SearXNG returned HTTP ${response.status}.`);
      data = response.data || {};
    } catch (error) {
      // A later page that fails leaves the depth checked at what was read.
      if (page === 1) throw error;
      break;
    }
    const items = Array.isArray(data.results) ? data.results : [];
    let added = 0;
    for (const item of items) {
      const row = normalizeSearchResult(
        {
          url: item.url || item.link,
          title: item.title,
          description: item.content || item.description || item.snippet,
          domain: item.parsed_url?.[1] || item.domain,
        },
        rows.length + 1,
        "searxng",
      );
      if (!row || seen.has(row.url)) continue;
      seen.add(row.url);
      rows.push(row);
      added += 1;
    }
    if (page === 1 && !added) {
      const unresponsive = Array.isArray(data.unresponsive_engines)
        ? data.unresponsive_engines.map((engine: unknown) => (Array.isArray(engine) ? engine.join(": ") : String(engine))).join(", ")
        : "";
      throw new Error(`SearXNG returned no results${unresponsive ? ` (unresponsive engines: ${unresponsive})` : ""}.`);
    }
    if (!added) break;
  }
  const checked = rows.slice(0, options.depth);
  return { rows: checked, source: "searxng", locale, depthChecked: checked.length };
}

// DuckDuckGo's region codes pair a country with that market's language.
function duckDuckGoRegion(options: SearchOptions) {
  const country = searchCountry(options);
  if (country === "ca") return searchLanguage(options) === "fr" ? "ca-fr" : "ca-en";
  const regions: Record<string, string> = {
    us: "us-en",
    gb: "uk-en",
    pt: "pt-pt",
    br: "br-pt",
    es: "es-es",
    fr: "fr-fr",
    de: "de-de",
  };
  return regions[country] || "wt-wt";
}

function duckDuckGoHtmlUrl() {
  return process.env.DUCKDUCKGO_HTML_URL?.trim() || "https://html.duckduckgo.com/html/";
}

// Pause between DuckDuckGo requests. Bursts get rate limited, and a rate-limited
// answer is a provider error, never a "not ranking" result.
const DUCKDUCKGO_PAUSE_MS = 1000;

async function fetchDuckDuckGoPage(url: string, form?: URLSearchParams) {
  const response = await fetch(url, {
    method: form ? "POST" : "GET",
    body: form,
    redirect: "follow",
    signal: AbortSignal.timeout(15000),
    headers: {
      "User-Agent": "LocalSEO/0.1 (+https://localhost)",
      Accept: "text/html,application/xhtml+xml",
      ...(form ? { "Content-Type": "application/x-www-form-urlencoded" } : {}),
    },
  });
  return { status: response.status, url: response.url || url, text: await response.text() };
}

// Reads one DuckDuckGo HTML results page. Anything but HTTP 200 is an error:
// DuckDuckGo answers rate-limited requests with 202 and an empty page, which
// must not be read as "no results". Ads are skipped so positions count organic
// results only.
export function readDuckDuckGoPage(page: { status: number; url?: string; text: string }, firstRank = 1) {
  if (page.status !== 200) {
    throw new Error(
      page.status === 202
        ? "DuckDuckGo returned HTTP 202 (rate limited) instead of results."
        : `DuckDuckGo returned HTTP ${page.status}.`,
    );
  }
  const $ = cheerio.load(page.text);
  const rows: WebSearchResult[] = [];
  $(".result").each((_, element) => {
    if ($(element).is(".result--ad")) return;
    const link = $(element).find("a.result__a").first();
    const url = decodeDuckDuckGoHref(link.attr("href") || "");
    const domain = normalizeDomain(url);
    if (!url || !domain) return;
    rows.push({
      rank: firstRank + rows.length,
      domain,
      url,
      title: cleanText(link.text()),
      description: cleanText($(element).find(".result__snippet").text()),
      source: "duckduckgo",
    });
  });
  const nextForm = $("form")
    .filter((_, form) => $(form).find('input[type="submit"]').toArray().some((input) => /next/i.test($(input).attr("value") || "")))
    .first();
  const next = nextForm.length
    ? {
        action: new URL(nextForm.attr("action") || "", page.url || duckDuckGoHtmlUrl()).toString(),
        fields: new URLSearchParams(
          nextForm
            .find('input[type="hidden"]')
            .toArray()
            .map((input) => [$(input).attr("name") || "", $(input).attr("value") || ""] as [string, string])
            .filter(([name]) => name),
        ),
      }
    : null;
  return { rows, next };
}

// DuckDuckGo HTML has no device parameter; region comes from kl. Deeper pages
// are fetched through the page's own "Next" form until the depth is reached.
async function searchDuckDuckGo(query: string, options: SearchOptions): Promise<SearchOutcome> {
  const region = duckDuckGoRegion(options);
  const url = new URL(duckDuckGoHtmlUrl());
  url.searchParams.set("q", query);
  url.searchParams.set("kl", region);
  let page = readDuckDuckGoPage(await fetchDuckDuckGoPage(url.toString()));
  if (!page.rows.length) {
    throw new Error("DuckDuckGo returned a page without results (likely rate limited or blocked).");
  }
  const rows = [...page.rows];
  for (let pageNumber = 2; pageNumber <= maxSearchPages(options.depth) && rows.length < options.depth && page.next; pageNumber += 1) {
    await Bun.sleep(DUCKDUCKGO_PAUSE_MS);
    try {
      page = readDuckDuckGoPage(await fetchDuckDuckGoPage(page.next.action, page.next.fields), rows.length + 1);
    } catch {
      // A later page that fails leaves the depth checked at what was read.
      break;
    }
    if (!page.rows.length) break;
    rows.push(...page.rows);
  }
  const checked = rows.slice(0, options.depth);
  return { rows: checked, source: "duckduckgo", locale: region, depthChecked: checked.length };
}

// Configured self-hosted providers first, then the built-in DuckDuckGo
// fallback. A provider that errors or returns nothing hands over to the next;
// when all fail the combined error is thrown so callers never mistake a
// provider failure for "no results".
async function searchWeb(query: string, options: SearchOptions): Promise<SearchOutcome> {
  const errors: string[] = [];
  for (const provider of [searchOpenSerp, searchSearxng, searchDuckDuckGo]) {
    try {
      const outcome = await provider(query, options);
      if (outcome) return outcome;
    } catch (error) {
      errors.push(error instanceof Error ? error.message : String(error));
    }
  }
  throw new Error(`Search failed: ${errors.join(" ")}`);
}

export function listSites() {
  return all<Site>("SELECT * FROM sites ORDER BY created_at DESC");
}

export function getSite(siteId: string) {
  return get<Site>("SELECT * FROM sites WHERE id = ?", [siteId]);
}

// Optional text field from a request body: undefined when absent, 400 when
// present with the wrong type.
function optionalText(value: unknown, field: string) {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string") throw badRequest(`${field} must be text.`);
  return value.trim();
}

// A domain field from a request: "" when blank, 400 when it is not a hostname.
function domainInput(value: unknown) {
  const text = optionalText(value, "Domain");
  if (!text) return "";
  const domain = normalizeDomain(text);
  if (!domain) throw badRequest(`"${text}" is not a valid domain.`);
  return domain;
}

function optionalLocationCode(value: unknown) {
  if (value === undefined || value === null || value === "") return undefined;
  const code = Number(value);
  if (!Number.isInteger(code) || code <= 0) throw badRequest("Location code must be a positive number.");
  return code;
}

export function createSite(input: {
  name?: unknown;
  domain?: unknown;
  notes?: unknown;
  locationCode?: unknown;
  languageCode?: unknown;
  crawlProtocol?: CrawlProtocol | string;
  crawlHost?: CrawlHost | string;
  crawlSpeed?: CrawlSpeed | string;
  crawlMaxPages?: number;
  crawl_protocol?: CrawlProtocol | string;
  crawl_host?: CrawlHost | string;
  crawl_speed?: CrawlSpeed | string;
  crawl_max_pages?: number;
}) {
  const id = randomUUID();
  const domain = domainInput(input.domain);
  const name = optionalText(input.name, "Site name") || domain;
  if (!name) throw badRequest("A site name or domain is required.");
  const locationCode = optionalLocationCode(input.locationCode) || defaultLocationCode();
  const languageCode = optionalText(input.languageCode, "Language code") || defaultLanguageCode();
  const crawlProtocol = normalizeCrawlProtocol(
    input.crawlProtocol ?? input.crawl_protocol ?? getConfigValue("default_crawl_protocol"),
  );
  const crawlHost = normalizeCrawlHost(input.crawlHost ?? input.crawl_host ?? getConfigValue("default_crawl_host"));
  const crawlSpeed = normalizeCrawlSpeed(input.crawlSpeed ?? input.crawl_speed);
  const crawlMaxPages = normalizeCrawlMaxPages(input.crawlMaxPages ?? input.crawl_max_pages);
  run(
    `
    INSERT INTO sites (id, name, domain, notes, location_code, language_code, crawl_protocol, crawl_host, crawl_speed, crawl_max_pages)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `,
    [
      id,
      name,
      domain,
      optionalText(input.notes, "Notes") || "",
      locationCode,
      languageCode,
      crawlProtocol,
      crawlHost,
      crawlSpeed,
      crawlMaxPages,
    ],
  );
  return getSite(id)!;
}

export function updateSite(siteId: string, input: Record<string, unknown>) {
  const existing = getSite(siteId);
  if (!existing) throw notFound("Site not found.");
  const name = optionalText(input.name, "Site name");
  if (name === "") throw badRequest("Site name cannot be empty.");
  run(
    `
    UPDATE sites
    SET name = ?, domain = ?, notes = ?, location_code = ?, language_code = ?, crawl_protocol = ?, crawl_host = ?, crawl_speed = ?, crawl_max_pages = ?, updated_at = CURRENT_TIMESTAMP
    WHERE id = ?
    `,
    [
      name ?? existing.name,
      input.domain === undefined ? existing.domain : domainInput(input.domain),
      optionalText(input.notes, "Notes") ?? existing.notes,
      optionalLocationCode(input.location_code) ?? existing.location_code,
      optionalText(input.language_code, "Language code") || existing.language_code,
      normalizeCrawlProtocol(input.crawl_protocol ?? input.crawlProtocol ?? existing.crawl_protocol),
      normalizeCrawlHost(input.crawl_host ?? input.crawlHost ?? existing.crawl_host),
      normalizeCrawlSpeed(input.crawl_speed ?? input.crawlSpeed ?? existing.crawl_speed),
      normalizeCrawlMaxPages(input.crawl_max_pages ?? input.crawlMaxPages ?? existing.crawl_max_pages),
      siteId,
    ],
  );
  return getSite(siteId)!;
}

export function deleteSite(siteId: string) {
  const info = run("DELETE FROM sites WHERE id = ?", [siteId]);
  return { id: siteId, deleted: Number(info.changes || 0) > 0 };
}

function providerRequiredMessage(feature: string) {
  return `${feature} needs a real imported dataset. No generated SEO metrics are shown.`;
}

function emptyProviderResult(feature: string, extra: Record<string, unknown> = {}) {
  return {
    source: "provider-not-configured",
    providerRequired: "imported-dataset",
    warning: providerRequiredMessage(feature),
    ...extra,
  };
}

function publicDomainResult(result: any, fallbackDomain = "") {
  if (!result || typeof result !== "object" || Array.isArray(result)) return result;
  return {
    ...result,
    domain: result.domain || fallbackDomain || "",
  };
}

function publicDomainSnapshotRow(row: any) {
  const { site_id: siteId, domain, result_json, ...rest } = row;
  return {
    ...rest,
    site_id: siteId,
    domain,
    result: publicDomainResult(jsonParse(result_json, {}), domain),
  };
}

function publicSerpResult(result: any) {
  if (!result || typeof result !== "object" || Array.isArray(result)) return result;
  return {
    ...result,
    rows: result.rows,
    domain: result.domain || "",
    domainPosition: result.domainPosition ?? null,
  };
}

// Older lookups stored the per-name result counts as "shareOfVoice" and a
// "visibility" count shown as a percentage. Both were only counts of returned
// search results, so history is served under the honest names.
function publicBrandLookupResult(result: any) {
  if (!result || typeof result !== "object" || Array.isArray(result)) return result;
  const { shareOfVoice, ...rest } = result;
  return {
    ...rest,
    resolvedEntity: result.resolvedEntity || "",
    resultCounts:
      result.resultCounts ??
      (Array.isArray(shareOfVoice) ? shareOfVoice : []).map((row: any) => ({
        label: row.label,
        isPrimary: Boolean(row.isPrimary),
        resultCount: row.value ?? null,
        maxResults: BRAND_LOOKUP_RESULTS,
      })),
    platforms: (Array.isArray(result.platforms) ? result.platforms : []).map((platform: any) => ({
      platform: platform.platform,
      resultCount: platform.resultCount ?? platform.mentions ?? null,
      citations: platform.citations || [],
    })),
  };
}

async function duckDuckGoSuggestions(query: string, limit: number): Promise<KeywordRow[]> {
  const response = await fetchJson(`https://duckduckgo.com/ac/?q=${encodeURIComponent(query)}&type=list`);
  if (!response.ok) throw new Error(`DuckDuckGo suggestions ${response.status}`);
  const rows = Array.isArray(response.data) ? response.data : [];
  const seen = new Set<string>();
  return rows
    .map((item: any) => String(item.phrase || item.text || item.value || "").trim())
    .filter((keyword) => {
      const key = keyword.toLowerCase();
      if (!keyword || seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .slice(0, limit)
    .map((keyword) => ({
      keyword,
      searchVolume: null,
      difficulty: null,
      cpc: null,
      intent: "unknown",
    }));
}

export async function researchKeywords(input: {
  siteId: string;
  query: string;
  locationCode?: number;
  languageCode?: string;
  limit?: number;
}) {
  const site = getSite(input.siteId);
  if (!site) throw notFound("Site not found.");
  const query = optionalText(input.query, "Keyword query") || "";
  if (!query) throw badRequest("Keyword query is required.");
  const locationCode = input.locationCode || site.location_code;
  const languageCode = input.languageCode || site.language_code;
  const limit = Math.max(5, Math.min(100, input.limit || 25));
  let source = "duckduckgo-suggest";
  let rows: KeywordRow[] = [];
  let warning = "Keyword suggestions are real. Volume, CPC, and difficulty are unavailable because this local app does not generate third-party metrics.";

  try {
    rows = await duckDuckGoSuggestions(query, limit);
  } catch (error) {
    source = "suggest-error";
    warning = error instanceof Error ? error.message : "Keyword suggestions failed";
  }

  const id = randomUUID();
  run(
    `
    INSERT INTO keyword_research_runs
      (id, site_id, query, location_code, language_code, source, result_json)
    VALUES (?, ?, ?, ?, ?, ?, ?)
    `,
    [id, site.id, query, locationCode, languageCode, source, JSON.stringify(rows)],
  );
  return { id, siteId: site.id, query, source, rows, warning, createdAt: nowIso() };
}

export function saveKeywords(input: {
  siteId: string;
  keywords: Array<KeywordRow | string>;
  tags?: string[];
  tagMode?: "append" | "replace";
  source?: string;
}) {
  const site = getSite(input.siteId);
  if (!site) throw notFound("Site not found.");
  const tagNames = parseList(input.tags).map(normalizeTagName).filter(Boolean);
  for (const tag of tagNames) ensureSavedKeywordTag(site.id, tag);
  const saved = [];
  for (const row of input.keywords) {
    const keywordRow: KeywordRow =
      typeof row === "string"
        ? {
            keyword: row,
            searchVolume: null,
            difficulty: null,
            cpc: null,
            intent: "unknown",
          }
        : row;
    if (!keywordRow.keyword?.trim()) continue;
    const id = randomUUID();
    const existing = get<any>(
      "SELECT * FROM saved_keywords WHERE site_id = ? AND keyword = ? AND location_code = ? AND language_code = ?",
      [site.id, keywordRow.keyword, site.location_code, site.language_code],
    );
    const existingTags = jsonParse<string[]>(existing?.tags, []);
    // Only replace tags when the caller explicitly supplied some in replace mode;
    // re-saving research rows (no tags) must not wipe imported/manual tags.
    const nextTags =
      input.tagMode === "append"
        ? Array.from(new Set([...existingTags, ...tagNames]))
        : tagNames.length
          ? tagNames
          : existingTags;
    run(
      `
      INSERT INTO saved_keywords
        (id, site_id, keyword, location_code, language_code, search_volume, difficulty, cpc, intent, tags, source)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(site_id, keyword, location_code, language_code) DO UPDATE SET
        search_volume = COALESCE(excluded.search_volume, saved_keywords.search_volume),
        difficulty = COALESCE(excluded.difficulty, saved_keywords.difficulty),
        cpc = COALESCE(excluded.cpc, saved_keywords.cpc),
        intent = CASE WHEN excluded.intent = 'unknown' THEN saved_keywords.intent ELSE excluded.intent END,
        tags = excluded.tags,
        source = excluded.source
      `,
      [
        id,
        site.id,
        keywordRow.keyword,
        site.location_code,
        site.language_code,
        keywordRow.searchVolume,
        keywordRow.difficulty,
        keywordRow.cpc,
        keywordRow.intent || "unknown",
        JSON.stringify(nextTags),
        input.source || "research",
      ],
    );
    saved.push(keywordRow.keyword);
  }
  return { saved };
}

type ImportedKeywordMetricRow = {
  keyword: string;
  searchVolume: number | null;
  difficulty: number | null;
  cpc: number | null;
  intent: string;
};

const keywordColumnAliases = ["keyword", "query", "search term", "search_term", "term"];

// Search Console "impressions" are deliberately not a volume alias: impressions
// count how often this site was shown, not how often the keyword was searched.
function parseKeywordMetricsCsv(csv: string) {
  const { fields, rows } = parseCsvRows(csv, "Keyword metrics CSV");
  const [onlyField] = fields;
  const headerIsKeywordColumn = keywordColumnAliases.some(
    (alias) => normalizeCsvHeader(alias) === normalizeCsvHeader(onlyField || ""),
  );
  // A plain one-column keyword list may have no header: its first line is a
  // keyword too, not a column name.
  if (fields.length === 1 && !headerIsKeywordColumn) {
    return [onlyField, ...rows.map((row) => String(row[onlyField] ?? ""))].map((keyword) => ({ keyword }));
  }
  return rows;
}

function normalizeImportedKeywordMetricRow(raw: Record<string, unknown>): ImportedKeywordMetricRow | null {
  const row = csvRow(raw);
  const keyword = csvText(row, keywordColumnAliases);
  if (!keyword) return null;
  return {
    keyword,
    searchVolume: csvNumber(row, ["search volume", "search_volume", "volume", "avg monthly searches", "monthly searches"]),
    difficulty: csvNumber(row, ["difficulty", "keyword difficulty", "keyword_difficulty", "kd", "seo difficulty"]),
    cpc: csvNumber(row, ["cpc", "cost per click", "cost_per_click", "avg cpc", "average cpc"]),
    intent: csvText(row, ["intent", "search intent", "main intent"]) || "unknown",
  };
}

function mapKeywordMetricImport(row: any) {
  return {
    id: row.id,
    siteId: row.site_id,
    source: "keyword-metrics-import",
    sourceName: row.source_name,
    source_name: row.source_name,
    rowCount: row.row_count,
    row_count: row.row_count,
    insertedCount: row.inserted_count,
    inserted_count: row.inserted_count,
    updatedCount: row.updated_count,
    updated_count: row.updated_count,
    rows: jsonParse<ImportedKeywordMetricRow[]>(row.rows_json, []),
    createdAt: row.created_at,
    created_at: row.created_at,
  };
}

export function listKeywordMetricImports(siteId: string) {
  return all<any>(
    "SELECT * FROM keyword_metric_imports WHERE site_id = ? ORDER BY created_at DESC",
    [siteId],
  ).map(mapKeywordMetricImport);
}

function importRows(input: { csv?: unknown; rows?: unknown }, parse: (csv: string) => Record<string, unknown>[]) {
  if (typeof input.csv === "string" && input.csv.trim()) return parse(input.csv);
  if (input.csv !== undefined && typeof input.csv !== "string") throw badRequest("csv must be text.");
  if (input.rows === undefined) return [];
  if (!Array.isArray(input.rows)) throw badRequest("rows must be an array.");
  return input.rows.filter((row): row is Record<string, unknown> => Boolean(row) && typeof row === "object");
}

export function importKeywordMetricsCsv(input: {
  siteId?: string;
  sourceName?: string;
  csv?: unknown;
  rows?: unknown;
}) {
  const site = getSite(String(input.siteId || ""));
  if (!site) throw notFound("Site not found.");
  const rows = importRows(input, parseKeywordMetricsCsv)
    .map(normalizeImportedKeywordMetricRow)
    .filter((row): row is ImportedKeywordMetricRow => Boolean(row));
  if (!rows.length) throw badRequest("Import file has no keyword metric rows.");

  return transaction(() => {
    // Keywords match case-insensitively; both maps are built once instead of
    // scanning saved_keywords / rank_keywords for every imported row.
    const savedByKeyword = new Map<string, any>();
    for (const saved of all<any>(
      "SELECT * FROM saved_keywords WHERE site_id = ? AND location_code = ? AND language_code = ?",
      [site.id, site.location_code, site.language_code],
    )) {
      savedByKeyword.set(saved.keyword.toLowerCase(), saved);
    }
    const rankKeywordIds = new Map<string, string[]>();
    for (const rankKeyword of all<{ id: string; keyword: string }>(
      `
      SELECT rk.id, rk.keyword
      FROM rank_keywords rk
      JOIN rank_trackers rt ON rt.id = rk.tracker_id
      WHERE rt.site_id = ? AND rt.location_code = ? AND rt.language_code = ?
      `,
      [site.id, site.location_code, site.language_code],
    )) {
      const key = rankKeyword.keyword.toLowerCase();
      rankKeywordIds.set(key, [...(rankKeywordIds.get(key) || []), rankKeyword.id]);
    }

    let insertedCount = 0;
    let updatedCount = 0;
    for (const row of rows) {
      const key = row.keyword.toLowerCase();
      const existing = savedByKeyword.get(key);
      const next = {
        search_volume: row.searchVolume ?? existing?.search_volume ?? null,
        difficulty: row.difficulty ?? existing?.difficulty ?? null,
        cpc: row.cpc ?? existing?.cpc ?? null,
        intent: row.intent && row.intent !== "unknown" ? row.intent : existing?.intent || "unknown",
      };
      if (existing) {
        run(
          "UPDATE saved_keywords SET search_volume = ?, difficulty = ?, cpc = ?, intent = ?, source = ? WHERE id = ?",
          [next.search_volume, next.difficulty, next.cpc, next.intent, "keyword-metrics-import", existing.id],
        );
        savedByKeyword.set(key, { ...existing, ...next });
        updatedCount += 1;
      } else {
        const id = randomUUID();
        run(
          `
          INSERT INTO saved_keywords
            (id, site_id, keyword, location_code, language_code, search_volume, difficulty, cpc, intent, tags, source)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, '[]', ?)
          `,
          [
            id,
            site.id,
            row.keyword,
            site.location_code,
            site.language_code,
            next.search_volume,
            next.difficulty,
            next.cpc,
            next.intent,
            "keyword-metrics-import",
          ],
        );
        savedByKeyword.set(key, { id, keyword: row.keyword, ...next });
        insertedCount += 1;
      }
      if (row.searchVolume === null && row.difficulty === null && row.cpc === null) continue;
      for (const rankKeywordId of rankKeywordIds.get(key) || []) {
        run(
          `
          UPDATE rank_keywords
          SET search_volume = COALESCE(?, search_volume),
              keyword_difficulty = COALESCE(?, keyword_difficulty),
              cpc = COALESCE(?, cpc),
              metrics_fetched_at = CURRENT_TIMESTAMP
          WHERE id = ?
          `,
          [row.searchVolume, row.difficulty, row.cpc, rankKeywordId],
        );
      }
    }

    const id = randomUUID();
    run(
      `
      INSERT INTO keyword_metric_imports
        (id, site_id, source_name, row_count, inserted_count, updated_count, rows_json)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      `,
      [
        id,
        site.id,
        String(input.sourceName || "Keyword metrics CSV").slice(0, 160),
        rows.length,
        insertedCount,
        updatedCount,
        JSON.stringify(rows),
      ],
    );
    return mapKeywordMetricImport(get<any>("SELECT * FROM keyword_metric_imports WHERE id = ?", [id]));
  });
}

export function listSavedKeywords(siteId: string) {
  return all<any>(
    "SELECT * FROM saved_keywords WHERE site_id = ? ORDER BY created_at DESC",
    [siteId],
  ).map((row) => ({ ...row, tags: jsonParse<string[]>(row.tags, []) }));
}

export function ensureSavedKeywordTag(siteId: string, name: string, color?: string) {
  const cleanName = normalizeTagName(name);
  if (!cleanName) throw badRequest("Tag name is required.");
  const existing = get<any>(
    "SELECT * FROM saved_keyword_tags WHERE site_id = ? AND lower(name) = lower(?)",
    [siteId, cleanName],
  );
  if (existing) return existing;
  const id = randomUUID();
  run(
    `
    INSERT INTO saved_keyword_tags (id, site_id, name, color)
    VALUES (?, ?, ?, ?)
    `,
    [id, siteId, cleanName, color || pickTagColor(cleanName)],
  );
  return get<any>("SELECT * FROM saved_keyword_tags WHERE id = ?", [id])!;
}

export function listSavedKeywordTags(siteId: string) {
  const tags = all<any>(
    "SELECT * FROM saved_keyword_tags WHERE site_id = ? ORDER BY name",
    [siteId],
  );
  const keywords = listSavedKeywords(siteId);
  return tags.map((tag) => ({
    ...tag,
    keyword_count: keywords.filter((keyword) => keyword.tags.includes(tag.name)).length,
  }));
}

export function querySavedKeywords(input: {
  siteId: string;
  search?: string;
  includeTerms?: string[];
  excludeTerms?: string[];
  minVolume?: number | null;
  maxVolume?: number | null;
  minDifficulty?: number | null;
  maxDifficulty?: number | null;
  minCpc?: number | null;
  maxCpc?: number | null;
  tagNames?: string[];
  page?: number;
  pageSize?: number;
  sort?: string;
  order?: string;
}) {
  const site = getSite(input.siteId);
  if (!site) throw notFound("Site not found.");
  const search = String(input.search || "").trim().toLowerCase();
  const includeTerms = parseList(input.includeTerms).map((item) => item.toLowerCase());
  const excludeTerms = parseList(input.excludeTerms).map((item) => item.toLowerCase());
  const tagNames = parseList(input.tagNames).map(normalizeTagName);
  let rows = listSavedKeywords(site.id);

  rows = rows.filter((row) => {
    const keyword = String(row.keyword || "").toLowerCase();
    if (search && !keyword.includes(search)) return false;
    if (includeTerms.some((term) => !keyword.includes(term))) return false;
    if (excludeTerms.some((term) => keyword.includes(term))) return false;
    if (tagNames.length > 0 && !tagNames.every((tag) => row.tags.includes(tag))) return false;
    if (typeof input.minVolume === "number" && Number(row.search_volume || 0) < input.minVolume) return false;
    if (typeof input.maxVolume === "number" && Number(row.search_volume || 0) > input.maxVolume) return false;
    if (typeof input.minDifficulty === "number" && Number(row.difficulty || 0) < input.minDifficulty) return false;
    if (typeof input.maxDifficulty === "number" && Number(row.difficulty || 0) > input.maxDifficulty) return false;
    if (typeof input.minCpc === "number" && Number(row.cpc || 0) < input.minCpc) return false;
    if (typeof input.maxCpc === "number" && Number(row.cpc || 0) > input.maxCpc) return false;
    return true;
  });

  const sort = input.sort || "created_at";
  const order = input.order === "asc" ? 1 : -1;
  const sortValue = (row: any) => {
    switch (sort) {
      case "keyword":
        return String(row.keyword || "");
      case "search_volume":
      case "volume":
        return Number(row.search_volume || 0);
      case "difficulty":
        return Number(row.difficulty || 0);
      case "cpc":
        return Number(row.cpc || 0);
      default:
        return String(row.created_at || "");
    }
  };
  rows.sort((a, b) => {
    const left = sortValue(a);
    const right = sortValue(b);
    if (left < right) return -1 * order;
    if (left > right) return 1 * order;
    return 0;
  });

  const total = rows.length;
  const pageSize = Math.max(10, Math.min(250, Number(input.pageSize || 50)));
  const page = Math.max(1, Number(input.page || 1));
  const offset = (page - 1) * pageSize;
  return {
    rows: rows.slice(offset, offset + pageSize),
    total,
    page,
    pageSize,
    tags: listSavedKeywordTags(site.id),
  };
}

export function updateSavedKeywordTags(input: {
  siteId: string;
  savedKeywordIds: string[];
  addTags?: string[] | string;
  removeTagNames?: string[] | string;
  removeTagIds?: string[];
}) {
  const site = getSite(input.siteId);
  if (!site) throw notFound("Site not found.");
  const addTags = parseList(input.addTags).map(normalizeTagName).filter(Boolean);
  const removeTagNames = new Set(parseList(input.removeTagNames).map(normalizeTagName));
  for (const tagId of input.removeTagIds || []) {
    const tag = get<any>("SELECT * FROM saved_keyword_tags WHERE id = ? AND site_id = ?", [tagId, site.id]);
    if (tag) removeTagNames.add(tag.name);
  }
  for (const tag of addTags) ensureSavedKeywordTag(site.id, tag);
  let updated = 0;
  for (const id of input.savedKeywordIds || []) {
    const row = get<any>("SELECT * FROM saved_keywords WHERE id = ? AND site_id = ?", [id, site.id]);
    if (!row) continue;
    const current = new Set(jsonParse<string[]>(row.tags, []));
    for (const tag of addTags) current.add(tag);
    for (const tag of removeTagNames) current.delete(tag);
    run("UPDATE saved_keywords SET tags = ? WHERE id = ?", [JSON.stringify(Array.from(current)), id]);
    updated += 1;
  }
  return { updated, tags: listSavedKeywordTags(site.id) };
}

export function updateSavedKeywordTag(input: {
  siteId: string;
  tagId: string;
  name?: string;
  color?: string | null;
}) {
  const site = getSite(input.siteId);
  if (!site) throw notFound("Site not found.");
  const tag = get<any>("SELECT * FROM saved_keyword_tags WHERE id = ? AND site_id = ?", [
    input.tagId,
    site.id,
  ]);
  if (!tag) throw notFound("Tag not found.");
  const nextName = input.name ? normalizeTagName(input.name) : tag.name;
  const nextColor = input.color || tag.color || pickTagColor(nextName);
  run(
    "UPDATE saved_keyword_tags SET name = ?, color = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?",
    [nextName, nextColor, input.tagId],
  );
  if (nextName !== tag.name) {
    for (const keyword of listSavedKeywords(site.id)) {
      if (!keyword.tags.includes(tag.name)) continue;
      const tags = keyword.tags.map((item: string) => (item === tag.name ? nextName : item));
      run("UPDATE saved_keywords SET tags = ? WHERE id = ?", [JSON.stringify(Array.from(new Set(tags))), keyword.id]);
    }
  }
  return get<any>("SELECT * FROM saved_keyword_tags WHERE id = ?", [input.tagId]);
}

export function deleteSavedKeywordTag(input: { siteId: string; tagId: string }) {
  const site = getSite(input.siteId);
  if (!site) throw notFound("Site not found.");
  const tag = get<any>("SELECT * FROM saved_keyword_tags WHERE id = ? AND site_id = ?", [
    input.tagId,
    site.id,
  ]);
  if (!tag) throw notFound("Tag not found.");
  for (const keyword of listSavedKeywords(site.id)) {
    if (!keyword.tags.includes(tag.name)) continue;
    const tags = keyword.tags.filter((item: string) => item !== tag.name);
    run("UPDATE saved_keywords SET tags = ? WHERE id = ?", [JSON.stringify(tags), keyword.id]);
  }
  run("DELETE FROM saved_keyword_tags WHERE id = ? AND site_id = ?", [input.tagId, site.id]);
  return { deleted: true };
}

export function removeSavedKeywords(siteId: string, savedKeywordIds: string[]) {
  const site = getSite(siteId);
  if (!site) throw notFound("Site not found.");
  let removed = 0;
  for (const id of savedKeywordIds || []) {
    const info = run("DELETE FROM saved_keywords WHERE id = ? AND site_id = ?", [id, site.id]);
    removed += Number(info.changes || 0);
  }
  return { removed };
}

// Runs listed with each tracker. Older runs stay in SQLite and are paged
// through listRankRuns; runCount always reports the full total.
const RANK_RUN_HISTORY_LIMIT = 100;

type RankRunError = { keywordId: string; keyword: string; error: string };

function requireTracker(trackerId: string) {
  const tracker = get<any>("SELECT * FROM rank_trackers WHERE id = ?", [trackerId]);
  if (!tracker) throw notFound("Tracker not found.");
  return tracker;
}

function publicRankRun(row: any) {
  const { errors_json, history_rank: _historyRank, run_total: _runTotal, ...rest } = row;
  return { ...rest, errors: jsonParse<RankRunError[]>(errors_json, []) };
}

function groupByTracker<T extends { tracker_id: string }>(rows: T[]) {
  const groups = new Map<string, T[]>();
  for (const row of rows) {
    const group = groups.get(row.tracker_id);
    if (group) group.push(row);
    else groups.set(row.tracker_id, [row]);
  }
  return groups;
}

// The latest check of each keyword still on its tracker, from completed runs
// only. Partial and failed runs stay visible in run and keyword history but
// never replace a keyword's latest position or feed the trend. Removed
// keywords drop out because their snapshots lose keyword_id.
function latestRankSnapshots(siteId: string) {
  return all<any>(
    `
    SELECT * FROM (
      SELECT rs.*, ROW_NUMBER() OVER (
        PARTITION BY rs.keyword_id
        ORDER BY rs.checked_at DESC, rr.started_at DESC, rs.rowid DESC
      ) AS latest_rank
      FROM rank_snapshots rs
      JOIN rank_runs rr ON rr.id = rs.run_id AND rr.status = 'completed'
      JOIN rank_keywords rk ON rk.id = rs.keyword_id AND rk.tracker_id = rs.tracker_id
      JOIN rank_trackers rt ON rt.id = rs.tracker_id
      WHERE rt.site_id = ?
    )
    WHERE latest_rank = 1
    ORDER BY position IS NULL, position ASC, keyword ASC
    `,
    [siteId],
  ).map(({ latest_rank: _latestRank, ...row }) => row);
}

export function listRankTrackers(siteId: string) {
  const trackers = all<any>(
    "SELECT * FROM rank_trackers WHERE site_id = ? ORDER BY created_at DESC",
    [siteId],
  );
  if (!trackers.length) return [];
  const keywords = groupByTracker(
    all<any>(
      `
      SELECT rk.* FROM rank_keywords rk
      JOIN rank_trackers rt ON rt.id = rk.tracker_id
      WHERE rt.site_id = ?
      ORDER BY rk.keyword
      `,
      [siteId],
    ),
  );
  const runs = groupByTracker(
    all<any>(
      `
      SELECT * FROM (
        SELECT rr.*,
          ROW_NUMBER() OVER (PARTITION BY rr.tracker_id ORDER BY rr.started_at DESC, rr.rowid DESC) AS history_rank,
          COUNT(*) OVER (PARTITION BY rr.tracker_id) AS run_total
        FROM rank_runs rr
        JOIN rank_trackers rt ON rt.id = rr.tracker_id
        WHERE rt.site_id = ?
      )
      WHERE history_rank <= ?
      ORDER BY started_at DESC, history_rank ASC
      `,
      [siteId, RANK_RUN_HISTORY_LIMIT],
    ),
  );
  const latest = groupByTracker(latestRankSnapshots(siteId));
  return trackers.map((tracker) => {
    const trackerRuns = runs.get(tracker.id) || [];
    return {
      ...tracker,
      keywords: keywords.get(tracker.id) || [],
      runs: trackerRuns.map(publicRankRun),
      runCount: Number(trackerRuns[0]?.run_total || 0),
      latest: latest.get(tracker.id) || [],
    };
  });
}

function rankTrackerView(tracker: any) {
  return listRankTrackers(tracker.site_id).find((item) => item.id === tracker.id);
}

function serpDepth(value: unknown) {
  return Math.max(10, Math.min(100, Math.round(Number(value)) || 50));
}

export function createRankTracker(input: {
  siteId: string;
  domain?: unknown;
  keywords?: unknown;
  locationCode?: unknown;
  languageCode?: unknown;
  device?: unknown;
  depth?: unknown;
}) {
  const site = getSite(input.siteId);
  if (!site) throw notFound("Site not found.");
  const domain = domainInput(input.domain) || site.domain;
  if (!domain) throw badRequest("Domain is required.");
  const id = randomUUID();
  run(
    `
    INSERT INTO rank_trackers
      (id, site_id, domain, location_code, language_code, device, serp_depth)
    VALUES (?, ?, ?, ?, ?, ?, ?)
    `,
    [
      id,
      site.id,
      domain,
      optionalLocationCode(input.locationCode) || site.location_code,
      optionalText(input.languageCode, "Language code") || site.language_code,
      input.device === "mobile" ? "mobile" : "desktop",
      serpDepth(input.depth),
    ],
  );
  addRankKeywords(id, input.keywords);
  return rankTrackerView({ id, site_id: site.id });
}

function savedKeywordMetricsForTracker(tracker: any, keyword: string) {
  return get<any>(
    `
    SELECT search_volume, difficulty, cpc
    FROM saved_keywords
    WHERE site_id = ?
      AND lower(keyword) = lower(?)
      AND location_code = ?
      AND language_code = ?
    ORDER BY created_at DESC
    LIMIT 1
    `,
    [tracker.site_id, keyword, tracker.location_code, tracker.language_code],
  );
}

function hasImportedKeywordMetrics(metrics: any) {
  return metrics && (metrics.search_volume != null || metrics.difficulty != null || metrics.cpc != null);
}

export function addRankKeywords(trackerId: string, keywords: unknown) {
  const tracker = requireTracker(trackerId);
  for (const keyword of parseList(keywords)) {
    const metrics = savedKeywordMetricsForTracker(tracker, keyword);
    const hasMetrics = hasImportedKeywordMetrics(metrics);
    run(
      `
      INSERT INTO rank_keywords
        (id, tracker_id, keyword, search_volume, keyword_difficulty, cpc, metrics_fetched_at)
      VALUES (?, ?, ?, ?, ?, ?, CASE WHEN ? THEN CURRENT_TIMESTAMP ELSE NULL END)
      ON CONFLICT(tracker_id, keyword) DO NOTHING
      `,
      [
        randomUUID(),
        trackerId,
        keyword,
        metrics?.search_volume ?? null,
        metrics?.difficulty ?? null,
        metrics?.cpc ?? null,
        hasMetrics ? 1 : 0,
      ],
    );
  }
}

export function removeRankKeywords(trackerId: string, keywordIds: unknown) {
  const tracker = requireTracker(trackerId);
  if (!Array.isArray(keywordIds)) throw badRequest("keywordIds must be an array.");
  let removed = 0;
  for (const id of keywordIds) {
    const info = run("DELETE FROM rank_keywords WHERE id = ? AND tracker_id = ?", [String(id), trackerId]);
    removed += Number(info.changes || 0);
  }
  return { removed, tracker: rankTrackerView(tracker) };
}

function historyDays(sinceDays: number | undefined) {
  return Math.max(1, Math.min(730, Math.round(Number(sinceDays)) || 365));
}

export function getRankKeywordHistory(input: { trackerId: string; keywordId: string; sinceDays?: number }) {
  requireTracker(input.trackerId);
  return all<any>(
    `
    SELECT rs.run_id, rs.position, rs.url, rs.title, rs.checked_at, rs.depth_checked, rs.source, rr.status AS run_status
    FROM rank_snapshots rs
    JOIN rank_runs rr ON rr.id = rs.run_id
    WHERE rs.tracker_id = ?
      AND rs.keyword_id = ?
      AND rs.checked_at >= datetime('now', ?)
    ORDER BY rs.checked_at ASC
    `,
    [input.trackerId, input.keywordId, `-${historyDays(input.sinceDays)} days`],
  );
}

// One point per completed run. notRanking counts keywords not found within the
// depth that run actually checked.
export function getRankTrackerTrend(trackerId: string, sinceDays = 365) {
  requireTracker(trackerId);
  return all<any>(
    `
    SELECT
      rr.id AS runId,
      COALESCE(rr.finished_at, rr.started_at) AS checkedAt,
      COUNT(rs.id) AS checked,
      COALESCE(SUM(rs.position <= 3), 0) AS top3,
      COALESCE(SUM(rs.position <= 10), 0) AS top10,
      COALESCE(SUM(rs.position <= 20), 0) AS top20,
      COALESCE(SUM(rs.id IS NOT NULL AND rs.position IS NULL), 0) AS notRanking
    FROM rank_runs rr
    LEFT JOIN rank_snapshots rs ON rs.run_id = rr.id
    WHERE rr.tracker_id = ?
      AND rr.status = 'completed'
      AND rr.started_at >= datetime('now', ?)
    GROUP BY rr.id
    ORDER BY rr.started_at ASC
    `,
    [trackerId, `-${historyDays(sinceDays)} days`],
  );
}

export function syncRankKeywordMetrics(trackerId: string) {
  const tracker = requireTracker(trackerId);
  const keywords = all<any>("SELECT * FROM rank_keywords WHERE tracker_id = ?", [trackerId]);
  let updated = 0;
  const missingKeywords: string[] = [];
  for (const keyword of keywords) {
    const metrics = savedKeywordMetricsForTracker(tracker, keyword.keyword);
    if (!hasImportedKeywordMetrics(metrics)) {
      missingKeywords.push(keyword.keyword);
      continue;
    }
    run(
      `
      UPDATE rank_keywords
      SET search_volume = COALESCE(?, search_volume),
          keyword_difficulty = COALESCE(?, keyword_difficulty),
          cpc = COALESCE(?, cpc),
          metrics_fetched_at = CURRENT_TIMESTAMP
      WHERE id = ?
      `,
      [metrics.search_volume, metrics.difficulty, metrics.cpc, keyword.id],
    );
    updated += 1;
  }
  return {
    updated,
    skipped: missingKeywords.length,
    source: "local-keyword-metrics",
    warning: missingKeywords.length
      ? "Some tracked keywords do not have imported metrics yet. Import a keyword metrics CSV from Saved keywords."
      : "",
    missingKeywords,
    tracker: rankTrackerView(tracker),
  };
}

// Search providers have no device emulation, so tracker.device is recorded but
// cannot change results. Location and language are passed where supported.
async function serpPosition(keyword: string, tracker: any) {
  const outcome = await searchWeb(keyword, {
    depth: serpDepth(tracker.serp_depth),
    locationCode: tracker.location_code,
    languageCode: tracker.language_code,
  });
  const match = outcome.rows.find((row) => hostMatchesDomain(row.domain, tracker.domain));
  return {
    position: match?.rank ?? null,
    url: match?.url || "",
    title: match?.title || "",
    depthChecked: outcome.depthChecked,
    source: outcome.locale ? `${outcome.source}:${outcome.locale}` : outcome.source,
  };
}

function saveRankRunProgress(runId: string, checked: number, errors: RankRunError[], message: string) {
  run(
    "UPDATE rank_runs SET checked_count = ?, error_count = ?, errors_json = ?, message = ? WHERE id = ?",
    [checked, errors.length, JSON.stringify(errors), message, runId],
  );
}

// A keyword whose search fails gets no snapshot: the error is recorded on the
// run instead of a fabricated "not ranking" row. The run ends 'completed' only
// when every keyword was checked, 'partial' when some were, else 'failed'.
async function executeRankRun(runId: string, tracker: any, keywords: any[]) {
  const errors: RankRunError[] = [];
  let checked = 0;
  for (const [index, keyword] of keywords.entries()) {
    let pause = true;
    try {
      const result = await serpPosition(keyword.keyword, tracker);
      pause = result.source.startsWith("duckduckgo");
      // Skip keywords removed from the tracker while the run was going.
      if (get("SELECT id FROM rank_keywords WHERE id = ?", [keyword.id])) {
        run(
          `
          INSERT INTO rank_snapshots
            (id, run_id, tracker_id, keyword_id, keyword, position, url, title, depth_checked, source)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          `,
          [
            randomUUID(),
            runId,
            tracker.id,
            keyword.id,
            keyword.keyword,
            result.position,
            result.url,
            result.title,
            result.depthChecked,
            result.source,
          ],
        );
        checked += 1;
      }
    } catch (error) {
      errors.push({
        keywordId: keyword.id,
        keyword: keyword.keyword,
        error: error instanceof Error ? error.message : "Search failed",
      });
    }
    saveRankRunProgress(runId, checked, errors, `Checked ${index + 1} of ${keywords.length} keywords`);
    if (pause && index < keywords.length - 1) await Bun.sleep(DUCKDUCKGO_PAUSE_MS);
  }
  const status = !errors.length ? "completed" : checked ? "partial" : "failed";
  const message =
    status === "completed"
      ? `Checked ${checked} ${checked === 1 ? "keyword" : "keywords"}.`
      : status === "partial"
        ? `${errors.length} of ${keywords.length} keywords could not be checked: ${errors[0].error}`
        : `No keyword could be checked: ${errors[0].error}`;
  run(
    "UPDATE rank_runs SET status = ?, message = ?, checked_count = ?, error_count = ?, errors_json = ?, finished_at = CURRENT_TIMESTAMP WHERE id = ?",
    [status, message, checked, errors.length, JSON.stringify(errors), runId],
  );
}

// Starts a rank check in the background and returns the running run at once.
// Poll getRankRun (or reload the trackers) until its status leaves 'running'.
export function startRankCheck(trackerId: string) {
  const tracker = requireTracker(trackerId);
  const active = get<any>(
    "SELECT * FROM rank_runs WHERE tracker_id = ? AND status IN ('queued', 'running') ORDER BY started_at DESC LIMIT 1",
    [trackerId],
  );
  if (active) {
    return { runId: active.id, alreadyRunning: true, run: publicRankRun(active), tracker: rankTrackerView(tracker) };
  }
  const keywords = all<any>("SELECT * FROM rank_keywords WHERE tracker_id = ? ORDER BY keyword", [trackerId]);
  if (!keywords.length) throw badRequest("Add keywords to this tracker before running a rank check.");
  const runId = randomUUID();
  run(
    "INSERT INTO rank_runs (id, tracker_id, status, message, keyword_count) VALUES (?, ?, 'running', ?, ?)",
    [runId, trackerId, `Checking ${keywords.length} ${keywords.length === 1 ? "keyword" : "keywords"}`, keywords.length],
  );
  queueMicrotask(() => {
    executeRankRun(runId, tracker, keywords).catch((error) => {
      run(
        "UPDATE rank_runs SET status = 'failed', message = ?, finished_at = CURRENT_TIMESTAMP WHERE id = ?",
        [error instanceof Error ? error.message : "Rank check failed", runId],
      );
    });
  });
  return { runId, alreadyRunning: false, run: getRankRun(trackerId, runId), tracker: rankTrackerView(tracker) };
}

export function getRankRun(trackerId: string, runId: string) {
  const row = get<any>("SELECT * FROM rank_runs WHERE id = ? AND tracker_id = ?", [runId, trackerId]);
  if (!row) throw notFound("Rank run not found.");
  return publicRankRun(row);
}

export function listRankRuns(trackerId: string, limit = 50, offset = 0) {
  requireTracker(trackerId);
  const total = get<{ count: number }>("SELECT count(*) AS count FROM rank_runs WHERE tracker_id = ?", [trackerId])?.count || 0;
  const runs = all<any>(
    "SELECT * FROM rank_runs WHERE tracker_id = ? ORDER BY started_at DESC, rowid DESC LIMIT ? OFFSET ?",
    [trackerId, limit, offset],
  ).map(publicRankRun);
  return { runs, total, limit, offset, hasMore: offset + runs.length < total };
}

export async function domainOverview(input: { siteId: string; domain?: string }) {
  const site = getSite(input.siteId);
  if (!site) throw notFound("Site not found.");
  const domain = normalizeDomain(input.domain || site.domain);
  if (!domain) throw badRequest("Domain is required.");
  const imported = latestOrganicImport(site.id, domain);
  if (imported) {
    return {
      source: "organic-import",
      domain,
      organicKeywords: imported.summary.organicKeywords,
      organicTraffic: imported.summary.organicTraffic,
      estimatedValue: imported.summary.estimatedValue,
      competitors: [],
      topPages: imported.pages.slice(0, 10),
      importId: imported.id,
      sourceName: imported.sourceName,
      importedAt: imported.createdAt,
    };
  }
  return emptyProviderResult("Organic research", {
    domain,
    organicKeywords: null,
    organicTraffic: null,
    estimatedValue: null,
    competitors: [],
    topPages: [],
  });
}

function relativePath(url: string) {
  try {
    const parsed = new URL(/^https?:\/\//i.test(url) ? url : `https://${url}`);
    return `${parsed.pathname}${parsed.search}` || "/";
  } catch {
    return null;
  }
}

function localScanPagesForDomain(siteId: string, domain: string, page: number, pageSize: number, search: string) {
  const scope = `https://${domain}`;
  const scans = all<any>(
    `
    SELECT * FROM scans
    WHERE site_id = ? AND status = 'completed' AND result_json IS NOT NULL
    ORDER BY updated_at DESC, created_at DESC
    LIMIT 10
    `,
    [siteId],
  );

  for (const scan of scans) {
    const result = jsonParse<any>(scan.result_json, null);
    const pages = Array.isArray(result?.pages) ? result.pages : [];
    // Page issues live once in result.issues, recorded on the page URL or on
    // the URL it was requested as (redirect findings).
    const issueCounts = new Map<string, number>();
    for (const issue of Array.isArray(result?.issues) ? result.issues : []) {
      issueCounts.set(issue.url, (issueCounts.get(issue.url) || 0) + 1);
    }
    const rows = pages
      .filter((row: any) => sameSiteUrl(String(row.finalUrl || row.url || ""), scope))
      .map((row: any) => {
        const pageUrl = String(row.finalUrl || row.url || "");
        const issueUrls = new Set([row.url, row.requestedUrl].filter(Boolean));
        return {
          page: pageUrl,
          relativePath: relativePath(pageUrl),
          organicTraffic: null,
          keywords: null,
          title: String(row.title || ""),
          issues: [...issueUrls].reduce((total, url) => total + (issueCounts.get(url) || 0), 0),
          source: "local-scan",
          scanId: scan.id,
          scannedAt: scan.updated_at || scan.created_at,
        };
      });
    if (!rows.length) continue;

    const filtered = search
      ? rows.filter((row: any) =>
        `${row.page} ${row.relativePath || ""} ${row.title || ""}`.toLowerCase().includes(search),
      )
      : rows;
    const offset = (page - 1) * pageSize;
    return {
      domain,
      page,
      pageSize,
      totalCount: filtered.length,
      hasMore: offset + pageSize < filtered.length,
      pages: filtered.slice(offset, offset + pageSize),
      fetchedAt: nowIso(),
      warning: "Showing real pages from the latest local scan. Traffic and keyword counts stay unavailable without an imported organic dataset.",
    };
  }

  return null;
}

type ImportedOrganicKeywordRow = {
  keyword: string;
  position: number | null;
  searchVolume: number | null;
  traffic: number | null;
  keywordDifficulty: number | null;
  cpc: number | null;
  url: string;
  relativeUrl: string | null;
  intent: string;
};

type ImportedOrganicPageRow = {
  page: string;
  relativePath: string | null;
  title: string;
  organicTraffic: number | null;
  keywords: number | null;
  value: number | null;
  source: string;
};

function parseOrganicCsv(csv: string) {
  return parseCsvRows(csv, "Organic research CSV").rows;
}

function organicUrl(value: string, domain: string) {
  const clean = value.trim();
  if (!clean) return "";
  if (/^https?:\/\//i.test(clean)) return clean;
  if (clean.startsWith("/")) return `https://${domain}${clean}`;
  if (clean.includes(".") && !clean.includes(" ")) return `https://${clean}`;
  return "";
}

function normalizeImportedOrganicRow(raw: Record<string, unknown>, domain: string) {
  const row = csvRow(raw);
  const keyword = csvText(row, keywordColumnAliases);
  const rawUrl = csvText(row, [
    "url",
    "page",
    "ranking url",
    "ranking_url",
    "ranking page",
    "top page",
    "landing page",
    "target url",
    "page url",
  ]);
  const url = organicUrl(rawUrl, domain);
  const acceptsUrl = !url || sameSiteUrl(url, `https://${domain}`);
  const traffic = csvNumber(row, ["traffic", "organic traffic", "organic_traffic", "clicks", "estimated traffic"]);
  const keywordCount = csvNumber(row, ["keywords", "keyword count", "keyword_count", "ranking keywords"]);
  const page: ImportedOrganicPageRow | null = url && acceptsUrl
    ? {
        page: url,
        relativePath: relativePath(url),
        title: csvText(row, ["title", "page title", "meta title"]),
        organicTraffic: traffic,
        keywords: keywordCount || (keyword ? 1 : null),
        value: csvNumber(row, ["value", "traffic value", "estimated value", "cost"]),
        source: "organic-import",
      }
    : null;
  const keywordRow: ImportedOrganicKeywordRow | null = keyword && acceptsUrl
    ? {
        keyword,
        position: csvNumber(row, ["position", "rank", "ranking position", "current position"]),
        searchVolume: csvNumber(row, ["search volume", "search_volume", "volume", "avg monthly searches", "monthly searches"]),
        traffic,
        keywordDifficulty: csvNumber(row, ["keyword difficulty", "keyword_difficulty", "difficulty", "kd", "seo difficulty"]),
        cpc: csvNumber(row, ["cpc", "cost per click", "cost_per_click"]),
        url,
        relativeUrl: url ? relativePath(url) : null,
        intent: csvText(row, ["intent", "search intent"]) || "unknown",
      }
    : null;
  return { keyword: keywordRow, page };
}

function mergeOrganicPages(rows: ImportedOrganicPageRow[]) {
  const byPage = new Map<string, ImportedOrganicPageRow>();
  for (const row of rows) {
    const key = row.page;
    const current = byPage.get(key);
    if (!current) {
      byPage.set(key, { ...row });
      continue;
    }
    current.title ||= row.title;
    current.organicTraffic = (Number(current.organicTraffic || 0) + Number(row.organicTraffic || 0)) || null;
    current.keywords = (Number(current.keywords || 0) + Number(row.keywords || 0)) || null;
    current.value = (Number(current.value || 0) + Number(row.value || 0)) || null;
  }
  return [...byPage.values()].sort((a, b) => Number(b.organicTraffic || 0) - Number(a.organicTraffic || 0));
}

function organicSummary(keywords: ImportedOrganicKeywordRow[], pages: ImportedOrganicPageRow[]) {
  const keywordSet = new Set(keywords.map((row) => row.keyword.toLowerCase()).filter(Boolean));
  const organicKeywords = keywordSet.size || keywords.length || pages.reduce((total, row) => total + Number(row.keywords || 0), 0);
  return {
    organicKeywords,
    organicTraffic: pages.reduce((total, row) => total + Number(row.organicTraffic || 0), 0) || keywords.reduce((total, row) => total + Number(row.traffic || 0), 0) || null,
    estimatedValue: pages.reduce((total, row) => total + Number(row.value || 0), 0) || null,
  };
}

function mapOrganicImport(row: any) {
  const keywords = jsonParse<ImportedOrganicKeywordRow[]>(row.keywords_json, []);
  const pages = jsonParse<ImportedOrganicPageRow[]>(row.pages_json, []);
  const summary = jsonParse<Record<string, any>>(row.summary_json, {});
  return {
    id: row.id,
    siteId: row.site_id,
    domain: row.domain,
    source: "organic-import",
    sourceName: row.source_name,
    source_name: row.source_name,
    keywordCount: row.keyword_count,
    keyword_count: row.keyword_count,
    pageCount: row.page_count,
    page_count: row.page_count,
    rowCount: Number(row.keyword_count || 0) + Number(row.page_count || 0),
    row_count: Number(row.keyword_count || 0) + Number(row.page_count || 0),
    summary,
    keywords,
    pages,
    result: { source: "organic-import", domain: row.domain, ...summary },
    createdAt: row.created_at,
    created_at: row.created_at,
  };
}

function latestOrganicImport(siteId: string, domain: string) {
  const row = get<any>(
    "SELECT * FROM organic_imports WHERE site_id = ? AND domain = ? ORDER BY created_at DESC LIMIT 1",
    [siteId, domain],
  );
  return row ? mapOrganicImport(row) : null;
}

export function listOrganicImports(siteId: string) {
  return all<any>(
    "SELECT * FROM organic_imports WHERE site_id = ? ORDER BY created_at DESC",
    [siteId],
  ).map(mapOrganicImport);
}

export function importOrganicResearchCsv(input: {
  siteId?: string;
  domain?: string;
  sourceName?: string;
  csv?: string;
  rows?: Record<string, unknown>[];
}) {
  const site = getSite(String(input.siteId || ""));
  if (!site) throw notFound("Site not found.");
  const domain = normalizeDomain(input.domain || site.domain);
  if (!domain) throw badRequest("Domain is required.");
  const rawRows = importRows(input, parseOrganicCsv);
  const normalized = rawRows.map((row) => normalizeImportedOrganicRow(row, domain));
  const keywords = normalized.map((row) => row.keyword).filter((row): row is ImportedOrganicKeywordRow => Boolean(row));
  const pages = mergeOrganicPages(normalized.map((row) => row.page).filter((row): row is ImportedOrganicPageRow => Boolean(row)));
  if (!keywords.length && !pages.length) {
    throw badRequest("Import file has no organic keyword or page rows for this domain.");
  }
  const summary = organicSummary(keywords, pages);
  const id = randomUUID();
  run(
    `
    INSERT INTO organic_imports
      (id, site_id, domain, source_name, keyword_count, page_count, summary_json, keywords_json, pages_json)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `,
    [
      id,
      site.id,
      domain,
      String(input.sourceName || "Organic research CSV").slice(0, 160),
      keywords.length,
      pages.length,
      JSON.stringify(summary),
      JSON.stringify(keywords),
      JSON.stringify(pages),
    ],
  );
  return mapOrganicImport(get<any>("SELECT * FROM organic_imports WHERE id = ?", [id]));
}

export async function getDomainKeywordSuggestions(input: {
  siteId: string;
  domain?: string;
  limit?: number;
}) {
  const site = getSite(input.siteId);
  if (!site) throw notFound("Site not found.");
  const target = normalizeDomain(input.domain || site.domain);
  const limit = Math.max(5, Math.min(100, input.limit || 25));
  const page = await getDomainKeywordsPage({
    siteId: site.id,
    domain: target,
    page: 1,
    pageSize: limit,
    sortMode: "traffic",
    sortOrder: "desc",
  });
  return page.keywords.slice(0, limit);
}

export async function getDomainKeywordsPage(input: {
  siteId: string;
  domain?: string;
  includeSubdomains?: boolean;
  page?: number;
  pageSize?: number;
  sortMode?: string;
  sortOrder?: string;
  search?: string;
}) {
  const site = getSite(input.siteId);
  if (!site) throw notFound("Site not found.");
  const target = normalizeDomain(input.domain || site.domain);
  if (!target) throw badRequest("Domain is required.");
  const page = Math.max(1, Number(input.page || 1));
  const pageSize = Math.max(10, Math.min(200, Number(input.pageSize || 50)));
  const search = String(input.search || "").trim().toLowerCase();
  const imported = latestOrganicImport(site.id, target);
  if (imported) {
    const rows = (search
      ? imported.keywords.filter((row) => `${row.keyword} ${row.url}`.toLowerCase().includes(search))
      : imported.keywords
    ).sort((a, b) => Number(a.position || 999999) - Number(b.position || 999999));
    const paged = paginateRows(rows, page, pageSize);
    return {
      source: "organic-import",
      domain: target,
      page,
      pageSize,
      totalCount: paged.totalCount,
      hasMore: paged.hasMore,
      keywords: paged.rows,
      fetchedAt: nowIso(),
      importId: imported.id,
      sourceName: imported.sourceName,
    };
  }
  return {
    source: "provider-not-configured",
    domain: target,
    page,
    pageSize,
    totalCount: 0,
    hasMore: false,
    keywords: [],
    fetchedAt: nowIso(),
    warning: providerRequiredMessage("Ranked domain keywords"),
  };
}

export async function getDomainPagesPage(input: {
  siteId: string;
  domain?: string;
  includeSubdomains?: boolean;
  page?: number;
  pageSize?: number;
  sortMode?: string;
  sortOrder?: string;
  search?: string;
}) {
  const site = getSite(input.siteId);
  if (!site) throw notFound("Site not found.");
  const target = normalizeDomain(input.domain || site.domain);
  if (!target) throw badRequest("Domain is required.");
  const page = Math.max(1, Number(input.page || 1));
  const pageSize = Math.max(10, Math.min(200, Number(input.pageSize || 50)));
  const search = String(input.search || "").trim().toLowerCase();
  const imported = latestOrganicImport(site.id, target);
  if (imported?.pages.length) {
    const rows = search
      ? imported.pages.filter((row) => `${row.page} ${row.relativePath || ""} ${row.title || ""}`.toLowerCase().includes(search))
      : imported.pages;
    const paged = paginateRows(rows, page, pageSize);
    return {
      source: "organic-import",
      domain: target,
      page,
      pageSize,
      totalCount: paged.totalCount,
      hasMore: paged.hasMore,
      pages: paged.rows,
      fetchedAt: nowIso(),
      importId: imported.id,
      sourceName: imported.sourceName,
    };
  }
  if (sameSiteUrl(`https://${target}`, `https://${site.domain}`)) {
    const localPages = localScanPagesForDomain(site.id, target, page, pageSize, search);
    if (localPages) {
      return { source: "local-scan", ...localPages };
    }
  }
  return {
    source: "provider-not-configured",
    domain: target,
    page,
    pageSize,
    totalCount: 0,
    hasMore: false,
    pages: [],
    fetchedAt: nowIso(),
    warning: providerRequiredMessage("Domain top pages"),
  };
}

export function listDomainSnapshots(siteId: string) {
  const snapshots = all<any>(
    "SELECT * FROM domain_snapshots WHERE site_id = ? ORDER BY created_at DESC",
    [siteId],
  ).map(publicDomainSnapshotRow);
  return [...listOrganicImports(siteId), ...snapshots].sort(
    (a, b) => new Date(b.created_at || b.createdAt || 0).getTime() - new Date(a.created_at || a.createdAt || 0).getTime(),
  );
}

export async function backlinksOverview(input: { siteId: string; domain?: string }) {
  const site = getSite(input.siteId);
  if (!site) throw notFound("Site not found.");
  const domain = normalizeDomain(input.domain || site.domain);
  if (!domain) throw badRequest("Domain is required.");
  const imported = latestBacklinkImport(site.id, domain);
  if (imported) {
    return {
      source: "backlink-import",
      domain,
      ...imported.summary,
      importId: imported.id,
      sourceName: imported.sourceName,
      createdAt: imported.createdAt,
    };
  }
  return emptyProviderResult("Backlink index data", {
    domain,
    backlinks: null,
    referringDomains: null,
    dofollowRatio: null,
    topAnchors: [],
    prospects: [],
  });
}

export async function getBacklinksProfile(input: {
  siteId: string;
  domain?: string;
  scope?: "domain" | "page";
  tab?: "backlinks" | "domains" | "pages";
  page?: number;
  pageSize?: number;
  sortField?: string;
  sortOrder?: string;
  mode?: string;
}) {
  const site = getSite(input.siteId);
  if (!site) throw notFound("Site not found.");
  const domain = normalizeDomain(input.domain || site.domain);
  if (!domain) throw badRequest("Domain is required.");
  const tab = input.tab || "backlinks";
  const page = Math.max(1, Number(input.page || 1));
  const pageSize = Math.max(10, Math.min(200, Number(input.pageSize || 50)));
  let source = "provider-not-configured";
  let result: any = {
    rows: [],
    totalCount: 0,
    hasMore: false,
    page,
    pageSize,
    fetchedAt: nowIso(),
    warning: providerRequiredMessage("Backlink index data"),
  };

  const imported = latestBacklinkImport(site.id, domain);
  if (imported) {
    const importedRows = imported.rows as ImportedBacklinkRow[];
    const rows: any[] =
      tab === "domains"
        ? backlinkDomainRows(importedRows)
        : tab === "pages"
          ? backlinkPageRows(importedRows)
          : [...importedRows].sort((a, b) => Number(b.rank || 0) - Number(a.rank || 0));
    const pageRows = paginateRows(rows, page, pageSize);
    source = "backlink-import";
    result = {
      ...pageRows,
      page,
      pageSize,
      fetchedAt: nowIso(),
      importId: imported.id,
      sourceName: imported.sourceName,
    };
  }

  return { source, domain, tab, ...result };
}

export function listBacklinkSnapshots(siteId: string) {
  const snapshots = all<any>(
    "SELECT * FROM backlink_snapshots WHERE site_id = ? ORDER BY created_at DESC",
    [siteId],
  ).map(publicDomainSnapshotRow);
  return [...listBacklinkImports(siteId), ...snapshots].sort(
    (a, b) => new Date(b.created_at || b.createdAt || 0).getTime() - new Date(a.created_at || a.createdAt || 0).getTime(),
  );
}

type ImportedBacklinkRow = {
  domainFrom: string;
  urlFrom: string;
  urlTo: string;
  anchor: string;
  itemType: string;
  isDofollow: boolean | null;
  relAttributes: string[];
  rank: number | null;
  domainFromRank: number | null;
  pageFromRank: number | null;
  spamScore: number | null;
  firstSeen: string | null;
  lastSeen: string | null;
  isLost: boolean;
  isBroken: boolean;
  linksCount: number | null;
};

// true / false for explicit yes/no cells, null when the cell is empty or says
// something else.
function csvFlag(row: CsvRow, aliases: string[]) {
  const value = csvText(row, aliases).toLowerCase();
  if (["true", "yes", "y", "1"].includes(value)) return true;
  if (["false", "no", "n", "0"].includes(value)) return false;
  return null;
}

// Whether the link passes authority: false for nofollow/ugc/sponsored, true
// when the export shows a followed link, null when the export does not say.
// Semrush and Ahrefs exports carry Nofollow / UGC / Sponsored flag columns;
// other tools use a rel column or a follow/dofollow column.
function backlinkFollowState(row: CsvRow, relAttributes: string[]) {
  if (csvHasColumn(row, ["rel", "rel attributes", "attributes", "link rel"]) && relAttributes.length) {
    return !/\b(nofollow|ugc|sponsored)\b/i.test(relAttributes.join(" "));
  }
  const flags = [
    csvFlag(row, ["nofollow", "no follow", "is nofollow"]),
    csvFlag(row, ["ugc", "is ugc"]),
    csvFlag(row, ["sponsored", "is sponsored"]),
  ];
  if (flags.includes(true)) return false;
  if (flags[0] === false) return true;
  const follow = csvText(row, ["dofollow", "follow", "is dofollow", "link type", "type"]).toLowerCase();
  if (/\b(nofollow|no follow|ugc|sponsored)\b/.test(follow) || ["false", "no", "0"].includes(follow)) return false;
  if (/\b(dofollow|do follow|follow|followed)\b/.test(follow) || ["true", "yes", "1"].includes(follow)) return true;
  return null;
}

// Only a three-digit HTTP code counts as a status code: "404" or
// "404 Not Found", never the year in "Lost 2024-03-01".
function backlinkHttpStatus(row: CsvRow) {
  const match = /^([1-5]\d\d)\b/.exec(csvText(row, ["http status", "http code", "status code", "status", "link status"]));
  return match ? Number(match[1]) : null;
}

function backlinkDomainFromRow(row: CsvRow, urlFrom: string) {
  const domain = csvText(row, [
    "domain_from",
    "domain from",
    "source_domain",
    "source domain",
    "referring_domain",
    "referring domain",
    "linking_domain",
    "linking domain",
  ]);
  return normalizeDomain(domain || urlFrom);
}

function normalizeImportedBacklinkRow(raw: Record<string, unknown>, fallbackDomain: string): ImportedBacklinkRow | null {
  const row = csvRow(raw);
  const urlFrom =
    csvText(row, [
      "url_from",
      "url from",
      "source_url",
      "source url",
      "source page",
      "referring page",
      "referring page url",
      "referring url",
      "backlink url",
      "from",
    ]) || "";
  const domainFrom = backlinkDomainFromRow(row, urlFrom);
  if (!urlFrom && !domainFrom) return null;
  const urlTo =
    csvText(row, [
      "url_to",
      "url to",
      "target_url",
      "target url",
      "target",
      "destination_url",
      "destination url",
      "linked_url",
      "linked url",
      "landing page",
      "to",
    ]) || `https://${fallbackDomain}`;
  const relAttributes = parseList(csvText(row, ["rel", "rel attributes", "attributes", "link rel"]));
  const status = csvText(row, ["status", "link status"]).toLowerCase();
  const httpStatus = backlinkHttpStatus(row);
  return {
    domainFrom,
    urlFrom: urlFrom || `https://${domainFrom}`,
    urlTo,
    anchor: csvText(row, ["anchor", "anchor text", "text", "link text"]),
    itemType: csvText(row, ["item type", "item_type", "type", "link type"]) || "link",
    isDofollow: backlinkFollowState(row, relAttributes),
    relAttributes,
    rank: csvNumber(row, ["rank", "domain rank", "domain rating", "dr", "authority", "page rank"]),
    domainFromRank: csvNumber(row, ["domain_from_rank", "domain from rank", "domain rank", "domain rating", "dr"]),
    pageFromRank: csvNumber(row, ["page_from_rank", "page from rank", "url rating", "ur", "page rank"]),
    spamScore: csvNumber(row, ["spam score", "spam_score", "toxicity", "toxic score"]),
    firstSeen: csvText(row, ["first seen", "first_seen", "first found", "date first seen"]) || null,
    lastSeen: csvText(row, ["last seen", "last_seen", "last found", "date last seen"]) || null,
    isLost: /\b(lost|removed|deleted|missing)\b/.test(status) || csvFlag(row, ["lost link", "lost", "is lost"]) === true,
    isBroken: (httpStatus !== null && httpStatus >= 400) || /\b(broken|error)\b/.test(status),
    linksCount: csvNumber(row, ["links count", "links_count", "count"]) ?? 1,
  };
}

function parseBacklinkCsv(csv: string) {
  return parseCsvRows(csv, "Backlink CSV").rows;
}

function backlinkSummary(rows: ImportedBacklinkRow[]) {
  const referringDomains = new Set(rows.map((row) => row.domainFrom).filter(Boolean));
  const followKnown = rows.filter((row) => row.isDofollow !== null);
  const dofollowRows = followKnown.filter((row) => row.isDofollow === true).length;
  const anchorCounts = new Map<string, number>();
  for (const row of rows) {
    const anchor = row.anchor || "(empty anchor)";
    anchorCounts.set(anchor, (anchorCounts.get(anchor) || 0) + 1);
  }
  return {
    backlinks: rows.length,
    referringDomains: referringDomains.size,
    // Share of followed links among rows whose export states follow/nofollow;
    // rows without that evidence are counted separately, never as nofollow.
    dofollowRatio: followKnown.length ? Math.round((dofollowRows / followKnown.length) * 100) : null,
    dofollowBacklinks: dofollowRows,
    nofollowBacklinks: followKnown.length - dofollowRows,
    followUnknownBacklinks: rows.length - followKnown.length,
    topAnchors: [...anchorCounts.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 10)
      .map(([anchor, count]) => ({ anchor, count })),
    lostBacklinks: rows.filter((row) => row.isLost).length,
    brokenBacklinks: rows.filter((row) => row.isBroken).length,
    prospects: [],
  };
}

function mapBacklinkImport(row: any) {
  const rows = jsonParse<ImportedBacklinkRow[]>(row.rows_json, []);
  const summary = jsonParse<Record<string, unknown>>(row.summary_json, {});
  return {
    id: row.id,
    siteId: row.site_id,
    domain: row.domain,
    source: "backlink-import",
    sourceName: row.source_name,
    source_name: row.source_name,
    rowCount: row.row_count,
    row_count: row.row_count,
    summary,
    rows,
    createdAt: row.created_at,
    created_at: row.created_at,
  };
}

function latestBacklinkImport(siteId: string, domain: string) {
  const row = get<any>(
    "SELECT * FROM backlink_imports WHERE site_id = ? AND domain = ? ORDER BY created_at DESC LIMIT 1",
    [siteId, domain],
  );
  return row ? mapBacklinkImport(row) : null;
}

export function listBacklinkImports(siteId: string) {
  return all<any>(
    "SELECT * FROM backlink_imports WHERE site_id = ? ORDER BY created_at DESC",
    [siteId],
  ).map(mapBacklinkImport);
}

export function importBacklinksCsv(input: {
  siteId?: string;
  domain?: string;
  sourceName?: string;
  csv?: string;
  rows?: Record<string, unknown>[];
}) {
  const site = getSite(String(input.siteId || ""));
  if (!site) throw notFound("Site not found.");
  const domain = normalizeDomain(input.domain || site.domain);
  if (!domain) throw badRequest("Domain is required.");
  const rawRows = importRows(input, parseBacklinkCsv);
  const rows = rawRows
    .map((row) => normalizeImportedBacklinkRow(row, domain))
    .filter((row): row is ImportedBacklinkRow => Boolean(row))
    .filter((row) => !row.urlTo || sameSiteUrl(row.urlTo, `https://${domain}`));
  if (!rows.length) {
    throw badRequest("Import file has no backlink rows for this domain.");
  }
  const summary = backlinkSummary(rows);
  const id = randomUUID();
  run(
    `
    INSERT INTO backlink_imports
      (id, site_id, domain, source_name, row_count, summary_json, rows_json)
    VALUES (?, ?, ?, ?, ?, ?, ?)
    `,
    [
      id,
      site.id,
      domain,
      String(input.sourceName || "Backlink CSV").slice(0, 160),
      rows.length,
      JSON.stringify(summary),
      JSON.stringify(rows),
    ],
  );
  return mapBacklinkImport(get<any>("SELECT * FROM backlink_imports WHERE id = ?", [id]));
}

function paginateRows<T>(rows: T[], page: number, pageSize: number) {
  const totalCount = rows.length;
  const start = (page - 1) * pageSize;
  return {
    rows: rows.slice(start, start + pageSize),
    totalCount,
    hasMore: start + pageSize < totalCount,
  };
}

function backlinkDomainRows(rows: ImportedBacklinkRow[]) {
  const byDomain = new Map<string, any>();
  for (const row of rows) {
    if (!row.domainFrom) continue;
    const entry = byDomain.get(row.domainFrom) || {
      domain: row.domainFrom,
      backlinks: 0,
      referringPageSet: new Set<string>(),
      rank: null,
      spamScore: null,
      firstSeen: row.firstSeen,
      brokenBacklinks: 0,
      brokenPageSet: new Set<string>(),
    };
    entry.backlinks += 1;
    entry.referringPageSet.add(row.urlFrom);
    entry.rank = Math.max(Number(entry.rank || 0), Number(row.domainFromRank || row.rank || 0)) || null;
    entry.spamScore = Math.max(Number(entry.spamScore || 0), Number(row.spamScore || 0)) || null;
    if (row.isBroken) {
      entry.brokenBacklinks += 1;
      entry.brokenPageSet.add(row.urlTo);
    }
    byDomain.set(row.domainFrom, entry);
  }
  return [...byDomain.values()]
    .map((row) => ({
      domain: row.domain,
      backlinks: row.backlinks,
      referringPages: row.referringPageSet.size,
      rank: row.rank,
      spamScore: row.spamScore,
      firstSeen: row.firstSeen,
      brokenBacklinks: row.brokenBacklinks,
      brokenPages: row.brokenPageSet.size,
    }))
    .sort((a, b) => b.backlinks - a.backlinks);
}

function backlinkPageRows(rows: ImportedBacklinkRow[]) {
  const byPage = new Map<string, any>();
  for (const row of rows) {
    const page = row.urlTo || "/";
    const entry = byPage.get(page) || {
      page,
      backlinks: 0,
      domainSet: new Set<string>(),
      rank: null,
      brokenBacklinks: 0,
    };
    entry.backlinks += 1;
    if (row.domainFrom) entry.domainSet.add(row.domainFrom);
    entry.rank = Math.max(Number(entry.rank || 0), Number(row.rank || row.pageFromRank || 0)) || null;
    if (row.isBroken) entry.brokenBacklinks += 1;
    byPage.set(page, entry);
  }
  return [...byPage.values()]
    .map((row) => ({
      page: row.page,
      backlinks: row.backlinks,
      referringDomains: row.domainSet.size,
      rank: row.rank,
      brokenBacklinks: row.brokenBacklinks,
    }))
    .sort((a, b) => b.backlinks - a.backlinks);
}

function emptySerpResult(keyword: string, domain: string) {
  const normalizedDomain = normalizeDomain(domain);
  return {
    keyword,
    domain: normalizedDomain,
    domainPosition: null,
    rows: [],
    intentMix: null,
    opportunities: [
      "Compare headings from the top three pages before drafting content.",
      "Look for recurring entities and questions in SERP titles.",
      normalizedDomain
        ? "Improve internal links to the ranking URL when this domain is outside the top 5."
        : "Set a site domain to track ownership in ranking rows.",
    ],
  };
}

export async function getSerpAnalysis(input: {
  siteId: string;
  keyword: string;
  domain?: string;
  depth?: number;
}) {
  const site = getSite(input.siteId);
  if (!site) throw notFound("Site not found.");
  const keyword = optionalText(input.keyword, "Keyword") || "";
  if (!keyword) throw badRequest("Keyword is required.");
  const domain = normalizeDomain(input.domain || site.domain);
  const depth = Math.max(10, Math.min(100, Math.round(Number(input.depth)) || 20));
  let source = "search-error";
  let result: any = emptySerpResult(keyword, domain);

  try {
    const outcome = await searchWeb(keyword, {
      depth,
      locationCode: site.location_code,
      languageCode: site.language_code,
    });
    result = {
      ...result,
      rows: outcome.rows.map((row) => ({
        ...row,
        isDomain: domain ? hostMatchesDomain(row.domain, domain) : false,
      })),
      depthChecked: outcome.depthChecked,
      locale: outcome.locale,
    };
    result.domainPosition = result.rows.find((row: any) => row.isDomain)?.rank ?? null;
    source = outcome.source;
  } catch (error) {
    result.warning = error instanceof Error ? error.message : "Search failed";
  }

  const id = randomUUID();
  run(
    `
    INSERT INTO serp_runs
      (id, site_id, keyword, domain, location_code, language_code, source, result_json)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `,
    [
      id,
      site.id,
      keyword,
      domain,
      site.location_code,
      site.language_code,
      source,
      JSON.stringify(result),
    ],
  );
  return { id, source, ...result };
}

export function listSerpRuns(siteId: string) {
  return all<any>(
    "SELECT * FROM serp_runs WHERE site_id = ? ORDER BY created_at DESC",
    [siteId],
  ).map((row) => ({ ...row, result: publicSerpResult(jsonParse(row.result_json, {})) }));
}

// Competitors may be domains or plain brand names; names that are not
// hostnames are kept as typed.
function splitCompetitors(value: unknown) {
  return parseList(value)
    .map((item) => normalizeDomain(item) || item)
    .filter(Boolean);
}

// Results checked per name in a brand lookup (one page of web results).
const BRAND_LOOKUP_RESULTS = 10;

export async function brandLookup(input: {
  siteId: string;
  query?: unknown;
  competitors?: unknown;
}) {
  const site = getSite(input.siteId);
  if (!site) throw notFound("Site not found.");
  const query = optionalText(input.query, "Brand or domain") || site.domain || site.name;
  if (!query) throw badRequest("Brand or domain is required.");
  const competitors = splitCompetitors(input.competitors);
  let source = "web-search";
  const result: any = {
    query,
    resolvedEntity: normalizeDomain(query) || query,
    platforms: [],
    // How many web results an exact-phrase search returned for each name, out
    // of the first BRAND_LOOKUP_RESULTS checked. A raw result count, not a share
    // of voice or visibility score.
    resultCounts: [],
    citations: [],
    recommendations: [
      "Use Search Console and crawl evidence before asking Codex for recommendations.",
      "Create citation-worthy comparison, definition, and proof pages.",
      "Keep entity names consistent in titles, headings, schema, and organization profiles.",
    ],
  };

  // One name at a time: parallel bursts get rate limited by DuckDuckGo.
  for (const label of [query, ...competitors]) {
    const isPrimary = label === query;
    try {
      const outcome = await searchWeb(`"${label}"`, {
        depth: BRAND_LOOKUP_RESULTS,
        locationCode: site.location_code,
        languageCode: site.language_code,
      });
      if (isPrimary) {
        result.citations = outcome.rows;
        source = outcome.source;
      }
      result.resultCounts.push({
        label,
        isPrimary,
        resultCount: outcome.rows.length,
        maxResults: BRAND_LOOKUP_RESULTS,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Brand lookup search failed";
      if (isPrimary) {
        source = "search-error";
        result.warning = message;
      }
      result.resultCounts.push({ label, isPrimary, resultCount: null, maxResults: BRAND_LOOKUP_RESULTS, error: message });
    }
  }
  if (result.citations.length) {
    result.platforms = [{ platform: "web_search", resultCount: result.citations.length, citations: result.citations }];
  }

  const id = randomUUID();
  run(
    `
    INSERT INTO brand_lookup_runs
      (id, site_id, query, competitors, source, result_json)
    VALUES (?, ?, ?, ?, ?, ?)
    `,
    [id, site.id, query, JSON.stringify(competitors), source, JSON.stringify(result)],
  );
  return { id, source, ...publicBrandLookupResult(result) };
}

export function listBrandLookupRuns(siteId: string) {
  return all<any>(
    "SELECT * FROM brand_lookup_runs WHERE site_id = ? ORDER BY created_at DESC",
    [siteId],
  ).map((row) => ({
    ...row,
    competitors: jsonParse<string[]>(row.competitors, []),
    result: publicBrandLookupResult(jsonParse(row.result_json, {})),
  }));
}

export async function promptExplorer(input: {
  siteId: string;
  prompt: string;
  highlightBrand?: string;
  models?: string[];
}) {
  const site = getSite(input.siteId);
  if (!site) throw notFound("Site not found.");
  const prompt = optionalText(input.prompt, "Prompt") || "";
  if (!prompt) throw badRequest("Prompt is required.");
  const highlightBrand = optionalText(input.highlightBrand, "Highlight brand") || site.domain || site.name;
  const models = ["local_codex"];
  const source = "codex";
  const result: any = {
    prompt,
    highlightBrand,
    fetchedAt: nowIso(),
    results: [],
  };

  const job = createAiJob({
    type: "prompt.explorer",
    siteId: site.id,
    prompt: [
      "Analyze this prompt for SEO and AI-answer visibility using only real evidence supplied in the prompt.",
      "Do not invent rankings, citations, traffic, or model mentions.",
      `Prompt: ${prompt}`,
      `Brand/domain to watch: ${highlightBrand}`,
      `Site domain: ${site.domain || "not set"}`,
    ].join("\n"),
  });
  result.jobId = job.id;
  result.results = [
    {
      model: "local_codex",
      status: job.status,
      brandMentioned: null,
      text: "Queued a local Codex analysis job. Open AI lab to read the result when it completes.",
      citations: [],
    },
  ];

  const id = randomUUID();
  run(
    `
    INSERT INTO prompt_explorer_runs
      (id, site_id, prompt, highlight_brand, models, source, result_json)
    VALUES (?, ?, ?, ?, ?, ?, ?)
    `,
    [id, site.id, prompt, highlightBrand, JSON.stringify(models), source, JSON.stringify(result)],
  );
  return { id, source, ...result };
}

// Older runs stored fixed template strings as "fanOutQueries", which read like
// AI output. They were never model results, so history no longer serves them.
function publicPromptExplorerResult(result: any) {
  if (!Array.isArray(result?.results)) return result;
  return {
    ...result,
    results: result.results.map(({ fanOutQueries: _templates, ...row }: any) => row),
  };
}

export function listPromptExplorerRuns(siteId: string) {
  return all<any>(
    "SELECT * FROM prompt_explorer_runs WHERE site_id = ? ORDER BY created_at DESC",
    [siteId],
  ).map((row) => ({
    ...row,
    models: jsonParse<string[]>(row.models, []),
    result: publicPromptExplorerResult(jsonParse(row.result_json, {})),
  }));
}

function csvCell(value: unknown) {
  const text = String(value ?? "");
  return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

export function exportSavedKeywordsCsv(siteId: string) {
  const rows = listSavedKeywords(siteId);
  const header = ["keyword", "search_volume", "difficulty", "cpc", "intent", "tags", "source", "created_at"];
  return [
    header.join(","),
    ...rows.map((row) =>
      [
        row.keyword,
        row.search_volume ?? "",
        row.difficulty ?? "",
        row.cpc ?? "",
        row.intent,
        Array.isArray(row.tags) ? row.tags.join("|") : "",
        row.source,
        row.created_at,
      ]
        .map(csvCell)
        .join(","),
    ),
  ].join("\n");
}

export function dashboardSummary(siteId?: string) {
  const sites = listSites();
  const site = siteId ? getSite(siteId) || sites[0] : sites[0];
  if (!site) {
    return {
      activeSite: null,
      sites: [],
      savedKeywordCount: 0,
      trackerCount: 0,
      scanCount: 0,
      serpRunCount: 0,
      brandLookupCount: 0,
      promptExplorerCount: 0,
      gscImportCount: 0,
      latestGscImport: null,
      latestScans: [],
      latestAiJobs: listAiJobs(),
    };
  }
  const latestGscImport = get<any>(
    "SELECT * FROM gsc_imports WHERE site_id = ? ORDER BY created_at DESC LIMIT 1",
    [site.id],
  );
  return {
    activeSite: site,
    sites: sites,
    savedKeywordCount: get<{ count: number }>(
      "SELECT count(*) AS count FROM saved_keywords WHERE site_id = ?",
      [site.id],
    )?.count || 0,
    trackerCount:
      get<{ count: number }>("SELECT count(*) AS count FROM rank_trackers WHERE site_id = ?", [
        site.id,
      ])?.count || 0,
    scanCount:
      get<{ count: number }>("SELECT count(*) AS count FROM scans WHERE site_id = ?", [
        site.id,
      ])?.count || 0,
    serpRunCount:
      get<{ count: number }>("SELECT count(*) AS count FROM serp_runs WHERE site_id = ?", [
        site.id,
      ])?.count || 0,
    brandLookupCount:
      get<{ count: number }>(
        "SELECT count(*) AS count FROM brand_lookup_runs WHERE site_id = ?",
        [site.id],
      )?.count || 0,
    promptExplorerCount:
      get<{ count: number }>(
        "SELECT count(*) AS count FROM prompt_explorer_runs WHERE site_id = ?",
        [site.id],
      )?.count || 0,
    gscImportCount:
      get<{ count: number }>("SELECT count(*) AS count FROM gsc_imports WHERE site_id = ?", [
        site.id,
      ])?.count || 0,
    latestGscImport: latestGscImport
      ? {
          id: latestGscImport.id,
          siteUrl: latestGscImport.site_url,
          sourceName: latestGscImport.source_name,
          rowCount: latestGscImport.row_count,
          totals: jsonParse(latestGscImport.totals_json, {}),
          createdAt: latestGscImport.created_at,
        }
      : null,
    // Lite rows (no pages/issues); open GET /api/scans/:id for a full report.
    latestScans: listScans(site.id),
    latestAiJobs: listAiJobs(site.id),
  };
}

// Everything saved for a site as metadata and counts. Import rows, scan
// results, and stored SERP/lookup payloads are not parsed here; each has its
// own endpoint that loads the full data on demand.
export function siteSummary(siteId: string) {
  const site = getSite(siteId);
  if (!site) throw notFound("Site not found.");
  return {
    site,
    savedKeywords: listSavedKeywords(siteId),
    keywordMetricImports: all<any>(
      `
      SELECT id, source_name AS sourceName, row_count AS rowCount, inserted_count AS insertedCount,
        updated_count AS updatedCount, created_at AS createdAt
      FROM keyword_metric_imports WHERE site_id = ? ORDER BY created_at DESC
      `,
      [siteId],
    ),
    rankTrackers: listRankTrackers(siteId),
    scans: all<any>(
      `
      SELECT id, url, status, score, pages_crawled, issue_count, error, created_at, updated_at
      FROM scans WHERE site_id = ? ORDER BY created_at DESC
      `,
      [siteId],
    ),
    domainSnapshots: [
      ...all<any>(
        `
        SELECT id, domain, 'organic-import' AS source, source_name AS sourceName, keyword_count AS keywordCount,
          page_count AS pageCount, created_at
        FROM organic_imports WHERE site_id = ?
        `,
        [siteId],
      ),
      ...all<any>("SELECT id, domain, source, created_at FROM domain_snapshots WHERE site_id = ?", [siteId]),
    ].sort(newestFirst),
    backlinkSnapshots: [
      ...all<any>(
        `
        SELECT id, domain, 'backlink-import' AS source, source_name AS sourceName, row_count AS rowCount, created_at
        FROM backlink_imports WHERE site_id = ?
        `,
        [siteId],
      ),
      ...all<any>("SELECT id, domain, source, created_at FROM backlink_snapshots WHERE site_id = ?", [siteId]),
    ].sort(newestFirst),
    serpRuns: all<any>(
      "SELECT id, keyword, domain, source, location_code, language_code, created_at FROM serp_runs WHERE site_id = ? ORDER BY created_at DESC",
      [siteId],
    ),
    brandLookupRuns: all<any>(
      "SELECT id, query, competitors, source, created_at FROM brand_lookup_runs WHERE site_id = ? ORDER BY created_at DESC",
      [siteId],
    ).map((row) => ({ ...row, competitors: jsonParse<string[]>(row.competitors, []) })),
    promptExplorerRuns: all<any>(
      "SELECT id, prompt, highlight_brand, source, created_at FROM prompt_explorer_runs WHERE site_id = ? ORDER BY created_at DESC",
      [siteId],
    ),
  };
}

function newestFirst(a: { created_at: string }, b: { created_at: string }) {
  return String(b.created_at).localeCompare(String(a.created_at));
}

export function domainFromUrl(value: string) {
  const parsed = parseDomain(value);
  return parsed.domain || normalizeDomain(value);
}
