import type { Context } from "hono";
import { secretsEqual } from "./auth";
import { getConfigValue } from "./config";
import { createAiJob, getAiJob } from "./codex";
import { notFound } from "./errors";
import { analysisHandlers, analysisTools, type ToolDefinition } from "./mcp-analysis-tools";
import { requireScan, scanOverview } from "./scan-summary";
import {
  createSite,
  brandLookup,
  backlinksOverview,
  getBacklinksProfile,
  getDomainKeywordSuggestions,
  getDomainKeywordsPage,
  getDomainPagesPage,
  getSerpAnalysis,
  domainOverview,
  getSite,
  importBacklinksCsv,
  importKeywordMetricsCsv,
  importOrganicResearchCsv,
  listRankTrackers,
  listSites,
  listSavedKeywords,
  querySavedKeywords,
  promptExplorer,
  siteSummary,
  researchKeywords,
  saveKeywords,
  startScan,
  updateSavedKeywordTags,
} from "./seo";
import { getGscPerformance, inspectGscUrls } from "./gsc";
import { resolveSavedSiteScanUrl, siteScanUrlCandidates, unreachableScanUrlError } from "./site-scan-url";

type JsonRpcId = string | number | null;

const SUPPORTED_PROTOCOL_VERSIONS = ["2025-06-18", "2025-03-26", "2024-11-05"];

const siteIdInput = {
  siteId: { type: "string", description: "Local site id." },
};

