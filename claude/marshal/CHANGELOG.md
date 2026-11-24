# Changelog

Each release of the `marshal` plugin, newest first. The release on GitHub
(`marshal-v<version>`) shows the section for its version.

## 0.3.6

- The fleet pane reads well in terminals where Claude Code shows no clickable links, such as
  herdr: it draws plain text, shows each ask's run address once in full, and says how to turn
  links on (start Claude Code with `FORCE_HYPERLINK=1`).
- The ask above the prompt keeps "open run" and its note on one line each: when the row is
  full, they move below the answer buttons instead of breaking into pieces.

## 0.3.5

- The plugin uploads to Claude Desktop. Each release carries `marshal-plugin-<version>.zip`,
  the plugin alone, with a `.sha256` next to it.
- In Claude Desktop and other chat apps that show cards, ask for your fleet and get it as a
  live card in the conversation, from the Marshal MCP's `fleet` tool.

## 0.3.4

- Every message in the fleet pane opens its run in the Marshal web app: the ask card's title,
  the run it comes from, and each run's title. The ask above the prompt links to its run too.
- Links work in the Claude Code desktop app, where the Marshal connector has no name in your
  Claude Code config: the pane uses the address from the plugin's `url` setting.
- The pane header names your Marshal by its web address and links to it.
- Cleaner layout: section titles stay on one line, and run rows line up (status, title,
  deputy and age) in the desktop app as well as the terminal.
