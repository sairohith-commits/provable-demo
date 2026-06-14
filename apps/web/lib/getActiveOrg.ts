import "server-only";
import { auth, clerkClient } from "@clerk/nextjs/server";
import { prisma, provisionOrg, type Org } from "@provable/db";

// Server-only. Resolves the Provable Org for the signed-in user's ACTIVE Clerk
// organization, JIT-provisioning it on first sight (idempotent upsert on
// clerkOrgId — D2/D5). The Clerk org id is read EXCLUSIVELY from the verified
// session via auth(); it is never taken from client input, a header, or a query
// param (defense-in-depth re: CVE-2025-29927 — the data layer is the trust
// boundary, not middleware).

export type ActiveOrgResult =
  | { status: "signed-out" } // no Clerk session
  | { status: "needs-onboarding" } // signed in, but no active org yet
  | { status: "active"; org: Org };

export async function getActiveOrg(): Promise<ActiveOrgResult> {
  // treatPendingAsSignedOut: false — in "Membership required" mode a user with no
  // organization has a PENDING session (an unfinished "create/select org" task).
  // Clerk treats pending sessions as signed-out by default, which would hide an
  // org-less-but-authenticated user. We need to see them so we can route them to
  // onboarding, so we opt in: userId is present, orgId is null → needs-onboarding.
  const { userId, orgId } = await auth({ treatPendingAsSignedOut: false });
  if (!userId) return { status: "signed-out" };
  if (!orgId) return { status: "needs-onboarding" };

  // Fast path: the Provable Org already exists for this Clerk org — no Clerk API
  // call, no key regeneration.
  const existing = await prisma.org.findUnique({ where: { clerkOrgId: orgId } });
  if (existing) return { status: "active", org: existing };

  // First sight of this Clerk org → JIT-provision. Use the authoritative org
  // name from Clerk. provisionOrg is idempotent, so concurrent first-loads are
  // safe (the loser gets the existing row, no new key).
  const client = await clerkClient();
  const clerkOrg = await client.organizations.getOrganization({ organizationId: orgId });
  const { org } = await provisionOrg({ clerkOrgId: orgId, name: clerkOrg.name });
  return { status: "active", org };
}
