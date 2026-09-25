import { useEffect, useState } from "react";
import { api, type ScanIssueType } from "../../../api";
import { humanizeIssueType } from "./common";

export type IssueCatalog = Map<string, ScanIssueType>;

const emptyCatalog: IssueCatalog = new Map();
let catalogRequest: Promise<IssueCatalog> | null = null;

// The issue-type catalog is static per app build, so it is fetched once per
// session and shared by every scan view.
function loadIssueCatalog() {
  if (!catalogRequest) {
    catalogRequest = api
      .scanIssueTypes()
      .then((rows) => new Map((Array.isArray(rows) ? rows : []).map((row) => [row.type, row])))
      .catch(() => {
        catalogRequest = null;
        return emptyCatalog;
      });
  }
  return catalogRequest;
}

export function useIssueCatalog() {
  const [catalog, setCatalog] = useState<IssueCatalog>(emptyCatalog);
  useEffect(() => {
    let cancelled = false;
    loadIssueCatalog().then((next) => {
      if (!cancelled) setCatalog(next);
    });
    return () => {
      cancelled = true;
    };
  }, []);
  return catalog;
}

// Generic per-type title ("Missing meta description"), never a page-specific
// message, so a group reads the same whichever issue happened to be first.
export function issueTypeTitle(catalog: IssueCatalog, type: unknown, fallback?: unknown) {
  const key = String(type || "");
  const title = catalog.get(key)?.title || (typeof fallback === "string" ? fallback : "");
  if (title) return title;
  const label = humanizeIssueType(key);
  return label ? label.charAt(0).toUpperCase() + label.slice(1) : "Issue";
}

export function issueGuidance(catalog: IssueCatalog, type: unknown, recommendation?: unknown) {
  const entry = catalog.get(String(type || ""));
  return {
    why: entry?.why || "",
    fix: entry?.fix || (typeof recommendation === "string" ? recommendation : ""),
  };
}
