import "server-only";
import { auth } from "@clerk/nextjs/server";
import { prisma, type Org } from "@provable/db";

// Server-only, READ-ONLY resolver for the signed-in user's active org.
//
// IMPORTANT (C4 show-once coordination): this function does NOT provision. The
// API key plaintext is returned by provisionOrg exactly once on CREATE, so the
// onboarding flow's server action (app/onboarding/actions.ts) is the sole
// authoritative provisioner — it captures that plaintext for screen 2. If this
// resolver (or the layout) silently JIT-provisioned a brand-new org first, the
// plaintext would be discarded and screen 2 would have nothing to show. So an
// active Clerk org with no Provable Org yet returns `unprovisioned`, and callers
// route the user into onboarding rather than provisioning here.
//
// The Clerk org id is read EXCLUSIVELY from the verified session via auth() —
// never from client input (defense-in-depth re: CVE-2025-29927).

export type ActiveOrgResult =
  | { status: "signed-out" } // no Clerk session
  | { status: "needs-onboarding" } // signed in, no active Clerk org
  | { status: "unprovisioned"; clerkOrgId: string } // active Clerk org, Provable Org not created yet
  | { status: "active"; org: Org };

export async function getActiveOrg(): Promise<ActiveOrgResult> {
  // treatPendingAsSignedOut: false — in "Membership required" mode an org-less
  // user has a PENDING session; we still need to see them (userId present, orgId
  // null) so we can route them into onboarding.
  const { userId, orgId } = await auth({ treatPendingAsSignedOut: false });
  if (!userId) return { status: "signed-out" };
  if (!orgId) return { status: "needs-onboarding" };

  const existing = await prisma.org.findUnique({ where: { clerkOrgId: orgId } });
  if (existing) return { status: "active", org: existing };

  // Active Clerk org but no Provable Org → onboarding must provision (and capture
  // the show-once key). We do NOT provision here.
  return { status: "unprovisioned", clerkOrgId: orgId };
}
