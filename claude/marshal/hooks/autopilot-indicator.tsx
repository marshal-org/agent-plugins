import type { ClientModule } from 'claude-code'

// The moving "Autopilot is on" indicator: a client-side component with its
// own 500 ms frame clock, so the hooks side redraws nothing while it moves.
// It exists only while Autopilot is on and the pane is open (paused or off
// draws a still glyph instead), so no timer runs otherwise. Under reduced
// motion, or with the window out of focus, it holds still.

type Props = { label: string }
type State = { frame: number }

const SPIN = ['◐', '◓', '◑', '◒']
export const STILL = '◆'
// A soft shimmer: one letter of the label lit, sweeping left to right, then
// a short rest before it starts again.
const REST = 4

const Indicator: ClientModule<Props, State> = (props, surface) => {
  const { Box, Text } = surface.elements
  if (surface.state === undefined) {
    surface.every(500, () => {
      if (surface.isMotionReduced || !surface.isWindowFocused) return
      surface.setState({ frame: (surface.state?.frame ?? 0) + 1 })
    })
    surface.setState({ frame: 0 })
  }
  const label = props.label
  if (surface.isMotionReduced) {
    return (
      <Box flexDirection="row" gap={1}>
        <Text color="success">{STILL}</Text>
        <Text bold>{label}</Text>
      </Box>
    )
  }
  const frame = surface.state?.frame ?? 0
  const at = frame % (label.length + REST)
  return (
    <Box flexDirection="row" gap={1}>
      <Text color="success">{SPIN[frame % SPIN.length]}</Text>
      <Box flexDirection="row">
        <Text bold>{label.slice(0, at)}</Text>
        <Text bold color="suggestion">
          {label.slice(at, at + 1)}
        </Text>
        <Text bold>{label.slice(at + 1)}</Text>
      </Box>
    </Box>
  )
}

export default Indicator
