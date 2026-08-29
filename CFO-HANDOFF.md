# CFO — session handoff

For any session picking up the personal-CFO workstream cold, on any machine or in
the cloud. Architecture and working agreements only — **no figures live in this
repo, ever** (see Ground rules).

## What this is

Matheo wants an ongoing personal-accountant workstream. **Personal money only** —
his own salary, cards, transfers, Haiti balances, investments, net worth. The
Cameo / DEKA factory P&L is a different app and explicitly out of scope.

It lives in **Finances ▸ CFO** in this app.

## The page

`cfo` is a `SPECIAL` page — one nav entry under Finances, with a segbar across five
views: a Dashboard plus four registers that are ordinary `MODS` sections.

| Register | Holds | Why it exists |
|---|---|---|
| `income` | source, amount, cadence, currency, account | Nothing else in Alfred records a dollar coming *in* |
| `debt` | balance, APR, minimum, due day | Payoff strategy is unanswerable without APR + minimum |
| `goal` | target, date, put-aside | Turns a wish into a monthly number |
| `spend` | category × month | Statements say what you *paid the card*, not what you *bought* |

**The dashboard writes nothing another page owns.** Cash, subscriptions, payroll,
investments and assets are read where they live, on the same basis `networthPage`
already uses. Keep it that way — it is the condition under which the tab was
allowed to exist.

## Things that will bite you

- **Debt balances are stored positive** here ("what you owe"). This is the opposite
  of `fincash` group `Credit`, which stores negatives. Don't unify them.
- **`cfoPayoff(ordered, extra)`** holds the budget fixed at total-minimums + extra,
  so a cleared debt's minimum rolls onto the next one. That roll-up *is* the
  avalanche/snowball strategy. The **caller** decides the order; the function only
  runs the arithmetic. It returns `ok:false` past 600 months, which is what happens
  when interest outruns the payments — surface that, don't hide it.
- **The FAB accepts a function.** `SPECIAL.cfo.fab` returns `null` on the dashboard
  and the register key elsewhere; `renderActive()` was widened to allow it and is
  still backwards-compatible with the string fabs everywhere else.
- **A `const` must never go inside the `MODS` object literal** — it is an object,
  not a block, and doing it silently blanks the whole app.
- Anything referenced from a `MODS` *field definition* is evaluated at load, so it
  must be declared above `MODS`. Helper *functions* are hoisted and can live below.

## Reading his real data

Run SQL directly against `public.items` in the Supabase project
`lceferergfrjklqhzokf` — this bypasses RLS, so the `x-alfred-key` secret is **not**
needed. Don't ask him to paste the setup link.

- Filter `not coalesce(del,false)`; tombstones are kept.
- `data` is jsonb with string values — cast via `(nullif(data->>'amt',''))::numeric`.
- Writing server-side: set `up = extract(epoch from now())*1000`, or a stale device
  copy wins on the next sync (last-write-wins on `up`).

Never test behaviour against his live rows. A test tick once left a tombstone that
killed a real reminder. Use throwaway ids, or verify by reading rather than mutating.

## Ground rules

- **This repo is public.** No balances, no income, no account numbers, no card
  figures in any file here. A line quoting his actual card spend nearly shipped
  inside an empty-state string once — it was caught at the last check before push,
  which is the only reason it isn't in the git history. Run a scan over your own
  diff before every push. Personal numbers live only in the private Supabase.
- Deploy is: edit `index.html` → commit → push to `main` → GitHub Pages. No build
  step. The service worker caches hard; hard-reload to see changes.
- He is not asking for investment advice and should not be given any. Budgeting,
  cash-flow design, payoff math, net-worth tracking and scenario modelling — yes.
  Which securities to buy — no.

## Cadence

Monthly close plus a weekly check.

## Still outstanding

The registers were shipped empty for him to fill. Until they are, the dashboard
shows a "Fill these in" panel rather than fake zeros. Four things only he can answer:

1. Income — figures, cadence, currency, which account.
2. Debt APRs and minimums; and whether the Haiti BUH line is a card, an overdraft
   or a loan.
3. Goals — what the money is actually for, and by when.
4. Whether the large monthly card payments are his own living costs or business /
   family spend that gets reimbursed. This one changes the reading of everything
   else, and no register can infer it.
