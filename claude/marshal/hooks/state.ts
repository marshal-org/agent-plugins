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
}

export async function findCell($: EngineInterface): Promise<Cell | undefined> {
  const names = (await $.tool.list()).map(t => t.name)
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
  // that address only when the panes read the plugin's own server; any other
  // server's address is in Claude Code's MCP config. (The url defaults to
  // Marshal cloud, so using it for another server sent every link there.)
  let webUrl = !mod.inSpace && server === OWN_SERVER ? webBase(mod.config.url) : ''
  if (!webUrl) {
    try {
      const home = await $.env.get('HOME')
      if (home) webUrl = webBase(serverUrl(JSON.parse(await $.fs.read(`${home}/.claude.json`)), server, mod.cwd))
    } catch {
      // Links are a convenience; the board works without them.
    }
  }
  const tools = toolsOf(server, names)
  return { server, webUrl, hasPrs: tools.has('runs_prs'), hasAttention: tools.has('runs_attention'), hasQueue: tools.has('runs_cancel_queued'), hasSpaceReads: tools.has('spaces_usage') && tools.has('spaces_changes') }
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
          // status line stays the space's own.
          if (mod.fleetOpened) await pollFleet($, [mod.cell], false)
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
