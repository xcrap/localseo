import assert from "node:assert/strict";
import { run } from "../src/db";
import {
  backlinksOverview, createSite, deleteSite, domainOverview, getBacklinksProfile, getDomainKeywordsPage,
  getDomainKeywordSuggestions, getDomainPagesPage, importBacklinksCsv, importOrganicResearchCsv, readDuckDuckGoPage,
} from "../src/seo";

export async function verifySeoImports() {
  const { id: siteId } = createSite({ domain: "research.example" });
  try {
    const { rows } = readDuckDuckGoPage({
      status: 200,
      text: '<div class="result">No results</div><div class="result"><a class="result__a" href=" ">Blank</a></div>',
    });
    assert.equal(rows.length, 0, "Empty DuckDuckGo result containers cannot establish a rank.");

    const keywords = Array.from({ length: 60 }, (_, i) => ({ keyword: `term ${i}`, position: i + 1, traffic: i }));
    importOrganicResearchCsv({ siteId, rows: keywords });
    const pagesBatch = importOrganicResearchCsv({ siteId, csv: "Page,Keywords,Organic traffic,Traffic value\n/p,0,0,0\n/p,0,0,0\n/unknown,,," });
    assert.deepEqual(pagesBatch.summary, { organicKeywords: 0, organicTraffic: 0, estimatedValue: 0 });
    assert.equal(pagesBatch.pages.find((page) => page.relativePath === "/p")?.keywords, 0);
    assert.equal(pagesBatch.pages.find((page) => page.relativePath === "/unknown")?.organicTraffic, null);
    const ranked = await getDomainKeywordsPage({ siteId, sortMode: "traffic", sortOrder: "desc", page: 2, pageSize: 10 });
    assert.equal(ranked.keywords[0]?.keyword, "term 49", "Sort all records before taking a page.");
    assert.equal((await getDomainKeywordsPage({ siteId, allRows: true })).keywords.length, 60);
    assert.equal((await getDomainKeywordSuggestions({ siteId, limit: 5 }))[0]?.keyword, "term 59");
    // Previous versions persisted null for a legitimate zero in summary_json.
    run("UPDATE organic_imports SET summary_json = '{}' WHERE id = ?", [pagesBatch.id]);
    const organicOverview = await domainOverview({ siteId });
    assert.ok("organicTraffic" in organicOverview);
    assert.equal(organicOverview.organicTraffic, 0);
    importOrganicResearchCsv({ siteId, csv: "Keyword,Position\nnew keyword,3" });
    const olderPages = await getDomainPagesPage({ siteId, sortMode: "traffic", sortOrder: "asc", allRows: true });
    assert.equal(olderPages.pages[0]?.relativePath, "/p");
    assert.equal(olderPages.pages.length, 2, "A keyword-only export must leave the latest Pages export available.");
    const legacyOrganic = importOrganicResearchCsv({ siteId, csv: "Keyword,Page,Traffic\na,/zero,0\nb,/zero,0\nc,/unknown," });
    run("UPDATE organic_imports SET summary_json = '{}', pages_json = ? WHERE id = ?", [
      JSON.stringify(legacyOrganic.pages.map((page) => ({ ...page, organicTraffic: null }))), legacyOrganic.id,
    ]);
    const repairedPages = await getDomainPagesPage({ siteId });
    assert.equal(repairedPages.pages.find((page) => page.relativePath === "/zero")?.organicTraffic, 0);
    assert.equal(repairedPages.pages.find((page) => page.relativePath === "/unknown")?.organicTraffic, null);

    const grouped = importBacklinksCsv({ siteId, rows: [
      { "Referring domain": "ref.example", "Links count": 18, follow: "yes", status: "404", anchor: "group" },
      { "Source URL": "https://ref.example/a", "Target URL": "https://research.example/p", follow: "no", anchor: "page" },
    ] });
    assert.equal(grouped.rowCount, 2);
    assert.equal(grouped.rows[0].urlFrom, "");
    assert.equal(grouped.rows[0].urlTo, "");
    run("UPDATE backlink_imports SET summary_json = '{}' WHERE id = ?", [grouped.id]);
    const overview = await backlinksOverview({ siteId });
    assert.ok("backlinks" in overview);
    assert.equal(overview.backlinks, 19);
    assert.equal(overview.dofollowRatio, 95);
    assert.equal(overview.brokenBacklinks, 18);
    assert.deepEqual(overview.topAnchors[0], { anchor: "group", count: 18 });
    const domains = await getBacklinksProfile({ siteId, tab: "domains" });
    assert.equal(domains.rows[0].backlinks, 19);
    assert.equal(domains.rows[0].referringPages, null);
    assert.equal(domains.rows[0].brokenPages, null);
    const linked = await getBacklinksProfile({ siteId, tab: "pages" });
    assert.equal(linked.rows.length, 1);
    assert.equal(linked.rows[0].page, "https://research.example/p");
    assert.equal(linked.rows[0].backlinks, 1);

    const homepages = importBacklinksCsv({ siteId, rows: [
      { "Source URL": "https://ref.example", "Target URL": "https://research.example" },
      { "Source URL": "https://ref.example/", "Target URL": "https://research.example/" },
    ] });
    assert.equal((await getBacklinksProfile({ siteId, tab: "pages" })).rows.length, 2);
    // Simulate the old format, which cannot distinguish explicitly supplied
    // bare homepages and a missing field filled with the same URL.
    run("UPDATE backlink_imports SET summary_json = '{}' WHERE id = ?", [homepages.id]);
    const legacyRows = (await getBacklinksProfile({ siteId })).rows;
    const ambiguous = legacyRows.find((row: any) => row.unverifiedUrlFrom);
    assert.equal(ambiguous.urlFrom, "");
    assert.equal(ambiguous.urlTo, "");
    assert.equal(ambiguous.unverifiedUrlFrom, "https://ref.example");
    assert.equal(ambiguous.unverifiedUrlTo, "https://research.example");
    assert.equal(ambiguous.linksCount, null);
    assert.equal(ambiguous.unverifiedLinksCount, 1);
    const verifiedPages = await getBacklinksProfile({ siteId, tab: "pages" });
    assert.deepEqual(verifiedPages.rows.map((row: any) => row.page), ["https://research.example/"]);

    const incomplete = importBacklinksCsv({ siteId, csv: "Referring domain\nref.example" });
    assert.equal(incomplete.summary.backlinks, null, "A domain without a count cannot establish the total links.");
    const full = Array.from({ length: 55 }, (_, i) => ({ "Source URL": `https://ref.example/${i}`, rank: i }));
    importBacklinksCsv({ siteId, rows: full });
    const all = await getBacklinksProfile({ siteId, tab: "backlinks", allRows: true, sortField: "rank", sortOrder: "asc" });
    assert.equal(all.rows.length, 55);
    assert.equal(all.rows[0].rank, 0);
  } finally {
    deleteSite(siteId);
  }
}
