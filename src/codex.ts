import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { codexModel, codexReasoningEffort } from "./config";
import { all, get, run } from "./db";
import { badRequest, notFound } from "./errors";

// Local Codex CLI jobs, saved in ai_jobs. Each job runs `codex exec` in an
// empty temp directory with the read-only sandbox, which can still read the
// whole disk (database/ holds Google refresh tokens). Web search is the job's
// only way to send data out, so it is turned off for jobs whose prompt embeds
// crawled page content (scan.prioritize, jobs with `context` or a `scanId`);
// ai_jobs.web_search records which mode a job ran in.

const codexTimeoutMs = Number(process.env.CODEX_TIMEOUT_MS || 600000);
// Each job is a full Codex CLI process; run at most this many at once and keep
// the rest queued in order.
const maxConcurrentJobs = Math.max(1, Number(process.env.CODEX_MAX_CONCURRENT || 2) || 2);
const pendingJobs: string[] = [];
let runningJobCount = 0;
// App credentials Codex never needs; keep them out of the spawned environment.
const hiddenEnvKeys = ["GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET", "MCP_TOKEN", "PAGESPEED_API_KEY"];

export type AiJob = {
  id: string;
  type: string;
  prompt: string;
  status: string;
  message: string;
  result_text: string;
  result_json: string | null;
  error: string;
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
  site_id: string | null;
  scan_id: string | null;
  web_search: number;
};

// Scan prioritisation and any job built from `context` or linked to a scan
// embed text from crawled pages (titles, headings, URLs), which a hostile page
// can word as instructions. Those jobs run without Codex web search, so an
// injected instruction cannot send what Codex reads out through search queries.
function jobUsesCrawledContent(type: string, context: string, scanId: string | null) {
  return type === "scan.prioritize" || Boolean(context) || Boolean(scanId);
}

export const promptTemplates = [
  {
    key: "seo.coach",
    label: "SEO coach",
    template:
      "You are a local SEO coach. Given this site context, recommend the next 5 SEO moves with evidence and priority. Return concise markdown.\n\n{{context}}",
  },
  {
    key: "keywords.cluster",
    label: "Keyword clustering",
    template:
      "Cluster these keywords by search intent and suggest one target page for each cluster. Return JSON with clusters.\n\n{{context}}",
  },
  {
    key: "scan.prioritize",
    label: "Scan prioritization",
    template:
      "Prioritize these technical SEO scan issues by likely impact, effort, and dependency order. Return concise markdown.\n\n{{context}}",
  },
  {
    key: "competitor.gaps",
    label: "Competitor gaps",
    template:
      "Analyze this domain and competitor context. Identify keyword, content, backlink, and technical gaps. Return a prioritized plan.\n\n{{context}}",
  },
  {
    key: "ai.visibility",
    label: "AI visibility",
    template:
      "Evaluate how this brand should appear in AI answers for the supplied prompts. Identify citations, positioning, and content needed to improve visibility.\n\n{{context}}",
  },
];

export function seedAiPrompts() {
  for (const prompt of promptTemplates) {
    run(
      `
      INSERT INTO ai_prompts (key, label, template)
      VALUES (?, ?, ?)
      ON CONFLICT(key) DO NOTHING
      `,
      [prompt.key, prompt.label, prompt.template],
    );
  }
}

export function listAiPrompts() {
  seedAiPrompts();
  return all("SELECT * FROM ai_prompts ORDER BY key");
}

export function saveAiPrompt(key: string, template: string) {
  const existing = promptTemplates.find((prompt) => prompt.key === key);
  run(
    `
    INSERT INTO ai_prompts (key, label, template, updated_at)
    VALUES (?, ?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(key) DO UPDATE SET template = excluded.template, updated_at = CURRENT_TIMESTAMP
    `,
    [key, existing?.label || key, template],
  );
}

