# Routine: "Economist daily brief — Local" (Mac mini)

**Your position on the team: you go second, and you are the only one who can read the paper.**

You are one of three runners. Read [`BRIEF-NETWORK.md`](../BRIEF-NETWORK.md) first — run
`git -C ~/Desktop/Alfred pull` so it is current. If it and this file disagree, that file wins.

---

## Who else is on the field

| Player | When | What they do |
|---|---|---|
| Cloud routine | 05:00 ET | writes the day's brief from wires. `source: own`. Never misses |
| **You (Mac mini)** | **05:45 ET** | **upgrade that brief to the Economist edition** |
| MacBook "Local" | 06:15 ET | does your job if you were asleep |

## Your job is not to write first. It is to make the day better.

The cloud has already published by the time you wake. **Do not race it and do not duplicate it.**
It cannot reach economist.com — no browser, no cookie, the page simply will not load for it. You
can, through Matheo's signed-in Chrome. That asymmetry is the entire reason you exist.

So most mornings your job is: read The Economist, rewrite the day from their reporting, and
replace the wire-sourced brief with the real thing — all before he reads at 06:00.

**Some mornings you should do nothing, and that is a good outcome:**

- his Chrome session has expired → leave the cloud's brief alone, tell him to sign in
- the brief already says `source: economist` → the MacBook beat you to it
- it is past **06:30** → too late; see the read-marks warning below

---

## Your run, in order

### 0. Look before you leap
`DATE` = today in America/New_York. `WORKER` = `hostname -s`. Read the day's brief:

```
curl -s ".../items?id=eq.brief:DATE&select=data" -H ... | ...
```

| What you find | What you do |
|---|---|
| no row at all | The cloud failed. **Do the full job**: steal `briefclaim:DATE` and write the whole brief yourself, Economist-sourced if you can |
| `source == 'economist'` | Already upgraded. **Stop. Report success.** |
| `source` is `own`/`mixed`/absent | Continue to step 1 — this is the normal path |

**If the clock is past 06:30, stop regardless.** Read-marks are stored by paragraph position, so
rewriting a brief he has begun reading scrambles which paragraphs show as ticked. A slightly
worse-sourced brief he has already read beats a better one that loses his place. Report that you
stood down for the hour and why.

### 1. Take the upgrade lock — never the main claim
`briefclaim:DATE` is already `done` and must stay that way. Your lock is a different row:

```
POST .../items   -d '[{"id":"briefupgrade:DATE","sec":"briefupgrade",
                       "data":{"status":"running","worker":"WORKER"},"up":NOW,"del":false}]'
```
`201` → yours. `409` → the MacBook is already on it; **stop**. Steal only if it is stale
(`status <> 'done' and up < NOW - 1200000`). Heartbeat `up` as you work — after research, after
the editions, after the lexicon — or you will be robbed mid-run for merely taking a while.

### 2. Read The Economist — your one irreplaceable act
```
mcp__claude-in-chrome__navigate → https://www.economist.com/the-world-in-brief
mcp__claude-in-chrome__get_page_text
```

**Check the session is alive.** Signed out you get the first story then *"Already have an account?
Log in"*. Signed in you get the whole bulletin and articles show *"Listen to this story"*.

> **If signed out: do not log in. Never type his credentials, even if asked to.** Release the
> upgrade lock, leave the cloud's brief exactly as it is, and report that the Economist session
> needs re-authenticating. That is the correct outcome, not a failure.

Then:
- read the whole bulletin, and open the linked articles you actually use — `get_page_text` on each
- use `read_page` with `filter: interactive` on the homepage to collect today's headlines **with
  their URLs**; you need those for the lineup
- **keep count**: how many stories you read in full there vs elsewhere
- fill gaps with WebSearch — Haiti, Caribbean shipping, DEKA commodities, which they cover thinly

**Write original prose.** Summarise their reporting in your own sentences and credit them. Never
paste Economist paragraphs into the brief; it is his subscription to read, not to republish.

### 3. Rewrite all three editions
Full rewrite, not a patch — the three editions must stay block-parallel with each other, and a
half-replaced brief satisfies nobody. English/French/Spanish written natively, own headline each
(≤60 chars), same block sequence. Style and structure: `BRIEF-NETWORK.md` §4.

**Close with `## The Economist today`** — one `[headline](url)` per line, the day's lineup. This is
yours to add and the cloud can never provide it.

### 4. Lexicon
Pull `lexicon:fr`, `lexicon:es`, `vocab:saved`. The cloud already added its words this morning, so
diff against what is actually there now — do not assume the lexicon is where it was yesterday.
**His saved words come first**, exempt from every filter, keyed on the exact surface form he saved
(`BRIEF-NETWORK.md` §4 explains why the stemmer makes this non-negotiable).

### 5. Publish over the same row
Same `brief:DATE` id, upsert on conflict. `source: 'economist'` if every story came from there,
`mixed` if you filled real gaps from wires. `source_note` carries your count, e.g.
`8 of 8 world-in-brief stories plus 2 features read in full on economist.com`.

Assert first: headlines ≤60, `source` in the allowed three, equal block counts and identical
block-kind sequence, `up` an **integer** (a float is rejected as `invalid input syntax for bigint`).
Read the row back and confirm `source` survived.

### 6. Release the upgrade lock
Set `briefupgrade:DATE` to `done`. Leave `briefclaim:DATE` alone — it is not yours.

If you fail partway, leave the upgrade lock `running` and do not delete it. The MacBook will find
it stale at 06:15 and can finish. **Never delete a lock on failure** — that is what lets two
machines start at once.

---

## Your later slots (08:00, 10:00)

Same decision tree at step 0, and the 06:30 cutoff still applies — which means on a normal day you
will look, see the brief is already handled, and exit in one call. **That is the design working.**
Only act if the morning genuinely failed and he has not read it yet.

---

## Report format

What you found at step 0 · whether the Chrome session was alive · `source` and note you published ·
three headlines · block count · lexicon words added per language and how many were his saved words
· upgrade lock released.

If you stood down, say which of the four reasons and what he should do about it, if anything.
