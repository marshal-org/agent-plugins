import type { EngineInterface } from 'claude-code'

// What Autopilot reads from GitHub, with the person's own `gh` in this
// session: a pull request's files (for component rules), its merge bar at
// the head (Cruise merges), its checks and a failing job's log (US4). No
// token is passed to Marshal; nothing here writes to GitHub.

async function gh($: EngineInterface, args: string[]): Promise<{ ok: boolean; out: string; err: string }> {
  try {
    const r = await $.process.run(['gh', ...args], { timeoutMs: 30_000 })
    return { ok: r.exitCode === 0, out: r.stdout, err: r.stderr }
  } catch (err) {
    return { ok: false, out: '', err: err instanceof Error ? err.message : String(err) }
  }
}

function json(s: string): unknown {
  try {
    return JSON.parse(s)
  } catch {
    return undefined
  }
}

const REPO = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/

export async function prFiles($: EngineInterface, repo: string, number: number): Promise<{ title: string; paths: string[] } | undefined> {
  if (!REPO.test(repo) || !(number > 0)) return undefined
  const r = await gh($, ['pr', 'view', String(number), '--repo', repo, '--json', 'files,title'])
  const v = r.ok ? (json(r.out) as { files?: { path?: unknown }[]; title?: unknown } | undefined) : undefined
  if (!v || !Array.isArray(v.files)) return undefined
  return { title: typeof v.title === 'string' ? v.title : '', paths: v.files.map(f => (typeof f.path === 'string' ? f.path : '')).filter(Boolean) }
}

export type Bar = { ok: true; head: string } | { ok: false; reason: string }

// The repository's own merge bar at the PR's current head: its required
// checks pass, its required reviews are given, no review thread is open.
// Anything unreadable fails the bar.
export async function mergeBar($: EngineInterface, repo: string, number: number): Promise<Bar> {
  if (!REPO.test(repo) || !(number > 0)) return { ok: false, reason: 'the pull request is unknown' }
  const view = await gh($, ['pr', 'view', String(number), '--repo', repo, '--json', 'headRefOid,reviewDecision,state,isDraft'])
  const v = view.ok ? (json(view.out) as { headRefOid?: string; reviewDecision?: string; state?: string; isDraft?: boolean } | undefined) : undefined
  if (!v || !v.headRefOid) return { ok: false, reason: `could not read ${repo}#${number} with gh` }
  if (v.state && v.state !== 'OPEN') return { ok: false, reason: `${repo}#${number} is ${v.state.toLowerCase()}` }
  if (v.isDraft) return { ok: false, reason: `${repo}#${number} is a draft` }
  if (v.reviewDecision === 'CHANGES_REQUESTED' || v.reviewDecision === 'REVIEW_REQUIRED') {
    return { ok: false, reason: `${repo}#${number}: required reviews are not given (${v.reviewDecision.toLowerCase().replace('_', ' ')})` }
  }
  const checks = await gh($, ['pr', 'checks', String(number), '--repo', repo, '--required', '--json', 'name,bucket'])
  const list = json(checks.out) as { name?: string; bucket?: string }[] | undefined
  if (Array.isArray(list)) {
    const bad = list.filter(c => c.bucket !== 'pass' && c.bucket !== 'skipping')
    if (bad.length > 0) return { ok: false, reason: `${repo}#${number}: required checks not passing (${bad.map(c => `${c.name}: ${c.bucket}`).join(', ')})` }
  } else if (!/no required checks/i.test(`${checks.out} ${checks.err}`)) {
    return { ok: false, reason: `could not read ${repo}#${number}'s required checks with gh` }
  }
  const [owner, name] = repo.split('/') as [string, string]
  const q = 'query($owner:String!,$name:String!,$number:Int!){repository(owner:$owner,name:$name){pullRequest(number:$number){headRefOid reviewThreads(first:100){totalCount pageInfo{hasNextPage} nodes{isResolved}}}}}'
  const threads = await gh($, ['api', 'graphql', '-f', `query=${q}`, '-F', `owner=${owner}`, '-F', `name=${name}`, '-F', `number=${number}`])
  const t = threads.ok
    ? (json(threads.out) as { data?: { repository?: { pullRequest?: { headRefOid?: string; reviewThreads?: { totalCount?: number; pageInfo?: { hasNextPage?: boolean }; nodes?: { isResolved?: boolean }[] } } } } } | undefined)
    : undefined
  const pr = t?.data?.repository?.pullRequest
  const nodes = pr?.reviewThreads?.nodes
  if (!pr || !Array.isArray(nodes)) return { ok: false, reason: `could not read ${repo}#${number}'s review threads with gh` }
  if (pr.headRefOid && pr.headRefOid !== v.headRefOid) return { ok: false, reason: `${repo}#${number} moved while it was checked` }
  // One page of threads is read: more than that (or a count it cannot read)
  // fails the bar rather than judge from part of them.
  const rt = pr.reviewThreads!
  if (rt.pageInfo?.hasNextPage !== false || typeof rt.totalCount !== 'number' || rt.totalCount > nodes.length) {
    return { ok: false, reason: `${repo}#${number} has more review threads than one read shows (${typeof rt.totalCount === 'number' ? rt.totalCount : 'unknown'})` }
  }
  const open = nodes.filter(n => n.isResolved !== true).length
  if (open > 0) return { ok: false, reason: `${repo}#${number}: ${open} review thread${open > 1 ? 's are' : ' is'} unresolved` }
  return { ok: true, head: v.headRefOid }
}
