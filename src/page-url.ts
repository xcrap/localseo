// Page identity used to match Search Console URLs, crawled pages, and rank
// snapshots: protocol, www, fragment, default port, and a trailing slash are
// ignored, like the crawler's own URL keys; the query string is kept (sorted),
// so parameter variants stay distinct pages. Percent-escapes are uppercased
// (%c3%a9 and %C3%A9 are the same byte), so Search Console's encoding and the
// crawler's match.
export function pageUrlKey(value: string) {
  const text = String(value || "").trim();
  try {
    const url = new URL(text);
    url.searchParams.sort();
    const host = url.hostname.toLowerCase().replace(/^www\./, "");
    const path = url.pathname === "/" ? "/" : url.pathname.replace(/\/+$/, "");
    const key = `${host}${url.port ? `:${url.port}` : ""}${path}${url.search}`;
    return key.replace(/%[0-9a-f]{2}/gi, (hex) => hex.toUpperCase());
  } catch {
    return text;
  }
}