// `context` (for example GET /api/scans/:id/ai-context) fills the saved
// prompt template for `type` ({{context}}) when no prompt is given, or is
// added to the prompt. `scanId` links the job to a scan and its site.
export function createAiJob(input: { type?: unknown; prompt?: unknown; siteId?: unknown; scanId?: unknown; context?: unknown }) {
  const type = typeof input?.type === "string" ? input.type.trim() : "";
  const context = typeof input?.context === "string" ? input.context.trim() : "";
  let prompt = typeof input?.prompt === "string" ? input.prompt.trim() : "";
  if (!type) throw badRequest("AI job type is required.");
  if (!prompt && context) {
    seedAiPrompts();
    prompt = get<{ template: string }>("SELECT template FROM ai_prompts WHERE key = ?", [type])?.template || "{{context}}";
  }
  if (context) prompt = prompt.includes("{{context}}") ? prompt.replaceAll("{{context}}", () => context) : `${prompt}\n\n${context}`;
  if (!prompt) throw badRequest("AI job prompt is required.");
  let siteId = typeof input?.siteId === "string" && input.siteId ? input.siteId : null;
  if (siteId && !get("SELECT id FROM sites WHERE id = ?", [siteId])) throw notFound("Site not found.");
  const scanId = typeof input?.scanId === "string" && input.scanId ? input.scanId : null;
  if (scanId) {
    const scan = get<{ site_id: string }>("SELECT site_id FROM scans WHERE id = ?", [scanId]);
    if (!scan) throw notFound("Scan not found.");
    if (siteId && scan.site_id !== siteId) throw badRequest("That scan belongs to another site.");
    siteId = scan.site_id;
  }
  const id = randomUUID();
  const webSearch = jobUsesCrawledContent(type, context, scanId) ? 0 : 1;
  run(
    "INSERT INTO ai_jobs (id, type, prompt, status, message, site_id, scan_id, web_search) VALUES (?, ?, ?, 'queued', 'Queued', ?, ?, ?)",
    [id, type, prompt, siteId, scanId, webSearch],
  );
  pendingJobs.push(id);
  queueMicrotask(startQueuedJobs);
  return getAiJob(id)!;
}

// Without a site, every job is listed. With a site, the list keeps that site's
// jobs plus jobs saved without a site (older jobs, MCP jobs with no siteId).
export function listAiJobs(siteId?: string) {
  if (siteId) {
    return all<AiJob>(
      "SELECT * FROM ai_jobs WHERE site_id = ? OR site_id IS NULL ORDER BY created_at DESC, rowid DESC",
      [siteId],
    );
  }
  return all<AiJob>("SELECT * FROM ai_jobs ORDER BY created_at DESC, rowid DESC");
}

// Dashboard rows: the latest jobs in listAiJobs' scope as small rows (no
// prompt or result), plus how many jobs that scope holds.
export function recentAiJobs(siteId?: string, limit = 10) {
  const where = siteId ? "WHERE site_id = ? OR site_id IS NULL" : "";
  const params = siteId ? [siteId] : [];
  return {
    rows: all<Pick<AiJob, "id" | "type" | "status" | "message" | "created_at" | "finished_at" | "scan_id">>(
      `SELECT id, type, status, message, created_at, finished_at, scan_id FROM ai_jobs ${where} ORDER BY created_at DESC, rowid DESC LIMIT ?`,
      [...params, limit],
    ),
    total: get<{ count: number }>(`SELECT count(*) AS count FROM ai_jobs ${where}`, params)?.count || 0,
  };
}

export function getAiJob(id: string) {
  return get<AiJob>("SELECT * FROM ai_jobs WHERE id = ?", [id]);
}

function startQueuedJobs() {
  while (runningJobCount < maxConcurrentJobs && pendingJobs.length) {
    const id = pendingJobs.shift()!;
    runningJobCount += 1;
    runAiJob(id)
      .catch((error) => failJob(id, error instanceof Error ? error.message : "Codex job failed"))
      .finally(() => {
        runningJobCount -= 1;
        startQueuedJobs();
      });
  }
}

