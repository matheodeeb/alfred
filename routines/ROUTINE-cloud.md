# Routine: "Economist Daily Brief — Cloud"

**Your position on the team: you go first, every single morning, without fail.**

You are one of three runners that write Matheo's daily brief. Read
[`BRIEF-NETWORK.md`](../BRIEF-NETWORK.md) in this repo for the shared picture — it is checked out
for you. If it and this file ever disagree, that file wins.

---

## Who else is on the field

| Player | When | What they do |
|---|---|---|
| **You (Cloud)** | 05:00 ET, retry 07:00 | write the day's brief from wires. `source: own` |
| Mac mini "Local" | 05:45 ET | **upgrades** your brief to the Economist edition |
| MacBook "Local" | 06:15 ET | upgrades it if the mini was asleep |

## Why you go first, and why you never read The Economist

You are the only runner that is always awake. The Macs sleep, or have the Claude app closed, and
some mornings neither fires. **So your job is the guarantee: a complete, well-written brief exists
by 06:00 no matter what.** That is not a consolation prize — it is the reason Matheo is never
without a brief.

You cannot read economist.com. Not because of a paywall — you cannot load the page at all.
`WebFetch` returns *unreachable*, and you have no browser and no access to his Chrome cookie. This
was tested repeatedly on 19 Aug 2026. **Do not spend a run trying.** Do not try WebSearch scraping
of Economist content as a workaround either.

You will therefore write `source: own` essentially every day. **That is correct and expected.**
Label it honestly and hand off. A Mac will read the paper and rewrite the day at 05:45 if it can.

> The one thing that would genuinely break the morning: you writing `source: economist` on a brief
> you researched from wires. That label is the only way Matheo can tell the paper he pays for from
> a search digest. Lying in it destroys the whole instrument.

---

## Your run, in order

### 1. Clock and identity
The container is UTC and would publish under the wrong date. Get both from the database:
```sql
select to_char(now() at time zone 'America/New_York','YYYY-MM-DD') as d,
       (extract(epoch from now())*1000)::bigint as ms;
```
`DATE` and `NOW`. `WORKER` = `cloud-` + `hostname -s`.

### 2. Claim the day
Use `mcp__Supabase_Alfred__execute_sql` for **every** database read and write. curl cannot reach
Supabase from your sandbox — the proxy returns 403 CONNECT, and retrying only burns the run.

```sql
insert into public.items (id, sec, data, up, del)
values ('briefclaim:DATE','briefclaim',
        jsonb_build_object('status','running','worker','WORKER'), NOW, false)
on conflict (id) do nothing
returning id;
```
Row back → the day is yours. Nothing back → steal only a genuinely dead claim
(`status <> 'done' and up < NOW - 2700000`). Still nothing → **stop immediately** and report
*"brief already handled for DATE, nothing to do."* That is a success. Do not research, do not
write, do not touch the lexicon.

### 3. Research
WebSearch, several times: world affairs and geopolitics (2–3), business and markets (2–3, noting
US markets, manufacturing, Miami/Florida), one science/tech/culture item if genuinely interesting.
Prefer Reuters, AP, FT, Bloomberg.

**Check the date on everything.** Search engines happily return a central-bank decision from two
months ago as though it were today's. If a story turns out to be old, drop it or place it as
standing context — never as news.

Cover Haiti, Caribbean shipping and DEKA-relevant commodities deliberately; nobody else will.

### 4. Write three editions
English (*The Economist* register), French (*Le Monde*/*Les Échos*), Spanish (*El País*/
*Expansión*) — three separate acts of writing, never translations, each with its own ≤60-character
headline and its own number formatting. Structure, style rules and the "why it matters to you"
guidance are in `BRIEF-NETWORK.md` §4.

**No `## The Economist today` lineup section** — that belongs to an Economist-sourced edition, and
yours is not one.

Keep the three editions **block-parallel**: same kickers, same headlines, same paragraph count and
order. Assert it before publishing.

### 5. Lexicon
Pull `lexicon:fr`, `lexicon:es` and `vocab:saved` together. **His saved words come first** and are
exempt from every filter — details in `BRIEF-NETWORK.md` §4. Merge only new words; never resend
the whole map. If the read fails, skip the step entirely rather than writing a partial map.

`vocab:saved` is **read-only**. It belongs to the app.

### 6. Publish
`source: 'own'`, `source_note` saying so plainly, e.g.
`researched from wires; economist.com is not reachable from the cloud runner`.

Assert before writing: three headlines ≤60 chars, `source in ('economist','mixed','own')`, equal
block counts and identical block-kind sequence across the three bodies, `up` an **integer**.

### 7. Release, and hand off
```sql
update public.items
set data = jsonb_build_object('status','done','worker','WORKER'), up = NOW
where id = 'briefclaim:DATE';
```
`done` is permanent. **Do not touch `briefupgrade:DATE`** — that row belongs to the Macs. Your
leg is over the moment the claim is released.

If your run fails partway: leave the claim `running`, do **not** mark it done, do **not** delete
it. Your 07:00 retry or a Mac will find it stale and finish the day.

---

## Report format

Three headlines · word count per edition · block count · `source` and its note · lexicon words
added per language, and how many came from his saved list · claim released, yes/no.

Say explicitly: *"handing off to the Macs for a possible Economist upgrade at 05:45."*
