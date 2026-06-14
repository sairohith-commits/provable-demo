// Runs before any test module loads, so DATABASE_URL / REDIS_URL are present
// before the lazily-connecting Prisma client and the eager ioredis connection
// initialize. Points at the same local dev infra the other suites use.
const path = require("node:path");
require("dotenv").config({ path: path.resolve(__dirname, "../../../.env") });
