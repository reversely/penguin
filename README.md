# Penguin

Code ships through five stages: local development, central development, test, pre-production and
production. Penguin runs a sandbox where the work many people's coding agents do in local development
merges into one codebase continuously without breaking main. A sandbox is one Penguin project: its
base repo and the forks its agents work in. A team can run a sandbox at any of the five stages. The
stage sets how much of the review Penguin does and how much people do: people decide more of it at
each stage nearer production.

Each person owns features. Each feature is a fork of main in Cloudflare Artifacts,
worked by one or more of that person's agents. When a feature changes something other running
features depend on, the agent making the change plans the merge first. It proposes the fix for each
affected feature and tells those authors in advance. It writes each approved fix straight into the
affected feature's fork. Penguin then promotes everything to main together as one block. Penguin
checks every step with deterministic tools. A feature that starts in another running feature's area
opens at once. Penguin tells that feature's person. People step in to approve a plan that
touches their code or for an exception, as often as the sandbox's stage sets.

## How Penguin decides

Penguin decides whether a change may reach main with six kinds of validation: Tests, Logic, Data
matching, Stored data, Custom path rules and place, Overlapping starts. Each kind has its own check
and its own tool. A failed test always goes back to the agent. An overlapping start always opens
with its owner told. For the other kinds, the sandbox's review policy names its stage, which sets
whether Penguin or a person decides:

| Stage | Who decides a part a check marks |
|---|---|
| Local development | Penguin, which tells the owners |
| Central development, the default | The person the part routes to |
| Test and Pre-production | The person the part routes to, also for a rule-written migration part whose side-by-side run differs |
| Production | A person, for every part |

[docs/validation.md](docs/validation.md) defines each kind and
[docs/review-policies.md](docs/review-policies.md) the policies.

## Answers to the competition questions

Penguin is an entry in Cloudflare's competition for the layer above Artifacts
([Cloudflare](https://blog.cloudflare.com/next-git-platform-on-cloudflare/)). The post asks four
questions.

| The post asks | Penguin's answer |
|---|---|
| "How do agents know what other agents are working on?" | Every feature declares its area when it opens. Penguin checks the declaration against every running feature. It keeps the overlap current at each checkpoint |
| "What happens when they make conflicting changes?" | The agent making the change plans the merge. It writes the fixes into the affected forks once their authors approve. Penguin then promotes the whole set as one block, so main receives all of the change in one push |
| "How do you review everything they produce?" | Deterministic checks gate every block. Agents review their own scope through a fixed form that Penguin validates and tests. People see the exceptions |
| "How do you keep track of not just what changed, but why?" | Every plan, approval, check and promotion is a signed record in the project's record repo in Artifacts |

## Procedure

1. **Open.** A feature declares its area. Penguin records where it overlaps another running feature
   and tells that feature's person. The feature starts at once.
2. **Plan.** A feature that changes something others depend on carries a merge plan written by its
   agent. Penguin supplies the contract diff, the callers and each affected scope's invariants.
3. **Advance notice.** Each affected author's agent reviews its part through a validated review form
   with declared invariants and side-by-side runs. The author approves once.
4. **Build.** The originating agent writes each approved fix straight into the affected feature's
   existing fork with a short-lived token scoped to that one repo. No new branch or fork is made.
5. **Block promotion.** Penguin checks the whole set deterministically. It moves main once.
6. **Late starters.** A feature opened after a plan was announced receives the plan at open.

Deterministic checks, tools and a resolution ladder handle mechanical breaks. Agents handle behaviour.
Penguin writes no judgment fix. [docs/design.md](docs/design.md) holds the full design.

## Use cases

1. **One person, two streams.** Priya's identity merge rules change data that Jun's analytics and
   Sam's messaging read ([fixture](docs/fixture.md#under-the-new-procedure),
   [demo story](docs/demo-story.md)).
2. **The helpful fix.** Priya's UTC fix to a shared date helper would move Jun's and Sam's users to
   the wrong local day ([fixture](docs/fixture-helpful-fix.md#under-the-new-procedure)).
3. **The dependency bump.** Hugo's HTTP client upgrade retries by default, which would charge Ana's
   payments twice ([fixture](docs/fixture-dependency-bump.md#under-the-new-procedure)).
4. **Money in minor units.** One change to the price type touches nine scopes and 24 running features
   on a team of fourteen people ([case study](docs/case-study-money.md)).

## Status

The current build has:

- Artifacts repos and repo-scoped tokens
- the signed operation log with validation and rejection reasons
- the ProjectAgent with one Durable Object per coordinated unit of work
- MCP tools and session registration
- the bridge with consent, checkpoint publishing and the safe-checkpoint hook
- combined runs on merged trees with `git merge-tree`
- fix routing, including sending a fix upstream to the scope that caused the break
- verification on a dedicated branch
- the walkthrough harness that runs the first three use cases
- the dashboard shell, team map and identities

The approved design is still being built in this order: features as forks with overlap locks; merge
plans with approvals and fixes written into affected forks; the deterministic checks, tools and
routing; the review harness; block promotion; the dashboard views; the scaled case with the
walkthrough of all four use cases. Pages in [docs/](docs/README.md) that describe the current build
say where the design changes them.

## Try it

[docs/deploy.md](docs/deploy.md) sets up a deployment. [docs/walkthrough.md](docs/walkthrough.md)
runs the first three use cases through the current build.

## Documentation

[docs/README.md](docs/README.md) lists every page.
