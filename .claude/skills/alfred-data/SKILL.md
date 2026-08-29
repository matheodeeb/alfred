---
name: alfred-data
description: Read, add, edit, or remove data in Alfred, the personal life console in this repo. Alfred's real data lives in a private Supabase `items` table, never in the repo, so every change is a database write and takes effect on the next sync — no reload, no deploy. Use whenever the user wants something recorded, changed, priced, corrected, ticked off, or removed: spoils and watches, wants, to-do, travels, food and menu, bathroom and living-room stock, perfume, supplements, shows, movies, books, courses, finances, projects, daily activities, recurring jobs. Triggers on "add this to my …", "put this on my list", "change the price of …", "take … off", a photo of a product, or a listing link to file — anything the user would otherwise have typed into the website.
---

# Alfred data entry

Alfred is a single-file offline-first PWA (`index.html`) whose data lives on-device in
localStorage and syncs to a private Supabase table. The repo is public and holds **no**
personal data — so data work is database work, not code work. Do not add personal values
to `index.html`.

## The table

`public.items`, reached with `mcp__Supabase_Alfred__execute_sql`.

| column | type | meaning |
|---|---|---|
| `id`   | text PK | stable row id |
| `sec`  | text | which section it belongs to (see map below) |
| `data` | jsonb | the row's fields |
| `up`   | int8 | last-touched, **epoch milliseconds** |
| `del`  | bool | tombstone |

## Rules that matter

**1. `up` must be now, in milliseconds.** The client pulls a row only when
`remote.up > local.up`. An `up` that is stale — or in seconds instead of milliseconds —
writes a row the device will silently ignore. Always:

```sql
(extract(epoch from now()) * 1000)::bigint
```

**2. Never `DELETE`.** Removing a row leaves the device's copy untouched, and it syncs
back on the next push. Tombstone instead — `del = true` plus a fresh `up`. The client
drops tombstones locally after 30 days.

**3. Edits merge, they don't replace.** `data = data || '{...}'::jsonb` keeps the keys you
aren't touching. Assigning a whole new object silently drops everything you left out.

**4. Read before you write.** Pull two or three existing rows from the same section first
and match how they're written — naming order, what goes in `notes`, whether a field is
left empty on purpose. House style lives in the data, not in a spec.

**5. `index.html` is the source of truth for fields.** The `MODS` object (around line
1239) defines each section's `fields:` array. The map below is a convenience copy and can
drift; when a field matters, check `MODS`.

## ids

Rows created by the app carry a random base36 id (`Date.now().toString(36)` + 5 random
chars, e.g. `mtddrkjuuibb5`). Leave those alone — but edit them freely by id.

Rows you create by hand get a readable `prefix:slug`, so the same request twice updates
one row instead of making two:

```
tl:rolex-daytona-126519ln   want:airpods-max-2   food:scrambled-eggs
perf:santal33               book:meditations     stock:dove
```

Prefixes in use: `tl:` spoils · `want:` · `need:` · `food:` · `menu:` · `juice:` ·
`perf:` · `supp:` · `stock:` · `kitchen:` · `book:` · `show:` · `movie:` · `course:` ·
`proj:` · `recur:` · `inv:` · `fin:` · `travel:` · `brief:`

## Sections and their fields

