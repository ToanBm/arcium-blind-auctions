import type { NextConfig } from "next";

const emptyShim = "./src/shims/node-empty.js";

const nextConfig: NextConfig = {
  turbopack: {
    resolveAlias: {
      fs: emptyShim,
      net: emptyShim,
      tls: emptyShim,
      "node:fs": emptyShim,
      "node:net": emptyShim,
      "node:tls": emptyShim,
    },
  },
};

export default nextConfig;
