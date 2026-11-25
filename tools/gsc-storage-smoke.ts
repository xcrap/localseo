import assert from "node:assert/strict";
import { get, run } from "../src/db";
import { getGscImport, getGscPerformance, importGscPerformance, listGscRows } from "../src/gsc";
import { gscPageData } from "../src/gsc-pages";
import { gscCrawlInsights } from "../src/insights";
import { scanReport } from "../src/report";
import { createSite, dashboardSummary } from "../src/seo";

// Invoked by the smoke suite after it has selected its disposable database.
export async function checkGscStorage() {
  const site = createSite({ domain: "gsc-evidence.test" });
  const siteId = site.id;
  const url = "https://gsc-evidence.test/page";
  const csv = (csv: string, extra = {}) => importGscPerformance({ siteId, csv, ...extra });

  const partial = csv(`Page,Clicks\n${url},5`);
  assert.equal(partial.totals.impressions, null);
  assert.equal(partial.totals.clicks, 5);
  run("UPDATE gsc_imports SET totals_json = ? WHERE id = ?", ['{"clicks":5,"impressions":0,"ctr":null}', partial.id]);
  assert.equal(dashboardSummary(siteId).latestGscImport?.totals.impressions, null);
  assert.equal(getGscImport(siteId, partial.id).rows[0].impressions, null);

  run("INSERT INTO scans (id, site_id, url, status) VALUES (?, ?, ?, 'completed')", [siteId, siteId, url]);
  run("INSERT INTO scan_results (scan_id, result_json) VALUES (?, ?)", [siteId, JSON.stringify({
    pages: [{ url, status: 200, isHtml: true, indexable: true, sitemapListed: null }], sitemap: { urlCount: 1 },
  })]);
  assert.equal(gscCrawlInsights(siteId, {}).sections.indexableNoImpressions.length, 0);
  assert.match(scanReport(siteId).html, /class="value">—<\/span><span class="name">Impressions/);
  const unknownClicks = csv(`Page,Impressions\n${url},150`);
  assert.equal(unknownClicks.totals.clicks, null);
  assert.equal(unknownClicks.totals.ctr, null);
  const zero = csv(`Page,Clicks,Impressions\n${url},0,0`);
  assert.equal(zero.totals.clicks, 0);
  assert.equal(zero.totals.impressions, 0);
  assert.equal(gscCrawlInsights(siteId, {}).sections.indexableNoImpressions[0].inSitemap, null);

  const dated = csv(`Page,Date,Clicks,Impressions\n${url},2026-05-01,1,10\n${url},2026-05-02,2,20`);
  const window = { startDate: "2026-05-01", endDate: "2026-05-02" };
  assert.throws(() => csv(`Page,Date,Clicks
${url},2026-06-01,5`, window), /outside the stated import window/);
  const dimensions = ["date", "page"];
  assert.equal(listGscRows(siteId, { dimensions, ...window }).total, 2);
  const subwindow = { startDate: window.endDate, endDate: window.endDate };
  assert.equal(listGscRows(siteId, { dimensions, ...subwindow }).rows[0].clicks, 2);
  const offline = await getGscPerformance({ siteId, dimensions, ...subwindow });
  assert.equal(offline.rows[0].clicks, 2);
  assert.equal(offline.rows.length, 1);
  assert.equal(offline.totals.ctr, 0.1);
  await assert.rejects(getGscPerformance({ siteId, dimensions: ["query"], ...window }), /matches/);
  await assert.rejects(getGscPerformance({ siteId, dimensions, startDate: "2025-01-01", endDate: "2025-01-31" }), /matches/);

  // Simulate a historical import whose declared end omitted a row date.
  run("UPDATE gsc_imports SET start_date = ?, end_date = ? WHERE id = ?", [window.startDate, window.startDate, dated.id]);
  const firstDay = { startDate: window.startDate, endDate: window.startDate };
  const exact = listGscRows(siteId, { dimensions, ...firstDay });
  assert.equal(exact.total, 1);
  assert.equal(exact.rows[0].clicks, 1);
  assert.equal(gscPageData(siteId, firstDay, { allowQueryRows: false })?.pages.values().next().value?.clicks, 1);
  assert.equal((await getGscPerformance({ siteId, dimensions, ...firstDay })).totals.clicks, 1);
  assert.equal(get<{ n: number }>("SELECT count(*) AS n FROM gsc_rows WHERE import_id = ?", [dated.id])?.n, 2);
}
