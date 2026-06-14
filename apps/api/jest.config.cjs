// Jest config for apps/api (P2-C1 tests).
// CJS transform mode: the source is ESM-with-.js-specifiers, but none of it uses
// import.meta, so ts-jest can transpile to CommonJS — avoiding the experimental
// ESM-VM runner. Type diagnostics are off (transpile-only) so the known,
// unrelated ioredis/BullMQ type mismatches in queue.ts/worker.ts don't fail the
// run; correctness is asserted behaviorally via Supertest.
module.exports = {
  testEnvironment: "node",
  roots: ["<rootDir>/test"],
  setupFiles: ["<rootDir>/test/loadEnv.cjs"],
  transform: {
    "^.+\\.ts$": [
      "ts-jest",
      {
        diagnostics: false,
        tsconfig: {
          module: "commonjs",
          target: "es2022",
          moduleResolution: "node",
          esModuleInterop: true,
          resolveJsonModule: true,
          skipLibCheck: true,
          verbatimModuleSyntax: false,
        },
      },
    ],
  },
  moduleNameMapper: {
    // Resolve the workspace package to its TS source (transformed by ts-jest).
    "^@provable/db$": "<rootDir>/../../packages/db/src/index.ts",
    // Strip the .js extension from relative ESM specifiers so ts-jest finds the .ts.
    "^(\\.{1,2}/.*)\\.js$": "$1",
  },
  testTimeout: 30000,
};
