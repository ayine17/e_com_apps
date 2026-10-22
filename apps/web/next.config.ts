import type { NextConfig } from "next";

const API_URL = process.env.API_URL ?? "http://localhost:4000";
if (process.env.NODE_ENV === "production" && !process.env.API_URL) {
  console.warn("\n⚠ API_URL is not set: the deployed site will proxy /api to localhost and every request will fail.\n  Set API_URL to your API's public URL in the build environment.\n");
}
const isDev = process.env.NODE_ENV !== "production";

// Strict Content Security Policy (spec section 8.3). Next's dev server needs eval for hot reload.
const csp = [
  "default-src 'self'",
  `script-src 'self' 'unsafe-inline'${isDev ? " 'unsafe-eval'" : ""}`,
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self'",
  "connect-src 'self'",
  "frame-ancestors 'none'",
  "base-uri 'self'",
  "form-action 'self'",
].join("; ");

const config: NextConfig = {
  // The browser only ever talks to this origin; the API sits behind it, so session cookies are first-party.
  async rewrites() {
    return [
      { source: "/api/:path*", destination: `${API_URL}/api/:path*` },
      { source: "/uploads/:path*", destination: `${API_URL}/uploads/:path*` },
    ];
  },
  async headers() {
    return [
      {
        source: "/:path*",
        headers: [
          { key: "Content-Security-Policy", value: csp },
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
          { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=(self)" },
          ...(isDev ? [] : [{ key: "Strict-Transport-Security", value: "max-age=63072000; includeSubDomains" }]),
        ],
      },
    ];
  },
};

export default config;
