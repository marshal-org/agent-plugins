import type { Kit } from './atoms'
import { updateLabel, versionLabel, versions } from './version'

// The plugin's version in a pane's header, next to the Marshal it reads, and
// a notice when a newer plugin is out (/plugin updates it).
export function pluginVersion(kit: Kit) {
  const { Text } = kit
  const label = versionLabel(versions)
  if (!label) return null
  const update = updateLabel(versions)
  const parts = [
    <Text key="ver:sep" dimColor>
      ·
    </Text>,
    <Text key="ver" dimColor>
      plugin {label}
    </Text>,
  ]
  if (update !== '')
    parts.push(
      <Text key="ver:new" color="warning">
        ↑ {update} · /plugin
      </Text>,
    )
  return parts
}
