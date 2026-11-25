import type { EngineInterface } from 'claude-code'

import { dataDir } from './autopilot-files'
import { journal, loadJournal, recentEntries, type JournalEntry } from './autopilot-journal'
import {
  DEFAULT_LIMITS,
  checkOverlayIds,
  loadOverlay,
  reservedIds,
  loadPolicy,
  newPolicy,
  parseRule,
  policyWords,
  readDecisions,
  removeOverlay,
  ruleWords,
  saveOverlay,
  savePolicy,
  validatePolicy,
  type Component,
  type Overlay,
  type Policy,
} from './autopilot-policy'
import { MODES, NEVER_AUTO_WORDS, modeWords, type Mode } from './autopilot-presets'
import type { Yaml } from './autopilot-yaml'

// The tools the marshal:autopilot skill calls. They are the only writers of
// the policy besides the strip's keys, and every change is read back in
// plain words: a call with confirm false shows what would be saved and saves
// nothing; the same call with confirm true saves it.

export const TOOL_NAMES = ['autopilot_status', 'autopilot_setup', 'autopilot_rules', 'autopilot_control', 'autopilot_train', 'autopilot_journal'] as const

const obj = { type: 'object' } as const
const strArr = { type: 'array', items: { type: 'string' } } as const

export const TOOL_SPECS = [
  {
    name: 'autopilot_status',
    description:
      'Marshal Autopilot: its state (on, paused or off), mode, the policy in plain words, the train overlay, the latest decisions, the connected Marshal server, and whether every run it watched has ended (then offer the improve-deputy review).',
    inputSchema: { ...obj, properties: {} },
  },
  {
    name: 'autopilot_setup',
    description:
      'Marshal Autopilot setup: write the policy from the setup brief answers. confirm false returns the policy in plain words and saves nothing; show it to the person, then call again with confirm true. Keeps existing rules and components.',
    inputSchema: {
      ...obj,
      properties: {
        mode: { type: 'string', enum: [...MODES], description: 'shadow (recommended to start), routine or cruise' },
        servers: { ...strArr, description: 'Marshal MCP server names to watch, as /mcp lists them; empty: the one the fleet pane reads' },
        watch_deputies: { ...strArr, description: 'only these deputies (slugs); empty: all' },
        watch_repos: { ...strArr, description: 'only these repositories (owner/repo); empty: all' },
        merge_bar: { type: 'boolean', description: "Cruise approves merges (the run merges); off: merges go to the person" },
        merge_bar_words: { type: 'string', description: "the person's own merge bar in their words, e.g. 'at least two AI agents reviewed the PR'; Autopilot verifies it on the head before approving a merge. The repo's required checks and no open threads stay a floor. Empty: the repo's bar only" },
        notify_desktop: { type: 'boolean' },
        reach: {
          type: 'array',
          items: { ...obj, properties: { server: { type: 'string' }, tool: { type: 'string' }, args: { ...obj }, says: { type: 'string' } } },
          description: "other ways to reach the person, through tools this session has: [{ server, tool, args with {text} where the notice goes, says: the person's words }], e.g. a Slack MCP's send-message tool to their DM. Empty list: only this session (toasts, strip, desktop)",
        },
        care: { ...obj, properties: { extend_timeouts: { type: 'boolean' }, relaunch: { type: 'boolean' } }, description: 'taking care of runs; each on by default' },
        model: { type: 'string', description: 'model alias for decisions; default sonnet' },
        limits: { ...obj, properties: { answers_per_cycle: { type: 'number' }, expiry_minutes: { type: 'number' }, silence_minutes: { type: 'number' }, notify_group_over: { type: 'number' }, journal_days: { type: 'number' } } },
        confirm: { type: 'boolean' },
      },
      required: ['confirm'],
    },
  },
  {
    name: 'autopilot_rules',
    description:
      "Marshal Autopilot rules and components. op list | add | remove | add_component | remove_component. add takes a structured rule (id, action answer|protect, kinds, deputies, repos, components, mentions: words the question must mention, guidance or answer, says: the person's own words). confirm false returns the rule read back in plain words and saves nothing.",
    inputSchema: {
      ...obj,
      properties: {
        op: { type: 'string', enum: ['list', 'add', 'remove', 'add_component', 'remove_component'] },
        rule: { ...obj, description: '{ id, action, kinds?, deputies?, repos?, components?, mentions?, guidance?, answer?, says? }' },
        component: { ...obj, description: '{ name, repo?, paths: [globs], says? }' },
        id: { type: 'string', description: 'rule id or component name to remove' },
        confirm: { type: 'boolean' },
      },
      required: ['op'],
    },
  },
  {
    name: 'autopilot_control',
    description: 'Marshal Autopilot: pause, resume, stop (off until started), start, or set the mode (shadow, routine, cruise).',
    inputSchema: { ...obj, properties: { action: { type: 'string', enum: ['pause', 'resume', 'stop', 'start', 'mode'] }, mode: { type: 'string', enum: [...MODES] } }, required: ['action'] },
  },
  {
    name: 'autopilot_train',
    description:
      'Marshal Autopilot train overlay: decisions and rules for one train on top of the policy. op show | start (name, rules?, decisions?) | add (rules?, decisions?) | end (removes the overlay and the train decisions). confirm false reads back without saving.',
    inputSchema: {
      ...obj,
      properties: {
        op: { type: 'string', enum: ['show', 'start', 'add', 'end'] },
        train: { type: 'string' },
        rules: { type: 'array', items: obj },
        decisions: { type: 'array', items: { ...obj, description: '{ kind, repo?, deputy?, question?, answer }' } },
        confirm: { type: 'boolean' },
      },
      required: ['op'],
    },
  },
  {
    name: 'autopilot_journal',
    description:
      "Marshal Autopilot journal: what it decided, newest first, with the rule, the reasoning and the question as asked. Filter by ask_id (explain one), run_id, or train (the overlay's runs).",
    inputSchema: { ...obj, properties: { ask_id: { type: 'string' }, run_id: { type: 'string' }, limit: { type: 'number' } } },
  },
] as const