const coreTools: ToolDefinition[] = [
  {
    name: "whoami",
    description: "Return local MCP server information.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "list_sites",
    description: "List local SEO sites.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "create_site",
    description: "Create a local SEO site.",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string" },
        domain: { type: "string" },
      },
      required: ["name"],
    },
  },
  {
    name: "get_site_summary",
    description: "Get saved keywords, trackers, scans, and snapshots for a site.",
    inputSchema: {
      type: "object",
      properties: siteIdInput,
      required: ["siteId"],
    },
  },
  {
    name: "research_keywords",
    description: "Run local keyword research from real DuckDuckGo suggestions. Third-party metrics are not generated locally.",
    inputSchema: {
      type: "object",
      properties: {
        ...siteIdInput,
        query: { type: "string" },
        limit: { type: "number" },
      },
      required: ["siteId", "query"],
    },
  },
  {
    name: "analyze_serp",
    description:
      "Check one page of web search results for a keyword and show where the active site or a comparison domain appears. Results come from the configured OpenSERP or SearXNG instance, otherwise DuckDuckGo — not Google.",
    inputSchema: {
      type: "object",
      properties: {
        ...siteIdInput,
        keyword: { type: "string" },
        domain: { type: "string", description: "Optional active-site or competitor domain to highlight in the ranking rows." },
        depth: { type: "number" },
      },
      required: ["siteId", "keyword"],
    },
  },
  {
    name: "list_saved_keywords",
    description: "List saved keywords for a site.",
    inputSchema: {
      type: "object",
      properties: siteIdInput,
      required: ["siteId"],
    },
  },
  {
    name: "query_saved_keywords",
    description: "Filter, sort, and paginate saved keywords for a site.",
    inputSchema: {
      type: "object",
      properties: {
        ...siteIdInput,
        search: { type: "string" },
        tagNames: { type: "array", items: { type: "string" } },
        page: { type: "number" },
        pageSize: { type: "number" },
      },
      required: ["siteId"],
    },
  },
  {
    name: "save_keywords",
    description: "Save keyword rows to a site.",
    inputSchema: {
      type: "object",
      properties: {
        ...siteIdInput,
        keywords: { type: "array" },
      },
      required: ["siteId", "keywords"],
    },
  },
  {
    name: "import_keyword_metrics",
    description: "Import real keyword metrics CSV rows into local SQLite for a saved site.",
    inputSchema: {
      type: "object",
      properties: {
        ...siteIdInput,
        sourceName: { type: "string" },
        csv: { type: "string" },
      },
      required: ["siteId", "csv"],
    },
  },
  {
    name: "update_saved_keyword_tags",
    description: "Add or remove tags on saved keywords.",
    inputSchema: {
      type: "object",
      properties: {
        ...siteIdInput,
        savedKeywordIds: { type: "array", items: { type: "string" } },
        addTags: { type: "array", items: { type: "string" } },
        removeTagNames: { type: "array", items: { type: "string" } },
      },
      required: ["siteId", "savedKeywordIds"],
    },
  },
  {
    name: "get_domain_overview",
    description: "Read organic research metrics for a domain from its latest imported organic CSV. Metrics stay null without an import.",
    inputSchema: {
      type: "object",
      properties: {
        ...siteIdInput,
        domain: { type: "string" },
      },
      required: ["siteId", "domain"],
    },
  },
  {
    name: "get_domain_keyword_suggestions",
    description: "List ranked keywords for a domain from its latest imported organic CSV.",
    inputSchema: {
      type: "object",
      properties: {
        ...siteIdInput,
        domain: { type: "string" },
        limit: { type: "number" },
      },
      required: ["siteId"],
    },
  },
  {
    name: "get_domain_keywords_page",
    description: "Get a paginated domain ranked-keywords table.",
    inputSchema: {
      type: "object",
      properties: {
        ...siteIdInput,
        domain: { type: "string" },
        page: { type: "number" },
        pageSize: { type: "number" },
        sortMode: { type: "string" },
        sortOrder: { type: "string" },
      },
      required: ["siteId"],
    },
  },
  {
    name: "get_domain_pages_page",
    description: "Get a paginated domain top-pages table.",
    inputSchema: {
      type: "object",
      properties: {
        ...siteIdInput,
        domain: { type: "string" },
        page: { type: "number" },
        pageSize: { type: "number" },
      },
      required: ["siteId"],
    },
  },
  {
    name: "import_organic_research",
    description: "Import real organic ranked-keyword and top-page CSV rows into local SQLite for a saved site.",
    inputSchema: {
      type: "object",
      properties: {
        ...siteIdInput,
        domain: { type: "string" },
        sourceName: { type: "string" },
        csv: { type: "string" },
      },
      required: ["siteId", "csv"],
    },
  },
  {
    name: "get_backlinks_overview",
    description: "Read backlink summary metrics for a domain from its latest imported backlink CSV. Metrics stay null without an import.",
    inputSchema: {
      type: "object",
      properties: {
        ...siteIdInput,
        domain: { type: "string" },
      },
      required: ["siteId", "domain"],
    },
  },
  {
    name: "get_backlinks_profile",
    description: "Get backlink rows, referring domains, or top linked pages.",
    inputSchema: {
      type: "object",
      properties: {
        ...siteIdInput,
        domain: { type: "string" },
        tab: { type: "string", enum: ["backlinks", "domains", "pages"] },
        page: { type: "number" },
        pageSize: { type: "number" },
      },
      required: ["siteId", "domain"],
    },
  },
  {
    name: "import_backlinks",
    description: "Import real backlink CSV rows into local SQLite for a saved site.",
    inputSchema: {
      type: "object",
      properties: {
        ...siteIdInput,
        domain: { type: "string" },
        sourceName: { type: "string" },
        csv: { type: "string" },
      },
      required: ["siteId", "csv"],
    },
  },
  {
    name: "get_rank_tracker",
    description:
      "Get rank trackers for a site (or one tracker): keywords, latest positions from completed checks, and recent check runs.",
    inputSchema: {
      type: "object",
      properties: {
        ...siteIdInput,
        trackerId: { type: "string" },
      },
      required: ["siteId"],
    },
  },
  {
    name: "start_scan",
    description: "Start a local crawl scan for a site URL.",
    inputSchema: {
      type: "object",
      properties: {
        ...siteIdInput,
        url: { type: "string" },
      },
      required: ["siteId", "url"],
    },
  },
  {
    name: "scan_site",
    description: "Start a local crawl scan for a saved site using its saved scan plan unless a URL is supplied.",
    inputSchema: {
      type: "object",
      properties: {
        ...siteIdInput,
        url: { type: "string" },
      },
      required: ["siteId"],
    },
  },
  {
    name: "get_scan",
    description:
      "Read a saved scan's summary by id (like get_scan_summary). Use get_scan_issues and get_scan_page for evidence; full: true returns the complete saved result, which can be several MB.",
    inputSchema: {
      type: "object",
      properties: {
        scanId: { type: "string" },
        full: { type: "boolean", description: "Return the complete saved scan result." },
      },
      required: ["scanId"],
    },
  },
  {
    name: "get_gsc_performance",
    description: "Read Search Console performance for a saved site live from Google OAuth, or from the latest locally stored CSV import or API sync.",
    inputSchema: {
      type: "object",
      properties: {
        ...siteIdInput,
        startDate: { type: "string" },
        endDate: { type: "string" },
        dimensions: { type: "array", items: { type: "string" } },
      },
      required: ["siteId", "startDate", "endDate"],
    },
  },
  {
    name: "inspect_urls",
    description: "Inspect URLs through Google Search Console URL Inspection API.",
    inputSchema: {
      type: "object",
      properties: {
        ...siteIdInput,
        urls: { type: "array", items: { type: "string" } },
        siteUrl: { type: "string" },
      },
      required: ["siteId", "urls"],
    },
  },
  {
    name: "brand_lookup",
    description: "Run brand lookup from real web-search citations and local recommendations.",
    inputSchema: {
      type: "object",
      properties: {
        ...siteIdInput,
        query: { type: "string" },
        competitors: { type: "array", items: { type: "string" } },
      },
      required: ["siteId", "query"],
    },
  },
  {
    name: "prompt_explorer",
    description: "Run a prompt through local Codex and save the job in SQLite.",
    inputSchema: {
      type: "object",
      properties: {
        ...siteIdInput,
        prompt: { type: "string" },
        highlightBrand: { type: "string" },
        models: { type: "array", items: { type: "string" } },
      },
      required: ["siteId", "prompt"],
    },
  },
  {
    name: "start_ai_job",
    description:
      "Queue a local Codex CLI job; it is saved in SQLite and runs in the background. Jobs of type scan.prioritize, or with context or scanId, run without Codex web search because their prompt carries crawled page text.",
    inputSchema: {
      type: "object",
      properties: {
        type: { type: "string" },
        prompt: { type: "string" },
        siteId: { type: "string", description: "Optional local site id the job belongs to." },
      },
      required: ["type", "prompt"],
    },
  },
  {
    name: "get_ai_job",
    description: "Read a local Codex job.",
    inputSchema: {
      type: "object",
      properties: { jobId: { type: "string" } },
      required: ["jobId"],
    },
  },
];

