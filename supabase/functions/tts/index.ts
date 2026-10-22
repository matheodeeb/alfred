import "jsr:@supabase/functions-js/edge-runtime.d.ts";

/* Alfred: the Brief, read aloud.
 *
 * The browser sends a row id and a language, never text. This function reads the row itself,
 * so it can only ever voice what is already in the house: it cannot be used to turn arbitrary
 * text into speech on the account's bill.
 *
 * Who may call it: whoever holds the house's sync secret. The function does not know that
 * secret. It forwards the caller's own x-alfred-key header to the database, where the items
 * table's row-level policy checks it; a wrong key gets no row back, and so no audio.
 *
 * Each reading is generated once per row, language and text, then kept in the private
 * brief-audio bucket. Playing it again, on any device, is a download rather than a new bill.
 * Editing the brief changes the text hash, so the next listen voices the new version.
 *
 * The voice is Google Cloud Text-to-Speech, Chirp 3 HD: a natural narrator voice in each
 * language, returned as compressed MP3 so a long brief stays a few megabytes.
 *
 * Environment: GOOGLE_TTS_API_KEY. Optional: TTS_VOICE_EN, TTS_VOICE_FR, TTS_VOICE_ES to
 * use a different voice (full Google voice names). Read per request, so a newly added
 * secret takes effect at once.
 */

const SB_URL = (Deno.env.get("SUPABASE_URL") ?? "").replace(/\/$/, "");
const BUCKET = "brief-audio";

function serviceKey(): string {
  const legacy = (Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "").trim();
  if (legacy) return legacy;
  try {
    const bundle = JSON.parse(Deno.env.get("SUPABASE_SECRET_KEYS") ?? "{}");
    for (const v of Object.values(bundle)) if (typeof v === "string" && v) return v;
  } catch { /* fall through */ }
  return "";
}

const ALLOWED = new Set([
  "https://matheodeeb.github.io",
  "http://127.0.0.1:8099",
  "http://localhost:8099",
  "http://localhost:8765",
]);
function cors(origin: string | null) {
  const ok = origin && ALLOWED.has(origin);
  return {
    "Access-Control-Allow-Origin": ok ? origin! : "https://matheodeeb.github.io",
    "Access-Control-Allow-Headers": "authorization, apikey, content-type, x-alfred-key",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Vary": "Origin",
  };
}

// Fresh generations are the only thing here that costs money, so they are capped per
// instance. Far above a person listening to a few briefs a day.
const GEN = { n: 0, until: 0 };
function overLimit(): boolean {
  const now = Date.now();
  if (now > GEN.until) { GEN.n = 0; GEN.until = now + 3_600_000; }
  return ++GEN.n > 30;
}

/* Charon is Google's measured, informative male narrator, the closest of its voices to a
 * magazine's audio edition, and it exists in each language so the brief sounds like one
 * presenter whichever edition is open. */
const LANGS: Record<string, { code: string; voice: string }> = {
  en: { code: "en-GB", voice: "en-GB-Chirp3-HD-Charon" },
  fr: { code: "fr-FR", voice: "fr-FR-Chirp3-HD-Charon" },
  es: { code: "es-ES", voice: "es-ES-Chirp3-HD-Charon" },
};
function voiceFor(lang: string): { code: string; voice: string } {
  const l = LANGS[lang] ?? LANGS.en;
  const o = (Deno.env.get(`TTS_VOICE_${lang.toUpperCase()}`) ?? "").trim();
  return o ? { code: l.code, voice: o } : l;
}

/* Markdown to something a narrator reads: headings become their own sentences, list items
 * become sentences, emphasis and links disappear but their words stay. */
