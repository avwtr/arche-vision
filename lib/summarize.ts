import { chat } from './venice'
import { formatTime } from './video'

const SYSTEM = `You write the closing note of a lab notebook entry. Two short paragraphs, plain prose, no headings and no bullet list.
Use only the log you are given. Do not invent measurements, times, objects, or outcomes.
If the log is thin or was stopped early, say what it records and what it does not establish.
Call the person "the researcher".`

export async function summarizeLog(
  key: string,
  model: string,
  input: { title: string; context: string; objects: string[]; entries: { t: number; text: string }[] },
) {
  const log = input.entries.length
    ? input.entries.map((entry) => `${formatTime(entry.t)} ${entry.text}`).join('\n')
    : 'The log has no observations.'
  const { content } = await chat(
    key,
    model,
    {
      temperature: 0.2,
      messages: [
        { role: 'system', content: SYSTEM },
        {
          role: 'user',
          content: [
            input.title && `Experiment: ${input.title}`,
            input.context && `Context the researcher gave: ${input.context}`,
            input.objects.length ? `Objects the researcher confirmed: ${input.objects.join(', ')}.` : '',
            `Log:\n${log}`,
          ]
            .filter(Boolean)
            .join('\n\n'),
        },
      ],
    },
    60_000,
  )
  return content.trim()
}
