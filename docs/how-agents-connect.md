# How Penguin reaches each person's agents

Each person on a team runs their own Claude Code or Codex on their own machine. Penguin never runs,
starts or reads those agents. It reaches them by three paths only. [README.md](README.md)
lists the other docs; [architecture.md](architecture.md) places these paths among Penguin's pieces.

```mermaid
flowchart LR
  subgraph Machine["One person's machine"]
    Agent["Claude Code or Codex"]
    Hook["PreToolUse hook<br/>penguin-bridge session-checkpoint --hook"]
    Bridge["penguin-bridge<br/>checkpoints, tests"]
  end
  Penguin["Penguin<br/>Worker + ProjectAgent"]
  Inbox["The person's inbox<br/>on the dashboard"]
  Agent -- "1. MCP tool calls" --> Penguin
  Hook -- "2. before each tool call:<br/>anything new?" --> Penguin
  Hook -. "one line of context" .-> Agent
  Bridge -- "checkpoints, test results" --> Penguin
  Penguin -- "3. when no agent can be reached" --> Inbox
```

## 1. The agent asks Penguin

Each person adds Penguin to their agent as an MCP server: one server address and that person's own
MCP token. Configuration for both products is in [mcp-setup.md](mcp-setup.md). The agent then has
eight tools:

| Tool | What the agent uses it for |
|---|---|
| `register_session` | Says which of its person's agent identities it works as, such as `@jun/reports` |
| `get_work` | Reads the issues and fix tasks assigned to that identity; also the threads and overlapping starts that need its person and whether its feature waits to start |
| `get_issue` | Reads one issue in full |
| `post_update` | Comments, links a commit, changes state, replies in a thread, sends a fix upstream |
| `report_checkpoint` | Reports a checkpoint on its person's owner fork or on its feature's fork; the answer lists any task or thread that arrived |
| `open_feature` | Opens a feature, or joins one its person already opened, with a declared area; the answer carries a short-lived write token on the feature's fork, or lists the running features whose people must approve first |
| `feature_token` | Gets a fresh write token on its feature's fork once no overlap lock holds its start |
| `declare_area` | Replaces its feature's declared scopes, paths and contracts |
| `submit_review` | Submits the review form for its own scope on another feature's change; the answer accepts it or lists every reason it is refused |

Penguin answers only when the agent calls a tool. The token decides whose identities the session may
use: Sam's token cannot register as `@jun/reports`.

## 2. A note before the agent's next step

An agent that is busy does not call `get_work` on its own. Claude Code and Codex both run command
hooks before each tool call. The project's hook settings run `penguin-bridge session-checkpoint --hook`
there. The hook asks Penguin whether anything new is waiting for this session:

- Nothing waiting: the hook prints nothing and the tool call goes ahead.
- A fix task or a thread arrived: the hook adds one line to the agent's context telling it to call
  `get_work`. The agent reads the task at that point, between two steps, never in the middle of one.
- Penguin unreachable: the hook stays silent and the tool call goes ahead.

This path reaches an agent that keeps working without anyone typing. The hook settings for both
products are in [mcp-setup.md](mcp-setup.md#fix-tasks-and-safe-checkpoints).

## 3. The person's inbox

An agent that is not running, or that has stopped to wait for its person, makes no tool calls, so
neither path above reaches it. Penguin cannot start or wake an agent. On a Claude plan nothing can
post into a session's window from outside. Penguin puts the item in the person's inbox on the
dashboard instead: "Start a session" for a task assigned to an identity with no running session,
"Waiting for your reply" for a thread, "Waiting for your review" for a fix. The person then starts a
session or tells their agent.

## What each person installs

| Piece | Where | What it does |
|---|---|---|
| `penguin-bridge` | Their machine, from this repo (`services/local-bridge`; see [bridge-and-runner.md](bridge-and-runner.md)) | Publishes their checkpoints to Penguin after showing them the exact changes, runs the project's allowed test commands, provides the hook command |
| One MCP server entry | Their Claude Code or Codex settings | Path 1 |
| One hook entry | The project's `.claude/settings.json` or `.codex/hooks.json` | Path 2 |
| A dashboard sign-in | Their browser, through GitHub | Path 3 |

## What Penguin does not do

- Read an agent's conversation: transcripts stay on the person's machine.
- Start, stop or wake an agent.
- Push code for an agent: each agent's work reaches Penguin only as a checkpoint its person's bridge
  publishes.
