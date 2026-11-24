/**
 * Server-only access to Venice. Every request goes through the private-model check first.
 * The key is the caller's. It is never logged.
 */

const API = 'https://api.venice.ai/api/v1'
const PRIVACY_TTL_MS = 10 * 60 * 1000

export class PrivacyError extends Error {}

export type Part = { type: 'text'; text: string } | { type: 'image_url'; image_url: { url: string } }
export type Message = { role: 'system' | 'user'; content: string | Part[] }

type Usage = { prompt_tokens?: number; completion_tokens?: number }
type Cache = { at: number; allowed: Set<string> }

const privacyCache = new Map<string, Cache>()

/**
 * Checks Venice's live model list before any frames leave, so a model that Venice later moves
 * off private infrastructure is refused. Fails closed when the list can't be read.
 */
export async function privateModels(key: string) {
  const cached = privacyCache.get(key)
  if (!cached || Date.now() - cached.at > PRIVACY_TTL_MS) {
    try {
      const response = await fetch(`${API}/models?type=text`, {
        headers: { Authorization: `Bearer ${key}` },
        cache: 'no-store',
        signal: AbortSignal.timeout(10_000),
      })
      if (response.status === 401 || response.status === 403) {
        throw new Error('Venice rejected the API key.')
      }
      if (!response.ok) throw new Error(String(response.status))
      const body = (await response.json()) as { data?: { id: string; model_spec?: { privacy?: string } }[] }
      privacyCache.set(key, {
        at: Date.now(),
        allowed: new Set((body.data ?? []).filter((model) => model.model_spec?.privacy === 'private').map((model) => model.id)),
      })
    } catch (error) {
      if (error instanceof Error && /rejected the API key/.test(error.message)) throw error
      if (!cached) throw new PrivacyError('Could not confirm the model runs privately, so nothing was sent.')
    }
  }
  return privacyCache.get(key)!.allowed
}

const verified = new Map<string, number>()

/** The model list is public, so a key is only real once a completion accepts it. */
export async function verifyKey(key: string, model: string) {
  const at = verified.get(key)
  if (at && Date.now() - at < PRIVACY_TTL_MS) return
  await assertPrivate(key, model)
  const response = await fetch(`${API}/chat/completions`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: payloadFor(model, {
      max_tokens: 1,
      temperature: 0,
      messages: [{ role: 'user', content: 'Reply with ok.' }],
    }),
    cache: 'no-store',
    signal: AbortSignal.timeout(20_000),
  })
  if (response.status === 401 || response.status === 403) {
    throw new Error('Venice rejected the API key.')
  }
  if (!response.ok) {
    throw veniceError(response.status, await response.text())
  }
  verified.set(key, Date.now())
}

async function assertPrivate(key: string, model: string) {
  const allowed = await privateModels(key)
  if (!allowed.has(model)) throw new PrivacyError(`${model} is not a private model on Venice, so nothing was sent.`)
}

