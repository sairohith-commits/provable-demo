import "./globals.css";
import type { ReactNode } from "react";
import Link from "next/link";
import { ShieldCheck } from "lucide-react";
import { ClerkProvider, OrganizationSwitcher, UserButton } from "@clerk/nextjs";
import { auth } from "@clerk/nextjs/server";

export const metadata = {
  title: "Provable — Agent Governance",
  description: "IBM proved agents work. Provable makes them governable.",
};

export default async function RootLayout({ children }: { children: ReactNode }) {
  // treatPendingAsSignedOut: false so an org-less (pending) user still reads as
  // signed in here — the header shows the org switcher / user button rather than
  // flashing a "Sign in" link while they're mid-onboarding.
  const { userId } = await auth({ treatPendingAsSignedOut: false });

  return (
    <ClerkProvider>
      <html lang="en">
        <body className="min-h-screen antialiased">
          <header className="sticky top-0 z-30 border-b bg-card/80 backdrop-blur">
            <div className="mx-auto flex h-16 max-w-7xl items-center justify-between px-6">
              <div className="flex items-center gap-6">
                <Link href="/" className="flex items-center gap-2">
                  <span className="flex h-8 w-8 items-center justify-center rounded-md bg-accent text-accent-foreground">
                    <ShieldCheck className="h-5 w-5" />
                  </span>
                  <span className="text-lg font-semibold tracking-tight">Provable</span>
                </Link>
                <span className="hidden text-sm text-muted-foreground md:inline">
                  IBM proved agents work. <span className="font-medium text-foreground">Provable makes them governable.</span>
                </span>
              </div>
              <div className="flex items-center gap-3">
                {userId ? (
                  <>
                    <Link
                      href="/settings"
                      className="rounded-md px-3 py-1.5 text-sm font-medium text-muted-foreground hover:bg-muted hover:text-foreground"
                    >
                      Settings
                    </Link>
                    <OrganizationSwitcher
                      hidePersonal
                      afterCreateOrganizationUrl="/"
                      afterSelectOrganizationUrl="/"
                    />
                    <UserButton />
                  </>
                ) : (
                  <Link
                    href="/sign-in"
                    className="rounded-md border bg-background px-3 py-1.5 text-sm font-medium hover:bg-muted"
                  >
                    Sign in
                  </Link>
                )}
              </div>
            </div>
          </header>
          <main className="mx-auto max-w-7xl px-6 py-8">{children}</main>
        </body>
      </html>
    </ClerkProvider>
  );
}
