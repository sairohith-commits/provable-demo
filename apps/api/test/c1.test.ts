import request from "supertest";
import Fastify, { type FastifyInstance } from "fastify";
import { prisma, provisionOrg, rotateKey } from "@provable/db";
import { registerRoutes } from "../src/routes.js";
import { recomputeQueue } from "../src/queue.js";
import { connection } from "../src/redis.js";

// P2-C1 gate: provisioning core + internal-auth branch.
// Exercises the real Fastify route handlers over HTTP via Supertest, against the
// local dev DB. The internal service token is set on process.env before the app
// handles requests (the middleware reads it per-request).

const TAG = `c1-${Date.now()}`;
const INTERNAL_TOKEN = `tok_test_${Math.random().toString(36).slice(2)}_${Date.now()}`;

let app: FastifyInstance;

beforeAll(async () => {
  process.env.PROVABLE_INTERNAL_TOKEN = INTERNAL_TOKEN;
  app = Fastify();
  await registerRoutes(app);
  await app.ready();
});

afterAll(async () => {
  await app.close();
  // Clean up everything this suite created (orgs + their agents), TAG-scoped.
  await prisma.agent.deleteMany({ where: { org: { name: { startsWith: TAG } } } });
  await prisma.org.deleteMany({ where: { name: { startsWith: TAG } } });
  await recomputeQueue.close();
  await connection.quit();
  await prisma.$disconnect();
});

describe("provisionOrg", () => {
  test("is idempotent: 2nd call returns null plaintext and the same key prefix", async () => {
    const clerkOrgId = `${TAG}_clerk_A`;

    const first = await provisionOrg({ clerkOrgId, name: `${TAG}_A` });
    expect(first.plaintextKey).toEqual(expect.any(String));
    expect(first.plaintextKey!.startsWith("pk_live_")).toBe(true);
    expect(first.org.clerkOrgId).toBe(clerkOrgId);

    const second = await provisionOrg({ clerkOrgId, name: `${TAG}_A_again` });
    expect(second.plaintextKey).toBeNull(); // never re-expose
    expect(second.org.id).toBe(first.org.id); // same row
    expect(second.org.apiKeyPrefix).toBe(first.org.apiKeyPrefix); // key not regenerated
    expect(second.org.name).toBe(`${TAG}_A`); // existing row untouched
  });
});

describe("rotateKey", () => {
  test("invalidates the old key (→401) and the new key authenticates (→200)", async () => {
    const { org, plaintextKey: oldKey } = await provisionOrg({ clerkOrgId: `${TAG}_clerk_R`, name: `${TAG}_R` });
    expect(oldKey).toEqual(expect.any(String));

    // Old key works on the P1 machine-key path.
    await request(app.server).get("/agents").set("x-provable-key", oldKey!).expect(200);

    const { plaintextKey: newKey } = await rotateKey({ orgId: org.id });
    expect(newKey).toEqual(expect.any(String));
    expect(newKey).not.toBe(oldKey);

    // Old key is now dead.
    const dead = await request(app.server).get("/agents").set("x-provable-key", oldKey!);
    expect(dead.status).toBe(401);
    expect(dead.body.error).toBe("invalid_key");

    // New key works.
    await request(app.server).get("/agents").set("x-provable-key", newKey).expect(200);
  });
});

