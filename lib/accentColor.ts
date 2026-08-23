export interface AccentColorOption {
  name: string;
  value: string;
}

export const ACCENT_COLORS: AccentColorOption[] = [
  { name: 'Blue', value: '#2258d3' },
  { name: 'Indigo', value: '#6366f1' },
  { name: 'Violet', value: '#8b5cf6' },
  { name: 'Rose', value: '#e11d48' },
  { name: 'Red', value: '#dc2626' },
  { name: 'Orange', value: '#ea580c' },
  { name: 'Amber', value: '#d97706' },
  { name: 'Green', value: '#16a34a' },
  { name: 'Teal', value: '#0d9488' },
  { name: 'Cyan', value: '#0891b2' },
];

export const ACCENT_COLOR_STORAGE_KEY = 'cloud-cost-assistant-accent-color';

// Inline styles on <html> beat both the light (:root) and dark (.dark) CSS
// rules for --primary/--accent regardless of which is active, so one hex
// per swatch is enough — no separate light/dark variant needed.
export function applyAccentColor(hex: string | null) {
  const root = document.documentElement;
  if (hex) {
    root.style.setProperty('--primary', hex);
    root.style.setProperty('--accent', hex);
  } else {
    root.style.removeProperty('--primary');
    root.style.removeProperty('--accent');
  }
}
