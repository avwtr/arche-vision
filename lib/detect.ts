import { boxFromModel, clampBox, type Box } from './boxes'
import { chat, readJson, type Message, type Part } from './venice'

export type DetectRequest = {
  model: string
  title: string
  objective: string
  scope: string
  image: string
  width: number
  height: number
}

export type DetectedBox = {
  label: string
  confidence: number
  bbox: Box
}

/**
 * Qwen3-VL grounds in its native bbox_2d on a 0–1000 grid; asked for percentages it mixes scales.
 * No worked example with numbers: the model copies it back as a detection.
 */
const SYSTEM = `You find the objects that matter in one photograph from a researcher's camera. It may show a lab bench, a desk or a room, often with the researcher in view. Reply with JSON only, no markdown.

Format: {"objects":[{"label":"<specific name>","bbox_2d":[x1,y1,x2,y2],"confidence":<0-1>}]}

bbox_2d is the tight box around the object in relative coordinates from 0 to 1000: x1,y1 the top-left corner and x2,y2 the bottom-right, where 0,0 is the image's top-left and 1000,1000 its bottom-right.

What to box, most useful first:
1. Anything the experiment, the researcher's notes or the work in view points to: instruments, containers, samples, tools, devices.
2. What a person is holding or using, and gear they wear for the work (gloves, goggles, lab coat). A bottle in a hand is an object like any other.
3. Other distinct objects someone could pick up or use.

Skip the room and its fixtures: walls, floor, ceiling, windows, curtains, rugs, wall panels, large furniture, background decor, and the whole bench or table. Skip tiny debris, parts of an object you already boxed, and anything you cannot name. Do not box people, faces, hands, bodies or everyday clothes unless the notes ask to.

Aim for the 3 to 12 objects that matter most. Each physical object gets exactly one box: never box the same object twice, and count repeated items carefully (four pipettes in a rack are four boxes, not more). Cover every different kind of object before adding more of one kind, and box at most 4 of any one kind. Box each object tightly.

Name the specific thing you see (“amber reagent bottle”, “stir plate”), never a generic class (“device”, “object”, “tools”).

Notes from the researcher adjust names and what to ignore. They are not a whitelist — still detect the other real objects.

Always return at least one object. If nothing above qualifies, box the most prominent thing in view, the person included if they are all there is.`

function briefing(req: DetectRequest) {
  return [
    req.title && `Experiment: ${req.title}`,
    req.objective && `What the researcher is doing: ${req.objective}`,
    req.scope &&
      `Researcher notes (overrides — apply these on top of a full object pass, do not detect only what they mention):\n${req.scope}`,
    `Boxes are bbox_2d on the 0–1000 grid of this image.`,
  ]
    .filter(Boolean)
    .join('\n\n')
}

function asNumber(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string' && value.trim() && Number.isFinite(Number(value))) return Number(value)
  return null
}

function asQuad(value: unknown): [number, number, number, number] | null {
  if (!Array.isArray(value) || value.length < 4) return null
  const nums = value.slice(0, 4).map(asNumber)
  if (nums.some((n) => n === null)) return null
  return nums as [number, number, number, number]
}

function fromBox2d(quad: [number, number, number, number]): Box {
  const left = Math.min(quad[0], quad[2])
  const top = Math.min(quad[1], quad[3])
  const right = Math.max(quad[0], quad[2])
  const bottom = Math.max(quad[1], quad[3])
  return clampBox({
    x: (left / 1000) * 100,
    y: (top / 1000) * 100,
    w: ((right - left) / 1000) * 100,
    h: ((bottom - top) / 1000) * 100,
  })
}

