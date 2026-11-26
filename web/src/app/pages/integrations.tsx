import { useEffect, useMemo, useRef, useState, type SyntheticEvent } from "react";
import { useSearchParams } from "react-router-dom";
import { Bot, RefreshCw, Settings } from "lucide-react";
import { api, isNotFoundError, type AiJob, type Site } from "../../api";
import { Badge, Button, Input, Select, SelectContent, SelectItem, SelectTrigger, SelectValue, Table, TableBody, TableCell, TableHead, TableHeader, TableRow, Textarea, toast } from "@/components/ui";
import { EmptyState, Field, InfoTip, JobTable, PageHeader, ReportSection, StatusEvidenceTable, cleanSiteDomain, crawlHostOptions, crawlProtocolOptions, crawlSpeedOptions, defaultCrawlHostFromConfig, defaultCrawlMaxPagesFromConfig, defaultCrawlProtocolFromConfig, defaultCrawlSpeedFromConfig, defaultKeywordLanguageCode, defaultKeywordLocationCode, defaultLanguageCodeFromConfig, defaultLocationCodeFromConfig, formatDate, formatNumber, languageOptions, marketOptions, preferredScanUrl, serpProviderStatus } from "../shared";
import { AI_JOB_POLL_MS, AiJobOutput, aiJobActive } from "../ai-job-output";

const workflowHelp: Record<string, string> = {
  "seo.coach": "Paste your goal and recent Search Console findings to get five SEO priorities.",
  "keywords.cluster": "Paste a keyword list to group phrases by intent and pick a target page for each group.",
  "scan.prioritize": "Rank technical fixes by impact and effort. Use Prioritise with Codex on a scan to include its findings automatically.",
  "competitor.gaps": "Paste what competing pages cover and what your page offers to find gaps worth addressing.",
  "ai.visibility": "Paste a question, a real AI answer, and relevant site evidence to see what would make your brand easier to cite.",
};

