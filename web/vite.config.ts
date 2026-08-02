import { defineConfig, type ProxyOptions } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

// The SPA is built into server/public and served by Fastify from the same
// container and port. In dev, /api is proxied to the server process — which
// lives in a sibling container in the dev stack, hence the override.
const apiTarget = process.env.VITE_API_TARGET ?? 'http://localhost:8080'
const usePolling = process.env.CHOKIDAR_USEPOLLING === 'true'

/**
 * Say why the proxy could not reach the API, in the shape the client already
 * understands.
 *
 * A proxy failure is not a server error, but from the browser it looks exactly
 * like one: Vite's own handler answers 500 with an empty body, and `request()`
 * in src/api.ts then falls back to the status text. So a click made during the
 * couple of seconds `tsx watch` takes to restart the API surfaces as "Internal
 * Server Error" — which sends you reading the handler that never ran, instead
 * of clicking again.
 *
 * `{ error }` is the error envelope the whole API uses, so whatever is put here
 * reaches the screen verbatim.
 *
 * Registered through `configure`, which Vite calls *before* installing its own
 * error handler: ours writes first, and Vite's then finds the response already
 * ended and only logs it to the terminal.
 */
const explainProxyErrors: ProxyOptions['configure'] = (proxy) => {
  proxy.on('error', (err, _req, res) => {
    // A websocket failure arrives here with a raw socket in place of a response.
    if (!('writeHead' in res) || res.headersSent || res.writableEnded) return

    const refused = (err as Error & { code?: string }).code === 'ECONNREFUSED'
    res.writeHead(503, { 'Content-Type': 'application/json' }).end(
      JSON.stringify({
        error: refused
          ? 'The API is not accepting connections — it is most likely restarting after a file change. Try again in a moment.'
          : `Could not reach the API: ${err.message}`,
      }),
    )
  })
}

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
    // `host: true` binds the port but Vite still rejects any Host header it
    // does not recognise, so reaching the dev server by container hostname or
    // LAN name fails with "This host is not allowed". Dev only — the built SPA
    // is served by Fastify and never sees this.
    allowedHosts: true,
    // Bind mounts backed by a Windows filesystem deliver file contents but not
    // inotify events, so watching silently never fires. Polling is the fix;
    // it costs CPU, so it is opt-in via the environment.
    ...(usePolling ? { watch: { usePolling: true, interval: 500 } } : {}),
    proxy: {
      /**
       * `ws` matters for exactly one route and is invisible until you hit it:
       * the noVNC viewer opens a websocket at
       * `/api/v1/browser/vnc/websockify`, and without this Vite answers the
       * upgrade itself and the viewer sits on "connecting" forever with
       * nothing in any log. Production never comes through here — Fastify
       * serves the built SPA and the proxy on one port.
       */
      '/api': { target: apiTarget, changeOrigin: true, ws: true, configure: explainProxyErrors },
      '/healthz': { target: apiTarget, changeOrigin: true, configure: explainProxyErrors },
    },
  },
})