function fromObjectBox(value: Record<string, unknown>, width: number, height: number): Box | null {
  const x = asNumber(value.x)
  const y = asNumber(value.y)
  const w = asNumber(value.w ?? value.width)
  const h = asNumber(value.h ?? value.height)
  if (x === null || y === null || w === null || h === null) return null
  if (w <= 1.05 && h <= 1.05 && x <= 1.05 && y <= 1.05) {
    return clampBox({ x: x * 100, y: y * 100, w: w * 100, h: h * 100 })
  }
  if (Math.max(x + w, y + h) <= 100 && width > 120) {
    return clampBox({ x, y, w, h })
  }
  return clampBox({
    x: (x / width) * 100,
    y: (y / height) * 100,
    w: (w / width) * 100,
    h: (h / height) * 100,
  })
}

function corners(row: Record<string, unknown>, width: number, height: number): Box | null {
  const grid = asQuad(row.bbox_2d ?? row.box_2d)
  if (grid) return fromBox2d(grid)
  const x1 = asNumber(row.x1 ?? row.xmin ?? row.left)
  const y1 = asNumber(row.y1 ?? row.ymin ?? row.top)
  const x2 = asNumber(row.x2 ?? row.xmax ?? row.right)
  const y2 = asNumber(row.y2 ?? row.ymax ?? row.bottom)
  if (x1 !== null && y1 !== null && x2 !== null && y2 !== null) {
    return boxFromModel(x1, y1, x2, y2, width, height)
  }
  const quad = asQuad(row.bbox ?? row.box ?? row.coords)
  if (quad) return boxFromModel(quad[0], quad[1], quad[2], quad[3], width, height)
  const boxed = row.bbox ?? row.box
  if (boxed && typeof boxed === 'object' && !Array.isArray(boxed)) {
    return fromObjectBox(boxed as Record<string, unknown>, width, height)
  }
  return null
}

function fromRow(row: Record<string, unknown>, width: number, height: number): DetectedBox | null {
  const label = typeof row.label === 'string' ? row.label.trim() : typeof row.name === 'string' ? row.name.trim() : ''
  if (!label) return null
  const bbox = corners(row, width, height)
  if (!bbox) return null
  const confidence = asNumber(row.confidence ?? row.score)
  return {
    label: label.slice(0, 80),
    confidence: confidence === null ? 0.7 : Math.min(1, Math.max(0, confidence)),
    bbox,
  }
}

function fromDict(body: Record<string, unknown>, width: number, height: number): DetectedBox[] {
  const out: DetectedBox[] = []
  for (const [label, value] of Object.entries(body)) {
    if (label === 'objects') continue
    const name = label.trim()
    if (!name) continue
    const quad = asQuad(value)
    if (quad) {
      out.push({
        label: name.slice(0, 80),
        confidence: Array.isArray(value) ? (asNumber(value[4]) ?? 0.7) : 0.7,
        bbox: boxFromModel(quad[0], quad[1], quad[2], quad[3], width, height),
      })
      continue
    }
    if (value && typeof value === 'object') {
      const row = fromRow({ label: name, ...(value as Record<string, unknown>) }, width, height)
      if (row) out.push(row)
    }
  }
  return out
}

function named(item: DetectedBox): boolean {
  const label = item.label.trim()
  if (/^(object|device|item|thing|stuff|area|region|ppe|tools?|containers?)$/i.test(label)) return false
  if (/\bppe\b/i.test(label)) return false
  if (/\b(bench|workbench|table|countertop|counter|wall|floor|ceiling|room|fume hood|background|curtains?|rugs?|carpet|wall panel)$/i.test(label))
    return false
  const { w, h } = item.bbox
  return w >= 1 && h >= 1
}

function sized(item: DetectedBox): boolean {
  const { w, h } = item.bbox
  const area = (w * h) / 100
  return w < 95 && area >= 0.1 && area <= 65
}

function overlap(a: Box, b: Box) {
  const w = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x)
  const h = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y)
  if (w <= 0 || h <= 0) return 0
  const shared = w * h
  return shared / (a.w * a.h + b.w * b.h - shared)
}

