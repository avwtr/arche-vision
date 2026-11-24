'use client'

import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react'
import { dropRun, getMedia, getRun, listRuns, putMedia, putRun, type LocalRun } from '@/lib/local'
import { DEFAULT_MODEL, formatTime, FRAME_WIDTH, WINDOW_SECONDS, type Frame } from '@/lib/video'

const KEY = 'arche-vision-key'

type Model = { id: string; name: string; note: string }
type Step = 'setup' | 'objects' | 'log'
type Obj = { id: string; label: string; x: number; y: number; w: number; h: number }
type Line = { id: string; t: number; text: string }
type Source = { kind: 'file'; url: string; name: string } | { kind: 'camera' }

type Run = {
  phase: 'running' | 'paused' | 'done' | 'error'
  covered: number
  duration: number
  stage: string
  error: string | null
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

function headers(key: string, json = true): HeadersInit {
  return {
    ...(json ? { 'Content-Type': 'application/json' } : {}),
    ...(key ? { 'x-venice-key': key } : {}),
  }
}

function grab(video: HTMLVideoElement) {
  const scale = FRAME_WIDTH / video.videoWidth
  const canvas = document.createElement('canvas')
  canvas.width = FRAME_WIDTH
  canvas.height = Math.max(1, Math.round(video.videoHeight * scale))
  const context = canvas.getContext('2d')
  if (!context || !video.videoWidth) throw new Error('This frame could not be read. Wait for the picture, then try again.')
  context.drawImage(video, 0, 0, canvas.width, canvas.height)
  return { image: canvas.toDataURL('image/jpeg', 0.72), width: canvas.width, height: canvas.height }
}

function seek(video: HTMLVideoElement, t: number) {
  return new Promise<void>((resolve, reject) => {
    const timer = window.setTimeout(() => {
      video.removeEventListener('seeked', done)
      reject(new Error(`Could not read the frame at ${t.toFixed(1)} s.`))
    }, 15_000)
    function done() {
      window.clearTimeout(timer)
      resolve()
    }
    video.addEventListener('seeked', done, { once: true })
    video.currentTime = Math.min(t, Math.max(video.duration - 0.05, 0))
  })
}

function savedStatus(item: LocalRun) {
  if (item.run?.phase === 'done') return 'Finished'
  if (item.run?.phase === 'paused' || item.run?.phase === 'running') return 'Paused'
  if (item.run?.phase === 'error') return 'Stopped'
  if (item.step === 'objects') return 'Objects'
  if (item.step === 'log') return 'Log'
  return 'Setup'
}

function download(name: string, text: string, type: string) {
  const url = URL.createObjectURL(new Blob([text], { type }))
  const link = document.createElement('a')
  link.href = url
  link.download = name
  link.click()
  URL.revokeObjectURL(url)
}

export function Studio() {
  const [keyState, setKeyState] = useState<'checking' | 'need' | 'bad' | 'ok'>('checking')
  const [key, setKey] = useState('')
  const [draft, setDraft] = useState('')
  const [usingEnv, setUsingEnv] = useState(false)
  const [keyError, setKeyError] = useState('')
  const [models, setModels] = useState<Model[]>([])
  const [model, setModel] = useState<string>(DEFAULT_MODEL)
  const [title, setTitle] = useState('')
  const [context, setContext] = useState('')
  const [minutes, setMinutes] = useState(5)
  const [step, setStep] = useState<Step>('setup')
  const [source, setSource] = useState<Source | null>(null)
  const [still, setStill] = useState<{ image: string; width: number; height: number } | null>(null)
  const [objects, setObjects] = useState<Obj[]>([])
  const [selected, setSelected] = useState<string | null>(null)
  const [busy, setBusy] = useState('')
  const [error, setError] = useState('')
  const [run, setRun] = useState<Run | null>(null)
  const [lines, setLines] = useState<Line[]>([])
  const [summary, setSummary] = useState('')
  const [library, setLibrary] = useState<LocalRun[]>([])
  const [fileMissing, setFileMissing] = useState(false)
  const [activeId, setActiveId] = useState<string | null>(null)
  const videoRef = useRef<HTMLVideoElement>(null)
  const streamRef = useRef<MediaStream | null>(null)
  const fileRef = useRef<HTMLInputElement>(null)
  const control = useRef({ paused: false, stopped: false, abort: null as AbortController | null })
  const runParams = useRef({ key: '', model: '', title: '', context: '', objects: [] as Obj[], source: null as Source | null, minutes: 5 })
  const runId = useRef<string | null>(null)
  const createdAt = useRef(0)
  const persistOn = useRef(false)
  const loopOn = useRef(false)
  const live = useRef({ title, context, model, minutes, step, source, objects, still, lines, summary, run })
  live.current = { title, context, model, minutes, step, source, objects, still, lines, summary, run }

  function snapshot(id: string): LocalRun {
    const current = live.current
    return {
      id,
      title: current.title,
      context: current.context,
      model: current.model,
      minutes: current.minutes,
      step: current.step,
      source: current.source ? (current.source.kind === 'file' ? { kind: 'file', name: current.source.name } : { kind: 'camera' }) : null,
      objects: current.objects,
      still: current.still,
      lines: current.lines,
      summary: current.summary,
      run: current.run,
      createdAt: createdAt.current,
      updatedAt: Date.now(),
    }
  }

  function remember(record: LocalRun) {
    setLibrary((items) => [record, ...items.filter((item) => item.id !== record.id)].sort((a, b) => b.updatedAt - a.updatedAt))
  }

  useEffect(() => {
    const saved = window.localStorage.getItem(KEY) ?? ''
    setDraft(saved)
    void check(saved)
    void listRuns().then(setLibrary).catch(() => {})
    const flush = () => {
      const id = runId.current
      if (!persistOn.current || !id) return
      const record = snapshot(id)
      void putRun(record).then(() => remember(record)).catch(() => {})
    }
    window.addEventListener('pagehide', flush)
    return () => {
      window.removeEventListener('pagehide', flush)
      streamRef.current?.getTracks().forEach((track) => track.stop())
    }
    // The key check and the browser store load once, when the page opens.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    const id = runId.current
    if (!persistOn.current || !id) return
    const handle = window.setTimeout(() => {
      const record = snapshot(id)
      void putRun(record).then(() => remember(record)).catch(() => {})
    }, 300)
    return () => window.clearTimeout(handle)
  }, [title, context, model, minutes, step, source, objects, still, lines, summary, run])

  async function check(next: string) {
    setKeyState('checking')
    setKeyError('')
    try {
      const response = await fetch('/api/ready', { headers: headers(next, false) })
      const body = (await response.json()) as { error?: string; source?: string; models?: Model[]; configured?: boolean }
      if (!response.ok) {
        if (next) window.localStorage.removeItem(KEY)
        setKeyState(body.configured === false ? 'need' : 'bad')
        setKeyError(body.configured === false ? '' : (body.error ?? 'This key could not be used.'))
        return
      }
      if (next) window.localStorage.setItem(KEY, next)
      else window.localStorage.removeItem(KEY)
      setKey(next)
      setUsingEnv(body.source === 'env')
      setModels(body.models ?? [])
      setModel((current) => (body.models?.some((item) => item.id === current) ? current : (body.models?.[0]?.id ?? current)))
      setKeyState('ok')
    } catch {
      setKeyState('bad')
      setKeyError('The local server could not be reached.')
    }
  }

  function forget() {
    window.localStorage.removeItem(KEY)
    setKey('')
    setDraft('')
    setUsingEnv(false)
    void check('')
  }

  function stopCamera() {
    streamRef.current?.getTracks().forEach((track) => track.stop())
    streamRef.current = null
  }

  function ensureRun() {
    if (runId.current) return runId.current
    const id = crypto.randomUUID()
    runId.current = id
    createdAt.current = Date.now()
    persistOn.current = true
    setActiveId(id)
    return id
  }

  function newRun() {
    stopCamera()
    persistOn.current = false
    runId.current = null
    createdAt.current = 0
    setActiveId(null)
    setTitle('')
    setContext('')
    setMinutes(5)
    setStep('setup')
    setSource((current) => {
      if (current?.kind === 'file') URL.revokeObjectURL(current.url)
      return null
    })
    setStill(null)
    setObjects([])
    setLines([])
    setSummary('')
    setRun(null)
    setError('')
    setFileMissing(false)
    setSelected(null)
  }

  async function openSaved(id: string) {
    const record = await getRun(id)
    if (!record) return
    stopCamera()
    persistOn.current = false
    loopOn.current = false
    runId.current = record.id
    createdAt.current = record.createdAt
    setActiveId(record.id)
    setTitle(record.title)
    setContext(record.context)
    setModel(record.model)
    setMinutes(record.minutes)
    setObjects(record.objects)
    setLines(record.lines)
    setSummary(record.summary)
    setStill(record.still)
    setStep(record.step)
    setError('')
    setSelected(null)
    const interrupted = record.run?.phase === 'running'
    setRun(
      record.run
        ? {
            ...record.run,
            phase: interrupted ? 'paused' : record.run.phase,
            stage: interrupted ? 'Paused when this page closed' : record.run.stage,
          }
        : null,
    )
    if (record.source?.kind === 'file') {
      const name = record.source.name
      const blob = await getMedia(record.id)
      setSource((current) => {
        if (current?.kind === 'file') URL.revokeObjectURL(current.url)
        return { kind: 'file', url: blob ? URL.createObjectURL(blob) : '', name }
      })
      setFileMissing(!blob)
    } else if (record.source?.kind === 'camera') {
      setSource({ kind: 'camera' })
      setFileMissing(false)
    } else {
      setSource(null)
      setFileMissing(false)
    }
    persistOn.current = true
  }

  async function removeSaved(id: string) {
    await dropRun(id)
    setLibrary((items) => items.filter((item) => item.id !== id))
    if (runId.current === id) newRun()
  }

  async function chooseFile(file: File | undefined) {
    if (!file) return
    const id = ensureRun()
    try {
      await putMedia(id, file)
    } catch {
      setError('This browser could not keep the video.')
      return
    }
    stopCamera()
    setFileMissing(false)
    setSource((current) => {
      if (current?.kind === 'file') URL.revokeObjectURL(current.url)
      return { kind: 'file', url: URL.createObjectURL(file), name: file.name }
    })
    setStill(null)
    setObjects([])
    setError('')
    setStep('objects')
  }

  async function chooseCamera() {
    setError('')
    if (!navigator.mediaDevices?.getUserMedia) {
      setError('This browser has no camera access.')
      return
    }
    try {
      ensureRun()
      stopCamera()
      setFileMissing(false)
      const stream = await navigator.mediaDevices.getUserMedia({ video: { width: { ideal: 1280 } }, audio: false })
      streamRef.current = stream
      setSource((current) => {
        if (current?.kind === 'file') URL.revokeObjectURL(current.url)
        return { kind: 'camera' }
      })
      setStill(null)
      setObjects([])
      setStep('objects')
    } catch {
      setError('The camera could not be opened.')
    }
  }

  useEffect(() => {
    const video = videoRef.current
    if (!video || !source) return
    if (source.kind === 'file') {
      if (!source.url) return
      video.srcObject = null
      if (video.dataset.src !== source.url) {
        video.dataset.src = source.url
        video.src = source.url
      }
      return
    }
    const stream = streamRef.current
    if (stream && video.srcObject !== stream) {
      video.srcObject = stream
      void video.play().catch(() => {})
    }
  }, [source, still, step])

  async function identify() {
    const video = videoRef.current
    if (!video) return
    setBusy('Looking at this frame…')
    setError('')
    try {
      const shot = grab(video)
      const response = await fetch('/api/detect', {
        method: 'POST',
        headers: headers(key),
        body: JSON.stringify({
          model,
          title,
          objective: context,
          scope: context,
          image: shot.image,
          width: shot.width,
          height: shot.height,
        }),
      })
      const body = (await response.json()) as { error?: string; objects?: { label: string; bbox: Obj }[] }
      if (!response.ok) throw new Error(body.error ?? 'Objects could not be identified.')
      setStill(shot)
      setObjects(
        (body.objects ?? []).map((item) => ({
          id: crypto.randomUUID(),
          label: item.label,
          x: item.bbox.x,
          y: item.bbox.y,
          w: item.bbox.w,
          h: item.bbox.h,
        })),
      )
      setSelected(null)
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Objects could not be identified.')
    } finally {
      setBusy('')
    }
  }

  function contextForRun() {
    const params = runParams.current
    const names = params.objects.map((item) => item.label.trim()).filter(Boolean)
    return [
      params.context.trim(),
      names.length
        ? `Objects the researcher confirmed. Use these names. Do not invent others unless something new clearly appears.\n${names.map((name) => `- ${name}`).join('\n')}`
        : '',
    ]
      .filter(Boolean)
      .join('\n\n')
  }

  async function postWindow(frames: Frame[], start: number, end: number, duration: number, earlier: Line[], scene: string) {
    control.current.abort = new AbortController()
    const response = await fetch('/api/window', {
      method: 'POST',
      headers: headers(runParams.current.key),
      signal: control.current.abort.signal,
      body: JSON.stringify({
        model: runParams.current.model,
        title: runParams.current.title || 'Recording',
        context: contextForRun(),
        start,
        end,
        duration,
        frames,
        earlier: earlier.slice(-12).map((line) => ({ t: line.t, text: line.text })),
        scene,
      }),
    })
    const body = (await response.json()) as { error?: string; entries?: { t: number; text: string }[]; scene?: string }
    if (!response.ok) throw new Error(body.error ?? 'This stretch could not be read.')
    return body
  }

  async function closeOut(entries: Line[], stopped: boolean) {
    const names = runParams.current.objects.map((item) => item.label.trim()).filter(Boolean)
    let text = entries.length
      ? entries.map((line) => `${formatTime(line.t)} ${line.text}`).join('\n\n')
      : 'Nothing was written to the log.'
    try {
      const response = await fetch('/api/summarize', {
        method: 'POST',
        headers: headers(runParams.current.key),
        body: JSON.stringify({
          model: runParams.current.model,
          title: runParams.current.title,
          context: runParams.current.context,
          objects: names,
          entries: entries.map((line) => ({ t: line.t, text: line.text })),
        }),
      })
      const body = (await response.json()) as { summary?: string }
      if (response.ok && body.summary) text = body.summary
    } catch {
      /* the log itself remains the record */
    }
    if (stopped) text = `Stopped early.\n\n${text}`
    setSummary(text)
    setRun((current) => (current ? { ...current, phase: 'done', stage: stopped ? 'Stopped' : 'Finished' } : current))
  }

  async function readFile(url: string, entries: Line[], from = 0) {
    const video = document.createElement('video')
    video.src = url
    video.muted = true
    video.playsInline = true
    video.preload = 'auto'
    await new Promise<void>((resolve, reject) => {
      video.onloadedmetadata = () => resolve()
      video.onerror = () => reject(new Error('This video could not be read. Use an MP4 or MOV.'))
    })
    const duration = video.duration
    const total = Math.ceil(Math.max(duration - 1, 0) / WINDOW_SECONDS)
    if (!total) throw new Error('The video is too short to read.')
    const startWindow = Math.min(total, Math.floor(Math.max(from, 0) / WINDOW_SECONDS))
    setRun({ phase: 'running', covered: startWindow * WINDOW_SECONDS, duration, stage: 'Starting…', error: null })
    let scene = ''
    for (let index = startWindow; index < total; index++) {
      if (control.current.stopped) break
      while (control.current.paused && !control.current.stopped) await sleep(200)
      if (control.current.stopped) break
      const start = index * WINDOW_SECONDS
      const end = Math.min(start + WINDOW_SECONDS, duration)
      setRun({ phase: 'running', covered: start, duration, stage: `Reading ${formatTime(start)}–${formatTime(end)}`, error: null })
      const frames: Frame[] = []
      try {
        for (let t = start; t < end - 0.05; t += 1) {
          if (control.current.stopped) break
          while (control.current.paused && !control.current.stopped) await sleep(200)
          await seek(video, t)
          const shot = grab(video)
          frames.push({ t, image: shot.image })
        }
      } catch (caught) {
        if (control.current.stopped) break
        entries.push({ id: crypto.randomUUID(), t: start, text: caught instanceof Error ? caught.message : 'This stretch could not be read.' })
        setLines([...entries])
        continue
      }
      if (control.current.stopped || control.current.paused || !frames.length) {
        if (control.current.paused) index -= 1
        continue
      }
      setRun({ phase: 'running', covered: start, duration, stage: 'Writing the log…', error: null })
      try {
        const result = await postWindow(frames, start, end, duration, entries, scene)
        scene = result.scene || scene
        for (const entry of result.entries ?? []) entries.push({ id: crypto.randomUUID(), t: entry.t, text: entry.text })
        setLines([...entries])
      } catch (caught) {
        if (control.current.stopped || control.current.paused || (caught instanceof DOMException && caught.name === 'AbortError')) {
          index -= 1
          continue
        }
        entries.push({ id: crypto.randomUUID(), t: start, text: caught instanceof Error ? caught.message : 'This stretch could not be read.' })
        setLines([...entries])
      }
      setRun({ phase: 'running', covered: end, duration, stage: `Reading ${formatTime(end)}`, error: null })
    }
    video.src = ''
    await closeOut(entries, control.current.stopped)
  }

  async function readCamera(entries: Line[], from = 0) {
    const video = videoRef.current
    if (!video) throw new Error('The camera is no longer open.')
    const duration = Math.max(1, runParams.current.minutes) * 60
    const offset = Math.max(0, from)
    setRun({ phase: 'running', covered: offset, duration, stage: 'Watching…', error: null })
    const started = performance.now() - offset * 1000
    let scene = ''
    let bucket: Frame[] = []
    const flush = async (end: number) => {
      if (!bucket.length) return
      const start = bucket[0].t
      setRun({ phase: 'running', covered: end, duration, stage: 'Writing the log…', error: null })
      const frames = bucket
      bucket = []
      try {
        const result = await postWindow(frames, start, end, duration, entries, scene)
        scene = result.scene || scene
        for (const entry of result.entries ?? []) entries.push({ id: crypto.randomUUID(), t: entry.t, text: entry.text })
        setLines([...entries])
      } catch (caught) {
        if (control.current.stopped || control.current.paused || (caught instanceof DOMException && caught.name === 'AbortError')) {
          bucket = frames
          return
        }
        entries.push({ id: crypto.randomUUID(), t: start, text: caught instanceof Error ? caught.message : 'This stretch could not be read.' })
        setLines([...entries])
      }
    }
    while (!control.current.stopped) {
      while (control.current.paused && !control.current.stopped) await sleep(200)
      if (control.current.stopped) break
      const t = (performance.now() - started) / 1000
      if (t >= duration) break
      setRun({ phase: 'running', covered: t, duration, stage: `Watching ${formatTime(t)}`, error: null })
      try {
        const shot = grab(video)
        bucket.push({ t, image: shot.image })
      } catch (caught) {
        entries.push({ id: crypto.randomUUID(), t, text: caught instanceof Error ? caught.message : 'The camera frame could not be read.' })
        setLines([...entries])
      }
      if (bucket.length >= WINDOW_SECONDS) await flush(t)
      await sleep(1000)
    }
    await flush((performance.now() - started) / 1000)
    await closeOut(entries, control.current.stopped)
  }

  async function attachCamera() {
    if (!navigator.mediaDevices?.getUserMedia) throw new Error('This browser has no camera access.')
    if (!streamRef.current) {
      streamRef.current = await navigator.mediaDevices.getUserMedia({ video: { width: { ideal: 1280 } }, audio: false })
    }
    setSource({ kind: 'camera' })
    setStep('log')
    await waitForVideo()
    const video = videoRef.current
    if (video && video.srcObject !== streamRef.current) {
      video.srcObject = streamRef.current
      await video.play().catch(() => {})
    }
  }

  function beginLoop(entries: Line[], from: number) {
    if (!source) return
    if (source.kind === 'file' && !source.url) {
      setFileMissing(true)
      setError('Choose the video again to continue. The log is still in this browser.')
      return
    }
    control.current = { paused: false, stopped: false, abort: null }
    loopOn.current = true
    runParams.current = { key, model, title, context, objects, source, minutes }
    setError('')
    setStep('log')
    const job =
      source.kind === 'file'
        ? readFile(source.url, entries, from)
        : attachCamera().then(() => readCamera(entries, from))
    void job
      .catch((caught) => {
        setRun({
          phase: 'error',
          covered: from,
          duration: 0,
          stage: 'Stopped',
          error: caught instanceof Error ? caught.message : 'Reading stopped.',
        })
      })
      .finally(() => {
        loopOn.current = false
      })
  }

  function startLog() {
    if (!source) return
    setLines([])
    setSummary('')
    beginLoop([], 0)
  }

  function waitForVideo() {
    return new Promise<void>((resolve, reject) => {
      let tries = 0
      const tick = () => {
        const video = videoRef.current
        if (video && video.videoWidth > 0) resolve()
        else if (++tries > 60) reject(new Error('The camera is no longer open.'))
        else window.setTimeout(tick, 50)
      }
      tick()
    })
  }

  function pause() {
    control.current.paused = true
    control.current.abort?.abort()
    setRun((current) => (current ? { ...current, phase: 'paused', stage: 'Paused' } : current))
  }

  function resume() {
    if (loopOn.current) {
      control.current.paused = false
      setRun((current) => (current && current.phase === 'paused' ? { ...current, phase: 'running', stage: 'Reading…' } : current))
      return
    }
    const from = run?.covered ?? 0
    const kept = lines.filter((line) => line.t < from)
    setLines(kept)
    beginLoop(kept, from)
  }

  function stop() {
    control.current.stopped = true
    control.current.paused = false
    control.current.abort?.abort()
  }

  function record() {
    const names = objects.map((item) => item.label.trim()).filter(Boolean)
    const body = {
      title,
      context,
      model,
      source: source?.kind === 'file' ? source.name : 'camera',
      objects: names,
      log: lines.map((line) => ({ t: line.t, text: line.text })),
      summary,
    }
    const slug = (title || 'arche-vision').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'arche-vision'
    const markdown = [
      `# ${title || 'Arche Vision'}`,
      '',
      context && context,
      '',
      names.length ? `Objects: ${names.join(', ')}.` : '',
      '',
      '## Log',
      '',
      ...lines.map((line) => `${formatTime(line.t)}  ${line.text}`),
      '',
      '## Summary',
      '',
      summary,
      '',
    ]
      .filter((line) => line !== '')
      .join('\n')
    return { slug, body, markdown }
  }

  const fraction = run && run.duration > 0 ? Math.min(1, run.covered / run.duration) : 0
  const running = run?.phase === 'running' || run?.phase === 'paused'

  return (
    <main className="page">
      <header className="top">
        <h1 className="mark">
          Arche <span>Vision</span> <i className="pill">Open</i>
        </h1>
        {keyState === 'ok' && (
          <span className="row">
            {activeId && (
              <button type="button" className="btn-quiet" onClick={newRun}>
                New run
              </button>
            )}
            <button type="button" className="btn-quiet" onClick={forget}>
              {usingEnv && !key ? 'Server key' : 'Forget key'}
            </button>
          </span>
        )}
      </header>
      <p className="lede">
        A recording or a camera becomes a lab log. You bring a Venice key. The video stays in this browser. Frames leave only for the model, and only if Venice still marks that model private.
      </p>

      {keyState !== 'ok' ? (
        <section className="panel grid">
          <p className="note">
            {keyState === 'checking'
              ? 'Checking the key…'
              : 'Paste a Venice API key. It is saved in this browser and sent only to the Arche Vision server running on this computer.'}
          </p>
          <label className="field">
            <span>Venice API key</span>
            <input
              type="password"
              autoComplete="off"
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
              placeholder="vapi-…"
            />
          </label>
          {keyError && <p className="error">{keyError}</p>}
          <div className="row">
            <button type="button" className="btn-primary" disabled={keyState === 'checking' || !draft.trim()} onClick={() => void check(draft.trim())}>
              Use this key
            </button>
            <a className="btn" href="https://venice.ai" target="_blank" rel="noreferrer">
              Get a key
            </a>
          </div>
        </section>
      ) : (
        <>
          <input
            ref={fileRef}
            type="file"
            accept="video/mp4,video/quicktime,video/*"
            hidden
            onChange={(event) => {
              void chooseFile(event.target.files?.[0])
              event.target.value = ''
            }}
          />
          <ol className="steps">
            <li className={step === 'setup' ? 'on' : undefined}>1. Setup</li>
            <li className={step === 'objects' ? 'on' : undefined}>2. Objects</li>
            <li className={step === 'log' ? 'on' : undefined}>3. Log</li>
          </ol>

          {step === 'setup' && (
            <section className="panel grid">
              <label className="field">
                <span>Experiment</span>
                <input
                  value={title}
                  onChange={(event) => {
                    if (event.target.value.trim() || context.trim()) ensureRun()
                    setTitle(event.target.value)
                  }}
                  placeholder="Weighing the dried sample"
                />
              </label>
              <label className="field">
                <span>Context for the log</span>
                <textarea
                  value={context}
                  onChange={(event) => {
                    if (event.target.value.trim() || title.trim()) ensureRun()
                    setContext(event.target.value)
                  }}
                  placeholder="What is happening, and what the names of things are. Ignore the laptop."
                />
              </label>
              <div className="row">
                <label className="field" style={{ flex: '1 1 16rem' }}>
                  <span>Model</span>
                  <select value={model} onChange={(event) => setModel(event.target.value)}>
                    {models.map((item) => (
                      <option key={item.id} value={item.id}>
                        {item.name} — {item.note}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="field" style={{ width: '9rem' }}>
                  <span>Camera, minutes</span>
                  <input
                    type="number"
                    min={1}
                    max={30}
                    value={minutes}
                    onChange={(event) => setMinutes(Math.min(30, Math.max(1, Number(event.target.value) || 1)))}
                  />
                </label>
              </div>
              {error && <p className="error">{error}</p>}
              <div className="row">
                <button type="button" className="btn-primary" onClick={() => fileRef.current?.click()}>
                  Choose a video
                </button>
                <button type="button" className="btn" onClick={() => void chooseCamera()}>
                  Use a camera
                </button>
              </div>
              <p className="note">
                A file is read from start to finish. A camera is watched for the minutes above, or until you stop it. The run is kept in this browser, and a reload can resume it.
              </p>
            </section>
          )}

          {step === 'objects' && source && (
            <section className="stage">
              <div>
                <div className="frame">
                  {still ? (
                    <Still objects={objects} selected={selected} image={still.image} onSelect={setSelected} onChange={setObjects} />
                  ) : fileMissing ? (
                    <p className="note" style={{ margin: 0, padding: 28 }}>
                      The video file is not in this browser. Choose it again and the names you already saved stay.
                    </p>
                  ) : (
                    <video ref={videoRef} controls={source.kind === 'file'} muted playsInline autoPlay={source.kind === 'camera'} />
                  )}
                </div>
                <div className="row" style={{ marginTop: 12 }}>
                  {fileMissing && (
                    <button type="button" className="btn-primary" onClick={() => fileRef.current?.click()}>
                      Choose the video
                    </button>
                  )}
                  {still ? (
                    <button
                      type="button"
                      className="btn"
                      onClick={() => {
                        setStill(null)
                        setObjects([])
                      }}
                    >
                      Choose another frame
                    </button>
                  ) : (
                    !fileMissing && (
                      <button type="button" className="btn-primary" disabled={Boolean(busy)} onClick={() => void identify()}>
                        {busy || 'Identify objects in this frame'}
                      </button>
                    )
                  )}
                  <button type="button" className="btn" onClick={startLog}>
                    {objects.length ? 'Start the log' : 'Start without objects'}
                  </button>
                  <button type="button" className="btn-quiet" onClick={() => setStep('setup')}>
                    Back
                  </button>
                </div>
                {fileMissing && <p className="error" style={{ marginTop: 10 }}>The video is not in this browser anymore. Choose it again and the log stays.</p>}
                {error && <p className="error" style={{ marginTop: 10 }}>{error}</p>}
                <p className="note" style={{ marginTop: 10 }}>
                  {source.kind === 'file'
                    ? `${source.name}. Scrub to a clear frame, then name what’s in it. Those names are used for the rest of the recording.`
                    : 'The names you keep are used for the rest of the watch.'}
                </p>
              </div>
              <aside>
                <p className="kicker">Confirmed objects</p>
                {objects.length === 0 ? (
                  <p className="note">None yet.</p>
                ) : (
                  <ul className="objects">
                    {objects.map((item) => (
                      <li key={item.id}>
                        <input
                          type="text"
                          value={item.label}
                          onFocus={() => setSelected(item.id)}
                          onChange={(event) =>
                            setObjects((all) => all.map((row) => (row.id === item.id ? { ...row, label: event.target.value } : row)))
                          }
                        />
                        <button
                          type="button"
                          className="btn"
                          onClick={() => setObjects((all) => all.filter((row) => row.id !== item.id))}
                        >
                          Remove
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
              </aside>
            </section>
          )}

          {step === 'log' && (
            <section>
              {source?.kind === 'camera' && (
                <div className="frame" style={{ maxWidth: 480, marginBottom: 16 }}>
                  <video ref={videoRef} muted playsInline autoPlay />
                </div>
              )}
              {fileMissing && (
                <p className="error" style={{ marginBottom: 12 }}>
                  Choose the video again to continue. The log is still in this browser.
                  <button type="button" className="btn" style={{ marginLeft: 8 }} onClick={() => fileRef.current?.click()}>
                    Choose the video
                  </button>
                </p>
              )}
              <div className="panel">
                <div className="row" style={{ justifyContent: 'space-between' }}>
                  <p style={{ margin: 0 }}>{run?.error || run?.stage || 'Starting…'}</p>
                  {run && run.duration > 0 && (
                    <p className="note" style={{ margin: 0 }}>
                      {Math.round(fraction * 100)}% · {formatTime(run.covered)} / {formatTime(run.duration)}
                    </p>
                  )}
                </div>
                <div className="bar" style={{ marginTop: 12 }}>
                  <i style={{ width: `${Math.max(running ? 4 : 0, fraction * 100)}%` }} />
                </div>
                <div className="row" style={{ marginTop: 14 }}>
                  {run?.phase === 'running' && (
                    <button type="button" className="btn" onClick={pause}>
                      Pause
                    </button>
                  )}
                  {run?.phase === 'paused' && (
                    <button type="button" className="btn-primary" onClick={resume}>
                      Resume
                    </button>
                  )}
                  {running && (
                    <button type="button" className="btn" onClick={stop}>
                      Stop
                    </button>
                  )}
                  {run?.phase === 'done' && (
                    <>
                      <button
                        type="button"
                        className="btn-primary"
                        onClick={() => {
                          const saved = record()
                          download(`${saved.slug}.md`, saved.markdown, 'text/markdown')
                        }}
                      >
                        Download the note
                      </button>
                      <button
                        type="button"
                        className="btn"
                        onClick={() => {
                          const saved = record()
                          download(`${saved.slug}.json`, JSON.stringify(saved.body, null, 2), 'application/json')
                        }}
                      >
                        Download JSON
                      </button>
                    </>
                  )}
                </div>
              </div>
              {run?.phase === 'done' && (
                <label className="field summary">
                  <span>Summary, yours to edit</span>
                  <textarea value={summary} onChange={(event) => setSummary(event.target.value)} />
                </label>
              )}
              <ol className="log">
                {[...lines].reverse().map((line) => (
                  <li key={line.id}>
                    <span className="t">{formatTime(line.t)}</span>
                    <p>{line.text}</p>
                  </li>
                ))}
              </ol>
              {lines.length === 0 && <p className="note">Nothing written yet.</p>}
            </section>
          )}
        </>
      )}

      {(keyState !== 'ok' || step === 'setup') && library.length > 0 && (
        <section className="panel">
          <p className="kicker">In this browser</p>
          <ul className="objects" style={{ marginTop: 10 }}>
            {library.map((item) => (
              <li key={item.id}>
                <button type="button" className="btn-quiet" style={{ justifyContent: 'flex-start' }} onClick={() => void openSaved(item.id)}>
                  {item.title.trim() || 'Untitled'} · {savedStatus(item)}
                </button>
                <button type="button" className="btn" onClick={() => void removeSaved(item.id)}>
                  Delete
                </button>
              </li>
            ))}
          </ul>
          <p className="note" style={{ marginTop: 10 }}>
            Private-local. Only this browser has these runs. Clearing site data removes them.
          </p>
        </section>
      )}

      <p className="foot">
        Open edition of Arche Vision, MIT license, from Heterodox Labs. No account and no Arche database. The run and the video are stored in this browser only, like a private-local session. Clearing site data or another browser loses them. Each 20 seconds of picture is sampled once a second and sent to Venice with your key, after a check that the model is private. A reload pauses the run; resume continues from the last stretch.
      </p>
    </main>
  )
}

function Still({
  image,
  objects,
  selected,
  onSelect,
  onChange,
}: {
  image: string
  objects: Obj[]
  selected: string | null
  onSelect: (id: string) => void
  onChange: (objects: Obj[]) => void
}) {
  const frame = useRef<HTMLDivElement>(null)
  const draw = useRef<{ x: number; y: number } | null>(null)
  const ghostRef = useRef<Obj | null>(null)
  const [ghost, setGhost] = useState<Obj | null>(null)

  function point(event: ReactPointerEvent) {
    const rect = frame.current!.getBoundingClientRect()
    return {
      x: Math.min(100, Math.max(0, ((event.clientX - rect.left) / rect.width) * 100)),
      y: Math.min(100, Math.max(0, ((event.clientY - rect.top) / rect.height) * 100)),
    }
  }

  return (
    <div
      ref={frame}
      style={{ position: 'relative' }}
      onPointerDown={(event) => {
        if ((event.target as HTMLElement).closest('[data-box]')) return
        frame.current?.setPointerCapture(event.pointerId)
        const at = point(event)
        draw.current = at
        const next = { id: 'ghost', label: 'Object', ...at, w: 0, h: 0 }
        ghostRef.current = next
        setGhost(next)
      }}
      onPointerMove={(event) => {
        if (!draw.current) return
        const at = point(event)
        const next = {
          id: 'ghost',
          label: 'Object',
          x: Math.min(draw.current.x, at.x),
          y: Math.min(draw.current.y, at.y),
          w: Math.abs(at.x - draw.current.x),
          h: Math.abs(at.y - draw.current.y),
        }
        ghostRef.current = next
        setGhost(next)
      }}
      onPointerUp={() => {
        const box = ghostRef.current
        draw.current = null
        ghostRef.current = null
        setGhost(null)
        if (!box || box.w < 1 || box.h < 1) return
        const id = crypto.randomUUID()
        onChange([...objects, { ...box, id, label: 'Object' }])
        onSelect(id)
      }}
    >
      {/* The still is the bitmap that was sent, so a box drawn in percent lands on the same pixels. */}
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src={image} alt="Frame chosen for object identification" />
      {[...objects, ...(ghost && ghost.w > 0 ? [ghost] : [])].map((item) => (
        <button
          key={item.id}
          type="button"
          data-box
          className={item.id === selected ? 'box on' : 'box'}
          style={{ left: `${item.x}%`, top: `${item.y}%`, width: `${item.w}%`, height: `${item.h}%` }}
          onClick={() => onSelect(item.id)}
        >
          <b>{item.label || 'Object'}</b>
        </button>
      ))}
    </div>
  )
}
