# Development stack

> Everything you need to run Newsdesk locally with real data flowing through it.
>
> Companion documents: [`stringers.md`](./stringers.md) (how to file),
> [`../ARCHITECTURE.md`](../ARCHITECTURE.md) (the model).

---

## What you need first

**A Beacon MCP aggregator running on your machine at `http://localhost:3000/mcp/`.**

The dev stack does **not** start one, and never will: inference and delivery living outside the app
is the whole design, so the stack that develops it should not quietly bundle them. Newsdesk reaches
your Beacon from inside Docker via `host.docker.internal`, which the compose file wires up.

Two things to know about that URL:

- **The trailing slash matters.** `/mcp` answers `307` to `/mcp/`. Configure `/mcp/` and skip the
  redirect entirely.
- **Check what your Beacon actually aggregates.** A local Beacon typically carries `claude-code` and
  `chrome-devtools`, which is enough for the **inference** port. It usually has no `discord-mcp` or
  `telegram-mcp`, so there is **no real publish target in dev** — see [Limits](#limits) below.

Verify it before starting anything:

```bash
curl -sL -X POST http://localhost:3000/mcp/ \
  -H 'content-type: application/json' \
  -H 'accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"probe","version":"0"}}}' \
  | head -c 400
```

You should see a `serverInfo` naming the aggregator and an `instructions` block listing its servers.

## Running it

```bash
docker compose -f deploy/dev/docker-compose.dev.yml up --build
```

| Service | Where | What |
|---|---|---|
| `web` | http://localhost:5173 | Vite dev server, hot reload, proxies `/api` to `api` |
| `api` | http://localhost:8080 | Fastify under `tsx watch`, hot reload |
| `korben` | — | files korben.info as a `timeline` submission every 15 minutes |

Filed material flows straight through: ingest trims it, the managing editor opens stories and proposes
routes, the writer drafts one piece per route, and each draft waits for you at **Review**. Nothing
reaches a destination without an explicit approval of that exact payload.

Sign in with **`newsdesk`** (override with `NEWSDESK_ADMIN_PASSWORD`). The ingest token is fixed to
`dev-ingest-token` (override with `NEWSDESK_INGEST_TOKEN`) so the stringer can be configured from
the same compose file.

Source is bind-mounted, so editing `server/src` or `web/src` reloads in place. `node_modules` lives
in an anonymous volume — dependencies are installed **in the image**, so the native `better-sqlite3`
binding matches the container rather than your machine.

If `8080` or `5173` are already taken, publish elsewhere:

```bash
API_PORT=8181 WEB_PORT=5174 docker compose -f deploy/dev/docker-compose.dev.yml up
```

> **File watching uses polling, on purpose.** A bind mount backed by a Windows filesystem delivers
> file *contents* to the container but not inotify *events*, so `tsx watch` and Vite see the new
> bytes and never notice they arrived — edits appear to do nothing. Both services therefore run with
> `CHOKIDAR_USEPOLLING=true`. It costs a little CPU; if your mount delivers events natively, set
> `CHOKIDAR_USEPOLLING=false` and hot reload will still work.

### Resetting

```bash
docker compose -f deploy/dev/docker-compose.dev.yml down -v   # drops the database
```

`deploy/dev/config.yaml` is seeded on **first boot only**. After that the database is the source of
truth and the file is ignored, so a stale file can never compete with a target you edited in the UI.
Change the seed and want it applied? `down -v` and start again.

### After changing a dependency

`package.json` changes need the image rebuilt **and the `node_modules` volume replaced**:

```bash
docker compose -f deploy/dev/docker-compose.dev.yml up -d --build --renew-anon-volumes
```

> **`--build` on its own is not enough**, and this will cost you twenty minutes if you let it.
> `node_modules` lives in an anonymous volume, and Compose *carries anonymous volumes over* when it
> recreates a container. So the image gets the new dependency, the container keeps the old volume
> mounted on top of it, and the module stays missing — with a `Cannot find module` that looks
> exactly like a broken install. `--renew-anon-volumes` drops that volume; the named `dev-data`
> volume, and therefore the database, is untouched.

## Watching it work

Open **Wire** (http://localhost:5173/wire). Within a minute of first start you should see one
korben submission with an outcome like *"baseline: considered the most recent entry, skipped 14
older"*. Fifteen minutes later, a second one saying *"nothing newer than …"* — the watermark doing
its job, and proof that a stringer re-sending its whole window costs nothing.

Filing something by hand, without waiting for the poller:

```bash
curl -s -X POST http://localhost:8080/api/v1/submissions \
  -H 'Authorization: Bearer dev-ingest-token' -H 'Content-Type: application/json' \
  -d '{"stringer_id":"github-appstore","kind":"report","text":"WireGuardEasyHost v15.3.0 shipped. Adds one-click client QR export."}'
```

More recipes in [`stringers.md`](./stringers.md).

## The n8n profile

The korben container is the default stringer because a stringer is one HTTP POST, and making the
daily loop depend on a container whose workflow lives in a UI rather than in git buys nothing while
you are iterating on prompts. But the production shape *is* n8n, so it is one flag away:

```bash
docker compose -f deploy/dev/docker-compose.dev.yml --profile n8n up
```

Then at http://localhost:5678:

1. **Import from File** → `deploy/dev/n8n/korben-stringer.json` (mounted at `/workflows` in the
   container).
2. Check the HTTP Request node: it posts to `http://api:8080/api/v1/submissions` with
   `Authorization: Bearer dev-ingest-token`. Both are reachable from inside the compose network.
3. **Execute Workflow** once to see it land in the Wire, then activate it if you want it on a
   schedule.

Stop the built-in poller while testing n8n, or the two will interleave and the watermark will make
whichever runs second look like it did nothing:

```bash
docker compose -f deploy/dev/docker-compose.dev.yml stop korben
```

The two paths fulfil the **same contract**, so nothing downstream can tell them apart. That is the
point of the exercise: prove the production path, then go back to the fast one.

## Inference

The desk's thinking runs through `claude-code__query_claude` on your Beacon. **That instance has to
be logged in.** If it is not, every managing editor, writer and assistant call comes back with the string
`Not logged in · Please run /login` — which parses as "no JSON found" and fails the job rather than
saying anything about auth.

Check it before blaming the desk:

```bash
curl -sL -X POST http://localhost:3000/mcp/ \
  -H 'content-type: application/json' -H 'accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"claude-code__query_claude","arguments":{"prompt":"reply with OK"}}}' \
  | tail -c 200
```

Log in as the user the MCP server runs as — for the `claude-code-container` stack that is the
`claude` user, via the web terminal on <http://localhost:8080> or
`docker exec -it -u claude claude-code claude`. A root login persists to a different home and leaves
`query_claude` still unauthenticated.

## Limits

Honest account of what this stack cannot do yet:

- **No real publish target — but a local sink stands in.** A local Beacon has no `discord-mcp`, so
  the `discord-test` target cannot actually send. `deploy/dev/config.yaml` therefore also configures
  a `local-sink` target on the `builtin` driver: approval, payload freeze, the ledger and the event
  log all behave exactly as they would against Discord, and the payload is recorded in the
  `PUBLISHED` event for inspection. It is the whole path minus the press.
- **No real Android install or push.** Both need HTTPS. Everything up to that works on `localhost`
  (which counts as a secure context), so the service worker registers and a subscription can be
  made, but verifying a real notification on a phone needs the deployed `nsl.sh` instance.
- **The dev UI is reachable only by a hostname Vite accepts.** `allowedHosts: true` is set in
  `web/vite.config.ts` so a container or LAN name works; without it Vite answers
  `Blocked request. This host is not allowed`.

## Troubleshooting

| Symptom | Cause |
|---|---|
| `/healthz` shows the endpoint `unreachable` | no Beacon on `localhost:3000`, or it is bound to `127.0.0.1` only and not reachable via `host.docker.internal` |
| `/healthz` shows `error: HTTP 307` | the endpoint URL is missing its trailing slash — use `/mcp/` |
| korben logs `newsdesk responded 401` | the token in `config.yaml`'s consumer and `NEWSDESK_INGEST_TOKEN` disagree, or it was rotated in the UI |
| korben logs `422 … unknown source "korben"` | the seed config did not import — check the `api` logs on first boot, then `down -v` and retry |
| Wire empty and korben quiet | it waits for `/healthz` before its first run; check `docker compose … logs korben` |
| Native module errors on start | `node_modules` leaked in from the host — `down -v` and rebuild |
| `Cannot find module` after adding a dependency | the anonymous `node_modules` volume survived the rebuild — add `--renew-anon-volumes` |
| Every job fails with "no JSON object found" | the `claude-code` behind your Beacon is not logged in — see [Inference](#inference) |
| `Blocked request. This host … is not allowed` | Vite is rejecting the Host header — `allowedHosts` in `web/vite.config.ts` |
| Edits do nothing, no restart logged | file watching is not firing — confirm `CHOKIDAR_USEPOLLING=true` reached the container |
| `failed to bind host port … address already in use` | something already owns `8080` or `5173` — set `API_PORT` / `WEB_PORT` |
