import { resolveSubmitterIdentity } from './supportIdentity';

describe('resolveSubmitterIdentity', () => {
  it('uses the profile first name and the signed-in email', () => {
    expect(resolveSubmitterIdentity('Jane', 'jane.doe@example.com')).toEqual({
      firstName: 'Jane',
      email: 'jane.doe@example.com',
    });
  });

  // A profile with no first name still has to produce a usable ticket: the
  // column is NOT NULL, and "—" in the staff queue helps nobody. The email's
  // local part is the closest thing to a name we actually hold.
  it('falls back to the email local part when the profile has no first name', () => {
    expect(resolveSubmitterIdentity(null, 'jane.doe@example.com').firstName).toBe('jane.doe');
  });

  it('treats a blank first name the same as a missing one', () => {
    expect(resolveSubmitterIdentity('   ', 'jane.doe@example.com').firstName).toBe('jane.doe');
  });

  it('trims a first name that has stray whitespace', () => {
    expect(resolveSubmitterIdentity('  Jane  ', 'jane@example.com').firstName).toBe('Jane');
  });

  it('falls back to a placeholder when there is no email to derive from either', () => {
    expect(resolveSubmitterIdentity(null, null)).toEqual({
      firstName: 'Portal user',
      email: null,
    });
  });

  it('reports no email rather than inventing one, so the caller can refuse', () => {
    expect(resolveSubmitterIdentity('Jane', null).email).toBeNull();
  });
});
