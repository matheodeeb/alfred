import "jsr:@supabase/functions-js/edge-runtime.d.ts";

/* Alfred CFO <-> Plaid.
 *
 * The bank access token never reaches the browser. It is written straight into
 * public.plaid_items, a table with RLS on, no policies and no grants -- unreachable even
 * by a signed-in session. Only this function can read it, using the service role key that
 * exists solely in its environment. The browser asks to sync by item_id and gets
 * transactions back; it never holds the credential that fetched them.
 *
 * Who may call it: a signed-in account. The platform verifies the JWT signature
 * (verify_jwt), but the project's anon key is ALSO a valid project JWT and is public by
 * design -- so the signature alone proves nothing. The role claim is the real gate, and
 * every query is scoped to the caller's own user id.
 *
 * Environment: PLAID_CLIENT_ID, PLAID_SECRET, PLAID_ENV (sandbox | production).
 * Read per request, not at module load: a warm instance that booted before the secrets
 * existed would otherwise keep answering with the empty values it started with.
 */

function env() {
  const e = (k: string) => (Deno.env.get(k) ?? "").trim();
  const mode = (e("PLAID_ENV") || "sandbox").toLowerCase();
  return { clientId: e("PLAID_CLIENT_ID"), secret: e("PLAID_SECRET"), mode, host: `https://${mode}.plaid.com` };
}

// Supabase ships the service key under a legacy name and a newer JSON bundle; accept either
// so a platform rename cannot silently break token storage.
function serviceKey(): string {
  const legacy = (Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "").trim();
  if (legacy) return legacy;
  try {
    const bundle = JSON.parse(Deno.env.get("SUPABASE_SECRET_KEYS") ?? "{}");
    for (const v of Object.values(bundle)) if (typeof v === "string" && v) return v;
  } catch { /* fall through */ }
  return "";
}
const SB_URL = (Deno.env.get("SUPABASE_URL") ?? "").replace(/\/$/, "");

async function db(path: string, init: RequestInit = {}) {
  const key = serviceKey();
  if (!SB_URL || !key) throw new Error("token store unavailable on this function");
  const r = await fetch(`${SB_URL}/rest/v1/${path}`, {
    ...init,
    headers: {
      apikey: key,
      Authorization: `Bearer ${key}`,
      "Content-Type": "application/json",
      ...(init.headers ?? {}),
    },
  });
  const t = await r.text();
  if (!r.ok) throw new Error(`token store ${r.status}`);
  return t ? JSON.parse(t) : null;
}

const ALLOWED = new Set([
  "https://matheodeeb.github.io",
  "http://127.0.0.1:8099",
  "http://localhost:8099",
]);
function cors(origin: string | null) {
  const ok = origin && ALLOWED.has(origin);
  return {
    "Access-Control-Allow-Origin": ok ? origin! : "https://matheodeeb.github.io",
    "Access-Control-Allow-Headers": "authorization, apikey, content-type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Vary": "Origin",
  };
}

/* Signature already verified upstream; this only reads the claims to tell a real user
 * session apart from the public anon key. Not a security check on its own. */
function claims(auth: string | null): { sub?: string; role?: string } | null {
  const m = /^Bearer\s+(.+)$/i.exec(auth ?? "");
  if (!m) return null;
  const p = m[1].split(".");
  if (p.length !== 3) return null;
  try {
    const pad = p[1].length % 4 ? "=".repeat(4 - (p[1].length % 4)) : "";
    return JSON.parse(atob(p[1].replace(/-/g, "+").replace(/_/g, "/") + pad));
  } catch { return null; }
}

/* Per-user rate limit, in memory per instance. Not distributed and not pretending to be:
 * its job is to stop a stolen session draining the Plaid quota. Normal use is a handful of
 * calls a day, so these ceilings sit far above anything legitimate. */
const RATE = new Map<string, { n: number; until: number }>();
const LIMITS: Record<string, { max: number; windowMs: number }> = {
  link_token:  { max: 10, windowMs: 60_000 },
  exchange:    { max: 10, windowMs: 60_000 },
  sync:        { max: 30, windowMs: 60_000 },
  liabilities: { max: 30, windowMs: 60_000 },
  balances:    { max: 30, windowMs: 60_000 },
  items:       { max: 60, windowMs: 60_000 },
  remove:      { max: 10, windowMs: 60_000 },
  _total:      { max: 120, windowMs: 60_000 },
};
function overLimit(user: string, bucket: string): boolean {
  const cfg = LIMITS[bucket] ?? LIMITS._total;
  const key = `${user}|${bucket}`, now = Date.now();
  const cur = RATE.get(key);
  if (!cur || now > cur.until) {
    RATE.set(key, { n: 1, until: now + cfg.windowMs });
    if (RATE.size > 500) for (const [k, v] of RATE) if (now > v.until) RATE.delete(k);
    return false;
  }
  cur.n++;
  return cur.n > cfg.max;
}