const tools: ToolDefinition[] = [...coreTools, ...analysisTools];

function isObject(value: unknown): value is Record<string, any> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function rpcResult(c: Context, id: JsonRpcId, result: unknown) {
  return c.json({ jsonrpc: "2.0", id, result });
}

// Errors for a request that could not be identified (bad JSON, not a JSON-RPC
// request) are HTTP 400; errors answering a valid request are HTTP 200.
function rpcError(c: Context, id: JsonRpcId, code: number, message: string, status: 200 | 400 = 200) {
  return c.json({ jsonrpc: "2.0", id, error: { code, message } }, status);
}

function argumentProblem(tool: ToolDefinition, args: Record<string, any>) {
  for (const name of tool.inputSchema.required || []) {
    if (args[name] === undefined || args[name] === null || args[name] === "") return `Missing required argument: ${name}.`;
  }
  for (const [name, value] of Object.entries(args)) {
    const property = tool.inputSchema.properties[name];
    const expected = property?.type;
    if (value === undefined || value === null || !expected) continue;
    const valid =
      expected === "array" ? Array.isArray(value) : expected === "number" ? typeof value === "number" : typeof value === expected;
    if (!valid) return `Argument ${name} must be ${expected === "array" ? "an array" : `a ${expected}`}.`;
    if (Array.isArray(property.enum) && !property.enum.includes(value)) {
      return `Argument ${name} must be one of: ${property.enum.join(", ")}.`;
    }
    if (typeof value === "number" && (value < (property.minimum ?? -Infinity) || value > (property.maximum ?? Infinity))) {
      const range =
        property.maximum === undefined
          ? `at least ${property.minimum}`
          : property.minimum === undefined
            ? `at most ${property.maximum}`
            : `from ${property.minimum} to ${property.maximum}`;
      return `Argument ${name} must be ${range}.`;
    }
  }
  return "";
}

