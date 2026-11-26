import Markdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import { TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui";
import { AiJobStructuredResult, parseStructuredResult } from "./ai-job-structured-result";

const markdownComponents: Components = {
  h1: "h3",
  h2: "h3",
  h3: "h4",
  h4: "h5",
  h5: "h6",
  a: ({ node: _node, ...props }) => (
    <a
      {...props}
      href={props.href || undefined}
      rel="noreferrer"
      target={props.href && !props.href.startsWith("#") ? "_blank" : undefined}
    />
  ),
  img: ({ alt }) => alt || null,
  pre: ({ children, node }) => {
    const code = node?.children[0];
    if (code?.type === "element" && code.tagName === "code") {
      const language = code.properties.className;
      const content = code.children[0];
      if ((!language || (Array.isArray(language) && language.includes("language-json"))) && content?.type === "text") {
        const data = parseStructuredResult(content.value);
        if (data) return <AiJobStructuredResult data={data} source={content.value} />;
      }
    }
    return <pre>{children}</pre>;
  },
  table: ({ children }) => (
    <section
      aria-label="Report table"
      // biome-ignore lint/a11y/noNoninteractiveTabindex: Keyboard users can scroll wide tables.
      tabIndex={0}
      className="max-w-full overflow-x-auto rounded-xl border border-border focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
    >
      <table className="w-full min-w-lg border-collapse text-sm leading-6">{children}</table>
    </section>
  ),
  thead: ({ children }) => <TableHeader className="bg-muted">{children}</TableHeader>,
  tbody: ({ children }) => <TableBody>{children}</TableBody>,
  tr: ({ children }) => <TableRow>{children}</TableRow>,
  th: ({ children, style }) => <TableHead scope="col" className="whitespace-nowrap" style={style}>{children}</TableHead>,
  td: ({ children, style }) => <TableCell className="align-top" style={style}>{children}</TableCell>,
};

const markdownPlugins = [remarkGfm];

export default function AiJobResult({ text }: { text: string }) {
  const data = parseStructuredResult(text);
  return (
    <article
      aria-label="Codex report"
      className="min-w-0 space-y-4 border-t border-border/70 pt-5 text-sm leading-6 wrap-anywhere
        [&_a]:text-primary [&_a]:underline [&_a]:underline-offset-2
        [&_blockquote]:border-l-2 [&_blockquote]:border-border [&_blockquote]:pl-4 [&_blockquote]:text-muted-foreground
        [&_h3]:font-heading [&_h3]:text-xl [&_h3]:leading-tight
        [&_h4]:font-heading [&_h4]:text-base [&_h4]:leading-snug [&_h5]:font-semibold [&_h6]:font-semibold
        [&_li+li]:mt-1 [&_li>ol]:mt-1 [&_li>ul]:mt-1 [&_ol]:list-decimal [&_ol]:pl-5 [&_ul]:list-disc [&_ul]:pl-5
        [&_p]:max-w-[78ch] [&_p]:whitespace-pre-line [&_strong]:font-semibold
        [&_pre]:rounded-lg [&_pre]:bg-muted/60 [&_pre]:p-3.5 [&_pre]:whitespace-pre-wrap
        [&_code]:rounded [&_code]:bg-muted [&_code]:px-1 [&_code]:py-0.5 [&_code]:text-xs
        [&_pre_code]:bg-transparent [&_pre_code]:p-0"
    >
      {data ? (
        <AiJobStructuredResult data={data} source={text} />
      ) : (
        <Markdown skipHtml remarkPlugins={markdownPlugins} components={markdownComponents}>
          {text}
        </Markdown>
      )}
    </article>
  );
}
