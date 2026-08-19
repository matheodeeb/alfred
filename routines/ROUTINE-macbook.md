# Routine: "Economist daily brief — Local" (MacBook Pro)

**Your position on the team: you are the substitute who wins the games the others miss.**

You are one of three runners. Read [`BRIEF-NETWORK.md`](../BRIEF-NETWORK.md) first — run
`git -C ~/Desktop/Alfred pull` so it is current. If it and this file disagree, that file wins.

---

## Who else is on the field

| Player | When | What they do |
|---|---|---|
| Cloud routine | 05:00 ET | writes the day's brief from wires. `source: own`. Never misses |
| Mac mini "Local" | 05:45 ET | upgrades that brief to the Economist edition |
| **You (MacBook)** | **06:15 ET** | **do the upgrade when the mini didn't** |

## Read this part carefully, because your situation is different

You and the Mac mini run **the same play with the same abilities** — both of you can reach
economist.com through Matheo's signed-in Chrome, which the cloud can never do. The difference is
purely timing: the mini goes at 05:45, you go at 06:15.

**So on a good morning you will find the job already done and exit in one call. That is success,
not a wasted run.** Resist the urge to redo it better.

But you are not decoration. The mini is a desktop that can be switched off, and the MacBook
travels with him — there will be mornings when you are the only Mac awake, and on those mornings
you are the only reason he gets the paper he pays for.

### The thing that is genuinely yours to worry about

**Your Chrome may hold a different session than the mini's.** If he signed in on one machine, the
other is not automatically signed in. So do not infer from "the mini did the upgrade yesterday"
that your own session is alive — **check it yourself, every run** (step 2).

### The timing trap you specifically will hit

You fire at **06:15**, and the hard cutoff for rewriting a brief is **06:30**. Your window is
fifteen minutes wide. A full Economist rewrite takes longer than that.

So your rule is stricter than the mini's: **if you cannot start the rewrite by 06:30, do not start
it at all.** Do not begin a rewrite you will finish at 07:10, because by then he may be reading,
and read-marks are stored by paragraph position — replacing the text scrambles which paragraphs
show as ticked. Losing his place in a brief is worse than a brief labelled `own`.

If you are outside the window, report it plainly: *"cloud brief stands; outside the safe rewrite
window."* Then leave it alone.

---

## Your run, in order

### 0. Look before you leap
`DATE` = today in America/New_York. `WORKER` = `hostname -s` — **never hardcode it**, that is how
the logs stop telling you which machine did what.

Read `brief:DATE`:

| What you find | What you do |
|---|---|
| no row at all | Both the cloud and the mini failed. **Do the full job**: steal `briefclaim:DATE` and write the whole brief. Ignore the 06:30 cutoff — there is nothing to scramble |
| `source == 'economist'` | The mini got there. **Stop. Report success.** |
| `source` is `own`/`mixed`, and it is **before 06:30** | Continue to step 1 |
| `source` is `own`/`mixed`, and it is **after 06:30** | Stand down and say why |

### 1. Take the upgrade lock
Never `briefclaim:DATE` — that is already `done` and must stay so. Insert `briefupgrade:DATE`
plain (no upsert; the primary key is the lock). `409` means the mini is mid-run: **stop**, unless
its heartbeat is stale (`status <> 'done' and up < NOW - 1200000`), in which case take over.
Heartbeat `up` as you work.

### 2. Check your own Chrome session — do not assume
```
mcp__claude-in-chrome__navigate → https://www.economist.com/the-world-in-brief
mcp__claude-in-chrome__get_page_text
```
Signed out: the first story, then *"Already have an account? Log in"*. Signed in: the whole
bulletin, and articles offer *"Listen to this story"*.

> **Signed out → do not log in, and never type his credentials.** Release the lock, leave the
> cloud's brief untouched, and report that *this machine's* Chrome needs signing in — naming the
> MacBook specifically, since the mini may be fine and he needs to know which one to fix.

### 3–5. Read, rewrite, publish
Identical to the Mac mini's playbook — read `routines/ROUTINE-mac-mini.md` steps 2 to 5, they
apply to you unchanged:

- read the whole bulletin plus the articles you use; collect the day's headlines **with URLs** via
  `read_page` (`filter: interactive`) on the homepage
- keep count of what you read there vs elsewhere
- rewrite **all three** editions block-parallel, natively, own ≤60-char headline each
- close with `## The Economist today` and the day's links
- lexicon: diff against what is in the rows **now** — the cloud already added words this morning —
  and do his `vocab:saved` words first, exempt from every filter, keyed on the exact saved form
- publish over the same `brief:DATE`, `source: economist` (or `mixed`), `source_note` with the
  count, `up` as an **integer**
- assert everything before writing, and read the row back

Never paste Economist paragraphs into the brief. Summarise in your own words and credit them.

### 6. Release the upgrade lock
`briefupgrade:DATE` → `done`. Leave `briefclaim:DATE` alone. On failure leave the lock `running`
and never delete it.

---

## If you are travelling with him

If this machine is on a different network or timezone, **the date still comes from America/New_York
and the schedule still refers to ET.** Do not publish under a local date — that creates a second
brief row for a day that already has one, and the app will show him two.

---

## Report format

What you found at step 0 · whether **this machine's** Chrome session was alive · whether you were
inside the 06:30 window · `source` and note published · three headlines · block count · lexicon
words added and how many were his saved words · lock released.

If you stood down, name which of the four reasons — he cannot fix what he cannot see.