type Args = Record<string, unknown>

function toYaml(v: unknown): Yaml {
  if (v === null || v === undefined) return null
  if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') return v
  if (Array.isArray(v)) return v.map(toYaml)
  if (typeof v === 'object') return Object.fromEntries(Object.entries(v as Args).map(([k, x]) => [k, toYaml(x)]))
  return String(v)
}

function strings(v: unknown): string[] | undefined {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string' && x.trim() !== '').map(x => x.trim()) : undefined
}

async function current($: EngineInterface): Promise<{ policy?: Policy; error?: string; path: string }> {
  const loaded = await loadPolicy($)
  const path = `${await dataDir($)}/policy.yaml`
  return 'error' in loaded ? (loaded.missing ? { path } : { error: loaded.error, path }) : { policy: loaded.policy, path }
}

function explainEntry(e: JournalEntry) {
  return {
    ask_id: e.ask_id,
    run_id: e.run_id,
    run: e.run_label,
    server: e.server,
    at: e.t,
    outcome: e.outcome,
    answer: e.answer,
    rule_id: e.rule_id,
    rule: e.rule,
    reasoning: e.reasoning,
    why_you: e.reason,
    kind: e.gate,
    mode: e.mode,
    asked: e.ask,
    ...(e.check && { check: e.check, pr: e.pr }),
    platform_accepted: e.accepted,
    via_stored: e.via_stored,
  }
}

export type ToolEnv = { server: string; activeRunIds: () => Promise<{ watched: Set<string>; active: Set<string>; deputies: Map<string, string> }> }

