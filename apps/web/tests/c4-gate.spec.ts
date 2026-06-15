import { test, expect } from "@playwright/test";
import { clerk, setupClerkTestingToken } from "@clerk/testing/playwright";
import { createClerkClient } from "@clerk/backend";
// Read the DB with the generated @prisma/client directly (same schema/DATABASE_URL
// as @provable/db; avoids the NodeNext ".js" specifier issue in the transpiler).
import { PrismaClient } from "@prisma/client";

// C4 gate: the 3-screen onboarding flow with a show-once API key.

const RUN_ID = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
const TEST_EMAIL = `provable-e2e+clerk_test+c4-${RUN_ID}@example.com`;
const TEST_PASSWORD = `Pv_${RUN_ID}_Aa9!zz`;
const ORG_NAME = `C4 Org ${RUN_ID}`;

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
  // Brand-new user: zero orgs, so the flow starts at screen 1 (name workspace).
  const memberships = await clerkBackend.users.getOrganizationMembershipList({ userId });
  expect(memberships.totalCount, "test user starts org-less").toBe(0);
});

test.afterAll(async () => {
  try {
    if (clerkOrgId) await prisma.agent.deleteMany({ where: { org: { clerkOrgId } } });
  } catch {}
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

test("(a–b) 3-screen onboarding + show-once key", async ({ page }) => {
  await setupClerkTestingToken({ page });
  await page.goto("/sign-in");
  await clerk.loaded({ page });
  await clerk.signIn({ page, emailAddress: TEST_EMAIL });

  let shownKey = "";

  await test.step("(a) sign up → name workspace → see key once → screen 3 → dashboard", async () => {
    await page.goto("/onboarding");

    // Screen 1 — name the workspace.
    await page.getByLabel(/workspace name/i).fill(ORG_NAME);
    await page.getByRole("button", { name: /create workspace/i }).click();

    // Screen 2 — the key is shown exactly once and matches the key format.
    const keyEl = page.getByTestId("api-key");
    await expect(keyEl).toBeVisible({ timeout: 30_000 });
    shownKey = ((await keyEl.textContent()) ?? "").trim();
    expect(shownKey, "plaintext key matches pk_live_ format").toMatch(/^pk_live_[A-Za-z0-9_-]{20,}$/);

    // Capture the active Clerk org id for DB assertions + teardown.
    clerkOrgId = await page.evaluate(() => (window as any).Clerk?.organization?.id as string | undefined);
    expect(clerkOrgId, "active Clerk org id set on the session").toBeTruthy();

    // Screen 3 — quickstart, then go to the dashboard.
    await page.getByRole("button", { name: /continue/i }).click();
    await page.getByRole("button", { name: /go to dashboard/i }).click();

    await page.waitForURL((url) => url.pathname === "/");
    await expect(page).not.toHaveURL(/\/onboarding/);
    await expect(page.getByText(/no agents yet/i), "lands on the empty dashboard").toBeVisible();

    // DB: exactly one Org for this Clerk org, provisioned (apiKeyHash set).
    const rows = await prisma.org.findMany({ where: { clerkOrgId } });
    expect(rows.length, "exactly one Provable Org provisioned").toBe(1);
    expect(rows[0].apiKeyHash, "apiKeyHash is set (key was issued + hashed)").toBeTruthy();
  });

  await test.step("(b) refresh/return does NOT re-show the key", async () => {
    // Re-navigating onboarding for an already-provisioned org redirects to the
    // dashboard — provisionOrg returns null on the existing org, so there is no
    // plaintext to render.
    await page.goto("/onboarding");
    await page.waitForURL((url) => url.pathname === "/");
    await expect(page.getByTestId("api-key"), "no key element on reload").toHaveCount(0);
    expect(shownKey.length).toBeGreaterThan(0);
    await expect(page.getByText(shownKey), "the plaintext key is never re-shown").toHaveCount(0);

    // Still exactly one org, still provisioned (no second key issued).
    const rows = await prisma.org.findMany({ where: { clerkOrgId } });
    expect(rows.length).toBe(1);
    expect(rows[0].apiKeyHash).toBeTruthy();
  });
});
