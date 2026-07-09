# Option 1 — Command Center

**One-liner:** Turn the single-page tab layout into a proper dashboard app: persistent sidebar, an Overview landing page that answers "what's happening?" at a glance, and denser, smarter tables.

Open `option-1-command-center.html` in a browser to see it.

## The core UX idea

The current app makes you *work* to get answers. The summary strip shows lifetime totals, but the questions you actually open the app with are temporal and actionable: *what's arriving this week? what did I spend this month? did anything fail to parse?* A dashboard's job is to answer those before you click anything.

## What changes vs. current design

**Sidebar navigation replaces tabs.** Orders, Items, Analytics, Settings, plus two new destinations: an **Overview** landing page and a **Needs Review** queue. Counts live on the nav items, so "38 orders / 214 items" stops taking up summary-strip real estate. The Gmail connection status and last-sync time move to the sidebar footer — persistent but out of the way, instead of a log box pushing content down.

**KPI cards with trend context.** Each stat gains a comparison ("▲ $212 this month") and a 6-month sparkline. Numbers without context are trivia; numbers with deltas are information. The hero card (Total charged) is visually dominant on dark, so the eye lands in the right place first.

**"Needs review" becomes a first-class queue.** Right now, estimated prices (the ≈ symbol) and failed emails are scattered inline and easy to miss. This design collects everything low-confidence — vision misreads, unmatched status emails, estimated splits — into one queue with a badge count. Fix them in one sitting, trust the data afterwards.

**"Arriving soon" panel.** The status data you already collect (shipped/delivered) finally earns its keep: a small panel of what's in transit and when to expect it. This is arguably the single highest-value addition for day-to-day use.

**Denser tables, richer rows.** Listed price struck through *inside* the Paid column, discount % as a green sub-line, category and qty as a muted sub-line under the name. One row carries what currently takes five columns, which is what lets the layout go two-column.

## Tradeoffs

- Most implementation effort of the three options (new Overview page, review queue, delivery-estimate logic).
- Sidebar costs ~220px of width — fine on desktop, needs a drawer on mobile.
- Loses some of the current quirky receipt personality; this is the most "generic SaaS" direction.

## Effort estimate

Medium-high. Layout restructure + two new views. The review queue and arriving-soon logic are mostly derivations of data already stored. ~2–3 sessions.
