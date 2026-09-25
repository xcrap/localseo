import { useEffect, useRef, useState, type ReactNode } from "react";
import { ExternalLink } from "lucide-react";
import { api, type ScanPageDetail } from "../../../api";
import { Badge, Button, Sheet, SheetBody, SheetContent, SheetDescription, SheetHeader, SheetTitle, Skeleton } from "@/components/ui";
import { EmptyState, IndexabilityBadge, formatBytes, formatMs, formatNumber, pageH1Count } from "../../shared";
import { severityVariant } from "./common";
import { EvidenceList } from "./issues";
import { issueGuidance, issueTypeTitle, type IssueCatalog } from "./issue-catalog";
import { DrawerSection, HreflangSection, NearDuplicatesSection, StructuredDataSection } from "./page-drawer-sections";

const LIST_STEP = 50;

// Long lists (inlinks on a home page can run into the hundreds) render in
// steps with an explicit "show more", never a silent cap.
function SteppedList<T>({ items, render, empty }: { items: T[]; render: (item: T, index: number) => ReactNode; empty: string }) {
  const [visible, setVisible] = useState(LIST_STEP);
  if (!items.length) return <p className="text-sm text-muted-foreground">{empty}</p>;
  return (
    <div className="space-y-2">
      <ul className="divide-y divide-border/50 rounded-lg border border-border/60">
        {items.slice(0, visible).map((item, index) => (
          <li key={index} className="px-3 py-2 text-sm">
            {render(item, index)}
          </li>
        ))}
      </ul>
      {items.length > visible ? (
        <Button size="sm" variant="ghost" className="h-7 px-2 text-xs" onClick={() => setVisible((value) => value + LIST_STEP)}>
          Show {formatNumber(Math.min(LIST_STEP, items.length - visible))} more of {formatNumber(items.length - visible)} remaining
        </Button>
      ) : null}
    </div>
  );
}

function Fact({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="min-w-0">
      <dt className="eyebrow-muted">{label}</dt>
      <dd className="mt-1 min-w-0 break-words text-sm">{children}</dd>
    </div>
  );
}

