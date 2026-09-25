import { useRef, useState } from "react";
import { Copy, KeyRound, TriangleAlert } from "lucide-react";
import type { GscStatus } from "../../../api";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle, Button, Select, SelectContent, SelectItem, SelectTrigger, SelectValue, toast } from "@/components/ui";
import { Field, ReportSection, StatusEvidenceTable, type StatusEvidenceRow } from "../../shared";

export function gscConnectionState(status: GscStatus | null, importCount: number) {
  if (status?.needsReconnect) return { label: "Reconnect needed", tone: "warn" as const };
  if (status?.connected) return { label: "Connected", tone: "good" as const };
  if (importCount) return { label: "Local imports", tone: "good" as const };
  if (status?.configured) return { label: "Ready to connect", tone: "warn" as const };
  return { label: "OAuth missing", tone: "outline" as const };
}

/** A live Google property this app can query right now. */
export function gscLiveProperty(status: GscStatus | null) {
  return status?.connected && !status.needsReconnect ? status.connection?.siteUrl || "" : "";
}

function RedirectUriBlock({ uri }: { uri: string }) {
  const codeRef = useRef<HTMLElement>(null);
  function selectText() {
    const element = codeRef.current;
    const selection = window.getSelection();
    if (!element || !selection) return;
    selection.selectAllChildren(element);
  }
  async function copy() {
    try {
      if (!navigator.clipboard) throw new Error("Clipboard unavailable");
      await navigator.clipboard.writeText(uri);
      toast.success("Redirect URI copied.");
    } catch {
      selectText();
      toast.info("Copy is blocked here. The URI is selected; press ⌘C or Ctrl+C.");
    }
  }
  return (
    <div className="space-y-2 rounded-xl bg-muted/40 p-4">
      <div className="text-sm font-medium">Authorized redirect URI</div>
      <p className="text-xs leading-5 text-muted-foreground">
        Add this exact URI to your OAuth client in Google Cloud Console (APIs &amp; Services → Credentials → your OAuth client → Authorized redirect URIs). Google rejects the sign-in if it differs by even a trailing slash.
      </p>
      <div className="flex flex-wrap items-center gap-2">
        <code ref={codeRef} className="min-w-0 flex-1 select-all break-all rounded-md bg-secondary px-3 py-2 font-mono text-[13px]">
          {uri || "Unavailable from the local API"}
        </code>
        <Button type="button" size="sm" variant="outline" onClick={copy} disabled={!uri}>
          <Copy /> Copy
        </Button>
      </div>
    </div>
  );
}

export function GscConnectionPanel({
  status,
  redirectUri,
  properties,
  loading,
  onConnect,
  onLoadProperties,
  onSelectProperty,
  onDisconnect,
}: {
  status: GscStatus | null;
  redirectUri: string;
  properties: any[];
  loading: string;
  onConnect: () => void;
  onLoadProperties: () => void;
  onSelectProperty: (siteUrl: string) => void;
  onDisconnect: () => Promise<void>;
}) {
  const [confirmDisconnect, setConfirmDisconnect] = useState(false);
  const needsReconnect = Boolean(status?.needsReconnect);
  const connected = Boolean(status?.connected) && !needsReconnect;
  const accountRow: StatusEvidenceRow = needsReconnect
    ? {
        title: "Google account",
        status: "Reconnect needed",
        tone: "warn",
        text: status?.authError || "Google no longer accepts the saved sign-in. Reconnect to query live data again.",
      }
    : {
        title: "Google account",
        status: connected ? "Connected" : "Not connected",
        tone: connected ? "good" : "warn",
        text:
          status?.connection?.accountEmail ||
          (status?.configured ? "Connect once, then choose the matching property." : "OAuth is not configured in this local runtime; local CSV import still works."),
      };
  return (
    <ReportSection
      title="Google connection"
      description="Connect once for live performance queries, syncs, and URL inspection. Local CSV import works without Google."
    >
      <div className="space-y-4">
        {needsReconnect ? (
          <div role="alert" className="flex flex-wrap items-start justify-between gap-3 rounded-xl border border-warn/30 bg-warn-soft px-4 py-3">
            <div className="flex min-w-0 items-start gap-2">
              <TriangleAlert aria-hidden className="mt-0.5 size-4 shrink-0 text-warn" />
              <div className="min-w-0 text-sm">
                <div className="font-medium">Google needs you to sign in again</div>
                <p className="mt-0.5 break-words text-[13px] text-muted-foreground">
                  {status?.authError || "The saved grant was revoked, expired, or is missing a refresh token."} Saved imports and syncs stay available.
                </p>
              </div>
            </div>
            <Button size="sm" onClick={onConnect} disabled={!status?.configured}>
              <KeyRound /> Reconnect Google
            </Button>
          </div>
        ) : null}
        <StatusEvidenceTable
          rows={[
            accountRow,
            {
              title: "OAuth client",
              status: status?.configured ? "Configured" : "Missing",
              tone: status?.configured ? "good" : "outline",
              text: status?.configured
                ? "Google client id and secret are set for this local runtime."
                : "Set the Google OAuth client id and secret in the local environment to enable the connection.",
            },
            {
              title: "Selected property",
              status: status?.connection?.siteUrl ? "Selected" : "None",
              tone: status?.connection?.siteUrl ? "good" : "warn",
              text: status?.connection?.siteUrl || "Load properties and pick the property for this site.",
            },
          ]}
        />
        <div className="flex flex-wrap gap-3">
          <Button onClick={onConnect} disabled={!status?.configured}>
            <KeyRound /> {needsReconnect ? "Reconnect Google" : connected ? "Connect again" : "Connect Google"}
          </Button>
          <Button variant="secondary" onClick={onLoadProperties} disabled={!connected || loading === "sites"}>
            {loading === "sites" ? "Loading" : "Load properties"}
          </Button>
          <Button variant="outline" onClick={() => setConfirmDisconnect(true)} disabled={!status?.connection || loading === "disconnect"}>
            Disconnect
          </Button>
        </div>
        {properties.length > 0 ? (
          <Field label="Property">
            <Select value={status?.connection?.siteUrl || ""} onValueChange={onSelectProperty}>
              <SelectTrigger>
                <SelectValue placeholder="Choose property" />
              </SelectTrigger>
              <SelectContent>
                {properties.map((property) => (
                  <SelectItem key={property.siteUrl} value={property.siteUrl}>
                    {property.siteUrl}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>
        ) : null}
        <RedirectUriBlock uri={redirectUri} />
      </div>
      <AlertDialog open={confirmDisconnect} onOpenChange={(open) => loading !== "disconnect" && setConfirmDisconnect(open)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Disconnect Google Search Console?</AlertDialogTitle>
            <AlertDialogDescription>
              The saved Google sign-in and selected property for this site are removed from local SQLite. Imported CSVs and synced rows stay saved.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={loading === "disconnect"}>Keep connection</AlertDialogCancel>
            <AlertDialogAction
              type="button"
              disabled={loading === "disconnect"}
              onClick={() => onDisconnect().finally(() => setConfirmDisconnect(false))}
            >
              {loading === "disconnect" ? "Disconnecting" : "Disconnect"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </ReportSection>
  );
}
