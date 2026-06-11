import "./globals.css";
import type { ReactNode } from "react";
import Link from "next/link";
import { ShieldCheck, ChevronDown } from "lucide-react";

export const metadata = {
  title: "Provable — Agent Governance",
  description: "IBM proved agents work. Provable makes them governable.",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
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
            <div className="flex items-center gap-2 rounded-md border bg-background px-3 py-1.5 text-sm">
              <span className="text-muted-foreground">Org</span>
              <span className="font-medium">Atlas Insurance</span>
              <ChevronDown className="h-4 w-4 text-muted-foreground" />
            </div>
          </div>
        </header>
        <main className="mx-auto max-w-7xl px-6 py-8">{children}</main>
      </body>
    </html>
  );
}
