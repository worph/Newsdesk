/**
 * Cheap deterministic work done BEFORE any inference, purely to keep the
 * expensive judgement small. None of this is a deduplication authority — that
 * is the director's job, semantically, because the same story can arrive
 * through a different door with different wording and no shared identifier.
 * This only avoids paying an LLM to re-read material it has already seen.
 *
 * See ARCHITECTURE.md section 4.1.
 */

export interface TrimResult {
  /** What the director will actually be given. Empty means "nothing new". */
  considered: string
  /** New watermark for a timeline source, when it advanced. */
  watermark?: string
  /** New stored snapshot for a snapshot source. */
  snapshot?: string
  /** Human-readable account of what happened, shown in the Inbox. */
  note: string
}

export interface TimelineEntry {
  at: string | null
  text: string
}

// Leading markdown decoration, then an ISO-ish date. Deliberately narrow:
// guessing at loose date formats produces silent mis-trimming, and a source
// whose dates we cannot read falls back to "consider everything" instead.
const DATE_LINE =
  /^\s*(?:[-*+]\s+|#{1,6}\s+|>\s+)?\[?(\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}(?::\d{2})?(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?)?)\]?/

function normalizeDate(raw: string): string | null {
  const iso = raw.includes('T') || !raw.includes(' ') ? raw : raw.replace(' ', 'T')
  const parsed = new Date(iso.length === 10 ? `${iso}T00:00:00Z` : iso)
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString()
}

/**
 * Split free text into dated entries. Text before the first dated line is the
 * preamble and is never dropped — it is usually a title or framing the
 * director needs to read the entries at all.
 */
export function parseTimeline(text: string): { preamble: string; entries: TimelineEntry[] } {
  const lines = text.split('\n')
  const preamble: string[] = []
  const entries: TimelineEntry[] = []
  let current: { at: string | null; lines: string[] } | null = null

  for (const line of lines) {
    const match = DATE_LINE.exec(line)
    const at = match?.[1] ? normalizeDate(match[1]) : null

    if (at) {
      if (current) entries.push({ at: current.at, text: current.lines.join('\n').trimEnd() })
      current = { at, lines: [line] }
    } else if (current) {
      current.lines.push(line)
    } else {
      preamble.push(line)
    }
  }
  if (current) entries.push({ at: current.at, text: current.lines.join('\n').trimEnd() })

  return { preamble: preamble.join('\n').trim(), entries }
}

function withPreamble(preamble: string, body: string): string {
  return preamble ? `${preamble}\n\n${body}` : body
}

export function trimTimeline(text: string, watermark: string | null): TrimResult {
  const { preamble, entries } = parseTimeline(text)

  if (entries.length === 0) {
    // Better to hand over everything than to silently drop a source whose date
    // format we do not recognise. Said out loud so it is visible in the Inbox.
    return { considered: text, note: 'no dated entries recognised — considered the whole submission' }
  }

  const newest = entries.reduce<string | null>(
    (max, e) => (e.at && (!max || e.at > max) ? e.at : max),
    null,
  )

  if (!watermark) {
    // Baseline: a fresh source must not flood the desk with its whole backlog.
    const mostRecent = entries.reduce((best, e) => (e.at && best.at && e.at > best.at ? e : best))
    const skipped = entries.length - 1
    return {
      considered: withPreamble(preamble, mostRecent.text),
      ...(newest ? { watermark: newest } : {}),
      note:
        skipped > 0
          ? `baseline: considered the most recent entry, skipped ${skipped} older`
          : 'baseline: considered the only entry',
    }
  }

  const fresh = entries.filter((e) => e.at !== null && e.at > watermark)
  if (fresh.length === 0) {
    return { considered: '', note: `nothing newer than ${watermark}` }
  }

  return {
    considered: withPreamble(preamble, fresh.map((e) => e.text).join('\n\n')),
    ...(newest && newest > watermark ? { watermark: newest } : {}),
    note: `${fresh.length} of ${entries.length} entries newer than ${watermark}`,
  }
}

/** Line count above which the LCS below would start costing real time. */
const DIFF_LIMIT = 2000

/**
 * Longest common subsequence over lines, so the director is handed the change
 * rather than the whole state.
 */
export function diffLines(previous: string, next: string): string {
  const a = previous.split('\n')
  const b = next.split('\n')

  if (a.length > DIFF_LIMIT || b.length > DIFF_LIMIT) {
    return next
  }

  const lcs: number[][] = Array.from({ length: a.length + 1 }, () => new Array<number>(b.length + 1).fill(0))
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      lcs[i]![j] = a[i] === b[j] ? lcs[i + 1]![j + 1]! + 1 : Math.max(lcs[i + 1]![j]!, lcs[i]![j + 1]!)
    }
  }

  const out: string[] = []
  let i = 0
  let j = 0
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      i++
      j++
    } else if (lcs[i + 1]![j]! >= lcs[i]![j + 1]!) {
      out.push(`- ${a[i]}`)
      i++
    } else {
      out.push(`+ ${b[j]}`)
      j++
    }
  }
  while (i < a.length) out.push(`- ${a[i++]}`)
  while (j < b.length) out.push(`+ ${b[j++]}`)

  return out.join('\n')
}

export function trimSnapshot(text: string, previous: string | null): TrimResult {
  if (previous === null) {
    // First snapshot is a baseline: there is no change to report yet, and
    // announcing a whole current state as news would flood the desk.
    return {
      considered: '',
      snapshot: text,
      note: 'baseline snapshot recorded — nothing to compare against yet',
    }
  }
  if (previous === text) {
    return { considered: '', snapshot: text, note: 'snapshot unchanged' }
  }

  const changes = diffLines(previous, text)
  const changed = changes.split('\n').filter((l) => l.startsWith('+ ') || l.startsWith('- ')).length
  return {
    considered: changes,
    snapshot: text,
    note: `${changed} changed line${changed === 1 ? '' : 's'} since the previous snapshot`,
  }
}

export interface TrimInput {
  kind: string
  text: string
  watermark: string | null
  lastSnapshot: string | null
}

export function trim({ kind, text, watermark, lastSnapshot }: TrimInput): TrimResult {
  switch (kind) {
    case 'timeline':
      return trimTimeline(text, watermark)
    case 'snapshot':
      return trimSnapshot(text, lastSnapshot)
    default:
      // A report or an idea is considered whole — depth is the source's
      // business, and there is nothing deterministic to trim.
      return { considered: text, note: 'considered whole' }
  }
}
