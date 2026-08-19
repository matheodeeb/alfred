# The daily brief: how the network actually works

**Read this before writing a brief, on any machine.** It is the single shared source of truth for
a system that runs on three different computers whose private instructions drift apart. It lives
in the repo precisely because the repo is the *only* channel all three runners share.

Last verified: **19 August 2026**.

---

## 1. Why this file exists

The brief is written by three runners, and **each one carries its own private copy of the
instructions**:

| Runner | Its instructions live in | Syncs with the others? |
|---|---|---|
| Cloud routine `trig_01RcKHHVXKPVsu2yTvzcpurZ` | the trigger's prompt, edited by hand in the Claude app | **no** |
| Mac mini | `~/.claude/scheduled-tasks/economist-daily-brief/SKILL.md` | **no** |
| MacBook Pro | its own copy of that same path | **no** |

`~/.claude` is not in git, and the cloud trigger was created through the HTTP API so an agent
cannot edit it — only Matheo can. A fix applied in one place reaches neither of the others. This
has already caused visible regressions:

- **18 Aug** — the Mac mini wrote the brief with no `source` field, because only the MacBook and
  the cloud had been told about it.
- **19 Aug** — the cloud's prompt had been rewritten into a WebSearch-only version that dropped
  the Economist step, and separately still *opened* with "READ THE ECONOMIST FIRST" while the
  runner could not reach the site, so it burned two tool calls on a host it cannot load.

**The rule:** when you change how the brief is written, change **all three** copies in the same
sitting, and update this file. If you can only reach one, say so explicitly in your report so the
gap is visible instead of silent.

**Canonical copies of the three prompts live in `routines/`.** They are the source; the machines
hold pasted copies. Credentials are redacted there — this repo is public.

---

## 2. The three runners are not interchangeable

This is the single most important fact in this document.

