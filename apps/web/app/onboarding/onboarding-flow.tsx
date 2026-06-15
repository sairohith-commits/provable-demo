"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { useOrganizationList } from "@clerk/nextjs";
import { Check, Copy, KeyRound, ShieldAlert } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

import { provisionAndIssueKey } from "./actions";

// initialState is the server's assessment at first load. It is acted on EXACTLY
// once (startedRef) so a router.refresh — which Clerk fires after setActive — can
// re-render this component with a changed prop WITHOUT restarting or interrupting
// the flow. Provisioning runs at most once (issuedRef): that is what protects the
// show-once plaintext from being clobbered by a second provisionOrg (→ null).
type InitialState = "needs-onboarding" | "unprovisioned" | "active";

type Issued = { plaintextKey: string | null; apiKeyPrefix: string; apiUrl: string };

function CopyButton({ text, label }: { text: string; label: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <Button
      type="button"
      variant="outline"
      size="sm"
      aria-label={label}
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(text);
          setCopied(true);
          setTimeout(() => setCopied(false), 1500);
        } catch {
          /* clipboard may be unavailable */
        }
      }}
    >
      {copied ? <Check className="h-4 w-4 text-solo" /> : <Copy className="h-4 w-4" />}
      {copied ? "Copied" : "Copy"}
    </Button>
  );
}

function CodeBlock({ text }: { text: string }) {
  return (
    <pre className="max-h-64 overflow-auto rounded-md border bg-secondary p-3 text-xs leading-relaxed text-secondary-foreground">
      {text}
    </pre>
  );
}

