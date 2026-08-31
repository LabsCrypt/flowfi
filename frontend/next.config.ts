import path from "node:path";
import type { NextConfig } from "next";

const nextConfig: NextConfig = {
<<<<<<< HEAD
  // The workspace root lives one level above this directory. Pinning it here
  // prevents Turbopack from inferring a wrong root when stray package-lock
  // files exist outside the repo (e.g. ~/package-lock.json).
  turbopack: {
    root: path.join(path.dirname(new URL(import.meta.url).pathname), ".."),
  },
=======
  output: 'standalone',
>>>>>>> 90c0dc1 (docker: optimize backend/frontend images for #1335 (non-root, healthchecks, size reduction - see PR description for details))
  // Enable tree-shaking for icon/utility libraries to reduce per-route
  // bundle sizes (Issue #1254).
  experimental: {
    optimizePackageImports: [
      "lucide-react",
      "@tanstack/react-query",
      "@tanstack/react-virtual",
    ],
  },
  async redirects() {
    return [
      {
        // Redirect legacy duplicated route `/streams/streams/:streamId` → `/streams/:id`
        // See: https://github.com/LabsCrypt/flowfi/issues/1084
        source: "/streams/streams/:streamId",
        destination: "/streams/:streamId",
        permanent: true,
      },
    ];
  },
};

export default nextConfig;
