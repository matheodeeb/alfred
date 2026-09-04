# Alfred CFO — project handoff

For any session picking up the **Alfred CFO** workstream cold. This is a separate
project from the Alfred life monitor; keep them apart. Architecture, decisions and
plan only — **no figures live in this repo, ever** (see Ground rules).

Living plan document (design, threat model, phases, diagrams):
<https://claude.ai/code/artifact/fbf0cffe-c440-4e2b-b561-32ddcee00cc8>

---

## What this project is

Matheo's money, on its own encrypted website, with his credit and debit card
transactions flowing in automatically.

**Personal money only** — his salary, cards, transfers, Haiti balances,
investments, net worth. The Cameo / DEKA factory P&L is a different app and
explicitly out of scope.

**The scope is deliberately narrow.** He considered building a full Ledgr-style
feature set (budgets, splits, safe-to-spend, calculators, an AI advisor) and
then cut all of it. What he wants is one thing: *connect the cards, read every
transaction individually*. Analysis happens in his CFO chat in the Claude app,
not in the site. Do not add tools he did not ask for.

## The two apps

| | Alfred monitor | Alfred CFO |
|---|---|---|
| URL | `matheodeeb.github.io/alfred/` | `matheodeeb.github.io/alfred/cfo/` |
| File | `index.html` | `cfo/index.html` |
| Table | `public.items` | `public.cfo_items` |
| Storage keys | `alfred_*` | `cfo_*` |
| At rest | plaintext | **encrypted** |
| Local cache | localStorage mirror | **none — memory only** |

Both live in this one repo and deploy together via GitHub Pages. They share an
origin, which is why every storage key had to be renamed — `localStorage` is
per-origin, not per-path.

**The monitor's Finances tab stays exactly as it is.** He was explicit: don't
remove it, don't rewire it. The CFO site was seeded *from* that data conceptually,
not wired *to* it. The two will drift, and that is accepted.

---

## Where things stand (4 Sep 2026)

**Built and live:**

- `cfo/index.html` — six pages lifted from the monitor's Finances tab: CFO
  dashboard, Cash, Statements, Transfers, Subscriptions, Investments.
- The vault: AES-GCM row encryption, PBKDF2 key derivation, passphrase gate.
- Dark identity: obsidian ground, indigo primary, mint/rose for gains and losses,
  Sora over IBM Plex Mono. Alfred's CSS is entirely token-driven, so this was a
  palette swap, not a rewrite — keep it that way.
- `cfo/sw.js` — caches the shell, never the data.

**Not done yet:**

- ~~The `cfo_items` table does not exist.~~ **Created**, with an RLS policy matching
  the one on `public.items` (same shared secret), plus an index on `up` for sync.
- No data has been imported. The app is empty.
- No recovery codes. **A forgotten passphrase currently means permanent loss** —
  he has been told to set only a throwaway passphrase until this is built.
- No Plaid. No transactions page.

---

## The vault — do not weaken this

The whole point of the separate site. A session that "simplifies" any of the
following has broken the feature.

| Step | What | Why |
|---|---|---|
| 1 | Passphrase → master key, PBKDF2-SHA256, **600,000 iterations** | Guessing must cost real time even with the database in hand |
| 2 | Master key wraps a random 256-bit **data key** | Changing the passphrase rewraps one blob instead of re-encrypting every row |
| 3 | Row payload encrypted AES-256-GCM, **fresh 96-bit IV per write** | Nonce reuse under GCM is catastrophic — never derive it, always random |
| 4 | **AAD = `id ‖ sec ‖ up`** | Binds a blob to its own row: it cannot be moved onto another id or rolled back to an older version. Verified — both are refused |
| 5 | Only `{v, iv, c}` leaves the device | Supabase stores a blob it cannot read |

- The passphrase is **never stored and never sent**. Verified: it appears nowhere
  in `localStorage`.
- The wrapped key lives in `localStorage.cfo_vault` **and** in a `cfg:vault` row,
  so a second device can join the same vault with the same passphrase.
  `cfg:vault` is the one row that must never be encrypted — it is the wrapper.
- The unwrapped key is cached in `sessionStorage` for the tab's lifetime only.
- **No local plaintext.** `load()` returns an empty store and `writeStore()` is a
  no-op; the app re-pulls on every load. This costs offline use and a round trip
  at startup, and that was the deliberate trade — a plaintext mirror of bank
  transactions in `localStorage` would have undone the encryption for anyone who
  opens the browser.
