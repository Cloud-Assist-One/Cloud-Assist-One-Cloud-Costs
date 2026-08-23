import { applyAccentColor } from './accentColor';

describe('applyAccentColor', () => {
  afterEach(() => {
    document.documentElement.style.removeProperty('--primary');
    document.documentElement.style.removeProperty('--accent');
  });

  it('sets --primary and --accent on the root element', () => {
    applyAccentColor('#16a34a');

    expect(document.documentElement.style.getPropertyValue('--primary')).toBe('#16a34a');
    expect(document.documentElement.style.getPropertyValue('--accent')).toBe('#16a34a');
  });

  it('removes the override when passed null', () => {
    applyAccentColor('#16a34a');
    applyAccentColor(null);

    expect(document.documentElement.style.getPropertyValue('--primary')).toBe('');
    expect(document.documentElement.style.getPropertyValue('--accent')).toBe('');
  });
});
