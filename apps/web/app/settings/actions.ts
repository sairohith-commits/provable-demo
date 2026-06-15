"use server";

import { getActiveOrg } from "@/lib/getActiveOrg";
import { rotateKey } from "@provable/db";

// Rotate the active org's API key. The target org is resolved from the
// Clerk-verified session via getActiveOrg() — NEVER from client input (D4). The
// new plaintext is returned exactly once (rotateKey); the old key dies instantly
// because its hash no longer matches the row. Never log plaintextKey.

export type RotateResult =
  | { ok: true; plaintextKey: string; apiKeyPrefix: string }
  | { ok: false; error: string };

export async function rotateApiKey(): Promise<RotateResult> {
  const active = await getActiveOrg();
  if (active.status !== "active") {
    return { ok: false, error: "no active organization" };
  }

  const { org, plaintextKey } = await rotateKey({ orgId: active.org.id });
  return { ok: true, plaintextKey, apiKeyPrefix: org.apiKeyPrefix };
}