async function plaid(path: string, body: Record<string, unknown>) {
  const { clientId, secret, host } = env();
  const r = await fetch(`${host}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ client_id: clientId, secret, ...body }),
  });
  const text = await r.text();
  let data: any = {};
  try { data = text ? JSON.parse(text) : {}; } catch { data = {}; }
  if (!r.ok) {
    // Plaid's own reason and nothing else. Never echo the request: it carries the client
    // id, the Plaid secret and the access token.
    throw new Error(data?.error_code ? `${data.error_code}: ${data.error_message}` : `plaid http ${r.status}`);
  }
  return data;
}

const qs = (s: string) => encodeURIComponent(s);

/* A card carries several APRs -- purchases, cash advances, balance transfers, a temporary
 * promotional one. The purchase APR is the rate the balance actually accrues at for normal
 * spending, so that is the one the payoff strategies want. Falling back to the highest
 * rather than the first keeps the estimate conservative when Plaid labels them oddly. */
function purchaseApr(aprs: any[]): number | null {
  if (!Array.isArray(aprs) || !aprs.length) return null;
  const pick = aprs.find((a) => String(a?.apr_type ?? "").toLowerCase() === "purchase_apr");
  if (pick && typeof pick.apr_percentage === "number") return pick.apr_percentage;
  const nums = aprs.map((a) => a?.apr_percentage).filter((n) => typeof n === "number") as number[];
  return nums.length ? Math.max(...nums) : null;
}

Deno.serve(async (req: Request) => {
  const CORS = cors(req.headers.get("origin"));
  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), {
      status,
      headers: { ...CORS, "Content-Type": "application/json", "Cache-Control": "no-store" },
    });

  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return json({ error: "POST only" }, 405);

  const { clientId, secret, mode } = env();
  const missing = [!clientId && "PLAID_CLIENT_ID", !secret && "PLAID_SECRET"].filter(Boolean);
  if (missing.length) {
    return json({ error: `Not set on this function: ${missing.join(" and ")}. Add them under Project Settings -> Edge Functions -> Secrets.` }, 500);
  }

  const c = claims(req.headers.get("authorization"));
  if (!c || c.role !== "authenticated" || !c.sub) return json({ error: "sign in first" }, 401);
  const user = c.sub;

  if (overLimit(user, "_total")) return json({ error: "rate limited" }, 429);

  let body: any = {};
  try { body = await req.json(); } catch { return json({ error: "bad json" }, 400); }

  const action = String(body.action ?? "");
  if (!Object.hasOwn(LIMITS, action) || action === "_total") return json({ error: "unknown action" }, 400);
  if (overLimit(user, action)) return json({ error: "rate limited" }, 429);

  try {
    switch (action) {
      case "link_token": {
        // An item_id may be passed to re-authenticate an existing connection; the token for
        // it is looked up here, never supplied by the caller.
        let access_token: string | undefined;
        if (typeof body.item_id === "string" && body.item_id) {
          const rows = await db(`plaid_items?item_id=eq.${qs(body.item_id)}&owner=eq.${qs(user)}&select=access_token`);
          access_token = rows?.[0]?.access_token;
        }
        /* Transactions is the one product every connection must have. Liabilities and
         * investments go in required_if_supported_products instead of products on purpose:
         * anything listed under products filters the institution picker down to banks
         * offering it, which would hide a plain checking account for want of a credit line.
         * This way a card brings its APR along and a bank simply does not. */
        const base = {
          user: { client_user_id: user },
          client_name: "Alfred CFO",
          products: ["transactions"],
          /* Plaid hands back 90 days unless asked otherwise, which is why a page built
           * around a calendar year came up empty until July. Two years is the most it
           * will give, and it is requested at the moment a bank is linked -- an Item
           * already created keeps the window it was created with. */
          transactions: { days_requested: 730 },
          country_codes: ["US"],
          language: "en",
          ...(access_token ? { access_token } : {}),
        };
        /* If the plan does not carry liabilities or investments, Plaid rejects the whole
         * request rather than dropping the part it cannot honour -- which would leave no
         * way to connect anything at all. Asking for them first and falling back to plain
         * transactions means a narrower plan costs the extra fields, not the feature. */
        let out;
        try {
          out = await plaid("/link/token/create", {
            ...base, required_if_supported_products: ["liabilities", "investments"],
          });
        } catch (e) {
          out = await plaid("/link/token/create", base);
        }
        return json({ link_token: out.link_token, expiration: out.expiration, env: mode });
      }

      // Link hands back a short-lived public token. The real one is exchanged, written to
      // the token store, and NEVER returned. The browser gets an id and the account list.
      case "exchange": {
        if (typeof body.public_token !== "string") return json({ error: "public_token required" }, 400);
        const out = await plaid("/item/public_token/exchange", { public_token: body.public_token });
        const accts = await plaid("/accounts/get", { access_token: out.access_token }).catch(() => ({ accounts: [] }));
        const accounts = (accts.accounts ?? []).map((a: any) => ({
          id: a.account_id, name: a.name, mask: a.mask, type: a.type, subtype: a.subtype,
        }));
        const institution = typeof body.institution === "string" ? body.institution.slice(0, 120) : "";
        await db("plaid_items?on_conflict=item_id", {
          method: "POST",
          headers: { Prefer: "resolution=merge-duplicates" },
          body: JSON.stringify([{
            item_id: out.item_id, owner: user, access_token: out.access_token,
            cursor: "", institution, accounts, updated_at: new Date().toISOString(),
          }]),
        });
        return json({ item_id: out.item_id, institution, accounts });
      }

      // The caller names an item; the token and cursor are read here and the cursor written
      // back here. Scoped by owner, so an id belonging to someone else finds nothing.
      case "sync": {
        if (typeof body.item_id !== "string" || !body.item_id) return json({ error: "item_id required" }, 400);
        const rows = await db(`plaid_items?item_id=eq.${qs(body.item_id)}&owner=eq.${qs(user)}&select=access_token,cursor`);
        const row = rows?.[0];
        if (!row) return json({ error: "no such connection" }, 404);

        let cursor: string | undefined = row.cursor || undefined;
        const added: any[] = [], modified: any[] = [], removed: string[] = [];
        let more = true, guard = 0;
        while (more && guard++ < 25) {
          const out = await plaid("/transactions/sync", {
            access_token: row.access_token, ...(cursor ? { cursor } : {}), count: 500,
          });
          added.push(...(out.added ?? []));
          modified.push(...(out.modified ?? []));
          removed.push(...(out.removed ?? []).map((r: any) => r.transaction_id));
          cursor = out.next_cursor;
          more = !!out.has_more;
        }
        await db(`plaid_items?item_id=eq.${qs(body.item_id)}&owner=eq.${qs(user)}`, {
          method: "PATCH",
          body: JSON.stringify({ cursor: cursor ?? "", updated_at: new Date().toISOString() }),
        });
        // The detailed category rides along: "FOOD_AND_DRINK" cannot tell groceries from a
        // restaurant, and for a spending plan that is the distinction worth having.
        const trim = (t: any) => ({
          id: t.transaction_id, account: t.account_id,
          date: t.authorized_date || t.date,
          desc: t.merchant_name || t.name,
          amt: t.amount, cur: t.iso_currency_code || "USD",
          cat: t.personal_finance_category?.primary || "",
          det: t.personal_finance_category?.detailed || "",
          pending: !!t.pending,
        });
        return json({ added: added.map(trim), modified: modified.map(trim), removed });
      }

      /* What a card actually costs: the APR, the minimum and the due date, which the payoff
       * comparison needs and which nobody enjoys typing in by hand four times a year. The
       * account balances come back in the same response, so one call keeps both the debt
       * figures and the amount owed current.
       *
       * An institution with no credit line at all answers PRODUCTS_NOT_SUPPORTED. That is
       * an ordinary outcome for a checking-only bank, not a failure, so it returns an empty
       * set and lets the caller carry on. */
      case "liabilities": {
        if (typeof body.item_id !== "string" || !body.item_id) return json({ error: "item_id required" }, 400);
        const rows = await db(`plaid_items?item_id=eq.${qs(body.item_id)}&owner=eq.${qs(user)}&select=access_token`);
        const row = rows?.[0];
        if (!row) return json({ error: "no such connection" }, 404);

        let out: any;
        try {
          out = await plaid("/liabilities/get", { access_token: row.access_token });
        } catch (e) {
          const msg = String((e as Error).message ?? "");
          if (/PRODUCTS_NOT_SUPPORTED|PRODUCT_NOT_READY|NO_LIABILITY_ACCOUNTS|NO_ACCOUNTS/i.test(msg)) {
            return json({ debts: [], balances: [], unsupported: true });
          }
          throw e;
        }

        const accounts: any[] = out.accounts ?? [];
        const acct = (id: string) => accounts.find((a) => a.account_id === id);
        const label = (id: string) => {
          const a = acct(id);
          return a ? `${a.name || "Account"}${a.mask ? ` ••${a.mask}` : ""}` : "Account";
        };
        // Plaid reports a card's balance as a positive number owed; the Debts page uses the
        // same convention, so it carries straight across.
        const owed = (id: string) => {
          const b = acct(id)?.balances;
          return typeof b?.current === "number" ? Math.abs(b.current) : null;
        };
        const dueDay = (d: unknown) => {
          const m = /^\d{4}-\d{2}-(\d{2})/.exec(String(d ?? ""));
          return m ? Number(m[1]) : null;
        };

        const debts: any[] = [];
        for (const c of out.liabilities?.credit ?? []) {
          debts.push({
            account: c.account_id, name: label(c.account_id), kind: "Credit card",
            bal: owed(c.account_id), apr: purchaseApr(c.aprs),
            min: typeof c.minimum_payment_amount === "number" ? c.minimum_payment_amount : null,
            day: dueDay(c.next_payment_due_date),
            stmtDay: dueDay(c.last_statement_issue_date),
            statement: typeof c.last_statement_balance === "number" ? c.last_statement_balance : null,
            overdue: !!c.is_overdue,
          });
        }
        for (const s of out.liabilities?.student ?? []) {
          debts.push({
            account: s.account_id, name: label(s.account_id), kind: "Student loan",
            bal: owed(s.account_id),
            apr: typeof s.interest_rate_percentage === "number" ? s.interest_rate_percentage : null,
            min: typeof s.minimum_payment_amount === "number" ? s.minimum_payment_amount : null,
            day: dueDay(s.next_payment_due_date), statement: null, overdue: !!s.is_overdue,
          });
        }
        for (const m of out.liabilities?.mortgage ?? []) {
          debts.push({
            account: m.account_id, name: label(m.account_id), kind: "Mortgage",
            bal: owed(m.account_id),
            apr: typeof m.interest_rate?.percentage === "number" ? m.interest_rate.percentage : null,
            min: typeof m.next_monthly_payment === "number" ? m.next_monthly_payment : null,
            day: dueDay(m.next_payment_due_date), statement: null, overdue: false,
          });
        }

        // Every account's balance, so cash and cards can both be refreshed from one call.
        const balances = accounts.map((a: any) => ({
          id: a.account_id, name: a.name, mask: a.mask, type: a.type, subtype: a.subtype,
          current: a.balances?.current ?? null, available: a.balances?.available ?? null,
          cur: a.balances?.iso_currency_code || "USD",
        }));

        return json({ debts, balances });
      }

      /* Every account's balance. /liabilities/get carries balances too, but only for a bank
       * that has a credit line at all -- a checking-only bank answers PRODUCTS_NOT_SUPPORTED
       * and hands back nothing. This asks the question every bank can answer, which is what
       * the Accounts page needs: a typed-in balance is only ever true on the day it is typed. */
      case "balances": {
        if (typeof body.item_id !== "string" || !body.item_id) return json({ error: "item_id required" }, 400);
        const rows = await db(`plaid_items?item_id=eq.${qs(body.item_id)}&owner=eq.${qs(user)}&select=access_token`);
        const row = rows?.[0];
        if (!row) return json({ error: "no such connection" }, 404);
        const out = await plaid("/accounts/balance/get", { access_token: row.access_token });
        const balances = (out.accounts ?? []).map((a: any) => ({
          id: a.account_id, name: a.name, mask: a.mask, type: a.type, subtype: a.subtype,
          current: a.balances?.current ?? null, available: a.balances?.available ?? null,
          limit: a.balances?.limit ?? null, cur: a.balances?.iso_currency_code || "USD",
        }));
        // The stored account list is refreshed while we are here, so a card opened since the
        // connection was made does not stay invisible until it is reconnected.
        await db(`plaid_items?item_id=eq.${qs(body.item_id)}&owner=eq.${qs(user)}`, {
          method: "PATCH",
          body: JSON.stringify({
            accounts: balances.map((a: any) => ({ id: a.id, name: a.name, mask: a.mask, type: a.type, subtype: a.subtype })),
            updated_at: new Date().toISOString(),
          }),
        });
        return json({ balances });
      }

      // Connections belonging to the caller. Tokens are excluded from the projection.
      case "items": {
        const rows = await db(`plaid_items?owner=eq.${qs(user)}&select=item_id,institution,accounts,updated_at&order=created_at.asc`);
        return json({ items: rows ?? [] });
      }

      // Tell Plaid to drop the item, then forget the token either way.
      case "remove": {
        if (typeof body.item_id !== "string" || !body.item_id) return json({ error: "item_id required" }, 400);
        const rows = await db(`plaid_items?item_id=eq.${qs(body.item_id)}&owner=eq.${qs(user)}&select=access_token`);
        const tok = rows?.[0]?.access_token;
        if (tok) await plaid("/item/remove", { access_token: tok }).catch(() => null);
        await db(`plaid_items?item_id=eq.${qs(body.item_id)}&owner=eq.${qs(user)}`, { method: "DELETE" });
        return json({ removed: true });
      }

      default:
        return json({ error: "unknown action" }, 400);
    }
  } catch (e) {
    return json({ error: String((e as Error).message ?? "failed") }, 502);
  }
});