- The monitor's `#cfg=` setup-by-link scheme **was not carried over**. It puts the
  sync secret in a URL, and URLs end up in history and screenshots.

### The SQL he still needs to run

```sql
create table if not exists public.cfo_items (
  id text primary key, sec text,
  data jsonb default '{}'::jsonb,
  up bigint default 0, del boolean default false
);
alter table public.cfo_items enable row level security;
create policy "cfo access" on public.cfo_items for all
  using  (current_setting('request.headers',true)::json->>'x-alfred-key' = 'THE-SECRET')
  with check (current_setting('request.headers',true)::json->>'x-alfred-key' = 'THE-SECRET');
```

---

## The plan, in order

Phases 1–4 are the hardening; 5 onward is the feature. **The order is the
argument** — identity before encryption, both before bank data.

| # | Work | Effort | Why here |
|---|---|---|---|
| 1 | **Recovery codes** + a decrypt-and-copy export button | a session | Blocks everything: no real passphrase until loss is survivable |
| 2 | **Importer** — pull the monitor's finance rows, write them encrypted | a session | Gets the site out of its empty state |
| 3 | **Supabase Auth** — passkey sign-in, RLS on `auth.uid()`, retire the shared secret | half a day | Biggest security gain for least work |
| 4 | **Content security policy** + escape audit | an evening | Cheap; do it before there is anything valuable to steal |
| 5 | **Opaque row ids** for encrypted sections | a session | See the finding below — must precede any wider encryption |
| 6 | **Auto-lock** — the PIN holds the key, locking wipes it | an evening | Only meaningful once rows are encrypted |
| 7 | **Plaid**: sandbox → one card → the rest | 2–3 sessions | Now the data has somewhere safe to land |
| 8 | **Transactions page**, grouped by statement cycle | a session | The feature itself |
| 9 | Statements page fills itself from the feed | a session | The payoff — hand-entry disappears |

### Plaid, decided

- **No card number ever goes in the app.** Storing one drags the whole thing into
  PCI scope and tells you nothing about spending. You connect a read-only feed.
- **Plaid Trial plan**: free, up to 10 connected accounts, unlimited calls on
  them, Transactions + Liabilities included, OAuth to Amex, Citi and Wells Fargo
  by name. Debit works through the same connection. Confirm terms at signup.
- **It needs a server** — Plaid's secret cannot live in a public page. A Supabase
  edge function, made stateless and blind: the Plaid token is stored **encrypted
  with the data key** like any other row, and the browser passes it in for one
  call. The function keeps nothing. At rest the server holds nothing usable.
- **Two accepted costs**: no background sync (the key is only present when he has
  the app open), and a moment where transactions are readable in the function's
  memory during a sync he started. The second is unavoidable with any aggregator.
- **What no encryption fixes**: connect Plaid and Plaid has his transaction
  history. Say so plainly; do not let a security discussion imply otherwise.

### A finding that will bite

**Alfred's row ids are descriptive** — `travel:past:2016-08:oahu-hawaii`,
`jersey:spain-2026-away-yamal`. Encrypting a payload while leaving an id that
spells out its contents is theatre. Any section that gets encrypted needs opaque
random ids first. Easy to miss; it is step 5 for that reason.

---

## Open questions only he can answer

1. **Does his CFO chat keep direct database access, or work from exports?**
   The one real trade left. That chat reads his figures out of Supabase the same
   way a session does; encrypting the rows blinds it. The proposed answer is an
   export button — decrypt in the browser, copy a slice to the clipboard, paste
   into the chat. He has not chosen yet.
2. **Where the recovery codes will physically live.** Phase 1 does not start
   until there is somewhere that is not a device.
3. ~~**Payroll.**~~ **Answered.** Kept, and now reachable — `payroll` was in
   `MODS` but missing from `NAV`, so the page could not be opened and the
   overview's `go('payroll')` card led nowhere. It is in `NAV` now.
   He does not pay any staff today; he wants the section in place for when he
   does. So the burn keeps reading `list('payroll')` and it contributes **$0**
   until he adds someone — the "money out" breakdown already hides a zero line,
   so nothing shows until it is real. Do not "fix" the burn by deleting this.
4. **How much history on the first Plaid pull** — up to 24 months.
5. **Whether the Haiti accounts are in scope.** Plaid is US/Canada; BUH stays
   hand-entered regardless, which shapes how a transactions page handles two
   currencies.
