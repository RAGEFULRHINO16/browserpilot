import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  turbopack: { root: process.cwd() },
  outputFileTracingExcludes: { "/*": ["./.env*", "./.secrets/**", "./.git/**", "./extension/bridge-config.js"] },
};

export default nextConfig;
