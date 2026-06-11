import { prisma } from "@provable/db";
import { costForUsage } from "./pricing.js";
import { ensureAgent } from "./org.js";

export interface CaptureContext {
  orgId: string;
  agentName: string | null;
  requestModel: string | null;
  startedAt: number;
  isStream: boolean;
  status: number;
}

interface Usage {
  model: string | null;
  inputTokens: number;
  outputTokens: number;
}

// Best-effort: read the (tee'd) response body, extract usage, and write a
// GatewayCall row + auto-register the agent. Never throws into the caller —
// the proxied response has already been sent regardless of what happens here.
export async function captureFromStream(body: ReadableStream<Uint8Array>, ctx: CaptureContext): Promise<void> {
  try {
    const text = await streamToText(body);
    const usage = ctx.isStream ? parseStreamingUsage(text) : parseJsonUsage(text);
    if (!usage) return;

    const model = usage.model ?? ctx.requestModel ?? "unknown";
    const latencyMs = Date.now() - ctx.startedAt;
    const costUsd = costForUsage(model, usage.inputTokens, usage.outputTokens);

    let agentId: string | null = null;
    if (ctx.agentName) {
      const agent = await ensureAgent(ctx.orgId, ctx.agentName);
      agentId = agent.id;
    }

    await prisma.gatewayCall.create({
      data: {
        orgId: ctx.orgId,
        agentId,
        model,
        inputTokens: usage.inputTokens,
        outputTokens: usage.outputTokens,
        costUsd,
        latencyMs,
      },
    });
  } catch {
    // Telemetry capture is best-effort — never let it surface to the agent.
  }
}

async function streamToText(body: ReadableStream<Uint8Array>): Promise<string> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let out = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    out += decoder.decode(value, { stream: true });
  }
  out += decoder.decode();
  return out;
}

// Non-streaming response: a single JSON object with a top-level `usage`.
function parseJsonUsage(text: string): Usage | null {
  try {
    const json = JSON.parse(text);
    const usage = json?.usage;
    if (!usage) return null;
    return {
      model: typeof json?.model === "string" ? json.model : null,
      inputTokens: Number(usage.input_tokens ?? 0),
      outputTokens: Number(usage.output_tokens ?? 0),
    };
  } catch {
    return null;
  }
}

// SSE stream: input_tokens comes from `message_start`, output_tokens (final,
// cumulative) comes from the last `message_delta` before `message_stop`.
function parseStreamingUsage(text: string): Usage | null {
  let model: string | null = null;
  let inputTokens = 0;
  let outputTokens = 0;
  let found = false;

  for (const block of text.split("\n\n")) {
    const dataLine = block.split("\n").find((l) => l.startsWith("data:"));
    if (!dataLine) continue;
    let payload: any;
    try {
      payload = JSON.parse(dataLine.slice(5).trim());
    } catch {
      continue;
    }

    if (payload.type === "message_start") {
      model = payload.message?.model ?? model;
      inputTokens = Number(payload.message?.usage?.input_tokens ?? inputTokens);
      outputTokens = Number(payload.message?.usage?.output_tokens ?? outputTokens);
      found = true;
    } else if (payload.type === "message_delta") {
      outputTokens = Number(payload.usage?.output_tokens ?? outputTokens);
      found = true;
    }
  }

  return found ? { model, inputTokens, outputTokens } : null;
}
