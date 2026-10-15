# Case study: moving every price to integer minor units

This case follows one breaking change through Penguin at a company of 200 engineers running 587 agent
identities, plus up to five sub-agents per builder, with 573 features in progress at once. The change alters contracts that nine scopes
and 23 running features call, so it reaches main as a split: the expand first, then each owner's
code in its own block, then the removal of the old shape. Every count below comes from the preview
seed's run of the fixture in [fixture-money.md](fixture-money.md): `propose_plan`, Penguin's caller
counts, its migration plans and the review harness.

## Team

Larder is a sample e-commerce site for grocery delivery, with one repository. Two hundred engineers
work in four teams. Fourteen of them are DRI for two or three of the repository's 30 scopes each and
run a steward for those scopes. Every engineer runs one builder per open feature: 587 identities
across 573 open features. A builder may run up to five sub-agents on its own machine, each on a
bounded task within the feature, so Larder runs up to 3,452 agents at once. Sub-agents act as their
builder: Penguin sees the builder's identity, charter and token. The tables below follow the fourteen
DRIs, whose features the cases are written around; [fixture-money.md](fixture-money.md#scale)
describes the other 186 engineers and their 532 features.

| Team | Person | DRI for | Reads money? |
|---|---|---|---|
| Payments (lead Ines) | Ines | `money` (price types and arithmetic), `currencies` | Owns it |
| | Kofi | `payouts` to stores, `store-billing` | Yes |
| | Ade | `refunds`, `disputes` | Yes |
| | Rahul | `tax`, `tax-filing` | Yes |
| | Mei | `invoicing`, `dunning` | Yes |
| Shopping (lead Tomas) | Priya | `checkout`, `payment-methods`, `accounts` (shopper accounts) | Yes |
| | Tomas | `orders`, `fulfilment` | Yes |
| | Lena | `promotions`, `loyalty` | Yes |
| | Sun | `catalog` and search pricing, `inventory` | Yes |
| Stores and apps (lead Elif) | Noor | `mobile-api`, `app-config` | Yes |
| | Elif | `store-dashboard`, `store-onboarding` | No |
| | Sam | `messaging` (receipts and emails), `notification-prefs` | Yes |
| Data and platform (lead Hugo) | Jun | `analytics`, `dashboards`, `experiments` | Yes |
| | Hugo | `platform` (shared libraries and dependencies), `feature-flags` | No |

## Change

Prices today are floating-point dollars. Invoices have drifted by a cent against card charges. The
Japan launch also needs yen, which has no minor unit. Stripe takes amounts in the currency's minor
unit: `1000` charges 10 USD. `10` charges 10 JPY, because JPY is a zero-decimal currency
([Stripe currencies](https://docs.stripe.com/currencies)). Ines's feature replaces float prices with
`Money(amount_minor, currency)`.

## Open

Every feature is its own fork of main in Artifacts. PRD cases 1 to 3 run on the same main first:
Priya's shopper accounts, Hugo's structured logs and Hugo's HTTP client upgrade each reach main as
a block ([fixture-money.md](fixture-money.md#cases-1-to-3)). Lena's promotion stacking reaches main
after them, before Ines starts. Ines's agent opens the feature "Money in minor units" and declares its area: the money
and orders scopes. Four running features already work there. Penguin approves the start at once with a
signed `approve_overlap` record and tells each worktree owner with an `overlap_started` item: Hugo once,
beside the rounding-mode bump, which touches another money function, and Tomas three times, beside the
three orders features Tomas runs.

## Expand

Ines's agent writes the new shape beside the old one as the feature's first checkpoint. `Money` holds
a whole number of the currency's minor unit, with `sum()`, `times()`, `scaled()`, `major()` and
`display()`. `discounted()` sits beside `percent_off()`. `line_total_minor()` and
`order_total_minor()` sit beside `line_total()` and `order_total()` in orders. Nothing that exists
changes.

Penguin sorts the checkpoint's contract diff: 25 additive entries, no changed signature and no
changed stored data shape. Ines's agent proposes the plan at that checkpoint. The facts run finds no
place, so the plan holds no part. The plan declares seven rewrite rules and marks six contracts
retiring, each with its replacement: `price()` for `Money`, `total()` for `Money.sum()`, `display()`
for `Money.display()`, `percent_off()` for `discounted()`, `line_total()` for `line_total_minor()`
and `order_total()` for `order_total_minor()`. Penguin signs one `retire_symbols` record. The expand
reaches main on its own, while Ines's feature keeps building on its fork.

A stored order line keeps its unit price in dollars, as the order store records it. A Money field on
`Line` would change the class and every `Line(...)` call with it. `line_total_minor()` reads the
stored price into the order's currency instead, so no stored shape changes and no scope needs a
migration marker.

## Retire

From the expand on, each checkpoint gets one retiring-calls check of its own changes. Noor's
pagination reports its second checkpoint, which adds `money.display(line_total(line))`. The check
answers two next steps. The `display` rule rewrites the `display()` call, so that step goes to
Penguin's codemod. No rule covers `line_total()`, so that step goes to Noor's builder with
`line_total_minor()` named as the replacement.

Sun opens "Currency filter in search" after the expand. Sun's agent writes against `Money` from the
first commit and calls nothing that retires, so no plan reaches it.

## Migrate

After each promotion Penguin counts the callers of the six retiring functions, on main and in every
running feature's own changes. A use inside a retiring function's own module or its scope's tests is
no caller: those tests leave with the function. The count after the expand finds 84: 39 on main in
nine scopes and 45 in the 23 readers. Penguin proposes one migration plan per owner group, ten plans
with 32 parts. Noor's pagination later joins Noor's plan.

| Owner | Places | Uses |
|---|---|---|
| Ade | `partial-refunds`, `store-credit`, refunds on main | 5 |
| Jun | `basket-size`, `cohort-ltv`, `store-league`, analytics on main | 12 |
| Kofi | `instant-payouts`, `weekly-statements`, payouts on main | 11 |
| Lena | promotions on main | 2 |
| Mei | `business-accounts`, `credit-notes`, `pdf-layout`, invoicing on main | 14 |
| Noor | `cart-sync`, `order-history`, mobile-api on main, then `pagination` | 7, then 3 more |
| Priya | `japan-launch`, `saved-carts`, `tip-jar`, checkout on main | 6 |
| Rahul | `bottle-deposit`, `tax-exempt`, tax on main | 4 |
| Sam | `order-shipped`, `refund-email`, `weekly-digest`, messaging on main | 15 |
| Tomas | `reorder`, `split-shipments`, `substitutions` | 8 |

The rules rewrite every use in 10 parts, so the check runner writes those and tries each on its
trial tree. Kofi's `instant-payouts` part passes `test:payouts`, so Penguin approves it with no
person asked. 9 fail their scope's tests there and become edit tasks with the failing check. In
`store-league`, for one, the `display` rule turns `money.display(amount)` into `amount.display()`
while `amount` is still a float. The other 22 parts are edit tasks from the start: each reader's own
changes go to its builder. Each owner's code on main goes to that owner's steward in a block Penguin
opens from main.

Each reader's builder moves its module onto `Money` and keeps the module's results, so its tests
pass unchanged. Tomas's plan holds only readers, so it closes once their migrations are written. Each
steward's block keeps the types of its scope's own contracts, so no other scope on main breaks when
the block reaches main: `cart_total()` still answers dollars, computed in `Money`. Penguin lands each
block once its parts are written. The callers left after each promotion:

| Block reaching main | Callers left |
|---|---|
| Priya's checkout | 36 |
| Ade's refunds | 33 |
| Mei's invoicing | 25 |
| Rahul's tax | 23 |
| Kofi's payouts | 15 |
| Jun's analytics | 11 |
| Sam's messaging | 5 |
| Noor's mobile API | 2 |
| Lena's promotions | 0 |

The count after Priya's block is the first after the readers migrated, so it drops their 45 uses at
once.

### Rahul's revision

Rahul's steward first computes tax on the order's subtotal and rounds once. Rahul's agent submits a
review form for tax on that step. Penguin runs `invoice_tax_minor` on main and on the block over
5,000 recorded orders. Invoice tax differs on 1,633 of them by one or two cents. No single-line order
differs. The form marks the invariant "Tax is rounded per line item" broken, so the exception goes to
Rahul. Rahul asks for per-line rounding. The steward writes it as the block's next commit. On the
rerun 10 orders still differ by one cent. Each has one line whose exact tax is half a cent, which
main's float arithmetic rounds down. The revision equals exact decimal arithmetic on all 5,000
orders. The review holds and the block lands.

Tax only reads orders and stores nothing derived from them. The split changes no stored shape, so
Rahul's forms name no migration marker.

## Contract

When a retiring function has no caller left on main or in any running feature's own changes, Penguin
proposes removing it on Ines's feature. The plan has no place, so Penguin approves it with no person
asked. `price()` reaches zero after Kofi's block, `total()` after Jun's, `line_total()` after Sam's,
`order_total()` and `display()` after Noor's and `percent_off()` after Lena's. Ines's agent removes
all six with their own tests as the feature's last checkpoint. Its contract diff shows each removed
with no caller. The feature lands and Penguin closes the six retiring records under one signed
`symbols_removed` record.

## What it took

| | Count |
|---|---|
| Starts Penguin approved beside a running feature | 4: Hugo told once and Tomas three times |
| Plans with places proposed by Ines's agent | 0: the expand's plan has none |
| Migration plans Penguin proposed | 10, one per owner. One more for Ade held a part that the next count dropped |
| Migration parts | 33: 23 readers' own changes, Noor's pagination and 9 owners' code on main |
| Parts written by the runner, by the rules | 10: Penguin approved Kofi's `instant-payouts`; 9 failed their trial |
| Edit tasks for builders and stewards | 32 |
| Review exceptions | 1: Rahul's broken `tax-per-line` invariant on the whole-order step |
| Custom path rule confirmations | 0: Jun's own steward writes the analytics block |
| Times main moved | 12: Lena's stacking, the expand, 9 blocks and the contract |
| Callers of the float API on main at the end | 0 |

Every step lives as a signed record in the project's record repo in Artifacts: the expand's plan and
its retiring declarations, each migration plan and its routing, Rahul's review and revision, each
contract step and the removal.
