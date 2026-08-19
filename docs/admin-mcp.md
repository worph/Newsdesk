# Administering the desk over MCP

> The configuration surface as an MCP server, so an agent can hold the charter, the outlets and the
> rest of the settings — with the same validation and the same way back the Configuration screen has.
>
> Companion documents: [`dev-stack.md`](./dev-stack.md) (running it locally),
> [`../ARCHITECTURE.md`](../ARCHITECTURE.md) (the model).

---

## What it is

Newsdesk already speaks MCP as a **client** — inference and delivery both go out that way. This is
the same protocol pointed inward: `POST /mcp` is a stateless MCP server whose tools are the desk's
own administration.

Every tool is a thin wrapper over `server/src/config/store.ts`, deliberately. That module validates
the whole document on every write, takes a restore point before it, and refuses to delete a
stringer that has filed or an outlet that has published. An agent driving the desk gets all of
that, including the undo. A tool that reached past it to the tables would be a second definition of
what a valid desk is, and the first one to drift.

## Filing a tip

One tool is not administration: `file_tip` puts an article idea on the wire, as the tip line does.

It earns its place because a tip is **ingest**. It creates work for a human — the idea is stored,
judged against the charter like any filing, and drafted only if it is worth running — and it
publishes nothing. It also grants nothing new: `get_settings` already returns the ingest token, so a
caller holding the administration token could already file by POSTing to `/api/v1/filings`. The tool
just saves the round trip.

It names a stringer only when it has to. One tip stringer and the desk picks it; several and it asks
which — the same rule `POST /api/v1/tips` follows, from the same function.

## What it cannot do

**It cannot approve, publish or spike — and this is now something the code enforces rather than
something the list happens not to contain.** The administrator chat gained those three tools
(`admin-chat.md` §4.3); they are marked `chatOnly` and `admin/tools.ts` filters them out of this
server. The reason is the gate: what makes them safe there is an operator typing a confirmation, and
there is nobody on the other end of an MCP call to type it. A copy of them here would be the same
decisions with the safety removed, reachable by every agent that can see this desk's Beacon.

**So: this surface cannot approve, publish or spike.** A human between every draft and every channel is the
product, not a setting — an administration surface that could send would delete the one guarantee
the whole design exists to make. Editorial content is not readable through it either. This is
configuration and diagnostics.

Three things are genuinely out of reach, because they need a browser a server does not have:

- **authorising an MCP endpoint over OAuth** — the desk cannot follow the authorization URL itself,
  which is the whole reason that flow is interactive (`server/src/ports/mcp/oauth.ts`)
- **signing the publishing browser into a destination** — that is a real Chrome profile
- **changing the desk password** — it needs the current one

## The tools

**Reading**

| Tool | What it answers |
|---|---|
| `get_config` | the whole configuration as YAML, plus its current validation issues. Start here |
| `get_charter` | the charter alone, when that is what you are working on |
| `validate_config` | would this document be accepted? Touches nothing |
| `list_config_versions` | the restore points, newest first |
| `get_config_version` | one of them, in full |
| `preview_restore` | what restoring it would change, refuse, and lose for good |
| `get_settings` | timezone, the ingest token, registered push devices |
| `get_status` | version, whether the desk is configured, and a live probe of every endpoint |
| `read_log` | the operations log, filterable by level, category and substring |

**Writing one entry at a time** — the safe path, and the one to prefer:

`set_charter` · `upsert_voice` · `upsert_stringer` · `upsert_outlet` · `upsert_mcp_endpoint` ·
`upsert_browser_engine` · `remove_config_entry` · `set_reporting` · `set_timezone`

Each of these reads the configuration, changes the one thing named, and writes it back. **That
read-modify-write is the point.** `writeConfig` replaces the whole document and deletes anything
absent from it, so a tool that asked a model to restate the configuration in order to change one
outlet would make a truncated answer indistinguishable from a deletion. Here the model supplies only
the entry it means to change, and the rest of the document is the server's own reading of the
database — which cannot be truncated.

The input schemas are the real ones: `outletSchema`, `voiceSchema` and the rest come straight from
`shared/src/config.ts`, so the tool schema and the validator can never disagree.