export async function runTool($: EngineInterface, name: string, args: Args, env: ToolEnv): Promise<unknown> {
  const cur = await current($)
  switch (name) {
    case 'autopilot_status': {
      const now = await $.clock.now()
      await loadJournal($, now, cur.policy?.limits.journalDays ?? DEFAULT_LIMITS.journalDays)
      const { overlay } = cur.policy ? await loadOverlay($, cur.policy) : { overlay: undefined }
      const runs = await env.activeRunIds()
      const watchedRuns = new Set(recentEntries(500).map(e => e.run_id).filter(Boolean))
      const stillActive = [...watchedRuns].filter(id => runs.active.has(id))
      const deputies = [...new Set([...watchedRuns].map(id => runs.deputies.get(id) ?? '').filter(Boolean))]
      return {
        state: !cur.policy ? 'off' : !cur.policy.enabled ? 'off' : cur.policy.paused ? 'paused' : 'on',
        mode: cur.policy?.mode ?? '',
        mode_words: cur.policy ? modeWords(cur.policy.mode) : '',
        policy_file: cur.path,
        policy: cur.policy ? policyWords(cur.policy) : [],
        problem: cur.error ?? (cur.policy ? '' : 'No policy yet: run setup.'),
        modes: MODES.map(m => modeWords(m)),
        never_auto: NEVER_AUTO_WORDS,
        server_connected: env.server,
        train: overlay ? { name: overlay.train, rules: overlay.rules.map(r => ruleWords(r, cur.policy?.components ?? [])), decisions: overlay.decisions.length + (await readDecisions($, overlay.train)).length } : null,
        latest: recentEntries(10).map(explainEntry),
        checks: journal.checks.slice(-10).map(explainEntry),
        watched_runs: watchedRuns.size,
        all_watched_runs_ended: watchedRuns.size > 0 && stillActive.length === 0,
        deputies_of_watched_runs: deputies,
      }
    }
    case 'autopilot_setup': {
      const base = cur.policy ?? newPolicy(env.server)
      // A mode left out keeps the one in force (Shadow for a new policy): a
      // setup call changes only what it was given.
      const mode = typeof args.mode === 'string' && args.mode ? args.mode : base.mode
      const lim = (args.limits && typeof args.limits === 'object' ? args.limits : {}) as Args
      const raw = {
        version: 1,
        mode,
        enabled: true,
        paused: false,
        servers: strings(args.servers)?.length ? strings(args.servers) : base.servers.length ? base.servers : [env.server].filter(Boolean),
        watch: { deputies: strings(args.watch_deputies) ?? base.watchDeputies, repos: strings(args.watch_repos) ?? base.watchRepos },
        merge_bar: typeof args.merge_bar === 'boolean' ? args.merge_bar : base.mergeBar,
        merge_bar_words: typeof args.merge_bar_words === 'string' ? args.merge_bar_words : base.mergeBarWords,
        reach: Array.isArray(args.reach) ? args.reach : reachRaw(base),
        care: { ...careRaw(base), ...(args.care && typeof args.care === 'object' ? (args.care as Args) : {}) },
        model: typeof args.model === 'string' && args.model ? args.model : base.model,
        notify: { desktop: typeof args.notify_desktop === 'boolean' ? args.notify_desktop : base.notifyDesktop },
        limits: {
          answers_per_cycle: lim.answers_per_cycle ?? base.limits.answersPerCycle,
          notify_group_over: lim.notify_group_over ?? base.limits.notifyGroupOver,
          expiry_minutes: lim.expiry_minutes ?? base.limits.expiryMinutes,
          silence_minutes: lim.silence_minutes ?? base.limits.silenceMinutes,
          journal_days: lim.journal_days ?? base.limits.journalDays,
        },
        components: base.components.map(c => ({ name: c.name, repo: c.repo, paths: c.paths, says: c.says })),
        rules: base.rules.map(r => ({ ...r })),
      }
      let p: Policy
      try {
        p = validatePolicy(toYaml(raw))
      } catch (err) {
        return { saved: false, error: err instanceof Error ? err.message : String(err) }
      }
      if (args.confirm === true) await savePolicy($, p)
      return { saved: args.confirm === true, policy_file: cur.path, read_back: policyWords(p), mode: modeWords(p.mode), never_auto: NEVER_AUTO_WORDS }
    }
    case 'autopilot_rules': {
      if (!cur.policy) return { saved: false, error: cur.error ?? 'No policy yet: run setup first.' }
      const p = cur.policy
      const names = new Set(p.components.map(c => c.name))
      const op = String(args.op ?? 'list')
      if (op === 'list') return { rules: p.rules.map(r => ruleWords(r, p.components)), components: p.components }
      let next: Policy
      let words: string
      try {
        if (op === 'add') {
          const rule = parseRule(toYaml(args.rule), 'rule', names)
          next = { ...p, rules: [...p.rules.filter(r => r.id !== rule.id), rule] }
          words = ruleWords(rule, p.components)
        } else if (op === 'remove') {
          const id = String(args.id ?? '')
          const r = p.rules.find(x => x.id === id)
          if (!r) return { saved: false, error: `no rule "${id}"` }
          next = { ...p, rules: p.rules.filter(x => x.id !== id) }
          words = `Remove: ${ruleWords(r, p.components)}`
        } else if (op === 'add_component') {
          const v = validatePolicy(toYaml({ ...rawOf(p), components: [...p.components, args.component] }))
          next = v
          const c = v.components[v.components.length - 1] as Component
          words = `Component ${c.name}: ${c.repo ? `${c.repo} ` : ''}${c.paths.join(', ')}`
        } else if (op === 'remove_component') {
          const id = String(args.id ?? '')
          if (p.rules.some(r => r.components?.includes(id))) return { saved: false, error: `rules still use component "${id}": remove them first` }
          next = { ...p, components: p.components.filter(c => c.name !== id) }
          words = `Remove component ${id}`
        } else return { saved: false, error: `unknown op "${op}"` }
      } catch (err) {
        return { saved: false, error: err instanceof Error ? err.message : String(err) }
      }
      if (args.confirm === true) await savePolicy($, next)
      return { saved: args.confirm === true, read_back: words, ...(args.confirm !== true && { next_step: 'Show the read_back to the person in plain words; on their yes, call again with confirm true.' }) }
    }
    case 'autopilot_control': {
      if (!cur.policy) return { done: false, error: cur.error ?? 'No policy yet: run setup first.' }
      const action = String(args.action ?? '')
      const p = cur.policy
      let next: Policy
      if (action === 'pause') next = { ...p, paused: true }
      else if (action === 'resume') next = { ...p, paused: false }
      else if (action === 'stop') next = { ...p, enabled: false, paused: false }
      else if (action === 'start') next = { ...p, enabled: true, paused: false }
      else if (action === 'mode' && typeof args.mode === 'string' && (MODES as readonly string[]).includes(args.mode)) next = { ...p, mode: args.mode as Mode }
      else return { done: false, error: 'action must be pause, resume, stop, start, or mode with a mode' }
      await savePolicy($, next)
      return { done: true, state: !next.enabled ? 'off' : next.paused ? 'paused' : 'on', mode: next.mode, mode_words: modeWords(next.mode) }
    }
    case 'autopilot_train': {
      if (!cur.policy) return { saved: false, error: cur.error ?? 'No policy yet: run setup first.' }
      const names = new Set(cur.policy.components.map(c => c.name))
      const { overlay, error } = await loadOverlay($, cur.policy)
      const op = String(args.op ?? 'show')
      const words = (o: Overlay) => [
        `Train ${o.train}.`,
        ...o.rules.map(r => ruleWords(r, cur.policy?.components ?? [])),
        ...o.decisions.map(d => `Decision: ${d.kind || 'any question'}${d.repo ? ` in ${d.repo}` : ''}: answer "${d.answer}"`),
      ]
      if (op === 'show') return overlay ? { train: overlay.train, read_back: words(overlay), person_decisions: await readDecisions($, overlay.train) } : { train: null, problem: error }
      if (op === 'end') {
        if (args.confirm !== true) return { saved: false, read_back: overlay ? [`End train ${overlay.train}: remove its overlay and its decisions; only the standing policy applies.`] : ['No train overlay.'] }
        await removeOverlay($)
        return { saved: true, read_back: ['The train overlay is removed: only the standing policy applies.'] }
      }
      const base: Overlay = op === 'start' ? { train: String(args.train ?? '').trim(), rules: [], decisions: [] } : overlay ?? { train: '', rules: [], decisions: [] }
      if (!base.train) return { saved: false, error: op === 'start' ? 'start needs train: a name for the train' : 'no train overlay: start one first' }
      let next: Overlay
      try {
        const rules = (Array.isArray(args.rules) ? args.rules : []).map((r, i) => parseRule(toYaml(r), `rules[${i}]`, names))
        checkOverlayIds(rules, reservedIds(cur.policy))
        const decisions = (Array.isArray(args.decisions) ? args.decisions : []).map(d => {
          const x = (d && typeof d === 'object' ? d : {}) as Args
          return { at: new Date(0).toISOString(), kind: String(x.kind ?? ''), repo: String(x.repo ?? ''), deputy: String(x.deputy ?? ''), question: String(x.question ?? ''), answer: String(x.answer ?? ''), source: 'skill' as const }
        })
        next = { train: base.train, rules: [...base.rules.filter(r => !rules.some(n => n.id === r.id)), ...rules], decisions: [...base.decisions, ...decisions] }
      } catch (err) {
        return { saved: false, error: err instanceof Error ? err.message : String(err) }
      }
      if (args.confirm === true) await saveOverlay($, next)
      return { saved: args.confirm === true, read_back: words(next) }
    }
    case 'autopilot_journal': {
      const now = await $.clock.now()
      await loadJournal($, now, cur.policy?.limits.journalDays ?? DEFAULT_LIMITS.journalDays)
      const limit = typeof args.limit === 'number' ? Math.min(200, Math.max(1, args.limit)) : 20
      let rows = [...recentEntries(1000), ...journal.checks].sort((a, b) => b.at - a.at)
      if (typeof args.ask_id === 'string' && args.ask_id) rows = rows.filter(e => e.ask_id === args.ask_id || e.ask_id.startsWith(String(args.ask_id)))
      if (typeof args.run_id === 'string' && args.run_id) rows = rows.filter(e => e.run_id === args.run_id || e.run_id.startsWith(String(args.run_id)))
      return { entries: rows.slice(0, limit).map(explainEntry) }
    }
  }
  return { error: `unknown tool ${name}` }
}

function rawOf(p: Policy): Args {
  return {
    version: 1,
    mode: p.mode,
    enabled: p.enabled,
    paused: p.paused,
    servers: p.servers,
    watch: { deputies: p.watchDeputies, repos: p.watchRepos },
    merge_bar: p.mergeBar,
    merge_bar_words: p.mergeBarWords,
    reach: reachRaw(p),
    care: careRaw(p),
    model: p.model,
    notify: { desktop: p.notifyDesktop },
    limits: {
      answers_per_cycle: p.limits.answersPerCycle,
      notify_group_over: p.limits.notifyGroupOver,
      expiry_minutes: p.limits.expiryMinutes,
      silence_minutes: p.limits.silenceMinutes,
      journal_days: p.limits.journalDays,
    },
    components: p.components.map(c => ({ name: c.name, repo: c.repo, paths: c.paths, says: c.says })),
    rules: p.rules.map(r => ({ ...r })),
  }
}

function reachRaw(p: Policy): Args[] {
  return p.reach.map(r => ({ server: r.server, tool: r.tool, args: { ...r.args }, ...(r.says && { says: r.says }) }))
}

function careRaw(p: Policy): Args {
  return { extend_timeouts: p.care.extendTimeouts, relaunch: p.care.relaunch }
}
