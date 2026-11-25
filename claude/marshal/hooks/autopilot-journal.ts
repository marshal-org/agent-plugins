import type { EngineInterface } from 'claude-code'

import type { AutopilotOutcome } from '../types'
import { appendPrivate, dataDir, readText, removeFile } from './autopilot-files'

// The local journal: one JSON line per decision, a file per day in the
// plugin's data folder, mode 0600. Not an audit log: never uploaded, not
// tamper-evident. "Seen" is derived from it, so a restarted session never
// decides an ask twice.

export type JournalEntry = {
  t: string
  at: number
  server: string
  ask_id: string
  run_id: string
  run_label: string
  outcome: AutopilotOutcome
  answer: string
  rule_id: string
  rule: string
  reasoning: string
  reason: string
  gate: string
  mode: string
  policy_mtime: number
  ask: { question: string; choices: string[]; rung: string; deputy: string }
  accepted: boolean
  via_stored: boolean | null
  redacted: boolean
  space_hosted: boolean
  // For check watching: the check's identity (name and failing step).
  check?: string
  pr?: string
  expires_in_min?: number
}

export const ENTRY_MAX = 4096
const ASK_MAX = 2048
// Under $.fs's 4 MiB read cap, so a file is always read back whole.
export const ROTATE_BYTES = 4_000_000

function bytes(s: string): number {
  return new TextEncoder().encode(s).length
}

function cutTo(s: string, max: number): string {
  if (bytes(s) <= max) return s
  let out = s.slice(0, max)
  while (bytes(out) > max - 1) out = out.slice(0, -16)
  return `${out}…`
}

// One line of at most ENTRY_MAX bytes: the ask is cut at 2 KB, then the
// reasoning and the ask again until the line fits.
export function entryLine(e: JournalEntry): string {
  const c: JournalEntry = {
    ...e,
    reasoning: cutTo(e.reasoning, 800),
    reason: cutTo(e.reason, 400),
    rule: cutTo(e.rule, 400),
    answer: cutTo(e.answer, 600),
    ask: { ...e.ask, question: cutTo(e.ask.question, ASK_MAX), choices: e.ask.choices.slice(0, 10).map(x => cutTo(x, 120)) },
  }
  let line = JSON.stringify(c)
  for (let budget = 1200; bytes(line) > ENTRY_MAX && budget > 0; budget -= 300) {
    c.ask.question = cutTo(c.ask.question, budget)
    c.reasoning = cutTo(c.reasoning, Math.max(100, budget / 2))
    line = JSON.stringify(c)
  }
  return line
}

export function dayOf(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10)
}

const FILE = /^(\d{4}-\d{2}-\d{2})(?:\.(\d+))?\.jsonl$/

// The journal in memory: the latest entry per ask, every entry for checks.
export const journal = {
  byAsk: new Map<string, JournalEntry>(),
  checks: [] as JournalEntry[],
  loaded: false,
  file: '',
  fileBytes: 0,
}

export function resetJournal(): void {
  journal.byAsk.clear()
  journal.checks = []
  journal.loaded = false
  journal.file = ''
  journal.fileBytes = 0
}

function remember(e: JournalEntry): void {
  if (e.ask_id) journal.byAsk.set(e.ask_id, e)
  else journal.checks.push(e)
  if (journal.checks.length > 500) journal.checks = journal.checks.slice(-500)
}

export function parseLines(text: string): JournalEntry[] {
  const out: JournalEntry[] = []
  for (const line of text.split('\n')) {
    if (!line.trim()) continue
    try {
      const e = JSON.parse(line) as JournalEntry
      if (e && typeof e === 'object' && typeof e.outcome === 'string') out.push(e)
    } catch {
      // A torn last line is skipped.
    }
  }
  return out
}

// At session start: prune files past the retention window, then rebuild the
// index from every file left (asks expire within a day, so all open asks
// are covered).
export async function loadJournal($: EngineInterface, now: number, keepDays: number): Promise<void> {
  if (journal.loaded) return
  journal.loaded = true
  const dir = `${await dataDir($)}/journal`
  let names: string[] = []
  try {
    names = (await $.fs.list(dir)).filter(e => e.kind === 'file').map(e => e.name)
  } catch {
    return
  }
  const cutoff = dayOf(now - keepDays * 86_400_000)
  const kept: string[] = []
  for (const name of names) {
    const m = FILE.exec(name)
    if (!m) continue
    if (m[1]! < cutoff) await removeFile($, `${dir}/${name}`).catch(() => undefined)
    else kept.push(name)
  }
  kept.sort((a, b) => {
    const ma = FILE.exec(a)!
    const mb = FILE.exec(b)!
    return ma[1] === mb[1] ? Number(ma[2] ?? 0) - Number(mb[2] ?? 0) : ma[1]! < mb[1]! ? -1 : 1
  })
  for (const name of kept) {
    const text = await readText($, `${dir}/${name}`)
    if (text) for (const e of parseLines(text)) remember(e)
  }
}

async function fileFor($: EngineInterface, now: number, add: number): Promise<string> {
  const dir = `${await dataDir($)}/journal`
  const day = dayOf(now)
  if (journal.file.includes(day) && journal.fileBytes + add <= ROTATE_BYTES) return journal.file
  // A new day, or the file would pass the cap: the next free part of today.
  for (let part = 0; part < 1000; part++) {
    const path = `${dir}/${day}${part === 0 ? '' : `.${part}`}.jsonl`
    let size = 0
    try {
      size = (await $.fs.stat(path)).size
    } catch {
      size = 0
    }
    if (size + add <= ROTATE_BYTES) {
      journal.file = path
      journal.fileBytes = size
      return path
    }
  }
  return `${dir}/${day}.overflow.jsonl`
}

export async function record($: EngineInterface, e: JournalEntry): Promise<void> {
  remember(e)
  const line = entryLine(e)
  try {
    const path = await fileFor($, e.at, bytes(line) + 1)
    await appendPrivate($, path, line)
    journal.fileBytes += bytes(line) + 1
  } catch {
    // The decision stands in memory; the journal is best effort on disk.
  }
}

export function seen(askId: string): JournalEntry | undefined {
  return journal.byAsk.get(askId)
}

export function recentEntries(limit: number): JournalEntry[] {
  return [...journal.byAsk.values()].sort((a, b) => b.at - a.at).slice(0, limit)
}
