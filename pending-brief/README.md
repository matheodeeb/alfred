# Unpublished brief: 2026-10-22

The cloud runner wrote this brief but **could not publish it**. It is complete and
validated; it just needs one SQL statement run from a machine that can reach the
database.

## To publish

From the Mac mini or MacBook (either can reach Supabase over curl REST), or from any
session where `mcp__Supabase_Alfred__execute_sql` is connected:

    psql "$ALFRED_DB_URL" -f pending-brief/publish-2026-10-22.sql

or paste the contents of `publish-2026-10-22.sql` into `execute_sql`. It is a single
idempotent upsert to `brief:2026-10-22`. It touches no other row.

**Do not** publish it if a brief for that date already reads as written by a Mac with
`source: economist` — that edition is better than this one. This row is `brief:2026-10-22`
(the cloud's own row, no suffix), so it cannot collide with `brief:2026-10-22:local`
in any case.

## Why it was not published

- `mcp__Supabase_Alfred__execute_sql` failed to connect for the whole session:
  `503 ... CLIENT_HTTP_NOT_IMPLEMENTED` dialling the MCP endpoint. MCP servers connect
  at session start, so this could not be retried from inside the run.
- curl REST is 403'd from the cloud runner, as recorded in `BRIEF-NETWORK.md` section 2.

The 11:15 UTC firing was 07:15 EDT, i.e. the 07:00 retry, so no further cloud run was
scheduled for the day. Nothing was written to the database at all, which means **no
lock was ever claimed** — there is no `briefclaim:2026-10-22:cloud` row to clear, and a
later run will find the day unclaimed and free to proceed.

## What is in the payload

`source: own`, `edition: cloud`, 27 blocks per edition with an identical block sequence
across English, French and Spanish (4 H2, 5 H3, 18 paragraphs). `art` is a list of five
nulls: `commons.wikimedia.org` did not resolve from the container (DNS ENOTFOUND), and
pictures never block the brief.

The lexicon step was skipped entirely, as the instructions require when the
`lexicon:fr` / `lexicon:es` read fails. No lexicon row was written or should be
back-filled from this payload.
