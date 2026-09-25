import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { Bot, LoaderCircle } from "lucide-react";
import { api, isNotFoundError } from "../../../api";
import { Button, toast } from "@/components/ui";

const PRIORITISE_TYPE = "scan.prioritize";

// Sends this scan's saved report context to a local Codex job that ranks the
// fixes, then opens the AI lab on that job. The context comes from the scan
// report itself; nothing is summarised or invented in the browser. The backend
// fills the saved scan.prioritize template with it, so no text in the context
// (a "$&" in a URL, say) is ever read as a replacement pattern.
export function PrioritiseWithCodexButton({ scan }: { scan: any }) {
  const navigate = useNavigate();
  const [busy, setBusy] = useState(false);
  if (scan?.status !== "completed") return null;

  async function start() {
    setBusy(true);
    try {
      let context: string;
      try {
        context = String((await api.scanAiContext(scan.id))?.text || "").trim();
      } catch (err) {
        if (isNotFoundError(err)) {
          toast.error("The scan report context endpoint is unavailable in this local API, so Codex cannot be given the evidence.");
          return;
        }
        throw err;
      }
      if (!context) {
        toast.error("This scan has no report context to send to Codex.");
        return;
      }
      const job = await api.createAiJob({
        type: PRIORITISE_TYPE,
        context,
        siteId: scan.site_id || undefined,
        scanId: scan.id,
      });
      toast.success("Codex job queued. Opening the AI lab.");
      navigate(job?.id ? `/ai?job=${encodeURIComponent(job.id)}` : "/ai");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not start the Codex job. Is the local Codex CLI available?");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Button size="sm" variant="secondary" onClick={start} disabled={busy} aria-busy={busy}>
      {busy ? <LoaderCircle className="animate-spin motion-reduce:animate-none" /> : <Bot />}
      {busy ? "Queuing Codex job" : "Prioritise with Codex"}
    </Button>
  );
}
