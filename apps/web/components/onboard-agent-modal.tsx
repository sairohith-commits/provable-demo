"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Plus, Copy, Check, X } from "lucide-react";

const SLUG_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/;

function snippetFor() {
  return `// 1. src/lib/provable.ts
const API = process.env.PROVABLE_API_URL;
const KEY = process.env.PROVABLE_API_KEY;
const AGENT = process.env.PROVABLE_AGENT_NAME;
const ON = process.env.PROVABLE_ENABLED === 'true' && !!KEY;

export async function registerAgent() {
  if (!ON) return;
  await fetch(\`\${API}/register\`, {
    method: 'POST',
    headers: { 'content-type':'application/json',
               'x-provable-key':KEY, 'x-provable-agent':AGENT },
    body: JSON.stringify({ agent:AGENT, tasks:[] })
  }).catch(() => {});
}

export async function trackDecision(event) {
  if (!ON) return;
  await fetch(\`\${API}/track\`, {
    method: 'POST',
    headers: { 'content-type':'application/json',
               'x-provable-key':KEY, 'x-provable-agent':AGENT },
    body: JSON.stringify(event)
  }).catch(() => {});
}

// 2. instrumentation.ts
export async function register() {
  if (process.env.NEXT_RUNTIME === 'nodejs') {
    const { registerAgent } = await import('./src/lib/provable');
    await registerAgent();
  }
}`;
}

function configFor(apiUrl: string, apiKey: string, agentName: string) {
  return `PROVABLE_ENABLED=true
PROVABLE_API_URL=${apiUrl}
PROVABLE_API_KEY=${apiKey}
PROVABLE_AGENT_NAME=${agentName}`;
}

function CopyBlock({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);

  async function handleCopy() {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // ignore — clipboard may be unavailable
    }
  }

  return (
    <div className="relative">
      <pre className="max-h-64 overflow-auto rounded-md border bg-secondary p-3 pr-12 text-xs leading-relaxed text-secondary-foreground">
        {text}
      </pre>
      <button
        type="button"
        onClick={handleCopy}
        className="absolute right-2 top-2 inline-flex h-7 w-7 items-center justify-center rounded-md border bg-card text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground"
        aria-label="Copy to clipboard"
      >
        {copied ? <Check className="h-3.5 w-3.5 text-solo" /> : <Copy className="h-3.5 w-3.5" />}
      </button>
    </div>
  );
}

export function OnboardAgentModal() {
  const [open, setOpen] = useState(false);
  const [step, setStep] = useState<1 | 2 | 3>(1);
  const [agentName, setAgentName] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [apiKey, setApiKey] = useState<string | null>(null);
  const [apiUrl, setApiUrl] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function reset() {
    setStep(1);
    setAgentName("");
    setDisplayName("");
    setApiKey(null);
    setApiUrl(null);
    setError(null);
  }

  function close() {
    setOpen(false);
    reset();
  }

  const slugValid = SLUG_RE.test(agentName);

  async function goToStep2() {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/org-key");
      const body = await res.json();
      if (!res.ok) throw new Error(body?.error ?? `request failed (${res.status})`);
      setApiKey(body.apiKey);
      setApiUrl(body.apiUrl);
      setStep(2);
    } catch (e: any) {
      setError(e?.message ?? "Could not fetch your API key.");
    } finally {
      setLoading(false);
    }
  }

  return (
    <>
      <Button onClick={() => setOpen(true)}>
        <Plus className="h-4 w-4" />
        Onboard agent
      </Button>

      {open && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
          <div className="w-full max-w-lg rounded-lg border bg-card text-card-foreground shadow-lg">
            <div className="flex items-center justify-between border-b p-4">
              <div>
                <h2 className="text-base font-semibold tracking-tight">
                  {step === 1 && "Onboard agent — name your agent"}
                  {step === 2 && "Onboard agent — connect your agent"}
                  {step === 3 && "Onboard agent — waiting for first connection"}
                </h2>
                <p className="mt-0.5 text-xs text-muted-foreground">Step {step} of 3</p>
              </div>
              <button
                type="button"
                onClick={close}
                className="inline-flex h-8 w-8 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground"
                aria-label="Close"
              >
                <X className="h-4 w-4" />
              </button>
            </div>

            <div className="space-y-4 p-4">
              {step === 1 && (
                <>
                  <div className="space-y-1.5">
                    <label htmlFor="agent-name" className="text-sm font-medium">
                      Agent name
                    </label>
                    <input
                      id="agent-name"
                      value={agentName}
                      onChange={(e) => setAgentName(e.target.value)}
                      placeholder="refund-desk"
                      className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                    />
                    <p className="text-xs text-muted-foreground">Lowercase, hyphens ok — e.g. refund-desk</p>
                  </div>
                  <div className="space-y-1.5">
                    <label htmlFor="display-name" className="text-sm font-medium">
                      Display name
                    </label>
                    <input
                      id="display-name"
                      value={displayName}
                      onChange={(e) => setDisplayName(e.target.value)}
                      placeholder="Refund Desk Agent"
                      className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                    />
                  </div>
                  {error && <p className="text-sm text-danger">{error}</p>}
                  <div className="flex justify-end pt-2">
                    <Button
                      onClick={goToStep2}
                      disabled={!slugValid || !displayName.trim() || loading}
                    >
                      {loading ? "Loading…" : "Next"}
                    </Button>
                  </div>
                </>
              )}

              {step === 2 && apiKey && apiUrl && (
                <>
                  <div className="space-y-1.5">
                    <p className="text-sm font-medium">Config (env vars)</p>
                    <CopyBlock text={configFor(apiUrl, apiKey, agentName)} />
                  </div>
                  <div className="space-y-1.5">
                    <p className="text-sm font-medium">Add to your agent's code</p>
                    <CopyBlock text={snippetFor()} />
                  </div>
                  <div className="flex justify-end pt-2">
                    <Button onClick={() => setStep(3)}>Done</Button>
                  </div>
                </>
              )}

              {step === 3 && (
                <>
                  <p className="text-sm text-muted-foreground">
                    Set the env vars, deploy your agent, and call <code className="rounded bg-secondary px-1 py-0.5 text-xs">registerAgent()</code> on
                    startup. It will appear in the registry automatically.
                  </p>
                  <div className="flex justify-end pt-2">
                    <Button variant="outline" onClick={close}>
                      Close
                    </Button>
                  </div>
                </>
              )}
            </div>
          </div>
        </div>
      )}
    </>
  );
}
