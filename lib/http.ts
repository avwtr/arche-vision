import { NextResponse } from 'next/server'
import { PrivacyError } from './venice'

/** The browser key wins, so a shared computer can still be one person, one key. */
export function keyFrom(request: Request) {
  const header = request.headers.get('x-venice-key')?.trim()
  if (header) return { key: header, source: 'request' as const }
  const env = process.env.VENICE_API_KEY?.trim()
  if (env) return { key: env, source: 'env' as const }
  return null
}

/**
 * Default is localhost. A server on a public host with a key in the environment
 * would let anyone who can reach it spend that key.
 */
export function localOnly(request: Request) {
  if (process.env.ARCHE_VISION_OPEN_HOST === '1') return null
  const host = (request.headers.get('x-forwarded-host') ?? request.headers.get('host') ?? '').split(':')[0]
  if (host === 'localhost' || host === '127.0.0.1' || host === '::1' || host === '[::1]') return null
  return NextResponse.json(
    {
      error:
        'Arche Vision Open only answers on localhost. Set ARCHE_VISION_OPEN_HOST=1 to answer other hosts, and read the README before you do.',
    },
    { status: 403 },
  )
}

export function begin(request: Request) {
  const blocked = localOnly(request)
  if (blocked) return blocked
  const auth = keyFrom(request)
  if (!auth) {
    return NextResponse.json({ error: 'Add a Venice API key to continue.', configured: false }, { status: 401 })
  }
  return auth
}

export function publicError(error: unknown, key: string): { message: string; status: number } {
  const raw = error instanceof Error ? error.message : ''
  const scrubbed = key && raw.includes(key) ? raw.split(key).join('a key') : raw
  console.error('vision', scrubbed || error)
  if (error instanceof PrivacyError) return { message: error.message, status: 503 }
  const name = error instanceof Error ? error.name : ''
  const status = typeof (error as { status?: unknown })?.status === 'number' ? (error as { status: number }).status : 0
  if (name === 'TimeoutError' || name === 'AbortError' || /timed? ?out/i.test(scrubbed)) {
    return { message: 'Venice took too long to answer. Try this stretch again.', status: 504 }
  }
  if (status === 429 || /rate limit/i.test(scrubbed)) {
    return { message: 'Venice is busy right now. Wait a minute, then resume.', status: 429 }
  }
  if (status === 401 || status === 403 || /rejected the API key/i.test(scrubbed)) {
    return { message: 'Venice rejected this API key.', status: 401 }
  }
  if (/not configured|balance|quota/i.test(scrubbed)) {
    return { message: 'Venice could not use this key. Check the key and its balance.', status: 402 }
  }
  if (status === 400 || status === 413 || status === 422) {
    return { message: 'Venice couldn’t take that request.', status: 400 }
  }
  if (status >= 500 || /reach|fetch failed|ECONN|network/i.test(scrubbed)) {
    return { message: 'Venice couldn’t be reached. Try again in a moment.', status: 502 }
  }
  return { message: 'Something went wrong while reading. Try again.', status: 502 }
}
