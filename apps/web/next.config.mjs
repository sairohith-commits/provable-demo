/** @type {import('next').NextConfig} */
const nextConfig = {
  // @provable/db ships TypeScript source, so Next must transpile it (used by
  // getActiveOrg/provisionOrg in Node-runtime RSCs — never Edge or the browser).
  transpilePackages: ["@provable/db"],
  // ...but the native Prisma client stays external so its query engine isn't
  // pulled through the bundler.
  serverExternalPackages: ["@prisma/client"],
  webpack: (config) => {
    // @provable/db uses NodeNext ".js" import specifiers that point at ".ts"
    // sources (no build step). Let the bundler resolve ".js" → ".ts" so those
    // workspace imports (./scoring.js, ./provisioning.js, …) resolve.
    config.resolve.extensionAlias = {
      ...(config.resolve.extensionAlias ?? {}),
      ".js": [".ts", ".tsx", ".js"],
      ".mjs": [".mts", ".mjs"],
    };
    return config;
  },
};

export default nextConfig;
