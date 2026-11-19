import type { Elements } from 'claude-code'

import type { Fleet, Inspector } from '../types'

export const FLEET_PANE = 'marshal-fleet'
export const INSPECT_PANE = 'marshal-space'

// Every Marshal space pod mounts this socket for the agent (the marshal-agent
// CLI talks to the supervisor through it). Its presence is how the mod knows
// it runs inside a space; the mod never calls it.
export const SPACE_SOCKET = '/run/marshal-agent.sock'

// Atoms are declared in each file that reads or writes them (the scan needs
// the reference written where it is used). Same ref = same value.
export const EMPTY_FLEET: Fleet = { cells: [], polledAt: 0 }
export const EMPTY_INSPECTOR: Inspector = { spaceId: '', problem: '', tabs: {} }

export type Kit = Pick<Elements['terminal'], 'Box' | 'Text' | 'Button'> &
  Partial<Pick<Elements['terminal'], 'Input' | 'Link' | 'Progress' | 'Markdown'>>
