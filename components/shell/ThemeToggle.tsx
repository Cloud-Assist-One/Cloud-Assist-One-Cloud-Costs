'use client';

import { useEffect, useState } from 'react';
import { useTheme } from 'next-themes';
import { Button } from '@/components/ui/button';

/**
 * Light and dark, and nothing else.
 *
 * The button used to cycle system -> light -> dark. "System" worked, but on a
 * machine set to light it rendered identically to "Light", so one press in
 * three appeared to do nothing at all.
 *
 * The app still opens on the operating system's preference -- that is the
 * provider's defaultTheme, not this button's business -- but the first press
 * commits to a real theme rather than offering a third stop that looks like
 * one of the other two.
 */
export default function ThemeToggle() {
  const { resolvedTheme, setTheme } = useTheme();
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    // Intentional one-time mount flag for the SSR/hydration guard below --
    // not a case of deriving state from props/other state during render.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setMounted(true);
  }, []);

  // resolvedTheme, not theme: while the app is still following the system,
  // theme reads "system" while the page is plainly one or the other. Toggling
  // against what is actually on screen is what makes one press flip it.
  const isDark = resolvedTheme === 'dark';

  function handleClick() {
    setTheme(isDark ? 'light' : 'dark');
  }

  // Server-rendered output can't know the persisted theme (it lives in
  // localStorage), so it always renders "Light" here. Rendering the real
  // theme before mount would mismatch that server output and trigger a
  // hydration error whenever the persisted theme is dark.
  const label = mounted && isDark ? 'Dark' : 'Light';

  return (
    <Button
      type="button"
      variant="ghost"
      size="sm"
      aria-label={`Toggle theme (currently ${label})`}
      onClick={handleClick}
    >
      {label}
    </Button>
  );
}
