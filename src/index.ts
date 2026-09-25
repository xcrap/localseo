import "./db";
import { recoverInterruptedJobs } from "./db";
import dotenv from "dotenv";
import { Hono } from "hono";
import { serveStatic } from "hono/bun";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import {
  beginLoginAttempt,
  clearLoginFailures,
  createOrReplaceAdmin,
  createSessionToken,
  getAdminByEmail,
  getAdminById,
  getAdminUserCount,
  getAuthConfig,
  publicUser,
  revokeSessionToken,
  secretsEqual,
  verifyPassword,
  verifySessionToken,
} from "./auth";
import { appUrl as configuredAppUrl, getConfigValue, isAppPreferenceKey, listPublicConfig, setConfigValue } from "./config";
import { createAiJob, getAiJob, listAiJobs, listAiPrompts, saveAiPrompt } from "./codex";
import { cwvStatus, startCwvRun } from "./cwv";
import { HttpError, badRequest, notFound } from "./errors";
import {
  createGscAuthUrl,
  disconnectGsc,
  getGscImport,
  gscRedirectUri,
  gscStatus,
  handleGscCallback,
  importGscPerformance,
  inspectGscUrls,
  listGscImports,
  listGscRows,
  listGscSites,
  queryGscPerformance,
  setGscSite,
  syncGscPerformance,
} from "./gsc";
import { cannibalization, contentDecay, gscCrawlInsights } from "./insights";
import { handleMcp, mcpToolList } from "./mcp";
import { deleteNotification, listNotifications, markAllNotificationsRead, markNotificationRead } from "./notifications";
import { scanReport } from "./report";
import { scanAiContext } from "./scan-summary";
import { getSiteSchedule, setScanSchedule, setTrackerSchedule, startScheduler } from "./scheduler";
import { resolveSavedSiteScanUrl, siteScanUrlCandidates, unreachableScanUrlError } from "./site-scan-url";
import { cancelScan, compareScans, getScanPage, ScanRequestError, scanIssueTypeList, testSiteRobots } from "./scans";
import {
  addRankKeywords,
  backlinksOverview,
  brandLookup,
  clearIssueIgnores,
  clearScans,
  createIssueIgnore,
  createSite,
  createRankTracker,
  dashboardSummary,
  deleteIssueIgnore,
  deleteScan,
  deleteSite,
  deleteSavedKeywordTag,
  domainOverview,
  exportSavedKeywordsCsv,
  getScan,
  getBacklinksProfile,
  getDomainKeywordSuggestions,
  getDomainKeywordsPage,
  getDomainPagesPage,
  getRankKeywordHistory,
  getRankRun,
  getRankTrackerTrend,
  getSerpAnalysis,
  getSite,
  importBacklinksCsv,
  importKeywordMetricsCsv,
  importOrganicResearchCsv,
  listBacklinkSnapshots,
  listAllScans,
  listIssueIgnores,
  listRankRuns,
  listScans,
  listBrandLookupRuns,
  listDomainSnapshots,
  listPromptExplorerRuns,
  listSites,
  listRankTrackers,
  listSavedKeywordTags,
  listSavedKeywords,
  listKeywordMetricImports,
  listSerpRuns,
  promptExplorer,
  siteSummary,
  querySavedKeywords,
  researchKeywords,
  syncRankKeywordMetrics,
  removeRankKeywords,
  removeSavedKeywords,
  saveKeywords,
  startRankCheck,
  startScan,
  updateSavedKeywordTag,
  updateSavedKeywordTags,
  updateSite,
} from "./seo";
dotenv.config({ path: ".env", quiet: true });
dotenv.config({ path: ".env.local", override: true, quiet: true });

