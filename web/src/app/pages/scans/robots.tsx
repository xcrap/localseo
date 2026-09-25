import { useEffect, useMemo, useState, type SyntheticEvent } from "react";
import { FlaskConical } from "lucide-react";
import { api, type RobotsTestResult, type RobotsTestStatus } from "../../../api";
import { Badge, Button, Input, Select, SelectContent, SelectItem, SelectTrigger, SelectValue, SortableTableHead, Table, TableBody, TableCell, TableHeader, TableRow, Textarea } from "@/components/ui";
import { FilteredRows } from "../../data-table";
import { EmptyState, Field, ReportSection, StatusEvidenceTable, formatNumber, knownNumber, type StatusEvidenceRow } from "../../shared";

/** The robots.txt product token the crawler follows (its own group, else `*`). */
export const robotsAgent = "LocalSEO";

type RobotsRule = { type?: string; path?: string };
type RobotsGroup = { userAgents?: string[]; rules?: RobotsRule[] };

function ruleVariant(type?: string) {
  const value = String(type || "").toLowerCase();
  if (value === "allow") return "good";
  if (value === "disallow") return "warn";
  return "outline";
}

function ruleLabel(type?: string) {
  const value = String(type || "").toLowerCase();
  if (value === "allow") return "Allow";
  if (value === "disallow") return "Disallow";
  return type || "Rule";
}

// How Google handles a robots.txt it could not read: a 4xx answer (except 429)
// means there is no file, so every URL is allowed; a 5xx, a 429, or no answer
// means robots.txt is unavailable, so the whole site is treated as disallowed.
// Same split as the crawler's own robots handling.
function robotsFetchState(status: unknown): "missing" | "unavailable" {
  const code = knownNumber(status);
  return code !== null && code >= 300 && code < 500 && code !== 429 ? "missing" : "unavailable";
}

function httpAnswer(status: unknown) {
  const code = knownNumber(status);
  return code !== null ? `HTTP ${code}` : "no answer";
}

function withError(text: string, error: unknown) {
  return error ? `${text} (${String(error)})` : text;
}

const unavailableRule = "Google treats a server error, a 429, or an unreachable robots.txt as disallowing the whole site until it answers again.";
const missingRule = "Google treats a missing robots.txt as allowing every URL.";

/** Plain-language outcome of fetching robots.txt, from a scan's saved robots evidence. */
export function robotsFileSummary(robots: any) {
  if (robots?.exists) return { state: "found" as const, label: "Found", tone: "good" as const, text: "" };
  const answer = httpAnswer(robots?.status);
  if (robotsFetchState(robots?.status) === "missing") {
    return { state: "missing" as const, label: `Missing (${answer})`, tone: "warn" as const, text: `robots.txt answered ${answer}. ${missingRule}` };
  }
  return {
    state: "unavailable" as const,
    label: `Unavailable (${answer})`,
    tone: "bad" as const,
    text: `${withError(`robots.txt could not be read: ${answer}`, robots?.error)}. ${unavailableRule}`,
  };
}

