# Dashboard

The dashboard is where people on the team see who is working on what and what waits on them. The
team view shows each person's features with their agents and one-word states. The approvals inbox
holds what waits on the signed-in person with the facts behind each item. A feature page tells one
feature's story from its declaration to its record. People also act on issues there: open and
assign issues, review fixes, answer threads and manage their agent identities. The issue pages stay
as they were until a ticket replaces them.
Every action it takes is an issue operation or an identity change sent to the ProjectAgent. The
Worker serves it from the same origin as its API. The code is in `apps/dashboard/src/`; the Worker's
routes for it are in `apps/worker/src/dashboard.ts`.

## Pages

| Path | Page |
|---|---|
| `/` | The team view |
| `/?person=<id>` | One person's view |
| `/features/<id>` | One feature's page |
| `/inbox` | The signed-in person's approvals |
| `/identities`, `/identities?identity=<id>` | Every identity, with the chosen one's agent card |
| `/issues/<number or temporary ID>`, `?closed=all` | One issue, beside the person's issue items |
| `/issues/new` | The New issue form |
| `/board` | Redirects to `/` |

The shell has three panes: a sidebar with the navigation (Team, Inbox with the count of approvals
waiting, Identities), the page's list and the signed-in person's account menu; the centre; and a
details panel for the issue page. From 1100px the panel docks beside the centre; below that it opens
as a drawer. Below 760px the sidebar becomes a phone header. No page in the navigation links to the
New issue form or lists issue items: those belong to the issue pages, which stay until a ticket
replaces them.

## Sign-in

The dashboard signs people in through GitHub OAuth (`apps/worker/src/github-oauth.ts`):

1. "Sign in with GitHub" goes to `/auth/github`, which redirects to GitHub with a random `state` and a
   PKCE challenge. Penguin asks for no OAuth scope.
2. GitHub returns to `/auth/github/callback`. The Worker exchanges the code, reads the account's
   public login once and discards the access token.
3. The Worker looks the login up in `PENGUIN_DASHBOARD_OWNERS`, a comma-separated list of
   `<github login>:<owner id>` pairs. A login missing from the map is sent back with "Please ask your
   Penguin admin to add your GitHub account". A GitHub account alone grants nothing.
4. The Worker sets the session cookie `__Host-penguin_session` for 12 hours: Secure, HttpOnly,
   SameSite=Lax, signed with an HMAC key derived from the OAuth client secret
   (`apps/worker/src/session.ts`). Rotating the client secret signs everyone out.

