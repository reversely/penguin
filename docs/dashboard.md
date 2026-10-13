# Dashboard

The dashboard is where people on the team see who is working on what and what waits on them. Its
pages follow the hierarchy of PRD 0.5: org, team, person, feature, part, file. The team page is an
engineering manager's home: each member's features by stage, their agents and what waits on them,
then the scopes the team owns. The approvals inbox
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
| `/` | The signed-in person's team page; the org page for a person in no team |
| `/org` | The org page |
| `/review-policy` | The sandbox's review policy ([review-policies.md](review-policies.md)) |
| `/teams/<id>` | One team's page; a one-person team's id is `person:<id>` |
| `/people/<id>`, `/?person=<id>` | One person's page |
| `/features/<id>` | One feature's page |
| `/inbox` | The signed-in person's approvals |
| `/identities`, `/identities?identity=<id>` | Every identity, with the chosen one's agent card |
| `/issues/<number or temporary ID>`, `?closed=all` | One issue, beside the person's issue items |
| `/issues/new` | The New issue form |
| `/board` | Redirects to `/` |

The shell has three panes: a sidebar with the navigation (Org, Team, Inbox with the count of approvals
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

## Org, team and person pages

Every page opens under a breadcrumb that follows the hierarchy: Org, the team, the person, the
feature, then the part and the file a feature page's anchor opened. A person's pages sit under the
first declared team they lead, else the first they belong to, else their one-person team. The three
pages read `GET /api/team` once through the shell, which every page shares for the person hues; the
person page also reads `GET /api/people/<id>/scopes`. The ProjectAgent builds both answers
(`services/project-agent/src/dashboard-views.ts`). Every signed-in person may read every team as
counts and states. No page carries a part's changed lines.

A page shows counts, the top few items as pills and tables. A list of every feature or every waiting
item belongs to the level below. Only exceptions are highlighted: a stage needing a person, what
waits on a person and a scope that is not clean take the attention colour. A table row holding one
takes an attention edge. On a phone each row of the org, Members and Scopes tables stacks into a
block under its name, with each cell beside its column's name.

Each feature counts at its current stage of its pipeline
([design.md](design.md#the-merge-as-a-pipeline-in-the-build)). A feature whose current stage needs a
person or failed, or that carries an exception, counts in its own stage pill in the attention colour,
apart from the same stage's running features. A feature that needs no plan counts under Building
until its agent asks to land: its own changes reach no one else, so the facts run of its latest
checkpoint shows no place, or that run has not reported yet. Its strip reads Building too. A feature
whose facts show a place and no stored plan counts under Plan. A feature reaches its last stage once
its block was checked. Until main moves to its checkpoint it counts under Promotion. Its strip reads
Promotion too. A feature whose block reached main counts under On main.
A block Penguin closed with nothing left to carry counts under Closed. Pills order the stages
needing a person first, then Open, Building and the rest of the pipeline's order, then On main and Closed. A pill of one feature
opens that feature; a pill of several opens the level that lists them.

### Org page

`/org` (`org-page.tsx`) opens with the How Penguin validates panel ([How Penguin validates](#how-penguin-validates)),
then holds one row per team, declared teams first:

| Column | Holds |
|---|---|
| Team | The team's name, linking to its page, with its count of people |
| Lead | The team's lead as a pill |
| Features by stage | The members' features as stage pills with counts. A person in two teams counts in each |
| Waiting | How many items wait on the team's members, linking to the team page |
| Health | How many of the team's scopes are clean, such as `27 of 29 scopes clean` |

Below the teams, Review policy names the sandbox's policy, such as `Central development policy`, with `Locked by admin
mode` while `PENGUIN_PLAN_ADMIN_MODE` is on and a Settings link to `/review-policy`. Its table holds
the approvals of the last 30 days by route: one row for every approval, then one per type of approval
that sent the part there. Each row counts Penguin automatically, Person in the dashboard and Penguin's
share as a percent.

### Team page

`/` opens the signed-in person's own team; `/teams/<id>` opens any team (`team-page.tsx`). Under the
team's name and its lead, the Members table holds the lead first, then each member in the order
`penguin/teams.json` lists them:

| Column | Holds |
|---|---|
| Person | The member as a pill, linking to their page |
| Features by stage | The member's features as stage pills. Under a pill, the count of open edit tasks routed to those features' builders, such as `2 tasks 1 asked` |
| Agents | The member's steward with its own queue: `1 of 2 running` against the person's cap, then `3 queued` and `1 asked` (in the attention colour) when any. The queue counts only the tasks routed to the steward. Then the count of builders on features that have not reached main, linking to the person page |
| Waiting on them | Every item waiting on the member, linking to their page, then the two features holding the most as pills with their counts, then a link such as `2 more` |

What waits on a person is each plan part routed to them that waits or passed the round limit, each
custom path rule confirmation they owe, each edit task they are asked about and each expand
addition they approve.

The Scopes table holds every scope the team owns, those not clean first:

| Column | Holds |
|---|---|
| Scope | The scope's name, with its id on hover |
| DRI | The scope's DRI as a pill, linking to their page |
| Reads | How many other scopes it reads, in the code at main's last promotion or declared in `depends_on` |
| Read by | How many other scopes read it |
| Health | `2 waiting` for the items in the scope waiting on a person, `1 not in code` for declared dependencies the code no longer shows, else Clean |

The items waiting in a scope are its plan parts waiting on a person, its edit tasks a person is asked
about and each running feature whose newest review of the scope raised an exception.

The team page also opens with the How Penguin validates panel and ends with the Review policy table
of the org page, counting only the parts and starts the team's members own.

### Review policy

`/review-policy` (`review-policy.tsx`) is the settings view of the sandbox's review policy
([review-policies.md](review-policies.md)), read from `GET /api/review-policy`. It shows who changed
the policy last and when, or `Central development by default`; `Admin mode sends every part to a
person` while admin mode locks it; Stage, the release pipeline in one row; and Types of approval, one
row per type with its kind, what sends a part to a person and a Penguin or Person choice.

Stage draws the pipeline left to right with the feature timeline's bar and stage nodes: Local
development, Central development, Test, Pre-production, Production. The stage the policy names is
marked as the current one, with its dot ringed and its name in the heading weight. Under each stage a
label says what it sends to a person:

| Stage | Label |
|---|---|
| Local development | Penguin decides every part |
| Central development | Person decides flagged parts |
| Test | Same setting as Pre-production |
| Pre-production | Person decides flagged parts and migration differences |
| Production | Person decides every part |

Test shares Pre-production's setting, so choosing Pre-production marks both. Each other stage is a
radio choice for a team lead. Below 39rem of width the row wraps, one dot and name per line.

A team lead in `penguin/teams.json` changes the stage or single rows
and saves with Save policy, `POST /api/review-policy`. Anyone else sees the same view with every
choice disabled and `Please ask a team lead to change the policy`. Last, the approvals of the last
30 days by route, as on the org page.

### How Penguin validates

A folded panel on the org, team, feature, inbox and review policy pages lists the six kinds of
validation ([validation.md](validation.md)): each kind, what it checks in one line and who decides it
under the sandbox's policy, such as `Person`, `Penguin` or, when the policy's two rows of Custom path
rules and place differ, `Custom path rules: Person` and `Place: Penguin`. Overlapping starts reads
`Penguin` and `Owner told` at every stage. Its summary names the policy by its stage, such as
`Central development policy`. Outside the review policy page the open panel starts with the release
pipeline row, read-only, with that stage marked. It links to `/review-policy`.

### Kinds and routes on results

Every check result names its kind of validation with a data tag: each job under Review (Logic), each
block check job and each check group under Block checks (Tests, or Overlapping starts for the
`overlap` check), each start (Overlapping starts), each review form (Logic), its side-by-side run
(Data matching) and its migration or backfill marker (Stored data). Each reason a plan card lists
starts with its kind, such as `Data matching: 2 inputs of daily_active_users differ`. Each record in
the Record view carries the kinds its result belongs to.

Every decision and every write names its route:

| Route | How it reads |
|---|---|
| Agent through MCP | The agent's identity and tool, such as `by @priya/accounts-merge (MCP report_fix_write)` on a written fix and `@priya/accounts-merge (MCP propose_plan)` in the Record view |
| Penguin automatically | The policy and the kinds checked, such as `Approved by Penguin (Central development policy: Tests, Logic, Data matching, Stored data and Custom path rules and place clean)`. A fix the check runner wrote reads `by Penguin (check runner)` |
| Person in the dashboard | The person and the dashboard, such as `Approved by jun in the dashboard` |

A part still waiting names whom it waits for and the policy's rule, such as `Waiting for jun: Logic
and Data matching are set to person`. The Record view reads each record's route from its author:
`{ identity }` is an agent through MCP, `{ penguin: true }` is Penguin automatically and `{ person }`
is a person in the dashboard.

### Person page

`/people/<id>` (`person-page.tsx`) shows, in order:

- **Waiting:** one row per feature holding items that wait on the person, most first, with a tag per
  kind such as `3 parts` or `1 start`. Each row opens the feature.
- **Features:** Needs a person, then In progress, each feature with its timeline strip, its
  exceptions, its agents and its builders' open tasks. The features on main fold behind On main
  with their count. Closed blocks fold behind Closed. They list no agents: their builders have
  finished.
- **Scopes:** the role tables below.
- **Agents:** the person's steward with its own queue, then On no feature: the idle stewards and the
  builders of paused features. A builder of a feature on main leaves every agent list.
- **Issues:** every issue that involves the person, open issues first. Each row carries why it is
  there: Assigned, Review, Reply or Session to start.

The role reads `GET /api/people/<id>/scopes` once and again on every live message. A line names the
main commit the dependencies were read from (`Read from main at <commit>`), or says that Reads show
declared dependencies until the next promotion of main. A search field (scope, scope id, DRI or team)
and the source filters (All, Derived, Declared, Not in code, each with its count) narrow the tables;
the source filters leave Owns whole. Owns (the scopes the person is DRI for), Reads and Read by each
get a table:

| Column | Holds |
|---|---|
| Scope | The scope's name. For Reads and Read by it also names the person's own scopes the dependency runs through (`via`), when the table's rows run through more than one of them |
| DRI | The scope's DRI as a pill, linking to their page, with the owning team's name for a declared team |
| Call sites | Call sites over the dependency's edges; for Owns, other people's calls into the scope |
| Source | Derived, Declared, or both; a declared dependency with no use in the code adds Not in code in the attention colour. Owns reads Declared |
| Updated | The main commit at which the row's counts last changed, with the time on hover, shown only where it differs from the commit the page reads main at. A table whose every row matches that commit leaves the column out |

A table opens ranked by call sites. Each column header sorts by that column and a second click
reverses it. Each table scrolls inside itself on a phone.

### Feature states and exceptions

Each feature in `GET /api/team` also carries a one-word state, which comes from facts Penguin holds,
the latest step first:

| State | When |
|---|---|
| promoting | Every part of the feature's merge plan is approved, or its block run is being checked or moving main (`land_feature`) |
| waiting on approvals | A plan part waits for its author, or a start waits on a lock opened before #177 |
| planning | The facts run of its latest checkpoint shows a place its change reaches and no plan is stored, or a plan is stored and a newer checkpoint's facts run waits or found no plan parts, or the plan was returned over the break limit, or a part waits on the agent's revision |
| building | Anything else, including a feature whose facts run shows no place or still waits for the runner while no plan is stored |
| promoted | Main moved to the feature's checkpoint; its fork is read-only |
| closed | A block feature Penguin opened was left with no part to carry and closed; nothing landed and its fork is read-only ([design.md](design.md#migration-plans-in-the-build)) |

On the person page a feature carries each exception PRD
section 7 routes to a person as a line in the attention colour, with an attention edge on its row.
The exceptions are a part past the round limit, a plan returned over the break limit, a broken
invariant or a protected difference in the newest review of each scope. A run the check runner
stopped at the failure limit is the last kind. Its line reads "Block run stopped after 3 failures"; the
feature page shows the last reason on the run's failed job.

## Feature page

`/features/<id>` shows one feature, the unit of work (`feature-page.tsx`, read from one request,
`GET /api/features/<id>/page`). It has three levels.

**Header.** It stays at the top of every view:

| Part | Content |
|---|---|
| Breadcrumb | Org, the person's team, the feature's person, the feature, then the part and the file an anchor or a link opened. The part reads its number and place, such as `#3 tax`; the file reads its name. Each opens its fold on the page |
| Title | The feature's name, its person as a pill in the person's hue and its scopes as pills in their owners' hues |
| Timeline bar | One node per stage of the feature's pipeline ([design.md](design.md#the-merge-as-a-pipeline-in-the-build)): split features run Open, Expand, Migrate, Contract and Done; the rest run Open, Plan, Review, Fixes written, Block checks and Promoted. Each node shows its status as a dot and its count of passed jobs, such as `2 of 4`, with Needs a person or Failed when a job is. The current stage is ringed. A node opens its stage in the Pipeline view |
| Branches | One line per person per stage holds the work that reached the person and has not settled. That work is their parts, starts and confirmations plus the open edit tasks the feature raised ([design.md](design.md#edit-tasks-in-the-build)). The line shows the person's agent, the count by kind (such as `2 parts 1 task`) and the most urgent tag. It shows the person instead when no agent or several agents took the work. A part, start or confirmation is tagged sent, reviewing, waiting (its fix waits for its turn on the fork), fix written, approved or needs a person; a task is tagged running, queued, waiting (its write waits for its turn on the fork) or asked. Opening the line lists each item with its tag and its part's number and place, which opens its diff, or the task's kind and place, such as `Review form analytics`. An item names its agent when the items' agents differ. A task names `builder` when a builder took it. A line of one item shows the item itself and opens to its fact: the job's fact, why the task's person is asked or how its run ended. Within a stage, lines needing a person (needs a person, asked) come first, then running lines (reviewing, running), then waiting lines (sent, waiting, queued); the latest stage's lines come first. On a plan a task hangs from Review (a review form), Fixes written (a fix) or Block checks (a next step); on a split a contract step hangs from Contract and any other task from Migrate. A task another feature raised in this feature's fork hangs from that feature's timeline. Another feature's fix waiting for its turn on this feature's fork hangs from the current stage under that feature's person, tagged waiting. A settled branch has rejoined the bar as the person's avatar under its stage. Six lines show before a button counts the rest |
| Summary | At most three lines: the contract change with its counts of changes, breaking signatures and incompatible entries; how many features and people the feature reaches; the first place needing a person, else the first failed job. Each line opens what it sums up |

**Views.** Four tabs, each with its own anchor, so a link can open one: `#changes`, `#pipeline`,
`#people` and `#record`. An anchor naming a part, a file or a stage (`#part-3`, `#part-3-file-1`,
`#stage-review`) opens its view and every fold that holds it.

| View | Content |
|---|---|
| Changes | The contract change first: each signature and stored data shape before and after as a diff, the retiring symbols with their replacements and, for each, its own uses in its defining module and its scope's tests, which the contract step removes with it, the incompatible and behaviour entries Penguin sorted, and the callers on main. Then each place the plan fixes: its number and place, owner, state with its route ([Kinds and routes on results](#kinds-and-routes-on-results)) and file count; its kind, revision and rounds; a fix written into another fork with its writer and commit; the latest requested change; each file as a unified diff with both sides' line numbers, cut at 80 lines with a button for the rest; and its breaks, invariants and uses behind a line that counts them. Last, the declared area: contracts, paths and latest checkpoint |
| Pipeline | Each stage with its status and count, then its jobs: each job's status, label and one fact, with a link to its diff or its results. A failed or person-needed job shows its failing targets or its reviewing agent. Block checks has one check job per check kind. Once the block run a `land` asked for has reported, those jobs come from that run's checks in its signed `block_checked` record, so a promoted feature shows the run that gated its land. Before then they come from the newest `check` run. A block run never has a `retiring` job, since that check runs only on a checkpoint's own changes. A check job from a `check` run lists the findings its passing targets still name, such as the dependency diff's changed library and each place the target imports it; the `block_checked` record keeps no findings. A run the check runner stopped at the failure limit is a failed job with its last reason. The current stage lists each checkpoint the feature's agents reported with the checks run on it. What a stage's jobs ran sits under it: the plan's facts with the tool or read behind each under Plan, the review forms with their side-by-side runs under Review, the newest `check` run's results by tool under Block checks (the failing targets with their findings, each passing target whose check names findings, a count of the rest and one next step per failing check), and each agent tool call under the stage it served |
| People | Read by: one row per running feature that reads what this feature changes, the one whose part needs a person first, then by stage. Its columns are the feature, its person as a pill, the reading scope and the scope it reads as pills in their owners' hues, the reader's current stage and this plan's part for it, which opens the part's diff. Start: one row per running feature this feature's start overlaps, with its person, the lock (approved, or waiting on a lock opened before #177) and who approved it, `Penguin` for a start since #177. Agents: the agents whose sessions joined the feature. Each table scrolls inside itself on a phone |
| Record | Each signed record with its type, its route (an agent with its MCP tool, Penguin automatically or a person in the dashboard), the kinds of validation its result belongs to, time and path in the record repo, filtered by type. Once a record is in the record repo its path links to `GET /api/features/<id>/records/<record id>`, which answers the signed file as the repo holds it at the commit that added it. A record still waiting for its push shows its path as plain text. An expand checkpoint promoted on its own shows as its own `Expand promoted` record after its `Expand requested` record. The contract step shows as `Contract step approved` when Penguin approves removing a retiring symbol with no caller left, `Contract step withdrawn` when a caller comes back and `Symbols removed` once the block that removes it reaches main. A feature Penguin opened that main moved past shows `Rebuilt from main` when Penguin forks it again from main and re-applies its parts |

**Rows.** Every fold starts closed except what needs the viewer: a part the viewer decides that
waits on them, with its files when it has two or fewer, and, for the feature's person, each stage
that needs a person or failed. A fold's body renders only while it is open.

Each deterministic tool shows by name beside its output, as [demo-story.md](demo-story.md#tools-on-screen)
asks. A part's changed lines go only to the feature's person, the part's owner and that owner's
delegate; anyone else sees the part's place, state and facts.

The page answer carries the first 80 diff lines of each file (`FEATURE_PAGE_LIMITS.fileLines`) with
the count of the rest and each file's added and removed lines. Expanding a cut file reads its whole
diff once from `GET /api/features/<id>/plan`, which applies the same line rule; the page makes no
other request.

### Change page

A feature opened by someone other than its person is that person's change page (`change-tree.tsx`,
`banner-view.ts`). Under the header, a line per thing the viewer must do: decide each of their parts
that waits on them or confirm their custom path rule lines. Each line opens the part it
concerns, with a link to the inbox where they act. The Changes view then reads, in order:

| Section | Content |
|---|---|
| Main change | The contract change, open from the start |
| Your changes | The viewer's running features that read what the feature changes, each with the reading scope and the scope it reads as pills; then each of the viewer's places, grouped by scope, with its state and approver; each file lists the changed contract symbols its lines use above its diff |
| Other places | The other places, folded, with their state and no lines |

Pipeline, People and Record hold the rest: the block checks and jobs, the review forms with their
side-by-side runs, the Read by and Start tables and the record. A viewer sees the contract change and
their own places' lines only.

## Banners

The top of every page shows one line per colleague's feature that reaches the signed-in person
(`banner.tsx`): the colleague, the feature, linking to its change page, and the feature's current
stage. A banner that needs the person reads Your decision and links to the first part they decide. A
feature has a banner while the person's inbox holds an item of it: a part to decide or one Penguin
approved for them, a custom path rule confirmation or an overlapping start Penguin told them of. Only
a part to decide or a confirmation reads Your decision. The banner clears once the
inbox holds nothing of the feature or its block reaches main. The banners come from the answers the
shell already reads for the inbox count and the team answer, so they cost no request. The open
feature's own page shows no banner of it.

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
`GET /api/overlaps` and `GET /api/plan-parts`), each a card with the facts behind it. Each part's
number and place link to the feature's change page at that part (`/features/<id>#part-3`); a
custom path rule card links to its Changes view and a review exception to its review:

| Group | Holds | Controls |
|---|---|---|
| Overlapping starts | Each feature that started beside one of the person's running features, its person and the scopes, contracts and paths where the two areas meet, tagged Approved by Penguin. An expand checkpoint that adds to the person's scopes shows here too, with the scopes and paths it adds to ([design.md](design.md#expand-in-the-build)) | None for a start Penguin approved. For an expand, Approve addition, `POST /api/overlaps/approve` with `feature` set to `owner:<person>`. A start on a lock opened before #177 that still waits carries Approve start |
| Plans | One card per merge plan with parts for the person: the originating feature and person, why the plan needs the person in person, each review the parts carry and then each of the person's parts. A part Penguin approved for the person is listed too, until its block reaches main | Per part waiting on the person: Approve revision, `POST /api/plan-parts/approve`; Request change, which opens a field whose text posts `POST /api/plan-parts/request-change`. Per part Penguin approved: Reverse approval, `POST /api/plan-parts/reverse` |
| Custom path rules | Each feature whose own change, since its merge base with main, writes a path under one of the person's custom path rules (`custom_paths` in `penguin/scopes.json`): the feature and its person, the checkpoint, each custom path and the changed lines of each file under it | Confirm lines, `POST /api/plan-parts/confirm-protected` with `{ feature, owner, checkpoint }`. A confirmed card stays, marked Confirmed, until a later checkpoint changes the lines |
| Review exceptions | Each review of the person's scopes whose record raised an exception | None |
| Returned plans | Each plan of the person's returned over the break limit, with the places of its parts that need a person | None |

A plan card shows each review and each reason once, however many of its parts carry them
(`planGroups` in `feature-view.ts`). The parts follow one per row: the part number and place, the
kind, the revision and the rounds, then the part's state. A part the person approves carries its
decision at the end of that row. A part that writes a path under the person's custom path rule reads Custom path rule.
A part of the person's own plan past the round limit reads Past the round limit. Neither carries
controls. A part of the person's own plan can wait on them because their change reshapes stored
data the part's scope only reads. Its tag says Stored data needs a migration or backfill. It
carries Approve revision and no Request change, since the fix belongs in the person's own change. A part Penguin approved reads Approved by Penguin in the verified colour, with Reverse
approval at the end of its row and the line "You may reverse it until the block reaches main". A
reversal sends the part back to the person, who then approves it or asks for a change. The reasons
a plan needs the person list every check Penguin found not clean, one line each, such as "No run has
tested the fix", "invoicing tests fail on the merged tree with 2 breaks" or "No review yet for tax".
The inbox reads the routing from `GET /api/plan-parts` alone, with no further request per part. The latest requested change follows as a quote. The tests that break in the place and the
fix's changed lines open from a line that counts them, such as "4 breaks, 3 changed files". A review
exception whose review a plan card already shows lists its exceptions with a link to that review.

A feature cannot reach main while a Custom path rules card of its own waits. The card lists for the
person whose custom path rule covers the path and for their delegate; its lines follow the plan
patches' rule, so only the feature's person, that rule's person and that person's delegate read them. The approvals count
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

A row shows what the item waits on the person for as a bare label: Review, Reply, Session to start
or Acceptance. A dot marks an unread
item; pressing the dot marks it read, in every browser the person has open. The person who did
something gets no item for it. An item is keyed by person, issue and reason, so a later event of the
same reason marks it unread again (`services/project-agent/src/inbox-store.ts`).

## Agent labels

Every surface outside the agent card names an agent the same way, through `AgentLabel` in
`agent-label.tsx`: the agent's name, the part of its handle after `@<owner>/` (`merge-rules` for
`@priya/merge-rules`), beside its avatar, then its person. A 2px ring in the person's hue circles
the avatar, so two people's agents with the same name read apart. The full label puts the person
on a second line; the compact label, on table rows, feature rows and tool runs, puts it after the name. The
full handle, the vendor and the branch appear only on the agent card.

## Issue page

The centre holds the issue's activity in apply order (`issue-thread.tsx`):

- Your decisions, at the top, linking to each open thread that needs the viewer and each fix waiting for
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

The org, team and person pages, a feature page and the approvals read their answers again on every live message the
person's connection receives and after a reconnect. The ProjectAgent sends an inbox-changed message
to the people a decision, an overlap or a review exception concerns. It also sends a features-changed
message to every connection after a write that may change a feature, its merge plan, a part's
decision, a fix write or a review. Those writes are a feature's opening, area and checkpoints; an
overlap approval; a plan proposal and its facts run; a part's approval, change request and revision;
a fix write; a review's submission and the runner's record of it; a land request, a landing and a
failed land run. Every open org, team and person page then shows the new state, including the views of people the
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

## Person colours and avatars

People and agents look different at a glance (`person-hue.ts`, `penguin-face.ts`, `avatar.tsx`):

- A person shows a round initial in their hue. The eight person hues (lime, jade, sky, blue, violet,
  purple, magenta, pink) are assigned per team. Owner ids are taken in sorted order; each takes the
  hue its id hashes to, or the next free hue on a clash. A team of up to eight never shares a
  hue. The hues sit apart from the red, amber and orange used for status.
- An agent identity shows its uploaded avatar, or else a crop of Penguin's logo around the head in
  two colours: its owner's hue and white. A feature's builder shows the logo in the owner's hue on
  white. The owner's steward, `@<person>/steward`, shows the same crop inverted: a white logo on a
  disc of the owner's hue. The crop takes the logo's own path (viewBox `110 10 780 780`). A CSS circle
  clip trims it, so no SVG id repeats on a page. Nothing is stored, so a new or duplicated
  identity gets its avatar on every device. The session's vendor never changes it.
- Penguin's own mark, on its state indicator and its posts, is the full logo in ink.

## Copy

Every string the dashboard shows is a bare label, a count or one clause with no comma. Headings are
standard nouns such as Changes, Plans or Reviews. A field's hint names its field, such as "A handle
takes lowercase letters and digits joined by hyphens". An empty state names the next step, such as
the empty inbox's "Please open your team page to follow running features". A tag that asks the
person to act reads Your decision. `apps/dashboard/test/copy-style.test.ts` fails the build on any
banned word or pattern of the house style in a string literal, a template literal or JSX text under
`apps/dashboard/src`.

## Security

Every dashboard response carries a Content Security Policy that allows scripts, styles, fonts and
connections from the Worker's own origin only, with no inline script. Fonts (Inter and Piazzolla) are
self-hosted. Every value from an issue, identity, record, commit, docstring, review form or person renders as
React text, so markup in a title, body, name or handle shows as text and runs nothing. Each API route
answers only as the session's person. The approvals list only that person's items. A feature page
and `GET /api/features/<id>/plan` send a part's changed lines and patch only to the people they
concern: the feature's person, the part's owner and that owner's delegate. A role's dependencies in
`GET /api/team` and `GET /api/people/<id>/scopes` carry scope names and counts, never code. No route returns an agent's
session transcript; Penguin holds none.

## Local preview

`node scripts/preview/dashboard.ts [--example identity-unification|helpful-fix|money-minor-units] [--port <port>] [--as <owner>] [--step]`
serves the built dashboard (`npm run build -w @penguin/dashboard`) on the Worker's own routes over a
project seeded from one fixture under `examples/` (`scripts/preview/seed.ts`). The seed builds the
fixture's repository with its own `build.py` and goes through the modules the ProjectAgent calls:
identities from `penguin/identities.json`, each feature opened by its agent with its declared area
and overlap check, each checkpoint, `whats_near`, `impact` and `check` run by the check runner's
programs, the merge plan with a real facts run, each review with the review harness, Penguin's
approval of each part whose checks are clean and each person's decision on the rest. A request signs in as the owner its `X-Preview-Owner` header names, or as the
`--as` owner, or as the originating person; `/preview/as/<owner>` switches a browser's seat.

By default the seed runs to the end before the server listens. With `--step` the server listens as
soon as the project exists, before the first step, so a recording shows each step happen:

- `POST /preview/step` runs the next step and answers once it has run. After each step the preview
  sends every open dashboard the live feed's `penguin.inbox-changed` and `penguin.features-changed`
  messages. Each dashboard then reads its inbox and team view again.
- `GET /preview/steps` answers `{ steps, next, waitingFor, finished }`. `steps` lists the names of the
  steps run so far plus the next one. `next` is the index of the next one. The seed decides its steps
  as it runs, so the list ends at the next step.
- A step whose action is a person's decision waits for that person to make it on the dashboard. The
  decisions are a plan part's approval or change request and a confirmation of custom path rule
  lines. `POST /preview/step` answers with `waitingFor` naming the person and the decision's route:
  `/api/plan-parts/approve` or `/api/plan-parts/request-change`, or
  `/api/plan-parts/confirm-protected`. No step waits on a start: Penguin approves each overlapping
  start and tells the owner. Once that person's request succeeds, the seed continues.

On identity unification the plan is stored with four parts: Priya's fix commits for analytics' and
messaging's code on main, and the patches for Jun's and Sam's forks. Jun's and Sam's agents submit
the fixture's review forms from `examples/identity-unification/reviews/`. Each part's trial runs the
forms on its trial tree ([design.md](design.md#part-trials)). Penguin approves none of the four.
Sam's review is accepted on both of Sam's trial trees: messaging only reads the reshaped `Profile`,
which identity-map owns. Priya's change carries no migration or backfill for it, so both of Sam's
parts wait on Priya as `stored_data` asks in Priya's inbox. Sam is not asked. Jun's
form names the cutover marker of Jun's fork; it is accepted on the trial of Jun's own part and
refused with `evidence_not_found` on the analytics part on main. The tablet invariant reaches Jun, so
Jun's two parts wait on Jun. On the helpful fix Priya's agent proposes the plan at the checkpoint
that adds `start_of_local_day`, and the plan holds the patches for Jun's weekly report and Sam's
reminders. Each feature's tests pass on its trial tree and both reviews hold, with no difference on
the 2 recorded examples each fork declares. Penguin approves both parts, and Jun and Sam each get a
`penguin_approved` item. On money in minor units the seed runs Ines's split as
[case-study-money.md](case-study-money.md) tells it. Ines's start opens at once. Penguin tells
Hugo and Tomas. The expand
reaches main with a plan of no place. Penguin then proposes ten migration plans, one per owner.
Each reader's builder reports its migration. Each owner's steward writes the block Penguin
opened for that owner's code on main, and Penguin lands each block. Rahul's tax review raises the broken
`tax-per-line` invariant on the block's whole-order step and holds on its revision. Once no caller is
left, Ines's contract lands.
