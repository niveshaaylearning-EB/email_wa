import type { NextConfig } from "next";

// cacheComponents/partialPrefetching are intentionally disabled: every screen in this
// internal tool is authenticated and reads live PostgreSQL state, so per-request
// rendering is the correct default and avoids stale compliance-relevant data.
const securityHeaders = [
  { key: "X-Frame-Options", value: "DENY" },
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=()" },
  { key: "Strict-Transport-Security", value: "max-age=63072000; includeSubDomains; preload" },
];

const nextConfig: NextConfig = {
  poweredByHeader: false,
  serverExternalPackages: ["argon2", "bullmq", "ioredis", "embedded-postgres"],
  turbopack: {
    rules: {
      "*.css": {
        loaders: ["@tailwindcss/turbopack"],
        as: "*.css",
      },
    },
  },
  async headers() {
    return [
      { source: "/:path*", headers: securityHeaders },
      // Archived-template preview is framed by the app itself (sandboxed iframe, script-free CSP).
      { source: "/api/v1/salesforce/assets/:id/preview", headers: [{ key: "X-Frame-Options", value: "SAMEORIGIN" }] },
      { source: "/api/v1/salesforce/emails/:id/preview", headers: [{ key: "X-Frame-Options", value: "SAMEORIGIN" }] },
    ];
  },
};

export default nextConfig;
