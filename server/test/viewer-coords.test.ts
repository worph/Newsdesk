import { describe, expect, it } from 'vitest'
import { toPageCoords } from '../../web/src/components/BrowserViewer.js'

/**
 * Canvas coordinates to page coordinates.
 *
 * The one piece of arithmetic in the live viewer that has to be right: get it
 * wrong and every tap lands somewhere the operator did not press — which, on a
 * page holding a publish button, is the worst kind of quietly wrong.
 *
 * Tested from the server suite because the browser bundle has no runner of its
 * own and this is pure.
 */

const PAGE = { width: 1280, height: 800 }

describe('mapping a tap onto the page', () => {
  it('is identity when the canvas is shown at the page size', () => {
    expect(toPageCoords({ x: 640, y: 400 }, { width: 1280, height: 800 }, PAGE)).toEqual({
      x: 640,
      y: 400,
    })
  })

  it('scales up when the canvas is smaller than the page', () => {
    // The mobile case: a 390-wide phone showing a 1280-wide page.
    expect(toPageCoords({ x: 195, y: 122 }, { width: 390, height: 244 }, PAGE)).toEqual({
      x: 640,
      y: 400,
    })
  })

  it('scales down when the canvas is larger than the page', () => {
    expect(toPageCoords({ x: 2560, y: 1600 }, { width: 2560, height: 1600 }, PAGE)).toEqual({
      x: 1280,
      y: 800,
    })
  })

  it('keeps the corners at the corners', () => {
    const canvas = { width: 390, height: 244 }
    expect(toPageCoords({ x: 0, y: 0 }, canvas, PAGE)).toEqual({ x: 0, y: 0 })
    expect(toPageCoords({ x: 390, y: 244 }, canvas, PAGE)).toEqual({ x: 1280, y: 800 })
  })

  it('answers the origin rather than dividing by zero before the first frame', () => {
    // The canvas has no size until a frame has been drawn, and a tap in that
    // window must not send NaN coordinates into a real page.
    expect(toPageCoords({ x: 10, y: 10 }, { width: 0, height: 0 }, PAGE)).toEqual({ x: 0, y: 0 })
  })
})
