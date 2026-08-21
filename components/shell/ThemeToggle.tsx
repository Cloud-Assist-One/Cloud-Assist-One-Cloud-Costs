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
