import { clerkMiddleware, createRouteMatcher } from "@clerk/nextjs/server";

// Clerk Core-3 (App Router) middleware. Runs on the Edge runtime, so it does
// NOT touch Prisma / @provable/db — it only enforces authentication. JIT org
// provisioning (which needs the DB) happens in Node-runtime RSCs via
// getActiveOrg(), never here.
//
// Public routes (no sign-in required):
//   /             — transitional dashboard (still served via PROVABLE_API_KEY until C3)
//   /sign-in, /sign-up — Clerk auth pages
//   /onboarding   — interim org-creation stub
//   /api/org-key  — server proxy the home onboarding modal calls (transitional, reworked in C3)
// Everything else (e.g. /agents/:id, /tasks/:id/audit) requires a signed-in user.
const isPublicRoute = createRouteMatcher([
  "/",
  "/sign-in(.*)",
  "/sign-up(.*)",
  "/onboarding(.*)",
  "/api/org-key",
]);

export default clerkMiddleware(async (auth, req) => {
  if (!isPublicRoute(req)) {
    await auth.protect(); // unauthenticated → redirect to sign-in
  }
});

export const config = {
  matcher: [
    // Run on everything except Next internals and static assets...
    "/((?!_next|[^?]*\\.(?:html?|css|js(?!on)|jpg|jpeg|gif|png|svg|ico|webp|avif|woff2?|ttf|otf|map)).*)",
    // ...and always on API routes.
    "/(api|trpc)(.*)",
  ],
};
