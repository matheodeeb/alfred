# The daily brief: how the network actually works

**Read this before writing a brief, on any machine.** It is the single shared source of truth for
a system that runs on three different computers whose private instructions drift apart. It lives
in the repo precisely because the repo is the *only* channel all three runners share.

Last verified: **19 August 2026**.

---

## 1. Why this file exists

The brief is written by whichever of three runners claims the day first, and **each one carries
its own private copy of the instructions**:

| Runner | Its instructions live in | Syncs with the others? |
|---|---|---|
| Cloud routine `trig_01RcKHHVXKPVsu2yTvzcpurZ` | the trigger's prompt (edit with `RemoteTrigger`) | **no** |
| Mac mini | `~/.claude/scheduled-tasks/economist-daily-brief/SKILL.md` | **no** |
| MacBook Pro | its own copy of that same path | **no** |

`~/.claude` is not in git. A fix applied on one machine reaches neither of the others. This has
already caused two visible regressions:

- **18 Aug** — the Mac mini wrote the brief with no `source` field, because only the MacBook and
  the cloud had been told about it. Matheo saw no source line and reasonably concluded nothing
  had been fixed.
- **19 Aug** — the cloud's prompt had been rewritten the previous afternoon into a WebSearch-only
  version that dropped the Economist step entirely. It produced a search digest.

**The rule:** when you change how the brief is written, change **all three** copies in the same
sitting, and update this file. If you can only reach one, say so explicitly in your report so the
gap is visible instead of silent.

---

## 2. The three runners are not interchangeable

This is the single most important fact in this document.

