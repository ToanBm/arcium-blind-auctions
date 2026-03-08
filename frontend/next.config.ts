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
  webpack: (config) => {
    config.resolve.fallback = {
      ...config.resolve.fallback,
      fs: false,
      net: false,
      tls: false,
    };
    return config;
  },
};

export default nextConfig;
