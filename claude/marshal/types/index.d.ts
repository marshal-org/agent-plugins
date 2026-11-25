export type FleetAsk = {
  askId: string
  runId: string
  rung: string
  deputy: string
  question: string
  // The offered choices as shown (whitespace collapsed).
  choices: string[]
  // The same choices exactly as the server offers them, index for index:
  // what an answer sends.
  choiceTexts?: string[]
  // The title of the run that asks, so the person knows where the question
  // comes from; empty until found.
  runTitle: string
  // RFC3339; empty when the ask does not expire or the server did not say.
  expiresAt?: string
}

// A deputy launch waiting for a concurrency limit. Not a run yet: no run id.
export type FleetQueued = {
  id: string
  title: string
  deputy: string
  // 1 is next; 0 when the server did not say.
  position: number
  // Why it waits, as the server words it.
  reason: string
  createdAt: string
}

// A pull request a run opened, pushed to, merged or closed.
export type FleetPr = {
  // owner/repo; empty until the platform resolved it.
  repo: string
  number: number
  url: string
  // open, merged or closed; from GitHub once synced, else from what the run did.
  state: string
}

export type FleetRun = {
  id: string
  title: string
  deputy: string
  state: string
  stopReason: string
  createdAt: string
  completedAt: string
  // Its pull requests, when the server has runs_prs; absent before the read.
  prs?: FleetPr[]
  // Its estimated cost so far in USD (runs_list cost_usd); absent when the
  // server does not say.
  costUsd?: number
}

export type FleetCell = {
  // The MCP server's name, as /mcp lists it.
  server: string
  isProd: boolean
  // The web app's base URL, for links; empty when unknown.
  webUrl: string
  asks: FleetAsk[]
  // True when the server lists only the runs this space launched (a space's
  // marshal-orchestration has no runs_attention): no asks, no attention.
  launchedOnly?: boolean
  // Parked runs, and runs that failed or timed out in the window.
  attention: FleetRun[]
  // Runs still going: pending, running, awaiting_human, engaged.
  active: FleetRun[]
  // Launches waiting for a concurrency limit, newest first.
  queued: FleetQueued[]
  // The newest runs that ended well (succeeded) or were canceled.
  recent: FleetRun[]
  // A short reason when this cell could not be read this time.
  error: string
}

export type Fleet = {
  cells: FleetCell[]
  // Milliseconds since the epoch of the last poll; 0 before the first.
  polledAt: number
}

// One row of an inspector tab, already formatted for drawing.
export type InspectorLine = {
  text: string
  tone: '' | 'dim' | 'error' | 'warning' | 'success'
  // A web link for the row, when it has one.
  href: string
  // A label drawn in its own dim column before the text (overview facts).
  key?: string
  // A share from 0 to 1, drawn as a bar (cost by source).
  bar?: number
}

export type InspectorTab = {
  lines: InspectorLine[]
  // A short reason when this tab could not be read.
  error: string
  // Milliseconds since the epoch of the last read; 0 before the first.
  readAt: number
}

export type Inspector = {
  // The space the session runs in; empty until found.
  spaceId: string
  // Why the inspector cannot work here, when it cannot (no Marshal server,
  // the server refuses the space's own tools).
  problem: string
  tabs: Record<string, InspectorTab>
}

// The ask being answered with free text, if any.
export type Answering = { server: string; askId: string } | null


// ── Autopilot ────────────────────────────────────────────────────────────────

// What Autopilot decided about one ask, as the strip and explain show it.
export type AutopilotOutcome = 'answered' | 'would_answer' | 'notified' | 'answered_elsewhere' | 'refused' | 'escalated' | 'nudged' | 'waiting' | 'cared'

export type AutopilotEntry = {
  askId: string
  runId: string
  server: string
  // The run's title or the deputy, for the row.
  runLabel: string
  question: string
  outcome: AutopilotOutcome
  // The answer sent, or the one it would send (Shadow).
  answer: string
  ruleId: string
  // The rule in plain words, for explain.
  rule: string
  reasoning: string
  // Why it went to the person, when it did (no rule, protect, ...).
  reason: string
  gate: string
  mode: string
  // Milliseconds since the epoch.
  at: number
  // The ask as asked, for explain: question and choices.
  asked: string
  // Minutes left before the ask expires when it was escalated; 0 otherwise.
  expiresInMin: number
}

// The strip's state: on (any mode), paused, or off (stopped, no policy, an
// invalid policy). The mode is never drawn in the strip.
export type AutopilotView = {
  state: 'on' | 'paused' | 'off'
  // Why it is off, when it is.
  reason: string
  // The mode, for explain only.
  mode: string
  // Latest answers and would-answers, newest first.
  recent: AutopilotEntry[]
  // Asks Autopilot handed to the person that are still open.
  waiting: AutopilotEntry[]
  // When the policy file last changed (ms since the epoch); 0 when unknown.
  policyChangedAt: number
}

// Which strip entry is selected, and whether its explanation is open.
export type AutopilotUi = { selected: string; explaining: boolean }

declare module 'claude-code' {
  interface PluginState {
    marshal: {
      fleet: Shaped<Fleet>
      answering: Answering
      inspector: Shaped<Inspector>
      tab: string
      autopilot: Shaped<AutopilotView>
      autopilotUi: AutopilotUi
    }
  }
}