| | Cloud | Mac mini | MacBook |
|---|---|---|---|
| Always awake | **yes** | only if awake + Claude app open | only if awake + app open |
| Can reach economist.com | **no** | **yes**, via Chrome | **yes**, via Chrome |
| Database access | `mcp__Supabase_Alfred__execute_sql` (curl is 403'd) | curl REST works | curl REST works |
| Best it can produce | `source: own` | `source: economist` | `source: economist` |

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
   better than `own`. A Mac can write `economist` but may be asleep. So they run as a **relay**,
   not as rivals — see §3.
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

**If it is signed out: do not log in and never type credentials.** Fall back to research, set
`source: own`, and say so in your report so Matheo knows to re-authenticate.

Use `read_page` with `filter: interactive` on the homepage to collect the day's article headlines
*with* their URLs — you need those for the closing lineup section.

Summarise their reporting **in your own words and credit them**. Never paste Economist paragraphs
into the brief; it is Matheo's subscription to read, not to republish.

---

## 3. Two editions a day, side by side

**Nothing overwrites anything.** Each runner writes its own row, and the app shows a switch at the
top of the brief page.

| Row | Written by | When | Source | Meaning |
|---|---|---|---|---|
| `brief:DATE` | Cloud | 05:00 ET | always `own` | the guarantee — exists every single day |
| `brief:DATE:local` | Mac mini, else MacBook | 05:45 / 06:15 ET | `economist` or `mixed` | the paper he pays for |

The switch reads *Wires* / *The Economist* and **defaults to the local edition whenever it
exists**, because The Economist is his stated priority. On mornings when no Mac was awake there is
no switch at all and he reads the cloud's — which is exactly what it is for.

Two rules keep this honest:

1. **The cloud writes every day, unconditionally.** It never checks whether a Mac might do better
   and never stands down in favour of one. Its brief is what he reads on every morning a Mac was
   asleep, which historically is most of them.
2. **A Mac writes ONLY if it actually read The Economist.** If Chrome's session is dead it writes
   nothing at all, rather than a wire-sourced duplicate of the cloud's. `brief:DATE:local` existing
   must always mean "this was read on economist.com" — that is what makes the switch meaningful.

Each side has its own lock, and neither may touch the other's:

| Lock | Owner |
|---|---|
| `briefclaim:DATE:cloud` | the cloud, so its 07:00 retry does not redo a good 05:00 run |
| `briefclaim:DATE:local` | the two Macs, so they do not both write the Economist edition |

Read-marks are stored **per edition** (`alfred_briefread_DATE` for the cloud, `..._local` for the
Economist one). The two are written from different material and do not run block-parallel *with
each other*, so a tick at paragraph 7 of one means nothing at paragraph 7 of the other.
Block-parallelism still applies **within** an edition, across its three languages.

### 3.1 The claim mechanics

Exactly one runner may write a given leg. The lock is the primary key on `items.id`.

1. **Claim** — a plain insert of `briefclaim:DATE`, no upsert (an upsert would defeat the lock).
   `201`/row returned → you own the day. `409`/no row → someone else has it.
2. **Steal only a dead claim** — conditional update filtered on
   `status <> 'done' AND up < now - staleness`. A returned row means you took over; `[]` means
   stop immediately and report *"brief already handled by <worker> — nothing to do."*
   **That is a success, not a failure.** Do not research, do not write, do not touch the lexicon.
3. **Heartbeat while you work** — re-stamp `up` after research, after the three editions, and
   after the lexicon. `up` must mean "last sign of life", not "when I started", or a healthy run
   gets robbed for merely taking a while. A full run takes roughly 50 minutes.
4. **Release** — set `status: done` only after the brief row *and* both lexicon rows are written.
   `done` is permanent; the steal filter can never take it back.

**On failure, leave the claim `running` and do not delete it.** A later runner finds it stale and
finishes the day. Deleting it would let two machines start at once.

---

## 4. What gets written

Rows a runner may write: its own lock (`briefclaim:DATE:cloud` **or** `briefclaim:DATE:local`),
its own brief row (`brief:DATE` **or** `brief:DATE:local`), `lexicon:fr` and `lexicon:es`.
`vocab:saved` is **read-only** — it belongs to the app, and overwriting it would destroy words
Matheo saved on another device. Never delete anything.

### `brief:DATE`

`date`, `title`, `body`, `title_en`/`body_en`, `title_fr`/`body_fr`, `title_es`/`body_es`,
`langs: ["en","fr","es"]`, plus:

- **`source`** — exactly `economist`, `mixed`, or `own`. **Nothing else.** The app looks the value
  up in a map and renders *nothing* on a miss, so a plausible-looking `"The Economist"` silently
  produces no source line at all. That exact mistake is what made it look broken.
- **`source_note`** — a short phrase with the count, e.g.
  `8 of 8 world-in-brief stories plus 2 features read in full on economist.com`.

`title`/`body` must equal `title_en`/`body_en`. All three bodies are required. **Never label a
search-assembled edition `economist`** — Matheo uses this label precisely to tell the paper he
pays for from a search digest, so a flattering label destroys the only thing it does.

### The three editions

Written natively, never translated: The Economist in English, *Le Monde*/*Les Échos* in French,
*El País*/*Expansión* in Spanish, with each language's own number formatting and quotation marks.
Each gets its own ≤60-character headline written in that language.

**They must be block-parallel.** The app pairs paragraphs across languages *by position*, for both
the shared read-marks and the "same paragraph in English" panel. Same section kickers, same report
headlines, same paragraph count, same order. Sentences *inside* a paragraph need not correspond —
that is where each language should sound like itself. The app degrades safely when counts differ,
but the feature is lost.

Close with `## The Economist today` — one markdown link per line, `[headline](url)`. The app
renders http/https links as tappable. **Omit the section entirely when `source` is `own`.**

### The lexicon and saved words

Definitions accumulate permanently in `lexicon:fr` / `lexicon:es`; each morning you define only
what is *new*. Shape: `data.w = {headword: {p, e, d}}` — `e` is the closest English word, `d` is a
real definition, because Matheo often knows the equivalent and still does not know what it means.

**His saved words come first.** Words he taps and saves land in `vocab:saved`
(`data.w = [{w, l, d}]`). Any without a lexicon entry show a bare dash in his saved-words list.
Define every one the lexicon does not cover, **before** the day's harvested words, and **exempt
from every filter** — not the 4-letter minimum, not the everyday-word stop-list. `où` gets an
entry because he asked for it, however common it is.

**Key saved words on the exact surface form he saved.** `wtStem` is lossy in both directions:
`faucons` stems to `fauc` while `faucon` stems to `faucon`, so they never meet and a base-form
entry is unreachable from the plural he tapped. Exact match is tried first, so the saved form
always hits.

**Strip the `## The Economist today` section before extracting harvested words.** Its headlines
are English and sit inside the French and Spanish bodies, so leaving it in floods the candidates
with `blockbuster`, `happens`, `tobacco`, `what`, `when`. Measured 19 Aug 2026: a single day
yielded 308 French candidates instead of 40–60, largely for this reason. Also drop bare proper
nouns that are only the day's cast, unless the person or institution earns a `"p":"name"` entry.

For harvested words, test membership the way the app does — exact, then de-elided, then stem —
porting `wtStem`, `wtDeElide`, `wtDeaccent` and `WT_SUF` out of `index.html` rather than inventing
a stemmer. Expect roughly 40–60 genuinely new words per language. 250+ means the stop-list is too
thin; under 10 means you over-filtered.

Merge only the new words into the row; never resend the whole map. If the lexicon read fails, skip
the step entirely rather than overwriting with a partial map, and say so.

---

## 5. Timing

All America/New_York.

| Runner | Fires | Writes |
|---|---|---|
| Cloud — "Economist Daily Brief - Cloud" | **05:00**, 07:00 retry | `brief:DATE`, every day |
| Mac mini — "Economist daily brief - Local" | **05:45**, 08:00, 10:00 | `brief:DATE:local`, if Chrome is signed in |
| MacBook — "Economist daily brief - Local" | **06:15** | `brief:DATE:local`, if the mini did not |

The Macs need `sudo pmset repeat wakeorpoweron MTWRFSU 05:40:00` and the Claude app left running,
or they simply never fire and the cloud's `own` brief stands.

The old "never claim before 07:30" rule is **retired**, and so is the 06:30 rewrite cutoff that
briefly replaced it. Neither is needed now that nothing overwrites anything: a Mac edition arriving
late simply adds a second option to the switch — it cannot scramble a brief he is already reading.

---

## 6. Before you publish — assert, don't hope

- all three headlines ≤ 60 characters
- `source in ('economist','mixed','own')`
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

---

## 8. Related app internals

- `briefSource()` / `BRIEF_SRC` in `index.html` — renders the source line, strict 3-value map
- `vocabMirror()` — mirrors saved words into `vocab:saved`
- `vocabDef()` — looks a saved word's meaning up **live**, so a dash fills itself in the morning
  the lexicon gains the word, with no migration
- `mdBlocks()` / `inline()` — block splitting and `[text](url)` rendering (http/https only)
- `wtLookup()` / `wtStem()` / `wtLexIndex()` — tap-to-understand lookup chain

**Known open bug:** the `wtStem` asymmetry above also affects tapping words in the brief itself —
a tap on `faucons` finds nothing even when `faucon` is defined. Worked around for saved words;
not yet fixed at source.
