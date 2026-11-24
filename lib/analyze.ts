import { chat, readJson, sameActivity, type Message, type Part } from './venice'
import { formatTime, IMAGES_PER_MESSAGE, parseTime, type WindowRequest, type WindowResult } from './video'

const SYSTEM = `You keep the lab log for a recorded bench experiment. You are shown frames from a fixed camera, sampled once per second and labelled with their time in the recording. Frames are in order and exactly 1 s apart.

Write log entries for what happened in this window, the way a careful researcher would write a lab notebook.
- One entry per distinct step. When the researcher keeps doing the same thing with the same objects, that is one entry timed at its first frame, however many times the motion repeats: "Added white powder to the weighing boat on the balance in several small portions", never "added powder", "added more powder", "added a final portion" as separate entries.
- Start a new entry only when the researcher moves to a different object, instrument or step, or when a result appears.
- One plain sentence per entry, past tense. Name the object or instrument and what was done with it.
- Quote a display or label only if every character is legible in a frame; otherwise say the display changed. Never invent a value.
- Usually 1 to 3 entries per window, none if nothing happens, never more than 5.
- Each entry covers a span: "time" is the label of the frame where the step starts and "until" the label where it ends. A step that runs most of the window is one entry with a long span.
- Only log what the frames show. Before writing an entry, check that the change is visible across the frames: an object that moved should be somewhere else afterwards. If the purpose of a motion is unclear, describe the motion ("reached toward the balance") instead of guessing a step. The earlier log tells you what came before, not what must come next.
- Use the same names for things as the earlier log.
- The last entry in the earlier log may still be under way when this window starts. Do not restate it. Do log every new step after it, including small ones such as putting something down, picking something up or pressing a button.
- Before answering, merge any of your entries that describe the same activity into one.
- Call the person "the researcher".
- "activity" is "new" if you wrote entries, "continuing" if an earlier activity simply carried on, or "idle" if nothing was happening.
- "scene" is one or two sentences on the state of the bench at the end of the window (where key items are, what is in progress, whether hands are in view) so the next window can continue from it. In the first window, also list the instruments and objects in view.`

const RESPONSE_FORMAT = {
  type: 'json_schema',
  json_schema: {
    name: 'lab_log_window',
    strict: true,
    schema: {
      type: 'object',
      additionalProperties: false,
      required: ['entries', 'activity', 'scene'],
      properties: {
        activity: { type: 'string', enum: ['new', 'continuing', 'idle'] },
        entries: {
          type: 'array',
          items: {
            type: 'object',
            additionalProperties: false,
            required: ['time', 'until', 'text'],
            properties: { time: { type: 'string' }, until: { type: 'string' }, text: { type: 'string' } },
          },
        },
        scene: { type: 'string' },
      },
    },
  },
}

function briefing(req: WindowRequest) {
  const lines = [
    req.title && `Experiment: ${req.title}`,
    req.context && `Context from the researcher: ${req.context}`,
    `Recording length: ${formatTime(req.duration)}.`,
    `This window: ${formatTime(req.start)} to ${formatTime(req.end)}, ${req.frames.length} frames.`,
    req.earlier.length
      ? `Earlier log, oldest first:\n${req.earlier.map((entry) => `${formatTime(entry.t)} ${entry.text}`).join('\n')}`
      : 'This is the first window.',
    req.scene && `Scene at ${formatTime(req.start)}: ${req.scene}`,
    'Frames follow.',
  ]
  return lines.filter(Boolean).join('\n\n')
}

/** One user message per group of frames, each frame preceded by its time label. */
function messages(req: WindowRequest): Message[] {
  const groups: Part[][] = []
  req.frames.forEach((frame, i) => {
    if (i % IMAGES_PER_MESSAGE === 0) groups.push([])
    groups[groups.length - 1].push(
      { type: 'text', text: `Frame ${i + 1} · ${formatTime(frame.t)}` },
      { type: 'image_url', image_url: { url: frame.image } },
    )
  })
  groups[0]?.unshift({ type: 'text', text: briefing(req) })
  groups[groups.length - 1]?.push({ type: 'text', text: 'That is every frame in this window. Write the log entries.' })
  return [{ role: 'system', content: SYSTEM }, ...groups.map((content) => ({ role: 'user' as const, content }))]
}

function dropRepeats(entries: { t: number; text: string }[], previous?: string) {
  const kept: { t: number; text: string }[] = []
  for (const entry of entries) {
    const before = kept[kept.length - 1]?.text ?? previous
    if (before && sameActivity(before, entry.text)) continue
    kept.push(entry)
  }
  return kept
}

export async function analyzeWindow(key: string, req: WindowRequest): Promise<WindowResult> {
  const started = Date.now()
  const { content, tokens } = await chat(key, req.model, {
    temperature: 0.2,
    messages: messages(req),
    response_format: RESPONSE_FORMAT,
  })

  const parsed = readJson(content)
  const body = Array.isArray(parsed) ? { entries: parsed } : (parsed as { entries?: unknown; scene?: unknown; activity?: unknown })
  const entries = (Array.isArray(body.entries) ? body.entries : []) as { time?: unknown; text?: unknown }[]
  const last = req.frames[req.frames.length - 1]?.t ?? req.start

  return {
    entries: dropRepeats(
      entries
        .map((entry) => ({
          t: Math.min(Math.max(parseTime(entry.time) ?? req.start, req.start), last),
          text: typeof entry.text === 'string' ? entry.text.trim() : '',
        }))
        .filter((entry) => entry.text)
        .sort((a, b) => a.t - b.t),
      req.earlier[req.earlier.length - 1]?.text,
    ),
    scene: typeof body.scene === 'string' ? body.scene.trim() : '',
    quiet: 'activity' in body && body.activity === 'idle' ? 'idle' : 'continuing',
    ms: Date.now() - started,
    tokens,
  }
}
