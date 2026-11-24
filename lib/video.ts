/** Frame-sampled lab logging. Shared by the page and the API routes. */

export const WINDOW_SECONDS = 20
export const FRAMES_PER_SECOND = 1
export const FRAME_WIDTH = 768
/** Venice accepts at most 10 images per message, so a window's frames are split across messages. */
export const IMAGES_PER_MESSAGE = 10

/**
 * Private models only: Venice runs them on its own or zero-retention infrastructure
 * and keeps no prompts or frames. The server refuses anything Venice does not currently mark private.
 */
export const VENICE_MODELS = [
  { id: 'qwen3-vl-235b-a22b', name: 'Qwen3 VL 235B', note: 'Most accurate' },
  { id: 'google-gemma-4-31b-it', name: 'Gemma 4 31B', note: 'Slower' },
] as const

export const DEFAULT_MODEL = VENICE_MODELS[0].id

export type Frame = { t: number; image: string }

export type WindowRequest = {
  model: string
  title: string
  context: string
  start: number
  end: number
  duration: number
  frames: Frame[]
  earlier: { t: number; text: string }[]
  scene: string
}

export type WindowResult = {
  entries: { t: number; text: string }[]
  scene: string
  quiet: 'continuing' | 'idle'
  ms: number
  tokens: { prompt: number; completion: number }
}

export function formatTime(seconds: number) {
  const s = Math.max(0, Math.floor(seconds))
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const pad = (n: number) => String(n).padStart(2, '0')
  return h ? `${h}:${pad(m)}:${pad(s % 60)}` : `${pad(m)}:${pad(s % 60)}`
}

/** Reads "MM:SS", "H:MM:SS" or a plain number of seconds. */
export function parseTime(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value !== 'string') return null
  const parts = value
    .trim()
    .split(':')
    .map(Number)
  if (!parts.length || parts.some((n) => !Number.isFinite(n))) return null
  return parts.reduce((total, n) => total * 60 + n, 0)
}
