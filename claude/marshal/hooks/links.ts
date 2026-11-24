import type { EngineInterface } from 'claude-code'

// Claude Code draws a Link as clickable text only in a terminal it knows
// handles OSC 8 links. Anywhere else (herdr, for one) it draws "text URL",
// which wraps a narrow column into a tall strip of URL pieces. The panes ask
// the same question first and, on "no", draw no Link at all: plain text, and
// the URL once, in full, where a terminal can still open it.
//
// The check is Claude Code's own, read from the same variables: FORCE_HYPERLINK
// decides when set, else the terminals it knows.
const KNOWN = ['ghostty', 'Hyper', 'kitty', 'alacritty', 'iTerm.app', 'iTerm2', 'rex', 'WarpTerminal', 'WezTerm', 'vscode']

export async function terminalLinks($: EngineInterface): Promise<boolean> {
  const [force, program, version, emulator, wt, tmux, lcTerminal, term, vte] = await Promise.all([
    $.env.get('FORCE_HYPERLINK'),
    $.env.get('TERM_PROGRAM'),
    $.env.get('TERM_PROGRAM_VERSION'),
    $.env.get('TERMINAL_EMULATOR'),
    $.env.get('WT_SESSION'),
    $.env.get('TMUX'),
    $.env.get('LC_TERMINAL'),
    $.env.get('TERM'),
    $.env.get('VTE_VERSION'),
  ])
  if (force) return !/^(0|false|no|off)$/i.test(force.trim())
  if (program && KNOWN.includes(program)) return true
  if (lcTerminal && KNOWN.includes(lcTerminal)) return true
  if (emulator === 'JetBrains-JediTerm') return true
  if (wt && program !== 'tmux' && !tmux) return true
  if (program === 'tmux') {
    const [major = 0, minor = 0] = (version ?? '').split('.').map(n => parseInt(n, 10) || 0)
    if (major > 3 || (major === 3 && minor >= 4)) return true
  }
  if (term?.includes('kitty') || term === 'alacritty') return true
  if (vte && vte !== '0.50.0' && vte !== '5000') {
    // "7600" is 0.76; "0.50.1" is 0.50.
    const [major, minor] = /^\d{3,4}$/.test(vte) ? [0, Math.floor(Number(vte) / 100)] : vte.split('.').map(n => parseInt(n, 10) || 0)
    if ((major ?? 0) > 0 || (minor ?? 0) >= 50) return true
  }
  return false
}
