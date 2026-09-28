import type { NextConfig } from 'next';
import path from 'node:path';

const nextConfig: NextConfig = {
  reactStrictMode: true,
  transpilePackages: ['@avg/contracts'],
  images: { unoptimized: true },
  // Self-contained server bundle for the container image (docker/web.Dockerfile); the
  // tracing root is the monorepo so workspace packages are included.
  output: 'standalone',
  outputFileTracingRoot: path.join(__dirname, '../../'),
};

export default nextConfig;
