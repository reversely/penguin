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
| `/inbox`, `/inbox?closed=all` | The signed-in person's approvals and issue inbox |
| `/identities`, `/identities?identity=<id>` | Every identity, with the chosen one's agent card |
| `/issues/<number or temporary ID>` | One issue |
| `/issues/new` | The New issue form |
| `/board` | Redirects to `/` |

The shell has three panes: a sidebar with the navigation (Team, Inbox with its unread count,
Identities), the page's list and the signed-in person's account menu; the centre; and a details panel
for the issue page. From 1100px the panel docks beside the centre; below that it opens as a drawer.
Below 760px the sidebar becomes a phone header.

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
- each of the person's features, newest first, linking to its page, with its one-word state and the
  agents whose sessions joined it;
- the person's agents on no feature.

A feature's state comes from facts Penguin holds, the latest step first:

| State | When |
|---|---|
| promoting | Every part of the feature's merge plan is approved |
| waiting on approvals | The feature's start waits for an overlap approval, or a plan part waits for its author |
| planning | Its agent proposed a plan and the check runner's facts run waits, or Penguin answered with what the plan lacks and no plan is stored, or the plan was returned over the break limit, or a part waits on the agent's revision |
| building | Anything else |
| promoted | Shown once block promotion records a promotion |

States take a neutral tag. Only exceptions are highlighted: a feature carries each exception PRD
section 7 routes to a person as a line in the attention colour, with an attention edge on its row.
The exceptions are a part past the round limit, a plan returned over the break limit and a broken
invariant or a protected difference in the newest review of each scope.

### Person view

`/?person=<id>` shows the person's role, their features as on the square, their agents on no feature
and every issue that involves them, open issues first. Each issue row carries why it is there:
Assigned, Review, Reply or Session to start.

## Feature page

`/features/<id>` shows one feature (`feature-page.tsx`, read from `GET /api/features/<id>/page`):

| Section | Content |
|---|---|
| Header | The feature id, its state, its person, its fork and its latest checkpoint |
| Declaration | Its scopes, contracts and paths; whose approval its start waits for or got; the running features that read what it changes |
| Agents | The agents whose sessions joined it |
| Merge plan | The change in plain words; each fact with the tool or read that produced it; the contract diff; the callers on main; each affected place as a part with its owner, kind, state and rounds. A part's breaks, invariants and changed lines open from a line that counts them |
| Reviews | Each review form with the check runner's verdict and side-by-side run |
| Fixes in other forks | Each part whose fix goes into a running feature's fork, with its approval state and its write: queued for the check runner, granted to the originating agent, or written with its commit ([design.md](design.md#steps-1-and-3-in-the-build)) |
| Block checks | The newest `check` run's results grouped by the tool that ran them, with its version and command ID: the failing targets with their findings, a count of the rest and one next step per failing check |
| Tool runs | Every agent tool call on the feature, newest first: the tool, its caller, its result and what it reported, such as the impact graph's changed symbols and the forks that use them |
| Record | Each signed record with its type, author, time and path in the record repo |

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
| Overlapping starts | Each feature whose start waits beside one of the person's running features, its person and the scopes, contracts and paths where the two areas meet | Approve start, `POST /api/overlaps/approve` |
| Plan parts | Each part that touches the person's code: the originating feature and person, the place, the kind and why, the revision and rounds, why it needs the person in person, the latest requested change, the tests that break in the place, the newest review of each scope it touches and the fix's changed lines | Approve revision, `POST /api/plan-parts/approve`; Request change, which opens a field whose text posts `POST /api/plan-parts/request-change` |
| Protected paths | Parts that write a path the person protects, with the same facts | None |
| Round limits | Parts of the person's own plans past the round limit | None |
| Review exceptions | Each review of the person's scopes whose record raised an exception | None |
| Returned plans | Each plan of the person's returned over the break limit, with its behavioural places | None |

A review shows the form row by row: each invariant's statement, the verdict and the evidence, the
stored data marker, Penguin's refusals and the exceptions it raised. Under it the side-by-side run
names its tool and command ID. It counts the inputs that differ between main and the fork. It lists
up to five differing inputs per set with their outcome on each side. Request change puts its field
in focus; Escape or Cancel closes it and returns focus to Request change. While a decision sends,
its button keeps focus and reads Approving or Sending. The server names the approver and the
decider from the session ([design.md](design.md#advance-notice-in-the-build)).

Below the approvals, from 760px, the issue inbox's rows sit in the sidebar and stay there while an
issue is open beside them. On a phone they follow the approvals under a strip of the person's own
identities. The rows fall in five groups (`inbox-page.tsx`, `inbox-view.ts`):

| Group | Holds |
|---|---|
| Review requests | Fixes whose combined tests pass and whose review counts from this person |
| Assignments | Issues assigned to the person or an identity they answer for; requests to start a session of one |
| Mentions | Mentions of the person or an identity they own |
| Threads | Issues with a thread that needs the person |
| Closed issues | Issues that closed while the person had an item for them; the newest 10, or all with `/inbox?closed=all` |

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
to the people a decision, an overlap or a review exception concerns, so another person's open team
view shows a feature's new state at their next live message.

The dashboard opens a WebSocket at `/api/live` (`use-live.ts`). The Worker accepts it only with a
valid session cookie and forwards it to the ProjectAgent with the person's owner id. The agent sends a
message naming changed issues and identities whose sessions went online or offline, an inbox-changed
message to one person's own connections, or an identities-changed message. The message carries no
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
sends a part's changed lines only to the people they concern. No route returns an agent's
session transcript; Penguin holds none.

## Local preview

`node scripts/preview/dashboard.ts [--example identity-unification|money-minor-units] [--port <port>] [--as <owner>]`
serves the built dashboard (`npm run build -w @penguin/dashboard`) on the Worker's own routes over a
project seeded from one fixture under `examples/` (`scripts/preview/seed.ts`). The seed builds the
fixture's repository with its own `build.py` and goes through the modules the ProjectAgent calls:
identities from `penguin/identities.json`, each feature opened by its agent with its declared area
and overlap check, each checkpoint, `whats_near`, `impact` and `check` run by the check runner's
programs, the merge plan with a real facts run, each review with the review harness and each
person's decision. A request signs in as the owner its `X-Preview-Owner` header names, or as the
`--as` owner, or as the originating person; `/preview/as/<owner>` switches a browser's seat.

On identity unification the plan stays unstored. Penguin's facts list analytics and messaging as
places with callers on main. The fixture holds no fix for them, so Priya's feature reads planning
and Jun's review exception carries the case. On money in minor units the plan is returned
over the default break limit of 10; the preview then raises the project's
limit to the plan's behavioural count and Ines's agent proposes it again, so the plan is stored and the return stays in
Ines's inbox.
