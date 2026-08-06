import type { NextConfig } from "next";

const nextConfig: NextConfig = {
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
