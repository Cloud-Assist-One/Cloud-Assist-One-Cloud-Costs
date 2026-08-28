import { hasDetailPullSource, sourcesForProvider } from './billingSourceAvailability';

const awsEnabled = { cloud_provider: 'aws', enabled: true };
const awsDisabled = { cloud_provider: 'aws', enabled: false };
const azureEnabled = { cloud_provider: 'azure', enabled: true };

describe('sourcesForProvider', () => {
  it('keeps only this provider’s sources', () => {
    expect(sourcesForProvider([awsEnabled, azureEnabled], 'aws')).toEqual([awsEnabled]);
  });

  it('drops disabled sources, which the pull route refuses anyway', () => {
    expect(sourcesForProvider([awsDisabled], 'aws')).toEqual([]);
  });

  // Rows written before `enabled` had a value, and any source the API returns
  // without the field. Absent is not the same as switched off.
  it('treats a missing enabled flag as enabled', () => {
    expect(sourcesForProvider([{ cloud_provider: 'aws' }], 'aws')).toHaveLength(1);
  });
});

describe('hasDetailPullSource', () => {
  it('is true when this provider has an enabled bucket', () => {
    expect(hasDetailPullSource([awsEnabled], 'aws')).toBe(true);
  });

  // The decisive case: an S3 bucket must not make the Azure tab hide its
  // Quick Pull and offer a Detail Pull with no Azure container behind it.
  it('is false for a provider whose only bucket belongs to the other cloud', () => {
    expect(hasDetailPullSource([awsEnabled], 'azure')).toBe(false);
  });

  it('is false when this provider’s only bucket is disabled', () => {
    expect(hasDetailPullSource([awsDisabled], 'aws')).toBe(false);
  });

  it('is false when nothing is configured at all', () => {
    expect(hasDetailPullSource([], 'aws')).toBe(false);
  });

  it('is true when one of several sources matches', () => {
    expect(hasDetailPullSource([azureEnabled, awsDisabled, awsEnabled], 'aws')).toBe(true);
  });
});
