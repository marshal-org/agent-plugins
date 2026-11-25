# Changelog

Each release of the `marshal` plugin, newest first. The release on GitHub
(`marshal-v<version>`) shows the section for its version.

## 0.4.0

- Marshal Autopilot answers the questions your runs ask, by rules you set, and brings you the
  rest. Ask Claude to "set up Marshal Autopilot": the `autopilot` skill shows the modes
  (Shadow, Routine, Train) and the never-auto list, asks a short set of questions with a
  recommendation on each, reads your settings back in plain words and starts in Shadow, where it
  answers nothing and shows what it would answer.
- Add your own rules in plain words, such as "anything touching billing, ask me". Protect rules
  always win, and takeovers, access grants, deploys to staging or production, releases and
  deletes are never answered automatically.
- Autopilot watches running runs' pull request checks: after the same check fails twice at the
  same step it sends the run the failing log lines (secrets removed), and on the third it tells
  you. A running run that goes quiet for 30 minutes is reported too.
- The fleet pane shows an Autopilot strip: "Autopilot is on" with a moving indicator, the latest
  answers with their rule, and what waits on you. `p` pauses, `s` stops, `e` explains the
  selected answer and `o` opens its run.
- A train: decisions for one batch of runs on top of your rules; your own answers during the
  train are followed over Autopilot's.

## 0.3.7

- New skill `improve-deputy`: give it a run or a deputy and it reads how the runs spent their
  time and money, then proposes exact changes to the mission text, the deputy's settings, the
  manifest or the compute class, each with the evidence and what it would save.

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
