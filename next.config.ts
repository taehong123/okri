import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Node standalone is the default delivery path. `sites` remains an explicit
  // rollback-only build mode while data cutover is being verified.
  output: process.env.OKRI_RUNTIME === "sites" ? undefined : "standalone",
};

export default nextConfig;
