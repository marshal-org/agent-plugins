// What each Autopilot mode answers: the Modes table of the spec as rule
// bundles, in the same schema as the person's own rules, so one evaluator
// covers both. Pure data and functions; no engine calls.

export const MODES = ['shadow', 'routine', 'cruise'] as const
export type Mode = (typeof MODES)[number]

// The kinds of question the model recognises from an ask's wording.
export const ANSWER_KINDS = ['pick_approach', 'proceed', 'rerun_check', 'resume', 'approve_plan', 'approve_merge'] as const
// The fixed never-auto list: no rule, mode or decision answers these.
export const NEVER_AUTO = ['takeover', 'access', 'deploy', 'release', 'delete'] as const
export const KINDS = [...ANSWER_KINDS, ...NEVER_AUTO, 'other'] as const
export type Kind = (typeof KINDS)[number]

export const KIND_WORDS: Record<Kind, string> = {
  pick_approach: 'picking a flow or approach the run recommends',
  proceed: "going ahead with the run's recommendation",
  rerun_check: 're-running a failed check that its log shows is a flake',
  resume: 'resuming or continuing paused work',
  approve_plan: 'approving a brief, plan or spec',
  approve_merge: 'approving a merge',
  takeover: 'a person taking over a run or its workspace',
  access: 'granting access, permissions or credentials',
  deploy: 'deploying to staging or production',
  release: 'cutting, publishing or promoting a release',
  delete: 'deleting or destroying anything',
  other: 'anything else',
}

export const NEVER_AUTO_WORDS = NEVER_AUTO.map(k => KIND_WORDS[k])

export type Rule = {
  id: string
  // answer: Autopilot may answer what matches; protect: always the person.
  action: 'answer' | 'protect'
  // Empty or absent: any kind.
  kinds?: Kind[]
  deputies?: string[]
  repos?: string[]
  // Names of the policy's components.
  components?: string[]
  // Words the question must mention (any one, case-insensitive), in the
  // run's title, question, context or choices.
  mentions?: string[]
  // How to answer (answer rules), in the person's words.
  guidance?: string
  // A fixed answer: one of the ask's choices, matched exactly.
  answer?: string
  // The person's own words for the rule, kept as said.
  says?: string
}

const PRESET: Record<string, Rule> = {
  pick_approach: {
    id: 'preset.pick-approach',
    action: 'answer',
    kinds: ['pick_approach'],
    guidance: "Pick the option the run recommends, unless it contradicts one of the person's decisions.",
  },
  proceed: {
    id: 'preset.proceed',
    action: 'answer',
    kinds: ['proceed'],
    guidance: "Go ahead with the run's recommendation, unless it contradicts one of the person's decisions.",
  },
  rerun_check: {
    id: 'preset.rerun-flake',
    action: 'answer',
    kinds: ['rerun_check'],
    guidance: 'Re-run the failed check once, only when its log shows a flake (network, timeout, runner), never for a real test failure.',
  },
  resume: {
    id: 'preset.resume',
    action: 'answer',
    kinds: ['resume'],
    guidance: 'Resume or continue the paused work. Autopilot checks the server has room first.',
  },
  approve_plan: {
    id: 'preset.approve-plan',
    action: 'answer',
    kinds: ['approve_plan'],
    guidance:
      "Approve a brief, plan or spec when it does what the run was asked to do and stays within the person's rules and decisions. Notify when it adds scope or risk the person has not decided, or touches anything on the never-auto list.",
  },
  approve_merge: {
    id: 'preset.approve-merge',
    action: 'answer',
    kinds: ['approve_merge'],
    guidance:
      "Approve the run's request to merge its pull request. Do not hold back for lack of check or review results: Autopilot's code checks the repository's required checks, reviews and open threads at the head before it sends the answer, and the run merges.",
  },
}

const ROUTINE = ['pick_approach', 'proceed', 'rerun_check', 'resume']
const CRUISE = [...ROUTINE, 'approve_plan', 'approve_merge']

// The preset rules a mode applies. Shadow shows what Cruise would answer.
export function presetRules(mode: Mode): Rule[] {
  const keys = mode === 'routine' ? ROUTINE : CRUISE
  return keys.map(k => PRESET[k]!)
}

// What each mode answers, in plain words, for the skill and explain.
export function modeWords(mode: Mode): string {
  switch (mode) {
    case 'shadow':
      return 'Shadow: answers nothing. For every question it shows what it would answer and under which rule, so you can check the rules first.'
    case 'routine':
      return 'Routine: answers flow and approach picks the run recommends, going ahead with a recommendation, one re-run of a check that failed on a flake, and resuming paused work when the server has room. Plans, specs and merges go to you.'
    case 'cruise':
      return "Cruise: everything Routine answers, plus approving a brief, plan or spec within your guidance, and approving a merge when the merge bar is on and the pull request meets the repository's own checks, reviews and has no open threads."
  }
}

export function isNeverAuto(kind: string): boolean {
  return (NEVER_AUTO as readonly string[]).includes(kind)
}
