import { randomBytes, createHash } from "node:crypto";

// Canonical key module — single home for generation + hashing so the API,
// the gateway, the seed, and any tooling all agree. apps/api/src/lib/apiKey.ts
// re-exports these so its documented import path stays valid; the gateway and
// the seed import them straight from "@provable/db" (no app-to-app dependency).

const PREFIX = "pk_live_";

/** Returns the full key (show once) plus the values to persist. */
export function generateApiKey() {
  const secret = randomBytes(24).toString("base64url"); // 192 bits, URL-safe
  const fullKey = `${PREFIX}${secret}`;
  return {
    fullKey, // return to user ONCE, never store
    apiKeyHash: hashApiKey(fullKey), // store this
    apiKeyPrefix: fullKey.slice(0, PREFIX.length + 8), // store this, for display
  };
}

export function hashApiKey(key: string): string {
  return createHash("sha256").update(key).digest("hex");
}
