import { Prisma } from "@prisma/client";
import { prisma } from "./client.js";
import { generateApiKey } from "./apiKey.js";
import type { Org } from "@prisma/client";

// Control-plane org provisioning + key rotation (D4/D5/D6).
//
// These are infrequent, trusted writes owned by the web/onboarding tier. They
// use the base (unguarded) client because they operate on the Org row itself by
// already-resolved id / clerkOrgId — Org is not a tenant-scoped model.
//
// Show-once contract: the plaintext key is returned EXACTLY ONCE (on create or
// on rotate). Only apiKeyHash + apiKeyPrefix are persisted; the plaintext is
// never stored and never retrievable again. NEVER log the returned plaintextKey.

export interface ProvisionResult {
  org: Org;
  /** The full key, returned once on CREATE; null when the org already existed. */
  plaintextKey: string | null;
}

/**
 * Idempotent upsert keyed on `clerkOrgId`.
 * - CREATE  → generates a key, stores hash+prefix, returns { org, plaintextKey }.
 * - EXISTING→ returns { org, plaintextKey: null } (never regenerate, never re-expose).
 * Concurrent first-requests are race-safe: the loser of the unique-constraint
 * race resolves to the existing row with a null plaintext (last-write is a no-op).
 */
export async function provisionOrg({ clerkOrgId, name }: { clerkOrgId: string; name: string }): Promise<ProvisionResult> {
  // Fast path: already linked → never regenerate, never re-show a key.
  const existing = await prisma.org.findUnique({ where: { clerkOrgId } });
  if (existing) return { org: existing, plaintextKey: null };

  const { fullKey, apiKeyHash, apiKeyPrefix } = generateApiKey();
  try {
    const org = await prisma.org.create({
      data: { name, clerkOrgId, apiKeyHash, apiKeyPrefix },
    });
    return { org, plaintextKey: fullKey };
  } catch (e) {
    // A concurrent provision created the row first → return it, with no key.
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002") {
      const org = await prisma.org.findUniqueOrThrow({ where: { clerkOrgId } });
      return { org, plaintextKey: null };
    }
    throw e;
  }
}

/**
 * Rotate an org's API key. Generates a new key, replaces hash+prefix, stamps
 * apiKeyRotatedAt, and returns the plaintext ONCE. The previous key dies
 * immediately because its hash no longer matches any row.
 */
export async function rotateKey({ orgId }: { orgId: string }): Promise<{ org: Org; plaintextKey: string }> {
  const { fullKey, apiKeyHash, apiKeyPrefix } = generateApiKey();
  const org = await prisma.org.update({
    where: { id: orgId },
    data: { apiKeyHash, apiKeyPrefix, apiKeyRotatedAt: new Date() },
  });
  return { org, plaintextKey: fullKey };
}
