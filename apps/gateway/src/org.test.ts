import { config } from "dotenv";
import { resolve } from "node:path";
config({ path: resolve(process.cwd(), "../../.env") });

import assert from "node:assert/strict";
import { prisma, generateApiKey } from "@provable/db";
import { orgFromKey } from "./org.js";

// Gateway org resolver: must resolve the org by sha256 apiKeyHash (same path as
// the API), and reject missing/malformed/unknown keys.

const TAG = `gw-org-test-${Date.now()}`;
let pass = 0;
const ok = (l: string) => { pass++; console.log(`PASS  ${l}`); };

async function main() {
  const { fullKey, apiKeyHash, apiKeyPrefix } = generateApiKey();
  const org = await prisma.org.create({ data: { name: TAG, apiKeyHash, apiKeyPrefix } });

  const resolved = await orgFromKey({ headers: { "x-provable-key": fullKey } });
  assert.equal(resolved?.id, org.id, "valid key resolves via apiKeyHash");
  ok("gateway: valid key resolves the org via apiKeyHash");

  assert.equal(await orgFromKey({ headers: {} }), null);
  ok("gateway: missing key -> null");

  assert.equal(await orgFromKey({ headers: { "x-provable-key": "garbage" } }), null);
  ok("gateway: malformed key -> null");

  assert.equal(await orgFromKey({ headers: { "x-provable-key": "pk_live_unknown" } }), null);
  ok("gateway: unknown key -> null");

  console.log(`\n${pass} checks passed.`);
}

main()
  .catch((e) => { console.error("FAIL", e); process.exitCode = 1; })
  .finally(async () => {
    await prisma.org.deleteMany({ where: { name: TAG } });
    await prisma.$disconnect();
  });
