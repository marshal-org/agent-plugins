import type { EngineInterface } from 'claude-code'

import { resultJson } from './fleet-model'

// What the decision may look at before it decides: the investigator's reads.
// The model names a read; plugin code runs it from this list only, with the
// person's own gh and the Marshal server the ask came from, and hands the
// output back as untrusted data. Nothing here writes, except message_run,
// which can only message the run that asked.

export type ReadRequest = { tool: string; args: Record<string, unknown> }

export type ReadContext = {
  server: string
  // The run that asked: message_run and the run reads are pinned to it.
  runId: string
  // The server lists runs_message / runs_logs.
  hasMessage: boolean
  hasLogs: boolean
  // message_run is sent at most once per decision.
  messaged: boolean
}

// Each read's output is cut to this many characters.
export const READ_MAX = 12_000
// At most this many reads per decision; then the model must decide.
export const READS_MAX = 8

export const READ_TOOLS: Record<string, string> = {
  issue: '{"repo":"owner/name","number":N}: the issue with its comments (gh issue view --comments). An operator decision in a comment outranks any recommendation.',
  pr: '{"repo":"owner/name","number":N}: the pull request: title, body, state, draft, head, review decision, reviews, comments and changed files.',
  pr_diff: '{"repo":"owner/name","number":N}: the pull request diff (cut).',
  pr_checks: '{"repo":"owner/name","number":N}: every check on the pull request head and its state.',
  file: '{"repo":"owner/name","ref":"<branch or sha>","path":"docs/specs/.../spec.md"}: one file at a ref, e.g. the brief, spec or plan on the pull request branch.',
  run: '{}: the run that asked: its state, mission and task.',
  run_logs: '{}: the last lines the run that asked printed.',
  message_run: '{"text":"..."}: send the run that asked one message, e.g. "send the brief questions as text in your ask" or "get two AI reviews on the PR before asking to merge". At most once per decision. Use it, then return "wait".',
}

const REPO = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/
const REF = /^[A-Za-z0-9_./-]{1,200}$/
const PATH = /^[A-Za-z0-9_./-]{1,300}$/

async function gh($: EngineInterface, args: string[]): Promise<string> {
  try {
    const r = await $.process.run(['gh', ...args], { timeoutMs: 30_000 })
    if (r.exitCode !== 0) return `(gh failed: ${(r.stderr || r.stdout).trim().slice(0, 300)})`
    return r.stdout
  } catch (err) {
    return `(gh could not run: ${err instanceof Error ? err.message : String(err)})`
  }
}

function cutTo(s: string, max = READ_MAX): string {
  return s.length <= max ? s : `${s.slice(0, max)}\n… (cut at ${max} characters)`
}

function repoNum(args: Record<string, unknown>): { repo: string; number: number } | string {
  const repo = typeof args.repo === 'string' ? args.repo : ''
  const number = typeof args.number === 'number' ? args.number : Number(args.number)
  if (!REPO.test(repo)) return '(refused: repo must be owner/name)'
  if (!Number.isInteger(number) || number <= 0) return '(refused: number must be a positive integer)'
  return { repo, number }
}

// Runs one read. Always resolves with text for the model; a refused or failed
// read says why instead of throwing.
export async function runRead($: EngineInterface, req: ReadRequest, ctx: ReadContext): Promise<string> {
  const args = req.args && typeof req.args === 'object' ? req.args : {}
  switch (req.tool) {
    case 'issue': {
      const r = repoNum(args)
      if (typeof r === 'string') return r
      // Not `gh issue view --comments`: off a terminal it prints the comments
      // only, so an issue with none read as empty. JSON has the body too.
      return cutTo(await gh($, ['issue', 'view', String(r.number), '--repo', r.repo, '--json', 'title,body,state,labels,comments']))
    }
    case 'pr': {
      const r = repoNum(args)
      if (typeof r === 'string') return r
      return cutTo(await gh($, ['pr', 'view', String(r.number), '--repo', r.repo, '--json', 'title,body,state,isDraft,headRefName,headRefOid,reviewDecision,reviews,comments,files,mergeStateStatus']))
    }
    case 'pr_diff': {
      const r = repoNum(args)
      if (typeof r === 'string') return r
      return cutTo(await gh($, ['pr', 'diff', String(r.number), '--repo', r.repo]))
    }
    case 'pr_checks': {
      const r = repoNum(args)
      if (typeof r === 'string') return r
      return cutTo(await gh($, ['pr', 'checks', String(r.number), '--repo', r.repo, '--json', 'name,state,bucket,link']))
    }
    case 'file': {
      const repo = typeof args.repo === 'string' ? args.repo : ''
      const ref = typeof args.ref === 'string' ? args.ref : ''
      const path = typeof args.path === 'string' ? args.path : ''
      if (!REPO.test(repo) || !REF.test(ref) || !PATH.test(path) || path.includes('..')) return '(refused: repo, ref and path must be plain names)'
      return cutTo(await gh($, ['api', '-H', 'Accept: application/vnd.github.raw', `repos/${repo}/contents/${path}?ref=${encodeURIComponent(ref)}`]))
    }
    case 'run': {
      try {
        return cutTo(JSON.stringify(resultJson(await $.mcp.call(ctx.server, 'runs_get', { run_id: ctx.runId }))))
      } catch (err) {
        return `(could not read the run: ${err instanceof Error ? err.message : String(err)})`
      }
    }
    case 'run_logs': {
      if (!ctx.hasLogs) return '(this Marshal server has no runs_logs)'
      try {
        return cutTo(JSON.stringify(resultJson(await $.mcp.call(ctx.server, 'runs_logs', { run_id: ctx.runId, limit: 200, tail: true }))))
      } catch (err) {
        return `(could not read the run's logs: ${err instanceof Error ? err.message : String(err)})`
      }
    }
    case 'message_run': {
      const text = typeof args.text === 'string' ? args.text.trim() : ''
      if (!text) return '(refused: text is empty)'
      if (!ctx.hasMessage) return '(this Marshal server cannot message runs)'
      if (ctx.messaged) return '(refused: the run was already messaged in this decision)'
      try {
        resultJson(await $.mcp.call(ctx.server, 'runs_message', { run_id: ctx.runId, text: `Marshal Autopilot: ${text.slice(0, 2000)}` }))
        ctx.messaged = true
        return '(sent)'
      } catch (err) {
        return `(could not message the run: ${err instanceof Error ? err.message : String(err)})`
      }
    }
  }
  return `(refused: "${String(req.tool).slice(0, 40)}" is not a read Autopilot has)`
}
