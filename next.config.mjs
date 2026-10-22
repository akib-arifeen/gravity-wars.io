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
  trailingSlash: true,
  eslint: {
    ignoreDuringBuilds: true,
  },
  images: {
    unoptimized: true,
  },
}

export default nextConfig
