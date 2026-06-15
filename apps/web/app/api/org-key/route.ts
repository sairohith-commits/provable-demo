import { NextResponse } from "next/server";
import { API_URL } from "@/lib/api";
import { getActiveOrg } from "@/lib/getActiveOrg";

// Backs the onboarding modal. C3: no more PROVABLE_API_KEY. The active org is
// derived from the Clerk-verified session (never client input); the display
// prefix comes straight off the provisioned Provable Org row. The full key is
// shown only once at creation/rotation and is never recoverable here.
export async function GET() {
  const active = await getActiveOrg();
  if (active.status !== "active") {
    return NextResponse.json({ error: "no active organization" }, { status: 401 });
  }

  const apiUrl = process.env.NEXT_PUBLIC_API_URL ?? API_URL;
  return NextResponse.json({ apiKeyPrefix: active.org.apiKeyPrefix, apiUrl });
}