export function AiPage({ site }: { site: Site }) {
  const [searchParams, setSearchParams] = useSearchParams();
  const jobParam = searchParams.get("job") || "";
  const [prompts, setPrompts] = useState<{ key: string; label: string }[]>([]);
  const [jobs, setJobs] = useState<AiJob[]>([]);
  // A job named in ?job= that the site-filtered list does not include.
  const [linkedJob, setLinkedJob] = useState<{ id: string; job?: AiJob; error?: string } | null>(null);
  const [type, setType] = useState("seo.coach");
  const [context, setContext] = useState(`Site: ${site.name}\nDomain: ${site.domain}`);
  const [starting, setStarting] = useState(false);
  const jobParamRef = useRef(jobParam);
  jobParamRef.current = jobParam;
  const loadToken = useRef(0);
  const listedJob = jobParam ? jobs.find((job) => job.id === jobParam) : undefined;
  const linked = linkedJob?.id === jobParam ? linkedJob : null;
  const activeJob = jobParam ? listedJob || linked?.job || null : jobs[0] || null;
  const help = workflowHelp[type];

  function workflowLabel(key: string) {
    return prompts.find((prompt) => prompt.key === key)?.label ?? (key === "prompt.explorer" ? "Saved prompt analysis" : key);
  }

  // Jobs are refreshed on their own so polling never refetches the prompts.
  async function loadJobs() {
    const token = ++loadToken.current;
    const siteId = site.id;
    const rows = await api.aiJobs(siteId);
    if (token !== loadToken.current) return;
    setJobs(rows);
    const wanted = jobParamRef.current;
    if (!wanted || rows.some((job) => job.id === wanted)) return;
    try {
      const job = await api.aiJob(wanted);
      if (token === loadToken.current) setLinkedJob({ id: wanted, job });
    } catch (err) {
      if (token !== loadToken.current) return;
      setLinkedJob({
        id: wanted,
        error: isNotFoundError(err) ? "This job is no longer saved in local SQLite." : err instanceof Error ? err.message : "Could not load this job",
      });
    }
  }

  useEffect(() => {
    setContext(`Site: ${site.name}\nDomain: ${site.domain}`);
    api.aiPrompts().then(setPrompts).catch(console.error);
  }, [site.id, site.name, site.domain]);

  useEffect(() => {
    loadJobs().catch(console.error);
  }, [site.id, jobParam]);

  // One sequential poller while any shown job is queued or running.
  const polling = jobs.some(aiJobActive) || aiJobActive(linked?.job);
  useEffect(() => {
    if (!polling) return;
    let cancelled = false;
    let timer = 0;
    const poll = async () => {
      await loadJobs().catch(console.error);
      if (!cancelled) timer = window.setTimeout(poll, AI_JOB_POLL_MS);
    };
    timer = window.setTimeout(poll, AI_JOB_POLL_MS);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [polling, site.id]);

  function selectJob(id: string) {
    const next = new URLSearchParams(searchParams);
    if (id) next.set("job", id);
    else next.delete("job");
    setSearchParams(next, { replace: true });
  }

  async function submit(event: SyntheticEvent) {
    event.preventDefault();
    if (starting || !context.trim()) return;
    setStarting(true);
    try {
      // The backend fills the saved template for this workflow with the context.
      const job = await api.createAiJob({ type, context, siteId: site.id });
      if (job?.id) {
        setJobs((rows) => [job, ...rows.filter((row) => row.id !== job.id)]);
        selectJob(job.id);
      }
      await loadJobs();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not start the Codex job. Is the local Codex CLI available?");
    } finally {
      setStarting(false);
    }
  }

  return (
    <>
      <PageHeader
        title="AI lab"
        description="SEO coach, keyword clustering, scan prioritization, competitor gaps, and AI visibility through local Codex medium jobs."
        meta={`${formatNumber(jobs.length)} saved ${jobs.length === 1 ? "job" : "jobs"} for ${site.name} and jobs saved without a site`}
      />
      <div className="grid items-start gap-6 2xl:grid-cols-[460px_minmax(0,1fr)]">
        <ReportSection title="New job" description="Run a Codex workflow and save the result with this site.">
          <form className="space-y-4" onSubmit={submit}>
            <div className="space-y-2">
              <Field label="Workflow">
                <Select value={type} onValueChange={setType}>
                  <SelectTrigger aria-describedby={help ? "ai-workflow-help" : undefined}><SelectValue /></SelectTrigger>
                  <SelectContent>{prompts.map((prompt) => <SelectItem key={prompt.key} value={prompt.key}>{prompt.label}</SelectItem>)}</SelectContent>
                </Select>
              </Field>
              {help && <p id="ai-workflow-help" className="text-sm leading-5 text-muted-foreground">{help}</p>}
            </div>
            <Field label="Context"><Textarea className="min-h-48" value={context} onChange={(e) => setContext(e.target.value)} /></Field>
            <Button disabled={starting || !context.trim()}><Bot /> {starting ? "Starting job" : "Start job"}</Button>
          </form>
        </ReportSection>
        <div className="min-w-0 space-y-6">
          <ReportSection
            title="Jobs"
            meta="Saved local Codex runs from SQLite."
            action={
              <Button size="sm" variant="outline" type="button" onClick={() => loadJobs().catch(console.error)}>
                <RefreshCw /> Refresh
              </Button>
            }
          >
            {jobs.length ? <JobTable rows={jobs} selectedId={activeJob?.id || ""} onSelect={selectJob} workflowLabel={workflowLabel} /> : <EmptyState title="No jobs" text="Start a local Codex workflow." />}
          </ReportSection>
          {jobParam && !activeJob ? (
            <ReportSection title="Job output">
              {linked?.error ? (
                <EmptyState
                  title="Job not found"
                  text={linked.error}
                  action={<Button variant="secondary" onClick={() => selectJob("")}>Show the newest job</Button>}
                />
              ) : (
                <p className="text-sm text-muted-foreground" role="status">Loading the linked job…</p>
              )}
            </ReportSection>
          ) : (
            <ReportSection title="Job output" meta={activeJob ? `${workflowLabel(activeJob.type)} · ${formatDate(activeJob.created_at)}` : undefined}>
              {activeJob ? <AiJobOutput job={activeJob} /> : <EmptyState title="No job selected" text="Start or select a local Codex job to read the complete output here." />}
            </ReportSection>
          )}
        </div>
      </div>
    </>
  );
}

export function McpPage({ site }: { site: Site }) {
  const [tools, setTools] = useState<any[]>([]);
  useEffect(() => {
    api.mcpTools().then((data) => setTools(data.tools || [])).catch(console.error);
  }, []);
  const endpoint = `${window.location.origin}/mcp`;
  const exampleDomain = cleanSiteDomain(site.domain);
  const exampleSiteId = site.id;
  const exampleScanUrl = site.domain ? preferredScanUrl(site) : "https://example.com";
  const exampleKeyword = exampleDomain ? `${exampleDomain} seo scan` : `${site.name || "site"} seo scan`;
  const groupedTools = useMemo(() => {
    return tools.reduce<Record<string, any[]>>((acc, tool) => {
      const group = mcpToolGroup(tool.name);
      acc[group] = acc[group] || [];
      acc[group].push(tool);
      return acc;
    }, {});
  }, [tools]);
  const examples = [
    {
      title: "List tools",
      body: { jsonrpc: "2.0", id: 1, method: "tools/list", params: {} },
    },
    {
      title: "Scan a site",
      body: { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "scan_site", arguments: { siteId: exampleSiteId } } },
    },
    {
      title: "Scan a URL",
      body: { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "start_scan", arguments: { siteId: exampleSiteId, url: exampleScanUrl } } },
    },
    {
      title: "Read Search Console",
      body: { jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "get_gsc_performance", arguments: { siteId: exampleSiteId, startDate: "2026-06-01", endDate: "2026-06-30", dimensions: ["query"] } } },
    },
    ...(exampleDomain
      ? [
          {
            title: "Read organic domain",
            body: { jsonrpc: "2.0", id: 5, method: "tools/call", params: { name: "get_domain_overview", arguments: { siteId: exampleSiteId, domain: exampleDomain } } },
          },
          {
            title: "Read link index",
            body: { jsonrpc: "2.0", id: 6, method: "tools/call", params: { name: "get_backlinks_profile", arguments: { siteId: exampleSiteId, domain: exampleDomain, tab: "domains" } } },
          },
          {
            title: "Analyze SERP",
            body: { jsonrpc: "2.0", id: 7, method: "tools/call", params: { name: "analyze_serp", arguments: { siteId: exampleSiteId, keyword: exampleKeyword, domain: exampleDomain } } },
          },
        ]
      : []),
  ];
  return (
    <>
      <PageHeader
        title="MCP"
        description="Local JSON-RPC tools for sites, scans, keywords, rank tracking, Search Console, AI jobs, and reports."
        meta={`${formatNumber(tools.length)} local tools · calls prefilled for ${site.name || exampleDomain || "the active site"}`}
      />
      <div className="grid gap-6 2xl:grid-cols-[460px_minmax(0,1fr)]">
        <div className="space-y-6">
          <ReportSection title="Endpoint" description="Use this from local agents and scripts. If a local token is configured, include an Authorization: Bearer header with the request.">
            <code className="block break-all rounded-md bg-secondary px-3 py-2 text-sm">{`POST ${endpoint}`}</code>
          </ReportSection>
          <ReportSection title="Common calls" description="Known-good JSON-RPC request shapes, prefilled with this site's siteId and domain.">
            <div className="space-y-4">
              {examples.map((example) => <McpExample key={example.title} title={example.title} value={example.body} />)}
            </div>
          </ReportSection>
        </div>
        <div className="space-y-6">
          {Object.entries(groupedTools).map(([group, rows]) => (
            <ReportSection key={group} title={group} meta={`${formatNumber(rows.length)} tools`}>
              <McpToolTable rows={rows} />
            </ReportSection>
          ))}
        </div>
      </div>
    </>
  );
}

