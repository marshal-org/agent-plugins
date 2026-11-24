# Changelog

Each release of the `marshal` plugin, newest first. The release on GitHub
(`marshal-v<version>`) shows the section for its version.

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
