# Case study: moving every price to integer minor units

This case follows one breaking change through Penguin on a team large enough that coordinating by
hand fails: fourteen people, about sixty agents and about forty features in progress at once.
[fixture-money.md](fixture-money.md) describes the Git repository that models it, with the scopes,
features, fixes and tax sample below.

## The team

Larder is a grocery delivery marketplace with one repository. Fourteen engineers each own one or two
scopes and each run between three and eight agents. At any moment about forty features are open.

| Person | Owns | Reads money? |
|---|---|---|
| Ines | `shared/money`: price types and arithmetic | Owns it |
| Priya | `checkout` | Yes |
| Tomas | `orders` | Yes |
| Ade | `refunds` | Yes |
| Mei | `invoicing` | Yes |
| Rahul | `tax` | Yes |
| Lena | `promotions` | Yes |
| Kofi | `payouts` to stores | Yes |
| Sun | `catalog` and search pricing | Yes |
| Jun | `analytics` | Yes |
| Sam | `messaging`: receipts and emails | Yes |
| Noor | `mobile-api` | Yes |
| Elif | `store-dashboard` | No |
| Hugo | `platform`: shared libraries and dependencies | No |

## The change

Ines opens the feature "Money in minor units". Prices today are floating-point dollars. Invoices
have drifted by a cent against card charges. The Japan launch also needs yen, which has no minor unit.
Stripe takes amounts in the currency's minor unit: `1000` charges 10 USD; `10` charges 10 JPY,
because JPY is a zero-decimal currency ([Stripe currencies](https://docs.stripe.com/currencies)).
The feature replaces every float price with `Money(amount_minor, currency)`.

## The procedure

### 1. Open: Penguin checks the area

Every feature is its own fork of main in Artifacts. The binding's `fork(name, { readOnly,
defaultBranchOnly })` makes it server-side. `createToken(scope, ttl)` gives each of the feature's
agents a write token for that one fork that expires. Opening a feature mints its fork; nobody clones
the whole project.

Ines's agent opens the feature. Penguin mints its fork, `feature-money-minor-units`. The agent
declares the feature's area: `shared/money` with the `price()` and `total()` contracts, which return
floats today.

Penguin checks that against the forty running features:

- **Same area.** Two running features already work inside `shared/money`:
  - Hugo's agent is bumping the decimal library's rounding mode.
  - Lena's agent is adding promotion stacking, which edits a money helper.

  Penguin blocks Ines's start until each of those people approves. Hugo approves, because the two
  changes touch different functions. Lena declines, because both edit the same helper. Penguin
  queues Ines's feature behind Lena's. Lena's lands first.
- **Readers.** The impact graph finds 23 running features, across nine scopes, that call the
  money contracts. None of them blocks the start. All of them are in the plan.

### 2. Plan: the originating agent proposes every fix

Ines's agent writes the merge plan: the change itself, plus a proposed fix for each of the nine
scopes that read money.

| Scope | Kind of fix | Who writes it |
|---|---|---|
| `checkout`, `orders`, `refunds`, `invoicing`, `messaging`, `mobile-api` | Mechanical: the float type becomes `Money`, `* 100` conversions are removed, formatting moves to `Money.display()` | Penguin's codemod, generated from the contract diff |
| `tax` | Behaviour: where rounding happens | Ines's agent |
| `payouts` | Behaviour: how store fees round | Ines's agent |
| `analytics` | Behaviour: summing revenue across currencies | Ines's agent |

### 3. Tell in advance: each author approves their part once

The plan goes to the nine authors and their running agents before anything lands. Each author
approves the part that touches their code:

- **Seven approve as proposed.**
- **Rahul's agent asks for a change.** Penguin hands it tax's declared invariant, "tax is rounded per
  line item". Penguin then runs the tax functions side by side on main and on Ines's fork, over
  5,000 sample orders drawn from a fixed seed. Invoice tax differs on 1,633 of them, every one with
  two or more lines, by one or two cents. The review form marks the invariant broken, which routes to
  Rahul. Rahul confirms the request. Ines's agent revises the tax fix. On the rerun, 10 orders still
  differ by one cent: each has a single line whose exact tax is half a cent, which main's float
  arithmetic rounds down. The revision matches exact decimal arithmetic on all 5,000 orders.
  Rahul's agent cites the test that proves it. Rahul approves the revision.
- **Jun approves and marks `analytics/revenue_report` as protected.** Jun will confirm the final
  lines in that file before the change lands.

### 4. Build: everyone keeps working

Each agreed fix goes where its code lives:

- **Code already on main**, in the nine scopes: Ines's agent and Penguin's codemods write these fixes
  into Ines's feature fork, next to the change itself.
- **Unfinished work** in the 23 running features: as soon as an owner approves the plan, Penguin mints
  a short write token on that feature's existing fork. The fix goes straight into it: 16 are
  codemods Penguin writes. The other 7, in tax, payouts and analytics, are written by Ines's agent. No new branch or fork is made. Each running feature then keeps building on code that already
  fits the new money type, so the merge conflict never forms.

The other 23 agents carry on in their own forks, now carrying the adaptation.

Midway through, Noor's pagination feature starts returning prices. Penguin sees this at Noor's next
checkpoint, not at merge. Ines's agent adds a mechanical fix for it to the plan. Noor approves.

### 5. Land as a block

The block is every write the plan makes: Ines's feature fork, plus the fixes written into the 23
overlapping forks. It is checked as one set and lands as one set.

1. **Check it.** Penguin merges Ines's feature fork onto main and onto each of the now 24
   overlapping forks with its fix in place. It runs the deterministic checks on each result:
   - the merge itself
   - ruff
   - the type checker
   - the contract diff
   - each affected scope's tests
2. **Owners try it.** Jun gets an expiring read token on Ines's feature fork, clones it and checks the
   protected file before confirming. Nothing new is created.
3. **Promote.** When everything is green, Penguin moves main to the feature's commit in one push, with a
   write token on main that only Penguin holds, for minutes. Main changes once, never in pieces, and
   every overlapping fork already carries its adaptation, so none of them breaks when it next takes
   main.
4. **Keep the record.** The feature's fork turns read-only and shows exactly what landed.

| Result | Count | What happens |
|---|---|---|
| Clean | 24 forks | Each already carries its fix from the build step; Hugo's same-area fork needed none |
| A failing test in `promotions` | 1 | Lena's promotion stacking, which promoted first, still adds floats. It shows from Ines's first checkpoint check onward. Penguin classifies it as mechanical and writes the codemod into Ines's fork |
| Protected file | `analytics/revenue_report` | Jun confirms after trying the read-only fork |

Main is never red.

### 6. Late starters

Sun opens "currency filter in search" after the plan was announced. Penguin hands Sun's agent the
plan when the feature opens. Sun's agent writes against `Money` from the start, so there is nothing
to resolve.

## What it took

| | Count |
|---|---|
| People confirming an overlapping start | 2 (Hugo, Lena) |
| People approving a plan | 10 (nine authors and Noor) |
| Plan revisions asked for | 1 (Rahul) |
| Protected-file confirmations | 1 (Jun) |
| Affected running branches | 24 |
| Affected forks that needed nothing | 1 (Hugo's) |
| Fixes written by deterministic tools | 24 codemods: 7 in Ines's fork, 16 in reader forks, 1 in Noor's |
| Fixes written by an agent | 11, all by Ines's agent: 3 in Ines's fork, 7 in reader forks, 1 revision |
| Times main was broken | 0 |

Every step lives as a signed record in the project's record repo in Artifacts: the plan, each approval and
its reason, Rahul's revision, the block's checks and the promotion. The feature's read-only fork holds the
exact code that landed. That record answers why each line
changed.

## The same change without Penguin

Ines opens one pull request that changes `shared/money`. Nine authors find out when their branches
stop compiling, or when tests fail after main moves. Twenty-four branches each resolve the break on
their own, with different conversions. Lena's float addition reaches main. Invoices drift
again. Yen is charged at a hundred times the price on any path that still multiplies by 100.
