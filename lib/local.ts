/**
 * Private-local storage for the open edition. The run lives in this browser.
 * The video file lives beside it. Nothing here is sent to Arche.
 */

const DB = 'arche.vision.open'
const RUNS = 'runs'
const MEDIA = 'media'

export type LocalObject = { id: string; label: string; x: number; y: number; w: number; h: number }
export type LocalLine = { id: string; t: number; text: string }
export type LocalStep = 'setup' | 'objects' | 'log'
export type LocalSource = { kind: 'file'; name: string } | { kind: 'camera' }

export type LocalRunState = {
  phase: 'running' | 'paused' | 'done' | 'error'
  covered: number
  duration: number
  stage: string
  error: string | null
}

export type LocalRun = {
  id: string
  title: string
  context: string
  model: string
  minutes: number
  step: LocalStep
  source: LocalSource | null
  objects: LocalObject[]
  still: { image: string; width: number; height: number } | null
  lines: LocalLine[]
  summary: string
  run: LocalRunState | null
  createdAt: number
  updatedAt: number
}

let opened: Promise<IDBDatabase> | null = null

function open(): Promise<IDBDatabase> {
  opened ??= new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(DB, 1)
    request.onupgradeneeded = () => {
      const db = request.result
      if (!db.objectStoreNames.contains(RUNS)) db.createObjectStore(RUNS)
      if (!db.objectStoreNames.contains(MEDIA)) db.createObjectStore(MEDIA)
    }
    request.onsuccess = () => {
      const db = request.result
      db.onclose = () => (opened = null)
      db.onversionchange = () => {
        db.close()
        opened = null
      }
      resolve(db)
    }
    request.onerror = () => {
      opened = null
      reject(request.error)
    }
  })
  return opened
}

function requestToPromise<T>(request: IDBRequest<T>) {
  return new Promise<T>((resolve, reject) => {
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
  })
}

export async function listRuns(): Promise<LocalRun[]> {
  const db = await open()
  const tx = db.transaction(RUNS, 'readonly')
  const rows = await requestToPromise(tx.objectStore(RUNS).getAll())
  return (rows as LocalRun[]).filter((row) => row && row.id).sort((a, b) => b.updatedAt - a.updatedAt)
}

export async function getRun(id: string): Promise<LocalRun | null> {
  const db = await open()
  const tx = db.transaction(RUNS, 'readonly')
  const row = await requestToPromise(tx.objectStore(RUNS).get(id))
  return (row as LocalRun | undefined) ?? null
}

export async function putRun(run: LocalRun) {
  const db = await open()
  const tx = db.transaction(RUNS, 'readwrite')
  tx.objectStore(RUNS).put(run, run.id)
  await new Promise<void>((resolve, reject) => {
    tx.oncomplete = () => resolve()
    tx.onerror = () => reject(tx.error)
  })
}

export async function dropRun(id: string) {
  const db = await open()
  const tx = db.transaction([RUNS, MEDIA], 'readwrite')
  tx.objectStore(RUNS).delete(id)
  tx.objectStore(MEDIA).delete(id)
  await new Promise<void>((resolve, reject) => {
    tx.oncomplete = () => resolve()
    tx.onerror = () => reject(tx.error)
  })
}

export async function putMedia(id: string, file: Blob) {
  const db = await open()
  const tx = db.transaction(MEDIA, 'readwrite')
  tx.objectStore(MEDIA).put(file, id)
  await new Promise<void>((resolve, reject) => {
    tx.oncomplete = () => resolve()
    tx.onerror = () => reject(tx.error)
  })
}

export async function getMedia(id: string): Promise<Blob | null> {
  const db = await open()
  const tx = db.transaction(MEDIA, 'readonly')
  const row = await requestToPromise(tx.objectStore(MEDIA).get(id))
  return (row as Blob | undefined) ?? null
}
