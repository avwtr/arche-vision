import { NextResponse } from 'next/server'
import { begin, publicError } from '@/lib/http'
import { summarizeLog } from '@/lib/summarize'
import { VENICE_MODELS } from '@/lib/video'

export const maxDuration = 60

type Body = {
  model?: string
  title?: string
  context?: string
  objects?: unknown
  entries?: { t?: unknown; text?: unknown }[]
}

export async function POST(request: Request) {
  const auth = begin(request)
  if (auth instanceof NextResponse) return auth
  const body = (await request.json().catch(() => null)) as Body | null
  if (!body || !VENICE_MODELS.some((model) => model.id === body.model)) {
    return NextResponse.json({ error: 'Unknown model.' }, { status: 400 })
  }
  const entries = (Array.isArray(body.entries) ? body.entries : [])
    .map((entry) => ({
      t: typeof entry.t === 'number' ? entry.t : 0,
      text: typeof entry.text === 'string' ? entry.text.slice(0, 500) : '',
    }))
    .filter((entry) => entry.text)
    .slice(0, 200)
  const objects = (Array.isArray(body.objects) ? body.objects : [])
    .filter((item): item is string => typeof item === 'string')
    .map((item) => item.slice(0, 80))
    .slice(0, 24)

  try {
    const summary = await summarizeLog(auth.key, body.model!, {
      title: String(body.title ?? '').slice(0, 200),
      context: String(body.context ?? '').slice(0, 2000),
      objects,
      entries,
    })
    return NextResponse.json({ summary })
  } catch (error) {
    const { message, status } = publicError(error, auth.key)
    return NextResponse.json({ error: message }, { status })
  }
}
