import type { EngineInterface } from 'claude-code'

import { appendPrivate, dataDir, mtimeOf, readText, removeFile, writePrivate } from './autopilot-files'
import { KINDS, KIND_WORDS, MODES, isNeverAuto, presetRules, type Kind, type Mode, type Rule } from './autopilot-presets'
import { parseYaml, stringifyYaml, YamlError, type Yaml } from './autopilot-yaml'

// The person's Autopilot policy (policy.yaml), the train overlay
// (train.yaml) and the train's decisions (train-decisions.jsonl), all in the
// plugin's data folder. The engine reads only the structured rules here; the
// skill turns plain words into them and shows them back through
// ruleWords before anything is saved.

export type Component = { name: string; repo: string; paths: string[]; says: string }

export type Limits = {
  answersPerCycle: number
  notifyGroupOver: number
  expiryMinutes: number
  silenceMinutes: number
  journalDays: number
}

export type Policy = {
  version: 1
  mode: Mode
  // false after stop: Autopilot is off until turned on again.
  enabled: boolean
  paused: boolean
  // The Marshal MCP servers it watches, by their /mcp names.
  servers: string[]
  // Only these deputies / repositories, when set.
  watchDeputies: string[]
  watchRepos: string[]
  // Cruise mode approves merges only when this is on.
  mergeBar: boolean
  // The model the decision call uses (an alias or id).
  model: string
  notifyDesktop: boolean
  rules: Rule[]
  components: Component[]
  limits: Limits
}

export type Decision = {
  at: string
  kind: string
  repo: string
  deputy: string
  question: string
  // The person's answer; empty when the server did not say what it was.
  answer: string
  source: 'person' | 'skill'
}

export type Overlay = { train: string; rules: Rule[]; decisions: Decision[] }

export const DEFAULT_LIMITS: Limits = { answersPerCycle: 3, notifyGroupOver: 3, expiryMinutes: 10, silenceMinutes: 30, journalDays: 30 }
export const DEFAULT_MODEL = 'sonnet'

export const POLICY_FILE = 'policy.yaml'
export const OVERLAY_FILE = 'train.yaml'
export const DECISIONS_FILE = 'train-decisions.jsonl'

type Obj = { [k: string]: Yaml }

function isObj(v: Yaml | undefined): v is Obj {
  return v !== null && v !== undefined && typeof v === 'object' && !Array.isArray(v)
}

function strList(v: Yaml | undefined, field: string): string[] {
  if (v === undefined || v === null) return []
  if (typeof v === 'string') return [v]
  if (!Array.isArray(v)) throw new Error(`${field} must be a list`)
  return v.map(x => {
    if (typeof x !== 'string' && typeof x !== 'number') throw new Error(`${field} must be a list of words`)
    return String(x).trim()
  }).filter(x => x !== '')
}

function str(v: Yaml | undefined, field: string, fallback = ''): string {
  if (v === undefined || v === null) return fallback
  if (typeof v !== 'string' && typeof v !== 'number') throw new Error(`${field} must be text`)
  return String(v).trim()
}

function bool(v: Yaml | undefined, field: string, fallback: boolean): boolean {
  if (v === undefined || v === null) return fallback
  if (typeof v !== 'boolean') throw new Error(`${field} must be true or false`)
  return v
}

function num(v: Yaml | undefined, field: string, fallback: number, min: number, max: number): number {
  if (v === undefined || v === null) return fallback
  if (typeof v !== 'number' || !Number.isFinite(v) || v < min || v > max) throw new Error(`${field} must be a number from ${min} to ${max}`)
  return v
}

const RULE_ID = /^[a-z0-9][a-z0-9._-]{0,63}$/

