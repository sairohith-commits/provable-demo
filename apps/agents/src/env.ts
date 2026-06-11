import { config } from "dotenv";
import { resolve } from "node:path";

// Load the single root .env (shared with packages/db and apps/api).
config({ path: resolve(process.cwd(), "../../.env") });

function need(key: string): string {
  const v = process.env[key];
  if (!v || !v.trim()) {
    throw new Error(`Missing ${key} in root .env — add it before running agents.`);
  }
  return v.trim();
}

// Presence-checked at import time; never logged.
export const ANTHROPIC_API_KEY = need("ANTHROPIC_API_KEY");
export const AGENT_MODEL = process.env.AGENT_MODEL?.trim() || "claude-haiku-4-5";
export const REVIEWER_MODEL = process.env.REVIEWER_MODEL?.trim() || "claude-sonnet-4-6";
export const API_URL = process.env.API_URL?.trim() || `http://localhost:${process.env.API_PORT ?? 4000}`;
