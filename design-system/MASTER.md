# Leadium CRM Design System

This file is the design source of truth for UI work in this repository. It adapts ideas from Anthropic `frontend-design` and `ui-ux-pro-max` to this specific product: an operational cruise CRM for leads, calls, tasks, WhatsApp, post-sale documents, payments, and admin review.

## Product Stance

Leadium is not a marketing site. It is an operations cockpit.

The UI should help operators decide what to do next, reduce ambiguity, and keep dense information readable during repeated daily use. A screen is successful when the user can understand status, urgency, owner, next action, and blockers without hunting.

## Design Priorities

1. Clarity before decoration.
2. Workflow continuity before novelty.
3. Dense but calm information layouts.
4. Color used for meaning, not mood.
5. Controls named by what the operator understands.
6. Progressive disclosure for complex decisions.
7. No duplicate UI when an existing view already owns the workflow.

## Visual Direction

Leadium should feel like a precise travel operations desk: organized, brisk, trustworthy, and quietly premium. Avoid landing-page energy, decorative hero sections, oversized cards, and visual effects that make the product feel less operational.

Use distinctive touches only where they clarify the domain or state of work. Spend visual personality in one place per feature, then keep the rest restrained.

## Existing Token Direction

Use the app's existing palette as the base. Do not introduce a competing theme unless refactoring the entire design system.

Core surfaces:
- App background: `#f2f5f9`, `#e9edf3`
- Panel background: `#ffffff`
- Soft panel background: `#fbfdff`, `#f8fbff`
- Border: `#d5deea`, `#d8e1ee`, `#dbe4f0`
- Primary text: `#1b2a40`, `#213b62`, `#244061`
- Secondary text: `#5f7595`, `#6d83a3`, `#7186a4`
- Primary action: `#225fb6`, `#2e66b7`, `#3d79cf`

Semantic colors:
- New / info: blue family
- Contact / waiting: amber family
- Converted / complete: green family
- Lost / blocked / error: red family
- Review / ready: blue or amber, depending on action urgency

Do not use color as the only status indicator. Pair it with labels, icons, text, or placement.

## Typography

The current app uses `"Space Grotesk", "Segoe UI", sans-serif`. Keep it unless deliberately changing the full product typography.

Rules:
- Compact panels use small, strong labels.
- Row/list content should favor 11-14px text with clear hierarchy.
- Hero-scale type is reserved for true page-level headers, not cards, modals, or table rows.
- Letter spacing should stay at `0` unless used sparingly for small uppercase metadata.

## Layout Rules

Operational pages should be built around:
- full-width sections
- dense rows
- predictable filters
- sticky/list headers where useful
- side drawers and modals for focused decisions
- stable dimensions for cards, buttons, counters, and row cells

Avoid:
- card inside card
- page sections styled as decorative floating cards
- duplicate summary panels for data already owned by a tab/view
- bento grids unless the information is genuinely dashboard-like
- empty decorative gradients, blobs, or orbs

Preferred radii:
- Rows, panels, controls: `8px`
- Modals and larger guided flows: `8px` to `12px`
- Pills/badges/avatar chips: `999px`

## Interaction Rules

Complex actions should be step-by-step, not a single overloaded select.

Examples:
- Call outcome: first ask whether the customer answered, then ask the customer outcome.
- Practice closure: checklist first, final note second, admin review third.
- Admin return: require a clear reason before sending back to operator.

Buttons should say the action they perform:
- `Salva esito`
- `Completa pratica`
- `Rimanda pratica`
- `Chiudi 100%`

Avoid generic labels like `Submit`, `OK`, or feature-describing copy inside the app.

## CRM Page Patterns

### Pratiche List

Goal: scan and choose the next action quickly.

Must preserve:
- row density
- filters above list
- visible status, priority, owner, SLA, next action
- admin/operator scope differences

Enhance through:
- better row affordances
- clearer state badges
- keyboard/focus support
- more meaningful empty states

Do not add separate panels if the same work already lives in `Attive`, `Pronte`, or `Archivio`.

### Pratica Detail

Goal: resolve one customer/practice end-to-end.

Must preserve:
- top identity/context
- documents and payments as operational checklists
- call/task/timeline context
- closure band as the single source for completion/review state

Use guided modals for actions that have consequences.

### Dashboard

Goal: summarize workload and risk.

Use data-dense dashboard principles:
- compact KPIs
- trend and queue information
- direct links to work
- no vanity charts without a decision attached

### Chat / WhatsApp

Goal: help the operator reply and move work forward.

Messages and recommended actions should stay connected to actual lead/practice state. Avoid decorative chat UI that hides tasks, documents, payments, or ownership.

## Accessibility And Quality Bar

Every UI change should check:
- keyboard focus is visible
- text contrast is readable
- mobile layouts do not overlap
- button text fits without clipping
- hover/focus/disabled states exist
- motion is subtle and not required to understand state
- error and empty states explain the next useful action

## Pre-Delivery Checklist

Before marking a UI change done:
- The feature belongs in the page where it was added.
- It does not duplicate an existing workflow.
- Labels use operator language, not backend language.
- Important state is visible without opening a modal.
- The layout is still usable on mobile.
- Build passes.
- If the change affects core workflow, test the happy path and one failure path.

## Source Inspiration

This system is informed by:
- Anthropic `frontend-design`: intentional, non-templated visual design, restraint, and copy clarity.
- `ui-ux-pro-max`: design system generation, dashboard patterns, accessibility checks, and UI anti-patterns.

These are references, not automatic rules. Leadium's operational CRM needs win over generic design-system recommendations.
