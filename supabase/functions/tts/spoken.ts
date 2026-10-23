/* Written text to spoken text, before the voice sees it.
 *
 * A narrator reads "6,79 dollars" as "six dollars soixante-dix-neuf", not "six virgule
 * soixante-dix-neuf dollars"; "+0,4 %" as "plus zéro virgule quatre pour cent"; "XXIe siècle"
 * as "vingt-et-unième siècle". Left to itself the voice sometimes reads the page rather than
 * speaking it, so the forms people say differently from how they write them are rewritten
 * here, deterministically. Everything else is left to the voice, with instructions on how a
 * native speaker reads numbers (LANG_NOTE in index.ts).
 *
 * Each rule is written for the way that language writes numbers: French and Spanish use a
 * decimal comma and a space or full stop for thousands; English uses a decimal point and a
 * thousands comma. */

type Lang = "en" | "fr" | "es";

// Digits, optionally grouped by thousands, optionally with decimals, in each language's style.
const NUM = {
  fr: String.raw`\d{1,3}(?:[   .]\d{3})+(?:,\d+)?|\d+(?:,\d+)?`,
  es: String.raw`\d{1,3}(?:[.   ]\d{3})+(?:,\d+)?|\d+(?:,\d+)?`,
  en: String.raw`\d{1,3}(?:,\d{3})+(?:\.\d+)?|\d+(?:\.\d+)?`,
};

const CUR: Record<Lang, Record<string, [string, string]>> = {
  // symbol or word -> [singular, plural]
  fr: { "$": ["dollar", "dollars"], "€": ["euro", "euros"], "£": ["livre", "livres"], "¥": ["yen", "yens"] },
  es: { "$": ["dólar", "dólares"], "€": ["euro", "euros"], "£": ["libra", "libras"], "¥": ["yen", "yenes"] },
  en: { "$": ["dollar", "dollars"], "€": ["euro", "euros"], "£": ["pound", "pounds"], "¥": ["yen", "yen"] },
};
const CODES: Record<string, string> = { USD: "$", "US$": "$", EUR: "€", GBP: "£", JPY: "¥" };
const WORD2SYM: Record<Lang, Record<string, string>> = {
  fr: { dollar: "$", dollars: "$", euro: "€", euros: "€", livre: "£", livres: "£" },
  es: { "dólar": "$", "dólares": "$", euro: "€", euros: "€", libra: "£", libras: "£" },
  en: { dollar: "$", dollars: "$", euro: "€", euros: "€", pound: "£", pounds: "£" },
};

const SCALE: Record<Lang, Record<string, [string, string]>> = {
  fr: { k: ["mille", "mille"], m: ["million", "millions"], md: ["milliard", "milliards"], mds: ["milliard", "milliards"], mrd: ["milliard", "milliards"], bn: ["milliard", "milliards"], tn: ["billion", "billions"] },
  es: { k: ["mil", "mil"], m: ["millón", "millones"], mm: ["mil millones", "mil millones"], bn: ["mil millones", "mil millones"], b: ["mil millones", "mil millones"], tn: ["billón", "billones"] },
  en: { k: ["thousand", "thousand"], m: ["million", "million"], bn: ["billion", "billion"], b: ["billion", "billion"], tn: ["trillion", "trillion"], trn: ["trillion", "trillion"] },
};

const ROMAN: Record<string, number> = { I: 1, V: 5, X: 10, L: 50, C: 100 };
function roman(s: string): number {
  let n = 0;
  for (let i = 0; i < s.length; i++) {
    const a = ROMAN[s[i]], b = ROMAN[s[i + 1]] ?? 0;
    n += a < b ? -a : a;
  }
  return n;
}

