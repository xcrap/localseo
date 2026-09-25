import type { ReactNode } from "react";
import { Badge, Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui";
import { formatNumber } from "../../shared";

export function DrawerSection({ title, count, children }: { title: string; count?: number; children: ReactNode }) {
  return (
    <section className="space-y-2">
      <h3 className="flex items-baseline gap-2 font-heading text-[15px]">
        {title}
        {count != null ? <span className="text-[13px] font-normal text-muted-foreground">{formatNumber(count)}</span> : null}
      </h3>
      {children}
    </section>
  );
}

export function structuredDataTypeLabel(item: any) {
  const type = Array.isArray(item?.type) ? item.type.filter(Boolean).join(", ") : String(item?.type || "");
  return type || "Untyped item";
}

function stringList(value: unknown): string[] {
  return Array.isArray(value) ? value.map((item) => String(item)).filter(Boolean) : [];
}

// Structured data items found on the page, with the schema properties the
// crawler found missing. Absent evidence (older scans) is said so, not shown
// as "no structured data".
export function StructuredDataSection({ items }: { items: unknown }) {
  if (!Array.isArray(items)) {
    return (
      <DrawerSection title="Structured data">
        <p className="text-sm text-muted-foreground">Structured data details were not collected in this scan.</p>
      </DrawerSection>
    );
  }
  return (
    <DrawerSection title="Structured data" count={items.length}>
      {items.length ? (
        <ul className="space-y-2">
          {items.map((item: any, index: number) => {
            const required = stringList(item?.missingRequired);
            const recommended = stringList(item?.missingRecommended);
            return (
              <li key={`${structuredDataTypeLabel(item)}:${index}`} className="space-y-1.5 rounded-lg border border-border/60 px-3 py-2.5">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-sm font-medium">{structuredDataTypeLabel(item)}</span>
                  {item?.format ? <Badge variant="outline">{item.format}</Badge> : null}
                </div>
                {required.length ? (
                  <div className="flex flex-wrap items-center gap-1.5 text-xs">
                    <span className="text-muted-foreground">Missing required:</span>
                    {required.map((property) => <Badge key={property} variant="bad">{property}</Badge>)}
                  </div>
                ) : (
                  <p className="text-xs text-good">All required properties present</p>
                )}
                {recommended.length ? (
                  <div className="flex flex-wrap items-center gap-1.5 text-xs">
                    <span className="text-muted-foreground">Missing recommended:</span>
                    {recommended.map((property) => <Badge key={property} variant="warn">{property}</Badge>)}
                  </div>
                ) : null}
              </li>
            );
          })}
        </ul>
      ) : (
        <p className="text-sm text-muted-foreground">No structured data items were found on this page.</p>
      )}
    </DrawerSection>
  );
}

function statusVariant(status: unknown) {
  const code = Number(status);
  if (!Number.isFinite(code) || status == null || status === "") return "outline";
  if (code >= 400) return "bad";
  if (code >= 300) return "warn";
  return "good";
}

export function HreflangSection({ links }: { links: unknown }) {
  if (!Array.isArray(links)) return null;
  return (
    <DrawerSection title="Hreflang" count={links.length}>
      {links.length ? (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Lang</TableHead>
              <TableHead>Alternate URL</TableHead>
              <TableHead>Status</TableHead>
              <TableHead>Return link</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {links.map((link: any, index: number) => (
              <TableRow key={`${link?.lang}:${link?.href}:${index}`}>
                <TableCell className="font-mono text-xs">{link?.lang || "-"}</TableCell>
                <TableCell className="max-w-72 break-all text-xs">{link?.href || "-"}</TableCell>
                <TableCell>
                  <Badge variant={statusVariant(link?.targetStatus) as any}>{link?.targetStatus ?? "not checked"}</Badge>
                </TableCell>
                <TableCell>
                  {link?.returnLink === true ? (
                    <Badge variant="good">Yes</Badge>
                  ) : link?.returnLink === false ? (
                    <Badge variant="bad">Missing</Badge>
                  ) : (
                    <Badge variant="outline">Unknown</Badge>
                  )}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      ) : (
        <p className="text-sm text-muted-foreground">This page declares no hreflang alternates.</p>
      )}
    </DrawerSection>
  );
}

export function NearDuplicatesSection({ rows, onOpenPage }: { rows: unknown; onOpenPage?: (url: string) => void }) {
  if (!Array.isArray(rows)) return null;
  return (
    <DrawerSection title="Near duplicates" count={rows.length}>
      {rows.length ? (
        <ul className="divide-y divide-border/50 rounded-lg border border-border/60">
          {rows.map((row: any, index: number) => {
            const similarity = Number(row?.similarity);
            return (
              <li key={`${row?.url}:${index}`} className="flex items-center justify-between gap-3 px-3 py-2 text-sm">
                {onOpenPage && row?.url ? (
                  <button
                    type="button"
                    className="min-w-0 break-all rounded-sm text-left hover:text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/60"
                    onClick={() => onOpenPage(row.url)}
                  >
                    {row.url}
                  </button>
                ) : (
                  <span className="min-w-0 break-all">{row?.url || "-"}</span>
                )}
                <Badge variant="warn" className="nums shrink-0">
                  {Number.isFinite(similarity) ? `${Math.round(similarity * 100)}% similar` : "similarity unknown"}
                </Badge>
              </li>
            );
          })}
        </ul>
      ) : (
        <p className="text-sm text-muted-foreground">No near-duplicate pages were found for this page.</p>
      )}
    </DrawerSection>
  );
}
