import type { Cadence } from '@newsdesk/shared'
import { describe, expect, it } from 'vitest'
import { fromLocal, localParts, proposeSlot } from '../src/pipeline/schedule.js'

/**
 * The proposer is a pure function over an injected clock, so these are real
 * assertions about wall-clock behaviour rather than approximations. The DST
 * cases are the point of the whole module: a posting window means local time,
 * and the two Sundays a year when local time is not a fixed offset from UTC are
 * exactly when a naive implementation posts an hour off.
 */

const PARIS: Cadence = {
  timezone: 'Europe/Paris',
  days: [1, 2, 3, 4, 5],
  window: { from: '09:00', to: '18:00' },
  min_gap_minutes: 90,
  max_per_day: 3,
}

/** Local wall-clock time in a zone, as "YYYY-MM-DD HH:MM". */
function local(at: Date, timezone = 'Europe/Paris'): string {
  const p = localParts(at, timezone)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${p.year}-${pad(p.month)}-${pad(p.day)} ${pad(p.hour)}:${pad(p.minute)}`
}

describe('fromLocal', () => {
  it('resolves a local time to the right UTC instant in winter and summer', () => {
    // CET (+01:00) in January, CEST (+02:00) in July.
    expect(fromLocal('Europe/Paris', { year: 2026, month: 1, day: 15 }, 9, 0).toISOString()).toBe(
      '2026-01-15T08:00:00.000Z',
    )
    expect(fromLocal('Europe/Paris', { year: 2026, month: 7, day: 15 }, 9, 0).toISOString()).toBe(
      '2026-07-15T07:00:00.000Z',
    )
  })

  it('survives both DST transitions', () => {
    // Spring forward: 2026-03-29, 02:00 -> 03:00 local. 01:59 is CET, 03:00 CEST.
    expect(fromLocal('Europe/Paris', { year: 2026, month: 3, day: 29 }, 1, 30).toISOString()).toBe(
      '2026-03-29T00:30:00.000Z',
    )
    expect(fromLocal('Europe/Paris', { year: 2026, month: 3, day: 29 }, 4, 0).toISOString()).toBe(
      '2026-03-29T02:00:00.000Z',
    )
    // Autumn back: 2026-10-25, 03:00 -> 02:00 local.
    expect(fromLocal('Europe/Paris', { year: 2026, month: 10, day: 25 }, 9, 0).toISOString()).toBe(
      '2026-10-25T08:00:00.000Z',
    )
  })

  it('lands on a real instant when the requested local time does not exist', () => {
    // 02:30 never happens on the spring-forward day. Rather than throw, the
    // round trip settles on the next instant the clock actually shows, which is
    // what a posting window wants.
    const at = fromLocal('Europe/Paris', { year: 2026, month: 3, day: 29 }, 2, 30)
    expect(Number.isNaN(at.getTime())).toBe(false)
    expect(local(at)).toBe('2026-03-29 03:30')
  })
})

describe('proposeSlot', () => {
  it('sends breaking news immediately, ignoring the window', () => {
    // 04:00 local on a Sunday: outside the window and outside the allowed days.
    const now = new Date('2026-08-02T02:00:00.000Z')
    const slot = proposeSlot({ now, cadence: PARIS, urgency: 'breaking' })
    expect(slot.at).toBe(now)
    expect(slot.reason).toContain('breaking')
  })

  it('waits for the window to open when the desk is asleep', () => {
    // 06:00 Paris on Monday — three hours before the window.
    const now = new Date('2026-08-03T04:00:00.000Z')
    expect(local(proposeSlot({ now, cadence: PARIS }).at)).toBe('2026-08-03 09:00')
  })

  it('offers the next round five minutes when already inside the window', () => {
    // 11:32 Paris on Monday rounds up to 11:35, not back to 09:00.
    const now = new Date('2026-08-03T09:32:00.000Z')
    expect(local(proposeSlot({ now, cadence: { ...PARIS, min_gap_minutes: 5 } }).at)).toBe('2026-08-03 11:35')
  })

  it('skips days the outlet does not post on', () => {
    // Saturday 10:00 Paris; the next weekday is Monday.
    const now = new Date('2026-08-01T08:00:00.000Z')
    expect(local(proposeSlot({ now, cadence: PARIS }).at)).toBe('2026-08-03 09:00')
  })

  it('keeps the minimum gap from what is already booked', () => {
    const now = new Date('2026-08-03T04:00:00.000Z') // 06:00 Paris, Monday
    const slot = proposeSlot({
      now,
      cadence: PARIS,
      taken: ['2026-08-03T07:00:00.000Z'], // 09:00 Paris
    })
    // 09:00 is taken and 90 minutes must be clear, so the 10:30 step wins.
    expect(local(slot.at)).toBe('2026-08-03 10:30')
    expect(slot.reason).toContain('90 minutes clear')
  })

  it('rolls to the next day once the daily cap is reached', () => {
    const now = new Date('2026-08-03T04:00:00.000Z')
    const slot = proposeSlot({
      now,
      cadence: PARIS,
      taken: [
        '2026-08-03T07:00:00.000Z', // 09:00 Paris
        '2026-08-03T10:00:00.000Z', // 12:00
        '2026-08-03T13:00:00.000Z', // 15:00
      ],
    })
    expect(local(slot.at)).toBe('2026-08-04 09:00')
  })

  it('rolls over the weekend when Friday is full', () => {
    const now = new Date('2026-08-07T04:00:00.000Z') // Friday 06:00 Paris
    const slot = proposeSlot({
      now,
      cadence: PARIS,
      taken: [
        '2026-08-07T07:00:00.000Z',
        '2026-08-07T10:00:00.000Z',
        '2026-08-07T13:00:00.000Z',
      ],
    })
    expect(local(slot.at)).toBe('2026-08-10 09:00') // Monday
  })

  it('puts evergreen behind everything already committed', () => {
    const now = new Date('2026-08-03T04:00:00.000Z') // Monday 06:00 Paris
    const taken = ['2026-08-04T07:00:00.000Z'] // Tuesday 09:00 Paris

    // Normal takes the first free slot, today.
    expect(local(proposeSlot({ now, cadence: PARIS, taken }).at)).toBe('2026-08-03 09:00')
    // Evergreen waits until after the last commitment instead of jumping it.
    expect(local(proposeSlot({ now, cadence: PARIS, taken, urgency: 'evergreen' }).at)).toBe(
      '2026-08-04 10:30',
    )
  })

  it('honours the window across a DST boundary', () => {
    // Friday 2026-10-23, after the window. The next weekday is Monday the 26th,
    // the day after the clocks go back — 09:00 local is 08:00Z, not 07:00Z.
    const now = new Date('2026-10-23T17:00:00.000Z')
    const slot = proposeSlot({ now, cadence: PARIS })
    expect(local(slot.at)).toBe('2026-10-26 09:00')
    expect(slot.at.toISOString()).toBe('2026-10-26T08:00:00.000Z')
  })

  it('treats an outlet with no cadence as postable at any time', () => {
    const now = new Date('2026-08-02T02:07:00.000Z') // Sunday, 04:07 Paris
    const slot = proposeSlot({ now, timezone: 'Europe/Paris' })
    expect(local(slot.at)).toBe('2026-08-02 04:10')
    expect(slot.reason).toContain('declares no posting window')
  })

  it('defaults to UTC when neither the outlet nor the desk names a zone', () => {
    const now = new Date('2026-08-03T11:03:00.000Z')
    expect(proposeSlot({ now }).at.toISOString()).toBe('2026-08-03T11:05:00.000Z')
  })

  it('never proposes a time in the past', () => {
    const now = new Date('2026-08-03T15:30:00.000Z') // 17:30 Paris, near the window's end
    expect(proposeSlot({ now, cadence: PARIS }).at.getTime()).toBeGreaterThanOrEqual(now.getTime())
  })

  it('gives up legibly rather than spinning when no slot can fit', () => {
    // An outlet that posts only on a day that is excluded cannot ever fit.
    const now = new Date('2026-08-03T04:00:00.000Z')
    const slot = proposeSlot({
      now,
      cadence: { timezone: 'Europe/Paris', days: [1], max_per_day: 0 as unknown as number },
      taken: ['2026-08-03T07:00:00.000Z'],
    })
    expect(slot.reason).toContain('no slot fits')
    // Still clear of what is booked, so the offered time is at least defensible.
    expect(slot.at.getTime()).toBeGreaterThanOrEqual(new Date('2026-08-03T07:00:00.000Z').getTime())
  })
})
