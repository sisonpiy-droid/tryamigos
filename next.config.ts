import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  /* The service worker is fetched fresh every time: a cached old one keeps
     showing notifications the old way, and nothing would ever replace it. */
  async headers() {
    return [
      {
        source: "/sw.js",
        headers: [
          { key: "Content-Type", value: "application/javascript; charset=utf-8" },
          { key: "Cache-Control", value: "no-cache, no-store, must-revalidate" },
        ],
      },
    ];
  },
};

export default nextConfig;
