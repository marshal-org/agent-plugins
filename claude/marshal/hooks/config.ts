import type { PluginOptions } from 'claude-code'

export type Mode = 'auto' | 'command' | 'off'

export type Config = {
  // The Marshal MCP address the plugin's own server connects to (.mcp.json);
  // empty when the person added Marshal with claude mcp add instead.
  url: string
  // The MCP server name the person chose; empty means the first Marshal server.
  server: string
  fleet: Mode
  space: Mode
  pollMs: number
  notify: boolean
}

function mode(v: unknown, fallback: Mode): Mode {
  return v === 'auto' || v === 'command' || v === 'off' ? v : fallback
}

export function readConfig(options: PluginOptions): Config {
  const seconds = Number(options.pollSeconds ?? 20)
  return {
    url: String(options.url ?? '').trim(),
    server: String(options.server ?? '').trim(),
    fleet: mode(options.fleet, 'command'),
    space: mode(options.space, 'command'),
    // Never faster than every 5 seconds: each poll is two MCP calls.
    pollMs: Math.max(5, Number.isFinite(seconds) ? seconds : 20) * 1000,
    notify: options.notify !== false,
  }
}

// Tool names are mcp__<server>__<tool>; a Marshal server lists this one.
const MCP_TOOL = /^mcp__(.+?)__([A-Za-z0-9_]+)$/
const MARKERS = new Set(['runs_attention', 'runs_get'])

// The Marshal servers among the session's tools, in the order listed.
export function marshalServers(toolNames: readonly string[]): string[] {
  const out: string[] = []
  for (const t of toolNames) {
    const m = MCP_TOOL.exec(t)
    if (m && m[1] && m[2] && MARKERS.has(m[2]) && !out.includes(m[1])) out.push(m[1])
  }
  return out
}

// The tools one server lists, by their short names.
export function toolsOf(server: string, toolNames: readonly string[]): Set<string> {
  const prefix = `mcp__${server}__`
  return new Set(toolNames.filter(t => t.startsWith(prefix)).map(t => t.slice(prefix.length)))
}

// The configured server in tool-name spelling: every character outside
// [A-Za-z0-9_-] becomes "_", as the engine spells it in tool names.
export function toolSpelling(server: string): string {
  return server.replace(/[^A-Za-z0-9_-]/g, '_')
}

// The plugin's own server (.mcp.json), as tool names spell it.
export const OWN_SERVER = 'plugin_marshal_marshal'

export function pickServer(config: Config, found: readonly string[]): string {
  if (config.server) {
    const want = toolSpelling(config.server)
    return found.find(s => s === want) ?? ''
  }
  if (config.url && found.includes(OWN_SERVER)) return OWN_SERVER
  return found[0] ?? ''
}
