import { useState } from "react";
import { useSearchParams } from "react-router-dom";
import type { Site } from "../../../api";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui";
import { PageHeader, insightTabs } from "../../shared";
import { CannibalizationTab } from "./cannibalization";
import { DecayTab } from "./decay";
import { GscCrawlTab } from "./gsc-crawl";

type InsightTab = (typeof insightTabs)[number]["value"];

const DEFAULT_TAB: InsightTab = "gsc-crawl";

function isInsightTab(value: string | null): value is InsightTab {
  return insightTabs.some((tab) => tab.value === value);
}

export function InsightsPage({ site }: { site: Site }) {
  const [searchParams, setSearchParams] = useSearchParams();
  const urlTab = searchParams.get("tab");
  const activeTab: InsightTab = isInsightTab(urlTab) ? urlTab : DEFAULT_TAB;
  // Tabs mount on first visit and then stay mounted, so switching back keeps
  // the chosen dates and loaded rows instead of refetching.
  const [visited, setVisited] = useState<Set<InsightTab>>(() => new Set([activeTab]));
  if (!visited.has(activeTab)) setVisited(new Set([...visited, activeTab]));

  function changeTab(value: string) {
    if (!isInsightTab(value) || value === activeTab) return;
    const next = new URLSearchParams(searchParams);
    if (value === DEFAULT_TAB) next.delete("tab");
    else next.set("tab", value);
    setSearchParams(next, { replace: true });
  }

  return (
    <>
      <PageHeader
        title="Insights"
        description="Joins stored Search Console rows with local crawl evidence. Every row comes from your own Search Console data and saved scans; nothing is estimated."
        meta={site.domain || site.name}
      />
      <Tabs value={activeTab} onValueChange={changeTab} className="space-y-5">
        <TabsList className="h-auto flex-wrap justify-start gap-y-1">
          {insightTabs.map((tab) => (
            <TabsTrigger key={tab.value} value={tab.value}>
              {tab.label}
            </TabsTrigger>
          ))}
        </TabsList>
        <TabsContent value="gsc-crawl" forceMount className="data-[state=inactive]:hidden">
          {visited.has("gsc-crawl") ? <GscCrawlTab site={site} /> : null}
        </TabsContent>
        <TabsContent value="cannibalization" forceMount className="data-[state=inactive]:hidden">
          {visited.has("cannibalization") ? <CannibalizationTab site={site} /> : null}
        </TabsContent>
        <TabsContent value="decay" forceMount className="data-[state=inactive]:hidden">
          {visited.has("decay") ? <DecayTab site={site} /> : null}
        </TabsContent>
      </Tabs>
    </>
  );
}
