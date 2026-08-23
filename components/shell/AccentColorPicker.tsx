'use client';

import { useEffect, useState } from 'react';
import { ACCENT_COLORS, ACCENT_COLOR_STORAGE_KEY, applyAccentColor } from '@/lib/accentColor';
import { Button } from '@/components/ui/button';
import styles from './AccentColorPicker.module.css';

export default function AccentColorPicker() {
  const [mounted, setMounted] = useState(false);
  const [open, setOpen] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);

  useEffect(() => {
    // Reads localStorage and re-applies the saved color on every load (the
    // CSS override lives only in an inline style, so it doesn't survive a
    // fresh page load on its own). Server-rendered output can't know this
    // value, so — like ThemeToggle — nothing here renders before mount.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setMounted(true);
    const saved = window.localStorage.getItem(ACCENT_COLOR_STORAGE_KEY);
    if (saved) {
      setSelected(saved);
      applyAccentColor(saved);
    }
  }, []);

  function handleSelect(hex: string | null) {
    setSelected(hex);
    applyAccentColor(hex);
    if (hex) {
      window.localStorage.setItem(ACCENT_COLOR_STORAGE_KEY, hex);
    } else {
      window.localStorage.removeItem(ACCENT_COLOR_STORAGE_KEY);
    }
    setOpen(false);
  }

  return (
    <div className={styles.wrapper}>
      <Button type="button" variant="outline" size="sm" onClick={() => setOpen((prev) => !prev)}>
        Color
      </Button>
      {open && (
        <div className={styles.popover} role="menu">
          <button
            type="button"
            role="menuitemradio"
            aria-checked={mounted ? selected === null : undefined}
            aria-label="Default"
            className={`${styles.defaultSwatch} ${mounted && selected === null ? styles.selected : ''}`}
            onClick={() => handleSelect(null)}
          />
          {ACCENT_COLORS.map((color) => (
            <button
              key={color.value}
              type="button"
              role="menuitemradio"
              aria-checked={mounted ? selected === color.value : undefined}
              aria-label={color.name}
              className={`${styles.swatch} ${mounted && selected === color.value ? styles.selected : ''}`}
              style={{ backgroundColor: color.value }}
              onClick={() => handleSelect(color.value)}
            />
          ))}
        </div>
      )}
    </div>
  );
}
