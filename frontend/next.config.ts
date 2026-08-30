import type { NextConfig } from "next";

const nextConfig: NextConfig = {
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
