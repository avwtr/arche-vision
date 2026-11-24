import path from 'node:path'
import { fileURLToPath } from 'node:url'
import type { NextConfig } from 'next'

const root = path.dirname(fileURLToPath(import.meta.url))

const nextConfig: NextConfig = {
  poweredByHeader: false,
  images: { unoptimized: true },
  // This repository is its own app. Keep tracing and Turbopack rooted here.
  turbopack: { root },
  outputFileTracingRoot: root,
  agentRules: false,
}

export default nextConfig
