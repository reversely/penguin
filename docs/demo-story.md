# Demo story: one person's seat

The demo shows Penguin from Priya's dashboard while use case 1 (identity unification) runs through
the procedure in [design.md](design.md#procedure). Each frame answers one question a viewer would ask,
in that order. A frame passes only if someone who has never seen Penguin can read the answer off the
screen without a caption.

The frames describe the approved design. The current build runs the same use case as a Huddle
([huddle-flow.md](huddle-flow.md)). The fixture changes it needs are listed in
[fixture.md](fixture.md#under-the-new-procedure).

The people, from `examples/identity-unification/base/penguin/`:

| Person | Team | DRI for | Reads | Steward | Builder |
|---|---|---|---|---|---|
| Priya | Data | Ingestion and the identity map | none | `@priya/steward` | `@priya/person-id-merge-rules` |
| Jun | Data | Analytics | The identity map | `@jun/steward` | `@jun/retention-dashboard` |
| Sam | Lifecycle messaging | Messaging and the CRM sync | The identity map | `@sam/steward` | `@sam/reengagement-audience` |

## Who does what

- **People** own scopes and features. Each person approves the part of a plan that touches their
  code. A person asks for a change when a review shows a broken invariant.
- **Their agents** write the code. The agent whose feature changes something others depend on writes
  the merge plan. It also writes each approved fix into the affected feature's fork.
- **Penguin** checks, routes and promotes. It finds the running features a change affects. It
  validates each review form and runs the side-by-side comparison. It promotes the block to main in
  one push. Penguin writes no judgment fix. On screen its posts read as notices of fact, each saying
  what the feature waits on.

**Cloudflare** holds and runs the coordination. Each frame names the piece doing the work:

| Piece | What it does in the story |
|---|---|
| Artifacts repo `main` | The team's code. Only Penguin writes to it, once, at promotion |
| Artifacts repos `feature-*` | One fork of main per feature: Priya's merge rules, Jun's retention dashboard, Sam's re-engagement audience |
| Artifacts repo `record` | Every plan, approval, check and promotion as a signed file |
| `createToken(scope, ttl)` | Short-lived write tokens: each agent on its own fork, Priya's agent on an approved fork, Penguin on main |
| Durable Object `ProjectAgent` | People, scopes, invariants, features and their areas; validates and signs every record |
| Durable Object `FeatureAgent` | One per feature with a merge plan: the plan, approvals, fix writes, block checks and the promotion |
| Worker | The dashboard, the agents' MCP tools, forking and token minting, reading changed lines out of Artifacts |

## Frames

| # | The viewer's question | What Priya's screen shows | Cloudflare piece |
|---|---|---|---|
| 1 | Who is working on what? | The team view: Priya, Jun and Sam as squares. Each square holds the person's features with their agents and a one-word state. Jun's retention dashboard and Sam's re-engagement audience read "building" | ProjectAgent (people, features, sessions); `feature-*` forks in Artifacts |
| 2 | Can Priya start? | Priya's agent opens "Add person_id with merge rules". Its area is the identity map with the `person_id` contract. No running feature works in that area, so the feature starts at once. Penguin lists the two running features that read the identity map: Jun's retention dashboard and Sam's re-engagement audience | Worker forks main into the feature's repo with `fork()`; ProjectAgent checks the area |
| 3 | Whose work does the change break? | The feature page: the merge plan with the `person_id` contract diff, the invariants of analytics and messaging, plus four proposed fixes. Priya's own fork fixes analytics' and messaging's code on main. Jun's dashboard gets a cutover marker so past days keep the counts they were published with. Sam's audience honours an unsubscribe from any identity linked to the person | FeatureAgent holds the plan; Worker reads the contract diff from the forks |
| 4 | Who has approved? | The plan's four parts. Sam's two parts read "approved": the side-by-side run shows no consent changes once the fix is in. Jun's two parts read "broken invariant" | FeatureAgent tracks each part; each approval is a signed file in `record` |
| 5 | Why does Jun ask Priya for a change? | Jun's review form. The invariant "patrons who log in on one library tablet stay separate people" breaks. The side-by-side run shows strangers on one tablet merged into one person. The break sits in Priya's merge rules, so Jun asks for a limit on identities per device in Priya's own feature | ProjectAgent validates the form; the check runner runs main against the fork |
| 6 | Did the first revision fix it? | Priya's agent sets the limit to five. The rerun still merges a busy tablet's users. Jun asks for a lower limit | Priya's `feature-*` fork holds the revision; FeatureAgent records the request |
| 7 | Did the second revision fix it? | The lower limit passes the side-by-side run. Jun's part reads "approved" | FeatureAgent records the approval in `record` |
| 8 | Where do the fixes go? | Priya's agent writes the cutover marker into Jun's existing fork and the unsubscribe fix into Sam's. Jun's and Sam's agents keep building on code that already fits | `createToken()` mints a write token for Priya's agent on each approved fork, for minutes |
| 9 | Is it safe to promote? | The block's checks: Priya's fork merged onto main and onto each affected fork with its fix in place. Every check passes | The check runner runs the checks; FeatureAgent records each result |
| 10 | How does it end? | Main moves to Priya's feature commit in one push. Priya's fork turns read-only. The record lists every step. Jun was asked twice and Sam once | `createToken()` on main for Penguin alone; the promotion is a signed file in `record` |

## Frames in every case

The walkthrough ([walkthrough.md](walkthrough.md)) captures these frames in each of the four cases,
one screenshot per frame from the seat the frame names. Each file is `<n>-<frame>.png` in capture
order.

| Frame | Frame above | Seat | Shows |
|---|---|---|---|
| `team` | 1 | The originating person | The team view |
| `start-waits` | Case 4 only | The person whose running feature covers the area | The overlapping start in that person's inbox, before the approval |
| `open` | 2 | The originating person | The feature page's declaration and the features that read it |
| `returned` | Case 4 only | The originating person | The plan returned over the break limit, in that person's inbox |
| `plan` | 3 | The originating person | The merge plan with its facts, the tools that produced them and the parts |
| `review` | 5 | The author | The author's inbox card for the plan: the review form, the side-by-side run and the parts |
| `approvals` | 4 | The originating person | The plan's parts with their states |
| `revision` | 6 | The author | The card after a revision that still differs, one per such revision |
| `revision-passes` | 7 | The author | The card after the last revision |
| `midway` | Case 4 only | The originating person | The plan with the part Penguin added at a running feature's checkpoint |
| `fixes` | 8 | The originating person | The fixes written into other forks |
| `block-checks` | 9 | The originating person | The last `check` run before landing, by tool |
| `promoted` | 10 | The originating person | The whole feature page after the promotion, with its record |

In cases 2 and 3 no author asks for a change, so `revision` and `revision-passes` do not appear and
`review` shows the first reviewed part its author approves. In case 4 a plan over the break limit goes
back to Ines, so its frames end at `returned`. Today case 4 stops before Ines opens, at the promotion
the fixture makes first ([walkthrough.md](walkthrough.md#where-the-cases-stop)), so it captures `team`
only.

## Rules for the frames

- Every name, scope, test and line of code comes from the fixture and the run. Nothing is typed in.
- Plain words on screen: no hashes, fingerprints or test ids as the main text. They stay available
  one click away for anyone checking.
- One frame, one point. A frame that needs the caption to make sense fails.

## Tools on screen

Whenever a deterministic tool acts in a frame, the frame names the tool and shows what it reported or
changed: the `ast` impact graph listing the callers of a changed function, the contract diff naming
the changed signature, pyright's error on the merged tree, ruff's fixes, a LibCST codemod's rewritten
call sites, the side-by-side run's differing cases. A viewer sees which step a tool settled and which
step needed an agent or a person.
