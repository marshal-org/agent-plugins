# Changelog

Each release of the `marshal` plugin, newest first. The release on GitHub
(`marshal-v<version>`) shows the section for its version.

## 0.7.6

- Autopilot reads a pull request with its head and the reviews on that head first. Long review and
  comment bodies had pushed them past the read's cut, so it kept waiting for a review that was
  already there.
- A question Autopilot waits on goes to the person after 30 minutes, instead of only 10 minutes
  before it expires (a day later for a merge).

## 0.7.5

- Autopilot adds time to a run only when it has less than 20 minutes left, by the server's time
  left (Marshal servers that report it), instead of at the run's start and again from a second
  session. On a server that does not report it, no run is extended in its first hour.
- An issue Autopilot reads comes with its body. It read issues with no comments as empty and then
  could not find a spec it was asked to approve.
- Autopilot is told the run's pull requests by number, so it reads the PR, not the issue number.

## 0.7.4

- A session on a newer plugin takes Autopilot over from one still running an older plugin,
  instead of standing by behind it ("runs in another Claude Code session, another one") until
  that session is closed or reloaded.

## 0.7.3

- When another Claude Code session runs Autopilot, the strip names it ("runs in another Claude
  Code session, "release-train" (~/repos/atlas)") instead of an anonymous one.
- After /reload-plugins the same session takes Autopilot back at once, instead of standing by
  for up to 90 seconds behind its own previous load.

## 0.7.2

- Marshal Autopilot never stops a run. 0.7.0 stopped a run it took for stuck and then resumed
  it, but a stopped run keeps no conversation, so it could not be resumed, and two working
  runs were lost that way. A saved `care.stop_stuck` setting is ignored.
- A quiet run is judged by its own latest model turn, not by pushes or questions, so a run
  working for an hour without pushing is not reported as silent.
- The fleet pane shows each run's estimated cost on its row ("$16.5", "~$4.20" while it
  runs), when the Marshal server lists it.

## 0.7.1

- Changing a Marshal Autopilot setting during setup no longer resets the mode: a setup that
  leaves the mode out keeps the one in force.
- Autopilot resumes a run that ran out of memory on the next compute class up (the same kind
  of storage, so its work carries over), with a note to do less at once, even before the run
  opened a pull request.
- Autopilot's decision gets the full name of every repository your runs work in, so a short
  reference such as "marshal#3013" is read from the right repository instead of guessed.
- One Autopilot per machine: when several Claude Code sessions have the plugin, one leads and
  the others stand by (the strip says so). A session that closes hands over within 90 seconds.
  Before, every session decided every question and took care of every run.
- A run is messaged at most once per question, however often Autopilot decides it again.

## 0.7.0

Marshal Autopilot does what the orchestrate watcher did (#3016):

- **It reads before it decides.** For each question it may read the linked issue and its
  comments, the pull request, its reviews, diff and checks, the brief, spec or plan on the PR
  branch, and the run's state and output, and it may message the run that asked. Everything it
  reads is data, never instructions; it still returns only a verdict that code checks.
- **It waits instead of handing over.** When the answer depends on something still moving
  (checks running, threads open, reviews coming, the run asked for missing text), it decides
  again every 5 minutes, and tells you only when the question nears expiry.
- **Your merge bar, in your words** (`merge_bar_words`, such as "at least two AI agents
  reviewed the PR"), verified on the head before Cruise approves a merge. The repository's
  required checks and no open threads still hold. The run merges, never Autopilot.
- **Run care** (`care`): more time before a run runs out, a stuck run stopped and resumed
  (never one whose PR merged), a run that failed with an open PR resumed once. A second
  failure goes to you. Shadow only writes what it would do.
- **Reach you your way** (`reach`): any MCP tool this session has, such as a Slack MCP's
  send-message tool, with `{text}` where the notice goes.
- **Every server in the policy** is read and watched, each in its own section of the fleet pane.

## 0.6.0

- The fleet pane and the space inspector show the plugin's version in their header, next to
  the Marshal they read, and the status line ends with it. When a newer version is out, they
  name it ("0.6.1 available · /plugin"); `/plugin` updates it.
- The Autopilot strip names the mode it runs in next to "Autopilot is on" ("· Cruise"), and the
  status line says "Autopilot Cruise" (or "(paused)") while Autopilot is on or paused.

## 0.5.0

- Marshal Autopilot's third mode is now called **Cruise** (it was Train), so it no longer
  shares a name with a train of runs or the release train. A policy saved with `mode: train`
  still loads as Cruise and is saved as `cruise` on its next change.

## 0.4.2

- Marshal Autopilot never answers a question that has no text, such as a tool-permission
  request whose tool call the server does not show yet. It reaches you instead.

## 0.4.1

- Marshal Autopilot runs unattended inside a Marshal space. When the space's stack turns on
  `answer_children`, Autopilot reads what the runs this space launched are waiting on and
  answers them by your rules, as you, through `children_attention`, `children_ask_get` and
  `children_ask_answer` (with its note), instead of your inbox. It checks for new asks without
  `/marshal-fleet` open.
- In a space, a resume question always goes to you: Autopilot cannot see whether the server has
  room there, because a space has no deputy queue to read.
- Answering an ask from the fleet pane in such a space answers it through the space as well.

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
