// Static export: the game is client-only, so `next build` writes a plain site to out/.
// BASE_PATH lets the same build be hosted under a sub-path, e.g.
//   BASE_PATH=/play/gravity-wars npm run build
// Normalised to "/a/b" (Next rejects a trailing slash); empty means site root.
const rawBase = (process.env.BASE_PATH ?? "").replace(/^\/+|\/+$/g, "")
const basePath = rawBase ? `/${rawBase}` : ""

/** @type {import('next').NextConfig} */
const nextConfig = {
  output: "export",
  basePath,
  // Always defined so Next inlines it; empty in normal builds, which lets the minifier drop the
  // debug hook in app/components/GameView.tsx entirely. Set NEXT_PUBLIC_GW_DEBUG=1 to keep it.
  env: {
    NEXT_PUBLIC_GW_DEBUG: process.env.NEXT_PUBLIC_GW_DEBUG ?? "",
    // Empty in every normal build. A loopback API base here turns on the local verified-run
    // experiment; without it the page is byte-for-byte the game it was.
    NEXT_PUBLIC_GW_CHALLENGE_API: process.env.NEXT_PUBLIC_GW_CHALLENGE_API ?? "",
  },
  trailingSlash: true,
  eslint: {
    ignoreDuringBuilds: true,
  },
  images: {
    unoptimized: true,
  },
}

export default nextConfig
