import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

// The SPA is built into server/public and served by Fastify from the same
// container and port. In dev, /api is proxied to the server process — which
// lives in a sibling container in the dev stack, hence the override.
const apiTarget = process.env.VITE_API_TARGET ?? 'http://localhost:8080'
const usePolling = process.env.CHOKIDAR_USEPOLLING === 'true'

export default defineConfig({
  plugins: [react(), tailwindcss()],
  build: {
    outDir: '../server/public',
    emptyOutDir: true,
  },
  server: {
    port: 5173,
    // Reachable from outside the container in the dev stack.
    host: true,
    // Bind mounts backed by a Windows filesystem deliver file contents but not
    // inotify events, so watching silently never fires. Polling is the fix;
    // it costs CPU, so it is opt-in via the environment.
    ...(usePolling ? { watch: { usePolling: true, interval: 500 } } : {}),
    proxy: {
      '/api': { target: apiTarget, changeOrigin: true },
      '/healthz': { target: apiTarget, changeOrigin: true },
    },
  },
})