6. From the original CFO tab, still open: whether the large monthly card payments
   are his own living costs or business/family spend that gets reimbursed. This
   changes the reading of everything else and no register can infer it.

---

## Inherited from the CFO tab — things that will bite you

The CFO dashboard code came across unchanged, so all of this still applies.

- **Debt balances are stored positive** here ("what you owe"), the opposite of
  `fincash` group `Credit`, which stores negatives. Don't unify them.
- **`cfoPayoff(ordered, extra)`** holds the budget fixed at total-minimums + extra,
  so a cleared debt's minimum rolls onto the next. That roll-up *is* the
  avalanche/snowball strategy. The **caller** picks the order; the function only
  does arithmetic. It returns `ok:false` past 600 months — surface that, don't hide it.
- **The dashboard writes nothing another page owns.** Cash, subscriptions,
  payroll, investments and assets are read where they live. Keep it that way.
- **The FAB accepts a function.** `SPECIAL.cfo.fab` returns `null` on the dashboard
  and the register key elsewhere.
- **A `const` must never go inside the `MODS` object literal** — it is an object,
  not a block, and doing it silently blanks the whole app.
- Anything referenced from a `MODS` *field definition* is evaluated at load and
  must be declared above `MODS`. Helper *functions* hoist and can live below.
  This has caused three temporal-dead-zone outages; the test catches it every time.

### Transactions

`tx` is the per-purchase ledger and the reason the app exists. Everything else says
what a card was **paid**; only this says what was **bought**, which is the only thing
that can be cut.

- **Grouped by statement cycle, not calendar month.** `txStmtDay()` reads the card's
  `stmtDay` off its Cash row, so the rows under a heading are exactly the purchases
  that produced that bill. A transaction on the statement day belongs to that cycle;
  the day after rolls to the next. An account with no statement day falls back to the
  calendar month.
- `TXKEY` maps group label → sort key. `group()` fills it as labels are built and
  `groupOrder()` reads it back, because **groupOrder receives label strings, not rows.**
- **`cfoTxMo()` excludes the `Subscriptions` category on purpose.** Subscriptions are
  already counted from the subscriptions page and *also* land on the card as
  transactions. Counting both bills him twice for Netflix. Don't "fix" this.
- The dashboard prefers `cfoTxMo()` over the hand-typed `spend` register whenever any
  transactions exist.
- The importer reads Citi, Amex and Wells Fargo exports without being told which is
  which: a date is whichever cell parses as one, the amount is the last cell that
  parses as a number, the description is the longest cell that is neither. Wells Fargo
  signs purchases negative — hence the flip checkbox. Nothing is written until previewed.

### The CFO app holds finance only

It was forked from the monitor and carried the whole thing — jerseys, perfume,
recipes, travels, shows, bathroom stock. None of it was reachable and all of it sat
inside the app holding the most sensitive data. 24 sections and 6 uncalled page
functions are gone; the file went 3,141 → 2,690 lines before the transactions work.
**Do not port a non-financial section back in.**

### Importing from the monitor, and why it runs in the browser

`monScan()` / `monImport()` on the CFO dashboard lift the financial rows out of
`public.items`. **This must never be done as SQL on the server.** `decRow()` returns
any row without a `c` field unchanged, so a server-side copy lands in `cfo_items` as
readable JSON and sits there in plaintext until each row is next edited — the exact
thing this app exists to prevent. Only the browser holds the data key, so writing
through `put()` is what makes the rows arrive encrypted. Verified end to end: what
reaches the server is `{v,iv,c}` and nothing else.

Ids are preserved, existing rows are never overwritten, tombstones are skipped, and
re-running is a no-op.

### Plaid

The `plaid` edge function is deployed and ACTIVE. It is **stateless and blind**: it
never stores an access token and never touches the database. The browser keeps the
token encrypted in an ordinary row, unwraps it, and passes it in for one call.

Actions: `link_token`, `exchange` (returns the access token to the *browser*, which
encrypts it), `sync` (incremental via cursor; the cursor also lives in the encrypted
row).

Auth: the Supabase anon key is public and proves nothing, so the real gate is an
`x-alfred-key` header compared against the `ALFRED_KEY` env var in constant time.

