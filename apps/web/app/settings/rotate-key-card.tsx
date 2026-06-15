"use client";

import { useState } from "react";
import { Check, Copy, KeyRound, ShieldAlert, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

import { rotateApiKey } from "./actions";

// Reuses the C4 show-once pattern: the new plaintext key lives ONLY in client
// state (set from the server action result), is shown once in a modal, and is
// never persisted or re-fetched — a reload shows only the (new) prefix.
export function RotateKeyCard({ initialPrefix }: { initialPrefix: string }) {
  const [prefix, setPrefix] = useState(initialPrefix);
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [newKey, setNewKey] = useState<string | null>(null); // show-once, modal only
  const [copied, setCopied] = useState(false);

  async function rotate() {
    setBusy(true);
    setError(null);
    const res = await rotateApiKey();
    if (!res.ok) {
      setError(res.error);
      setBusy(false);
      return;
    }
    setNewKey(res.plaintextKey); // reveal once
    setPrefix(res.apiKeyPrefix); // update the displayed prefix immediately
    setConfirming(false);
    setBusy(false);
  }

  async function copyKey() {
    if (!newKey) return;
    try {
      await navigator.clipboard.writeText(newKey);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* clipboard may be unavailable */
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <KeyRound className="h-5 w-5" /> API key
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="space-y-1">
          <p className="text-sm font-medium">Key prefix</p>
          <code
            data-testid="key-prefix"
            className="inline-block rounded-md border bg-secondary px-3 py-1.5 font-mono text-sm text-secondary-foreground"
          >
            {prefix}…
          </code>
          <p className="text-xs text-muted-foreground">
            For identification only — the full key is shown once at creation or rotation and can’t be retrieved again.
          </p>
        </div>

        {!confirming ? (
          <Button variant="outline" onClick={() => setConfirming(true)}>
            Rotate key
          </Button>
        ) : (
          <div className="space-y-3 rounded-md border border-danger/40 bg-danger/5 p-3">
            <div className="flex items-start gap-2 text-sm">
              <ShieldAlert className="mt-0.5 h-4 w-4 shrink-0 text-danger" />
              <p>
                <span className="font-semibold">Rotating invalidates the current key immediately.</span> Any agent or
                integration still using it will start failing until you update it with the new key.
              </p>
            </div>
            <div className="flex gap-2">
              <Button
                onClick={rotate}
                disabled={busy}
                className="bg-danger text-white hover:bg-danger/90"
              >
                {busy ? "Rotating…" : "Yes, rotate now"}
              </Button>
              <Button variant="outline" onClick={() => setConfirming(false)} disabled={busy}>
                Cancel
              </Button>
            </div>
          </div>
        )}

        {error && <p className="text-sm text-danger">{error}</p>}
      </CardContent>

      {/* ── Show-once modal ──────────────────────────────────────────────── */}
      {newKey && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
          <div className="w-full max-w-lg rounded-lg border bg-card text-card-foreground shadow-lg">
            <div className="flex items-center justify-between border-b p-4">
              <h2 className="flex items-center gap-2 text-base font-semibold tracking-tight">
                <KeyRound className="h-4 w-4" /> Your new API key
              </h2>
              <button
                type="button"
                onClick={() => setNewKey(null)}
                aria-label="Close"
                className="inline-flex h-8 w-8 items-center justify-center rounded-md text-muted-foreground hover:bg-secondary hover:text-foreground"
              >
                <X className="h-4 w-4" />
              </button>
            </div>
            <div className="space-y-4 p-4">
              <div className="flex items-start gap-2 rounded-md border border-danger/40 bg-danger/5 p-3 text-sm">
                <ShieldAlert className="mt-0.5 h-4 w-4 shrink-0 text-danger" />
                <p>
                  <span className="font-semibold">Copy this key now — we can’t show it again.</span> Your previous key
                  is already invalid. Existing integrations will break until you update them with this new key.
                </p>
              </div>
              <div className="flex items-center gap-2">
                <code
                  data-testid="api-key"
                  className="flex-1 overflow-x-auto rounded-md border bg-secondary px-3 py-2 font-mono text-sm text-secondary-foreground"
                >
                  {newKey}
                </code>
                <Button type="button" variant="outline" size="sm" aria-label="Copy API key" onClick={copyKey}>
                  {copied ? <Check className="h-4 w-4 text-solo" /> : <Copy className="h-4 w-4" />}
                  {copied ? "Copied" : "Copy"}
                </Button>
              </div>
              <div className="flex justify-end">
                <Button onClick={() => setNewKey(null)}>Done</Button>
              </div>
            </div>
          </div>
        </div>
      )}
    </Card>
  );
}