function McpToolTable({ rows }: { rows: any[] }) {
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>Tool</TableHead>
          <TableHead>Inputs</TableHead>
          <TableHead>Description</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {rows.map((tool) => {
          const required = new Set(Array.isArray(tool.inputSchema?.required) ? tool.inputSchema.required : []);
          const properties = Object.keys(tool.inputSchema?.properties || {});
          return (
            <TableRow key={tool.name}>
              <TableCell className="min-w-52 font-medium">{tool.name}</TableCell>
              <TableCell className="min-w-64">
                <div className="flex flex-wrap gap-1">
                  {properties.length ? properties.map((name: string) => (
                    <Badge key={name} variant={required.has(name) ? "good" : "outline"}>
                      {name}{required.has(name) ? " required" : ""}
                    </Badge>
                  )) : <Badge variant="outline">none</Badge>}
                </div>
              </TableCell>
              <TableCell className="min-w-96 text-sm leading-6 text-muted-foreground">{tool.description}</TableCell>
            </TableRow>
          );
        })}
      </TableBody>
    </Table>
  );
}

function mcpToolGroup(name: string) {
  if (/scan/.test(name)) return "Site scans";
  if (/site|whoami/.test(name)) return "Sites";
  if (/keyword|serp|rank/.test(name)) return "Keywords and ranks";
  if (/domain|backlink/.test(name)) return "Competitive data";
  if (/gsc|inspect/.test(name)) return "Search Console";
  if (/brand|prompt|ai/.test(name)) return "AI visibility";
  return "Other";
}