Required env vars on the function — set in the Supabase dashboard, never in this repo:
`PLAID_CLIENT_ID`, `PLAID_SECRET`, `PLAID_ENV`, `ALFRED_KEY`.

**Sandbox keys cannot reach real banks.** Plaid's sandbox only connects to its own
fake institutions with `user_good` / `pass_good`. Citi, Amex and Wells Fargo need
production access (or the free trial's production connections). Do not spend time
debugging why a real bank will not appear on sandbox credentials.

### Net liquid vs net worth

He drew this himself. **Net worth** is everything. **Net liquid** is only what his
own behaviour moves: banking, physical bills, Haiti balances, brokerage, less
revolving debt. Watches and property are gifts and appreciation — counting them in
a savings goal flatters the number and hides whether the plan is working.

`cfoNetLiquid()` is the goal basis and **excludes `assets` entirely**. A goal row
can set `track: 'Net liquid — live'` and read from it instead of a typed figure;
anything summing goal progress must honour that flag.

**The `assets` row whose `src` is `Investment log` mirrors the brokerage.** Net
liquid already carries the brokerage, so any net-worth sum must filter that row out
or it double-counts. This bit once.

### Property and windfalls

`prop` reaches the cash-flow figures **only** at status `Renting` — `propLive()`
gates every sum, so a `Pending transfer` is context and contributes nothing. That
pause was asked for; don't start counting a house he does not hold. `propNet()` is
gross rent minus tax, insurance, HOA, maintenance, management and vacancy,
normalised monthly — gross rent is never income.

Bonuses arrive as irregular family gifts with no pattern and he does not want one
inferred. Cadence `One-off` maps to 0 in `CFO_CYC` and stays out of monthly income.
Expect unexplained jumps in the cash rows; usually this.

---

## Reading his real data

SQL against `public.items` in the Supabase project bypasses RLS, so the
`x-alfred-key` secret is not needed. **Once `cfo_items` is encrypted, this stops
working for those rows** — that is the entire point, and is question 1 above.

- Filter `not coalesce(del,false)`; tombstones are kept.
- `data` is jsonb with string values — cast via `(nullif(data->>'amt',''))::numeric`.
- Writing server-side: set `up = extract(epoch from now())*1000`, or a stale
  device copy wins on the next sync (last-write-wins on `up`).
- Never test against his live rows. A test tick once left a tombstone that killed a
  real reminder. Use throwaway ids, or verify by reading.

---

## Ground rules

- **This repo is public.** No balances, no income, no account numbers, no card
  figures in any file. A line quoting his real card spend nearly shipped inside an
  empty-state string once and was caught at the last check before push. Scan your
  own diff before every push. Personal numbers live only in the private Supabase.
- **The Supabase secret has not been rotated.** He decided that deliberately and
  asked to be reminded when a change made it matter. Phase 3 is that moment —
  when auth lands, the old key becomes unnecessary and should be revoked the same day.
- Deploy: edit → commit → push to `main` → GitHub Pages, ~40–60s. No build step.
  The service worker caches hard; hard-reload to see changes.
- **He is not asking for investment advice and should not be given any.**
  Budgeting, cash-flow design, payoff math, net-worth tracking, scenario
  modelling — yes. Which securities to buy — no.

## Environment notes

Things a cloud session will hit and waste time on otherwise.

- **`execute_sql` on the Supabase MCP returns "requires approval" and the approval
  never arrives** in remote sessions. Read-only tools (`list_tables`, `get_advisors`)
  work. So: hand him SQL to run, then verify with the read-only tools.
- **Egress is filtered.** `matheodeeb.github.io`, `plaid.com`, `justalba.com` and
  most retail sites are blocked. Never verify a deploy with curl — it will report a
  false failure. Use the GitHub Actions API (workflow id `316932437`) instead.
- **Browser tests**: `python3 -m http.server 8099 --bind 127.0.0.1 --directory
  /home/user/alfred`; Playwright at `/opt/node22/lib/node_modules/playwright`;
  Chromium at `/opt/pw-browsers/chromium-1194/chrome-linux/chrome`. Seed state with
  `page.addInitScript` — setting `localStorage` after `goto` gets overwritten.
  The monitor's PIN is dismissed with
  `document.getElementById('lock').classList.remove('show')`.
- **Squash merges rewrite history**, so the working branch needs
  `git rebase --onto origin/main <old-head>` before the next PR or it conflicts.

## Cadence

Monthly close plus a weekly check.