| | Cloud | Mac mini | MacBook |
|---|---|---|---|
| Always awake | **yes** | only if awake + Claude app open | only if awake + app open |
| Can reach economist.com | **no** | **yes**, via Chrome | **yes**, via Chrome |
| Database access | `mcp__Supabase_Alfred__execute_sql` (curl is 403'd) | curl REST works | curl REST works |
| Writes row | `brief:DATE` | `brief:DATE:local` | `brief:DATE:local` |
| Its lock | `briefclaim:DATE:cloud` | `briefclaim:DATE:local` | `briefclaim:DATE:local` |
| Source it may write | `own` only | `economist` / `mixed` | `economist` / `mixed` |

### Getting to The Economist — the full matrix

Tested repeatedly on 19 Aug 2026. **Do not spend a run rediscovering this.**

| Route | Result |
|---|---|
| `WebFetch` from a Mac | refused: "Claude Code is unable to fetch from www.economist.com" |
| `WebFetch` from the cloud | two runs both reported `economist.com unreachable, 0 of 15 stories` |
| In-app Browser pane (`mcp__Claude_Browser__`) | "blocked by policy and cannot be opened" |
| **Real Chrome (`mcp__claude-in-chrome__*`)** | **works — the only route that loads the page** |
| Economist newsletter → Gmail | zero Economist mail in the account, any date |

Two consequences worth internalising:

1. **Neither runner can do the whole job alone.** The cloud is always awake but can never write
   better than `own`. A Mac can write `economist` but may be asleep. So they publish **side by
   side** — see §3.
2. **Matheo being logged in does not help the cloud.** The cloud never had his cookie and cannot
   load the page regardless. The tell is in the failure mode: signed-out Chrome still returns
   *1 of 8* stories, whereas the cloud returns *nothing*. Truncation means paywall; nothing means
   transport. Do not confuse the two.

> Historical note: a cloud run on 16 Aug 2026 *did* produce a real Economist edition (58 article
> links, full lineup). Whatever allowed that has since closed. Treat it as history, not as
> something to retry.

### Reading it, on a Mac

```
mcp__claude-in-chrome__navigate  → https://www.economist.com/the-world-in-brief
mcp__claude-in-chrome__get_page_text
```

Check the session is alive. Signed out you get the first story and then *"Already have an
account? Log in"*. Signed in you get the whole bulletin, and articles show
*"Listen to this story / ai narrated"*.

**If it is signed out: do not log in and never type credentials.** Write nothing, and report that
the session needs re-authenticating (§3).

Use `read_page` with `filter: interactive` on the homepage to collect the day's article headlines
*with* their URLs — you need those for the closing lineup section.

Summarise their reporting **in your own words and credit them**. Never paste Economist paragraphs
into the brief; it is Matheo's subscription to read, not to republish.

---

## 3. Two rows, one switch — not a relay

Each runner owns its **own row** and never touches the other's.

| Row | Written by | Source | Meaning |
|---|---|---|---|
| `brief:DATE` | Cloud, 05:00 | always `own` | the guarantee — exists every morning |
| `brief:DATE:local` | a Mac, 05:45 / 06:15 | `economist` or `mixed` | the paper he pays for, when a Mac was awake |

The app renders a switch at the top of the brief page — **Wires** and **The Economist** — and
**defaults to the Economist row whenever it exists**. If only one exists, there is no switch and
that one is shown.

This replaces the earlier *relay*, in which a Mac overwrote the cloud's row. The relay is retired
and its machinery — `briefupgrade:DATE`, the upgrade decision tree, the 06:30 rewrite cutoff — is
**gone**. Nothing should reference them. Three problems went with it:

- a Mac waking at 05:45 into a half-written cloud row had to guess whether the cloud had failed;
- an upgrade finishing after 06:00 rewrote a brief he had begun reading, scrambling read-marks,
  which are stored by paragraph position;
- one bad Mac run destroyed the only copy of the day.

Because the rows are separate, **no runner needs to know anything about the others' state.** The
cloud writes unconditionally. A Mac checks only whether `brief:DATE:local` already exists.

### The rule that defines a Mac's job

**If it cannot read The Economist, it writes nothing at all.** A wire-researched `:local` row
would duplicate the cloud's and put two identical things in the switch. `brief:DATE:local`
existing must always mean "this was read on economist.com". Standing down is a clean outcome.

### 3.1 The claim mechanics

Exactly one runner may write a given row. The lock is the primary key on `items.id`.

1. **Claim** — a plain insert of the runner's own lock id, no upsert (an upsert defeats the lock).
   `201`/row returned → you own it. `409`/no row → someone else does.
2. **Steal only a dead claim** — conditional update filtered on
   `status <> 'done' AND up < now - staleness`. A returned row means you took over; `[]` means
   stop immediately and report *"already handled by &lt;worker&gt;."*
   **That is a success, not a failure.**
3. **Heartbeat while you work** — re-stamp `up` after research, after the three editions, and
   after the lexicon. `up` must mean "last sign of life", not "when I started".
   **Compute a fresh timestamp at each write.** Capturing `NOW` once at the top of the run and
   reusing that one value everywhere — including for the release — is the same bug wearing a
   heartbeat's clothes: the row reads as an hour stale the instant you write it. The cloud run of
   19 Aug 2026 did exactly this and released a `done` claim stamped 45 minutes in the past.
   In SQL that is `up = (extract(epoch from now())*1000)::bigint`, evaluated then and there.
4. **Release** — set `status: done` only after the brief row *and* both lexicon rows are written.
   `done` is permanent; the steal filter can never take it back.

**On failure, leave the claim `running` and do not delete it.** A later runner finds it stale and
finishes. Deleting it would let two machines start at once.

---

## 4. What gets written

Rows that may ever be written: `briefclaim:DATE:cloud`, `briefclaim:DATE:local`, `brief:DATE`,
`brief:DATE:local`, `lexicon:fr`, `lexicon:es`.
`vocab:saved` is **read-only** — it belongs to the app, and overwriting it would destroy words
Matheo saved on another device. Never delete anything.

**Never write the other side's brief row.** The cloud writing `brief:DATE:local` would destroy his
Economist edition; a Mac writing `brief:DATE` would destroy his safety net.

### `brief:DATE` / `brief:DATE:local`

`date`, `title`, `body`, `title_en`/`body_en`, `title_fr`/`body_fr`, `title_es`/`body_es`,
`langs: ["en","fr","es"]`, `edition` (`cloud` or `local`), plus:

- **`source`** — exactly `economist`, `mixed`, or `own`. **Nothing else.** The app looks the value
  up in a map (`BRIEF_SRC`) and renders *nothing* on a miss, so a plausible-looking
  `"The Economist"` silently produces no source line at all. That exact mistake is what made it
  look broken.
- **`source_note`** — a short phrase with the count, e.g.
  `8 of 8 world-in-brief stories plus 2 features read in full on economist.com`.

`title`/`body` must equal `title_en`/`body_en`. All three bodies are required. **Never label a
search-assembled edition `economist`** — Matheo uses this label precisely to tell the paper he
pays for from a search digest, so a flattering label destroys the only thing it does.

### The three editions

Written natively, never translated: The Economist in English, *Le Monde*/*Les Échos* in French,
*El País*/*Expansión* in Spanish, with each language's own number formatting and quotation marks.
Each gets its own ≤60-character headline written in that language.

**They must be block-parallel.** The app pairs paragraphs across *languages* by position, for both
the shared read-marks and the "same paragraph in English" panel. Same section kickers, same report
headlines, same paragraph count, same order. Sentences *inside* a paragraph need not correspond —
that is where each language should sound like itself. The app degrades safely when counts differ,
but the feature is lost.

Read-marks are shared across the three *languages* of one edition, and deliberately **not** shared
between the wires and Economist editions — those are different reporting with different paragraph
counts, so a shared tick would mark a story he never read.

Close with `## The Economist today` — one markdown link per line, `[headline](url)`. The app
renders http/https links as tappable. **The cloud never writes this section**; it belongs to an
Economist-sourced edition.

### The lexicon and saved words

Both editions merge into the same `lexicon:fr` / `lexicon:es`. Merges are additive and a Mac may
add an hour after the cloud, so **always re-read the rows immediately before merging** rather than
working from a copy pulled earlier in the run.

Definitions accumulate permanently; each morning define only what is *new*. Shape:
`data.w = {headword: {p, e, d}}` — `e` is the closest English word, `d` is a real definition,
because Matheo often knows the equivalent and still does not know what it means.

**His saved words come first.** Words he taps and saves land in `vocab:saved`
(`data.w = [{w, l, d}]`). Any without a lexicon entry show a bare dash in his saved-words list.
Define every one the lexicon does not cover, **before** the day's harvested words, and **exempt
from every filter** — not the 4-letter minimum, not the everyday-word stop-list. `où` gets an
entry because he asked for it, however common it is.

The row is live: it appeared on 19 Aug 2026 holding seven French words, two of which
(`hypothétique`, `raréfient`) had no entry and were showing him a dash. Both are now defined.

**Key saved words on the exact surface form he saved.** `wtStem` is lossy in both directions:
`faucons` stems to `fauc` while `faucon` stems to `faucon`, so they never meet and a base-form
entry is unreachable from the plural he tapped. Exact match is tried first, so the saved form
always hits.

For harvested words, test membership the way the app does — exact, then de-elided, then stem —
porting `wtStem`, `wtDeElide`, `wtDeaccent` and `WT_SUF` out of `index.html` rather than inventing
a stemmer. Expect roughly 40–60 genuinely new words per language. 250+ means the stop-list is too
thin; under 10 means you over-filtered.

Merge only the new words into the row; never resend the whole map. If the lexicon read fails, skip
the step entirely rather than overwriting with a partial map, and say so.

Two footguns, both tripped on 19 Aug 2026:

- **Recompute `n` from the merged map, then verify it.** If the merge and the count are split into
  two statements, the count in the second one still sees the *old* map and `n` silently drifts
  below the real key count. Either do both in one statement, or set `n` afterwards from what is
  actually there and check the two agree.
- **Test coverage against the full key list, not a shortcut.** Narrowing the existing headwords by
  prefix before stemming them is *not* equivalent to the app's exact → de-elided → stem chain: a
  stored key can stem onto your candidate without sharing its prefix. That shortcut silently
  overwrote three existing Spanish entries. If you cannot test the whole list, skip the doubtful
  word — a missing entry costs one dead tap, a redefinition destroys a definition he already had.

---

## 5. Timing

All America/New_York.

| Runner | Fires | Writes |
|---|---|---|
| Cloud — "Economist Daily Brief - Cloud" | **05:00**, 07:00 retry | `brief:DATE` |
| Mac mini — "Economist daily brief - Local" | **05:45**, then 08:00 / 10:00 | `brief:DATE:local` |
| MacBook — "Economist daily brief - Local" | **06:15** | `brief:DATE:local`, if the mini didn't |

The Macs need `sudo pmset repeat wakeorpoweron MTWRFSU 05:40:00` and the Claude app left running,
or they simply never fire and only the cloud's edition exists — which is a perfectly good morning,
just without the switch.

Because the rows are separate, **overlap is now harmless**. A Mac starting while the cloud is still
writing costs nothing; a Mac finishing after he has started reading adds a second edition rather
than rewriting the one in front of him. The old "never claim before 07:30" and "never upgrade after
06:30" rules are both **retired** — they existed only to protect a single shared row.

Cloud cron verified 19 Aug 2026: `0 9,11 * * *` **UTC** = 05:00 / 07:00 ET while EDT is in effect.
**It will drift to 04:00 / 06:00 ET when the clocks go back on 1 Nov 2026** — cron is stored in UTC
and does not follow New York. Re-point it to `0 10,12 * * *` that week, or the cloud starts an hour
early all winter.

---

## 6. Before you publish — assert, don't hope

- all three headlines ≤ 60 characters
- `source in ('economist','mixed','own')`, and matching the runner (`own` for the cloud only)
- `edition` matches the row id (`cloud` ↔ `brief:DATE`, `local` ↔ `brief:DATE:local`)
- the three bodies have **equal block counts and the same sequence of block kinds**
- `up` is an **integer** millisecond timestamp — a float (`1787144300007.0`) is rejected by
  Postgres with `invalid input syntax for type bigint`
- read the row back and confirm all three bodies are non-empty and `source` survived

If an assertion trips, **fix the editions and re-check**. Do not skip it and do not publish
unbalanced editions.

---

## 7. Mistakes already made, so you don't repeat them

| Mistake | What happened | The lesson |
|---|---|---|
| Free-text `source` | `"The Economist"` renders nothing; only the 3-value enum works | check the app's actual reader before inventing a field value |
| Fixing one runner | 18 and 19 Aug both regressed | change all three copies, or name the gap in your report |
| Trusting one data point | The 16 Aug cloud success was used to conclude the cloud could read The Economist; two direct tests said otherwise | prefer a direct test today over a successful run last week |
| Confusing paywall with block | signed-out Chrome truncates; the cloud gets nothing | truncation ≠ unreachable |
| Assuming the app can see saved words | `alfred_vocab` was localStorage-only and never left the phone | if a writer must act on something, it has to be in a synced row |
| Voice mistaken for sourcing | the brief is always in The Economist's register, sourced or not | only `source` can answer "where did this come from" |
| One `NOW` for the whole run | 19 Aug: the cloud stamped its release with the timestamp it captured 45 min earlier, so a healthy run looked dead | a heartbeat is only a heartbeat if the clock is read again |
| An unmarked override | the cloud's prompt opens "READ THE ECONOMIST FIRST" and the prepended block did not say it overrode that, so the run obeyed whichever it read last | when two instruction blocks are concatenated, say in the newer one which parts of the older it replaces |
| Prefix-narrowing the lexicon before stemming | 3 Spanish entries silently redefined | replicate the app's lookup chain exactly, or skip the word |
| Assuming the repo checkout is current | 19 Aug: the cloud container had cloned *before* `BRIEF-NETWORK.md` was pushed, so the file it was told to read was simply absent | fetch before you read; "it is checked out for you" is not "it is up to date" |
| Credentials in a public repo | the routine files carry a live `x-alfred-key`; the repo is public | redact before committing — the machines keep the real values in their own `SKILL.md` |

---

## 8. Related app internals

- `briefEds()` / `briefPick()` / `briefEdBar()` / `briefsSorted()` in `index.html` — the two-row
  switch, the default-to-Economist rule, and one archive card per day
- `briefReadKey(date, ed)` — read-marks, per edition, wires keeping the legacy unsuffixed key
- `briefSource()` / `BRIEF_SRC` — renders the source line, strict 3-value map
- `vocabMirror()` — mirrors saved words into `vocab:saved`
- `vocabDef()` — looks a saved word's meaning up **live**, so a dash fills itself in the morning
  the lexicon gains the word, with no migration
- `mdBlocks()` / `inline()` — block splitting and `[text](url)` rendering (http/https only)
- `wtLookup()` / `wtStem()` / `wtLexIndex()` — tap-to-understand lookup chain, reading the edition
  currently on screen via `WT.bid`

**Known open bug:** the `wtStem` asymmetry above also affects tapping words in the brief itself —
a tap on `faucons` finds nothing even when `faucon` is defined. Worked around for saved words;
not yet fixed at source.
