type JsonValue = null | boolean | number | string | JsonValue[] | JsonRecord;
type JsonRecord = { [key: string]: JsonValue };
type StructuredResult = JsonRecord | JsonValue[];

function isRecord(value: JsonValue): value is JsonRecord {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function parseStructuredResult(text: string): StructuredResult | undefined {
  const first = text.trimStart()[0];
  if (first !== "{" && first !== "[") return undefined;
  try {
    return JSON.parse(text) as StructuredResult;
  } catch {
    return undefined;
  }
}

function fieldLabel(key: string) {
  if (key === "intent") return "Search intent";
  if (key === "clusters") return "Keyword clusters";
  const words = key.replace(/([a-z\d])([A-Z])/g, "$1 $2").replace(/[_-]+/g, " ").trim();
  return words ? words[0].toUpperCase() + words.slice(1) : "Value";
}

function ResultFields({ entries }: { entries: [string, JsonValue][] }) {
  if (!entries.length) return <span className="text-muted-foreground">No details</span>;
  return (
    <dl className="space-y-3">
      {entries.map(([key, value]) => (
        <div key={key}>
          <dt className="font-semibold">{fieldLabel(key)}</dt>
          <dd className="mt-0.5 text-foreground/90"><ResultValue value={value} field={key} /></dd>
        </div>
      ))}
    </dl>
  );
}

function ResultValue({ value, field }: { value: JsonValue; field?: string }) {
  if (value == null || value === "") return <span className="text-muted-foreground">Not provided</span>;
  if (isRecord(value)) return <ResultFields entries={Object.entries(value)} />;
  if (Array.isArray(value)) {
    if (!value.length) return <span className="text-muted-foreground">{field === "clusters" ? "No clusters" : "None"}</span>;
    return (
      <ul className="space-y-2">
        {value.map((item, index) => (
          <li key={index} className={isRecord(item) ? "rounded-lg border border-border/70 bg-muted/30 p-3.5" : undefined}>
            <ResultValue value={item} />
          </li>
        ))}
      </ul>
    );
  }
  if (typeof value === "boolean") return value ? "Yes" : "No";
  const rendered = field === "status" && typeof value === "string" ? fieldLabel(value) : value;
  return <span className="whitespace-pre-line">{rendered}</span>;
}

export function AiJobStructuredResult({ data, source }: { data: StructuredResult; source: string }) {
  const status = Array.isArray(data) ? undefined : data.status;
  const needsKeywords = status === "missing_keywords";
  const needsInput = typeof status === "string" && /^(missing|needs|insufficient)[_ -]/i.test(status);
  const message = Array.isArray(data) || typeof data.message !== "string" ? undefined : data.message;
  const entries = Array.isArray(data) ? [] : Object.entries(data).filter(([key, value]) => {
    if (!needsInput) return true;
    if (key === "status" || (key === "message" && message)) return false;
    return !(key === "clusters" && Array.isArray(value) && value.length === 0);
  });

  return (
    <div className="space-y-4">
      {needsInput && (
        <div className="space-y-1 rounded-lg border border-warn/30 bg-warn-soft/55 px-4 py-3">
          <h3 className="font-semibold text-warn">{needsKeywords ? "Keywords needed" : "More input needed"}</h3>
          <p>{needsKeywords ? "Paste your keywords into Context, one per line, then start the job again." : message || "Add the information requested below and start the job again."}</p>
        </div>
      )}
      {Array.isArray(data) ? <ResultValue value={data} /> : entries.length || !needsInput ? <ResultFields entries={entries} /> : null}
      <details className="rounded-lg border border-border/60">
        <summary className="cursor-pointer px-3.5 py-2 text-xs font-medium text-muted-foreground hover:text-foreground">Raw output</summary>
        <pre className="border-t border-border/60"><code>{source.trim()}</code></pre>
      </details>
    </div>
  );
}
