import { tagValue } from './awsTags';

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
});
