// @provable/sdk — the one-call client a customer integrates with.
//
//   const provable = new Provable({
//     apiUrl: process.env.PROVABLE_API_URL!,
//     apiKey: process.env.PROVABLE_API_KEY!,   // org key
//     agent:  "Support Triage Agent",          // this agent's identity
//   });
//   await provable.register({ purpose, tasks: [{ key, name, riskLevel }] });
//   await provable.track({ task: "set_priority", outcome: "success", ... });
//
// The SDK attaches `x-provable-key` and `x-provable-agent` automatically.
// Agents and tasks are addressed by name/key — never internal IDs.

export interface ProvableOptions {
  apiUrl: string;
  apiKey?: string;
  agent?: string;
}

export type TrackOutcome = "success" | "failure" | "partial" | "SUCCESS" | "FAILURE" | "PARTIAL";

export interface TaskDef {
  key: string;
  name: string;
  riskLevel?: "low" | "medium" | "high" | string;
}

export interface RegisterInput {
  purpose?: string;
  tasks: TaskDef[];
}

export interface TrackInput {
  /** Task key (customer-facing path). */
  task?: string;
  outcome: TrackOutcome;
  confidence?: number;
  wasOverridden?: boolean;
  wasEscalated?: boolean;
  latencyMs?: number;
  tokens?: number;
  metadata?: Record<string, unknown>;
  /** Legacy by-id path (internal demos only). */
  agentId?: string;
  taskId?: string;
}

export interface TrackResult {
  ok: boolean;
  eventId: string;
  queued: boolean;
  /** Set by Provable's cost governor when this event tripped the runaway-token threshold. */
  capped?: boolean;
  /** The token cap the agent should enforce on subsequent calls. */
  capTokens?: number;
}

export interface RegisterResult {
  ok: boolean;
  agent: string;
  tasks: number;
}

export class Provable {
  private apiUrl: string;
  private apiKey?: string;
  private agent?: string;

  constructor(opts: ProvableOptions) {
    this.apiUrl = opts.apiUrl.replace(/\/$/, "");
    this.apiKey = opts.apiKey;
    this.agent = opts.agent;
  }

  private headers(): Record<string, string> {
    return {
      "content-type": "application/json",
      ...(this.apiKey ? { "x-provable-key": this.apiKey } : {}),
      ...(this.agent ? { "x-provable-agent": this.agent } : {}),
    };
  }

  /** Idempotent self-enrollment. Safe to call on every startup. */
  async register(input: RegisterInput): Promise<RegisterResult> {
    if (!this.agent) throw new Error("Provable.register() requires `agent` in the constructor options.");
    const res = await fetch(`${this.apiUrl}/register`, {
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify({ agent: this.agent, purpose: input.purpose, tasks: input.tasks }),
    });
    if (!res.ok) throw new Error(`Provable.register failed: ${res.status} ${await res.text()}`);
    return (await res.json()) as RegisterResult;
  }

  /** Track one decision. Use `task` (a key) for the customer path. */
  async track(input: TrackInput): Promise<TrackResult> {
    const res = await fetch(`${this.apiUrl}/track`, {
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify(input),
    });
    if (!res.ok) throw new Error(`Provable.track failed: ${res.status} ${await res.text()}`);
    return (await res.json()) as TrackResult;
  }
}
