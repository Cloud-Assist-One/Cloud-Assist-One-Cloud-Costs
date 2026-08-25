import { tagValue, readTagKey, lookupTag, tagFailureWarning } from './resourceTags';

describe('tagValue', () => {
  // AWS is not self-consistent about tag shapes, so each of these three
  // cases is a real response format we read somewhere in the AWS routes.

  it('reads the PascalCase Key/Value array used by EC2, RDS, DynamoDB, S3 and IAM', () => {
    const tags = [
      { Key: 'Name', Value: 'web-01' },
      { Key: 'CostCenter', Value: 'CC-1234' },
    ];
    expect(tagValue(tags, 'CostCenter')).toBe('CC-1234');
  });

  it('reads the lowercase key/value array used by ECS', () => {
    const tags = [{ key: 'CostCenter', value: 'CC-9999' }];
    expect(tagValue(tags, 'CostCenter')).toBe('CC-9999');
  });

  it('reads the plain record used by Lambda and API Gateway', () => {
    const tags = { CostCenter: 'CC-5555', Owner: 'platform' };
    expect(tagValue(tags, 'CostCenter')).toBe('CC-5555');
  });

  it('matches the tag key case-insensitively', () => {
    // Clients are inconsistent about costcenter/CostCenter/COSTCENTER, and
    // making them match the casing exactly would look like missing data.
    expect(tagValue([{ Key: 'costcenter', Value: 'CC-1' }], 'CostCenter')).toBe('CC-1');
    expect(tagValue({ COSTCENTER: 'CC-2' }, 'costCenter')).toBe('CC-2');
  });

  it('returns null when the tag is absent', () => {
    expect(tagValue([{ Key: 'Name', Value: 'web-01' }], 'CostCenter')).toBeNull();
    expect(tagValue({ Owner: 'platform' }, 'CostCenter')).toBeNull();
  });

  it('returns null when the resource has no tags at all', () => {
    expect(tagValue(undefined, 'CostCenter')).toBeNull();
    expect(tagValue(null, 'CostCenter')).toBeNull();
    expect(tagValue([], 'CostCenter')).toBeNull();
    expect(tagValue({}, 'CostCenter')).toBeNull();
  });

  it('returns null when no tag key is configured', () => {
    // A blank tagKey means the feature is switched off for this connection;
    // it must never accidentally match a tag whose key is the empty string.
    expect(tagValue([{ Key: 'CostCenter', Value: 'CC-1' }], '')).toBeNull();
    expect(tagValue([{ Key: '', Value: 'oops' }], '')).toBeNull();
  });

  it('preserves a tag explicitly set to an empty string', () => {
    // Present-but-empty is different from absent, and squashing it to null
    // would hide a real tagging mistake from the client.
    expect(tagValue([{ Key: 'CostCenter', Value: '' }], 'CostCenter')).toBe('');
  });

  it('ignores malformed entries instead of throwing', () => {
    const tags = [{ Value: 'no-key' }, { Key: 'CostCenter', Value: 'CC-7' }];
    expect(tagValue(tags, 'CostCenter')).toBe('CC-7');
  });

  it('prefers an exact-case match over a case-insensitive one', () => {
    // AWS tag keys are case-sensitive, so both can legitimately exist on the
    // same resource; the exact match must win rather than whichever is listed
    // first.
    const tags = [
      { Key: 'CostCenter', Value: 'CC-a' },
      { Key: 'costcenter', Value: 'CC-b' },
    ];
    expect(tagValue(tags, 'CostCenter')).toBe('CC-a');
  });

  it('keeps scanning past a key match whose value is not a string', () => {
    const tags = [
      { Key: 'CC', Value: null },
      { Key: 'cc', Value: 'real' },
    ];
    expect(tagValue(tags, 'CC')).toBe('real');
  });
});

describe('readTagKey', () => {
  it('accepts a normal tag key and trims it', () => {
    expect(readTagKey('  CostCenter  ')).toEqual({ ok: true, tagKey: 'CostCenter' });
  });

  it('accepts a Unicode tag key', () => {
    expect(readTagKey('Kostenstelle-Größe')).toEqual({ ok: true, tagKey: 'Kostenstelle-Größe' });
    expect(readTagKey('部門')).toEqual({ ok: true, tagKey: '部門' });
  });

  it('treats a blank or undefined value as "no tag column"', () => {
    expect(readTagKey(undefined)).toEqual({ ok: true, tagKey: '' });
    expect(readTagKey(null)).toEqual({ ok: true, tagKey: '' });
    expect(readTagKey('')).toEqual({ ok: true, tagKey: '' });
    expect(readTagKey('   ')).toEqual({ ok: true, tagKey: '' });
  });

  it('rejects a tag key over 128 characters', () => {
    expect(readTagKey('a'.repeat(129))).toEqual({ ok: false });
    expect(readTagKey('a'.repeat(128))).toEqual({ ok: true, tagKey: 'a'.repeat(128) });
  });

  it('rejects a non-string value', () => {
    expect(readTagKey(42)).toEqual({ ok: false });
  });
});

describe('lookupTag', () => {
  it('short-circuits to ok/null without calling fetchTagValue when no tag key is configured', async () => {
    const fetchTagValue = jest.fn();
    const result = await lookupTag('', fetchTagValue);
    expect(result).toEqual({ ok: true, value: null });
    expect(fetchTagValue).not.toHaveBeenCalled();
  });

  it('returns ok:true with the fetched value on success', async () => {
    const result = await lookupTag('CostCenter', async () => 'CC-1');
    expect(result).toEqual({ ok: true, value: 'CC-1' });
  });

  it('returns ok:false, distinct from "no tag", when the fetch throws', async () => {
    const result = await lookupTag('CostCenter', async () => {
      throw new Error('ThrottlingException');
    });
    expect(result).toEqual({ ok: false });
  });
});

describe('tagFailureWarning', () => {
  it('returns null when there are no failures', () => {
    expect(tagFailureWarning(0, 120)).toBeNull();
  });

  it('names the failure count when there are failures', () => {
    expect(tagFailureWarning(3, 120)).toBe(
      '3 of 120 tag lookups failed (throttling or a missing permission); some tag values may be blank.'
    );
  });
});