// MCP over HTTP: one JSON-RPC message per POST. Notifications and client
// responses get 202 with no body; tool failures are tool results with
// isError, not protocol errors.
export async function handleMcp(c: Context) {
  const token = getConfigValue("mcp_token");
  if (token && !secretsEqual(c.req.header("authorization") || "", `Bearer ${token}`)) {
    return c.json({ error: "Unauthorized" }, 401);
  }

  let message: unknown;
  try {
    message = JSON.parse(await c.req.text());
  } catch {
    return rpcError(c, null, -32700, "Parse error", 400);
  }
  if (!isObject(message) || message.jsonrpc !== "2.0") {
    return rpcError(c, null, -32600, "Invalid Request", 400);
  }
  const hasId = "id" in message;
  const id = message.id as JsonRpcId;
  if (hasId && !(typeof id === "string" || typeof id === "number" || id === null)) {
    return rpcError(c, null, -32600, "Invalid Request", 400);
  }
  if (typeof message.method !== "string") {
    // A response to a server request carries result/error and needs no reply.
    if (hasId && ("result" in message || "error" in message)) return c.body(null, 202);
    return rpcError(c, hasId ? id : null, -32600, "Invalid Request", 400);
  }
  if (!hasId) return c.body(null, 202);
  if (message.params !== undefined && !isObject(message.params)) {
    return rpcError(c, id, -32602, "Invalid params: params must be an object.");
  }
  const params = (message.params || {}) as Record<string, any>;

  switch (message.method) {
    case "initialize": {
      const requested = params.protocolVersion;
      return rpcResult(c, id, {
        protocolVersion: SUPPORTED_PROTOCOL_VERSIONS.includes(requested) ? requested : SUPPORTED_PROTOCOL_VERSIONS[0],
        serverInfo: { name: "local-seo", version: "0.1.0" },
        capabilities: { tools: {} },
      });
    }
    case "ping":
      return rpcResult(c, id, {});
    case "tools/list":
      return rpcResult(c, id, { tools });
    case "tools/call": {
      const tool = tools.find((item) => item.name === params.name);
      if (!tool) return rpcError(c, id, -32602, `Unknown tool: ${String(params.name ?? "")}`);
      if (params.arguments !== undefined && !isObject(params.arguments)) {
        return rpcError(c, id, -32602, "Invalid params: arguments must be an object.");
      }
      const args = params.arguments || {};
      const problem = argumentProblem(tool, args);
      if (problem) return rpcError(c, id, -32602, `Invalid params: ${problem}`);
      try {
        const result = await callTool(tool.name, args);
        return rpcResult(c, id, {
          content: [
            {
              type: "text",
              text: typeof result === "string" ? result : JSON.stringify(result, null, 2),
            },
          ],
          // structuredContent must be a JSON object; lists and scalars are wrapped.
          structuredContent: isObject(result) ? result : { result: result ?? null },
        });
      } catch (error) {
        return rpcResult(c, id, {
          content: [{ type: "text", text: error instanceof Error ? error.message : "Tool failed" }],
          isError: true,
        });
      }
    }
    default:
      return rpcError(c, id, -32601, "Method not found");
  }
}

