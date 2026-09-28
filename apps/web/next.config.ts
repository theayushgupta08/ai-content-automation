import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  reactStrictMode: true,
  transpilePackages: ['@avg/contracts'],
  images: { unoptimized: true },
};

export default nextConfig;
