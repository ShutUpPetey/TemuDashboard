# UX Design Options — Temu Order Manifest

Three directions for the next iteration of the app. Each has a self-contained HTML mockup (open in any browser, dummy data, no build needed) and a supporting doc.

| | Option 1 — Command Center | Option 2 — Paper Ledger | Option 3 — Visual Gallery |
|---|---|---|---|
| **Files** | `option-1-command-center.*` | `option-2-paper-ledger.*` | `option-3-visual-gallery.*` |
| **Primary object** | The dashboard (KPIs + queues) | The order (as a receipt) | The item (as a photo card) |
| **Personality** | Serious SaaS tool | Playful, tactile, personal | Modern shopping app |
| **Best at** | "What needs my attention?" | Enjoyable browsing, at-a-glance status | Finding/remembering items, mobile use |
| **Weakest at** | Charm; mobile needs a drawer | Dense sorting/comparison | Order-level financial detail |
| **New capabilities introduced** | Overview page, Needs-review queue, Arriving-soon panel, trend deltas | Per-item handwritten notes, stamp statuses | Detail sheet w/ status timeline, smart filter chips, filter-aware stats dock |
| **Effort** | Medium-high (~2–3 sessions) | Low-medium (~1–2 sessions) | Medium (~2 sessions) |

## How to compare them fairly

Each mockup answers the same three user questions differently — check how fast each design gets you there:

1. **"Did my stuff ship?"** — Option 1: Arriving-soon panel. Option 2: sticky note + stamps. Option 3: status dots + In-transit chip.
2. **"What did I actually pay for that thing?"** — Option 1: table row sub-line. Option 2: receipt line item. Option 3: card price + detail sheet.
3. **"Is my data trustworthy?"** — Option 1: dedicated review queue (strongest). Option 2: inline ≈ marks. Option 3: Needs-review chip.

## Recommendation

**Option 3 (Visual Gallery) as the structural base, stealing the two best ideas from the others:**

- Option 1's **Needs-review queue** (as a smart chip + dedicated view) — it's the biggest trust-builder for vision-parsed data.
- Option 2's **rubber-stamp statuses** inside the order view and detail sheet — highest information-per-pixel status treatment of the three, and keeps the app's existing receipt personality alive.

Reasoning: the app's data model is item-centric (discount distribution, categories, per-item prices are the core feature), the newly-fixed thumbnails make an image-first layout finally viable, and it's the only direction that's genuinely good on a phone — which is where "did it ship yet?" gets asked. Option 2 is the most charming and cheapest to ship, so if the goal is maximum pop for minimum work, it's a legitimate pick on its own.

These directions aren't mutually exclusive with the current codebase — all three keep the existing React/data layer and mostly replace the presentation layer.
