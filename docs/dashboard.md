# Dashboard

> **Design change.** This page describes the current build. The dashboard in
> [design.md](design.md#dashboard-for-people) shows each person's features with their agents on the
> team view. It adds an approvals inbox. A feature page takes over from the issue page.

The dashboard is where people on the team see who is working on what and what waits on them. They
act on issues there too: open and assign issues, review fixes, answer threads and manage their agent
identities.
Every action it takes is an issue operation or an identity change sent to the ProjectAgent. The
Worker serves it from the same origin as its API. The code is in `apps/dashboard/src/`; the Worker's
routes for it are in `apps/worker/src/dashboard.ts`.

## Pages

| Path | Page |
|---|---|
| `/` | The team map |
| `/?person=<id>` | One person's view |
| `/inbox`, `/inbox?closed=all` | The signed-in person's inbox |
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

## Team map

The home page shows one square per person, the signed-in person first
(`team-page.tsx`, `team-view.ts`). The people are every owner in the scope map, every owner who holds
an identity or an assigned issue, plus every person an inbox item asks to act.

Each square holds:

- the person's name and avatar in their hue, linking to the person's view;
- counts of what waits on them, shown only when non-zero: reviews, threads and sessions to start;
- one box per agent identity of theirs. A box shows the identity's character, its handle, its session
  status and the number of the open issue it holds, with `+N` for others. It opens the identity's
  agent card.

| Status | When |
|---|---|
| Blocked | No running session holds the issue, or an open thread on it needs a person |
| Waiting | The issue is in `verifying` or `in_review` |
| Working | A running session holds the issue and nothing above applies |
| Done | The issue is closed |
| No session | No session of the identity is running |

No MCP tool reports a session's status, so the dashboard derives it from the issue's state and
routing (`board-view.ts`). Boxes order by the most pressing status. A team identity sits under the
owners who assigned it its issues, or under every owner it serves while it holds none.

Below the squares, Unassigned lists open issues with no assignee. The page header carries Penguin's
state across every open issue (observing, coordinating, fixing, verification failed, awaiting review,
ready to approve) and New issue.

### Person view

`/?person=<id>` shows the person's scopes from the scope map, their agent boxes and every issue that
involves them, open issues first. Each issue row carries why it is there: Assigned, Review, Reply or
Session to start.

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

The inbox lists the signed-in person's items in five groups (`inbox-page.tsx`, `inbox-view.ts`):

| Group | Holds |
|---|---|
| Review requests | Fixes whose combined tests pass and whose review counts from this person |
| Assignments | Issues assigned to the person or an identity they answer for; requests to start a session of one |
| Mentions | Mentions of the person or an identity they own |
| Threads | Issues with a thread that needs the person |
| Closed issues | Issues that closed while the person had an item for them; the newest 10, or all with `/inbox?closed=all` |

A row shows what the item waits on the person for: "Waiting for your review", "Waiting for your
reply", "Waiting for you to start a session" or "Waiting for your acceptance". A dot marks an unread
item; pressing the dot marks it read, in every browser the person has open. From 760px the rows sit in the sidebar and
stay there while an issue is open beside them. On a phone they fill the page under a strip of the
person's own identities.

The person who did something gets no item for it. An item is keyed by person, issue and reason, so a
later event of the same reason marks it unread again (`services/project-agent/src/inbox-store.ts`).

Above the groups, Overlapping starts lists each feature whose start waits for the person beside one
of their running features (`overlap-requests.tsx`, read from `GET /api/overlaps`). A row names the
waiting feature, its person, the person's own feature and the scopes, contracts and paths where the
two areas meet. Approve start posts `POST /api/overlaps/approve`; the row goes once the approval is
recorded ([design.md](design.md#step-3-in-the-build)). The section shows only while a start waits.

Below it, Merge plan parts lists each plan part that waits on the person as its owner or the owner's
delegate (`plan-parts.tsx`, read from `GET /api/plan-parts`). A row names the part, its revision, the
originating feature and person, the place it changes and its round count against the limit. It
shows each reason the part needs the person in person, the latest requested change and each changed
file's diff lines. Approve revision posts `POST /api/plan-parts/approve`. Request change opens a field
whose text posts `POST /api/plan-parts/request-change`
([design.md](design.md#advance-notice-in-the-build)). The same list shows, without controls, the
parts that write a path the person protects and the parts of the person's own plans past the round
limit. Review exceptions lists each review of the person's scopes whose record raised an exception.

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
self-hosted. Every value from an issue or identity renders as React text, so markup in a title, body,
name or handle shows as text and runs nothing.
