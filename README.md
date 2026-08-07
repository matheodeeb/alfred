# Alfred — personal life console

Offline-first PWA for personal life admin: menus for the cook, stock counts, orders, payroll, schedules, timelines, net worth, projects.

- **Offline-first:** all data lives on-device (localStorage) and every edit saves instantly.
- **Cloud sync:** when online, changes sync to a private Supabase table (last edit wins). Sync config is entered once per device and is never committed to this repo.
- **Adding a device:** on a device that already syncs, open settings → **Copy setup link**, then open that link on the new device — it picks up the config and pulls everything down. Otherwise retype the URL, key and secret in settings.
- **PIN lock:** 4-digit PIN gate (UI-level, not encryption).
- **Install:** open the site → Share → Add to Home Screen (iPhone) or Install (Chrome on Mac).

Static site — no build step. Hosted on GitHub Pages.