export function parseRule(v: Yaml, where: string, componentNames: ReadonlySet<string>): Rule {
  if (!isObj(v)) throw new Error(`${where} must be a mapping`)
  const id = str(v.id, `${where}.id`)
  if (!RULE_ID.test(id)) throw new Error(`${where}.id must be lowercase letters, digits, dots or dashes (got "${id}")`)
  if (id.startsWith('preset.')) throw new Error(`${where}.id: "preset." is kept for the modes' own rules`)
  const action = str(v.action, `${where}.action`)
  if (action !== 'answer' && action !== 'protect') throw new Error(`${where}.action must be answer or protect`)
  const kinds = strList(v.kinds, `${where}.kinds`)
  for (const k of kinds) if (!(KINDS as readonly string[]).includes(k)) throw new Error(`${where}.kinds: "${k}" is not a kind (${KINDS.join(', ')})`)
  if (action === 'answer' && kinds.some(isNeverAuto)) {
    throw new Error(`${where}: an answer rule cannot cover ${kinds.filter(isNeverAuto).join(', ')}: those are on the never-auto list`)
  }
  const components = strList(v.components, `${where}.components`)
  for (const c of components) if (!componentNames.has(c)) throw new Error(`${where}.components: "${c}" is not one of the policy's components`)
  const rule: Rule = { id, action }
  if (kinds.length > 0) rule.kinds = kinds as Kind[]
  const deputies = strList(v.deputies, `${where}.deputies`)
  if (deputies.length > 0) rule.deputies = deputies
  const repos = strList(v.repos, `${where}.repos`)
  if (repos.length > 0) rule.repos = repos
  if (components.length > 0) rule.components = components
  const mentions = strList(v.mentions, `${where}.mentions`).map(m => m.trim()).filter(m => m !== '')
  for (const m of mentions) if (m.length > 80) throw new Error(`${where}.mentions: "${m.slice(0, 20)}…" is longer than 80 characters`)
  if (mentions.length > 0) rule.mentions = mentions
  const guidance = str(v.guidance, `${where}.guidance`)
  if (guidance) rule.guidance = guidance
  const answer = str(v.answer, `${where}.answer`)
  if (answer) rule.answer = answer
  const says = str(v.says, `${where}.says`)
  if (says) rule.says = says
  if (action === 'answer' && !guidance && !answer) throw new Error(`${where}: an answer rule needs guidance or a fixed answer`)
  return rule
}

function parseComponent(v: Yaml, where: string): Component {
  if (!isObj(v)) throw new Error(`${where} must be a mapping`)
  const name = str(v.name, `${where}.name`)
  if (!/^[A-Za-z0-9][A-Za-z0-9 _.-]{0,63}$/.test(name)) throw new Error(`${where}.name must be a short name`)
  const paths = strList(v.paths, `${where}.paths`)
  if (paths.length === 0) throw new Error(`${where}.paths must list at least one path or glob`)
  return { name, repo: str(v.repo, `${where}.repo`), paths, says: str(v.says, `${where}.says`) }
}

export function validatePolicy(y: Yaml): Policy {
  if (!isObj(y)) throw new Error('the policy must be a mapping of settings')
  const version = y.version ?? 1
  if (version !== 1) throw new Error('version must be 1')
  // Cruise was called Train before 0.5.0; a policy saved then still loads
  // and is written back as cruise on its next save.
  const raw = str(y.mode, 'mode', 'shadow')
  const mode = raw === 'train' ? 'cruise' : raw
  if (!(MODES as readonly string[]).includes(mode)) throw new Error(`mode must be one of ${MODES.join(', ')}`)
  const servers = strList(y.servers, 'servers')
  if (servers.length === 0) throw new Error('servers must name at least one Marshal server (its /mcp name)')
  const watch = isObj(y.watch) ? y.watch : {}
  const notify = isObj(y.notify) ? y.notify : {}
  const lim = isObj(y.limits) ? y.limits : {}
  const components = (Array.isArray(y.components) ? y.components : y.components == null ? [] : (() => {
    throw new Error('components must be a list')
  })()).map((c, i) => parseComponent(c, `components[${i}]`))
  const names = new Set(components.map(c => c.name))
  if (names.size !== components.length) throw new Error('components: two components share a name')
  const rawRules = y.rules == null ? [] : Array.isArray(y.rules) ? y.rules : (() => {
    throw new Error('rules must be a list')
  })()
  const rules = rawRules.map((r, i) => parseRule(r, `rules[${i}]`, names))
  const ids = new Set(rules.map(r => r.id))
  if (ids.size !== rules.length) throw new Error('rules: two rules share an id')
  return {
    version: 1,
    mode: mode as Mode,
    enabled: bool(y.enabled, 'enabled', true),
    paused: bool(y.paused, 'paused', false),
    servers,
    watchDeputies: strList(watch.deputies, 'watch.deputies'),
    watchRepos: strList(watch.repos, 'watch.repos'),
    mergeBar: bool(y.merge_bar, 'merge_bar', false),
    model: str(y.model, 'model', DEFAULT_MODEL) || DEFAULT_MODEL,
    notifyDesktop: bool(notify.desktop, 'notify.desktop', true),
    rules,
    components,
    limits: {
      answersPerCycle: num(lim.answers_per_cycle, 'limits.answers_per_cycle', DEFAULT_LIMITS.answersPerCycle, 1, 20),
      notifyGroupOver: num(lim.notify_group_over, 'limits.notify_group_over', DEFAULT_LIMITS.notifyGroupOver, 1, 50),
      expiryMinutes: num(lim.expiry_minutes, 'limits.expiry_minutes', DEFAULT_LIMITS.expiryMinutes, 1, 1440),
      silenceMinutes: num(lim.silence_minutes, 'limits.silence_minutes', DEFAULT_LIMITS.silenceMinutes, 5, 1440),
      journalDays: num(lim.journal_days, 'limits.journal_days', DEFAULT_LIMITS.journalDays, 1, 365),
    },
  }
}