function failJob(id: string, message: string) {
  run(
    "UPDATE ai_jobs SET status = 'failed', message = 'Failed', error = ?, finished_at = CURRENT_TIMESTAMP WHERE id = ?",
    [message.slice(0, 2000), id],
  );
}

async function runAiJob(id: string) {
  const job = getAiJob(id);
  if (job?.status !== "queued") return;
  run(
    "UPDATE ai_jobs SET status = 'running', message = 'Codex is working', started_at = CURRENT_TIMESTAMP WHERE id = ?",
    [id],
  );
  const result = await runCodex(job.prompt, Boolean(job.web_search));
  run(
    "UPDATE ai_jobs SET status = 'completed', message = 'Completed', result_text = ?, result_json = ?, finished_at = CURRENT_TIMESTAMP WHERE id = ?",
    [result.text, result.json ? JSON.stringify(result.json) : null, id],
  );
}

// Codex runs in an empty per-job directory, never in the app checkout, with
// the read-only sandbox. Read-only still lets Codex read any file the user can
// (including database/ with Google refresh tokens and .env); it only blocks
// writes and network access from commands. The one outbound channel left is
// web search (--search), which is off for jobs that embed crawled content
// (see jobUsesCrawledContent). The prompt goes after "--" so text starting
// with "-" can never be parsed as a CLI option.
export function codexArgs(prompt: string, workDir: string, outputPath: string, webSearch = false) {
  const args = [
    "codex",
    ...(webSearch ? ["--search"] : []),
    "--ask-for-approval",
    "never",
    "exec",
    "--ephemeral",
    "--skip-git-repo-check",
    "--color",
    "never",
    "-C",
    workDir,
    "-s",
    "read-only",
  ];
  const model = codexModel();
  const effort = codexReasoningEffort();
  if (model) args.push("--model", model);
  if (effort) args.push("--config", `model_reasoning_effort="${effort}"`);
  args.push("-o", outputPath, "--", prompt);
  return args;
}

async function runCodex(prompt: string, webSearch: boolean): Promise<{ text: string; json: unknown | null }> {
  const workDir = await mkdtemp(path.join(os.tmpdir(), "local-seo-codex-"));
  const outputPath = path.join(workDir, "last-message.txt");
  try {
    const env = { ...process.env };
    for (const key of hiddenEnvKeys) delete env[key];
    const proc = Bun.spawn(codexArgs(prompt, workDir, outputPath, webSearch), {
      cwd: workDir,
      stdout: "pipe",
      stderr: "pipe",
      env,
    });
    const stdoutPromise = new Response(proc.stdout).text();
    const stderrPromise = new Response(proc.stderr).text();
    let timeoutId: Timer | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timeoutId = setTimeout(() => {
        proc.kill();
        reject(new Error("Codex job timed out."));
      }, codexTimeoutMs);
    });
    const exitCode = await Promise.race([proc.exited, timeout]);
    if (timeoutId) clearTimeout(timeoutId);
    const [stdout, stderr] = await Promise.all([stdoutPromise, stderrPromise]);
    if (exitCode !== 0) {
      throw new Error((stderr || stdout || `Codex exited with ${exitCode}`).slice(0, 2000));
    }
    const text = (await readFile(outputPath, "utf8").catch(() => stdout)).trim();
    return { text, json: parseMaybeJson(text) };
  } finally {
    await rm(workDir, { recursive: true, force: true });
  }
}

function parseMaybeJson(text: string) {
  const cleaned = text.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "").trim();
  try {
    return JSON.parse(cleaned);
  } catch {
    const objectMatch = cleaned.match(/\{[\s\S]*\}/);
    if (objectMatch) {
      try {
        return JSON.parse(objectMatch[0]);
      } catch {
        return null;
      }
    }
    return null;
  }
}
