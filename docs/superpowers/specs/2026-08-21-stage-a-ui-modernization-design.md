# Stage A — UI Modernization + Dark Mode — Design Spec

## Overview

The Cloud Cost Review Portal (Phase 1 of the product roadmap: login, AWS/Azure upload + reporting, comparison, staff review workflow, Admin UI) is fully built and live in production, styled entirely with hand-rolled CSS Modules against 6 CSS custom properties in `app/globals.css`. This is the first of four planned follow-on stages (see `docs/superpowers/plans/` roadmap discussion) — the others being enhanced charts/a line-item view, subscription billing, and AI anomaly detection — all of which build on top of whatever design-system foundation this stage establishes.

This stage introduces Tailwind CSS + shadcn/ui as the project's UI foundation going forward, wires up dark mode, and migrates only the app shell (tab bar, sign-out button, new theme toggle) plus the global token layer — not a full-app visual rewrite. Every other page benefits immediately from correct dark-mode colors via the shared token layer, even before its own component is individually migrated to shadcn.

## Goals

- Add Tailwind CSS (v4) and shadcn/ui to the project as reusable, incrementally-adoptable UI primitives — not a big-bang rewrite of every component.
- Add dark mode, defaulting to system preference, with a manual toggle that overrides and persists.
- Fix the two inconsistent hardcoded "error red" values (`#d1274b`, `#b3261e`) and the accent-blue hardcoded twice as inline Recharts SVG props, replacing them with proper tokens/theme-aware values.
- Migrate `components/shell/AppShell.tsx`'s tab bar and sign-out button to shadcn primitives, as the first concrete example of the migration pattern later stages/components will follow.
- Establish the token-mapping convention (existing 6 CSS vars → shadcn's expected variable names) that all future component migrations reuse.

## Non-goals (this stage)

- No migration of `LoginForm`, `UploadForm`, `AdminCompanies`/`AdminUsers`, `NotesFeed`, or any report/table component to shadcn — those stay on their current CSS Modules for now and migrate opportunistically in later stages (starting with Stage B's chart/table work, which needs a `Table` primitive anyway).
- No new chart features, no line-item view, no billing, no AI — those are separate stages already scoped in the roadmap.
- No design-system component beyond what the shell needs this pass: `Button`, `Tabs`, plus whatever shadcn scaffolds as shared primitives (`Card`, `Badge`) even if unused immediately, since shadcn's CLI generates a few interdependent files together.

## Technical constraints

- Must not regress any existing test (`npm test`) — existing tests query by ARIA role/text, not CSS class names, so a pure styling change shouldn't break them; component behavior (tab switching, sign-out) must stay identical.
- Must work with this project's exact stack: Next.js 16.3.1 (App Router, Turbopack), React 19.2.8, TypeScript. Tailwind v4 + Turbopack compatibility must be spiked/confirmed before committing to the full task breakdown — this is a real, named risk, not assumed.
- The existing 6 CSS custom properties in `app/globals.css` (`--color-bg`, `--color-bg-alt`, `--color-fg`, `--color-border`, `--color-accent`, `--color-muted`, `--radius-pill`) stay as the source of truth; shadcn's expected variable names (`--background`, `--foreground`, `--primary`, etc.) are added as a second layer mapped onto them, not a replacement.
- SVG elements (Recharts) cannot read CSS custom properties as directly as HTML/CSS can in all cases — validate `stroke="var(--color-accent)"` actually repaints on `.dark` class toggle before relying on it; have a JS-resolved fallback ready.

## Architecture

**Dependencies added:** `tailwindcss` v4 + `@tailwindcss/postcss`, `next-themes`, plus whatever `shadcn` CLI scaffolding pulls in (Radix UI primitives per-component, `class-variance-authority`, `clsx`, `tailwind-merge`).

**New files:**
- `components.json` — shadcn CLI config.
- `lib/utils.ts` — the standard shadcn `cn()` class-merging helper.
- `components/ui/button.tsx`, `components/ui/tabs.tsx` (+ any files shadcn's CLI generates alongside them, e.g. `card.tsx`, `badge.tsx`, since its scaffolding tends to add a few related primitives together).
- `components/shell/ThemeToggle.tsx` + `.test.tsx` — a small client component using `next-themes`' `useTheme()` to cycle light/dark/system, rendered in `AppShell`'s top bar.

**Modified files:**
- `app/globals.css` — add the shadcn-mapped token layer (`--background: var(--color-bg)`, `--foreground: var(--color-fg)`, `--card`/`--popover: var(--color-bg-alt)`, `--primary: var(--color-accent)`, `--border`/`--input: var(--color-border)`, `--muted-foreground: var(--color-muted)`, new `--destructive` value replacing the two inconsistent error-reds, new `--radius` distinct from the existing `--radius-pill`), plus a `.dark { ... }` block with freshly-authored dark values for every one of the above (a real design decision — pick real contrast-checked colors, not a mechanical `#fff`→`#000` inversion). Add the Tailwind v4 `@import "tailwindcss";` entry point.
- `app/layout.tsx` — wrap `<html>` in `next-themes`' `ThemeProvider` (`attribute="class"`, `defaultTheme="system"`, `enableSystem`), add `suppressHydrationWarning` on `<html>` (required by `next-themes` to avoid a hydration-mismatch warning on first paint).
- `components/shell/AppShell.tsx` + `AppShell.module.css` — tab bar (`role="tablist"` buttons) → shadcn `Tabs`/`TabsList`/`TabsTrigger`, preserving existing `activeTab` state/switching logic and every existing `aria-selected`-based test query (shadcn's `Tabs` uses Radix under the hood, which manages its own ARIA attributes — the existing tests query by role name, e.g. `getByRole('tab', { name: /aws/i })`, which should keep working, but this needs verification during implementation, not just assumed). Sign-out button → shadcn `Button variant="ghost"`. New `ThemeToggle` added next to it.
- `components/reports/CostReportTab.tsx` — lines with `stroke="#2258d3"` / `fill="#2258d3"` become either `stroke="var(--color-accent)"` (if validated to repaint correctly) or a small local `useThemeColor()` hook resolving a light/dark hex pair via `next-themes`' `resolvedTheme`.
- `package.json` / `package-lock.json`.

**No database migrations** — this stage is entirely front-end.

## Testing

- Run the full existing suite (`npm test`) after each file change — the bar to clear is zero regressions, not just "new tests pass."
- New tests: `ThemeToggle.test.tsx` (clicking cycles the theme; the resulting `.dark` class presence is asserted, e.g. via `document.documentElement.classList`).
- `AppShell.test.tsx` — re-verify its existing tab-switching and sign-out tests still pass unchanged after the `Tabs`/`Button` swap; if a query needs adjusting because Radix renders a different DOM shape than the old plain `<button role="tab">`, that's an expected, reviewable change — not a sign something's broken, but it should be called out explicitly during implementation, not silently patched.
- Manual verification (chrome-devtools, matching how every phase in this project has been verified): visit every existing tab in light mode, toggle to dark, confirm every page's colors look correct (not just the shell) since the token layer applies globally; specifically confirm the AWS/Azure report charts (Recharts Line/Bar) recolor correctly on toggle, since that's the one place a CSS-variable-in-SVG risk was flagged.

## Future work (explicitly out of scope now, per the roadmap)

- Migrating remaining components (`LoginForm`, `UploadForm`, Admin/Notes forms, plain HTML tables) to shadcn — starts in Stage B when the `Table` primitive is needed for the new line-item view, and continues opportunistically after.
- `@tanstack/react-table` — not needed yet (no sortable/paginated table exists until Stage B), but the decision of whether to adopt it is flagged in the roadmap as something to settle once, reused by Stage B — this stage doesn't need to decide it, since nothing here requires sorting/pagination.
- Per-company theme customization, white-labeling, or any branding beyond a single light/dark pair — not requested, not planned.
