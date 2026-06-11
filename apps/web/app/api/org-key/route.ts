import { NextResponse } from "next/server";
import { API_URL } from "@/lib/api";

// Server-side proxy for the onboarding modal. Keeps the org's API key out of
// the client bundle: the browser calls this route, which calls the Provable
// API with the key from a server-only env var.
export async function GET() {
  const key = process.env.PROVABLE_API_KEY;
  if (!key) {
    return NextResponse.json(
      { error: "PROVABLE_API_KEY is not configured on the dashboard" },
      { status: 500 },
    );
  }

  const res = await fetch(`${API_URL}/org/key`, {
    headers: { "x-provable-key": key },
    cache: "no-store",
  });

  const body = await res.json();
  return NextResponse.json(body, { status: res.status });
}
