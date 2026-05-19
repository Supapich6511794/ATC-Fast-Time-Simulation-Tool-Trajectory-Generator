/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // Keep `next build` and `next dev` in SEPARATE output dirs. They both
  // write to `.next` by default, so running a build while the dev server
  // is live corrupts its webpack chunks (MODULE_NOT_FOUND './xxx.js').
  // The `build` npm script sets NEXT_DIST_DIR=.next-build; dev uses `.next`.
  distDir: process.env.NEXT_DIST_DIR || ".next",
};

export default nextConfig;
