import type { EngineInterface } from 'claude-code'

// Watching what running runs produce (US4): their pull requests' checks.
// A failure's identity is the check's name plus its failing step; it counts
// across new pushes to the same PR and resets when that check passes. The
// second failure of one identity sends the run the failing step's log tail
// once (redacted, at most 200 lines and 16 KB); the third notifies the
// person. A running run silent past the person's limit notifies too. In
// Shadow it only notifies. Logs are read with the person's own gh; no token
// reaches Marshal or the run.

export const TAIL_LINES = 200
export const TAIL_BYTES = 16 * 1024
export const PRS_PER_CYCLE = 5
// A PR's checks are read again at most this often.
export const PR_REREAD_MS = 60_000

export type FailedCheck = { name: string; runId: string; jobId: string; url: string }

export function failedChecks(rollup: unknown): { head: string; failed: FailedCheck[]; passed: string[] } | undefined {
  const v = rollup && typeof rollup === 'object' ? (rollup as { headRefOid?: unknown; statusCheckRollup?: unknown }) : undefined
  if (!v || typeof v.headRefOid !== 'string' || !Array.isArray(v.statusCheckRollup)) return undefined
  const failed: FailedCheck[] = []
  const passed: string[] = []
  for (const c of v.statusCheckRollup as Record<string, unknown>[]) {
    if (c.__typename !== undefined && c.__typename !== 'CheckRun') continue
    const name = typeof c.name === 'string' ? c.name : ''
    const conclusion = String(c.conclusion ?? '').toUpperCase()
    if (!name) continue
    if (conclusion === 'SUCCESS') passed.push(name)
    if (conclusion !== 'FAILURE' && conclusion !== 'TIMED_OUT') continue
    const url = typeof c.detailsUrl === 'string' ? c.detailsUrl : ''
    const m = /\/actions\/runs\/(\d+)\/job\/(\d+)/.exec(url)
    failed.push({ name, runId: m?.[1] ?? '', jobId: m?.[2] ?? '', url })
  }
  return { head: v.headRefOid, failed, passed }
}

// `gh run view --log-failed` prints "job<TAB>step<TAB>line" rows.
export function parseFailedLog(text: string): { step: string; lines: string[] } {
  let step = ''
  const lines: string[] = []
  for (const row of text.split('\n')) {
    if (!row) continue
    const parts = row.split('\t')
    if (parts.length >= 3) {
      if (!step) step = parts[1]!.trim()
      lines.push(parts.slice(2).join('\t'))
    } else lines.push(row)
  }
  return { step: step || 'unknown step', lines }
}

