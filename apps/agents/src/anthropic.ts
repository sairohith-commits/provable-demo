import Anthropic from "@anthropic-ai/sdk";
import "./env.js"; // ensures dotenv has loaded ANTHROPIC_API_KEY before client init

// The SDK reads ANTHROPIC_API_KEY from the environment — never hardcoded.
export const anthropic = new Anthropic();

export interface ModelCall {
  text: string;
  inputTokens: number;
  outputTokens: number;
  latencyMs: number;
}

export async function callModel(opts: {
  model: string;
  system: string;
  user: string;
  maxTokens?: number;
  temperature?: number;
  disableThinking?: boolean;
}): Promise<ModelCall> {
  const start = Date.now();
  const body: Record<string, unknown> = {
    model: opts.model,
    max_tokens: opts.maxTokens ?? 600,
    system: opts.system,
    messages: [{ role: "user", content: opts.user }],
  };
  if (opts.temperature !== undefined) body.temperature = opts.temperature;
  if (opts.disableThinking) body.thinking = { type: "disabled" };

  const res = await anthropic.messages.create(body as any);
  const latencyMs = Date.now() - start;
  const text = (res.content as any[])
    .filter((b) => b.type === "text")
    .map((b) => b.text)
    .join("")
    .trim();

  return {
    text,
    inputTokens: res.usage.input_tokens,
    outputTokens: res.usage.output_tokens,
    latencyMs,
  };
}

// Defensive JSON extraction: strips code fences and isolates the first object.
export function extractJson<T = any>(text: string): T {
  let t = text.trim();
  const fence = t.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) t = fence[1].trim();
  const s = t.indexOf("{");
  const e = t.lastIndexOf("}");
  if (s >= 0 && e > s) t = t.slice(s, e + 1);
  return JSON.parse(t) as T;
}
