"use server";

import { auth, clerkClient } from "@clerk/nextjs/server";
import { provisionOrg } from "@provable/db";

// THE authoritative provisioner (C4 show-once). Reads the org id ONLY from the
// Clerk-verified session (never client input), runs provisionOrg, and returns
// the plaintext key — which provisionOrg yields exactly ONCE on create and null
// for an already-provisioned org. Nothing else (getActiveOrg, layout) provisions
// ahead of this, so the plaintext is never silently discarded.

export type IssueKeyResult =
  | { ok: true; plaintextKey: string | null; apiKeyPrefix: string; apiUrl: string }
  | { ok: false; error: string };

export async function provisionAndIssueKey(): Promise<IssueKeyResult> {
  const { userId, orgId } = await auth({ treatPendingAsSignedOut: false });
  if (!userId) return { ok: false, error: "not signed in" };
  if (!orgId) return { ok: false, error: "no active organization on the session" };

  // Authoritative org name from Clerk (used only on first provision).
  const client = await clerkClient();
  const clerkOrg = await client.organizations.getOrganization({ organizationId: orgId });

  const { org, plaintextKey } = await provisionOrg({ clerkOrgId: orgId, name: clerkOrg.name });

  return {
    ok: true,
    plaintextKey, // string on CREATE (show once), null if already provisioned
    apiKeyPrefix: org.apiKeyPrefix,
    apiUrl: process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:4000",
  };
}
