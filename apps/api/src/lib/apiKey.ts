// Re-export the canonical key module from @provable/db so generation + hashing
// have a single source of truth shared by the API, the gateway, and the seed.
// The implementation (node:crypto only) lives in packages/db/src/apiKey.ts.
export { generateApiKey, hashApiKey } from "@provable/db";