async function callTool(name: string, args: any) {
  const analysisHandler = analysisHandlers[name];
  if (analysisHandler) return analysisHandler(args);
  const withDomainInput = (input: any) => {
    const domain = input?.domain;
    return domain ? { ...input, domain } : input;
  };
  switch (name) {
    case "whoami":
      return { server: "local-seo", mode: "local-sqlite", hosting: "local" };
    case "list_sites":
      return listSites();
    case "create_site":
      return createSite(args);
    case "get_site_summary":
      return siteSummary(args.siteId);
    case "research_keywords":
      return researchKeywords(args);
    case "analyze_serp":
      return getSerpAnalysis(withDomainInput(args));
    case "list_saved_keywords":
      return listSavedKeywords(args.siteId);
    case "query_saved_keywords":
      return querySavedKeywords(args);
    case "save_keywords":
      return saveKeywords(args);
    case "import_keyword_metrics":
      return importKeywordMetricsCsv(args);
    case "update_saved_keyword_tags":
      return updateSavedKeywordTags(args);
    case "get_domain_overview":
      return domainOverview(withDomainInput(args));
    case "get_domain_keyword_suggestions":
      return getDomainKeywordSuggestions(args);
    case "get_domain_keywords_page":
      return getDomainKeywordsPage(withDomainInput(args));
    case "get_domain_pages_page":
      return getDomainPagesPage(withDomainInput(args));
    case "import_organic_research":
      return importOrganicResearchCsv(withDomainInput(args));
    case "get_backlinks_overview":
      return backlinksOverview(withDomainInput(args));
    case "get_backlinks_profile":
      return getBacklinksProfile(withDomainInput(args));
    case "import_backlinks":
      return importBacklinksCsv(withDomainInput(args));
    case "get_rank_tracker": {
      const trackers = listRankTrackers(args.siteId);
      if (!args.trackerId) return trackers;
      const tracker = trackers.find((item) => item.id === args.trackerId);
      if (!tracker) throw notFound("Tracker not found.");
      return tracker;
    }
    case "start_scan":
      return startScan(args.siteId, args.url);
    case "scan_site": {
      const siteId = args.siteId;
      const site = getSite(siteId);
      if (!site) throw new Error("Site not found.");
      const candidateUrls = args.url ? [String(args.url)] : site.domain ? siteScanUrlCandidates(site) : [];
      const url = args.url || (site.domain ? await resolveSavedSiteScanUrl(site) : "");
      if (!url) throw site.domain ? unreachableScanUrlError(site.domain) : new Error("Set a site domain or pass a URL.");
      // A resolved saved-site URL was just probed; a caller-supplied URL still needs its probe.
      const scan = await startScan(site.id, url, { reachable: !args.url });
      return {
        site: site.domain,
        scan,
        scanUrl: url,
        candidateUrls,
        scanPreferences: {
          protocol: site.crawl_protocol || "auto",
          host: site.crawl_host || "auto",
        },
        message: `Started site scan for ${site.domain || url}.`,
      };
    }
    case "get_scan": {
      const scan = requireScan(args.scanId);
      if (args.full === true) return scan;
      return {
        ...scanOverview(scan),
        hint: "Summary only. Use get_scan_issues for issue rows, get_scan_page for one page's evidence, or get_scan with full: true for the complete saved result.",
      };
    }
    case "get_gsc_performance":
      return getGscPerformance(args);
    case "inspect_urls":
      return inspectGscUrls(args);
    case "brand_lookup":
      return brandLookup(args);
    case "prompt_explorer":
      return promptExplorer(args);
    case "start_ai_job":
      return createAiJob(args);
    case "get_ai_job": {
      const job = getAiJob(args.jobId);
      if (!job) throw notFound("AI job not found.");
      return job;
    }
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

export function mcpToolList() {
  return tools;
}
