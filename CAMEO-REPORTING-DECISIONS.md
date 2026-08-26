# Cameo plant monitor — production reporting: decision log

**Status: paused mid-conversation, 26 August 2026. Resume by re-asking the two open
questions at the bottom, verbatim.**

Working note for the **Cameo Paper Plant Monitor** (`matheodeeb/my-next-big-thing`,
live at cameo-paper-plant-monitor.lovable.app/legacy). It lives in this repo only
because this is the branch designated for the work; nothing here has been applied to
the Cameo app. No code has been written or committed to that project.

---

## The goal

Elizabet does her production reports **entirely on the website**. No data entry
anywhere else — the MACRO workbook is retired as an input.

## What the six .xlsm files turned out to be

Six daily saves of one workbook (Elizabet's MACRO workbook), 19–25 August. Every
analysis tab is byte-identical across all six; only the production log grows. File 1
(25 Aug) is a strict superset.

**The site has already absorbed it.** Verified against the live database:

- Production reconciles month by month, Jan–Aug (23,329 / 20,667 / 25,210 /
  10,221+8,980 / 25,660 / 22,891 / 25,262 / 20,389). Only napkins drift: site is
  +3 in May, +201 in July.
- Monthly OEE Jan–Jun identical to `analysisData.months`.
- April Causes and June OEE Cause imported verbatim, tagged
  "[Imported from the Elizabet workbook]".
- Bottleneck tables for May and June both present.
- NOTE tab constants already in `prodSpec()` — jumbo 911 kg, cases/jumbo 379.6 and
  214.35, roll 0.05/0.085 kg, roll length 9.2/10 cm.

So there is **no bulk import to do**. The workbook is the site's ancestor, now behind it.

## What actually blocks Elizabet

1. **No lost-time capture** → Availability broken since July. The only one that
   breaks a number.
2. **Pareto stoppage log never used** — `paretoEvents` is an empty array. It already
   has a 16-cause catalogue (`PARETO_CAUSES`) and `anAvailFromPareto()` already
   derives Availability from it. This is also the fix for (1).
3. **Single-number machine speeds** → Performance measured against a wrong target
   since the April switch to Cameo.
4. **Process map has no real home** — the one artefact she'd still open Excel for.

---

## Decisions locked

### Lost time / Availability
- **Stoppage log only.** No separate worked-hours field. Machine + cause + minutes;
  worked hours derive from it.
- **Elizabet enters it once a day**, from the operators' paper sheets. Office screen,
  keyboard, dense table. Floor version stays possible later.
- **Plant clock** as the denominator — matches how she already does it
  (12.69/18 = 70.5%). Machine-level log feeds the Pareto ranking underneath.
  → Consequence: `anAvailFromPareto()` must change. It currently divides by
  `PARETO_MACHINES.length` (8 machines) × scheduled hours.
- **July shows as "not measured"**, not 0%. 27 days of planned hours, zero worked
  hours; the workbook doesn't have them either, so it is unrecoverable from any
  source we hold.

### Machine speeds
- **Two numbers per machine, not three: design max and the speed we set it to.**
  No "achieved rate" field. Matheo's reasoning, verbatim: *"the machines doesnt stay
  100% of its production time at the speed we target. we play with it and change it
  depending on the machines production . therefore, we dont need to track the achieved
  rate, only the maximum and rate which we set"*
- **Alpha gets per-product rates** — 11 logs/min on 509, 9 on Cameo. Flat 11.25 today,
  so Performance has been measured against a target ~20% too high since May.
  Restating history was accepted (option chosen was the plain "yes", not the
  "don't restate history" variant).
- **Efficiencies tab is the single source** for machine speeds; the Pareto machine
  list reads from it instead of holding its own copy.

### Context behind the speed decisions

Matheo's correction that reframed this: *the planned and unplanned downtime on the
Alpha is what allows the Coremaker to match its demand.* So the Coremaker is a
**masked bottleneck** — fixing Alpha's availability moves the constraint onto the
Coremaker rather than raising output proportionally. Worth stating on the site as a
relationship, not a static "Critical" row.

Three Coremaker numbers currently exist in the system:

| Source | Value | Probably is |
|---|---|---|
| Efficiencies (`efficiency`) | 130 m/min ≈ 18 cores/min, derived from a floor reading of 30% = 5.4 cores/min | Design max |
| `PARETO_MACHINES` | 21.875 cores/min | Unexplained, no derivation recorded |
| Workbook | 7 cores/min | Observed output |

Same pattern on Alpha: Efficiencies derives 11.3 logs/min from 71% = 8.0.

Note the Coremaker was measured *running at 30% speed* — so its 7/min is a set-point,
not a ceiling. That makes it the same finding as the workbook's "Speed Limited by
Management", not a separate one.

---

## OPEN — resume here, re-ask these two verbatim

Asked once and dismissed; not yet answered.

### Q1 — Set speed: what does the site store?

*You said you change the set speed during the day depending on how the machine is
running. So what should the site store as "the speed we set it to"?*

- **One current value per machine (recommended)** — the standard speed the machine is
  normally run at, e.g. Coremaker 30%. Elizabet edits it only when the standing
  instruction changes. Simple, and it is what Performance targets should be measured
  against; the day-to-day nudging averages out.
- **One value, with change history** — same single number, but dated log each time it
  changes. Lets you see "we raised Alpha from 71% to 85% in September and output
  did/didn't move". Slightly more to maintain, much better for proving a speed change
  worked.
- **A range (min–max)** — the band you actually operate within, e.g. 65–80%. Honest
  about variation, but gives no single number for the Performance target; the maths
  would need a midpoint anyway.
- **Per day, on the daily entry** — Elizabet records the day's speed alongside
  production. Most precise, but a new field every single day, and the speed moves
  around within the day anyway.

### Q2 — What is Performance measured against?

*Given there is no "achieved rate" field, what should Performance be measured against?*

- **The set speed (recommended)** — compares real output to what the machine should
  make at the speed you deliberately run it. Answers "did we get what we asked for?",
  the operational question. The gap to design max shows separately as headroom.
- **The design max** — compares output to full capability. Answers "how far from the
  theoretical ceiling are we?" Numbers look much worse, because the management speed
  cap is baked into the loss.
- **Both, side by side** — the gap between them is exactly the cost of the speed
  policy, useful evidence for the "speed limited by management" bottleneck. But two
  Performance numbers in one report needs careful labelling.

## Then, still to discuss

- **Process map (point 3).** The 16-cause `PARETO_CAUSES` catalogue already covers
  most of the workbook's failure modes — anilox, sensor, pneumatic, jumbo change,
  no operator are already there verbatim. What's missing is the **machine → likely
  cause** mapping (so picking "Wrapper Otto" narrows the list), plus 3–4 genuinely
  new causes (brush lubrication, mini-packaging positioning, pusher-roller blockage).
  Open question: does the process map become its own editable section, or a view over
  the Efficiencies registry?
- **Build sequence.** Suggested order: (1)+(2) together first — nothing else matters
  until Availability computes again — then speeds, then the process map.

## Ground rules for the Cameo repo (from its CLAUDE.md)

- The live app is `src/lib/cameo-app-LIVE.html`. The similarly-named React routes are
  hidden; editing them changes nothing visible.
- `bun test` is the only gate on legacy JS. `bun run lint:hooks` after any `.tsx`.
  `bun run build` does not execute legacy JS.
- A git push does **not** update the live site — a human clicks Publish → Update in
  Lovable.
- Never rewrite pushed history; the two-way Lovable sync breaks.
