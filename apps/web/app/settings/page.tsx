import { redirect } from "next/navigation";
import { getActiveOrg } from "@/lib/getActiveOrg";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { RotateKeyCard } from "./rotate-key-card";

export const dynamic = "force-dynamic";

export default async function SettingsPage() {
  const active = await getActiveOrg();
  if (active.status === "signed-out") redirect("/sign-in");
  if (active.status === "needs-onboarding" || active.status === "unprovisioned") redirect("/onboarding");

  const { org } = active;

  return (
    <div className="mx-auto max-w-2xl space-y-8">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Settings</h1>
        <p className="mt-1 text-muted-foreground">Manage your workspace and API key.</p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Workspace</CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-sm font-medium">Name</p>
          <p data-testid="org-name" className="text-sm text-muted-foreground">
            {org.name}
          </p>
        </CardContent>
      </Card>

      <RotateKeyCard initialPrefix={org.apiKeyPrefix} />
    </div>
  );
}
