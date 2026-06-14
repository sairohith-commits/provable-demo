import { test, expect } from "@playwright/test";
import { clerk, setupClerkTestingToken } from "@clerk/testing/playwright";
import { createClerkClient } from "@clerk/backend";
// NOTE: we read the DB with the generated @prisma/client directly — it is the
// exact client @provable/db wraps (same schema, same DATABASE_URL). Importing
// the @provable/db workspace package into Playwright's transpiler trips on its
// NodeNext ".js" import specifiers, so we use the generated client here. This is
// a test-harness detail only; no app source is involved.
import { PrismaClient } from "@prisma/client";

// Deterministic per-run identifiers so reruns never collide and cleanup is exact.
const RUN_ID = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
// Clerk "test mode" email: the +clerk_test subaddress means no real email is
// ever sent (and OTP, if any, is 424242). We sign in via the backend ticket
// strategy, so no code entry is needed.
const TEST_EMAIL = `provable-e2e+clerk_test+${RUN_ID}@example.com`;
const TEST_PASSWORD = `Pv_${RUN_ID}_Aa9!zz`;
const ORG_NAME = `E2E Org ${RUN_ID}`;

const clerkBackend = createClerkClient({ secretKey: process.env.CLERK_SECRET_KEY! });
const prisma = new PrismaClient();

let userId: string | undefined;
let clerkOrgId: string | undefined;

test.beforeAll(async () => {
  const user = await clerkBackend.users.createUser({
    emailAddress: [TEST_EMAIL],
    password: TEST_PASSWORD,
    skipPasswordChecks: true,
  });
  userId = user.id;

  // Invariant for the gate: the user must enter step (b) with ZERO org
  // memberships and no active org (a genuinely org-less, "needs onboarding"
  // user). createUser grants none; assert it so the precondition can't silently
  // drift (e.g. if instance settings ever auto-assigned one).
  const memberships = await clerkBackend.users.getOrganizationMembershipList({ userId });
  expect(memberships.totalCount, "test user starts with zero org memberships").toBe(0);
});

test.afterAll(async () => {
  // Best-effort teardown so reruns stay green: Provable Org row, Clerk org, user.
  try {
    if (clerkOrgId) await prisma.org.deleteMany({ where: { clerkOrgId } });
  } catch {}
  try {
    if (clerkOrgId) await clerkBackend.organizations.deleteOrganization(clerkOrgId);
  } catch {}
  try {
    if (userId) await clerkBackend.users.deleteUser(userId);
  } catch {}
  await prisma.$disconnect();
});

// (a) — independent, signed out.
test("(a) signed-out → protected route redirects to /sign-in", async ({ page }) => {
  await setupClerkTestingToken({ page });
  await page.goto("/agents/anything");
  await expect(page).toHaveURL(/\/sign-in/);
});

// (b–d) — one signed-in session carried across steps.
test("(b–d) onboarding routing + JIT provisioning", async ({ page }) => {
  await setupClerkTestingToken({ page });

  // Load Clerk on a public page, then sign in via the backend ticket strategy.
  await page.goto("/sign-in");
  await clerk.loaded({ page });
  await clerk.signIn({ page, emailAddress: TEST_EMAIL });

  await test.step("(b) signed in, no active org → / redirects to /onboarding", async () => {
    await page.goto("/");
    await expect(page).toHaveURL(/\/onboarding/);
  });

  await test.step("(c) create org via <CreateOrganization/> → back to / (no bounce)", async () => {
    // The CreateOrganization form: org-name textbox + a submit button. Race it
    // against Clerk's "Organizations feature required" dev overlay so a missing
    // dashboard setting fails fast with a clear message instead of a long timeout.
    const submit = page.getByRole("button", { name: /create organization/i });
    const orgsDisabled = page.getByText(/Organizations feature required/i).first();
    await expect(submit.or(orgsDisabled)).toBeVisible({ timeout: 20_000 });
    if (await orgsDisabled.isVisible().catch(() => false)) {
      throw new Error(
        "Clerk Organizations is NOT enabled on this instance. Enable it in the Clerk " +
          "dashboard (Configure → Organizations → choose a membership mode → Enable), " +
          "then rerun. The app code is correct; this is a dashboard setting.",
      );
    }
    const nameInput = page.getByRole("textbox").first();
    await nameInput.fill(ORG_NAME);
    await submit.click();

    // Lands on the dashboard and does NOT bounce back to onboarding.
    await page.waitForURL((url) => url.pathname === "/", { timeout: 30_000 });
    await expect(page).not.toHaveURL(/\/onboarding/);
  });

  await test.step("(d) JIT provisioning: exactly one Org row, idempotent on reload", async () => {
    await clerk.loaded({ page });
    clerkOrgId = await page.evaluate(() => (window as any).Clerk?.organization?.id as string | undefined);
    expect(clerkOrgId, "active Clerk org id is set on the session").toBeTruthy();

    const first = await prisma.org.findMany({ where: { clerkOrgId } });
    expect(first.length, "exactly one Provable Org provisioned").toBe(1);

    // Reload the dashboard — JIT must be idempotent (no second row).
    await page.goto("/");
    await page.waitForURL((url) => url.pathname === "/");
    await expect(page).not.toHaveURL(/\/onboarding/);
    const second = await prisma.org.findMany({ where: { clerkOrgId } });
    expect(second.length, "still exactly one Org after reload (idempotent)").toBe(1);
  });
});
