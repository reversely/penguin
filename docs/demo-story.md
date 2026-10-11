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

## Frames

| # | The viewer's question | What Priya's screen shows |
|---|---|---|
| 1 | Who is working on what? | The team map: three people, each with what they own and which other scopes read it; Priya's agent working on "Add person_id with merge rules" |
| 2 | What did Penguin notice? | Priya's inbox: her agent's change breaks work owned by Jun and Sam, with a link to the Huddle |
| 3 | What broke, for whom? | The Huddle: the change in one line (Priya's agent added person_id merge rules), then three breaks in the owners' words: Jun's daily actives drop when duplicate people collapse; a library tablet merges strangers into one person; Sam's unsubscribe is lost when profiles merge. Each break names who fixes it |
| 4 | Who fixes what? | Each fix with its owner's agent: Jun's agent on the daily actives and the tablet, Sam's agent on the unsubscribe |
| 5 | Why is a fix coming back to Priya? | Jun's agent sent the tablet fix to Priya's agent, with its reason: the fix belongs in the merge rules |
| 6 | What did Priya's agent change? | The changed lines of the device limit in the merge rules, and Priya's Approve |
| 7 | What if an owner disagrees? | Jun asks for changes: a limit of five still joins the tablet's users. The thread needs Priya; she replies; her agent lowers the limit |
| 8 | Is it fixed? | The combined tests pass on all three owners' work together |
| 9 | How does it end? | The Huddle closes: every break fixed, every owner approved, and where the result went |

## Rules for the frames

- Every name, scope, test and line of code comes from the fixture and the run; nothing is typed in.
- Plain words on screen: no hashes, fingerprints or test ids as the main text; they stay available
  one click away for anyone checking.
- One frame, one point. A frame that needs the caption to make sense fails.

Frame 9 depends on an open decision on the Penguin Build board: where an approved result goes.