/** Parallel things (pipettes in a rack) overlap a lot, so only near-identical boxes count as one. */
function distinct(items: DetectedBox[]): DetectedBox[] {
  const kept: DetectedBox[] = []
  const kinds = new Map<string, number>()
  for (const item of [...items].sort((a, b) => b.confidence - a.confidence)) {
    const kind = item.label.toLowerCase()
    if ((kinds.get(kind) ?? 0) >= 4) continue
    if (kept.some((other) => overlap(item.bbox, other.bbox) >= 0.9)) continue
    kinds.set(kind, (kinds.get(kind) ?? 0) + 1)
    kept.push(item)
  }
  return items.filter((item) => kept.includes(item)).slice(0, 12)
}

/** Qwen sometimes drops the brackets: "bbox_2d":527,120,872,333. */
function bracketBoxes(content: string) {
  return content.replace(
    /"(bbox_2d|box_2d|bbox|box)"\s*:\s*(-?[\d.]+\s*,\s*-?[\d.]+\s*,\s*-?[\d.]+\s*,\s*-?[\d.]+)(?=\s*[,}])/g,
    '"$1":[$2]',
  )
}

/**
 * A reply cut off at max_tokens is almost always the model looping on one label with
 * boxes that drift across the frame. Keep the complete objects before the loop.
 */
function salvage(content: string): { objects: Record<string, unknown>[] } | null {
  const rows: Record<string, unknown>[] = []
  for (const match of content.matchAll(/\{[^{}]*"bbox_2d"[^{}]*\}/g)) {
    try {
      rows.push(JSON.parse(match[0]) as Record<string, unknown>)
    } catch {
      /* partial row */
    }
  }
  if (!rows.length) return null
  const last = rows[rows.length - 1].label
  let start = rows.length - 1
  while (start > 0 && rows[start - 1].label === last) start -= 1
  return { objects: rows.slice(0, start + 1) }
}

export function parseObjects(raw: unknown, width: number, height: number): DetectedBox[] {
  if (!raw || typeof raw !== 'object') return []
  const body = raw as Record<string, unknown>
  const list = Array.isArray(body.objects) ? body.objects : Array.isArray(raw) ? raw : null
  let found: DetectedBox[] = []
  if (list) {
    found = list
      .map((row) => (row && typeof row === 'object' ? fromRow(row as Record<string, unknown>, width, height) : null))
      .filter((row): row is DetectedBox => Boolean(row))
  }
  if (!found.length) found = fromDict(body, width, height)
  const usable = found.filter(named)
  const fitted = usable.filter(sized)
  return fitted.length ? distinct(fitted) : distinct(usable).slice(0, 1)
}

async function ask(key: string, req: DetectRequest, format: Record<string, unknown> | undefined, extra: string) {
  const messages: Message[] = [
    { role: 'system', content: SYSTEM },
    {
      role: 'user',
      content: [
        { type: 'text', text: briefing(req) },
        { type: 'image_url', image_url: { url: req.image } },
        { type: 'text', text: extra },
      ] satisfies Part[],
    },
  ]
  const body: Record<string, unknown> = { temperature: 0, max_tokens: 2500, messages }
  if (format) body.response_format = format
  const content = bracketBoxes((await chat(key, req.model, body, 90_000)).content)
  if (!content.trim()) return []
  try {
    return parseObjects(readJson(content), req.width, req.height)
  } catch {
    return parseObjects(salvage(content), req.width, req.height)
  }
}

export async function detectBench(key: string, req: DetectRequest): Promise<DetectedBox[]> {
  const first = await ask(
    key,
    req,
    undefined,
    'Box the objects you can actually see in this photograph, including anything a person is holding. Box the people themselves only if the notes ask to.',
  )
  if (first.length) return first
  return ask(
    key,
    req,
    { type: 'json_object' },
    'Look again and return at least one object: the things that matter here, anything in someone’s hands, or else the most prominent thing in view. Do not invent items. JSON only.',
  )
}