// The number as the voice should see it: thousands run together, the decimal mark kept.
function plain(n: string, lang: Lang): string {
  if (lang === "en") return n.replace(/,/g, "");
  return n.replace(/[   ]/g, "").replace(/\.(?=\d{3}\b)/g, "");
}
function splitDec(n: string, lang: Lang): [string, string] {
  const p = plain(n, lang);
  const i = p.indexOf(lang === "en" ? "." : ",");
  return i < 0 ? [p, ""] : [p.slice(0, i), p.slice(i + 1)];
}

/* An amount of money. With cents it is said as units then cents ("6 dollars 79"), the way a
 * person says a price, never with the decimal mark. With a scale word it is "5,2 milliards de
 * dollars"; and ",5" of a million or a billion is "et demi" / "y medio" / "and a half". */
function money(num: string, sym: string, scale: string, lang: Lang): string {
  const [unit, cents] = splitDec(num, lang);
  const [one, many] = CUR[lang][sym];
  if (scale) {
    const sc = SCALE[lang][scale.toLowerCase()];
    if (!sc) return `${num} ${scale} ${many}`;
    const many2 = cents ? sc[1] : (+unit <= 1 ? sc[0] : sc[1]);
    const half = cents === "5";
    if (lang === "fr") {
      const of = sc[0] === "mille" ? "" : /^[aeiouéè]/.test(many) ? " d'" : " de ";
      const sp = of ? "" : " ";
      return half ? `${unit} ${+unit <= 1 ? sc[0] : sc[1]} et demi${of}${sp}${many}` : `${plain(num, lang)} ${many2}${of}${sp}${many}`;
    }
    if (lang === "es") {
      const of = sc[0] === "mil" ? "" : " de";
      if (half && sc[0] === "millón") return `${+unit === 1 ? "un millón" : unit + " millones"} y medio de ${many}`;
      return `${plain(num, lang)} ${many2}${of} ${many}`;
    }
    return half ? `${unit} and a half ${sc[0]} ${many}` : `${plain(num, lang)} ${sc[0]} ${many}`;
  }
  const u = +unit === 1 ? one : many;
  if (!cents || /^0+$/.test(cents)) return `${unit} ${u}`;
  if (cents.length > 2) return `${plain(num, lang)} ${many}`;
  const c = String(+cents.padEnd(2, "0"));
  if (lang === "fr") return `${unit} ${u} ${c}`;
  if (lang === "es") return `${unit} ${u} con ${c}`;
  return `${unit} ${u} ${c}`;
}

