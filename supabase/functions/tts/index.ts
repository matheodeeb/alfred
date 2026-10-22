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
 * The voice is Gemini's text-to-speech, which returns uncompressed audio. A whole brief in one
 * file would be tens of megabytes and would outgrow what one function call may hold, so a
 * brief is read in parts of about three minutes. Called without a part, the function returns
 * the plan (how many parts, how long each is); called with one, it returns that part as WAV.
 * The player starts on part one while the rest are prepared.
 *
 * Each part is generated once per row, language, voice and text, then kept in the private
 * brief-audio bucket. Playing it again, on any device, is a download rather than a new call.
 * Editing the brief changes the text hash, so the next listen voices the new version.
 *
 * Environment: GEMINI_API_KEY (a Google AI Studio key). Optional: GEMINI_TTS_MODEL,
 * GEMINI_TTS_VOICE (default Charon). Read per request, so a newly added secret takes
 * effect at once.
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
    "Access-Control-Expose-Headers": "x-alfred-audio",
    "Vary": "Origin",
  };
}

// Fresh generations are the only calls that spend quota, so they are capped per instance.
// Far above a person listening to a few briefs a day.
const GEN = { n: 0, until: 0 };
function overLimit(): boolean {
  const now = Date.now();
  if (now > GEN.until) { GEN.n = 0; GEN.until = now + 3_600_000; }
  return ++GEN.n > 80;
}

const LANG_NOTE: Record<string, string> = {
  en: "The text is in English; read it with a neutral British accent.",
  fr: "Le texte est en français ; lis-le avec une prononciation française naturelle et soignée.",
  es: "El texto está en español; léelo con una pronunciación peninsular natural y cuidada.",
};
const STYLE =
  "Read the text below aloud, word for word, as the narrator of a serious news magazine's " +
  "audio edition: calm, clear, unhurried, with the measured authority of a seasoned radio " +
  "presenter. Let headlines land and pause briefly between sections. Do not add anything. ";

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

/* About three minutes of speech per part, cut at paragraph boundaries. Short enough that
 * one part's audio sits comfortably inside a single function call, long enough that a brief
 * is only a handful of requests against Gemini's per-minute limit. */
