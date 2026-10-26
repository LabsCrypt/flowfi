import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Emit a self-contained server bundle (`.next/standalone`) carrying only the
  // traced production dependencies. The production Docker image copies this
  // instead of the full `.next` tree + node_modules, keeping the runtime image
  // small (issue #1335).
  output: "standalone",
  // The workspace root lives one level above this directory. Pinning it here
  // prevents Turbopack from inferring a wrong root when stray package-lock
  // files exist outside the repo (e.g. ~/package-lock.json).
  //
  // This must be computed without importing node:path or using __dirname:
  // next.config.ts is compiled to next.config.compiled.js and evaluated by
  // string-compilation, so references to imported identifiers or __dirname
  // can fail at load time when the emitted form isn't CJS (see earlier CI
  // failures: "ReferenceError: path is not defined" after an import was
  // lost in a merge, and "Fix Turbopack Windows path canonicalization"
  // 9f067dd which removed the import entirely). process.cwd() and the
  // global URL constructor work in every evaluation context and platform.
  turbopack: {
    root: new URL("../", `file://${process.cwd()}/`).pathname,
  },
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
