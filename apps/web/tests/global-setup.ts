import { clerkSetup } from "@clerk/testing/playwright";

// Runs once before the suite. Fetches a Clerk Testing Token from the Backend API
// (using CLERK_SECRET_KEY) and sets CLERK_TESTING_TOKEN on the main process env,
// which the worker processes inherit — setupClerkTestingToken() then injects it
// per test to bypass bot/anti-automation protection.
export default async function globalSetup() {
  if (!process.env.CLERK_SECRET_KEY) {
    throw new Error("CLERK_SECRET_KEY missing — set it in apps/web/.env.local");
  }
  await clerkSetup({
    publishableKey: process.env.CLERK_PUBLISHABLE_KEY ?? process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY,
  });
}