const SECRET_PATTERNS: [RegExp, string][] = [
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(-----END [A-Z ]*PRIVATE KEY-----|$)/g, '[REDACTED PRIVATE KEY]'],
  [/\b(Authorization\s*[:=]\s*["']?(?:Bearer|Basic|token)\s+)(?!\*\*\*)[^\s'"]+/gi, '$1[REDACTED]'],
  [/\b(Bearer\s+)[A-Za-z0-9._~+/-]{16,}=*/g, '$1[REDACTED]'],
  [/\b([a-z][a-z0-9+.-]*:\/\/)[^\s/:@'"]+:[^\s/@'"]+@/gi, '$1[REDACTED]@'],
  [/\b(gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})/g, '[REDACTED]'],
  [/\b(sk|rk)_(live|test)_[A-Za-z0-9]{10,}/g, '[REDACTED]'],
  [/\bglpat-[A-Za-z0-9_-]{20,}/g, '[REDACTED]'],
  [/\bnpm_[A-Za-z0-9]{36}\b/g, '[REDACTED]'],
  [/\bya29\.[A-Za-z0-9_-]{20,}/g, '[REDACTED]'],
  [/\b(AKIA|ASIA)[0-9A-Z]{16}\b/g, '[REDACTED]'],
  [/\bAIza[0-9A-Za-z_-]{35}\b/g, '[REDACTED]'],
  [/\bsk-(ant-)?[A-Za-z0-9_-]{20,}/g, '[REDACTED]'],
  [/\bxox[abprs]-[A-Za-z0-9-]{10,}/g, '[REDACTED]'],
  [/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g, '[REDACTED JWT]'],
  [/\b([A-Za-z0-9_]*(TOKEN|SECRET|PASSWORD|PASSWD|API_KEY|ACCESS_KEY|PRIVATE_KEY)[A-Za-z0-9_]*)(\s*[=:]\s*)(?!\*\*\*)[^\s'"]+/gi, '$1$3[REDACTED]'],
  [/\b(password|passwd|pwd)(\s*[=:]\s*)(?!\*\*\*)[^\s'"]+/gi, '$1$2[REDACTED]'],
]

// Common secret shapes out of a log before it goes anywhere. GitHub's own
// *** masking is kept as it is.
export function redact(text: string): { text: string; redacted: boolean } {
  let out = text
  for (const [re, by] of SECRET_PATTERNS) out = out.replace(re, by)
  return { text: out, redacted: out !== text }
}

// The last lines of the failing step, at most TAIL_LINES and TAIL_BYTES.
export function tailOf(lines: readonly string[]): string {
  const kept = lines.slice(-TAIL_LINES)
  let text = kept.join('\n')
  const enc = new TextEncoder()
  while (enc.encode(text).length > TAIL_BYTES && text.includes('\n')) text = text.slice(text.indexOf('\n') + 1)
  if (enc.encode(text).length > TAIL_BYTES) text = text.slice(-TAIL_BYTES / 2)
  return text
}

// What the failure says, without what changes on every run (times, ids).
export function failureHash(text: string): string {
  const norm = text
    .replace(/\d{4}-\d{2}-\d{2}[T ][\d:.]+Z?/g, '')
    .replace(/\b\d+(\.\d+)?\s?(ms|s|m)\b/g, '')
    .replace(/\b[0-9a-f]{7,40}\b/g, '')
    .replace(/\s+/g, ' ')
    .trim()
  let h = 2166136261
  for (let i = 0; i < norm.length; i++) h = Math.imul(h ^ norm.charCodeAt(i), 16777619)
  return (h >>> 0).toString(16)
}

export type Identity = { count: number; jobs: Set<string>; hash: string; messaged: boolean; notified: boolean; step: string }

export type PrWatch = {
  key: string
  server: string
  runId: string
  repo: string
  number: number
  readAt: number
  head: string
  ids: Map<string, Identity>
  skipped: string
}

export const watch = {
  prs: new Map<string, PrWatch>(),
  cursor: 0,
  // When each running run last showed activity (a push, a question, a new
  // state), and whether its silence was reported.
  runs: new Map<string, { state: string; since: number; reported: boolean; turnReadAt?: number }>(),
}

export function resetWatch(): void {
  watch.prs.clear()
  watch.cursor = 0
  watch.runs.clear()
}

async function gh($: EngineInterface, args: string[]): Promise<{ ok: boolean; out: string; err: string }> {
  try {
    const r = await $.process.run(['gh', ...args], { timeoutMs: 30_000 })
    return { ok: r.exitCode === 0, out: r.stdout, err: r.stderr }
  } catch (err) {
    return { ok: false, out: '', err: err instanceof Error ? err.message : String(err) }
  }
}

export async function readRollup($: EngineInterface, repo: string, number: number): Promise<ReturnType<typeof failedChecks> | string> {
  const r = await gh($, ['pr', 'view', String(number), '--repo', repo, '--json', 'headRefOid,statusCheckRollup'])
  // gh's own error text can carry remote URLs or token hints: not shown.
  if (!r.ok) return `gh could not read ${repo}#${number}'s checks`
  try {
    return failedChecks(JSON.parse(r.out)) ?? `gh gave no checks for ${repo}#${number}`
  } catch {
    return `gh gave no checks for ${repo}#${number}`
  }
}

export async function readFailedLog($: EngineInterface, repo: string, c: FailedCheck): Promise<{ step: string; lines: string[] } | undefined> {
  if (!c.runId || !c.jobId) return undefined
  const r = await gh($, ['run', 'view', c.runId, '--repo', repo, '--job', c.jobId, '--log-failed'])
  return r.ok ? parseFailedLog(r.out) : undefined
}

export function nudgeText(check: string, step: string, pr: string, count: number, changed: boolean, tail: string): string {
  const lines = tail.split('\n').length
  return [
    `Autopilot: the check "${check}" failed again on ${pr}, at the step "${step}" (${count} times now, ${changed ? 'with different output' : 'with the same output'}).`,
    `The failing step's last ${lines} log lines follow, with secrets redacted. Fix the cause before pushing again; one more identical failure goes to the person.`,
    '```',
    tail,
    '```',
  ].join('\n')
}