function chunks(text: string, max = 2800): string[] {
  const out: string[] = [];
  let cur = "";
  for (const p of text.split(/\n\n+/)) {
    if (p.length > max) {
      if (cur) { out.push(cur); cur = ""; }
      let rest = p;
      while (rest.length > max) {
        const cut = Math.max(rest.lastIndexOf(". ", max), rest.lastIndexOf(" ", max));
        const at = cut > max / 2 ? cut + 1 : max;
        out.push(rest.slice(0, at).trim());
        rest = rest.slice(at).trim();
      }
      cur = rest;
      continue;
    }
    if (cur && (cur + "\n\n" + p).length > max) { out.push(cur); cur = p; }
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

/* Gemini hands back raw 16-bit mono PCM; a 44-byte header makes it a WAV every browser plays. */
function wav(pcm: Uint8Array, rate: number): Uint8Array {
  const out = new Uint8Array(44 + pcm.length);
  const v = new DataView(out.buffer);
  const w = (o: number, s: string) => { for (let i = 0; i < s.length; i++) out[o + i] = s.charCodeAt(i); };
  w(0, "RIFF"); v.setUint32(4, 36 + pcm.length, true); w(8, "WAVE");
  w(12, "fmt "); v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
  v.setUint32(24, rate, true); v.setUint32(28, rate * 2, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true);
  w(36, "data"); v.setUint32(40, pcm.length, true);
  out.set(pcm, 44);
  return out;
}

class Busy extends Error { constructor(public retry: number) { super("busy"); } }

// The TTS models have been renamed as they left preview; the first one the key can use wins.
const MODELS = ["gemini-2.5-flash-preview-tts", "gemini-2.5-flash-tts", "gemini-2.5-pro-preview-tts"];

async function voice(text: string, lang: string, key: string): Promise<Uint8Array> {
  const pinned = (Deno.env.get("GEMINI_TTS_MODEL") ?? "").trim();
  const voiceName = (Deno.env.get("GEMINI_TTS_VOICE") ?? "").trim() || "Charon";
  let last = "";
  for (const model of pinned ? [pinned] : MODELS) {
    const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
      method: "POST",
      headers: { "x-goog-api-key": key, "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [{ parts: [{ text: STYLE + (LANG_NOTE[lang] ?? LANG_NOTE.en) + "\n\n" + text }] }],
        generationConfig: {
          responseModalities: ["AUDIO"],
          speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName } } },
        },
      }),
    });
    if (r.status === 404) { last = `model ${model} not available`; continue; }
    if (r.status === 429) {
      const t = await r.text().catch(() => "");
      const m = /"retryDelay":\s*"(\d+)/.exec(t);
      throw new Busy(m ? +m[1] : 30);
    }
    if (!r.ok) {
      const t = await r.text().catch(() => "");
      throw new Error(`voice ${r.status}: ${t.slice(0, 300)}`);
    }
    const j = await r.json();
    const part = j?.candidates?.[0]?.content?.parts?.find((p: any) => p?.inlineData?.data);
    if (!part) throw new Error("voice returned no audio");
    const rate = +(/rate=(\d+)/.exec(part.inlineData.mimeType ?? "")?.[1] ?? 24000);
    return wav(unb64(part.inlineData.data), rate);
  }
  throw new Error(last || "no text-to-speech model available");
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

  const gkey = (Deno.env.get("GEMINI_API_KEY") ?? "").trim();
  const svc = serviceKey();
  if (!gkey) return json({ error: "not_configured", detail: "GEMINI_API_KEY is not set on the tts function." }, 503);
  if (!SB_URL || !svc) return json({ error: "storage unavailable" }, 500);

  let body: { id?: string; lang?: string; part?: number } = {};
  try { body = await req.json(); } catch { return json({ error: "bad json" }, 400); }
  const id = String(body.id ?? "");
  const lang = LANG_NOTE[String(body.lang)] ? String(body.lang) : "en";
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
  const parts = chunks(text);

  if (body.part == null) return json({ parts: parts.length, chars: parts.map((p) => p.length), lang: speakLang });

  const i = Math.floor(Number(body.part));
  if (!(i >= 0 && i < parts.length)) return json({ error: "no such part" }, 400);

  // The voice is part of the name, so changing voices re-records rather than replaying the old one.
  const v = (Deno.env.get("GEMINI_TTS_VOICE") ?? "").trim() || "Charon";
  const path = `${id.replace(/[^A-Za-z0-9_-]/g, "_")}/${speakLang}-${await sha(v + "|" + text)}-${i}.wav`;
  const objUrl = `${SB_URL}/storage/v1/object/${BUCKET}/${path}`;
  const store = { apikey: svc, Authorization: `Bearer ${svc}` };
  const audioHeaders = { ...CORS, "Content-Type": "audio/wav", "Cache-Control": "no-store" };

  const hit = await fetch(objUrl, { headers: store });
  if (hit.ok) return new Response(hit.body, { headers: { ...audioHeaders, "x-alfred-audio": "cached" } });

  if (overLimit()) return json({ error: "rate_limited", retry: 600 }, 429);
  let audio: Uint8Array;
  try {
    audio = await voice(parts[i], speakLang, gkey);
  } catch (e) {
    if (e instanceof Busy) return json({ error: "busy", retry: e.retry }, 429);
    return json({ error: "voice_failed", detail: String((e as Error).message ?? e) }, 502);
  }

  // Keep it for next time. A failed save only means the next listen voices it again.
  await fetch(objUrl, {
    method: "POST",
    headers: { ...store, "Content-Type": "audio/wav", "x-upsert": "true" },
    body: audio,
  }).catch(() => {});

  return new Response(audio, { headers: { ...audioHeaders, "x-alfred-audio": "fresh" } });
});