Every write is authored as the owner id the cookie names; an operation that names its own `author` is
refused. Every POST also requires a same-origin `Origin` header. Account menu, Sign out sends
`POST /auth/signout`. [deploy.md](deploy.md#dashboard-sign-in) covers setting up the OAuth app.

## Team view

The home page shows one square per person, the signed-in person first (`team-page.tsx`, read from
`GET /api/team`). The people are every owner in the scope map, every person with a feature and every
identity owner. The ProjectAgent builds the answer (`services/project-agent/src/dashboard-views.ts`).

Each square holds:

- the person's name and avatar in their hue, linking to the person's view;
- the person's role in `penguin/scopes.json`, by scope name: Owns lists their scopes, Read by lists
  other people's scopes that depend on theirs and Reads lists the scopes theirs depend on. Each scope
  another person owns carries that person's id. A row with no scope is left out, except Owns, which
  says None;
- each of the person's features, newest first, linking to its page, with its stage strip and the
  agents whose sessions joined it. The strip is a dot per stage of the feature's pipeline
  ([design.md](design.md#the-merge-as-a-pipeline-in-the-build)), the current one ringed, then the
  current stage's name, such as `Review needs a person`;
- the person's agents on no feature.

Each feature in `GET /api/team` also carries a one-word state, which comes from facts Penguin holds,
the latest step first:

| State | When |
|---|---|
| promoting | Every part of the feature's merge plan is approved, or its block run is being checked or moving main (`land_feature`) |
| waiting on approvals | The feature's start waits for an overlap approval, or a plan part waits for its author |
| planning | Its agent proposed a plan and the check runner's facts run waits, or Penguin answered with what the plan lacks and no plan is stored, or the plan was returned over the break limit, or a part waits on the agent's revision |
| building | Anything else |
| promoted | Main moved to the feature's checkpoint; its fork is read-only |

Only exceptions are highlighted: a feature carries each exception PRD
section 7 routes to a person as a line in the attention colour, with an attention edge on its row.
The exceptions are a part past the round limit, a plan returned over the break limit, a broken
invariant or a protected difference in the newest review of each scope. A run the check runner
stopped at the failure limit is the last kind. Its line reads "Block run stopped after 3 failures"; the
feature page shows the last reason on the run's failed job.

### Person view

`/?person=<id>` shows the person's role, their features as on the square, their agents on no feature
and every issue that involves them, open issues first. Each issue row carries why it is there:
Assigned, Review, Reply or Session to start.

## Feature page

`/features/<id>` shows one feature, the unit of work (`feature-page.tsx`, read from one request,
`GET /api/features/<id>/page`). It has three levels.

**Header.** It stays at the top of every view:

| Part | Content |
|---|---|
| Breadcrumb | Team, the feature's person, the feature |
| Title | The feature's name, its person as a pill in the person's hue and its scopes as pills in their owners' hues |
| Timeline bar | One node per stage of the feature's pipeline ([design.md](design.md#the-merge-as-a-pipeline-in-the-build)): split features run Open, Expand, Migrate, Contract and Done; the rest run Open, Plan, Review, Fixes written, Block checks and Promoted. Each node shows its status as a dot and its count of passed jobs, such as `2 of 4`, with Needs a person or Failed when a job is. The current stage is ringed. A node opens its stage in the Pipeline view |
| Branches | Each piece of work that reached another person and has not settled hangs from its stage as one line: the reviewing agent, or the person before an agent took it; one label (sent, reviewing, fix written, approved or needs a person); and the part's number and place, which opens its diff. Opening the line shows the job's fact. A settled branch has rejoined the bar as the person's avatar under its stage. Six branches show before a button counts the rest |
| Summary | At most three lines: the contract change with its counts of changes, breaking signatures and incompatible entries; how many features and people the feature reaches; the first place needing a person, else the first failed job. Each line opens what it sums up |

**Views.** Four tabs, each with its own anchor, so a link can open one: `#changes`, `#pipeline`,
`#people` and `#record`. An anchor naming a part, a file or a stage (`#part-3`, `#part-3-file-1`,
`#stage-review`) opens its view and every fold that holds it.

| View | Content |
|---|---|
| Changes | The contract change first: each signature and stored data shape before and after as a diff, the retiring symbols with their replacements, the incompatible and behaviour entries Penguin sorted, and the callers on main. Then each place the plan fixes: its number and place, owner, state (an approved part names its approver: Approved by Penguin, or the person) and file count; its kind, revision and rounds; a fix written into another fork with its writer and commit; the latest requested change; each file as a unified diff with both sides' line numbers, cut at 80 lines with a button for the rest; and its breaks, invariants and uses behind a line that counts them. Last, the declared area: contracts, paths and latest checkpoint |
| Pipeline | Each stage with its status and count, then its jobs: each job's status, label and one fact, with a link to its diff or its results. A failed or person-needed job shows its failing targets or its reviewing agent. A check job lists the findings its passing targets still name, such as the dependency diff's changed library and each place the target imports it. A run the check runner stopped at the failure limit is a failed job with its last reason. The current stage lists each checkpoint the feature's agents reported with the checks run on it. What a stage's jobs ran sits under it: the plan's facts with the tool or read behind each under Plan, the review forms with their side-by-side runs under Review, the newest `check` run's results by tool under Block checks (the failing targets with their findings, each passing target whose check names findings, a count of the rest and one next step per failing check), and each agent tool call under the stage it served |
| People | Read by: one row per running feature that reads what this feature changes, the one whose part needs a person first, then by stage. Its columns are the feature, its person as a pill, the reading scope and the scope it reads as pills in their owners' hues, the reader's current stage and this plan's part for it, which opens the part's diff. Start: one row per running feature whose person approves this feature's start, with its person, the lock (waiting or approved) and who approved it. Agents: the agents whose sessions joined the feature. Each table scrolls inside itself on a phone |
| Record | Each signed record with its type, author, time and path in the record repo, filtered by kind. An expand checkpoint promoted on its own shows as its own `Expand promoted` record after its `Expand requested` record. The contract step shows as `Contract step approved` when Penguin approves removing a retiring symbol with no caller left, `Contract step withdrawn` when a caller comes back and `Symbols removed` once the block that removes it reaches main |

**Rows.** Every fold starts closed except what needs the viewer: a part the viewer decides that
waits on them, with its files when it has two or fewer, and, for the feature's person, each stage
that needs a person or failed. A fold's body renders only while it is open.

Each deterministic tool shows by name beside its output, as [demo-story.md](demo-story.md#tools-on-screen)
asks. A part's changed lines go only to the feature's person, the part's owner and that owner's
delegate; anyone else sees the part's place, state and facts.

## Agent card

`/identities?identity=<id>` opens an identity's card in the centre, beside the list of every identity
(`identities-page.tsx`). Penguin holds no session's conversation, so the card shows Penguin's facts
only:

| Tab | Content |
|---|---|
| Overview | The issue it holds and what that waits on, other issues it holds, its last reported checkpoint, its recent operations and each registered session with vendor, branch, worktree id, last heartbeat and current issue |
| Charter | Its job, the scopes it works in with each scope's test command, its paths and its rules |
| Issue history | The issues it was assigned or wrote to, most recent first |

Edit and Duplicate show only on the signed-in person's own identities, or on a team identity they
serve.

### Identities

Create, Edit and Duplicate open a form in the centre:

| Field | Rule |
|---|---|
| Handle | `@<your id>/<name>`, lowercase letters and digits joined by hyphens; must be free |
| Name | Up to 80 characters |
| Avatar | PNG, JPEG, GIF or WebP up to 64 KiB, stored in the ProjectAgent's SQLite; SVG is refused |
| Team identity | Shared with up to 16 other owners, each of whom may edit it |
| Auto-accept assignments | Takes each assignment without the owner accepting it |
| Job | What the identity works on, up to 1,000 characters |
| Works in | Scopes from the scope map that the owner holds |
| Paths and rules | Up to 64 path prefixes and 32 rules |

Duplicate copies the charter under a new handle; the issue history stays with the original. A scope's
test command shows read-only: owners change it in `penguin/scopes.json`.

No route or control accepts an assignment for an identity without Auto-accept yet, so such an identity
receives no assigned work ([huddle-flow.md](huddle-flow.md#5-fix-delivery-at-safe-checkpoints)).

## Inbox

The inbox page holds the approvals that wait on the signed-in person (`approvals.tsx`, read from
`GET /api/overlaps` and `GET /api/plan-parts`), each a card with the facts behind it:

| Group | Holds | Controls |
|---|---|---|
| Overlapping starts | Each feature whose start waits beside one of the person's running features, its person and the scopes, contracts and paths where the two areas meet. An expand checkpoint that adds to the person's scopes shows here too, with the scopes and paths it adds to ([design.md](design.md#expand-in-the-build)) | Approve start, `POST /api/overlaps/approve`; for an expand, Approve addition with `feature` set to `owner:<person>` |
| Plans | One card per merge plan with parts for the person: the originating feature and person, why the plan needs the person in person, each review the parts carry and then each of the person's parts. A part Penguin approved for the person is listed too, until its block reaches main | Per part waiting on the person: Approve revision, `POST /api/plan-parts/approve`; Request change, which opens a field whose text posts `POST /api/plan-parts/request-change`. Per part Penguin approved: Reverse approval, `POST /api/plan-parts/reverse` |
| Protected paths | Each feature whose own change, since its merge base with main, writes a path the person protects in `penguin/scopes.json`: the feature and its person, the checkpoint, each protected path and the changed lines of each file under it | Confirm lines, `POST /api/plan-parts/confirm-protected` with `{ feature, owner, checkpoint }`. A confirmed card stays, marked Confirmed, until a later checkpoint changes the lines |
| Review exceptions | Each review of the person's scopes whose record raised an exception | None |
| Returned plans | Each plan of the person's returned over the break limit, with the places of its parts that need a person | None |

A plan card shows each review and each reason once, however many of its parts carry them
(`planGroups` in `feature-view.ts`). The parts follow one per row: the part number and place, the
kind, the revision and the rounds, then the part's state. A part the person approves carries its
decision at the end of that row. A part that writes a path the person protects reads Protected path.
A part of the person's own plan past the round limit reads Past the round limit. Neither carries
controls. A part Penguin approved reads Approved by Penguin in the verified colour, with Reverse
approval at the end of its row and the line "You may reverse it until the block reaches main". A
reversal sends the part back to the person, who then approves it or asks for a change. The reasons
a plan needs the person list every check Penguin found not clean, one line each, such as "No run has
tested the fix", "invoicing tests fail on the merged tree with 2 breaks" or "No review yet for tax".
The inbox reads the routing from `GET /api/plan-parts` alone, with no further request per part. The latest requested change follows as a quote. The tests that break in the place and the
fix's changed lines open from a line that counts them, such as "4 breaks, 3 changed files". A review
exception whose review a plan card already shows lists its exceptions with a link to that review.

A feature cannot land while a Protected paths card of its own waits. The card lists for the person
who protects the path and for their delegate; its lines follow the plan patches' rule, so only the
feature's person, the protecting person and that person's delegate read them. The approvals count
leaves out a confirmed card.

A review shows the form row by row: each invariant's statement, the verdict and the evidence, the
stored data marker, Penguin's refusals and the exceptions it raised. Beside the form, in a centre
900px wide or more, the side-by-side run names its tool and command ID. It counts the inputs that
differ between main and the fork. A set with more than three differing inputs summarises them:

- the count, such as "1,633 of 5,000 differ";
- when every differing input holds a list at the same place in its arguments, how many differ at
  each length of that list, named by the list's key (`lines` for the money fixture's orders);
- three examples with their outcome on each side;
- a button, "All 1,633 differing inputs", that opens the full table from
  `GET /api/reviews/<id>/differences`, 100 rows a page with Previous and Next.

A set of three or fewer differing inputs lists them all. The full table gives each input's name, its
list's length and its outcome on each side, with no arguments. Any signed-in person may read it, as
the feature page shows every review. The ProjectAgent counts the breakdown over every differing input
(`sideBySideBreakdown` in `services/project-agent/src/review-view.ts`), while the plan parts answer
carries five examples per set.

Request change puts its field in focus; Escape or Cancel closes it and returns focus to Request
change. While a decision sends, its button keeps focus and reads Approving or Sending. The server
names the approver and the decider from the session
([design.md](design.md#advance-notice-in-the-build)).

### Issue items

From 760px an issue page shows the person's issue items in the sidebar. They stay there from one
open issue to the next. The rows fall in five groups (`inbox-page.tsx`, `inbox-view.ts`):

| Group | Holds |
|---|---|
| Review requests | Fixes whose combined tests pass and whose review counts from this person |
| Assignments | Issues assigned to the person or an identity they answer for; requests to start a session of one |
| Mentions | Mentions of the person or an identity they own |
| Threads | Issues with a thread that needs the person |
| Closed issues | Issues that closed while the person had an item for them; the newest 10, or all with `?closed=all` on the issue's path |

A row shows what the item waits on the person for: "Waiting for your review", "Waiting for your
reply", "Waiting for you to start a session" or "Waiting for your acceptance". A dot marks an unread
item; pressing the dot marks it read, in every browser the person has open. The person who did
something gets no item for it. An item is keyed by person, issue and reason, so a later event of the
same reason marks it unread again (`services/project-agent/src/inbox-store.ts`).

## Agent labels

Every surface outside the agent card names an agent the same way, through `AgentLabel` in
`agent-label.tsx`: the agent's name, the part of its handle after `@<owner>/` (`merge-rules` for
`@priya/merge-rules`), beside its character, then its person. A 2px ring in the person's hue circles
the character, so two people's agents with the same name read apart. The full label puts the person
on a second line; the compact label, on team view rows and tool runs, puts it after the name. The
full handle, the vendor and the branch appear only on the agent card.

## Issue page

The centre holds the issue's activity in apply order (`issue-thread.tsx`):

- Needs you, at the top, linking to each open thread that needs the viewer and each fix waiting for
  the viewer's review;
- the description;
- comments with their author's byline, the viewer's own in ink;
- Penguin's alerts (state changes, comments, threads, mentions) as centred system lines;
- Penguin's bookkeeping (labels, assignments, sub-issue links) as compact lines;
- evidence cards for checks: the result, who attached it, the test, the revision it ran on and, for a
  failure a sub-issue fixed, that fix;
- approval cards for each fix: its status, the owners whose review counts and, while the viewer's
  review is pending, Approve and Request changes, which asks for a reason;
- thread cards with their replies, a reply box and Resolve;
- rejected operations, struck through with their reason;
- the comment composer.

The details panel holds Penguin's state for the issue, the labels, the assignees with their sessions
and controls to assign an identity or unassign anyone, a summary of current and superseded checks,
the sub-issues with their reviews, the close-out (how it closed and its approved branch, or what a
Huddle still waits on), the trigger and the linked commits. On a phone an Activity and Details switch
moves between the two.

The header shows one line, such as "2 updates waiting for the Git log", for operations the runner has
not pushed within one runner interval ([issues.md](issues.md#pending-push)). The page shows no diff;
another owner's unfinished work appears only as linked commits and checks.

### New issue

`/issues/new` takes a title, a body and the identities to assign. Create sends a `create` operation,
then one `assign` per identity, then opens the new issue.

## Live updates

The team view, a feature page and the approvals read their answers again on every live message the
person's connection receives and after a reconnect. The ProjectAgent sends an inbox-changed message
to the people a decision, an overlap or a review exception concerns. It also sends a features-changed
message to every connection after a write that may change a feature, its merge plan, a part's
decision, a fix write or a review. Those writes are a feature's opening, area and checkpoints; an
overlap approval; a plan proposal and its facts run; a part's approval, change request and revision;
a fix write; a review's submission and the runner's record of it; a land request, a landing and a
failed land run. Every open team view then shows the new state, including the views of people the
change does not concern. A feature page's timeline, jobs and branches come from the same answer it
reads again, so they move with no reload and no request per job. The ProjectAgent's live feed sends one
such message per task, however many writes the task made (`services/project-agent/src/live-feed.ts`).

The dashboard opens a WebSocket at `/api/live` (`use-live.ts`). The Worker accepts it only with a
valid session cookie and forwards it to the ProjectAgent with the person's owner id. The agent sends a
message naming changed issues and identities whose sessions went online or offline, an inbox-changed
message to one person's own connections, an identities-changed message or a features-changed
message. The message carries no
issue data: each page reads what it shows again through the API, which checks the session. The
account menu shows whether the connection is live.

Rows a live change adds slide in, staggered; boxes whose order changes slide to their new place.
Nothing moves on first paint, a route change or a theme switch. Every animation has a reduced-motion
path with none (`motion.tsx`, `arrivals.ts`).

## Person colours and characters

People and agents look different at a glance (`character.ts`, `avatar.tsx`):

- A person shows a round initial in their hue. The eight person hues (lime, jade, sky, blue, violet,
  purple, magenta, pink) are assigned per team. Owner ids are taken in sorted order; each takes the
  hue its id hashes to, or the next free hue on a clash. A team of up to eight never shares a
  hue. The hues sit apart from the red, amber and orange used for status.
- An agent identity shows its uploaded avatar, or else a character derived from its handle: the
  FNV-1a hash of the handle picks one of eight body shapes, one of eight hues and one of three eye
  poses. Nothing is stored, so a new or duplicated identity gets its own character on every device.
  The session's vendor never changes it.

## Security

Every dashboard response carries a Content Security Policy that allows scripts, styles, fonts and
connections from the Worker's own origin only, with no inline script. Fonts (Inter and Piazzolla) are
self-hosted. Every value from an issue, identity, record, commit, docstring, review form or person renders as
React text, so markup in a title, body, name or handle shows as text and runs nothing. Each API route
answers only as the session's person. The approvals list only that person's items. A feature page
and `GET /api/features/<id>/plan` send a part's changed lines and patch only to the people they
concern: the feature's person, the part's owner and that owner's delegate. No route returns an agent's
session transcript; Penguin holds none.

## Local preview

`node scripts/preview/dashboard.ts [--example identity-unification|helpful-fix|money-minor-units] [--port <port>] [--as <owner>]`
serves the built dashboard (`npm run build -w @penguin/dashboard`) on the Worker's own routes over a
project seeded from one fixture under `examples/` (`scripts/preview/seed.ts`). The seed builds the
fixture's repository with its own `build.py` and goes through the modules the ProjectAgent calls:
identities from `penguin/identities.json`, each feature opened by its agent with its declared area
and overlap check, each checkpoint, `whats_near`, `impact` and `check` run by the check runner's
programs, the merge plan with a real facts run, each review with the review harness, Penguin's
approval of each part whose checks are clean and each person's decision on the rest. A request signs in as the owner its `X-Preview-Owner` header names, or as the
`--as` owner, or as the originating person; `/preview/as/<owner>` switches a browser's seat.

On identity unification the plan is stored with four parts: Priya's fix commits for analytics' and
messaging's code on main, and the patches for Jun's and Sam's forks. Jun's and Sam's agents submit
the fixture's review forms from `examples/identity-unification/reviews/`. Each part's trial runs the
forms on its trial tree ([design.md](design.md#part-trials)). Penguin approves none of the four.
Sam's review is refused on both of Sam's trial trees with `stored_data_without_marker`: messaging
reads the reshaped `Profile` and Sam's form names no marker. Sam approves both of Sam's parts. Jun's
form names the cutover marker of Jun's fork; it is accepted on the trial of Jun's own part and
refused with `evidence_not_found` on the analytics part on main. The tablet invariant reaches Jun, so
Jun's two parts wait on Jun. On the helpful fix Priya's agent proposes the plan at the checkpoint
that adds `start_of_local_day`, and the plan holds the patches for Jun's weekly report and Sam's
reminders. Each feature's tests pass on its trial tree and both reviews hold, with no difference on
the 2 recorded examples each fork declares. Penguin approves both parts, and Jun and Sam each get a
`penguin_approved` item. On money in minor units the one-block plan is returned
over the default break limit of 10 and stays in Ines's inbox. The seed then runs the seven waves of
[case-study-money.md](case-study-money.md): each wave opens from main as the wave before left it. The
seed approves each overlapping start. Lena's and Mei's agents submit the fixture's forms for
promotions and invoicing, and Penguin approves both stored parts
([case-study-money.md](case-study-money.md#what-it-took)). The seed then moves main to the
wave's head. Rahul's tax review raises the broken `tax-per-line` invariant on the tax wave's first
checkpoint and holds on its revision. The contract wave's plan is returned with 24 parts needing a person
and stays in Ines's inbox beside the one-block plan.
