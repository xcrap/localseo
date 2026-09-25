// Page identity used to match Search Console URLs, crawled pages, and rank
// snapshots: protocol, www, fragment, default port, and a trailing slash are
// ignored, like the crawler's own URL keys; the query string is kept (sorted),
// so parameter variants stay distinct pages.
export function pageUrlKey(value: string) {
  const text = String(value || "").trim();
  try {
    const url = new URL(text);
    url.searchParams.sort();
    const host = url.hostname.toLowerCase().replace(/^www\./, "");
    const path = url.pathname === "/" ? "/" : url.pathname.replace(/\/+$/, "");
    return `${host}${url.port ? `:${url.port}` : ""}${path}${url.search}`;
  } catch {
    return text;
  }
}
