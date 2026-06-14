import { CreateOrganization } from "@clerk/nextjs";
import { auth } from "@clerk/nextjs/server";
import { redirect } from "next/navigation";

export const dynamic = "force-dynamic";

// Interim C2 onboarding stub. A signed-in user with no active org lands here and
// uses Clerk's <CreateOrganization /> to create + activate one. After creation
// they return to the dashboard, where getActiveOrg() JIT-provisions the matching
// Provable Org. C4 replaces this stub with the branded 3-screen flow + show-once
// key. Org id is always derived from the Clerk session, never client input (D4).
export default async function OnboardingPage() {
  // treatPendingAsSignedOut: false — an org-less user (the whole audience of this
  // page in "Membership required" mode) has a PENDING session; without this they
  // would read as signed-out and bounce to /sign-in instead of seeing the form.
  const { userId, orgId } = await auth({ treatPendingAsSignedOut: false });
  if (!userId) redirect("/sign-in");
  if (orgId) redirect("/"); // already has an active org → dashboard

  return (
    <div className="flex flex-col items-center gap-6 py-12">
      <div className="max-w-xl text-center">
        <h1 className="text-2xl font-semibold tracking-tight">Create your workspace</h1>
        <p className="mt-2 text-muted-foreground">
          Spin up an organization to start governing your agents. This is an interim setup screen —
          the full guided onboarding (with your show-once API key) lands shortly.
        </p>
      </div>
      <CreateOrganization afterCreateOrganizationUrl="/" skipInvitationScreen />
    </div>
  );
}
