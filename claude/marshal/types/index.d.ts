export type FleetAsk = {
  askId: string
  runId: string
  rung: string
  deputy: string
  question: string
  choices: string[]
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

declare module 'claude-code' {
  interface PluginState {
    marshal: {
      fleet: Shaped<Fleet>
      answering: Answering
      inspector: Shaped<Inspector>
      tab: string
    }
  }
}
