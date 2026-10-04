import type { NextConfig } from "next";
import path from "node:path";

const nextConfig: NextConfig = {
  turbopack: { root: path.resolve(process.cwd(), "..") },
  outputFileTracingRoot: path.resolve(process.cwd(), ".."),
  outputFileTracingExcludes: { "/*": ["./.env*", "../.env*", "../.secrets/**", "../.git/**", "../.release/**", "../extension/bridge-config.js"] },
};

export default nextConfig;