const app = new Hono();
const isDev = process.env.NODE_ENV !== "production";
const appUrl = configuredAppUrl();
const apiUrl = process.env.API_URL?.trim() || "http://localhost:3031";
const port = Number(portFromUrl(apiUrl) || 3031);
const appPort = Number(portFromUrl(appUrl) || 5173);
// Bind to loopback by default so a local-first workstation is not exposed to
// other devices on the network. Set API_HOST=0.0.0.0 (or a LAN IP) to opt in.
const apiHost = process.env.API_HOST?.trim() || "127.0.0.1";
const mcpBoundBeyondLoopback = !["127.0.0.1", "::1", "localhost", ""].includes(apiHost);
const authConfig = getAuthConfig();
const configuredAppOrigin = normalizeOrigin(appUrl);
// Origins of this app's own pages: the configured app URL, the Vite dev
// server on localhost/127.0.0.1, and the API serving the built app itself.
const appOrigins = new Set(
  [
    configuredAppOrigin,
    `http://localhost:${appPort}`,
    `http://127.0.0.1:${appPort}`,
    `http://localhost:${port}`,
    `http://127.0.0.1:${port}`,
  ].filter((origin): origin is string => Boolean(origin)),
);
// Host names the API answers /api requests for: loopback plus the hosts of
// APP_URL, API_URL, and API_HOST. A DNS-rebinding page (attacker.example
// re-resolved to 127.0.0.1) sends its own name as both Host and Origin, so
// without this list its Origin would match Host and pass as the app itself —
// for example to create the first admin. The Vite dev proxy (changeOrigin)
// sends the API_URL target as Host; the built app is same-origin.
const allowedHostnames = new Set(
  [
    "localhost",
    "127.0.0.1",
    "[::1]",
    hostnameOf(appUrl),
    hostnameOf(apiUrl),
    hostnameOf(`http://${apiHost.includes(":") && !apiHost.startsWith("[") ? `[${apiHost}]` : apiHost}`),
  ].filter(Boolean),
);
const unsafeMethods = new Set(["POST", "PUT", "PATCH", "DELETE"]);

// JSON routes accept only application/json bodies. HTML forms and "simple"
// cross-site fetches can only send text/plain, urlencoded, or multipart
// bodies, so a forged request never reaches a JSON handler.
async function readJson(c: any): Promise<Record<string, any>> {
  const text = await c.req.text();
  if (!text.trim()) return {};
  const contentType = String(c.req.header("content-type") || "").toLowerCase();
  if (!/^application\/([\w.+-]+\+)?json\b/.test(contentType)) {
    throw new HttpError(415, "Request body must be sent as application/json.");
  }
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    throw badRequest("Request body is not valid JSON.");
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw badRequest("Request body must be a JSON object.");
  }
  return body as Record<string, any>;
}

function siteScopedBody(body: Record<string, any>) {
  return body;
}

async function readSiteScopedJson(c: any) {
  return siteScopedBody(await readJson(c));
}

function domainScopedBody(body: Record<string, any>) {
  const scoped = siteScopedBody(body);
  const domain = body.domain;
  return domain ? { ...scoped, domain } : scoped;
}

async function readDomainScopedJson(c: any) {
  return domainScopedBody(await readJson(c));
}

function siteQueryId(c: any) {
  return c.req.query("siteId");
}

function siteBodyId(body: Record<string, any>) {
  return String(body.siteId || "");
}

// Whole-number query parameter within a range; 400 instead of NaN when invalid.
function queryInt(c: any, name: string, fallback: number, min: number, max: number) {
  const raw = c.req.query(name);
  if (raw === undefined || raw === "") return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < min || value > max) {
    throw badRequest(`${name} must be a whole number from ${min} to ${max}.`);
  }
  return value;
}

function normalizeOrigin(value?: string) {
  if (!value?.trim()) return "";
  try {
    return new URL(value).origin;
  } catch {
    return "";
  }
}

function portFromUrl(value?: string) {
  if (!value?.trim()) return "";
  try {
    return new URL(value).port;
  } catch {
    return "";
  }
}

function hostnameOf(url: string) {
  try {
    return new URL(url).hostname;
  } catch {
    return "";
  }
}

function hostAllowed(host: string | undefined) {
  return Boolean(host) && allowedHostnames.has(hostnameOf(`http://${host}`));
}

// The app's own origins, or the origin of the (allowlisted) Host it was served
// from, e.g. a LAN address named in APP_URL or API_HOST.
function isAppOrigin(c: any, origin: string) {
  if (appOrigins.has(origin)) return true;
  const host = c.req.header("host");
  return hostAllowed(host) && (origin === `http://${host}` || origin === `https://${host}`);
}

function currentUser(c: any) {
  const userId = verifySessionToken(getCookie(c, authConfig.sessionCookieName), authConfig);
  if (!userId) return null;
  const user = getAdminById(userId);
  return user ? publicUser(user) : null;
}

function errorStatus(error: unknown) {
  if (error instanceof HttpError) return error.status;
  // Modules that throw plain errors (the crawler) still answer 404/400 for
  // their not-found and missing-input messages.
  const message = error instanceof Error ? error.message : "";
  if (/\bnot found\.?$/i.test(message)) return 404;
  if (/\bis required\.?$/i.test(message)) return 400;
  return 500;
}