function delay(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function veniceError(status: number, raw: string) {
  let message = `Venice returned ${status}.`
  try {
    const parsed = JSON.parse(raw) as { error?: string; issues?: { message?: string }[] }
    message = parsed.issues?.[0]?.message ?? parsed.error ?? message
  } catch {
    /* the body was not JSON */
  }
  const error = new Error(message) as Error & { status: number }
  error.status = status
  return error
}

function payloadFor(model: string, body: Record<string, unknown>) {
  return JSON.stringify({
    model,
    ...body,
    venice_parameters: { include_venice_system_prompt: false, disable_thinking: true, strip_thinking_response: true },
  })
}

/** Some private models lock sampling params or reject json_schema. One retry without the rejected field. */
function withoutRejected(body: Record<string, unknown>, errorText: string) {
  const next = { ...body }
  let changed = false
  if (/frequency_penalty|presence_penalty|sampling param/i.test(errorText)) {
    if ('frequency_penalty' in next || 'presence_penalty' in next) {
      delete next.frequency_penalty
      delete next.presence_penalty
      changed = true
    }
  }
  if (next.response_format && /response_format|json_schema|invalid request parameters/i.test(errorText)) {
    delete next.response_format
    changed = true
  }
  return changed ? next : null
}

async function post(key: string, model: string, body: Record<string, unknown>, timeoutMs: number) {
  await assertPrivate(key, model)
  const started = Date.now()
  let last: Error | null = null
  let request = body
  let retriedLock = false
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const response = await fetch(`${API}/chat/completions`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
        body: payloadFor(model, request),
        cache: 'no-store',
        signal: AbortSignal.timeout(timeoutMs),
      })
      if (response.ok) return response
      const raw = await response.text()
      last = veniceError(response.status, raw)
      if (!retriedLock && response.status === 400) {
        const stripped = withoutRejected(request, raw)
        if (stripped) {
          request = stripped
          retriedLock = true
          continue
        }
      }
      const retryable = response.status === 429 || response.status === 502 || response.status === 503
      if (!retryable || attempt === 2 || Date.now() - started > 8_000) break
      await delay(700 * (attempt + 1))
    } catch (error) {
      last = error instanceof Error ? error : new Error('Venice could not be reached.')
      const timeout = last.name === 'TimeoutError' || last.name === 'AbortError'
      if (timeout || attempt === 2 || Date.now() - started > 8_000) break
      await delay(700 * (attempt + 1))
    }
  }
  throw last ?? new Error('Venice could not be reached.')
}

function partText(value: unknown): string {
  if (typeof value === 'string') return value
  if (!Array.isArray(value)) return ''
  return value
    .map((part) => {
      if (typeof part === 'string') return part
      if (part && typeof part === 'object' && 'text' in part && typeof (part as { text?: unknown }).text === 'string') {
        return (part as { text: string }).text
      }
      return ''
    })
    .join('')
}

/** Thinking models sometimes return the answer beside an empty content field. */
function messageText(message: { content?: unknown; reasoning_content?: unknown } | undefined) {
  const content = partText(message?.content).trim()
  const raw = content || partText(message?.reasoning_content).trim()
  const end = raw.lastIndexOf('</think>')
  return (end >= 0 ? raw.slice(end + 8) : raw).trim()
}

export async function chat(key: string, model: string, body: Record<string, unknown>, timeoutMs = 120_000) {
  const response = await post(key, model, body, timeoutMs)
  const parsed = (await response.json()) as {
    choices?: { message?: { content?: unknown; reasoning_content?: unknown } }[]
    usage?: Usage
  }
  return {
    content: messageText(parsed.choices?.[0]?.message),
    tokens: { prompt: parsed.usage?.prompt_tokens ?? 0, completion: parsed.usage?.completion_tokens ?? 0 },
  }
}

/** Models that ignore the schema still tend to return the same shape, sometimes fenced or bare. */
export function readJson(content: string): unknown {
  const text = content.replace(/^```(?:json)?\s*|\s*```$/g, '').trim()
  try {
    return JSON.parse(text)
  } catch {
    const match = text.match(/[[{][\s\S]*[\]}]/)
    if (!match) throw new Error('Venice returned text instead of the expected fields.')
    return JSON.parse(match[0])
  }
}

const words = (text: string) =>
  new Set(
    text
      .toLowerCase()
      .replace(/[^a-z0-9 ]/g, ' ')
      .split(/\s+/)
      .filter((word) => word.length > 2),
  )

/** The same activity carried across frames or windows tends to come back nearly word for word. */
export function sameActivity(a: string, b: string, threshold = 0.7) {
  const x = words(a)
  const y = words(b)
  if (!x.size || !y.size) return false
  let shared = 0
  for (const word of x) if (y.has(word)) shared++
  return shared / (x.size + y.size - shared) >= threshold
}
