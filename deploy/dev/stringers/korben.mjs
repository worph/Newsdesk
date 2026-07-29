#!/usr/bin/env node
/**
 * A stringer, in about sixty lines.
 *
 * Polls an RSS feed and files what it finds as a `timeline` submission. It
 * keeps NO state: no cursor, no last-seen id, no dedup table. It re-sends its
 * whole window every run and lets the desk work out what is new — that is what
 * lets a stringer stay dumb, and it is the same contract the n8n workflow in
 * ../n8n/korben-stringer.json fulfils.
 *
 * It also does not judge. Everything in the window is filed; the charter
 * decides what is newsworthy, in one place, inside the app.
 */

import { parseFeed, toTimeline } from './rss.mjs'

const NEWSDESK_URL = process.env.NEWSDESK_URL ?? 'http://localhost:8080'
const TOKEN = process.env.NEWSDESK_INGEST_TOKEN ?? 'dev-ingest-token'
const SOURCE_ID = process.env.SOURCE_ID ?? 'korben'
const FEED_URL = process.env.FEED_URL ?? 'https://korben.info/feed'
const INTERVAL_MS = Number(process.env.INTERVAL_SECONDS ?? 900) * 1000
const MAX_ITEMS = Number(process.env.MAX_ITEMS ?? 15)

const log = (...args) => console.log(new Date().toISOString(), '[korben]', ...args)

async function fileOnce() {
  const response = await fetch(FEED_URL, {
    headers: { 'user-agent': 'newsdesk-dev-stringer/0.1 (+https://github.com/worph/Newsdesk)' },
    signal: AbortSignal.timeout(20_000),
  })
  if (!response.ok) throw new Error(`feed responded ${response.status}`)

  const items = parseFeed(await response.text())
  if (items.length === 0) {
    log('feed parsed but held no dated items — not filing')
    return
  }

  const filed = await fetch(`${NEWSDESK_URL}/api/v1/submissions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${TOKEN}` },
    body: JSON.stringify({
      source_id: SOURCE_ID,
      kind: 'timeline',
      text: toTimeline(items, { maxItems: MAX_ITEMS }),
    }),
    signal: AbortSignal.timeout(20_000),
  })

  const body = await filed.text()
  if (!filed.ok) throw new Error(`newsdesk responded ${filed.status}: ${body}`)

  const result = JSON.parse(body).results?.[0]
  log(`filed ${Math.min(items.length, MAX_ITEMS)} entries →`, result?.note ?? body)
}

async function waitForDesk() {
  for (let attempt = 0; attempt < 60; attempt++) {
    try {
      if ((await fetch(`${NEWSDESK_URL}/healthz`, { signal: AbortSignal.timeout(3000) })).ok) return
    } catch {
      /* not up yet */
    }
    await new Promise((resolve) => setTimeout(resolve, 2000))
  }
  throw new Error(`newsdesk never became reachable at ${NEWSDESK_URL}`)
}

log(`starting — ${FEED_URL} → ${NEWSDESK_URL} as "${SOURCE_ID}" every ${INTERVAL_MS / 1000}s`)
await waitForDesk()

for (;;) {
  try {
    await fileOnce()
  } catch (error) {
    // A failed run is not fatal: the next one re-sends the same window, so
    // nothing is lost to a transient failure.
    log('run failed —', error instanceof Error ? error.message : error)
  }
  await new Promise((resolve) => setTimeout(resolve, INTERVAL_MS))
}