function safe(handler: (c: any) => Promise<Response> | Response) {
  return async (c: any) => {
    try {
      return await handler(c);
    } catch (error) {
      const status = errorStatus(error);
      if (status >= 500) console.error(error);
      return c.json(
        { error: error instanceof Error ? error.message : "Internal server error" },
        status,
      );
    }
  };
}

function htmlEscape(value: string) {
  return value.replace(/[&<>"']/g, (char) => `&#${char.charCodeAt(0)};`);
}

// DNS rebinding guard: /api answers only the Host names in allowedHostnames.
app.use("/api/*", async (c, next) => {
  if (!hostAllowed(c.req.header("host"))) {
    return c.json(
      { error: "This server does not answer for that Host. Open the app at APP_URL, localhost, or 127.0.0.1." },
      421,
    );
  }
  await next();
});

// The browser app reaches the API same-origin: through the Vite proxy in
// development and from the API itself in production. Production therefore
// sends no CORS headers; development allows only the configured APP_URL origin.
app.use("/api/*", async (c, next) => {
  const origin = c.req.header("origin");
  if (isDev && origin && origin === configuredAppOrigin) {
    c.header("Access-Control-Allow-Origin", origin);
    c.header("Access-Control-Allow-Credentials", "true");
    c.header("Access-Control-Allow-Headers", "Content-Type, Authorization");
    c.header("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS");
    c.header("Vary", "Origin");
  }
  if (c.req.method === "OPTIONS") return c.body(null, 204);
  await next();
});

// State-changing requests must come from the app itself. Browsers mark
// cross-site requests with Sec-Fetch-Site and always send Origin on
// cross-origin POST/PUT/DELETE, so a page on another site cannot use the
// admin's session cookie to change data. Non-browser clients send neither.
app.use("/api/*", async (c, next) => {
  if (unsafeMethods.has(c.req.method)) {
    const origin = c.req.header("origin");
    if (c.req.header("sec-fetch-site") === "cross-site" || (origin && !isAppOrigin(c, origin))) {
      return c.json({ error: "Cross-site requests are not allowed." }, 403);
    }
  }
  await next();
});

app.get("/api/auth/me", (c) => {
  const setupRequired = getAdminUserCount() === 0;
  const user = currentUser(c);
  if (!user) {
    return c.json({ authenticated: false, setupRequired }, 401);
  }
  return c.json({ authenticated: true, setupRequired: false, user });
});

app.post(
  "/api/auth/setup",
  safe(async (c) => {
    if (getAdminUserCount() > 0) {
      return c.json({ error: "Admin user already exists." }, 409);
    }
    const body = await readJson(c);
    const user = await createOrReplaceAdmin(String(body.email || ""), String(body.password || ""));
    const token = createSessionToken(user.id, authConfig, authConfig.rememberSessionTtlSeconds);
    setCookie(c, authConfig.sessionCookieName, token, {
      httpOnly: true,
      sameSite: "Lax",
      secure: !isDev,
      path: "/",
      maxAge: authConfig.rememberSessionTtlSeconds,
    });
    return c.json({ success: true, user });
  }),
);

app.post(
  "/api/auth/login",
  safe(async (c) => {
    const body = await readJson(c);
    const email = String(body.email || "");
    const password = String(body.password || "");
    const remember = body.remember === true;
    // Counted before the password check, so parallel guesses share the limit.
    const retryAfter = beginLoginAttempt(email);
    if (retryAfter) {
      c.header("Retry-After", String(retryAfter));
      return c.json(
        { error: `Too many failed sign-in attempts. Try again in ${Math.ceil(retryAfter / 60)} minutes.` },
        429,
      );
    }
    const user = getAdminByEmail(email);
    if (!user || !(await verifyPassword(user, password))) {
      return c.json({ error: "Unauthorized" }, 401);
    }
    clearLoginFailures(email);
    const ttl = remember ? authConfig.rememberSessionTtlSeconds : authConfig.sessionTtlSeconds;
    const token = createSessionToken(user.id, authConfig, ttl);
    setCookie(c, authConfig.sessionCookieName, token, {
      httpOnly: true,
      sameSite: "Lax",
      secure: !isDev,
      path: "/",
      maxAge: ttl,
    });
    return c.json({ success: true, user: publicUser(user) });
  }),
);

// Logout revokes this session server-side, not just the cookie in this browser.
app.post("/api/auth/logout", (c) => {
  revokeSessionToken(getCookie(c, authConfig.sessionCookieName), authConfig);
  deleteCookie(c, authConfig.sessionCookieName, { path: "/" });
  return c.json({ success: true });
});

app.use("/api/*", async (c, next) => {
  const allowed = ["/api/auth/me", "/api/auth/login", "/api/auth/setup"];
  if (allowed.some((path) => c.req.path.startsWith(path))) {
    await next();
    return;
  }
  if (!currentUser(c)) {
    return c.json({ error: "Unauthorized" }, 401);
  }
  await next();
});

// The MCP endpoint sits outside the /api/* session guard so external MCP
// clients (which send no session cookie) can reach it. Real MCP clients are not
// browsers and send no Origin header; a browser page on another origin always
// does. Rejecting cross-origin requests blocks a malicious page from silently
// driving MCP tools (starting crawls, spawning Codex jobs) via the user's
// session, while leaving legitimate non-browser clients and the local app
// untouched.
//
// An absent Origin is only a safe proxy for "trusted local client" while the
// server is loopback-bound. Once API_HOST exposes it to the LAN, a bearer token
// (mcp_token) becomes mandatory — otherwise a remote HTTP client could omit
// Origin and invoke privileged tools unauthenticated. Fail closed if no token
// is configured in that mode.
function mcpOriginAllowed(origin?: string) {
  if (!origin) return true;
  return appOrigins.has(origin);
}

app.post("/mcp", async (c) => {
  if (!mcpOriginAllowed(c.req.header("origin"))) {
    return c.json({ error: "Forbidden" }, 403);
  }
  if (mcpBoundBeyondLoopback) {
    const token = getConfigValue("mcp_token");
    const auth = c.req.header("authorization") || "";
    if (!token || !secretsEqual(auth, `Bearer ${token}`)) {
      return c.json(
        { error: "MCP requires a bearer token (mcp_token) when API_HOST is not loopback." },
        401,
      );
    }
  }
  return handleMcp(c);
});
// JSON-RPC only: this server opens no SSE stream on GET.
app.get("/mcp", (c) => {
  c.header("Allow", "POST");
  return c.json({ error: "Use POST for MCP JSON-RPC requests." }, 405);
});
app.get("/api/mcp/tools", (c) => c.json({ tools: mcpToolList() }));

app.get("/api/dashboard", safe((c) => c.json(dashboardSummary(siteQueryId(c)))));

app.get("/api/config", safe((c) => c.json(listPublicConfig())));
app.put(
  "/api/config",
  safe(async (c) => {
    const body = await readJson(c);
    const unsupportedKeys = Object.keys(body).filter((key) => !isAppPreferenceKey(key));
    if (unsupportedKeys.length) {
      return c.json(
        {
          error: `App settings cannot save data-source credentials or environment keys: ${unsupportedKeys.join(", ")}.`,
        },
        400,
      );
    }
    for (const [key, value] of Object.entries(body)) {
      setConfigValue(key, String(value ?? ""));
    }
    return c.json(listPublicConfig());
  }),
);

async function startSavedSiteScan(c: any) {
  const site = getSite(c.req.param("id"));
  if (!site) return c.json({ error: "Site not found." }, 404);
  if (!site.domain) return c.json({ error: "Set a site domain first." }, 400);
  const candidateUrls = siteScanUrlCandidates(site);
  const url = await resolveSavedSiteScanUrl(site);
  if (!url) return c.json({ error: unreachableScanUrlError(site.domain).message }, 400);
  const scan = await startScan(site.id, url, { reachable: true });
  return c.json({
    site: site.domain,
    scan,
    related: [
      {
        key: "technical-scan",
        label: "Technical scan",
        status: "running",
        route: `/scans/${scan.id}`,
        message: `Local crawler is checking ${url} for pages, metadata, links, images, assets, robots, and sitemap.`,
      },
      {
        key: "page-speed",
        label: "Page speed",
        status: "running",
        route: `/scans/${scan.id}?tab=speed`,
        message: "Crawler response timings, HTML weight, compression, and CSS/JS evidence are saved in this scan.",
      },
      {
        key: "domain-intelligence",
        label: "Organic research",
        status: "local",
        route: "/domain",
        message: "Local crawl page evidence will be available from this scan. Third-party ranked keywords and traffic estimates are not generated locally.",
      },
      {
        key: "links",
        label: "Links",
        status: "local",
        route: "/links",
        message: "Local internal, external, and broken-link evidence will be available from this scan. Web-wide backlinks require a real imported index.",
      },
    ],
    scanUrl: url,
    candidateUrls,
    scanPreferences: {
      protocol: site.crawl_protocol || "auto",
      host: site.crawl_host || "auto",
    },
    message: `Started site scan for ${site.domain}.`,
  });
}

app.get("/api/sites", safe((c) => c.json(listSites())));
app.post(
  "/api/sites",
  safe(async (c) => c.json(createSite((await readJson(c)) as any))),
);
app.get("/api/sites/:id", safe((c) => c.json(siteSummary(c.req.param("id")))));
app.put(
  "/api/sites/:id",
  safe(async (c) => c.json(updateSite(c.req.param("id"), await readJson(c)))),
);
app.delete("/api/sites/:id", safe((c) => c.json(deleteSite(c.req.param("id")))));
app.post("/api/sites/:id/scan", safe(startSavedSiteScan));

app.post(
  "/api/keywords/research",
  safe(async (c) => c.json(await researchKeywords((await readSiteScopedJson(c)) as any))),
);
app.get(
  "/api/sites/:id/keywords",
  safe((c) => c.json(listSavedKeywords(c.req.param("id")))),
);
app.post(
  "/api/sites/:id/keywords/query",
  safe(async (c) => c.json(querySavedKeywords({ siteId: c.req.param("id"), ...(await readJson(c)) }))),
);
app.get(
  "/api/sites/:id/keyword-tags",
  safe((c) => c.json(listSavedKeywordTags(c.req.param("id")))),
);
app.post(
  "/api/sites/:id/keywords/tags",
  safe(async (c) =>
    c.json(updateSavedKeywordTags({ siteId: c.req.param("id"), ...(await readJson(c)) } as any)),
  ),
);
app.put(
  "/api/sites/:id/keyword-tags/:tagId",
  safe(async (c) =>
    c.json(updateSavedKeywordTag({ siteId: c.req.param("id"), tagId: c.req.param("tagId"), ...(await readJson(c)) })),
  ),
);
app.delete(
  "/api/sites/:id/keyword-tags/:tagId",
  safe((c) => c.json(deleteSavedKeywordTag({ siteId: c.req.param("id"), tagId: c.req.param("tagId") }))),
);
app.post(
  "/api/sites/:id/keywords/remove",
  safe(async (c) => {
    const body = await readJson(c);
    return c.json(removeSavedKeywords(c.req.param("id"), body.savedKeywordIds || body.ids || []));
  }),
);
app.get(
  "/api/sites/:id/keywords.csv",
  safe((c) => {
    const csv = exportSavedKeywordsCsv(c.req.param("id"));
    return new Response(csv, {
      headers: {
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": `attachment; filename="local-seo-keywords-${c.req.param("id")}.csv"`,
      },
    });
  }),
);
app.get(
  "/api/sites/:id/keyword-metric-imports",
  safe((c) => c.json(listKeywordMetricImports(c.req.param("id")))),
);
app.post(
  "/api/keywords/import-metrics",
  safe(async (c) => c.json(importKeywordMetricsCsv((await readSiteScopedJson(c)) as any))),
);
app.post(
  "/api/keywords/save",
  safe(async (c) => c.json(saveKeywords((await readSiteScopedJson(c)) as any))),
);
app.get(
  "/api/sites/:id/serp",
  safe((c) => c.json(listSerpRuns(c.req.param("id")))),
);
app.post(
  "/api/serp/analyze",
  safe(async (c) => c.json(await getSerpAnalysis((await readDomainScopedJson(c)) as any))),
);

app.get(
  "/api/sites/:id/rank-trackers",
  safe((c) => c.json(listRankTrackers(c.req.param("id")))),
);
app.post(
  "/api/rank-trackers",
  safe(async (c) => c.json(createRankTracker((await readSiteScopedJson(c)) as any))),
);
app.post(
  "/api/rank-trackers/:id/keywords",
  safe(async (c) => {
    const body = await readJson(c);
    addRankKeywords(c.req.param("id"), body.keywords || []);
    return c.json({ success: true });
  }),
);
app.post(
  "/api/rank-trackers/:id/keywords/remove",
  safe(async (c) => {
    const body = await readJson(c);
    return c.json(removeRankKeywords(c.req.param("id"), body.keywordIds || []));
  }),
);
app.post(
  "/api/rank-trackers/:id/sync-metrics",
  safe((c) => c.json(syncRankKeywordMetrics(c.req.param("id")))),
);
app.get(
  "/api/rank-trackers/:id/trend",
  safe((c) => c.json(getRankTrackerTrend(c.req.param("id"), queryInt(c, "sinceDays", 365, 1, 730)))),
);
app.get(
  "/api/rank-trackers/:id/keywords/:keywordId/history",
  safe((c) =>
    c.json(
      getRankKeywordHistory({
        trackerId: c.req.param("id"),
        keywordId: c.req.param("keywordId"),
        sinceDays: queryInt(c, "sinceDays", 365, 1, 730),
      }),
    ),
  ),
);
// Starts the check in the background and answers at once with
// { runId, alreadyRunning, run, tracker }; poll the run until it finishes.
app.post(
  "/api/rank-trackers/:id/check",
  safe((c) => c.json(startRankCheck(c.req.param("id")))),
);
app.get(
  "/api/rank-trackers/:id/runs",
  safe((c) =>
    c.json(listRankRuns(c.req.param("id"), queryInt(c, "limit", 50, 1, 500), queryInt(c, "offset", 0, 0, 1_000_000))),
  ),
);
app.get(
  "/api/rank-trackers/:id/runs/:runId",
  safe((c) => c.json(getRankRun(c.req.param("id"), c.req.param("runId")))),
);

app.post("/api/domain/overview", safe(async (c) => c.json(await domainOverview((await readDomainScopedJson(c)) as any))));
app.get(
  "/api/sites/:id/domain-snapshots",
  safe((c) => c.json(listDomainSnapshots(c.req.param("id")))),
);
app.post(
  "/api/domain/keyword-suggestions",
  safe(async (c) => c.json(await getDomainKeywordSuggestions((await readDomainScopedJson(c)) as any))),
);
app.post(
  "/api/domain/keywords",
  safe(async (c) => c.json(await getDomainKeywordsPage((await readDomainScopedJson(c)) as any))),
);
app.post(
  "/api/domain/pages",
  safe(async (c) => c.json(await getDomainPagesPage((await readDomainScopedJson(c)) as any))),
);
app.post(
  "/api/domain/import",
  safe(async (c) => c.json(importOrganicResearchCsv((await readDomainScopedJson(c)) as any))),
);
app.post(
  "/api/backlinks/overview",
  safe(async (c) => c.json(await backlinksOverview((await readDomainScopedJson(c)) as any))),
);
app.get(
  "/api/sites/:id/backlink-snapshots",
  safe((c) => c.json(listBacklinkSnapshots(c.req.param("id")))),
);
app.post(
  "/api/backlinks/profile",
  safe(async (c) => c.json(await getBacklinksProfile((await readDomainScopedJson(c)) as any))),
);
app.post(
  "/api/backlinks/import",
  safe(async (c) => c.json(importBacklinksCsv((await readDomainScopedJson(c)) as any))),
);
app.get(
  "/api/sites/:id/brand-lookup",
  safe((c) => c.json(listBrandLookupRuns(c.req.param("id")))),
);
app.post(
  "/api/brand-lookup",
  safe(async (c) => c.json(await brandLookup((await readSiteScopedJson(c)) as any))),
);
app.get(
  "/api/sites/:id/prompt-explorer",
  safe((c) => c.json(listPromptExplorerRuns(c.req.param("id")))),
);
app.post(
  "/api/prompt-explorer",
  safe(async (c) => c.json(await promptExplorer((await readSiteScopedJson(c)) as any))),
);

const listSiteScansHandler = safe((c: any) => c.json(listScans(c.req.param("id"))));
const listAllScansHandler = safe((c: any) => c.json(listAllScans()));
const getScanHandler = safe((c: any) => {
  const scan = getScan(c.req.param("id"));
  if (!scan) throw notFound("Scan not found.");
  return c.json(scan);
});
const clearSiteScansHandler = safe((c: any) => c.json(clearScans(c.req.param("id"))));
const deleteSiteScanHandler = safe((c: any) => c.json(deleteScan(c.req.param("siteId"), c.req.param("id"))));
const startScanHandler = safe(async (c: any) => {
  const body = await readJson(c);
  const url = typeof body.url === "string" ? body.url.trim() : "";
  if (!url) throw badRequest("A scan URL is required.");
  return c.json(await startScan(siteBodyId(body), url));
});

app.get("/api/sites/:id/scans", listSiteScansHandler);
app.get("/api/scans", listAllScansHandler);
app.get("/api/scans/:id", getScanHandler);
app.delete("/api/sites/:id/scans", clearSiteScansHandler);
app.delete("/api/sites/:siteId/scans/:id", deleteSiteScanHandler);
app.post("/api/scans", startScanHandler);
// Scan detail routes answer 404/400 for unknown scans or pages and bad input.
const scanRoute = (handler: (c: any) => unknown) =>
  safe(async (c: any) => {
    try {
      return c.json(await handler(c));
    } catch (error) {
      if (error instanceof ScanRequestError) return c.json({ error: error.message }, error.status);
      throw error;
    }
  });
app.get("/api/scan-issue-types", safe((c) => c.json(scanIssueTypeList())));
app.get("/api/scans/:id/page", scanRoute((c) => getScanPage(c.req.param("id"), String(c.req.query("url") || ""))));
app.get("/api/scans/:id/compare/:baseId", scanRoute((c) => compareScans(c.req.param("id"), c.req.param("baseId"))));
app.post("/api/scans/:id/cancel", scanRoute((c) => cancelScan(c.req.param("id"))));
app.post("/api/sites/:id/robots-test", scanRoute(async (c) => testSiteRobots(c.req.param("id"), await readJson(c))));
app.get("/api/sites/:id/issue-ignores", safe((c) => c.json(listIssueIgnores(c.req.param("id")))));
app.post(
  "/api/sites/:id/issue-ignores",
  safe(async (c) => c.json(createIssueIgnore(c.req.param("id"), (await readJson(c)) as any))),
);
app.delete("/api/sites/:id/issue-ignores", safe((c) => c.json(clearIssueIgnores(c.req.param("id")))));
app.delete(
  "/api/sites/:id/issue-ignores/:ignoreId",
  safe((c) => c.json(deleteIssueIgnore(c.req.param("id"), c.req.param("ignoreId")))),
);

app.get("/api/ai/prompts", safe((c) => c.json(listAiPrompts())));
app.put(
  "/api/ai/prompts/:key",
  safe(async (c) => {
    const body = await readJson(c);
    saveAiPrompt(c.req.param("key"), String(body.template || ""));
    return c.json({ success: true });
  }),
);
// ?siteId= keeps that site's jobs plus jobs saved without a site.
app.get("/api/ai/jobs", safe((c) => c.json(listAiJobs(siteQueryId(c) || undefined))));
app.get(
  "/api/ai/jobs/:id",
  safe((c) => {
    const job = getAiJob(c.req.param("id"));
    if (!job) throw notFound("AI job not found.");
    return c.json(job);
  }),
);
app.post(
  "/api/ai/jobs",
  safe(async (c) => c.json(createAiJob(await readJson(c)))),
);

app.get("/api/gsc/status/:siteId", safe((c) => c.json(gscStatus(c.req.param("siteId")))));
app.get("/api/gsc/imports/:siteId", safe((c) => c.json(listGscImports(c.req.param("siteId")))));
app.get(
  "/api/gsc/imports/:siteId/:importId",
  safe((c) => c.json(getGscImport(c.req.param("siteId"), c.req.param("importId")))),
);
app.post(
  "/api/gsc/start",
  safe(async (c) => {
    const body = await readJson(c);
    return c.json({ url: createGscAuthUrl(siteBodyId(body)), redirectUri: gscRedirectUri() });
  }),
);
// Google redirects the signed-in admin's browser here (the session guard
// applies). The state must be one this server issued; it names the site. The
// old per-site form (?siteId=...) is still accepted.
app.get("/api/gsc/callback", async (c) => {
  let status = 200;
  let message = "Google Search Console connected. You can close this tab.";
  try {
    await handleGscCallback({
      state: c.req.query("state") || "",
      code: c.req.query("code") || "",
      error: c.req.query("error") || "",
      legacySiteId: c.req.query("siteId") || "",
    });
  } catch (error) {
    status = errorStatus(error);
    message = error instanceof Error ? error.message : "Google Search Console connection failed.";
  }
  const script = status === 200 ? "<script>window.close()</script>" : "";
  return c.html(`<html><body>${script}<p>${htmlEscape(message)}</p></body></html>`, status as ContentfulStatusCode);
});
app.get("/api/gsc/sites/:siteId", safe(async (c) => c.json(await listGscSites(c.req.param("siteId")))));
app.post(
  "/api/gsc/site",
  safe(async (c) => {
    const body = await readJson(c);
    return c.json(setGscSite(siteBodyId(body), body.siteUrl));
  }),
);
// Fetches every Search Analytics row for { startDate, endDate, dimensions }
// and stores it locally as one batch (source "api").
app.post(
  "/api/sites/:id/gsc/sync",
  safe(async (c) => c.json(await syncGscPerformance({ ...(await readJson(c)), siteId: c.req.param("id") }))),
);
app.get(
  "/api/sites/:id/gsc/rows",
  safe((c) =>
    c.json(
      listGscRows(c.req.param("id"), {
        dimensions: c.req.query("dimensions"),
        startDate: c.req.query("startDate"),
        endDate: c.req.query("endDate"),
        importId: c.req.query("importId"),
        limit: queryInt(c, "limit", 1000, 1, 10_000),
        offset: queryInt(c, "offset", 0, 0, 100_000_000),
      }),
    ),
  ),
);
app.post(
  "/api/gsc/performance",
  safe(async (c) => c.json(await queryGscPerformance((await readSiteScopedJson(c)) as any))),
);
app.post(
  "/api/gsc/import",
  safe(async (c) => c.json(importGscPerformance((await readSiteScopedJson(c)) as any))),
);
app.post(
  "/api/gsc/inspect",
  safe(async (c) => c.json(await inspectGscUrls((await readSiteScopedJson(c)) as any))),
);
app.post(
  "/api/gsc/disconnect",
  safe(async (c) => {
    const body = await readJson(c);
    return c.json(disconnectGsc(siteBodyId(body)));
  }),
);

// Search Console × crawl analyses (src/insights.ts). Missing data answers
// { available: false, reason } instead of estimates.
app.get("/api/sites/:id/insights/gsc-crawl", safe((c) => c.json(gscCrawlInsights(c.req.param("id"), c.req.query()))));
app.get("/api/sites/:id/insights/cannibalization", safe((c) => c.json(cannibalization(c.req.param("id"), c.req.query()))));
app.get("/api/sites/:id/insights/decay", safe((c) => c.json(contentDecay(c.req.param("id"), c.req.query()))));

// Scheduled scans and rank checks (src/scheduler.ts) and their notifications.
app.get("/api/sites/:id/schedule", safe((c) => c.json(getSiteSchedule(c.req.param("id")))));
app.put("/api/sites/:id/schedule", safe(async (c) => c.json(setScanSchedule(c.req.param("id"), await readJson(c)))));
app.put(
  "/api/rank-trackers/:id/schedule",
  safe(async (c) => c.json(setTrackerSchedule(c.req.param("id"), await readJson(c)))),
);
app.get("/api/notifications", safe((c) => c.json(listNotifications(c.req.query()))));
app.post("/api/notifications/read-all", safe(async (c) => c.json(markAllNotificationsRead(await readJson(c)))));
app.post("/api/notifications/:id/read", safe((c) => c.json(markNotificationRead(c.req.param("id")))));
app.delete("/api/notifications/:id", safe((c) => c.json(deleteNotification(c.req.param("id")))));

// Core Web Vitals from PageSpeed Insights (src/cwv.ts), run in the background.
app.get("/api/sites/:id/cwv", safe((c) => c.json(cwvStatus(c.req.param("id")))));
app.post("/api/sites/:id/cwv", safe(async (c) => c.json(startCwvRun(c.req.param("id"), await readJson(c)))));

// Shareable HTML report and a compact Codex brief for one scan.
app.get(
  "/api/scans/:id/report.html",
  safe((c) => {
    const { html, filename } = scanReport(c.req.param("id"));
    const headers: Record<string, string> = { "Content-Type": "text/html; charset=utf-8" };
    if (c.req.query("download") === "1") headers["Content-Disposition"] = `attachment; filename="${filename}"`;
    return new Response(html, { headers });
  }),
);
app.get("/api/scans/:id/ai-context", safe((c) => c.json(scanAiContext(c.req.param("id")))));
// Unknown API paths must stay JSON 404s instead of falling through to the SPA's index.html.
app.all("/api/*", (c) => c.json({ error: "Not found." }, 404));

if (!isDev) {
  app.use("/*", serveStatic({ root: "./web/dist" }));
  app.get("/*", serveStatic({ root: "./web/dist", path: "index.html" }));
}

const recovered = recoverInterruptedJobs();
if (recovered.scans || recovered.jobs || recovered.rankRuns || recovered.cwvRuns) {
  console.log(
    `Recovered ${recovered.scans} interrupted scan(s), ${recovered.jobs} interrupted job(s), ${recovered.rankRuns} interrupted rank check(s), and ${recovered.cwvRuns} interrupted PageSpeed run(s) from a previous run.`,
  );
}
const schedulerTickMs = startScheduler();
if (!schedulerTickMs) console.log("Scheduler disabled (SCHEDULER_DISABLED).");

console.log(`Local SEO API running on http://${apiHost === "0.0.0.0" ? "localhost" : apiHost}:${port}`);
if (mcpBoundBeyondLoopback && !getConfigValue("mcp_token")) {
  console.warn(
    `API_HOST=${apiHost} exposes this server beyond loopback but no mcp_token is set — the MCP endpoint is disabled until you configure one.`,
  );
}

export default {
  port,
  hostname: apiHost,
  fetch: app.fetch,
};