// Parsed robots.txt groups saved with the scan: which user agents each group
// addresses and the Allow/Disallow rules it carries, in file order.
export function RobotsGroups({ robots }: { robots: any }) {
  const groups: RobotsGroup[] | null = Array.isArray(robots?.groups) ? robots.groups : null;
  // A missing or unreachable file is checked first: its empty group list was never read from a file.
  const file = robots?.exists === false ? robotsFileSummary(robots) : null;
  return (
    <ReportSection
      title="Robots.txt groups"
      description="Each user-agent group parsed from robots.txt during the scan, with its Allow and Disallow rules in file order."
      meta={groups && !file ? `${formatNumber(groups.length)} ${groups.length === 1 ? "group" : "groups"}` : undefined}
    >
      {file ? (
        <EmptyState title={file.state === "missing" ? "No robots.txt found" : "robots.txt was unavailable"} text={file.text} />
      ) : !groups ? (
        <EmptyState title="Groups not saved for this scan" text="Rescan to see parsed robots.txt groups." />
      ) : !groups.length ? (
        <EmptyState title="No user-agent groups" text="The robots.txt file was read but contains no user-agent groups, so nothing is blocked." />
      ) : (
        <div className="grid gap-3 lg:grid-cols-2">
          {groups.map((group, index) => {
            const agents = (group.userAgents || []).filter(Boolean);
            const rules = group.rules || [];
            return (
              <div key={index} className="min-w-0 rounded-xl border border-border/60 px-3.5 py-3">
                <div className="flex flex-wrap items-center gap-1.5">
                  <span className="eyebrow-muted mr-1">User-agent</span>
                  {agents.length ? agents.map((agent) => <Badge key={agent} variant="secondary" className="font-mono">{agent}</Badge>) : <Badge variant="outline">none listed</Badge>}
                </div>
                {rules.length ? (
                  <ul className="mt-2.5 space-y-1.5">
                    {rules.map((rule, ruleIndex) => (
                      <li key={ruleIndex} className="flex min-w-0 items-baseline gap-2 text-sm">
                        <Badge variant={ruleVariant(rule.type) as any} className="shrink-0">{ruleLabel(rule.type)}</Badge>
                        <code className="min-w-0 break-all font-mono text-[12.5px] text-foreground/85">{rule.path || "(empty)"}</code>
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p className="mt-2.5 text-sm text-muted-foreground">No rules (everything allowed)</p>
                )}
              </div>
            );
          })}
        </div>
      )}
    </ReportSection>
  );
}

type RobotsSkippedEntry = {
  url: string;
  rule?: RobotsRule | null;
  userAgentGroup?: string;
  source?: string;
  from?: string;
  robotsUrl?: string;
  robotsStatus?: number | null;
  robotsError?: string;
};

const skipSourceLabels: Record<string, string> = {
  "start-url": "Start URL",
  link: "Link",
  sitemap: "Sitemap",
  canonical: "Canonical",
  hreflang: "Hreflang",
  resource: "Image, CSS or JS",
  redirect: "Redirect target",
  "soft-404": "Soft 404 probe",
};

// Flat rows, so the table filter and the CSV export see every column.
function robotsSkippedRows(entries: RobotsSkippedEntry[]) {
  return entries.map((entry) => ({
    url: entry.url,
    ruleType: entry.rule?.type || "",
    rulePath: entry.rule?.path || "",
    // No rule: that host's robots.txt could not be read, which counts as disallowing everything.
    rule: entry.rule
      ? `${ruleLabel(entry.rule.type)}: ${entry.rule.path || "(empty)"}`
      : withError(`robots.txt unavailable (${httpAnswer(entry.robotsStatus)})`, entry.robotsError),
    group: entry.userAgentGroup || "",
    source: skipSourceLabels[entry.source || ""] || entry.source || "-",
    from: entry.from || "",
    robotsUrl: entry.robotsUrl || "",
  }));
}

type RobotsSkippedRow = ReturnType<typeof robotsSkippedRows>[number];

function RobotsSkippedTable({ rows }: { rows: RobotsSkippedRow[] }) {
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <SortableTableHead sortKey="url">URL</SortableTableHead>
          <SortableTableHead sortKey="rule">Rule</SortableTableHead>
          <SortableTableHead sortKey="source">Source</SortableTableHead>
          <SortableTableHead sortKey="from">Found on</SortableTableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {rows.map((row) => (
          <TableRow key={row.url}>
            <TableCell className="min-w-64 break-all font-medium">{row.url}</TableCell>
            <TableCell className="min-w-48">
              {row.ruleType ? (
                <div className="flex min-w-0 items-baseline gap-2">
                  <Badge variant={ruleVariant(row.ruleType) as any} className="shrink-0">{ruleLabel(row.ruleType)}</Badge>
                  <code className="min-w-0 break-all font-mono text-[12.5px] text-foreground/85">{row.rulePath || "(empty)"}</code>
                </div>
              ) : (
                <div className="space-y-1">
                  <Badge variant="bad">Unavailable</Badge>
                  <p className="break-all text-xs text-muted-foreground">{row.rule} · {row.robotsUrl}</p>
                </div>
              )}
              {row.group ? <p className="mt-1 text-xs text-muted-foreground">User-agent: {row.group}</p> : null}
            </TableCell>
            <TableCell><Badge variant="outline">{row.source}</Badge></TableCell>
            <TableCell className="min-w-48 break-all text-muted-foreground">{row.from || "-"}</TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}

// URLs the crawler never requested because robots.txt disallows them for
// LocalSEO, with the rule and where each was found. Scans from before the
// crawler respected robots.txt have no such list.
export function RobotsSkippedUrls({ result }: { result: any }) {
  const skipped = result?.robotsSkipped;
  const rows = useMemo(() => robotsSkippedRows(Array.isArray(skipped?.urls) ? skipped.urls : []), [skipped]);
  const count = knownNumber(skipped?.count) ?? rows.length;
  return (
    <ReportSection
      title="URLs not crawled"
      description={`URLs robots.txt disallows for ${robotsAgent} (its own user-agent group, or * when there is none) are never requested. The robots issues still report what Googlebot may not crawl.`}
      meta={skipped ? `${formatNumber(count)} ${count === 1 ? "URL" : "URLs"}` : undefined}
    >
      {result?.limits?.robots === "ignore" ? (
        <EmptyState
          title="robots.txt ignored for this site"
          text="This scan requested URLs robots.txt disallows, because the site's robots.txt setting is Ignore. The robots issues still flag what Google may not crawl."
        />
      ) : !skipped ? (
        <EmptyState title="Not recorded for this scan" text="Scans from before the crawler respected robots.txt requested every URL. Rescan to see which URLs robots.txt keeps it from crawling." />
      ) : !count ? (
        <EmptyState title="Nothing skipped" text={`robots.txt allowed every URL the crawler found for ${robotsAgent}.`} />
      ) : (
        <div className="space-y-3">
          <p className="text-sm">
            <span className="font-medium">
              {formatNumber(count)} {count === 1 ? "URL" : "URLs"}
            </span>{" "}
            not crawled because robots.txt disallows {robotsAgent}.
            {rows.length < count ? ` The first ${formatNumber(rows.length)} are listed.` : ""}
          </p>
          <FilteredRows rows={rows} placeholder="Filter URLs not crawled…" csvName="robots-skipped-urls">
            {(visible) => <RobotsSkippedTable rows={visible} />}
          </FilteredRows>
        </div>
      )}
    </ReportSection>
  );
}

/** The robots.txt mode a scan crawled with, for the evidence table. */
export function robotsModeEvidenceRow(result: any): StatusEvidenceRow {
  const title = "Crawler and robots.txt";
  const mode = result?.limits?.robots;
  if (mode === "respect") {
    return { title, status: "Respected", tone: "good", text: `URLs robots.txt disallows for ${robotsAgent} were not requested (site setting: Respect).` };
  }
  if (mode === "ignore") {
    return { title, status: "Ignored", tone: "warn", text: "Disallowed URLs were crawled anyway (site setting: Ignore)." };
  }
  return { title, status: "Not recorded", tone: "outline", text: "Scans from before this setting requested every URL, whatever robots.txt said." };
}

// Soft 404 probe: the crawler requests a URL that cannot exist and records how
// the server answers. Only a 404 or 410 passes; a 2xx is a soft 404; any other
// status (403, 500, an unresolved redirect) is shown as it is. It is not sent
// when robots.txt disallows the probe path, or followed into a disallowed URL.
export function softNotFoundEvidenceRow(result: any): StatusEvidenceRow {
  const title = "Soft 404 check";
  const probe = result?.softNotFound;
  if (!probe || typeof probe !== "object") {
    return { title, status: "Not checked", tone: "outline", text: "Not checked in this scan." };
  }
  if (probe.robotsSkipped) {
    return {
      title,
      status: "Skipped",
      tone: "outline",
      text: (
        <span className="break-all">
          robots.txt disallows the probe URL {probe.probeUrl || "-"} for {robotsAgent}
          {probe.rule?.path ? ` (${ruleLabel(probe.rule.type)}: ${probe.rule.path})` : ""}, so it was not requested.
        </span>
      ),
    };
  }
  const status = knownNumber(probe.status);
  const probeText = (outcome: string) => (
    <span className="break-all">
      Probe {probe.probeUrl || "-"} {outcome}
      {probe.finalUrl && probe.finalUrl !== probe.probeUrl ? ` after redirecting to ${probe.finalUrl}` : ""}.
    </span>
  );
  if (probe.skippedRedirect) {
    return {
      title,
      status: "Inconclusive",
      tone: "outline",
      text: (
        <span className="break-all">
          Probe {probe.probeUrl || "-"} redirects{status !== null ? ` (HTTP ${status})` : ""} to {probe.skippedRedirect}, which robots.txt disallows for {robotsAgent}, so the final answer is unknown.
        </span>
      ),
    };
  }
  if (probe.error || status === null) {
    return { title, status: "Inconclusive", tone: "outline", text: probeText(probe.error ? `failed: ${probe.error}` : "returned no HTTP status") };
  }
  if (status === 404 || status === 410) {
    return { title, status: `Missing pages return ${status}`, tone: "good", text: probeText(`answered ${status}`) };
  }
  if (status >= 200 && status < 300) {
    return { title, status: `Missing pages return ${status} — soft 404`, tone: "bad", text: probeText(`answered ${status}, so missing pages look like real pages`) };
  }
  return {
    title,
    status: `Missing pages return ${status}`,
    tone: "warn",
    text: probeText(`answered ${status}. Not a soft 404, but only a 404 or 410 tells search engines a page is gone`),
  };
}

const userAgentOptions = [
  { value: "Googlebot", label: "Googlebot" },
  { value: "Googlebot-Image", label: "Googlebot-Image" },
  { value: "Bingbot", label: "Bingbot" },
  { value: robotsAgent, label: `${robotsAgent} (this app's crawler)` },
  { value: "*", label: "* (any crawler)" },
  { value: "custom", label: "Custom…" },
];

// The backend reports why a URL was allowed or blocked; older APIs only sent
// the fetch status, so the same outcome is derived from it.
function robotsTestStatus(result: RobotsTestResult): RobotsTestStatus {
  if (result.status) return result.status;
  const fetched = knownNumber(result.fetchedStatus);
  if (result.source === "provided" || (fetched !== null && fetched >= 200 && fetched < 300)) {
    return result.matchedRule ? "matched" : "no-matching-rule";
  }
  return robotsFetchState(fetched) === "missing" ? "robots-missing" : "robots-unavailable";
}

function robotsTestRows(result: RobotsTestResult): StatusEvidenceRow[] {
  const status = robotsTestStatus(result);
  const answer = httpAnswer(result.fetchedStatus);
  const fileRead = status === "matched" || status === "no-matching-rule";
  const ruleRow: StatusEvidenceRow =
    status === "matched" && result.matchedRule
      ? {
          title: "Matched rule",
          status: ruleLabel(result.matchedRule.type),
          tone: ruleVariant(result.matchedRule.type) as StatusEvidenceRow["tone"],
          text: <code className="break-all font-mono text-[12.5px]">{result.matchedRule.path || "(empty)"}</code>,
        }
      : status === "robots-missing"
        ? { title: "Matched rule", status: "No robots.txt", tone: "warn", text: `robots.txt answered ${answer}, so there are no rules. ${missingRule}` }
        : status === "robots-unavailable"
          ? { title: "Matched rule", status: "robots.txt unavailable", tone: "bad", text: `${withError(`robots.txt could not be read: ${answer}`, result.error)}. ${unavailableRule}` }
          : { title: "Matched rule", status: "None", tone: "outline", text: "robots.txt was read and no rule matched this URL, so it is allowed by default." };
  return [
    ruleRow,
    {
      title: "User-agent group",
      status: fileRead ? result.userAgentGroup || "None" : "-",
      tone: "outline",
      text: !fileRead
        ? "No robots.txt rules were read, so no group applies."
        : result.userAgentGroup
          ? "The robots.txt group whose rules applied."
          : "No group addresses this crawler, so no rules apply.",
    },
    {
      title: "Robots.txt",
      status: result.source === "provided" ? "Pasted robots.txt" : fileRead ? "Live robots.txt" : status === "robots-missing" ? "Missing" : "Unavailable",
      tone: result.source === "provided" ? "outline" : fileRead ? "good" : status === "robots-missing" ? "warn" : "bad",
      text: (
        <span className="break-all">
          {result.robotsUrl || "-"}
          {result.source !== "provided" ? ` · ${answer}` : ""}
        </span>
      ),
    },
  ];
}

function defaultTestUrl(startUrl: string) {
  try {
    return new URL("/", startUrl).toString();
  } catch {
    return startUrl ? `${startUrl.replace(/\/+$/, "")}/` : "";
  }
}

// Checks one URL against the site's live robots.txt (or a pasted draft) with
// the same matcher the crawler uses, and shows the rule that decided it.
export function RobotsTester({ siteId, startUrl }: { siteId?: string | null; startUrl: string }) {
  const [url, setUrl] = useState(() => defaultTestUrl(startUrl));
  const [agent, setAgent] = useState("Googlebot");
  const [customAgent, setCustomAgent] = useState("");
  const [usePasted, setUsePasted] = useState(false);
  const [robotsTxt, setRobotsTxt] = useState("");
  const [pending, setPending] = useState(false);
  const [outcome, setOutcome] = useState<{ result?: RobotsTestResult; error?: string; agent: string } | null>(null);

  useEffect(() => {
    setUrl(defaultTestUrl(startUrl));
    setOutcome(null);
  }, [startUrl]);

  const userAgent = agent === "custom" ? customAgent.trim() : agent;

  async function test(event: SyntheticEvent) {
    event.preventDefault();
    if (!siteId || !url.trim() || !userAgent) return;
    setPending(true);
    try {
      const result = await api.robotsTest(siteId, {
        url: url.trim(),
        userAgent,
        robotsTxt: usePasted && robotsTxt.trim() ? robotsTxt : undefined,
      });
      setOutcome({ result, agent: userAgent });
    } catch (err) {
      setOutcome({ error: err instanceof Error ? err.message : "Could not test this URL", agent: userAgent });
    } finally {
      setPending(false);
    }
  }

  const result = outcome?.result;
  return (
    <ReportSection
      title="Robots tester"
      description="Test whether a crawler may fetch a URL. Uses the site's live robots.txt unless you paste a draft to try changes before publishing."
    >
      {!siteId ? (
        <EmptyState title="Tester needs a saved site" text="This scan is not linked to a saved site, so there is no robots.txt to test against." />
      ) : (
        <div className="grid gap-5 xl:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
          <form className="space-y-4" onSubmit={test}>
            <Field label="URL to test">
              <Input value={url} onChange={(event) => setUrl(event.target.value)} placeholder="https://example.com/page" required />
            </Field>
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="User agent">
                <Select value={agent} onValueChange={setAgent}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    {userAgentOptions.map((option) => <SelectItem key={option.value} value={option.value}>{option.label}</SelectItem>)}
                  </SelectContent>
                </Select>
              </Field>
              {agent === "custom" ? (
                <Field label="Custom user agent">
                  <Input value={customAgent} onChange={(event) => setCustomAgent(event.target.value)} placeholder="e.g. GPTBot" required />
                </Field>
              ) : null}
            </div>
            <div className="space-y-2">
              <Button type="button" variant="ghost" size="sm" className="h-7 px-2 text-xs text-muted-foreground" aria-expanded={usePasted} onClick={() => setUsePasted((value) => !value)}>
                {usePasted ? "Use the live robots.txt instead" : "Test against pasted robots.txt"}
              </Button>
              {usePasted ? (
                <Field label="Pasted robots.txt">
                  <Textarea
                    className="min-h-36 font-mono text-xs"
                    value={robotsTxt}
                    onChange={(event) => setRobotsTxt(event.target.value)}
                    placeholder={"User-agent: *\nDisallow: /private/"}
                  />
                </Field>
              ) : null}
            </div>
            <Button type="submit" disabled={pending || !url.trim() || !userAgent || (usePasted && !robotsTxt.trim())}>
              <FlaskConical /> {pending ? "Testing" : "Test URL"}
            </Button>
          </form>
          <div aria-live="polite" className="min-w-0">
            {outcome?.error ? (
              <p className="rounded-lg bg-bad-soft/50 px-3.5 py-2.5 text-sm text-destructive">{outcome.error}</p>
            ) : result ? (
              <div className="space-y-3 rounded-xl border border-border/60 px-4 py-3.5">
                <div className="flex flex-wrap items-center gap-2">
                  <Badge variant={result.allowed ? "good" : "bad"} className="text-sm">{result.allowed ? "Allowed" : "Blocked"}</Badge>
                  <span className="text-sm text-muted-foreground">for {outcome?.agent}</span>
                </div>
                <StatusEvidenceTable rows={robotsTestRows(result)} />
              </div>
            ) : (
              <p className="text-sm text-muted-foreground">Results show which rule allowed or blocked the URL.</p>
            )}
          </div>
        </div>
      )}
    </ReportSection>
  );
}
