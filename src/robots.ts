// robots.txt parsing and Google-style URL matching (RFC 9309 plus Google's
// documented interpretation): the most specific user-agent group applies,
// the longest matching rule wins, Allow wins ties, and `*` / trailing `$`
// are wildcards.

export type RobotsRule = { type: "allow" | "disallow"; path: string };
export type RobotsGroup = { userAgents: string[]; rules: RobotsRule[] };

export function parseRobots(text: string) {
  const sitemaps: string[] = [];
  const groups: RobotsGroup[] = [];
  let disallowCount = 0;
  // Rules for `*` (or all agents) are the ones our crawl follows. A site is only
  // fully blocked when those groups disallow "/" and allow nothing back.
  let disallowsRoot = false;
  let allowsAnything = false;
  let crawlDelaySeconds = 0;
  // Track the user-agent group each directive belongs to. `Disallow: /` only
  // blocks our crawl when it applies to `*` (or all agents), so a targeted block
  // like `User-agent: GPTBot\nDisallow: /` must not flag the whole site.
  let currentAgents: string[] = [];
  let currentGroup: RobotsGroup | null = null;
  // Only Allow/Disallow lines close a group; a user-agent line after one
  // starts the next group. Sitemap and Crawl-delay lines do not split groups.
  let sawRuleInGroup = false;
  // A leading UTF-8 byte order mark is not part of the first line.
  for (const rawLine of text.replace(/^\uFEFF/, "").split(/\r?\n/)) {
    const line = rawLine.replace(/#.*/, "").trim();
    if (!line) continue;
    const [rawKey, ...rest] = line.split(":");
    const key = rawKey.trim().toLowerCase().replace(/[\s_]+/g, "-");
    const value = rest.join(":").trim();
    if ((key === "sitemap" || key === "site-map") && value) {
      sitemaps.push(value);
      continue;
    }
    if (key === "user-agent" || key === "useragent") {
      // Consecutive user-agent lines share the same following directive block.
      if (sawRuleInGroup || !currentGroup) {
        currentAgents = [];
        currentGroup = { userAgents: [], rules: [] };
        groups.push(currentGroup);
        sawRuleInGroup = false;
      }
      currentAgents.push(value.toLowerCase());
      currentGroup.userAgents.push(value);
      continue;
    }
    // Rules before the first user-agent line belong to no group: the matcher
    // ignores them, and so do the site-wide checks (a stray leading
    // `Disallow: /` does not block the site).
    const appliesToAll = currentAgents.includes("*");
    if (key === "disallow" || key === "allow") {
      sawRuleInGroup = true;
      // An empty Disallow means "allow everything"; it is not a rule.
      if (value && currentGroup) currentGroup.rules.push({ type: key, path: value });
      if (key === "disallow" && appliesToAll && value) {
        disallowCount += 1;
        if (value === "/") disallowsRoot = true;
      }
      if (key === "allow" && appliesToAll && value) allowsAnything = true;
    } else if (key === "crawl-delay") {
      const seconds = Number(value);
      if (appliesToAll && Number.isFinite(seconds) && seconds > 0) {
        crawlDelaySeconds = Math.max(crawlDelaySeconds, seconds);
      }
    }
  }
  return {
    sitemaps: [...new Set(sitemaps)],
    disallowCount,
    blocksAll: disallowsRoot && !allowsAnything,
    crawlDelaySeconds,
    groups,
  };
}

// The product token robots.txt matches on: "Googlebot/2.1" -> "googlebot".
function productToken(value: string) {
  return (/^[a-z_-]+/i.exec(value.trim())?.[0] || "").toLowerCase();
}

function agentMatches(agent: string, candidate: string) {
  return candidate === "*" ? /^\*(?:\s|$)/.test(agent.trim()) : productToken(agent) === candidate;
}

const unreservedCharacter = /^[A-Za-z0-9\-._~]$/;

// Compare paths as RFC 9309 octets: non-ASCII characters become percent-encoded
// UTF-8, escapes of unreserved characters are decoded, and every remaining
// escape uses upper-case hex, so "/caf%c3%a9", "/café" and "/caf%C3%A9" match.
function normalizeRobotsPath(value: string) {
  let encoded = "";
  for (const character of value) {
    try {
      encoded += character.charCodeAt(0) > 0x7f ? encodeURIComponent(character) : character;
    } catch {
      encoded += character;
    }
  }
  return encoded.replace(/%([0-9a-f]{2})/gi, (_, hex: string) => {
    const character = String.fromCharCode(Number.parseInt(hex, 16));
    return unreservedCharacter.test(character) ? character : `%${hex.toUpperCase()}`;
  });
}

// Google's matcher: `*` matches any run of characters and a trailing `$`
// anchors the end. Tracks every reachable path position, so it stays linear in
// the pattern length times the path length (no regex backtracking).
function robotsPatternMatches(path: string, pattern: string) {
  let positions = [0];
  for (let index = 0; index < pattern.length; index += 1) {
    const character = pattern[index];
    if (character === "$" && index === pattern.length - 1) {
      return positions[positions.length - 1] === path.length;
    }
    if (character === "*") {
      const start = positions[0];
      positions = Array.from({ length: path.length - start + 1 }, (_, offset) => start + offset);
      continue;
    }
    positions = positions.filter((position) => path[position] === character).map((position) => position + 1);
    if (!positions.length) return false;
  }
  return true;
}

function robotsUrlPath(url: string) {
  try {
    const parsed = new URL(url);
    return normalizeRobotsPath(`${parsed.pathname || "/"}${parsed.search}`);
  } catch {
    return null;
  }
}

// Picks the rules that apply to one crawler. Only the most specific group
// counts: groups naming the crawler's product token (merged when repeated),
// then "googlebot" for Google's specialised crawlers (Googlebot-Image,
// Googlebot-News), then `*`. No matching group means everything is allowed.
function robotsGroupFor(groups: RobotsGroup[], userAgent: string) {
  const token = productToken(userAgent);
  const candidates = token ? [token, ...(token.startsWith("googlebot-") ? ["googlebot"] : []), "*"] : ["*"];
  for (const candidate of candidates) {
    const matching = groups.filter((group) => group.userAgents.some((agent) => agentMatches(agent, candidate)));
    if (!matching.length) continue;
    const userAgentGroup = matching[0].userAgents.find((agent) => agentMatches(agent, candidate)) || candidate;
    return { userAgentGroup: userAgentGroup.trim(), rules: matching.flatMap((group) => group.rules) };
  }
  return null;
}

export type RobotsVerdict = { allowed: boolean; matchedRule: RobotsRule | null; userAgentGroup: string };

// Builds a matcher for one crawler, with rule paths normalized once.
export function robotsMatcher(groups: RobotsGroup[], userAgent = "Googlebot") {
  const group = robotsGroupFor(groups, userAgent);
  const rules = (group?.rules || []).map((rule) => ({ rule, pattern: normalizeRobotsPath(rule.path) }));
  return (url: string): RobotsVerdict => {
    const path = robotsUrlPath(url);
    // RFC 9309: /robots.txt itself is always allowed.
    if (!group || path === null || path === "/robots.txt") {
      return { allowed: true, matchedRule: null, userAgentGroup: group?.userAgentGroup || "" };
    }
    let best: (typeof rules)[number] | null = null;
    for (const candidate of rules) {
      if (!robotsPatternMatches(path, candidate.pattern)) continue;
      // Longest pattern wins; on equal length the less restrictive Allow wins.
      if (
        !best ||
        candidate.pattern.length > best.pattern.length ||
        (candidate.pattern.length === best.pattern.length && candidate.rule.type === "allow")
      ) {
        best = candidate;
      }
    }
    return {
      allowed: best?.rule.type !== "disallow",
      matchedRule: best ? { type: best.rule.type, path: best.rule.path } : null,
      userAgentGroup: group.userAgentGroup,
    };
  };
}

export function testRobots(robotsTxt: string, url: string, userAgent = "Googlebot"): RobotsVerdict {
  return robotsMatcher(parseRobots(robotsTxt).groups, userAgent)(url);
}
