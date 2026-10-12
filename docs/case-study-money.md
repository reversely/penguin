# Case study: moving every price to integer minor units

This case follows one breaking change through Penguin on a team of fourteen people with about sixty
agents and about forty features in progress at once. The change does not fit one plan, so its author
splits it into waves by parallel change. Every count below comes from `propose_plan`, Penguin's caller
counts and the review harness run on the fixture in [fixture-money.md](fixture-money.md).

## Team

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

## Change

Prices today are floating-point dollars. Invoices have drifted by a cent against card charges. The
Japan launch also needs yen, which has no minor unit. Stripe takes amounts in the currency's minor
unit: `1000` charges 10 USD. `10` charges 10 JPY, because JPY is a zero-decimal currency
([Stripe currencies](https://docs.stripe.com/currencies)). Ines's feature replaces float prices with
`Money(amount_minor, currency)`.

## One-block attempt

Every feature is its own fork of main in Artifacts. Ines's agent opens the feature "Money in minor
units" and declares its area: `shared/money` with the `price()`, `total()` and `display()` contracts.
Two running features already work inside `shared/money`, so Penguin blocks the start until each of
their people approves:

- Hugo's agent is bumping the decimal library's rounding mode. Hugo approves, because the two changes
  touch different functions.
- Lena's agent is adding promotion stacking, which edits a money helper. Lena declines, because both
  edit the same helper. Penguin queues Ines's feature behind Lena's. Lena's feature reaches main first.

Ines's checkpoint changes `price()` and `total()` to return `Money` and removes `display()`. Ines's
agent proposes a plan with a fix for each place the change reaches. Penguin finds 32 places:

- **Code on main.** The nine scopes that call the money contracts: checkout, orders, refunds,
  invoicing, tax, payouts, analytics, messaging and mobile-api.
- **Running features.** The 23 features whose own changes call the money contracts.

All 32 fixes are behavioural. Each one rewrites test data or expectations, or makes a choice per
call such as the yen's currency, which no rewrite rule writes. All 32 parts also need a person: no
facts run has tested any of their fixes, since each fix comes after the checkpoint Ines's agent
reported. The project's break limit is 10, so Penguin returns the plan to Ines with a signed
`plan_returned` record. The returned plan stays in Ines's inbox.

## Waves by parallel change

Ines's agent splits the change into waves by parallel change: expand, migrate, then contract
([Fowler, ParallelChange](https://martinfowler.com/bliki/ParallelChange.html)). Each wave is its own
feature, opened from main as the wave before it left main. Each wave has its own plan. Once its parts
are approved, Penguin moves main to the wave's head in one push. Every scope's tests pass on main between waves.

| Wave | Feature | Moves | Places | Behavioural | Starts approved | Penguin's answer |
|---|---|---|---|---|---|---|
| 1. Expand | `money-type` | Adds `Money` and Money functions beside the float ones | 0 | 0 | 4: Hugo, Tomas (3) | Stored |
| 2. Migrate | `money-checkout` | `checkout` | 1: promotions on main | 1 | 3: Priya (3) | Stored |
| 3. Migrate | `money-tax` | `tax` | 1: invoicing on main | 1 | 2: Rahul (2) | Stored |
| 4. Migrate | `money-refunds-payouts` | `refunds`, `payouts` | 0 | 0 | 4: Ade (2), Kofi (2) | Stored |
| 5. Migrate | `money-analytics` | `analytics` | 0 | 0 | 3: Jun (3) | Stored |
| 6. Migrate | `money-messaging-mobile` | `messaging`, `mobile-api` | 0 | 0 | 6: Sam (3), Noor (3) | Stored |
| 7. Contract | `money-contract` | Removes the float API | 24: orders on main and 23 running features | 24 | 1: Hugo | Returned |

### Wave 1: expand

The expand wave adds `Money`, `Money.sum()` and `discounted()` to `shared/money`. It adds
`line_total_minor()` and `order_total_minor()` to `orders`. No existing function or class changes,
so the impact graph finds no caller and the plan has no place. The float functions keep working, so
no running feature breaks.

A stored order line keeps its unit price in dollars, as the order store records it. A Money field on
`Line` would change the class. Penguin's impact graph would then list every `Line(...)` call as a
caller, including the tests of every scope that reads orders. `line_total_minor()` reads the stored price into the order's
currency instead.

The wave adds functions to `orders/model.py`, so Tomas approves its start beside the three running
features Tomas owns in `orders`. Hugo approves it beside the rounding-mode feature.

### Waves 2 to 6: migrate

Each migrate wave moves one scope, or two, off the float API. Its own change rewrites that scope's
code and tests to import `Money` by name and to call the Money functions. The wave changes no float
function, so the running features in that scope keep working. Their people approve the wave's start
beside their features, 18 approvals across the five waves.

A migrate wave's places are the other scopes on main that call what it changes:

- **Checkout.** `cart_total()`, `charge_amount()` and `total_line()` take the cart's currency. The
  charge is the total's `amount_minor`, so a yen cart is charged at face value. Lena's promotion
  stacking on main calls `cart_total()`, so the plan has one part for promotions, which Lena approves.
- **Tax.** Tax becomes `Money` with `Decimal` rates. Invoicing on main adds the tax to the order
  total, so the plan has one part for invoicing, which Mei approves.
- **Refunds and payouts.** Refunds sum line totals in the order's currency. Store fees round half up
  in the minor unit, as the store agreement says. No other scope calls them on main.
- **Analytics.** Revenue is reported per currency, so amounts in different currencies are never
  added together. The wave edits `analytics/revenue_report.py`, the file Jun protects in the
  scope's `protected_paths`. The wave's plan has no parts, because no other scope on main calls
  what it changes. Penguin checks the wave's own change at its checkpoint anyway: the files that
  differ from its merge base with main. The change rewrites the protected file, so Jun gets a
  `protected_path` item with the file's changed lines. The wave cannot land until Jun confirms
  them. Jun confirms, and main moves to the wave's head.
- **Messaging and mobile API.** Receipts and order payloads read totals as `Money`. Their tests
  pass unchanged, because they compare the displayed text and the minor amount.

### Rahul's revision

The tax wave's first checkpoint rounds the order's subtotal once. Rahul's agent submits a review form
for tax. Penguin runs `invoice_tax_minor` on main and on the wave's fork over 5,000 recorded orders.
Invoice tax differs on 1,633 of them by one or two cents. No single-line order differs. The form
marks the invariant "Tax is rounded per line item" broken, so the exception goes to Rahul. Rahul asks
for per-line rounding. Ines's agent writes the revision as the wave's next checkpoint. On the rerun 10
orders still differ by one cent. Each has one line whose exact tax is half a cent, which main's float
arithmetic rounds down. The revision equals exact decimal arithmetic on all 5,000 orders. The review
holds. Ines's agent proposes the plan again at the revision.

### Wave 7: contract

The contract wave removes `price()`, `total()`, `display()` and `percent_off()` from `shared/money`.
After the migrate waves, one caller of the float API is left on main: `orders`, whose
`line_total()` and `order_total()` call `price()` and `total()`. Its fix removes those two functions.

The migrate waves changed main's code, never the running features' own changes. The 23 running
features that call the float API in the modules they add still call it, so each is a place of the
contract wave. Their 23 fixes and the orders fix make 24 parts needing a person, over the limit of
10, so Penguin returns the contract wave's plan to Ines as well.

Two moments depend on the contract wave's plan being announced:

- **Noor's pagination.** Noor's second checkpoint adds an order-lines page that calls
  `line_total()`. The contract plan was returned, so no announced plan gains a part for it. The
  feature's own change makes it a place of the next contract plan.
- **Sun's late start.** Sun opens "currency filter in search" after the contract plan. Sun's agent
  writes against `Money` from the first commit and imports it by name, so the feature calls nothing
  the contract wave removes.

### Retiring the float API

The expand wave's plan can also mark the float API retiring: `price()`, `total()`, `display()`,
`percent_off()`, `line_total()` and `order_total()`, each with its Money replacement. Penguin keeps
the six declarations as signed project data. From then on each checkpoint gets one retiring-calls
check of its own changes.

- **Noor's pagination.** Noor's second checkpoint adds `money.display(line_total(line))`. Its check
  gives two next steps. The plan's `display` rule rewrites the `display()` call, so that step is
  Penguin's codemod, step 3. No rule covers `line_total()`, so that step goes to Noor's agent at step
  4 with `line_total_minor()` named as the replacement.
- **The remaining callers.** After the migrate waves, Ines's agent asks for the remaining callers.
  Penguin lists 26 places in 10 owner groups. The 23 readers and the pagination feature sit in
  their own people's groups. Two scopes on main, money (Ines) and orders (Tomas), still call the
  float functions in their tests. Each group is one owner's set of migration parts.

[fixture-money.md](fixture-money.md#retiring-the-float-api) lists each group with its uses.

### Counting callers after each promotion

After each wave's block reaches main, Penguin counts the callers of the six retiring functions on
main and in the running features' own changes, in one analysis per promotion
([design.md](design.md#sorting-and-splitting-in-the-build), Contract). The counts on the fixture:

| Promotion | Callers | On main | In running features |
|---|---|---|---|
| `money-type` | 98 | 53 | 45 |
| `money-checkout` | 93 | 48 | 45 |
| `money-tax` | 83 | 38 | 45 |
| `money-refunds-payouts` | 72 | 27 | 45 |
| `money-analytics` | 68 | 23 | 45 |
| `money-messaging-mobile` | 59 | 14 | 45 |

The migrate waves moved callers on main only. The 45 uses in the 23 readers' own changes stay. After
the last migrate wave every function still has callers:

| Retiring function | Callers | On main | Running features calling it |
|---|---|---|---|
| `line_total()` | 8 | 2 | 3 |
| `order_total()` | 12 | 2 | 5 |
| `display()` | 11 | 1 | 10 |
| `price()` | 14 | 2 | 12 |
| `total()` | 8 | 1 | 7 |
| `percent_off()` | 6 | 6 | 0 |

No count reaches zero, so Penguin proposes no contract step. Each function's state is
`callers_left`. The expand wave that declared the six functions has also landed, so its fork could
not carry the removal at zero.

## What it took

| | Count |
|---|---|
| Plans returned over the break limit | 2: the one-block attempt (32) and the contract wave (24) |
| Plans stored | 6: the expand wave and five migrate waves |
| Parts approved in the migrate waves | 2, both by a person: Lena for promotions, Mei for invoicing |
| Parts Penguin approved | 0: each stored part fails a check (below) |
| Protected-path confirmations | 1: Jun for the analytics wave's `analytics/revenue_report.py` |
| Starts approved beside a running feature | 1 for the one-block attempt and 23 for the waves |
| Times main moved | 6, one per stored wave, each with every scope's tests passing |
| Review exceptions | 1: Rahul's broken `tax-per-line` invariant on the whole-order step |
| Callers of the float API left on main before the contract wave | 1 scope: orders |
| Callers of the retiring functions after the last migrate wave | 59: 14 on main, 45 in 23 running features |

Penguin approves a part only when each of its checks is clean ([design.md](design.md#penguins-approval-in-the-build)).
Neither stored part passes. Each part's trial applies its fix commit to main merged with the wave's
checkpoint ([design.md](design.md#part-trials)). Promotions' tests and invoicing's tests pass on
those trees. No agent reviewed either part, since the fixture holds no review form for promotions or
invoicing. Lena's fix also edits `promotions/tests/test_stacking.py`, which holds no caller of a
changed symbol and no break. Rahul's tax review is a review of
the tax wave's own change, so its broken invariant still reaches Rahul as a review exception.

The waves moved the nine scopes on main one or two at a time, with at most one part needing a person
per plan. The running features' own float calls stay in place until the contract wave, so that wave
carries the same 23 feature fixes the one-block attempt carried.

Every step lives as a signed record in the project's record repo in Artifacts: each plan, each
return, each approval and its reason, Rahul's review and revision, Jun's confirmation of the
protected lines, each promotion.
