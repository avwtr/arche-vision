import { NextResponse } from 'next/server'
import { begin, publicError } from '@/lib/http'
import { privateModels, verifyKey } from '@/lib/venice'
import { VENICE_MODELS } from '@/lib/video'

export const maxDuration = 30

/** Confirms the key and that a vision model still runs privately. The key is not returned. */
export async function GET(request: Request) {
  const auth = begin(request)
  if (auth instanceof NextResponse) return auth
  try {
    const allowed = await privateModels(auth.key)
    const models = VENICE_MODELS.filter((model) => allowed.has(model.id)).map(({ id, name, note }) => ({ id, name, note }))
    if (!models.length) {
      return NextResponse.json(
        { error: 'None of the vision models are marked private for this key, so nothing would be sent.' },
        { status: 503 },
      )
    }
    await verifyKey(auth.key, models[0].id)
    return NextResponse.json({ ok: true, source: auth.source, models })
  } catch (error) {
    const { message, status } = publicError(error, auth.key)
    return NextResponse.json({ error: message }, { status })
  }
}
