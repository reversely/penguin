# Penguin docs

One page per subject. The case study and the demo story follow the merge plan design. The other
pages describe what the code on `main` builds today. Where the design changes one of those pages,
the page opens with a note naming the part that changes.

| Page | Subject |
|---|---|
| [../README.md](../README.md) | What Penguin is, the four use cases and what is built today |
| [validation.md](validation.md) | The six kinds of validation: what each checks, the tool that runs it and who decides it |
| [review-policies.md](review-policies.md) | The sandbox's review policy: presets, rows, who changes it and the measured split |
| [case-study-money.md](case-study-money.md) | One breaking change across fourteen people and forty running features, split into expand, migration blocks and contract |
| [demo-story.md](demo-story.md) | The demo frames from one person's seat |
| [architecture.md](architecture.md) | The pieces, who owns which state and how data moves between them |
| [issues.md](issues.md) | Signed operation files, validation and rejection, the index, offline issues, pending push |
| [huddle-flow.md](huddle-flow.md) | A Huddle from the triggering checkpoint to its close or cancel |
| [how-agents-connect.md](how-agents-connect.md) | The three ways Penguin reaches each person's agents |
| [mcp-setup.md](mcp-setup.md) | Connecting Claude Code and Codex sessions; the agent-session exit check |
| [bridge-and-runner.md](bridge-and-runner.md) | Installing `penguin-bridge`, checkpoints, the issue command line, runner mode |
| [dashboard.md](dashboard.md) | Sign-in, the org, team and person pages, feature pages, the approvals inbox, agent cards, the issue page, the local preview |
| [deploy.md](deploy.md) | Cloudflare resources, secrets, variables, deploying and project setup |
| [walkthrough.md](walkthrough.md) | The Playwright run of the four use cases |
| [fixture.md](fixture.md) | The identity-unification fixture |
| [fixture-helpful-fix.md](fixture-helpful-fix.md) | The helpful-fix fixture |
| [fixture-dependency-bump.md](fixture-dependency-bump.md) | The dependency-bump fixture |
| [fixture-money.md](fixture-money.md) | The money-minor-units fixture: the case study's teams, 29 scopes, forty features and the split |