function ruleYaml(r: Rule): Obj {
  const o: Obj = { id: r.id, action: r.action }
  if (r.kinds?.length) o.kinds = [...r.kinds]
  if (r.deputies?.length) o.deputies = [...r.deputies]
  if (r.repos?.length) o.repos = [...r.repos]
  if (r.components?.length) o.components = [...r.components]
  if (r.mentions?.length) o.mentions = [...r.mentions]
  if (r.guidance) o.guidance = r.guidance
  if (r.answer) o.answer = r.answer
  if (r.says) o.says = r.says
  return o
}

export function policyYaml(p: Policy): string {
  const y: Obj = {
    version: 1,
    mode: p.mode,
    enabled: p.enabled,
    paused: p.paused,
    servers: [...p.servers],
    merge_bar: p.mergeBar,
    model: p.model,
    notify: { desktop: p.notifyDesktop },
    limits: {
      answers_per_cycle: p.limits.answersPerCycle,
      notify_group_over: p.limits.notifyGroupOver,
      expiry_minutes: p.limits.expiryMinutes,
      silence_minutes: p.limits.silenceMinutes,
      journal_days: p.limits.journalDays,
    },
  }
  if (p.watchDeputies.length || p.watchRepos.length) y.watch = { deputies: [...p.watchDeputies], repos: [...p.watchRepos] }
  y.components = p.components.map(c => {
    const o: Obj = { name: c.name, paths: [...c.paths] }
    if (c.repo) o.repo = c.repo
    if (c.says) o.says = c.says
    return o
  })
  y.rules = p.rules.map(ruleYaml)
  return stringifyYaml(
    y,
    'Marshal Autopilot policy. The marshal:autopilot skill writes it; you may edit it.\nAutopilot reads it again on its next check after a change. Comments are not kept.',
  )
}

function list(words: readonly string[]): string {
  if (words.length <= 1) return words.join('')
  return `${words.slice(0, -1).join(', ')} or ${words[words.length - 1]}`
}

// A rule in plain words, as the skill reads it back before saving.
export function ruleWords(r: Rule, components: readonly Component[] = []): string {
  const kinds = r.kinds?.length ? list(r.kinds.map(k => KIND_WORDS[k])) : 'any question'
  const scope: string[] = []
  if (r.deputies?.length) scope.push(`from deputy ${list(r.deputies)}`)
  if (r.repos?.length) scope.push(`in ${list(r.repos)}`)
  if (r.components?.length) {
    const named = r.components.map(n => {
      const c = components.find(x => x.name === n)
      return c ? `${n} (${c.repo ? `${c.repo}: ` : ''}${c.paths.join(', ')})` : n
    })
    scope.push(`when the run's work touches ${list(named)}`)
  }
  if (r.mentions?.length) scope.push(`when the question mentions ${list(r.mentions.map(m => `"${m}"`))}`)
  const where = scope.length ? ` ${scope.join(', ')}` : ''
  if (r.action === 'protect') return `${r.id}: questions about ${kinds}${where} always go to you; Autopilot never answers them.`
  const how = r.answer ? `answer "${r.answer}"` : r.guidance ?? ''
  return `${r.id}: Autopilot may answer questions about ${kinds}${where}: ${how}`
}

