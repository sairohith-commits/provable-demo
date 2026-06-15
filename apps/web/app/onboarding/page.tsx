import { redirect } from "next/navigation";
import { getActiveOrg } from "@/lib/getActiveOrg";
import { OnboardingFlow } from "./onboarding-flow";

export const dynamic = "force-dynamic";

// C4: the branded 3-screen onboarding flow (replaces the C2 <CreateOrganization/>
// stub). The server only gates signed-out users; the "already provisioned →
// dashboard" redirect is done CLIENT-side in the flow (once, on fresh mount) so a
// router.refresh fired by Clerk's setActive can't yank a mid-flow user off the
// show-once key screen. The flow is the sole provisioner.
export default async function OnboardingPage() {
  const active = await getActiveOrg();
  if (active.status === "signed-out") redirect("/sign-in");

  const initialState =
    active.status === "active" ? "active" : active.status === "unprovisioned" ? "unprovisioned" : "needs-onboarding";

  return <OnboardingFlow initialState={initialState} />;
}
