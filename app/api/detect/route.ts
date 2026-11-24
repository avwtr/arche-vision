import { NextResponse } from 'next/server'
import { detectBench, type DetectRequest } from '@/lib/detect'
import { begin, publicError } from '@/lib/http'
import { VENICE_MODELS } from '@/lib/video'

export const maxDuration = 90

export async function POST(request: Request) {
  const auth = begin(request)
  if (auth instanceof NextResponse) return auth
  const body = (await request.json().catch(() => null)) as Partial<DetectRequest> | null
  const image = typeof body?.image === 'string' && body.image.startsWith('data:image/') ? body.image : ''
  const width = Number(body?.width)
  const height = Number(body?.height)
  if (!image) return NextResponse.json({ error: 'No frame.' }, { status: 400 })
  if (!Number.isFinite(width) || !Number.isFinite(height) || width < 8 || height < 8) {
    return NextResponse.json({ error: 'Frame size is missing.' }, { status: 400 })
  }
  if (!VENICE_MODELS.some((model) => model.id === body?.model)) {
    return NextResponse.json({ error: 'Unknown model.' }, { status: 400 })
  }

  try {
    const objects = await detectBench(auth.key, {
      model: body!.model!,
      title: String(body!.title ?? '').slice(0, 200),
      objective: String(body!.objective ?? '').slice(0, 2000),
      scope: String(body!.scope ?? '').slice(0, 2000),
      image,
      width: Math.round(width),
      height: Math.round(height),
    })
    return NextResponse.json({ objects })
  } catch (error) {
    const { message, status } = publicError(error, auth.key)
    return NextResponse.json({ error: message }, { status })
  }
}