function speakable(md: string): string {
  return md
    .replace(/\r/g, "")
    .replace(/!\[[^\]]*\]\([^)]*\)/g, "")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .split(/\n/)
    .map((l) => l.trim())
    .map((l) => l.replace(/^#{1,6}\s+(.*)$/, (_m, t) => (/[.!?:]$/.test(t) ? t : t + ".")))
    .map((l) => l.replace(/^[-*•]\s+(.*)$/, (_m, t) => (/[.!?:]$/.test(t) ? t : t + ".")))
    .join("\n")
    .replace(/(\*\*|__|\*|_|`)/g, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/* Google takes at most 5,000 bytes of text per request, and an accented letter is two bytes,
 * so a long brief is cut at paragraph boundaries by byte length and the pieces are voiced in
 * parallel. MP3 frames join end to end, so the pieces concatenate into one file that plays
 * straight through. */
const ENC = new TextEncoder();
const bytes = (s: string) => ENC.encode(s).length;
function chunks(text: string, max = 4200): string[] {
  const out: string[] = [];
  let cur = "";
  for (const p of text.split(/\n\n+/)) {
    if (bytes(p) > max) {
      if (cur) { out.push(cur); cur = ""; }
      let rest = p;
      while (bytes(rest) > max) {
        // max/2 characters is always within max bytes, even if every letter were accented
        const lim = Math.floor(max / 2);
        const cut = Math.max(rest.lastIndexOf(". ", lim), rest.lastIndexOf(" ", lim));
        const at = cut > lim / 2 ? cut + 1 : lim;
        out.push(rest.slice(0, at).trim());
        rest = rest.slice(at).trim();
      }
      cur = rest;
      continue;
    }
    if (cur && bytes(cur + "\n\n" + p) > max) { out.push(cur); cur = p; }
    else cur = cur ? cur + "\n\n" + p : p;
  }
  if (cur) out.push(cur);
  return out;
}

async function sha(s: string): Promise<string> {
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, "0")).join("").slice(0, 24);
}

function unb64(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

async function voice(text: string, lang: string, key: string): Promise<Uint8Array> {
  const v = voiceFor(lang);
  const call = (voice: Record<string, string>) =>
    fetch("https://texttospeech.googleapis.com/v1/text:synthesize", {
      method: "POST",
      headers: { "X-Goog-Api-Key": key, "Content-Type": "application/json" },
      body: JSON.stringify({ input: { text }, voice, audioConfig: { audioEncoding: "MP3" } }),
    });
  let r = await call({ languageCode: v.code, name: v.voice });
  // A voice name Google does not know (renamed, or not offered in that language) should not
  // silence the brief: fall back to Google's own default voice for the language.
  if (r.status === 400) r = await call({ languageCode: v.code });
  if (!r.ok) {
    const t = await r.text().catch(() => "");
    throw new Error(`voice ${r.status}: ${t.slice(0, 300)}`);
  }
  const j = await r.json();
  if (!j?.audioContent) throw new Error("voice returned no audio");
  return unb64(j.audioContent);
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

  const gkey = (Deno.env.get("GOOGLE_TTS_API_KEY") ?? "").trim();
  const svc = serviceKey();
  if (!gkey) return json({ error: "not_configured", detail: "GOOGLE_TTS_API_KEY is not set on the tts function." }, 503);
  if (!SB_URL || !svc) return json({ error: "storage unavailable" }, 500);

  let body: { id?: string; lang?: string } = {};
  try { body = await req.json(); } catch { return json({ error: "bad json" }, 400); }
  const id = String(body.id ?? "");
  const lang = LANGS[String(body.lang)] ? String(body.lang) : "en";
  if (!id || id.length > 120) return json({ error: "id required" }, 400);

  // Read the row as the caller: their apikey and their sync secret, checked by the table's own policy.
  const apikey = req.headers.get("apikey") ?? "";
  const alfredKey = req.headers.get("x-alfred-key") ?? "";
  if (!apikey || !alfredKey) return json({ error: "unauthorised" }, 401);
  const rr = await fetch(`${SB_URL}/rest/v1/items?select=data&id=eq.${encodeURIComponent(id)}&limit=1`, {
    headers: { apikey, Authorization: `Bearer ${apikey}`, "x-alfred-key": alfredKey },
  });
  if (!rr.ok) return json({ error: "unauthorised" }, 401);
  const rows = await rr.json().catch(() => []);
  const d = rows?.[0]?.data;
  if (!d) return json({ error: "not found" }, 404);

  const pick = (base: string) => d[`${base}_${lang}`] || (lang === "en" ? d[base] || "" : "");
  let title = pick("title"), md = pick("body");
  let speakLang = lang;
  if (!md) { title = d.title_en || d.title || ""; md = d.body_en || d.body || ""; speakLang = "en"; }
  if (!md) return json({ error: "nothing to read" }, 404);
  const text = (title ? speakable(title) + (/[.!?]$/.test(title) ? "" : ".") + "\n\n" : "") + speakable(md);

  // The voice is part of the name, so changing voices re-records rather than replaying the old one.
  const path = `${id.replace(/[^A-Za-z0-9_-]/g, "_")}/${speakLang}-${await sha(voiceFor(speakLang).voice + "|" + text)}.mp3`;
  const objUrl = `${SB_URL}/storage/v1/object/${BUCKET}/${path}`;
  const store = { apikey: svc, Authorization: `Bearer ${svc}` };
  const audioHeaders = { ...CORS, "Content-Type": "audio/mpeg", "Cache-Control": "no-store" };

  const hit = await fetch(objUrl, { headers: store });
  if (hit.ok) return new Response(hit.body, { headers: { ...audioHeaders, "X-Alfred-Audio": "cached" } });

  if (overLimit()) return json({ error: "rate limited" }, 429);
  let parts: Uint8Array[];
  try {
    parts = await Promise.all(chunks(text).map((c) => voice(c, speakLang, gkey)));
  } catch (e) {
    return json({ error: "voice_failed", detail: String((e as Error).message ?? e) }, 502);
  }
  const all = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) { all.set(p, o); o += p.length; }

  // Keep it for next time. A failed save only means the next listen voices it again.
  await fetch(objUrl, {
    method: "POST",
    headers: { ...store, "Content-Type": "audio/mpeg", "x-upsert": "true" },
    body: all,
  }).catch(() => {});

  return new Response(all, { headers: { ...audioHeaders, "X-Alfred-Audio": "fresh" } });
});
