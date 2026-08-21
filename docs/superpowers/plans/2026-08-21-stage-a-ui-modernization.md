# Stage A — UI Modernization + Dark Mode Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add Tailwind CSS v4 + shadcn/ui as the project's UI foundation, wire up dark mode (system-preference default with a manual toggle), and migrate the app shell (tab bar, sign-out button) as the first concrete example of the migration pattern — without touching any other component's styling yet.

**Architecture:** Tailwind v4 is installed alongside the existing CSS Modules (not replacing them yet). shadcn/ui's CLI scaffolds Radix-based primitives into `components/ui/`. The existing 6 CSS custom properties in `app/globals.css` stay the source of truth; shadcn's generated token layer gets remapped onto them, plus real (not placeholder) dark-mode values. `next-themes` handles the light/dark/system toggle via a `.dark` class on `<html>`.

**Tech Stack:** Tailwind CSS v4, shadcn/ui (Radix UI + class-variance-authority + clsx + tailwind-merge), next-themes, existing Next.js 16.3.1 / React 19.2.8 / TypeScript / Jest + Testing Library.

**Spec:** `docs/superpowers/specs/2026-08-21-stage-a-ui-modernization-design.md`

## Global Constraints

- Follow existing project conventions: `@/*` path alias, tests co-located as `Component.test.tsx`, functional components with hooks, 2-space indentation.
- **Scope is strictly limited to:** `app/globals.css`, `app/layout.tsx`, `components/shell/AppShell.tsx` (+ its CSS + test), a new `components/shell/ThemeToggle.tsx`, the shadcn scaffolding itself (`components.json`, `lib/utils.ts`, `components/ui/*`), and the two hardcoded color lines in `components/reports/CostReportTab.tsx`. Every other existing component (`LoginForm`, `UploadForm`, `AdminCompanies`/`AdminUsers`, `NotesFeed`, `CompareTab`, `UploadedFilesList`, `DateRangePicker`, and the rest of `CostReportTab`'s JSX) is explicitly out of scope for this stage — do not modify them.
- Zero regressions in the existing test suite (`npm test`) — every existing test must still pass after each task. If a query needs adjusting because Radix renders a different DOM shape than the old plain buttons, that's a reviewable, explicitly-called-out change — never a silent workaround for an actual behavior change.
- The existing 6 CSS custom properties (`--color-bg`, `--color-bg-alt`, `--color-fg`, `--color-border`, `--color-accent`, `--color-muted`, `--radius-pill`) stay in `app/globals.css` exactly as they are — components not yet migrated keep reading them directly.
- No database migrations in this stage.

---

## Task 1: Install and verify Tailwind CSS v4

**Files:**
- Create: `postcss.config.mjs`
- Modify: `app/globals.css` (import line only — no token changes yet), `package.json`, `package-lock.json`

**Interfaces:** none (build tooling only).

- [ ] **Step 1: Install Tailwind v4**

Run: `npm install tailwindcss @tailwindcss/postcss`

- [ ] **Step 2: Write `postcss.config.mjs`**

```js
const config = {
  plugins: {
    '@tailwindcss/postcss': {},
  },
};

export default config;
```

- [ ] **Step 3: Add the Tailwind import to `app/globals.css`**

Read the current file first. At the very top, before the existing `:root` block, add:

```css
@import "tailwindcss";
```

Do not remove or alter anything else in the file yet — the token layer is Task 3's job.

- [ ] **Step 4: Verify the build**

Run: `npm run build` — expect a successful production build. This is the plan's highest-uncertainty step (Tailwind v4 + Next 16.3.1 + Turbopack compatibility) — done first and for real, not as a throwaway spike, so any incompatibility surfaces before more work is built on top of it.
Run: `npm test` — expect all existing tests still passing.

- [ ] **Step 5: Commit**

```bash
git add postcss.config.mjs app/globals.css package.json package-lock.json
git commit -m "Add Tailwind CSS v4"
```

---

## Task 2: Scaffold shadcn/ui (button, tabs, card, badge)

**Files:**
- Create: `components.json`, `lib/utils.ts`, and whatever `components/ui/*.tsx` files the CLI generates for button/tabs/card/badge
- Modify: `app/globals.css` (the CLI adds its own token/base-style layer — do not hand-edit this yet, that's Task 3), `package.json`, `package-lock.json`

**Interfaces:**
- Produces: `Button`, `Tabs`/`TabsList`/`TabsTrigger`/`TabsContent`, `Card`, `Badge` primitives under `components/ui/` — consumed by Task 4 (`ThemeToggle` uses `Button`) and Task 5 (`AppShell` uses `Tabs`/`Button`).

- [ ] **Step 1: Run the shadcn CLI init**

Run: `npx shadcn@latest init -y -d --base-color neutral`

This should run non-interactively using defaults. If it still prompts: TypeScript = yes, style = New York, base color = Neutral, CSS variables = yes, React Server Components = yes.

This will modify `app/globals.css` extensively (its own `:root`/`.dark` token blocks plus a `@theme inline` mapping) and create `components.json` + `lib/utils.ts`. **Do not hand-edit the resulting `globals.css` yet** — Task 3 remaps it to this project's brand colors.

- [ ] **Step 2: Add the button, tabs, card, badge components**

Run: `npx shadcn@latest add button tabs card badge -y`

- [ ] **Step 3: Verify**

Run: `npm run build` — expect success.
Run: `npm test` — expect all existing tests still passing.
Run: `npx tsc --noEmit` — expect no errors.

- [ ] **Step 4: Report exactly what was generated**

Run `git status --short` and include the full file list in your task report — the controller needs this to review the diff, since exact CLI output can vary slightly by shadcn version.

- [ ] **Step 5: Commit**

```bash
git add components.json lib/utils.ts components/ui app/globals.css package.json package-lock.json
git commit -m "Scaffold shadcn/ui: button, tabs, card, badge"
```

---

## Task 3: Remap tokens to brand colors + wire dark mode

**Files:**
- Modify: `app/globals.css` (remap shadcn's generated token values to this project's brand colors + add real dark-mode values), `app/layout.tsx` (wrap in `ThemeProvider`)

**Interfaces:**
- Consumes: whatever token structure Task 2's `shadcn init` produced — read the current `app/globals.css` in full first; the exact variable names it generated determine what to remap, the values below are what to remap them TO.
- Produces: a `globals.css` where shadcn's semantic tokens resolve to this project's brand palette in light mode and real (not placeholder) dark-mode values under `.dark`; app-wide theme switching via `next-themes`.

- [ ] **Step 1: Install `next-themes`**

Run: `npm install next-themes`

- [ ] **Step 2: Read the current `app/globals.css` in full**

Confirm exactly what Task 2's `shadcn init` produced — note the light-mode `:root` block's variable names and the `.dark` block's variable names (shadcn typically pre-fills both with its own default palette, not this project's brand colors).

- [ ] **Step 3: Remap the light-mode (`:root`) values**

Edit the *values* shadcn generated (not the variable names/structure) so they resolve to this project's existing brand palette:

| shadcn token | value | source |
|---|---|---|
| `--background` | `#ffffff` | existing `--color-bg` |
| `--foreground` | `#0f2540` | existing `--color-fg` |
| `--card`, `--popover` | `#f3f6fa` | existing `--color-bg-alt` |
| `--primary` | `#2258d3` | existing `--color-accent` |
| `--primary-foreground` | `#ffffff` | |
| `--border`, `--input` | `#dce3ec` | existing `--color-border` |
| `--muted-foreground` | `#64748b` | existing `--color-muted` |
| `--destructive` | `#d1274b` | canonical error red — this project currently has two inconsistent error-red literals (`#d1274b` in 5 CSS-Module files, `#b3261e` in 2); pick `#d1274b` as the single canonical value going forward |
| `--destructive-foreground` | `#ffffff` | |
| `--radius` | `0.5rem` | new token, distinct from the existing pill-specific `--radius-pill: 999px`, which stays untouched |

Keep the original 6 project variables (`--color-bg`, `--color-bg-alt`, `--color-fg`, `--color-border`, `--color-accent`, `--color-muted`, `--radius-pill`) exactly as they are, unchanged, in the same file — the shadcn tokens above are an *additional* layer mapped to the same real colors, not a replacement. Components not yet migrated keep reading the original 6 directly.

- [ ] **Step 4: Author real dark-mode values under `.dark`**

This is a genuine design decision, not a mechanical light-value inversion. Use this palette (a contrast-checked dark slate-blue scheme consistent with the light-mode accent):

| shadcn token | dark value |
|---|---|
| `--background` | `#0b1220` |
| `--foreground` | `#e6edf7` |
| `--card`, `--popover` | `#121b2e` |
| `--primary` | `#5b8def` (lightened from `#2258d3` for adequate contrast against a dark background) |
| `--primary-foreground` | `#0b1220` |
| `--border`, `--input` | `#243248` |
| `--muted-foreground` | `#94a3b8` |
| `--destructive` | `#f2596b` (lightened from `#d1274b`) |
| `--destructive-foreground` | `#0b1220` |

- [ ] **Step 5: Wire `next-themes` into the root layout**

Read the current `app/layout.tsx` in full first. Modify it to:

```tsx
import type { Metadata } from 'next';
import { ThemeProvider } from 'next-themes';
import './globals.css';

export const metadata: Metadata = {
  title: 'Cloud Assist One — Cost Review Portal',
  description: 'AWS and Azure billing review for Cloud Assist One clients.',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <body>
        <ThemeProvider attribute="class" defaultTheme="system" enableSystem>
          {children}
        </ThemeProvider>
      </body>
    </html>
  );
}
```

Keep the existing `metadata` export exactly as it is — only add the `ThemeProvider` wrapper and `suppressHydrationWarning` (a required `next-themes` convention to avoid a hydration-mismatch warning on first paint, since the theme class can only be determined client-side).

- [ ] **Step 6: Verify**

Run: `npm run build` — expect success.
Run: `npm test` — expect all existing tests still passing.
Run: `npx tsc --noEmit` — expect no errors.

- [ ] **Step 7: Commit**

```bash
git add app/globals.css app/layout.tsx package.json package-lock.json
git commit -m "Remap shadcn tokens to brand colors, wire up dark mode via next-themes"
```

---

## Task 4: ThemeToggle component

**Files:**
- Create: `components/shell/ThemeToggle.tsx`, `components/shell/ThemeToggle.test.tsx`

**Interfaces:**
- Consumes: `useTheme` from `next-themes`, `Button` from `@/components/ui/button` (Task 2).
- Produces: `ThemeToggle` (default export, no props) — consumed by `AppShell` in Task 5.

- [ ] **Step 1: Write the failing test**

```tsx
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import ThemeToggle from './ThemeToggle';

const setTheme = jest.fn();
let mockTheme = 'system';

jest.mock('next-themes', () => ({
  useTheme: () => ({ theme: mockTheme, setTheme: (...args: unknown[]) => setTheme(...args) }),
}));

describe('ThemeToggle', () => {
  beforeEach(() => {
    setTheme.mockReset();
    mockTheme = 'system';
  });

  it('cycles from system to light when clicked', async () => {
    const user = userEvent.setup();
    render(<ThemeToggle />);

    await user.click(screen.getByRole('button', { name: /theme/i }));

    expect(setTheme).toHaveBeenCalledWith('light');
  });

  it('cycles from light to dark when clicked', async () => {
    mockTheme = 'light';
    const user = userEvent.setup();
    render(<ThemeToggle />);

    await user.click(screen.getByRole('button', { name: /theme/i }));

    expect(setTheme).toHaveBeenCalledWith('dark');
  });

  it('cycles from dark back to system when clicked', async () => {
    mockTheme = 'dark';
    const user = userEvent.setup();
    render(<ThemeToggle />);

    await user.click(screen.getByRole('button', { name: /theme/i }));

    expect(setTheme).toHaveBeenCalledWith('system');
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx jest components/shell/ThemeToggle.test.tsx`
Expected: FAIL — `Cannot find module './ThemeToggle'`.

- [ ] **Step 3: Write the component**

```tsx
'use client';

import { useTheme } from 'next-themes';
import { Button } from '@/components/ui/button';

const NEXT_THEME: Record<string, string> = {
  system: 'light',
  light: 'dark',
  dark: 'system',
};

export default function ThemeToggle() {
  const { theme, setTheme } = useTheme();

  function handleClick() {
    setTheme(NEXT_THEME[theme ?? 'system'] ?? 'system');
  }

  return (
    <Button type="button" variant="ghost" size="sm" aria-label="Toggle theme" onClick={handleClick}>
      {theme === 'dark' ? 'Dark' : theme === 'light' ? 'Light' : 'System'}
    </Button>
  );
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx jest components/shell/ThemeToggle.test.tsx`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add components/shell/ThemeToggle.tsx components/shell/ThemeToggle.test.tsx
git commit -m "Add ThemeToggle component"
```

---

## Task 5: Migrate AppShell's tab bar and sign-out button to shadcn primitives

**Files:**
- Modify: `components/shell/AppShell.tsx`, `components/shell/AppShell.test.tsx`, `components/shell/AppShell.module.css`

**Interfaces:**
- Consumes: `Tabs`/`TabsList`/`TabsTrigger` from `@/components/ui/tabs`, `Button` from `@/components/ui/button` (Task 2), `ThemeToggle` from `./ThemeToggle` (Task 4).
- Produces: no new exports — `AppShell`'s props are unchanged.

- [ ] **Step 1: Read the current `AppShell.tsx` and its test in full**

This file has been modified in every prior phase (1/2/3) — confirm its exact current tab list (`aws|azure|compare|files|notes|admin`) and structure before editing.

- [ ] **Step 2: Add the `ThemeToggle`**

Import it and render it in the top bar, next to the existing sign-out button. Run the full existing `AppShell` test suite and confirm it still passes before moving on — this is a small, additive, low-risk change to verify in isolation first.

- [ ] **Step 3: Migrate the tab bar**

Replace the current `<div className={styles.tabList} role="tablist">...</div>` block (individual `<button role="tab" aria-selected={...} onClick={...}>` elements) with shadcn's `Tabs`, driven by the existing `activeTab` state as a controlled component:

```tsx
<Tabs value={activeTab} onValueChange={(value) => setActiveTab(value as TabKey)}>
  <TabsList>
    <TabsTrigger value="aws">AWS</TabsTrigger>
    <TabsTrigger value="azure">Azure</TabsTrigger>
    <TabsTrigger value="compare">Compare</TabsTrigger>
    <TabsTrigger value="files">Uploaded Files</TabsTrigger>
    <TabsTrigger value="notes">Notes & Follow-ups</TabsTrigger>
    {role === 'staff' && <TabsTrigger value="admin">Admin</TabsTrigger>}
  </TabsList>
</Tabs>
```

Keep the panel-switch block below this (the `{activeTab === 'aws' && <CostReportTab .../>}` conditions, etc.) exactly as it is — only the tab-button markup changes, not the panel logic.

Radix's `Tabs` renders `role="tablist"`/`role="tab"` with its own `aria-selected` management, matching the ARIA pattern the existing tests already query against (e.g. `getByRole('tab', { name: /aws/i })`, `getByRole('tab', { name: /admin/i })`) — this should mean the existing tests keep passing unchanged, but **verify this, don't assume it**. If a specific test needs adjusting because Radix's DOM shape differs from the old plain buttons in some way, fix the test and explicitly call out the change in your report — never a silent workaround for an actual behavioral regression.

- [ ] **Step 4: Migrate the sign-out button**

Replace `<button type="button" className={styles.signOut} onClick={handleSignOut}>Sign out</button>` with:

```tsx
<Button type="button" variant="outline" size="sm" onClick={handleSignOut}>
  Sign out
</Button>
```

- [ ] **Step 5: Clean up `AppShell.module.css`**

Remove the now-unused `.tabList` and `.signOut` rules. Do **not** remove `.wrapper`, `.topBar`, `.companySwitcher`, `.panel`, `.adminSections` — those are still used.

- [ ] **Step 6: Run the full existing `AppShell` test suite**

Run: `npx jest components/shell/AppShell.test.tsx`
Expected: PASS — all pre-existing tests (from Phases 1/2/3), with any query adjustments per Step 3's note explicitly documented in your report.

- [ ] **Step 7: Verify the full pipeline**

Run: `npx tsc --noEmit` — expect no errors.
Run: `npm test` (full suite) — expect all tests passing.
Run: `npm run lint` — expect no errors.
Run: `npm run build` — expect a successful production build.

- [ ] **Step 8: Commit**

```bash
git add components/shell/AppShell.tsx components/shell/AppShell.test.tsx components/shell/AppShell.module.css
git commit -m "Migrate AppShell's tab bar and sign-out button to shadcn primitives"
```

---

## Task 6: Fix hardcoded chart colors for dark-mode compatibility

**Files:**
- Modify: `components/reports/CostReportTab.tsx`

**Interfaces:** none new (unless the fallback hook in Step 2 is needed, in which case it's a local, non-exported helper).

- [ ] **Step 1: Read the current file, locate the two hardcoded color lines**

`stroke="#2258d3"` on the `<Line>` element, `fill="#2258d3"` on the `<Bar>` element.

- [ ] **Step 2: Try the CSS-variable approach first**

Change both to reference `var(--primary)` (the shadcn token Task 3 already gave real light/dark values — prefer this over `var(--color-accent)`, which was never given a dark-mode variant, to avoid maintaining the accent color in two places):

```tsx
<Line type="monotone" dataKey="total" stroke="var(--primary)" />
```
```tsx
<Bar dataKey="total" fill="var(--primary)" />
```

- [ ] **Step 3: Manually verify in a browser**

This is a visual/rendering concern jsdom can't meaningfully verify. Run `npm run dev`, view the AWS report tab with some data, toggle dark mode via the new `ThemeToggle`, and confirm the line/bar chart colors visibly change between light and dark.

If they do **not** change (Recharts may compute/cache the color at a point that doesn't react to a later CSS-variable repaint), fall back to a small local hook instead:

```tsx
'use client';

import { useEffect, useState } from 'react';
import { useTheme } from 'next-themes';

const ACCENT_COLORS = { light: '#2258d3', dark: '#5b8def' };

function useAccentColor(): string {
  const { resolvedTheme } = useTheme();
  const [color, setColor] = useState(ACCENT_COLORS.light);

  useEffect(() => {
    setColor(resolvedTheme === 'dark' ? ACCENT_COLORS.dark : ACCENT_COLORS.light);
  }, [resolvedTheme]);

  return color;
}
```

Place this directly in `components/reports/CostReportTab.tsx` as a local, non-exported hook if needed — don't create a new shared file for a single-use fallback unless a second chart needs the same thing later (Stage B may add one; cross that bridge then).

**Report which approach was actually needed** — this determines whether Stage B's future charts should follow the CSS-variable pattern or the hook pattern.

- [ ] **Step 4: Run the existing test suite**

Run: `npx jest components/reports/CostReportTab.test.tsx`
Expected: PASS — this test mocks Recharts entirely via a Proxy (existing pattern), so it won't catch a color-application bug either way; Step 3's manual browser check is the real verification here.

- [ ] **Step 5: Verify the full pipeline**

Run: `npx tsc --noEmit`, `npm test`, `npm run lint`, `npm run build` — all pass.

- [ ] **Step 6: Commit**

```bash
git add components/reports/CostReportTab.tsx
git commit -m "Make AWS/Azure chart colors theme-aware for dark mode"
```

---

## Task 7: Manual verification and deployment

**Files:** none (verification and deployment only).

- [ ] **Step 1: Manual end-to-end pass**

Run `npm run dev`, sign in as staff:

1. Confirm the tab bar (now shadcn `Tabs`) still switches between AWS/Azure/Compare/Uploaded Files/Notes & Follow-ups/Admin correctly — identical behavior to before.
2. Click the new `ThemeToggle` — confirm it cycles System → Light → Dark → System, and confirm every existing tab's colors update correctly in dark mode, not just the shell (the token layer applies globally, so this should already work everywhere without those components being individually migrated).
3. Specifically check the AWS/Azure report tab's Line and Bar charts recolor correctly when toggling dark mode.
4. Confirm the company switcher and sign-out button still work correctly in both themes.
5. If possible, check with system dark mode enabled (OS/browser setting) and reload — confirm the app defaults to dark mode with no toggle interaction (verifies `defaultTheme="system"` actually works, not just the manual toggle).

If anything fails, fix it and re-run the affected steps before deploying.

- [ ] **Step 2: Deploy**

Push to `main`, confirm the Vercel production build succeeds, and re-run the Step 1 pass against the production URL.

- [ ] **Step 3: Report**

Summarize which chart-color approach was used (Task 6), confirm dark mode works app-wide, and note that Stage B (enhanced charts + line-item view) is next per the roadmap.