function McpExample({ title, value }: { title: string; value: unknown }) {
  return (
    <div>
      <div className="text-sm font-medium">{title}</div>
      <pre className="mt-1.5 overflow-auto rounded-md bg-secondary p-3 text-xs leading-relaxed text-secondary-foreground">
        {JSON.stringify(value, null, 2)}
      </pre>
    </div>
  );
}

function appPreferences(data: Record<string, unknown> | null): Record<string, string> {
  return {
    codex_model: String(data?.codex_model || "").trim(),
    codex_reasoning_effort: String(data?.codex_reasoning_effort || "medium").trim(),
    default_location_code: String(defaultLocationCodeFromConfig(data)),
    default_language_code: defaultLanguageCodeFromConfig(data),
    default_crawl_protocol: defaultCrawlProtocolFromConfig(data) || "auto",
    default_crawl_host: defaultCrawlHostFromConfig(data) || "auto",
    default_crawl_speed: defaultCrawlSpeedFromConfig(data),
    default_crawl_max_pages: String(defaultCrawlMaxPagesFromConfig(data)),
  };
}

export function SettingsPage() {
  const [config, setConfig] = useState<any>(null);
  const [form, setForm] = useState<Record<string, string>>({});
  const [loadError, setLoadError] = useState("");
  const [saving, setSaving] = useState(false);

  function receiveConfig(data: any) {
    setConfig(data);
    setForm(appPreferences(data));
  }
  async function load() {
    setLoadError("");
    try {
      receiveConfig(await api.config());
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : "Could not load app settings.");
    }
  }
  useEffect(() => {
    void load();
  }, []);

  const baseline = appPreferences(config);
  const changes = Object.fromEntries(
    Object.entries(appPreferences(form)).filter(([key, value]) => value !== baseline[key]),
  );
  const hasChanges = Object.keys(changes).length > 0;

  async function save(event: SyntheticEvent) {
    event.preventDefault();
    if (!config || saving || !hasChanges) return;
    setSaving(true);
    try {
      const saved = await api.saveConfig(changes);
      receiveConfig(saved);
      toast.success("App settings saved locally.");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not save app settings");
    } finally {
      setSaving(false);
    }
  }

  if (!config) {
    return loadError ? (
      <EmptyState title="Could not load app settings" text={loadError} action={<Button onClick={load}><RefreshCw /> Retry</Button>} />
    ) : (
      <p role="status" className="text-sm text-muted-foreground">Loading app settings…</p>
    );
  }

  return (
    <>
      <PageHeader title="Settings" description="Local app preferences. Data sources are shown as status, not secret fields." />
      <div className="grid gap-6 2xl:grid-cols-[460px_minmax(0,1fr)]">
        <ReportSection title="App preferences" description="Defaults used when a new site is added. Existing sites keep their own saved settings.">
          <form className="space-y-5" onSubmit={save}>
            <div className="flex items-center gap-2">
              <h3 className="text-sm font-semibold">Keyword tool defaults</h3>
              <InfoTip>Used for keyword research, SERP checks, and rank tracking. They do not restrict multilingual site scans.</InfoTip>
            </div>
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="Default keyword market">
                <Select value={String(form.default_location_code || defaultKeywordLocationCode)} onValueChange={(value) => setForm({ ...form, default_location_code: value })}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    {marketOptions.map((market) => <SelectItem key={market.code} value={String(market.code)}>{market.label}</SelectItem>)}
                  </SelectContent>
                </Select>
              </Field>
              <Field label="Default keyword result language">
                <Select value={form.default_language_code || defaultKeywordLanguageCode} onValueChange={(value) => setForm({ ...form, default_language_code: value })}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    {languageOptions.map((language) => <SelectItem key={language.code} value={language.code}>{language.label}</SelectItem>)}
                  </SelectContent>
                </Select>
              </Field>
            </div>
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="Default scan protocol">
                <Select value={form.default_crawl_protocol || "auto"} onValueChange={(value) => setForm({ ...form, default_crawl_protocol: value })}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    {crawlProtocolOptions.map((option) => <SelectItem key={option.value} value={option.value}>{option.label}</SelectItem>)}
                  </SelectContent>
                </Select>
              </Field>
              <Field label="Default host variant">
                <Select value={form.default_crawl_host || "auto"} onValueChange={(value) => setForm({ ...form, default_crawl_host: value })}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    {crawlHostOptions.map((option) => <SelectItem key={option.value} value={option.value}>{option.label}</SelectItem>)}
                  </SelectContent>
                </Select>
              </Field>
              <Field label="Default crawl speed">
                <Select value={form.default_crawl_speed || "polite"} onValueChange={(value) => setForm({ ...form, default_crawl_speed: value })}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    {crawlSpeedOptions.filter((option) => option.value !== "auto").map((option) => <SelectItem key={option.value} value={option.value}>{option.label}</SelectItem>)}
                  </SelectContent>
                </Select>
              </Field>
              <Field label="Default max pages per scan">
                <Input
                  type="number"
                  min={10}
                  max={1000}
                  value={form.default_crawl_max_pages ?? 100}
                  onChange={(event) => setForm({ ...form, default_crawl_max_pages: event.target.value })}
                />
              </Field>
            </div>
            <div className="border-t pt-5">
              <div className="mb-3 flex items-center gap-2">
                <h3 className="text-sm font-semibold">Codex defaults</h3>
                <InfoTip>Local AI jobs run through the Codex CLI with medium reasoning. Leave the model empty to use your Codex CLI default.</InfoTip>
              </div>
              <div className="space-y-4">
                <Field label="Model override"><Input value={form.codex_model || ""} onChange={(e) => setForm({ ...form, codex_model: e.target.value })} placeholder="Codex CLI default" /></Field>
                <Field label="Reasoning">
                  <Select value={form.codex_reasoning_effort || "medium"} onValueChange={(value) => setForm({ ...form, codex_reasoning_effort: value })}>
                    <SelectTrigger><SelectValue /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="low">Low</SelectItem>
                      <SelectItem value="medium">Medium</SelectItem>
                      <SelectItem value="high">High</SelectItem>
                    </SelectContent>
                  </Select>
                </Field>
              </div>
            </div>
            <Button disabled={saving || !hasChanges}><Settings /> {saving ? "Saving settings" : "Save app settings"}</Button>
          </form>
        </ReportSection>
        <ReportSection title="Data sources" description="What the app can run locally now and what needs real imported data or a local provider.">
          <StatusEvidenceTable
            rows={[
              {
                title: "Local SQLite database",
                status: "Source of truth",
                tone: "good",
                text: (
                  <span className="break-all">
                    {config.local_db_path || "Database path unavailable"} · {formatNumber(config.local_site_count || 0)} sites · {formatNumber(config.local_scan_count || 0)} scans · {formatNumber(config.local_gsc_import_count || 0)} Search Console imports
                  </span>
                ),
              },
              { title: "Technical scans", status: "Active", tone: "good", text: "Local crawler checks metadata, images, links, robots, sitemap, indexability, headings, content, schema, and social tags." },
              { title: "Keyword ideas", status: "CSV import ready", tone: "good", text: "DuckDuckGo suggestions provide real query ideas; import keyword metrics CSVs on the Saved keywords page for volume, CPC, and difficulty." },
              { title: "SERP and rank checks", status: serpProviderStatus(config), tone: "good", text: "Uses local/self-hosted OpenSERP or SearXNG when configured, otherwise live DuckDuckGo results." },
              { title: "Search Console", status: "Local import ready", tone: "good", text: "Import Search Console CSVs locally; the Google connection is optional for live performance and URL inspection." },
              { title: "Backlink index", status: "CSV import ready", tone: "good", text: "Import backlink CSVs on the Links page; no backlink rows are ever generated." },
              { title: "MCP endpoint", status: "Local", tone: "good", text: "Local JSON-RPC endpoint, documented on the MCP screen." },
            ]}
          />
        </ReportSection>
      </div>
    </>
  );
}
