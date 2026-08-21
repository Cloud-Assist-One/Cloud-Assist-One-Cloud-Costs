'use client';

import { useEffect, useState } from 'react';
import { useTheme } from 'next-themes';
import { Button } from '@/components/ui/button';

const NEXT_THEME: Record<string, string> = {
  system: 'light',
  light: 'dark',
  dark: 'system',
};

export default function ThemeToggle() {
  const { theme, setTheme } = useTheme();
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    // Intentional one-time mount flag for the SSR/hydration guard below --
    // not a case of deriving state from props/other state during render.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setMounted(true);
  }, []);

  function handleClick() {
    setTheme(NEXT_THEME[theme ?? 'system'] ?? 'system');
  }

  // Server-rendered output can't know the persisted theme (it lives in
  // localStorage), so it always renders "System" here. Rendering the real
  // theme before mount would mismatch that server output and trigger a
  // hydration error whenever the persisted theme isn't "system".
  const label = mounted ? (theme === 'dark' ? 'Dark' : theme === 'light' ? 'Light' : 'System') : 'System';

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
