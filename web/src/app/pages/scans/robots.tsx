import { useEffect, useState, type SyntheticEvent } from "react";
import { FlaskConical } from "lucide-react";
import { api, type RobotsTestResult } from "../../../api";
import { Badge, Button, Input, Select, SelectContent, SelectItem, SelectTrigger, SelectValue, Textarea } from "@/components/ui";
import { EmptyState, Field, ReportSection, StatusEvidenceTable, formatNumber, type StatusEvidenceRow } from "../../shared";

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

// Parsed robots.txt groups saved with the scan: which user agents each group
// addresses and the Allow/Disallow rules it carries, in file order.
export function RobotsGroups({ robots }: { robots: any }) {
  const groups: RobotsGroup[] | null = Array.isArray(robots?.groups) ? robots.groups : null;
  return (
    <ReportSection
      title="Robots.txt groups"
      description="Each user-agent group parsed from robots.txt during the scan, with its Allow and Disallow rules in file order."
      meta={groups ? `${formatNumber(groups.length)} ${groups.length === 1 ? "group" : "groups"}` : undefined}
    >
      {!groups ? (
        <EmptyState
          title={robots?.exists === false ? "No robots.txt found" : "Groups not saved for this scan"}
          text={robots?.exists === false ? "The crawler found no robots.txt file, so every URL is crawlable by default." : "Rescan to see parsed robots.txt groups."}
        />
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

// Soft 404 probe: the crawler requests a URL that cannot exist and records how
// the server answers.
export function softNotFoundEvidenceRow(result: any): StatusEvidenceRow {
  const probe = result?.softNotFound;
  if (!probe || typeof probe !== "object") {
    return { title: "Soft 404 check", status: "Not checked", tone: "outline", text: "Not checked in this scan." };
  }
  const soft = probe.soft404 === true;
  const known = typeof probe.soft404 === "boolean";
  return {
    title: "Soft 404 check",
    status: !known
      ? "Inconclusive"
      : soft
        ? probe.status != null
          ? `Missing pages return ${probe.status} — soft 404`
          : "Soft 404 — missing pages do not return 404/410"
        : "Missing pages return a real 404/410",
    tone: !known ? "outline" : soft ? "bad" : "good",
    text: (
      <span className="break-all">
        Probe {probe.probeUrl || "-"} answered {probe.status ?? "no status"}
        {probe.finalUrl && probe.finalUrl !== probe.probeUrl ? ` after redirecting to ${probe.finalUrl}` : ""}.
      </span>
    ),
  };
}

const userAgentOptions = [
  { value: "Googlebot", label: "Googlebot" },
  { value: "Googlebot-Image", label: "Googlebot-Image" },
  { value: "Bingbot", label: "Bingbot" },
  { value: "*", label: "* (any crawler)" },
  { value: "custom", label: "Custom…" },
];

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
                <StatusEvidenceTable
                  rows={[
                    {
                      title: "Matched rule",
                      status: result.matchedRule ? ruleLabel(result.matchedRule.type) : "None",
                      tone: result.matchedRule ? (ruleVariant(result.matchedRule.type) as any) : "outline",
                      text: result.matchedRule ? (
                        <code className="break-all font-mono text-[12.5px]">{result.matchedRule.path || "(empty)"}</code>
                      ) : (
                        "No rule matched — allowed by default."
                      ),
                    },
                    {
                      title: "User-agent group",
                      status: result.userAgentGroup || "None",
                      tone: "outline",
                      text: result.userAgentGroup ? "The robots.txt group whose rules applied." : "No group addresses this crawler, so no rules apply.",
                    },
                    {
                      title: "Robots.txt",
                      status: result.source === "provided" ? "Pasted robots.txt" : "Live robots.txt",
                      tone: result.source === "provided" ? "outline" : result.fetchedStatus != null && result.fetchedStatus >= 400 ? "warn" : "good",
                      text: (
                        <span className="break-all">
                          {result.robotsUrl || "-"}
                          {result.source !== "provided" ? ` · HTTP ${result.fetchedStatus ?? "no response"}` : ""}
                        </span>
                      ),
                    },
                  ]}
                />
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
