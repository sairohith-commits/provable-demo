import { test, expect, type BrowserContext, type Page } from "@playwright/test";
import { clerk, setupClerkTestingToken } from "@clerk/testing/playwright";
import { createClerkClient } from "@clerk/backend";
// We read/write the DB with the generated @prisma/client directly — the exact
// client @provable/db wraps (same schema, same DATABASE_URL). Importing the
// @provable/db workspace into Playwright's transpiler trips on its NodeNext
// ".js" specifiers, so we use the generated client. Test-harness detail only.
import { PrismaClient } from "@prisma/client";

// C3 isolation gate: two onboarded orgs (A, B), each with its own injected agent.
// Proves the dashboard, now reading via the internal token + session-derived
// x-provable-org-id (PROVABLE_API_KEY removed), shows ONLY the logged-in org's
// data — cross-tenant isolation through the real web path.

const RUN_ID = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
const PASSWORD = `Pv_${RUN_ID}_Aa9!zz`;

const clerkBackend = createClerkClient({ secretKey: process.env.CLERK_SECRET_KEY! });
const prisma = new PrismaClient();

// Tracked for deterministic teardown.
const userIds: string[] = [];
const clerkOrgIds: string[] = [];

type Tenant = { label: string; email: string; userId: string; clerkOrgId: string };

// Backend-onboard a user that already has exactly one org (created via the Clerk
// API). The matching Provable Org is JIT-provisioned on the first dashboard load.
async function onboardUserWithOrg(label: string): Promise<Tenant> {
  const email = `provable-e2e+clerk_test+c3-${label}-${RUN_ID}@example.com`;
  const user = await clerkBackend.users.createUser({
    emailAddress: [email],
    password: PASSWORD,
    skipPasswordChecks: true,
  });
  userIds.push(user.id);
  const org = await clerkBackend.organizations.createOrganization({
    name: `C3 Org ${label} ${RUN_ID}`,
    createdBy: user.id,
  });
  clerkOrgIds.push(org.id);
  return { label, email, userId: user.id, clerkOrgId: org.id };
}

// Sign in (ticket strategy), activate the org so the session carries orgId, then
// load the dashboard once to trigger JIT provisioning. Returns the signed-in page.
async function signInAndLand(context: BrowserContext, t: Tenant): Promise<Page> {
  const page = await context.newPage();
  await setupClerkTestingToken({ page });
  await page.goto("/sign-in");
  await clerk.loaded({ page });
  await clerk.signIn({ page, emailAddress: t.email });

  // Activate the backend-created org (org id comes from the session afterward).
  await page.evaluate(async (orgId) => {
    await (window as any).Clerk.setActive({ organization: orgId });
  }, t.clerkOrgId);
  await page.waitForFunction(
    (orgId) => (window as any).Clerk?.organization?.id === orgId,
    t.clerkOrgId,
    { timeout: 15_000 },
  );

  await page.goto("/");
  await expect(page, "active-org user lands on the dashboard, not sign-in/onboarding").not.toHaveURL(
    /\/(sign-in|onboarding)/,
  );
  return page;
}

// JIT provisioning is synchronous in the RSC render, but poll briefly to be safe.
async function waitForProvableOrg(clerkOrgId: string) {
  for (let i = 0; i < 40; i++) {
    const org = await prisma.org.findUnique({ where: { clerkOrgId } });
    if (org) return org;
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`Provable org was not provisioned for clerkOrgId=${clerkOrgId}`);
}

test.afterAll(async () => {
  // Full teardown so reruns stay green: agents → Provable orgs → Clerk orgs → users.
  for (const cid of clerkOrgIds) {
    try {
      await prisma.agent.deleteMany({ where: { org: { clerkOrgId: cid } } });
    } catch {}
    try {
      await prisma.org.deleteMany({ where: { clerkOrgId: cid } });
    } catch {}
    try {
      await clerkBackend.organizations.deleteOrganization(cid);
    } catch {}
  }
  for (const uid of userIds) {
    try {
      await clerkBackend.users.deleteUser(uid);
    } catch {}
  }
  await prisma.$disconnect();
});

test("(a–c) cross-tenant isolation via the web path", async ({ browser }) => {
  const agentAName = `c3-agent-A-${RUN_ID}`;
  const agentBName = `c3-agent-B-${RUN_ID}`;

  // ---- Onboard A + inject agent-A ----
  const A = await onboardUserWithOrg("A");
  const ctxA = await browser.newContext();
  const pageA = await signInAndLand(ctxA, A);
  const provA = await waitForProvableOrg(A.clerkOrgId);
  await prisma.agent.create({ data: { orgId: provA.id, name: agentAName, purpose: "" } });

  await test.step("(a) A's dashboard shows agent-A", async () => {
    await pageA.goto("/");
    await expect(pageA.getByText(agentAName)).toBeVisible();
  });

  // ---- Onboard B + inject agent-B ----
  const B = await onboardUserWithOrg("B");
  const ctxB = await browser.newContext();
  const pageB = await signInAndLand(ctxB, B);
  const provB = await waitForProvableOrg(B.clerkOrgId);
  await prisma.agent.create({ data: { orgId: provB.id, name: agentBName, purpose: "" } });

  await test.step("(b) each org sees ONLY its own agent (cross-tenant isolation)", async () => {
    // B's dashboard: agent-B present, agent-A absent.
    await pageB.goto("/");
    await expect(pageB.getByText(agentBName)).toBeVisible();
    await expect(pageB.getByText(agentAName)).toHaveCount(0);

    // A's dashboard: agent-A present, agent-B absent.
    await pageA.goto("/");
    await expect(pageA.getByText(agentAName)).toBeVisible();
    await expect(pageA.getByText(agentBName)).toHaveCount(0);
  });

  await test.step("(c) reads work with PROVABLE_API_KEY absent from the web env", async () => {
    // The web dev server was started with PROVABLE_API_KEY="" (see
    // playwright.config webServer.env). The reads above already succeeded under
    // that condition; re-assert explicitly that A's data renders without it.
    await pageA.goto("/");
    await expect(pageA.getByText(agentAName)).toBeVisible();
  });

  await ctxA.close();
  await ctxB.close();
});
