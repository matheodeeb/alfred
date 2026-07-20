# Alfred — personal life console

Offline-first PWA for personal life admin: menus for the cook, stock counts, orders, payroll, schedules, timelines, net worth, projects.

- **Offline-first:** all data lives on-device (localStorage) and every edit saves instantly.
- **Cloud sync:** when online, changes sync to a private Supabase table (last edit wins). Sync config is entered once per device via settings or a `#cfg=` setup link — it is never committed to this repo.
- **PIN lock:** 4-digit PIN gate (UI-level, not encryption).
- **Install:** open the site → Share → Add to Home Screen (iPhone) or Install (Chrome on Mac).

Static site — no build step. Hosted on GitHub Pages.
