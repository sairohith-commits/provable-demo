# @provable/sdk

Enroll an agent and track its decisions for task-level readiness scoring.

```ts
import { Provable } from "@provable/sdk";

const provable = new Provable({
  apiUrl: process.env.PROVABLE_API_URL!,
  apiKey: process.env.PROVABLE_API_KEY!, // your org key
  agent: "Support Triage Agent",
});

// once on startup — idempotent
await provable.register({
  purpose: "Triages inbound support tickets",
  tasks: [
    { key: "set_priority", name: "Set priority", riskLevel: "medium" },
  ],
});

// per decision
await provable.track({
  task: "set_priority",
  outcome: "success",
  confidence: 0.82,
  wasOverridden: false,
  wasEscalated: false,
  tokens: 1180,
  latencyMs: 240,
  metadata: { ticketId: "T-1024" },
});
```

Agents and tasks are addressed by **name** and **key** — never internal IDs. The SDK
attaches `x-provable-key` and `x-provable-agent` to every request automatically.