function frenchAndSpanish(t: string, lang: "fr" | "es"): string {
  const N = NUM[lang];
  const SYM = "[$€£¥]";
  const scaleWords = lang === "fr" ? "k|M|Md|Mds|Mrd|bn|tn" : "k|M|mm|MM|bn|tn";

  // "US$ 6,79", "6,79 USD" -> symbols first, so one set of rules covers both
  t = t.replace(/\b(USD|EUR|GBP|JPY)\b/g, (m) => CODES[m] ?? m).replace(/US\$/g, "$");

  // Amounts with a scale: "5,2 Md$", "5,2 Mds $", "$5,2 bn", "300 M€"
  t = t.replace(new RegExp(`(${SYM})\\s?(${N})\\s?(${scaleWords})\\b`, "g"), (_m, s, n, sc) => money(n, s, sc, lang));
  t = t.replace(new RegExp(`(?<![\\w,])(${N})\\s?(${scaleWords})\\s?(${SYM})`, "g"), (_m, n, sc, s) => money(n, s, sc, lang));

  // Prices: "6,79 $", "6,79 dollars", "$6,79", "4,50 €", "1 234,50 euros"
  const words = Object.keys(WORD2SYM[lang]).join("|");
  t = t.replace(new RegExp(`(${SYM})\\s?(${N})(?![\\d,])`, "g"), (_m, s, n) => money(n, s, "", lang));
  t = t.replace(new RegExp(`(?<![\\w,])(${N})\\s?(${SYM})`, "g"), (_m, n, s) => money(n, s, "", lang));
  t = t.replace(new RegExp(`(?<![\\w,])(${N})\\s(${words})\\b`, "gi"), (m, n, w) => {
    const s = WORD2SYM[lang][w.toLowerCase()];
    return s && /,/.test(n) ? money(n, s, "", lang) : m;
  });

  // "1,5 milliard" -> "1 milliard et demi"; "2,5 millones" -> "2 millones y medio"
  if (lang === "fr") t = t.replace(/\b(\d+),5 (millions?|milliards?|billions?)\b/g, "$1 $2 et demi");
  else t = t.replace(/\b(\d+),5 (millones|millón)\b/g, (_m, n) => (+n === 1 ? "un millón y medio" : `${n} millones y medio`));

  // Signs and percentages: "+0,4 %" -> "plus 0,4 pour cent"; "−3 pp" -> "moins 3 points"
  const plus = lang === "fr" ? "plus" : "más", minus = lang === "fr" ? "moins" : "menos";
  t = t.replace(/(^|[\s(])\+\s?(?=\d)/g, `$1${plus} `).replace(/(^|[\s(])[−–-]\s?(?=\d)/g, `$1${minus} `);
  t = t.replace(/\s?%/g, lang === "fr" ? " pour cent" : " por ciento");
  t = t.replace(new RegExp(`(${N})\\s?(?:pp|pts?|p\\.p\\.)(?=[\\s.,;:)]|$)`, "g"), (_m, n) =>
    lang === "fr" ? `${n} ${parseFloat(plain(n, lang).replace(",", ".")) < 2 ? "point" : "points"}` : `${n} puntos`);

  // Ranges "2025-2030", "2–3" -> "2025 à 2030" / "2025 a 2030"
  const and = lang === "fr" ? "et" : "y", to = lang === "fr" ? "à" : "a";
  t = t.replace(/\b(entre)\s(\d{1,4})\s?[–-]\s?(\d{1,4})\b/gi, `$1 $2 ${and} $3`);
  t = t.replace(/\b(\d{1,4})\s?[–-]\s?(\d{1,4})\b/g, `$1 ${to} $2`);

  if (lang === "fr") {
    // Centuries and ordinals: "XXIe siècle" -> "21ème siècle"; "1er" -> "premier"; "209e" -> "209ème"
    // Only before the words that take one, or "Ce" and "Le" would become numbers.
    t = t.replace(/\b([IVXLC]+)(?:e|ème)(?=\s(?:siècles?|millénaire|arrondissement|République|Reich|Congrès|congrès|plénum|Plénum)\b)/g,
      (_m, r) => `${roman(r)}ème`);
    t = t.replace(/\b1er\b/g, "premier").replace(/\b1re\b/g, "première").replace(/\b1ère\b/g, "première");
    t = t.replace(/\b(\d+)(?:ème|eme|e|è)(?![A-Za-zÀ-ÿ])/g, "$1ème");
    // Times: "15h30" -> "15 heures 30", "9h" -> "9 heures"
    t = t.replace(/\b(\d{1,2})\s?h\s?(\d{2})\b/g, "$1 heures $2").replace(/\b(\d{1,2})\s?h\b/g, "$1 heures");
    // Titles and abbreviations
    t = t.replace(/\bM\.\s(?=[A-ZÉ])/g, "Monsieur ").replace(/\bMme\b\.?/g, "Madame").replace(/\bMM\.\s/g, "Messieurs ");
    t = t.replace(/\bn°\s?/g, "numéro ").replace(/\bc\.-à-d\./g, "c'est-à-dire").replace(/\benv\.\s/g, "environ ");
    t = t.replace(/\bvs\.?\s/g, "contre ").replace(/\s&\s/g, " et ");
    // Units
    t = t.replace(/(\d)\s?km²/g, "$1 kilomètres carrés").replace(/(\d)\s?km\/h\b/g, "$1 kilomètres heure")
      .replace(/(\d)\s?km\b/g, "$1 kilomètres").replace(/(\d)\s?kg\b/g, "$1 kilos")
      .replace(/(\d)\s?°C\b/g, "$1 degrés").replace(/(\d)\s?mb\/j\b/g, "$1 millions de barils par jour")
      .replace(/(\d)\s?b\/j\b/g, "$1 barils par jour").replace(/(\d)\s?Mt\b/g, "$1 millions de tonnes");
  } else {
    t = t.replace(/\bEE\.\s?UU\.?/g, "Estados Unidos").replace(/\bSr\.\s/g, "señor ").replace(/\bSra\.\s/g, "señora ");
    t = t.replace(/\bn\.º\s?/g, "número ").replace(/\bvs\.?\s/g, "contra ").replace(/\s&\s/g, " y ");
    t = t.replace(/\bsiglo ([IVXLC]+)\b/g, (_m, r) => `siglo ${roman(r)}`);
    t = t.replace(/(\d)\s?km²/g, "$1 kilómetros cuadrados").replace(/(\d)\s?km\/h\b/g, "$1 kilómetros por hora")
      .replace(/(\d)\s?km\b/g, "$1 kilómetros").replace(/(\d)\s?kg\b/g, "$1 kilos")
      .replace(/(\d)\s?°C\b/g, "$1 grados").replace(/(\d)\s?b\/d\b/g, "$1 barriles diarios");
  }
  return t;
}

function english(t: string): string {
  const N = NUM.en;
  // "$5.2bn", "£300m", "€1trn" -> "$5.2 billion": English voices read "$5.2 billion deal"
  // naturally, prices like "$6.79" too, so only the abbreviation needs spelling out.
  const SC: Record<string, string> = { k: "thousand", m: "million", bn: "billion", b: "billion", tn: "trillion", trn: "trillion" };
  t = t.replace(new RegExp(`([$€£¥])\\s?(${N})\\s?(k|m|bn|b|tn|trn)\\b`, "gi"), (_m, s, n, sc) => `${s}${n} ${SC[sc.toLowerCase()]}`);
  t = t.replace(/(^|[\s(])\+\s?(?=\d)/g, "$1plus ").replace(/(^|[\s(])[−–]\s?(?=\d)/g, "$1minus ");
  t = t.replace(/\s?%/g, " percent").replace(/(\d)\s?(pp|pts?)(?=[\s.,;:)]|$)/g, "$1 points");
  t = t.replace(/\b(between)\s(\d{1,4})\s?[–-]\s?(\d{1,4})\b/gi, "$1 $2 and $3")
    .replace(/\b(\d{4})\s?[–-]\s?(\d{2,4})\b/g, "$1 to $2").replace(/\b(\d{1,3})\s?–\s?(\d{1,3})\b/g, "$1 to $2");
  t = t.replace(/\bvs\.?\s/g, "versus ").replace(/\bb\/d\b|\bbpd\b/g, "barrels a day").replace(/\bmb\/d\b/g, "million barrels a day");
  t = t.replace(/(\d)\s?km\b/g, "$1 kilometres").replace(/(\d)\s?kg\b/g, "$1 kilograms").replace(/(\d)\s?°C\b/g, "$1 degrees");
  return t;
}

export function spoken(text: string, lang: string): string {
  const l = (lang === "fr" || lang === "es") ? lang : "en";
  // non-breaking and narrow spaces read as nothing; make them plain so every rule sees them
  const t = text.replace(/[\u00a0\u202f]/g, " ")
    // "2007-09" is two full years; spell the second out so every language's range rule reads it
    .replace(/\b((1[89]|20)\d{2})\s?[–-]\s?(\d{2})\b(?![\d-])/g, (_m, a, c, b) => `${a}-${+b > +a.slice(2) ? c : String(+c + 1)}${b}`);
  return l === "en" ? english(t) : frenchAndSpanish(t, l);
}
