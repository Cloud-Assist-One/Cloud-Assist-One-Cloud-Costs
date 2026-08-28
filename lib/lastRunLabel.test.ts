import { lastRunLabel } from './lastRunLabel';

describe('lastRunLabel', () => {
  it('names a detail pull and states when it ran', () => {
    expect(lastRunLabel({ origin: 'detail_pull', createdAt: '2026-08-28T15:42:00.000Z' })).toBe(
      'Detail pull · Aug 28, 2026, 3:42 PM UTC'
    );
  });

  it('names a quick pull', () => {
    expect(lastRunLabel({ origin: 'quick_pull', createdAt: '2026-08-28T15:42:00.000Z' })).toContain('Quick pull');
  });

  it('names a hand-uploaded file, so the line never implies a pull that did not happen', () => {
    expect(lastRunLabel({ origin: 'upload', createdAt: '2026-08-28T15:42:00.000Z' })).toContain('Uploaded');
  });

  it('returns null when there is no run to describe', () => {
    expect(lastRunLabel(null)).toBeNull();
  });

  // Rows written before uploaded_files.origin existed, and any value a future
  // writer adds without updating this map. Stating the time with no origin
  // beats inventing one.
  it('states the time alone rather than guessing at an unknown origin', () => {
    const label = lastRunLabel({ origin: null, createdAt: '2026-08-28T15:42:00.000Z' });

    expect(label).toBe('Aug 28, 2026, 3:42 PM UTC');
    expect(label).not.toMatch(/pull|upload/i);
  });

  it('falls back to the time alone for an origin it does not recognise', () => {
    expect(lastRunLabel({ origin: 'scheduled_sync', createdAt: '2026-08-28T15:42:00.000Z' })).toBe(
      'Aug 28, 2026, 3:42 PM UTC'
    );
  });

  it('returns null rather than "Invalid Date" when the timestamp is unusable', () => {
    expect(lastRunLabel({ origin: 'quick_pull', createdAt: 'not-a-date' })).toBeNull();
  });
});
