import type { EngineInterface } from 'claude-code'

import { marshalServers, OWN_SERVER, pickServer, readConfig, toolsOf, type Config } from './config'
import { serverUrl, webBase } from './fleet-model'
import { pollFleet, type Cell } from './fleet-poll'
import { pollInspector } from './space-poll'

// Module state: rebuilt on every load, which is right (a reload drops the
// timers too). What the panes draw lives in $.state.
export const mod = {
  config: readConfig({}) as Config,
  cell: undefined as Cell | undefined,
  problem: '',
  inSpace: false,
  // Inside a space the fleet is read only after /marshal-fleet opened it.
  fleetOpened: false,
  isPolling: false,
  // A poll asked for while one runs (a tab change, an answer): run once more
  // after it, so the new tab is read instead of staying on "Reading...".
  pollAgain: false,
  cwd: '',
  // Whether Claude Code draws links in this terminal (links.ts).
  links: true,
}

// inbox_answer's description names the optional via note ("via: a short
// note stored with the answer"). "via" alone is not enough: a description
// may say an ask was answered via Slack.
export const VIA_LISTED = /\bvia\b.{0,80}\bnote\b|\bnote\b.{0,80}\bvia\b/i

export async function findCell($: EngineInterface): Promise<Cell | undefined> {
  const listed = await $.tool.list()
  const names = listed.map(t => t.name)
  // Inside a space the plugin's own server (the default url, Marshal cloud) is
  // never the one to read: the space's own Marshal server is.
  const found = marshalServers(names).filter(s => !mod.inSpace || s !== OWN_SERVER)
  const server = pickServer(mod.config, found)
  if (!server) {
    mod.problem = mod.config.server
      ? `The Marshal server "${mod.config.server}" is not connected. Check /mcp.`
      : mod.config.url
        ? `Marshal is not signed in yet. Run /mcp, pick plugin:marshal:marshal and sign in (${mod.config.url}).`
        : 'Marshal is not connected yet. Copy the install command from Connect an agent in your Marshal web app and run it, then sign in with /mcp. Or set the address with /plugin configure marshal.'
    return undefined
  }
  mod.problem = ''
  // Links go to the web app of the server the panes read. The url setting is
  // that address when the panes read the plugin's own server; any other
  // server's address is in Claude Code's MCP config.
  let webUrl = !mod.inSpace && server === OWN_SERVER ? webBase(mod.config.url) : ''
  if (!webUrl) {
    try {
      const home = await $.env.get('HOME')
      if (home) webUrl = webBase(serverUrl(JSON.parse(await $.fs.read(`${home}/.claude.json`)), server, mod.cwd))
    } catch {
      // Links are a convenience; the board works without them.
    }
  }
  // A server that config does not name (the desktop app's connectors are
  // named by a UUID): the url setting is the person's own Marshal, so links
  // go there. The placeholder default is never used (readConfig drops it).
  if (!webUrl && !mod.inSpace) webUrl = webBase(mod.config.url)
  const tools = toolsOf(server, names)
  // A server that stores Autopilot's via note says so in inbox_answer's
  // description: the listing carries no input schema for an MCP tool.
  const answerTool = listed.find(t => t.name === `mcp__${server}__inbox_answer`)
  return {
    server,
    webUrl,
    hasPrs: tools.has('runs_prs'),
    hasAttention: tools.has('runs_attention'),
    hasQueue: tools.has('runs_cancel_queued'),
    hasSpaceReads: tools.has('spaces_usage') && tools.has('spaces_changes'),
    hasVia: answerTool !== undefined && VIA_LISTED.test(answerTool.description),
    hasInboxGet: tools.has('inbox_get'),
    hasDeputyQueue: tools.has('deputies_queue'),
    hasMessage: tools.has('runs_message'),
    // A space whose orchestration turns on answer_children: its children's
    // asks are read and answered through these three tools, never the inbox.
    hasChildAsks: tools.has('children_attention') && tools.has('children_ask_get') && tools.has('children_ask_answer'),
  }
}

export async function poll($: EngineInterface): Promise<void> {
  if (mod.isPolling) {
    mod.pollAgain = true
    return
  }
  mod.isPolling = true
  try {
    do {
      mod.pollAgain = false
      try {
        mod.cell = mod.cell ?? (await findCell($))
        if (!mod.cell) {
          $.ui.status(undefined)
          return
        }
        if (!mod.inSpace) await pollFleet($, [mod.cell], mod.config.notify)
        else {
          // No desktop to notify in a space; the inspector reads last so the
          // status line stays the space's own. A space that may answer its
          // children's asks is read without the pane open too, so Autopilot
          // runs unattended there.
          if (mod.fleetOpened || mod.cell.hasChildAsks) await pollFleet($, [mod.cell], false)
          if (mod.config.space !== 'off') await pollInspector($, mod.cell.server, mod.cell.hasSpaceReads === true)
        }
        mod.problem = ''
      } catch (err) {
        mod.problem = err instanceof Error ? err.message : String(err)
        $.ui.status(undefined)
      }
    } while (mod.pollAgain)
  } finally {
    mod.isPolling = false
  }
}