export function OnboardingFlow({ initialState }: { initialState: InitialState }) {
  const router = useRouter();
  const { isLoaded, createOrganization, setActive } = useOrganizationList();

  const [screen, setScreen] = useState<1 | 2 | 3>(1);
  const [orgName, setOrgName] = useState("");
  const [busy, setBusy] = useState(initialState !== "needs-onboarding"); // unprovisioned/active boot into a loading state
  const [error, setError] = useState<string | null>(null);
  const [issued, setIssued] = useState<Issued | null>(null);

  const issuedRef = useRef(false); // provision/issue at most once
  const startedRef = useRef(false); // act on initialState at most once

  const issueKey = useCallback(async () => {
    if (issuedRef.current) return; // never re-issue (would clobber the show-once key with null)
    issuedRef.current = true;
    setBusy(true);
    setError(null);
    const res = await provisionAndIssueKey();
    if (!res.ok) {
      issuedRef.current = false;
      setError(res.error);
      setBusy(false);
      return;
    }
    setIssued({ plaintextKey: res.plaintextKey, apiKeyPrefix: res.apiKeyPrefix, apiUrl: res.apiUrl });
    setScreen(2);
    setBusy(false);
  }, []);

  // Entry decision — runs once, ignores later prop changes.
  useEffect(() => {
    if (startedRef.current) return;
    startedRef.current = true;
    if (initialState === "unprovisioned") {
      void issueKey(); // active Clerk org, no Provable org yet → provision + show key
    } else if (initialState === "active") {
      router.replace("/"); // already onboarded → dashboard (never re-show the key)
    }
    // needs-onboarding → wait for the user on screen 1
  }, [initialState, issueKey, router]);

  async function createWorkspace() {
    if (!isLoaded || !createOrganization || !setActive) return;
    setBusy(true);
    setError(null);
    try {
      const org = await createOrganization({ name: orgName.trim() });
      await setActive({ organization: org.id }); // session now carries orgId
      await issueKey(); // sole provisioner reads auth().orgId server-side
    } catch (e: any) {
      setError(
        e?.errors?.[0]?.longMessage ?? e?.errors?.[0]?.message ?? e?.message ?? "Could not create workspace.",
      );
      setBusy(false);
    }
  }

  return (
    <div className="mx-auto flex max-w-xl flex-col gap-6 py-10">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold tracking-tight">Set up Provable</h1>
        <span className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Step {screen} of 3</span>
      </div>

      {/* ── Screen 1 — Workspace ───────────────────────────────────────────── */}
      {screen === 1 &&
        (initialState === "needs-onboarding" ? (
          <Card>
            <CardHeader>
              <CardTitle>Name your workspace</CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              <p className="text-sm text-muted-foreground">
                Your workspace is your organization in Provable — agents, tasks, and scores all live under it.
              </p>
              <div className="space-y-1.5">
                <label htmlFor="workspace-name" className="text-sm font-medium">
                  Workspace name
                </label>
                <input
                  id="workspace-name"
                  aria-label="Workspace name"
                  value={orgName}
                  onChange={(e) => setOrgName(e.target.value)}
                  placeholder="Acme Inc"
                  className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                />
              </div>
              {error && <p className="text-sm text-danger">{error}</p>}
              <div className="flex justify-end">
                <Button onClick={createWorkspace} disabled={!isLoaded || busy || !orgName.trim()}>
                  {busy ? "Creating…" : "Create workspace"}
                </Button>
              </div>
            </CardContent>
          </Card>
        ) : (
          <Card>
            <CardContent className="py-10 text-center text-sm text-muted-foreground">
              {error ? <span className="text-danger">{error}</span> : "One moment…"}
            </CardContent>
          </Card>
        ))}

      {/* ── Screen 2 — API key (show once) ─────────────────────────────────── */}
      {screen === 2 && issued && (
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <KeyRound className="h-5 w-5" /> Your API key
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            {issued.plaintextKey ? (
              <>
                <div className="flex items-start gap-2 rounded-md border border-danger/40 bg-danger/5 p-3 text-sm">
                  <ShieldAlert className="mt-0.5 h-4 w-4 shrink-0 text-danger" />
                  <p>
                    <span className="font-semibold">Copy this key now — we can’t show it again.</span> Store it in your
                    secret manager. If you lose it, rotate it from Settings to get a new one.
                  </p>
                </div>
                <div className="flex items-center gap-2">
                  <code
                    data-testid="api-key"
                    className="flex-1 overflow-x-auto rounded-md border bg-secondary px-3 py-2 font-mono text-sm text-secondary-foreground"
                  >
                    {issued.plaintextKey}
                  </code>
                  <CopyButton text={issued.plaintextKey} label="Copy API key" />
                </div>
                <div className="space-y-1.5">
                  <p className="text-sm font-medium">Add to your agent’s environment</p>
                  <CodeBlock text={`PROVABLE_API_URL=${issued.apiUrl}\nPROVABLE_API_KEY=${issued.plaintextKey}`} />
                </div>
              </>
            ) : (
              <p className="text-sm text-muted-foreground">
                This workspace already has an API key. For security we can’t show it again — rotate it from Settings to
                issue a new one.
              </p>
            )}
            <div className="flex justify-end">
              <Button onClick={() => setScreen(3)}>Continue</Button>
            </div>
          </CardContent>
        </Card>
      )}

      {/* ── Screen 3 — Connect first agent ─────────────────────────────────── */}
      {screen === 3 && (
        <Card>
          <CardHeader>
            <CardTitle>Connect your first agent</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <p className="text-sm text-muted-foreground">
              Report a decision from your agent with <code className="rounded bg-secondary px-1 py-0.5">track()</code>.
              It’ll show up in your registry automatically.
            </p>
            <CodeBlock
              text={`import { Provable } from "@provable/sdk";

const provable = new Provable({
  apiKey: process.env.PROVABLE_API_KEY,
});

await provable.track({
  agent: "refund-desk",
  task: "approve_refund",
  outcome: "success",
  confidence: 0.92,
});`}
            />
            <div className="flex justify-end">
              <Button onClick={() => router.push("/")}>Go to dashboard</Button>
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
