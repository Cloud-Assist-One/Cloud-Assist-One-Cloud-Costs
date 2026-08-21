import fs from 'fs';
import path from 'path';

describe('globals.css dark mode tokens', () => {
  it('gives --color-bg/--color-bg-alt/--color-fg real dark values so non-migrated components darken correctly', () => {
    const css = fs.readFileSync(path.join(__dirname, 'globals.css'), 'utf8');
    const darkBlockMatch = css.match(/\.dark\s*\{([^}]*)\}/s);
    expect(darkBlockMatch).not.toBeNull();

    const darkBlock = darkBlockMatch![1];
    expect(darkBlock).toMatch(/--color-bg:\s*#[0-9a-fA-F]{3,6}/);
    expect(darkBlock).toMatch(/--color-bg-alt:\s*#[0-9a-fA-F]{3,6}/);
    expect(darkBlock).toMatch(/--color-fg:\s*#[0-9a-fA-F]{3,6}/);
  });
});
