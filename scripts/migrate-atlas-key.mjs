// scripts/migrate-atlas-key.mjs
//
// One-shot Atlas API-key rotation for the S4 live cutover.
//
// WHAT IT DOES
//   1. Connects via DATABASE_URL (point it at Neon at run time).
//   2. Finds the org named "Atlas Insurance". Aborts if zero or >1 match —
//      it never guesses which org to rotate.
//   3. Generates a real key with generateApiKey() (the canonical key module)
//      and writes apiKeyHash + apiKeyPrefix + apiKeyRotatedAt in a transaction.
//   4. Prints the full key ONCE (it is not stored and cannot be re-read), plus
//      the exact Render env-var changes to make.
//
// RUN (read-only dry run — stops before any write):
//   DATABASE_URL="<neon-url>" pnpm --filter @provable/db exec tsx ../../scripts/migrate-atlas-key.mjs --dry-run
//
// RUN (real rotation — writes the new hash and prints the key once):
//   DATABASE_URL="<neon-url>" pnpm --filter @provable/db exec tsx ../../scripts/migrate-atlas-key.mjs
//
//   (tsx is required — this imports the TypeScript key module. From repo root
//    you can also use:  DATABASE_URL="<neon-url>" npx tsx scripts/migrate-atlas-key.mjs)
//
// IDEMPOTENCY: this is NOT idempotent. Every real run rotates the key AGAIN and
// prints a DIFFERENT key, immediately invalidating the previous one. Run it
// exactly once for the cutover. If you run it twice, you must re-point every
// consumer at the newest key. Use --dry-run to rehearse safely.

// Imported straight from the @provable/db source so generation + hashing stay
// single-source-of-truth (this is the same key module the API/gateway/seed use).
import { PrismaClient, generateApiKey } from "../packages/db/src/index.js";

const ATLAS_ORG_NAME = "Atlas Insurance";
const DRY_RUN = process.argv.includes("--dry-run") || process.env.DRY_RUN === "1";

const line = (c = "=") => console.log(c.repeat(72));
function fail(msg) {
  console.error(`\n  ABORT: ${msg}\n`);
  process.exitCode = 1;
}

async function main() {
  if (!process.env.DATABASE_URL) {
    fail("DATABASE_URL is not set. Point it at the target database and re-run.");
    return;
  }

  const prisma = new PrismaClient();
  try {
    // ---- locate exactly one Atlas org (never guess) ----
    const matches = await prisma.org.findMany({
      where: { name: ATLAS_ORG_NAME },
      select: { id: true, name: true, apiKeyPrefix: true, apiKeyRotatedAt: true },
    });

    if (matches.length === 0) {
      fail(`no org named "${ATLAS_ORG_NAME}" found in this database. Nothing rotated.`);
      return;
    }
    if (matches.length > 1) {
      fail(
        `found ${matches.length} orgs named "${ATLAS_ORG_NAME}" ` +
          `(ids: ${matches.map((o) => o.id).join(", ")}). Refusing to guess — resolve the duplicate first.`,
      );
      return;
    }

    const org = matches[0];
    console.log("");
    line();
    console.log(`  Target org : ${org.name}`);
    console.log(`  Org id     : ${org.id}`);
    console.log(`  Current key prefix : ${org.apiKeyPrefix}`);
    console.log(`  Last rotated at    : ${org.apiKeyRotatedAt?.toISOString?.() ?? org.apiKeyRotatedAt}`);
    line();

    if (DRY_RUN) {
      console.log("\n  DRY RUN — exactly ONE org matched. No key generated, nothing written.");
      console.log("  Re-run WITHOUT --dry-run to rotate this org's key.\n");
      return;
    }

    // ---- rotate: generate + persist hash/prefix/rotatedAt atomically ----
    const { fullKey, apiKeyHash, apiKeyPrefix } = generateApiKey();

    await prisma.$transaction(async (tx) => {
      await tx.org.update({
        where: { id: org.id },
        data: { apiKeyHash, apiKeyPrefix, apiKeyRotatedAt: new Date() },
      });
    });

    // ---- show the key ONCE ----
    console.log("");
    line("#");
    console.log("  NEW ATLAS API KEY — SHOWN ONCE, NOT STORED, CANNOT BE RE-READ");
    console.log("  Copy it now. The database holds only its sha256 hash + prefix.");
    line("#");
    console.log("");
    console.log(`      ${fullKey}`);
    console.log("");
    console.log(`  Stored prefix (display only): ${apiKeyPrefix}`);
    line("#");

    // ---- exact env-var changes for the operator ----
    console.log("\n  UPDATE THESE RENDER SERVICES (set the env var to the key above,");
    console.log("  then redeploy each service):\n");
    console.log("    • Service: refund-desk");
    console.log(`        PROVABLE_API_KEY = ${fullKey}`);
    console.log("");
    console.log("    • Service: provable-web");
    console.log(`        PROVABLE_API_KEY = ${fullKey}`);
    console.log("");
    line();
    console.log("  REMINDER: running this script again rotates the key AGAIN and");
    console.log("  prints a NEW key, invalidating the one above. Run it ONCE.");
    line();
    console.log("");
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((e) => {
  // Any thrown error inside the transaction rolls it back automatically.
  fail(`rotation failed, no changes committed: ${e?.message ?? e}`);
});