describe("internal-token auth branch", () => {
  test("returns ONLY the supplied org's data and scopes via the tenant-guard", async () => {
    const A = await provisionOrg({ clerkOrgId: `${TAG}_clerk_IA`, name: `${TAG}_IA` });
    const B = await provisionOrg({ clerkOrgId: `${TAG}_clerk_IB`, name: `${TAG}_IB` });
    const agentA = await prisma.agent.create({ data: { orgId: A.org.id, name: `${TAG}_agentA`, purpose: "" } });
    const agentB = await prisma.agent.create({ data: { orgId: B.org.id, name: `${TAG}_agentB`, purpose: "" } });

    // Internal token + x-provable-org-id=A → only A's agent, never B's.
    const res = await request(app.server)
      .get("/agents")
      .set("authorization", `Bearer ${INTERNAL_TOKEN}`)
      .set("x-provable-org-id", A.org.id)
      .expect(200);
    const ids = (res.body as Array<{ id: string }>).map((a) => a.id);
    expect(ids).toContain(agentA.id);
    expect(ids).not.toContain(agentB.id);

    // Cross-org detail read with org A's context cannot see B's agent → 404.
    await request(app.server)
      .get(`/agents/${agentB.id}`)
      .set("authorization", `Bearer ${INTERNAL_TOKEN}`)
      .set("x-provable-org-id", A.org.id)
      .expect(404);

    // Switching the header to B returns B's agent (server-derived scoping).
    const resB = await request(app.server)
      .get("/agents")
      .set("authorization", `Bearer ${INTERNAL_TOKEN}`)
      .set("x-provable-org-id", B.org.id)
      .expect(200);
    const idsB = (resB.body as Array<{ id: string }>).map((a) => a.id);
    expect(idsB).toContain(agentB.id);
    expect(idsB).not.toContain(agentA.id);
  });

  test("bad token, unknown org, and missing org/headers all → 401", async () => {
    const A = await provisionOrg({ clerkOrgId: `${TAG}_clerk_BAD`, name: `${TAG}_BAD` });

    // Wrong token → 401 invalid_internal_token (does NOT fall back to machine-key).
    const bad = await request(app.server)
      .get("/agents")
      .set("authorization", "Bearer not-the-real-token")
      .set("x-provable-org-id", A.org.id);
    expect(bad.status).toBe(401);
    expect(bad.body.error).toBe("invalid_internal_token");

    // Short/garbage bearer (unequal length) must NOT throw RangeError in
    // timingSafeEqual — it returns a clean 401, never a 500.
    const short = await request(app.server)
      .get("/agents")
      .set("authorization", "Bearer x")
      .set("x-provable-org-id", A.org.id);
    expect(short.status).toBe(401);
    expect(short.body.error).toBe("invalid_internal_token");

    // Valid token, unknown org id → 401 invalid_org_id.
    const unknown = await request(app.server)
      .get("/agents")
      .set("authorization", `Bearer ${INTERNAL_TOKEN}`)
      .set("x-provable-org-id", "org_does_not_exist");
    expect(unknown.status).toBe(401);
    expect(unknown.body.error).toBe("invalid_org_id");

    // Valid token, no org-id header → 401 missing_org_id.
    const missing = await request(app.server).get("/agents").set("authorization", `Bearer ${INTERNAL_TOKEN}`);
    expect(missing.status).toBe(401);
    expect(missing.body.error).toBe("missing_org_id");

    // No auth at all → 401.
    await request(app.server).get("/agents").expect(401);
  });

  test("internal token is NOT honored on machine-key-only routes (gateway/ingestion)", async () => {
    const A = await provisionOrg({ clerkOrgId: `${TAG}_clerk_G`, name: `${TAG}_G` });

    // A VALID internal token + org id on a gateway route must NOT authenticate:
    // those routes don't offer the internal branch, so it falls to the machine-key
    // path and fails for lack of x-provable-key.
    const g = await request(app.server)
      .get("/gateway/stats")
      .set("authorization", `Bearer ${INTERNAL_TOKEN}`)
      .set("x-provable-org-id", A.org.id);
    expect(g.status).toBe(401);
    expect(g.body.error).toBe("missing_or_malformed_key");

    // Same on /track (ingestion) with the task-key body shape → machine-key only.
    const t = await request(app.server)
      .post("/track")
      .set("authorization", `Bearer ${INTERNAL_TOKEN}`)
      .set("x-provable-org-id", A.org.id)
      .set("x-provable-agent", "whatever")
      .send({ task: "some_task", outcome: "success" });
    expect(t.status).toBe(401);
    expect(t.body.error).toBe("missing_or_malformed_key");
  });
});