export function policyWords(p: Policy): string[] {
  return [
    `Mode ${p.mode}. ${p.enabled ? (p.paused ? 'Paused.' : 'On.') : 'Off (stopped).'}`,
    `Watches ${list(p.servers)}${p.watchDeputies.length ? `, deputies ${list(p.watchDeputies)}` : ''}${p.watchRepos.length ? `, repositories ${list(p.watchRepos)}` : ''}.`,
    `Merge bar ${p.mergeBar ? 'on: Cruise approves a merge only when required checks pass, reviews are given and no thread is open at the head' : 'off: merges always go to you'}.`,
    `Desktop notifications ${p.notifyDesktop ? 'on' : 'off'} (toasts and the strip always).`,
    `At most ${p.limits.answersPerCycle} answers per check; more than ${p.limits.notifyGroupOver} notices at once are grouped; questions under ${p.limits.expiryMinutes} minutes from expiry are escalated; a running run silent for ${p.limits.silenceMinutes} minutes is reported.`,
    ...p.components.map(c => `Component ${c.name}: ${c.repo ? `${c.repo} ` : ''}${c.paths.join(', ')}.`),
    ...p.rules.map(r => ruleWords(r, p.components)),
  ]
}

// The rules a mode applies: the person's own first (protect wins whatever
// the order), then the overlay's, then the mode's presets.
export function activeRules(p: Policy, overlay: Overlay | undefined): Rule[] {
  return [...p.rules, ...(overlay?.rules ?? []), ...presetRules(p.mode)]
}

export function newPolicy(server: string): Policy {
  return {
    version: 1,
    mode: 'shadow',
    enabled: true,
    paused: false,
    servers: server ? [server] : [],
    watchDeputies: [],
    watchRepos: [],
    mergeBar: false,
    model: DEFAULT_MODEL,
    notifyDesktop: true,
    rules: [],
    components: [],
    limits: { ...DEFAULT_LIMITS },
  }
}

// ── Files ────────────────────────────────────────────────────────────────────

export type Loaded = { policy: Policy; mtime: number } | { error: string; mtime: number; missing: boolean }

let cache: { path: string; mtime: number; loaded: Loaded } | undefined
let overlayCache: { mtime: number; key: string; overlay: Overlay | undefined; error: string } | undefined

export function resetPolicyCache(): void {
  cache = undefined
  overlayCache = undefined
}

export async function policyPath($: EngineInterface): Promise<string> {
  return `${await dataDir($)}/${POLICY_FILE}`
}

// The policy, read again only when the file's modification time changed.
export async function loadPolicy($: EngineInterface): Promise<Loaded> {
  const path = await policyPath($)
  const mtime = await mtimeOf($, path)
  if (mtime === undefined) {
    cache = undefined
    return { error: 'no policy yet. Ask Claude to set up Marshal Autopilot (the marshal:autopilot skill).', mtime: 0, missing: true }
  }
  if (cache && cache.path === path && cache.mtime === mtime) return cache.loaded
  const text = await readText($, path)
  let loaded: Loaded
  if (text === undefined || text.trim() === '') loaded = { error: 'the policy file is empty.', mtime, missing: true }
  else {
    try {
      loaded = { policy: validatePolicy(parseYaml(text)), mtime }
    } catch (err) {
      const why = err instanceof YamlError || err instanceof Error ? err.message : String(err)
      loaded = { error: `the policy is invalid: ${why}`, mtime, missing: false }
    }
  }
  cache = { path, mtime, loaded }
  return loaded
}

export async function savePolicy($: EngineInterface, p: Policy): Promise<void> {
  await writePrivate($, await policyPath($), policyYaml(p))
  cache = undefined
}

function parseDecision(v: Yaml, where: string): Decision {
  if (!isObj(v)) throw new Error(`${where} must be a mapping`)
  return {
    at: str(v.at, `${where}.at`),
    kind: str(v.kind, `${where}.kind`),
    repo: str(v.repo, `${where}.repo`),
    deputy: str(v.deputy, `${where}.deputy`),
    question: str(v.question, `${where}.question`),
    answer: str(v.answer, `${where}.answer`),
    source: 'skill',
  }
}

// The ids an overlay rule may not take: the policy's own rules' and every
// preset's. Two rules with one id would let the model name the wrong one.
export function reservedIds(p: Policy): Set<string> {
  return new Set([...p.rules.map(r => r.id), ...presetRules('cruise').map(r => r.id), ...presetRules('routine').map(r => r.id)])
}

