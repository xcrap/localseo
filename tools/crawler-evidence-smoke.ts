import assert from "node:assert/strict";
import { run } from "../src/db";
import { scanReport } from "../src/report";
import { scanAiContext } from "../src/scan-summary";
import { getScan, getScanPage, startScan } from "../src/scans";

// Called by the smoke suite after it selects its disposable SQLite database.
export async function checkCrawlerEvidence() {
  const siteId = crypto.randomUUID();
  let scenario: "complete" | "partial" | "blocked" | "restricted" = "complete";
  const requested = new Set<string>();
  const externalRequests = new Set<string>();
  const external = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request) {
      const path = new URL(request.url).pathname;
      externalRequests.add(path);
      if (path === "/robots.txt") return new Response("User-agent: *\nDisallow: /private/");
      return new Response("Resource");
    },
  });
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request) {
      const { origin, pathname } = new URL(request.url);
      requested.add(pathname);
      const html = (body: string, headers: Record<string, string> = {}) =>
        new Response(body, { headers: { "content-type": "text/html", ...headers } });
      const xml = (body: string) => new Response(body, { headers: { "content-type": "application/xml" } });
      const urlset = (...paths: string[]) =>
        xml(`<urlset>${paths.map((path) => `<url><loc>${origin}${path}</loc></url>`).join("")}</urlset>`);
      if (pathname === "/robots.txt") {
        const disallow = scenario === "blocked" ? "/" : "/blocked/";
        const externalMap = scenario === "restricted" ? `\nSitemap: ${external.url.origin}/private/declared.xml` : "";
        return new Response(`User-agent: *\nDisallow: ${disallow}\nSitemap: ${origin}/custom-index.xml${externalMap}`);
      }
      if (pathname === "/custom-index.xml") {
        const maps = scenario === "partial"
          ? Array.from({ length: 25 }, (_, i) => `/map-${i}.xml`)
          : scenario === "restricted" ? ["/core.xml", "/blocked/child.xml", "/redirect.xml", "/external-redirect.xml"] : ["/core.xml"];
        return xml(`<sitemapindex>${maps.map((path) => `<sitemap><loc>${origin}${path}</loc></sitemap>`).join("")}</sitemapindex>`);
      }
      if (pathname === "/redirect.xml") return Response.redirect(`${origin}/blocked/redirect.xml`);
      if (pathname === "/external-redirect.xml") return Response.redirect(`${external.url.origin}/private/target.xml`);
      if (pathname === "/core.xml") return urlset("/", "/secondary", "/orphan", "/large", "/large-header");
      if (pathname.startsWith("/map-")) {
        return pathname === "/map-24.xml" ? urlset("/secondary") : urlset("/", "/large", "/large-header", "/orphan");
      }
      if (pathname === "/") return html('<title>Home</title><h1>Home</h1><a href="/secondary">Secondary</a><a href="/large">Large</a><a href="/large-header">Header</a>');
      if (pathname === "/orphan") return html('<title>Orphan</title><h1>Orphan</h1><a href="/orphan#top">Top of page</a>');
      if (pathname === "/secondary") {
        const externalLink = scenario === "restricted" ? `<a href="${external.url.origin}/private/link">External resource</a>` : "";
        return html(`<title>Secondary</title><h1>Secondary</h1>${externalLink}`);
      }
      if (pathname === "/large" || pathname === "/large-header") {
        if (scenario === "complete") return html("<h1>Earlier heading</h1>");
        const header: Record<string, string> = pathname === "/large-header" ? { "x-robots-tag": "noindex" } : {};
        return html(`<html><head><!--${"x".repeat(5 * 1024 * 1024)}--><title>Exists</title><meta name="robots" content="noindex"></head><body><h1>Exists</h1></body></html>`, header);
      }
      return new Response("Not found", { status: 404 });
    },
  });
  const base = server.url.origin;
  async function scan() {
    requested.clear();
    const started = await startScan(siteId, base);
    const deadline = Date.now() + 15_000;
    while (Date.now() < deadline) {
      const row = getScan(started.id);
      if (row.status === "completed") return row;
      assert.ok(["running", "queued"].includes(row.status), row.error);
      await Bun.sleep(10);
    }
    throw new Error("Timed out waiting for the crawler evidence fixture.");
  }
  try {
    run("INSERT INTO sites (id, name, domain, crawl_speed) VALUES (?, ?, ?, 'fast')", [siteId, "Crawler evidence fixture", server.url.host]);
    const first = await scan();
    assert.equal(requested.has("/sitemap.xml"), false);
    assert.equal(first.result.sitemap.coverageComplete, true);
    assert.equal(first.result.issues.some((row: any) => row.type === "sitemap-fetch-failed"), false);
    const orphan = getScanPage(first.id, `${base}/orphan`);
    assert.equal(orphan.page.internalInlinks, 0);
    assert.equal(orphan.inlinks.length, 0);
    assert.ok(orphan.issues.some((row: any) => row.type === "orphan-page"));
    assert.ok(orphan.outlinks.some((row: any) => row.href.startsWith(`${base}/orphan`)));

    scenario = "partial";
    const partial = await scan();
    assert.equal(partial.result.sitemap.coverageComplete, false);
    assert.equal(partial.result.sitemap.limitReached, true);
    assert.equal(requested.has("/map-24.xml"), false);
    const secondary = getScanPage(partial.id, `${base}/secondary`);
    assert.equal(secondary.page.sitemapListed, null);
    assert.equal(secondary.issues.some((row: any) => row.type === "page-missing-from-sitemap"), false);
    assert.equal(secondary.previous?.changes.some((row: any) => row.type === "page-removed-from-sitemap"), false);
    const large = getScanPage(partial.id, `${base}/large`);
    assert.equal(partial.result.summary.truncatedHtmlPages, 2);
    assert.match(scanReport(partial.id).html, /part of the HTML on 2 pages/);
    assert.match(scanAiContext(partial.id).text, /part of the HTML on 2 pages/);
    assert.equal(large.page.htmlTruncated, true);
    assert.equal(large.page.indexable, null);
    assert.equal(large.page.status, 200);
    assert.ok(large.issues.some((row: any) => row.type === "html-audit-incomplete"));
    assert.equal(large.issues.some((row: any) => row.type === "title-missing"), false);
    assert.equal(getScanPage(partial.id, `${base}/large-header`).page.indexable, false);
    assert.equal(partial.result.comparison.fixedIssues.some((issue: any) => issue.type === "title-missing" && issue.url === `${base}/large`), false);

    scenario = "restricted";
    const restricted = await scan();
    assert.equal(restricted.result.sitemap.coverageComplete, false);
    for (const path of ["/blocked/child.xml", "/blocked/redirect.xml"]) {
      assert.equal(requested.has(path), false, path);
      assert.ok(restricted.result.robotsSkipped.urls.some((row: any) => row.url === base + path));
    }
    for (const path of ["/private/declared.xml", "/private/target.xml"]) {
      assert.equal(externalRequests.has(path), false, path);
      assert.ok(restricted.result.robotsSkipped.urls.some((row: any) => row.url === external.url.origin + path));
    }
    assert.deepEqual(externalRequests, new Set(["/robots.txt", "/private/link"]));
    assert.equal(restricted.result.issues.some((row: any) => row.type === "sitemap-fetch-failed"), false);

    scenario = "blocked";
    const blocked = await scan();
    assert.deepEqual([...requested], ["/robots.txt"]);
    assert.equal(blocked.pages_crawled, 0);
    assert.equal(blocked.result.sitemap.coverageComplete, false);
  } finally {
    server.stop(true);
    external.stop(true);
    run("DELETE FROM sites WHERE id = ?", [siteId]);
  }
}
