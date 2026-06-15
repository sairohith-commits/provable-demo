import { test, expect } from "@playwright/test";
import { clerk, setupClerkTestingToken } from "@clerk/testing/playwright";
import { createClerkClient } from "@clerk/backend";
// Read/write the DB with the generated @prisma/client directly (same schema /
// DATABASE_URL as @provable/db; avoids the NodeNext ".js" specifier issue).
import { PrismaClient } from "@prisma/client";

// C5 gate: /settings key rotation (show-once) + dashboard empty states.

const RUN_ID = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
const TEST_EMAIL = `provable-e2e+clerk_test+c5-${RUN_ID}@example.com`;
const TEST_PASSWORD = `Pv_${RUN_ID}_Aa9!zz`;
const ORG_NAME = `C5 Org ${RUN_ID}`;
const API = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:4000";

const clerkBackend = createClerkClient({ secretKey: process.env.CLERK_SECRET_KEY! });
const prisma = new PrismaClient();

let userId: string | undefined;
let clerkOrgId: string | undefined;

// Hit the API's machine-key path with a given key; return the HTTP status.
async function apiStatus(key: string): Promise<number> {
  const res = await fetch(`${API}/agents`, { headers: { "x-provable-key": key } });
  return res.status;
}

test.beforeAll(async () => {
  const user = await clerkBackend.users.createUser({
    emailAddress: [TEST_EMAIL],
    password: TEST_PASSWORD,
    skipPasswordChecks: true,
  });
  userId = user.id;
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

test("(a–b) settings rotation (show-once) + dashboard empty states", async ({ page }) => {
  await setupClerkTestingToken({ page });
  await page.goto("/sign-in");
  await clerk.loaded({ page });
  await clerk.signIn({ page, emailAddress: TEST_EMAIL });

  // Onboard: name the workspace and capture the issued key (OLD).
  await page.goto("/onboarding");
  await page.getByLabel(/workspace name/i).fill(ORG_NAME);
  await page.getByRole("button", { name: /create workspace/i }).click();
  await expect(page.getByTestId("api-key")).toBeVisible({ timeout: 30_000 });
  const oldKey = ((await page.getByTestId("api-key").textContent()) ?? "").trim();
  expect(oldKey).toMatch(/^pk_live_[A-Za-z0-9_-]{20,}$/);
  clerkOrgId = await page.evaluate(() => (window as any).Clerk?.organization?.id as string | undefined);
  expect(clerkOrgId).toBeTruthy();

  let newKey = "";

  await test.step("(a) rotate invalidates the old key, activates the new one, prefix updates", async () => {
    // Sanity: the issued key authenticates at the API before rotation.
    expect(await apiStatus(oldKey)).toBe(200);

    await page.goto("/settings");
    await expect(page.getByTestId("org-name")).toHaveText(ORG_NAME);
    await expect(page.getByTestId("key-prefix")).toContainText(oldKey.slice(0, 16));

    // Rotate (with the danger-confirm step), then reveal the new key once.
    await page.getByRole("button", { name: /rotate key/i }).click();
    await page.getByRole("button", { name: /yes, rotate now/i }).click();
    await expect(page.getByTestId("api-key")).toBeVisible({ timeout: 15_000 });
    newKey = ((await page.getByTestId("api-key").textContent()) ?? "").trim();
    expect(newKey).toMatch(/^pk_live_[A-Za-z0-9_-]{20,}$/);
    expect(newKey).not.toBe(oldKey);

    // Dismiss the modal; the displayed prefix now reflects the new key.
    await page.getByRole("button", { name: /^done$/i }).click();
    await expect(page.getByTestId("key-prefix")).toContainText(newKey.slice(0, 16));

    // The API machine-key path: old key is dead, new key works.
    expect(await apiStatus(oldKey), "old key → 401 after rotation").toBe(401);
    expect(await apiStatus(newKey), "new key → 200 after rotation").toBe(200);

    // Reload: only the new prefix persists; the plaintext is never re-shown.
    await page.reload();
    await expect(page.getByTestId("key-prefix")).toContainText(newKey.slice(0, 16));
    await expect(page.getByTestId("api-key"), "no plaintext key on reload").toHaveCount(0);
  });

  await test.step("(b) empty state shows for a fresh org, then is replaced by real data", async () => {
    await page.goto("/");
    await expect(page.getByTestId("empty-agents")).toBeVisible();

    // Inject an agent for this org directly via prisma.
    const org = await prisma.org.findUniqueOrThrow({ where: { clerkOrgId } });
    const agentName = `c5-agent-${RUN_ID}`;
    await prisma.agent.create({ data: { orgId: org.id, name: agentName, purpose: "" } });

    await page.reload();
    await expect(page.getByText(agentName), "injected agent now renders").toBeVisible();
    await expect(page.getByTestId("empty-agents"), "empty state gone once data exists").toHaveCount(0);
  });
});
