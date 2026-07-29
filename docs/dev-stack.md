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

`package.json` changes need the image rebuilt, because dependencies are baked in:

```bash
docker compose -f deploy/dev/docker-compose.dev.yml up --build
```

## Watching it work

Open **Inbox** (http://localhost:5173/inbox). Within a minute of first start you should see one
korben submission with an outcome like *"baseline: considered the most recent entry, skipped 14
older"*. Fifteen minutes later, a second one saying *"nothing newer than …"* — the watermark doing
its job, and proof that a stringer re-sending its whole window costs nothing.

Filing something by hand, without waiting for the poller:

```bash
curl -s -X POST http://localhost:8080/api/v1/submissions \
  -H 'Authorization: Bearer dev-ingest-token' -H 'Content-Type: application/json' \
  -d '{"source_id":"github-appstore","kind":"report","text":"WireGuardEasyHost v15.3.0 shipped. Adds one-click client QR export."}'
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
3. **Execute Workflow** once to see it land in the Inbox, then activate it if you want it on a
   schedule.

Stop the built-in poller while testing n8n, or the two will interleave and the watermark will make
whichever runs second look like it did nothing:

```bash
docker compose -f deploy/dev/docker-compose.dev.yml stop korben
```

The two paths fulfil the **same contract**, so nothing downstream can tell them apart. That is the
point of the exercise: prove the production path, then go back to the fast one.

## Limits

Honest account of what this stack cannot do yet:

- **No real publish target.** A local Beacon has no `discord-mcp`, and delivery is not implemented
  until Phase 3 anyway. `deploy/dev/config.yaml` configures a `discord-test` target so the director
  has somewhere to route stories and the writer has slots to fill, but nothing can actually be sent.
  A local payload sink is the natural way to close this once the delivery port exists.
- **`claude-code` is effectively single-session.** Overlapping calls answer `409`. The job queue
  handles it with backoff, so work waits rather than failing — but prompt iteration in dev is
  serialised, and that is expected rather than broken.
- **No PWA.** Install, push and the share target arrive in Phase 5. The Idea box already accepts the
  share-target query parameters (`/ideas?url=…&text=…`), so that path can be exercised by hand.

## Troubleshooting

| Symptom | Cause |
|---|---|
| `/healthz` shows the endpoint `unreachable` | no Beacon on `localhost:3000`, or it is bound to `127.0.0.1` only and not reachable via `host.docker.internal` |
| `/healthz` shows `error: HTTP 307` | the endpoint URL is missing its trailing slash — use `/mcp/` |
| korben logs `newsdesk responded 401` | the token in `config.yaml`'s consumer and `NEWSDESK_INGEST_TOKEN` disagree, or it was rotated in the UI |
| korben logs `422 … unknown source "korben"` | the seed config did not import — check the `api` logs on first boot, then `down -v` and retry |
| Inbox empty and korben quiet | it waits for `/healthz` before its first run; check `docker compose … logs korben` |
| Native module errors on start | `node_modules` leaked in from the host — `down -v` and rebuild |
| Edits do nothing, no restart logged | file watching is not firing — confirm `CHOKIDAR_USEPOLLING=true` reached the container |
| `failed to bind host port … address already in use` | something already owns `8080` or `5173` — set `API_PORT` / `WEB_PORT` |