| `sec` | Tab | fields |
|---|---|---|
| `todo` | To-do list | task, grp, gord, due, ord, notes |
| `tlspoils` | Timeline → Spoils | date, name, cost, notes |
| `travels` | Timeline → Travels / Past | place, trip, start, end, notes |
| `wants` | Wants | name, grp, price, link, notes |
| `needs` | To order | name, src, qty, price, link, notes |
| `stock` | Bathroom | name, count, min, par, place |
| `kitchen` | Living room | name, count, min, par, unit, notes |
| `perfume` | Perfume | name, house, count, min, place, notes |
| `supp` | Supplements | name, brand, kind, count, min, place, notes |
| `food` | Food recipes | name, cat, ing, steps |
| `menu` | Home menu | name, cat, ing, notes |
| `juice` | Juice recipes | name, ing, notes |
| `shows` | Shows | name, genre, pri, seasons, eps, epmin, len, plat, status, season, rel, notes |
| `movies` | Movies | name, genre, pri, runtime, status, rel, notes |
| `books` | Books | name, author, cat, pri, pages, len, status, prog, notes |
| `courses` | To learn | name, topic, src, status, prog, notes |
| `projects` | Projects | project, name, when, wk, mon, start, end, status, notes |
| `acts` | Daily activities | name, splitDaily, split, days, timeDaily, start, end, notes |
| `recur` | Recurring | name, who, paused, every, anchor, dom, last, notes |
| `assets` | Assets | name, cat, src, paid, val, notes |
| `invest` | Investment log | date, acct, val, added, notes |
| `fincash` | Cash — accounts | name, grp, amt, denom, cur, stmtDay, dueDay, card |
| `finstmt` | Monthly statement | month, src, amt |
| `fintx` | Transfer | date, month, desc, acct, cur, dir, amt |
| `finsub` | Subscriptions | name, cycle, cost, bank, notes |
| `payroll` | Payroll | name, role, amt, payday, notes |
| `bdays` | Birthdays | name, date, notes |
| `brief` | Daily brief | date, title, body |
| `briefs` | Journal | title, txt |
| `income` | Finances → CFO | name, kind, amt, cyc, cur, acct, start, notes |
| `debt` | Finances → CFO | name, kind, bal, apr, min, cur, day, notes |
| `goal` | Finances → CFO | name, target, track, saved, by, pri, notes |
| `spend` | Finances → CFO | month, year, cat, amt, cur, notes |
| `prop` | Finances → CFO | name, status, addr, val, rent, tax, ins, hoa |

Two sections are not their own rows. **Timeline → Past** (`travpast`) is a view over
`travels` showing the ones with `done` set — a trip moves there by setting `done` on its
`travels` row, not by writing a `travpast` row. And `cfg` holds the app's own settings
(PIN hash, tab preferences); never write it as data entry.

Conventions worth knowing: money fields are plain numbers, no symbols or commas. Dates are
`YYYY-MM-DD`. An empty `date` on a spoil means *still on the list* — it gets a date when
the thing is actually acquired. `ing` and `steps` are newline-separated.

## Doing the work

**Add**

```sql
insert into items (id, sec, data, up, del) values
  ('tl:rolex-daytona-126519ln', 'tlspoils',
   '{"name":"Rolex Daytona 126519LN black dial on Oysterflex","cost":48000,"date":"","notes":"Watch"}'::jsonb,
   (extract(epoch from now()) * 1000)::bigint, false)
on conflict (id) do update
  set data = items.data || excluded.data,
      up   = excluded.up,
      del  = false;
```

**Edit**

```sql
update items
   set data = data || '{"price":550}'::jsonb,
       up   = (extract(epoch from now()) * 1000)::bigint
 where id = 'want:airpods-max-2';
```

**Remove**

```sql
update items
   set del = true,
       up  = (extract(epoch from now()) * 1000)::bigint
 where id = 'tl:daydate-228239';
```

**Find something to edit** when the user describes it rather than naming an id:

```sql
select id, data from items
 where sec = 'wants' and not del
   and data->>'name' ilike '%airpods%';
```

## From a photo or a listing

Read the details off the image — brand, reference, dial, bracelet, price — and write them
in the section's own naming order. If the price is a dealer ask rather than retail, use it
but say so, so the user can correct it.

## Finishing

Select the row back to confirm the write landed, then tell the user what will appear,
which tab it's under, and that it arrives on the next sync — no reload or deploy. If you
made a judgement call (a price source, a category, a name format), say which, in one line.