**Writing the whole document** — the escape hatch:

`write_config` takes a complete YAML document and `restore_config_version` puts a stored one back.
Both are marked destructive, `write_config` requires a reason, and both take a restore point before
they touch anything. Nothing in the configuration is unreachable, because these two take all of it.

## Refusals

A rejected write comes back as a tool error carrying **a path per problem**, not a flattened
message — the same `ConfigIssue[]` the Configuration screen renders. A model can fix the field the
path names and call again, which is why `validate_config` exists beside `write_config`. Nothing is
written on a refusal: `writeConfig` validates before it opens the transaction.

Every write is recorded twice: as a `CONFIG_CHANGED` row in the operations log saying an MCP client
made the change, and as a configuration version authored `mcp` carrying the reason given.

## The token

Authentication is a bearer on `Authorization`, checked in constant time against the
`admin_mcp_token` setting. Not the session cookie — the caller is a sidecar, not a browser.

**It is deliberately not the ingest token.** That one is pasted into every stringer workflow in
n8n; sharing it here would promote every stringer to an administrator of the desk that reads it.

There is always a token: one is generated the first time it is read, so the endpoint is never
accidentally open. Read it under **Settings**, or pin it from the compose file with
`NEWSDESK_MCP_TOKEN` — which is what lets both containers below agree on a value neither of them
had to invent.

Rotating it from Settings takes effect immediately, and the sidecar starts getting 401s until it is
given the new one. That is why the rotation is logged as a warning.

## Wiring it to Beacon

Discovery is UDP multicast, so an MCP server does not register with Beacon — Beacon probes the
network and servers answer. A [beaconify](https://github.com/worph/beaconify) sidecar does that part:
it answers the probe, fetches the desk's tool catalog over JSON-RPC, and proxies `/mcp` through,
adding the `Authorization` header on the way.

```yaml
newsdesk-mcp:
  image: ghcr.io/worph/beaconify:latest
  environment:
    BEACONIFY_NAME: newsdesk
    BEACONIFY_DESCRIPTION: "Newsdesk administration — charter, outlets, config history and health."
    BEACONIFY_UPSTREAM_URL: "http://newsdesk-backend:8080/mcp"
    BEACONIFY_AUTH: "Bearer ${NEWSDESK_MCP_TOKEN}"
  networks: [pcs]
```

Two things decide whether it works:

- **The sidecar must sit on a network Beacon actually probes.** Being routable to Beacon is not
  enough — discovery is multicast. On a Yundera box that is `pcs`; a stock Beacon stack uses its own
  `mcp-net`, in which case add that network too.
- **The token never travels in the announce manifest.** Beaconify does not use Beacon's `auth`
  announce field: Beacon calls the sidecar, and the sidecar calls the desk with the header. The
  credential stays inside the compose stack, which matters because any container that can send a
  discovery packet gets the manifest.

Once discovered, the tools appear through Beacon's meta-tools as `newsdesk__get_config` and so on.

## Reaching it directly

`POST /mcp` is on the backend, so anything on the container network can call it with the token:

```bash
curl -sL -X POST http://newsdesk-backend:8080/mcp \
  -H "authorization: Bearer $NEWSDESK_MCP_TOKEN" \
  -H 'content-type: application/json' \
  -H 'accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}'
```

**Not from the public URL.** On Yundera the desk sits behind an AppShield SSO sidecar, which answers
a token-authenticated POST with a login redirect rather than an MCP response — the same trap the
ingest endpoint has, and the reason stringers are told to use the internal address too.

## One trap worth naming

If this server is registered in the same Beacon aggregator the desk uses for its **own** inference,
the managing editor gains the ability to rewrite the charter it is being judged against. The desk
would then be grading itself against a policy it can edit. Keep the two apart, or know that you
have not.

## The trust boundary

A caller holding this token can rewrite the charter, repoint every outlet and delete configuration.
The sidecar should be the only thing on the mesh network that has it. Beacon itself authenticates
nothing and trusts every announcement on its network unconditionally — which is fine for a local
discovery protocol and is exactly why neither Beacon nor that network should be exposed to anything
untrusted.
