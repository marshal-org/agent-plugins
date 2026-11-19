# Marshal agent plugins

Plugins that bring Marshal into coding agents. One folder per agent harness:

| Folder | Harness | Plugins |
|---|---|---|
| `claude/` | Claude Code | `marshal` |

This folder is published as the public repo
[`marshal-org/agent-plugins`](https://github.com/marshal-org/agent-plugins) (a mirror; changes
land here, in the marshal monorepo). Its root `.claude-plugin/marketplace.json` makes the repo a
Claude Code plugin marketplace named `marshal`. A later harness (Codex, Gemini CLI, ...) gets its
own folder and its own catalog file.

## Claude Code: `marshal`

One plugin, `marshal`, in `claude/marshal/`:

| Part | Where it works | What it does |
|---|---|---|
| Skills `delegate`, `inbox`, `debug-run`, `suggest-stack` | Anywhere the Marshal MCP is connected | Teach Claude to hand a task to a Marshal run, triage what waits on you, find why a run failed, and build the org's first stack and manifests from your repositories |
| Fleet pane `/marshal-fleet` | Claude Code on a laptop | Your runs on one Marshal cell: what needs you (answer with a press), failed or parked, running, recently ended. Status line, toasts, a desktop notification on a new ask |
| Space inspector `/marshal-space` | Claude Code inside a Marshal space | The space's own overview, audit, requests, reviews, ports, changes and cost. Read only |

The panes are a Claude Code mod: a TypeScript hooks module (`hooks/register.tsx`) that draws
with `ui.render` and reads Marshal through the MCP server Claude Code already has
(`$.mcp.call`). There is no other network path and no credential in the plugin.

Spec and decisions: [`docs/specs/feat-claude-plugin/`](../../docs/specs/feat-claude-plugin/).

## Install (laptop)

One command, with your own Marshal's MCP address (the Marshal web app shows this exact command, filled
in, under **Connect an agent**):

```
claude plugin install marshal --marketplace marshal-org/agent-plugins --config url=https://<your-marshal>/mcp
```

Then in Claude Code: `/mcp`, pick `plugin:marshal:marshal`, sign in. Your org must have MCP access
turned on. Then `/marshal-fleet` opens the pane beside the transcript (fullscreen terminal) or inline.

The `url` setting is the address of the plugin's own MCP server (`.mcp.json`), so each customer's
internal domain works. Already added Marshal with `claude mcp add`? Leave `url` empty and the plugin
reads that server; set it to the same address and Claude Code keeps one server, not two.

From this repo while it is internal: `claude plugin marketplace add ./apps/agent-plugins`, then
`claude plugin install marshal@marshal --config url=...`.

Settings (`/plugin configure marshal`): `url` (the MCP address), `server` (which connected MCP server
the panes read, empty = the plugin's own, else the first Marshal server), `fleet` (`auto` / `command` /
`off`; default `command`, opened with `/marshal-fleet`), `space` (same, inside a space; default
`command`, opened with `/marshal-space`), `pollSeconds` (default 20, floor 5), `notify` (desktop
notification on a new ask).

What it shows:

- **Fleet pane** (`/marshal-fleet`): what needs you as cards with answer buttons, failed or parked runs,
  running and recently ended runs with their pull requests (when the server has `runs_prs`), details on
  hover, `r` to refresh.
- **Band above the prompt**: the first open ask, answerable in place. No digit hotkeys on purpose: an
  answer can merge a PR, so it takes a deliberate click.
- **Status line and toasts**, and a desktop notification on a new ask.

## Inside a space

The inspector turns on by itself when `/run/marshal-agent.sock` exists (every Marshal space has
it). It reads the space through the Marshal MCP that the `marshal-orchestration` package wires
into the agent (server name `marshal-orchestration`), using its read-only `inspect_self`
capability: `space: "self"`, `space_id: "self"` and `run_id: "self"` resolve server side to the
credential's own space and run. The capability is on by default (marshal-orchestration 1.0.6); a stack that lists its own tools without it turns it off.

It is read only, on purpose. The agent shares the container with the person, so any button
the person can press there, the agent can press too. Approving a network request or a policy
change from inside the space would let the agent unblock itself. Approvals stay in the web app.

Getting the plugin into a space: list it in the `claude-code` package's plugins setting, and
Claude Code installs and updates it from this marketplace. For a space with no access to GitHub,
the `plugin` content type of APM can ship a plugin folder instead (see
`docs/specs/feat-apm-claude-plugin/`).

## Develop

```
cd apps/agent-plugins/claude/marshal
claude plugin validate .     # manifest + what the hooks module hooks and calls
claude plugin test .         # tests/*.test.ts(x) against the engine's test kit
claude --plugin-dir .        # a session with the plugin loaded from disk, hot reloaded
```

Type-check: the engine writes its API types into `.claude-plugin/types/` (git-ignored) when it
loads the plugin from a folder; then `npx -p typescript@5.6 tsc -p .`.

Rules the validator enforces, learned the hard way:

- A function that takes `$` must be declared at the top level of a file (or imported from one).
  No closures over `$` inside `register`.
- Each file that reads or writes a `$.state` value declares its own `atom(...)` with literal
  `plugin` and `key`.
- `ui.render` matchers use literal ids.
- Commands register as `/<name>`, not `/<plugin>:<name>`.