export function checkOverlayIds(rules: readonly Rule[], reserved: ReadonlySet<string>): void {
  const seen = new Set<string>()
  rules.forEach((r, i) => {
    if (reserved.has(r.id)) throw new Error(`rules[${i}].id: "${r.id}" is already a rule of the policy (or a preset); give the train's rule its own id`)
    if (seen.has(r.id)) throw new Error('rules: two rules share an id')
    seen.add(r.id)
  })
}

export function validateOverlay(y: Yaml, components: ReadonlySet<string>, reserved: ReadonlySet<string> = new Set()): Overlay {
  if (!isObj(y)) throw new Error('the train overlay must be a mapping')
  const train = str(y.train, 'train')
  if (!train) throw new Error('train must name the train')
  const rules = (Array.isArray(y.rules) ? y.rules : []).map((r, i) => parseRule(r, `rules[${i}]`, components))
  checkOverlayIds(rules, reserved)
  const decisions = (Array.isArray(y.decisions) ? y.decisions : []).map((d, i) => parseDecision(d, `decisions[${i}]`))
  return { train, rules, decisions }
}

export function overlayYaml(o: Overlay): string {
  return stringifyYaml(
    {
      train: o.train,
      rules: o.rules.map(ruleYaml),
      decisions: o.decisions.map(d => ({ kind: d.kind, repo: d.repo, deputy: d.deputy, question: d.question, answer: d.answer, at: d.at })),
    },
    'Marshal Autopilot train overlay: decisions for one train, on top of policy.yaml.\nRemove it (the skill: end the train) when the train ends.',
  )
}

// The overlay against the policy it sits on (its components, and the ids
// its rules may not take).
export async function loadOverlay($: EngineInterface, policy: Policy): Promise<{ overlay: Overlay | undefined; error: string }> {
  const path = `${await dataDir($)}/${OVERLAY_FILE}`
  const mtime = await mtimeOf($, path)
  if (mtime === undefined) {
    overlayCache = undefined
    return { overlay: undefined, error: '' }
  }
  const components = new Set(policy.components.map(c => c.name))
  const reserved = reservedIds(policy)
  const key = JSON.stringify([[...components].sort(), [...reserved].sort()])
  if (overlayCache && overlayCache.mtime === mtime && overlayCache.key === key) return overlayCache
  const text = (await readText($, path)) ?? ''
  let out: { overlay: Overlay | undefined; error: string }
  if (text.trim() === '') out = { overlay: undefined, error: '' }
  else {
    try {
      out = { overlay: validateOverlay(parseYaml(text), components, reserved), error: '' }
    } catch (err) {
      out = { overlay: undefined, error: `the train overlay is invalid: ${err instanceof Error ? err.message : String(err)}` }
    }
  }
  overlayCache = { mtime, key, ...out }
  return out
}

export async function saveOverlay($: EngineInterface, o: Overlay): Promise<void> {
  await writePrivate($, `${await dataDir($)}/${OVERLAY_FILE}`, overlayYaml(o))
  overlayCache = undefined
}

export async function removeOverlay($: EngineInterface): Promise<void> {
  const dir = await dataDir($)
  await removeFile($, `${dir}/${OVERLAY_FILE}`)
  await removeFile($, `${dir}/${DECISIONS_FILE}`)
  overlayCache = undefined
}

// The person's own answers during the train, read again before every answer.
export async function readDecisions($: EngineInterface, train: string): Promise<Decision[]> {
  const text = (await readText($, `${await dataDir($)}/${DECISIONS_FILE}`)) ?? ''
  const out: Decision[] = []
  for (const line of text.split('\n')) {
    if (!line.trim()) continue
    try {
      const d = JSON.parse(line) as Partial<Decision> & { train?: string }
      if (d.train !== train) continue
      out.push({
        at: String(d.at ?? ''),
        kind: String(d.kind ?? ''),
        repo: String(d.repo ?? ''),
        deputy: String(d.deputy ?? ''),
        question: String(d.question ?? '').slice(0, 500),
        answer: String(d.answer ?? '').slice(0, 500),
        source: 'person',
      })
    } catch {
      // A torn line is skipped.
    }
  }
  return out
}

export async function appendDecision($: EngineInterface, train: string, d: Decision): Promise<void> {
  await appendPrivate($, `${await dataDir($)}/${DECISIONS_FILE}`, JSON.stringify({ train, ...d, question: d.question.slice(0, 500), answer: d.answer.slice(0, 500) }))
}
