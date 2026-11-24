import { NextResponse } from 'next/server'
import { analyzeWindow } from '@/lib/analyze'
import { begin, publicError } from '@/lib/http'
import { FRAMES_PER_SECOND, VENICE_MODELS, WINDOW_SECONDS, type WindowRequest } from '@/lib/video'

export const maxDuration = 150

export async function POST(request: Request) {
  const auth = begin(request)
  if (auth instanceof NextResponse) return auth
  const body = (await request.json().catch(() => null)) as Partial<WindowRequest> | null
  if (!body || !Array.isArray(body.frames) || !body.frames.length) {
    return NextResponse.json({ error: 'No frames in this window.' }, { status: 400 })
  }
  if (!VENICE_MODELS.some((model) => model.id === body.model)) {
    return NextResponse.json({ error: 'Unknown model.' }, { status: 400 })
  }

  try {
    const result = await analyzeWindow(auth.key, {
      model: body.model!,
      title: String(body.title ?? '').slice(0, 200),
      context: String(body.context ?? '').slice(0, 4000),
      start: Number(body.start) || 0,
      end: Number(body.end) || 0,
      duration: Number(body.duration) || 0,
      frames: body.frames
        .filter((frame) => typeof frame?.image === 'string' && frame.image.startsWith('data:image/'))
        .slice(0, WINDOW_SECONDS * FRAMES_PER_SECOND),
      earlier: Array.isArray(body.earlier) ? body.earlier.slice(-12) : [],
      scene: String(body.scene ?? '').slice(0, 1000),
    })
    return NextResponse.json(result)
  } catch (error) {
    const { message, status } = publicError(error, auth.key)
    return NextResponse.json({ error: message }, { status })
  }
}
