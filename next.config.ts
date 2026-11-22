import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  /* config options here */
  cacheComponents: true,
  partialPrefetching: true,
  // Compose uploads attachments through a server action (MAX_ATTACHMENT_BYTES defaults to 25 MiB).
  experimental: { serverActions: { bodySizeLimit: "30mb" } },
  turbopack: {
    rules: {
      "*.css": {
        loaders: ["@tailwindcss/turbopack"],
        as: "*.css",
      },
    },
  },
  // Sign-in lives at `/`; keep `/login` as a permanent alias.
  async redirects() {
    return [{ source: "/login", destination: "/", permanent: true }];
  },
};

export default nextConfig;