export function ScanPageDrawer({
  scanId,
  pageUrl,
  localPage,
  catalog,
  onClose,
  onOpenPage,
}: {
  scanId: string;
  pageUrl: string;
  /** The page row already in the loaded scan, shown instantly while details load. */
  localPage?: any;
  catalog: IssueCatalog;
  onClose: () => void;
  /** Switches the drawer to another page of this scan (near duplicates). */
  onOpenPage?: (url: string) => void;
}) {
  const [detail, setDetail] = useState<{ url: string; data?: ScanPageDetail; error?: string } | null>(null);
  const requestRef = useRef(0);
  useEffect(() => {
    if (!pageUrl) return;
    const token = ++requestRef.current;
    setDetail({ url: pageUrl });
    api
      .scanPage(scanId, pageUrl)
      .then((data) => {
        if (token === requestRef.current) setDetail({ url: pageUrl, data });
      })
      .catch((err) => {
        if (token === requestRef.current) {
          setDetail({ url: pageUrl, error: err instanceof Error ? err.message : "Could not load page details" });
        }
      });
  }, [scanId, pageUrl]);

  const current = detail?.url === pageUrl ? detail : null;
  const data = current?.data;
  const loading = Boolean(pageUrl) && !current?.data && !current?.error;
  const page = data?.page || localPage || null;
  const issues: any[] = (data?.issues || page?.issues || []).filter((issue: any) => !issue.ignored);
  const redirectChain: any[] = Array.isArray(page?.redirectChain) ? page.redirectChain : [];
  const h1s: string[] = Array.isArray(page?.h1s) ? page.h1s.filter((item: unknown) => String(item || "").trim()) : [];

  return (
    <Sheet open={Boolean(pageUrl)} onOpenChange={(open) => !open && onClose()}>
      <SheetContent>
        <SheetHeader>
          <SheetTitle className="line-clamp-2">{page?.title || "Page details"}</SheetTitle>
          <SheetDescription className="break-all">{pageUrl}</SheetDescription>
          {pageUrl ? (
            <div className="mt-1 flex flex-wrap items-center gap-2">
              <Button asChild size="sm" variant="outline">
                <a href={pageUrl} target="_blank" rel="noreferrer"><ExternalLink /> Open page</a>
              </Button>
              {page?.robotsBlocked === true ? <Badge variant="bad">Blocked by robots.txt</Badge> : null}
            </div>
          ) : null}
        </SheetHeader>
        <SheetBody className="space-y-6">
          {current?.error ? (
            <p className="rounded-lg bg-bad-soft/50 px-3.5 py-2.5 text-sm text-destructive">
              {current.error}. {page ? "Showing the saved page row from this scan." : ""}
            </p>
          ) : null}
          {!page ? (
            loading ? (
              <div className="space-y-3" role="status" aria-busy="true" aria-label="Loading page details">
                <Skeleton className="h-24 rounded-xl" />
                <Skeleton className="h-40 rounded-xl" />
              </div>
            ) : (
              <EmptyState title="Page not in this scan" text="This URL has no saved page row in the selected scan." />
            )
          ) : (
            <>
              <dl className="grid grid-cols-2 gap-x-4 gap-y-4 sm:grid-cols-3">
                <Fact label="Status">
                  <Badge variant={page.status >= 400 ? "bad" : page.sourceStatus >= 300 || page.status >= 300 ? "warn" : "good"}>
                    {page.sourceStatus != null && page.sourceStatus !== page.status ? `${page.sourceStatus} → ${page.status}` : page.status ?? "-"}
                  </Badge>
                </Fact>
                <Fact label="Indexable">
                  <span className="inline-flex flex-wrap items-center gap-1.5">
                    <IndexabilityBadge page={page} />
                    {page.indexabilityReason && page.indexabilityReason !== "indexable" ? (
                      <span className="text-xs text-muted-foreground">{String(page.indexabilityReason).replaceAll("-", " ")}</span>
                    ) : null}
                  </span>
                </Fact>
                <Fact label="Crawl depth">{page.depth != null ? formatNumber(page.depth) : "-"}</Fact>
                <Fact label="Internal inlinks">{formatNumber(data?.inlinks?.length ?? page.internalInlinks ?? 0)}</Fact>
                <Fact label="Discovered via">{page.discovery ? String(page.discovery).replaceAll("-", " ") : "-"}</Fact>
                <Fact label="Sitemap">{page.sitemapListed ? "Listed" : page.sitemapSourceListed ? "Redirect source listed" : "Not listed"}</Fact>
                <Fact label="Response">{formatMs(page.loadMs)}</Fact>
                <Fact label="HTML size">{formatBytes(page.contentLength)}</Fact>
                <Fact label="Words">{formatNumber(page.wordCount)}</Fact>
                <Fact label="Schema blocks">
                  {formatNumber(page.schemaCount || 0)}
                  {Number(page.schemaParseErrors || 0) ? <span className="text-xs text-warn"> · {formatNumber(page.schemaParseErrors)} parse errors</span> : null}
                </Fact>
                <Fact label="Hreflang links">{formatNumber(Array.isArray(page.hreflang) ? page.hreflang.length : page.hreflangCount || 0)}</Fact>
                <Fact label="Links out">
                  {formatNumber(page.internalLinks || 0)} internal · {formatNumber(page.externalLinks || 0)} external
                </Fact>
                {typeof page.robotsBlocked === "boolean" ? (
                  <Fact label="Robots.txt">
                    <Badge variant={page.robotsBlocked ? "bad" : "good"}>{page.robotsBlocked ? "Blocked" : "Allowed"}</Badge>
                  </Fact>
                ) : null}
              </dl>

              <DrawerSection title="Canonical">
                <p className="break-all text-sm text-muted-foreground">
                  {page.canonical || "No canonical tag"}
                  {Number(page.canonicalCount || 0) > 1 ? ` · ${formatNumber(page.canonicalCount)} canonical tags` : ""}
                </p>
              </DrawerSection>

              {redirectChain.length ? (
                <DrawerSection title="Redirect chain" count={redirectChain.length}>
                  <ol className="space-y-1.5 text-sm">
                    {redirectChain.map((hop: any, index: number) => (
                      <li key={`${hop.url}:${index}`} className="flex flex-wrap items-center gap-2">
                        <Badge variant="warn">{hop.status ?? "?"}</Badge>
                        <span className="break-all text-muted-foreground">{hop.url}</span>
                        <span aria-hidden className="text-muted-foreground">→</span>
                        <span className="break-all">{hop.targetUrl || hop.location || "-"}</span>
                      </li>
                    ))}
                  </ol>
                </DrawerSection>
              ) : null}

              <DrawerSection title="H1 headings" count={pageH1Count(page)}>
                {h1s.length ? (
                  <ul className="list-disc space-y-1 pl-5 text-sm">
                    {h1s.map((heading, index) => <li key={index} className="break-words">{heading}</li>)}
                  </ul>
                ) : (
                  <p className="text-sm text-muted-foreground">{page.h1 || "No H1 text saved"}</p>
                )}
              </DrawerSection>

              <StructuredDataSection items={page.structuredData} />
              <HreflangSection links={page.hreflang} />
              <NearDuplicatesSection rows={page.nearDuplicates} onOpenPage={onOpenPage} />

              <DrawerSection title="Issues" count={issues.length}>
                {issues.length ? (
                  <div className="space-y-2">
                    {issues.map((issue: any, index: number) => {
                      const guidance = issueGuidance(catalog, issue.type, issue.recommendation);
                      return (
                        <div key={`${issue.type}:${index}`} className="space-y-1.5 rounded-lg border border-border/60 px-3 py-2.5">
                          <div className="flex flex-wrap items-center gap-2">
                            <Badge variant={severityVariant(issue.severity) as any} className="text-[10px] uppercase">{issue.severity}</Badge>
                            <span className="text-sm font-medium">{issueTypeTitle(catalog, issue.type)}</span>
                          </div>
                          {issue.message ? <p className="text-xs text-muted-foreground">{issue.message}</p> : null}
                          {guidance.why ? <p className="text-xs text-muted-foreground"><span className="font-medium text-foreground/80">Why: </span>{guidance.why}</p> : null}
                          {guidance.fix ? <p className="text-xs text-muted-foreground"><span className="font-medium text-foreground/80">Fix: </span>{guidance.fix}</p> : null}
                          <EvidenceList evidence={issue.evidence} />
                        </div>
                      );
                    })}
                  </div>
                ) : (
                  <p className="text-sm text-muted-foreground">No open issues on this page.</p>
                )}
              </DrawerSection>

              <DrawerSection title="Inlinks" count={data ? data.inlinks.length : undefined}>
                {data ? (
                  <SteppedList
                    items={data.inlinks}
                    empty="No internal links to this page were found in this crawl."
                    render={(link) => (
                      <div className="space-y-0.5">
                        <div className="break-all">{link.from}</div>
                        <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                          <span>{link.anchor ? `“${link.anchor}”` : "No anchor text"}</span>
                          {link.nofollow ? <Badge variant="warn">nofollow</Badge> : null}
                        </div>
                      </div>
                    )}
                  />
                ) : (
                  <p className="text-sm text-muted-foreground">{loading ? "Loading link sources…" : "Link sources are unavailable for this page."}</p>
                )}
              </DrawerSection>

              <DrawerSection title="Outlinks" count={data ? data.outlinks.length : undefined}>
                {data ? (
                  <SteppedList
                    items={data.outlinks}
                    empty="No links were saved from this page."
                    render={(link: any) => (
                      <div className="space-y-0.5">
                        <div className="break-all">{link.href || link.url}</div>
                        <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                          {link.type ? <Badge variant="outline">{link.type}</Badge> : null}
                          <span>{link.anchor || link.accessibleName || "No anchor text"}</span>
                          {link.rel ? <span>rel={link.rel}</span> : null}
                        </div>
                      </div>
                    )}
                  />
                ) : (
                  <p className="text-sm text-muted-foreground">{loading ? "Loading outlinks…" : "Outlinks are unavailable for this page."}</p>
                )}
              </DrawerSection>

              <DrawerSection title="Images" count={data ? data.images.length : page.images}>
                {data ? (
                  <SteppedList
                    items={data.images}
                    empty="No image tags were saved from this page."
                    render={(image: any) => (
                      <div className="space-y-0.5">
                        <div className="break-all">{image.src || image.url || "Missing src"}</div>
                        <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                          {image.altState ? <Badge variant={image.altState === "present" ? "good" : "warn"}>alt {image.altState}</Badge> : null}
                          {image.altPreview ? <span className="line-clamp-1">{image.altPreview}</span> : null}
                          {Array.isArray(image.issues) && image.issues.length ? <span>{image.issues.join(" · ")}</span> : null}
                        </div>
                      </div>
                    )}
                  />
                ) : (
                  <p className="text-sm text-muted-foreground">{loading ? "Loading images…" : `${formatNumber(page.images || 0)} image tags counted; tag details are unavailable.`}</p>
                )}
              </DrawerSection>

              <DrawerSection title="Changed since last scan" count={data?.previous ? data.previous.changes.length : undefined}>
                {data ? (
                  data.previous ? (
                    data.previous.changes.length ? (
                      <ul className="space-y-2">
                        {data.previous.changes.map((change: any, index: number) => (
                          <li key={`${change.field}:${index}`} className="rounded-lg border border-border/60 px-3 py-2 text-sm">
                            <div className="flex flex-wrap items-center gap-2">
                              <Badge variant={change.regression ? "bad" : "outline"}>{change.label || change.field || String(change.type || "changed").replaceAll("-", " ")}</Badge>
                            </div>
                            <div className="mt-1 grid gap-1 text-xs sm:grid-cols-2">
                              <span className="break-words text-muted-foreground">Before: {String(change.before ?? "-") || "-"}</span>
                              <span className="break-words">After: {String(change.after ?? "-") || "-"}</span>
                            </div>
                          </li>
                        ))}
                      </ul>
                    ) : (
                      <p className="text-sm text-muted-foreground">No changes since the previous scan of this page.</p>
                    )
                  ) : (
                    <p className="text-sm text-muted-foreground">No earlier comparable scan includes this page.</p>
                  )
                ) : (
                  <p className="text-sm text-muted-foreground">{loading ? "Comparing with the previous scan…" : "Change history is unavailable for this page."}</p>
                )}
              </DrawerSection>
            </>
          )}
        </SheetBody>
      </SheetContent>
    </Sheet>
  );
}
