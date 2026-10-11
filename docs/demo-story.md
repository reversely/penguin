# Demo story: one person's seat

The demo shows Penguin from Priya's dashboard while use case 1 (identity unification) runs on the
live site. Each frame answers one question a viewer would ask, in that order. A frame passes only if
someone who has never seen Penguin can read the answer off the screen without a caption.

The team, from `examples/identity-unification/base/penguin/`:

| Person | Owns | Agent |
|---|---|---|
| Priya | Ingestion and identity map | `@priya/merge-rules` |
| Jun | Analytics models, which read the identity map | `@jun/reports` |
| Sam | Messaging and CRM sync, which read the identity map | `@sam/campaigns` |

## Who does what

- **People** own scopes and decide: each one reviews the fixes that touch what they own.
- **Their agents** write the fixes, each inside its person's scope.
- **Penguin** coordinates and never writes or decides a fix. It notices when a change breaks someone
  else's work, pulls everyone affected into one Huddle at once, routes each fix to the right agent,
  runs everyone's tests together, and closes the Huddle when every owner has approved. On screen its
  posts read as notices of fact and it says what the Huddle is waiting on.

**Cloudflare** holds and runs the coordination, and each frame names the piece doing the work:

| Piece | What it does in the story |
|---|---|
| Artifacts repo `base` | The team's code everyone starts from |
| Artifacts repos `owner-priya`, `owner-jun`, `owner-sam` | Each person's published checkpoints, the agents' unfinished work |
| Artifacts repo `huddle-<id>` | Forked when the Huddle opens; holds everyone's fixes combined on `integration` and the result on `approved` |
| Artifacts repo `issues` | Every action on the Huddle as a signed file, the audit trail |
| Durable Object `ProjectAgent` | Validates each action, keeps the board and inboxes, opens Huddles |
| Durable Object `HuddleAgent` | One per Huddle: runs verification, collects reviews, decides close |
| Queue `penguin-issues-events` | Artifacts push events that tell Penguin the issue log changed |
| Worker | The dashboard, the agents' MCP tools, and reading changed lines out of Artifacts |

A Huddle is one task. Everyone it pulls in works on it at the same time, in one shared conversation,
each with a role: the person whose change started it, the people whose work broke, and anyone a fix
is sent to.

## Frames

| # | The viewer's question | What Priya's screen shows | Cloudflare piece |
|---|---|---|---|
| 1 | Who is working on what? | The team map: three people, each with what they own and which other scopes read it; Priya's agent working on "Add person_id with merge rules" | ProjectAgent (team, sessions); owner forks in Artifacts |
| 2 | What did Penguin notice? | Priya's inbox: her agent's change breaks work owned by Jun and Sam, with a link to the Huddle | Priya's checkpoint in `owner-priya`; ProjectAgent schedules the combined run |
| 3 | What broke, for whom? | The Huddle: the change in one line (Priya's agent added person_id merge rules), then three breaks in the owners' words: Jun's daily actives drop when duplicate people collapse; a library tablet merges strangers into one person; Sam's unsubscribe is lost when profiles merge. Each break names who fixes it | Huddle repo forked in Artifacts; failing tests recorded in `issues` |
| 4 | Who fixes what? | Each fix with its owner's agent: Jun's agent on the daily actives and the tablet, Sam's agent on the unsubscribe | ProjectAgent routes each fix to an agent through the Worker's MCP tools |
| 5 | Why is a fix coming back to Priya? | Jun's agent sent the tablet fix to Priya's agent, with its reason: the fix belongs in the merge rules | The handoff is a signed action in `issues` |
| 6 | What did Priya's agent change? | The changed lines of the device limit in the merge rules, and Priya's Approve | Worker reads the changed lines from `owner-priya` in Artifacts |
| 7 | What if an owner disagrees? | Jun asks for changes: a limit of five still joins the tablet's users. The thread needs Priya; she replies; her agent lowers the limit | HuddleAgent tracks the thread; every reply is a signed action in `issues` |
| 8 | Is it fixed? | The combined tests pass on all three owners' work together | HuddleAgent merges everyone's fixes on `huddle-<id>/integration` and runs the tests |
| 9 | How does it end? | The Huddle closes: every break fixed, every owner approved, and where the result went | HuddleAgent records `huddle-<id>/approved` in Artifacts |

## Rules for the frames

- Every name, scope, test and line of code comes from the fixture and the run; nothing is typed in.
- Plain words on screen: no hashes, fingerprints or test ids as the main text; they stay available
  one click away for anyone checking.
- One frame, one point. A frame that needs the caption to make sense fails.

Frame 9 follows PRD section 6 step 8: the Huddle closes with the `approved` branch recorded in its Huddle repo. Merging it is a separate action (PRD section 5).
