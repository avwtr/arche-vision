export type Box = { x: number; y: number; w: number; h: number }

export function clampBox(box: Box): Box {
  const x = Math.min(99.5, Math.max(0, box.x))
  const y = Math.min(99.5, Math.max(0, box.y))
  return {
    x,
    y,
    w: Math.min(100 - x, Math.max(0.5, box.w)),
    h: Math.min(100 - y, Math.max(0.5, box.h)),
  }
}

/**
 * A model may return pixels of the image we sent, 0–1 normalised, or 0–100 percent.
 * Boxes are stored as percent of the snapshot.
 */
export function boxFromModel(x1: number, y1: number, x2: number, y2: number, imageWidth: number, imageHeight: number) {
  const left = Math.min(x1, x2)
  const top = Math.min(y1, y2)
  const right = Math.max(x1, x2)
  const bottom = Math.max(y1, y2)
  const span = Math.max(right, bottom)
  if (span <= 1.05) {
    return clampBox({ x: left * 100, y: top * 100, w: (right - left) * 100, h: (bottom - top) * 100 })
  }
  if (span <= 100 && imageWidth > 120 && imageHeight > 120) {
    return clampBox({ x: left, y: top, w: right - left, h: bottom - top })
  }
  return clampBox({
    x: (left / imageWidth) * 100,
    y: (top / imageHeight) * 100,
    w: ((right - left) / imageWidth) * 100,
    h: ((bottom - top) / imageHeight) * 100,
  })
}
