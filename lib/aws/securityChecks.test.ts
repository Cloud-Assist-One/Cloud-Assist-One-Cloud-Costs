import {
  openSecurityGroups,
  publicS3Buckets,
  rootAccessKeys,
  publicRdsInstances,
  iamUsersWithoutMfa,
  staleAccessKeys,
  inactiveIamUsers,
  unencryptedVolumes,
  unencryptedRdsStorage,
  expiringCertificates,
} from './securityChecks';

describe('openSecurityGroups', () => {
  it('flags a group exposing SSH to the whole internet', () => {
    const result = openSecurityGroups([
      {
        groupId: 'sg-1',
        groupName: 'web',
        arn: 'arn:sg-1',
        region: 'us-east-1',
        inboundRules: [{ protocol: 'tcp', fromPort: 22, toPort: 22, cidrs: ['0.0.0.0/0'] }],
      },
    ]);

    expect(result.findings).toHaveLength(1);
    expect(result.findings[0].severity).toBe('critical');
    expect(result.findings[0].detail).toContain('22');
  });

  it('flags an IPv6 open rule too', () => {
    const result = openSecurityGroups([
      {
        groupId: 'sg-2',
        groupName: 'web6',
        arn: 'arn:sg-2',
        region: 'us-east-1',
        inboundRules: [{ protocol: 'tcp', fromPort: 3389, toPort: 3389, cidrs: ['::/0'] }],
      },
    ]);

    expect(result.findings).toHaveLength(1);
  });

  it('flags an all-protocols rule open to the internet', () => {
    const result = openSecurityGroups([
      {
        groupId: 'sg-3',
        groupName: 'everything',
        arn: 'arn:sg-3',
        region: 'us-east-1',
        inboundRules: [{ protocol: '-1', fromPort: null, toPort: null, cidrs: ['0.0.0.0/0'] }],
      },
    ]);

    expect(result.findings).toHaveLength(1);
    expect(result.findings[0].detail).toContain('all ports');
  });

  it('flags a wide port range that happens to contain a sensitive port', () => {
    const result = openSecurityGroups([
      {
        groupId: 'sg-4',
        groupName: 'range',
        arn: 'arn:sg-4',
        region: 'us-east-1',
        inboundRules: [{ protocol: 'tcp', fromPort: 3000, toPort: 6000, cidrs: ['0.0.0.0/0'] }],
      },
    ]);

    expect(result.findings).toHaveLength(1);
    expect(result.findings[0].detail).toContain('3306');
    expect(result.findings[0].detail).toContain('5432');
  });

  it('ignores a sensitive port open only to a private CIDR', () => {
    const result = openSecurityGroups([
      {
        groupId: 'sg-5',
        groupName: 'internal',
        arn: 'arn:sg-5',
        region: 'us-east-1',
        inboundRules: [{ protocol: 'tcp', fromPort: 22, toPort: 22, cidrs: ['10.0.0.0/8'] }],
      },
    ]);

    expect(result.findings).toEqual([]);
  });

  it('ignores a non-sensitive port open to the internet, since that is what web servers do', () => {
    const result = openSecurityGroups([
      {
        groupId: 'sg-6',
        groupName: 'https',
        arn: 'arn:sg-6',
        region: 'us-east-1',
        inboundRules: [{ protocol: 'tcp', fromPort: 443, toPort: 443, cidrs: ['0.0.0.0/0'] }],
      },
    ]);

    expect(result.findings).toEqual([]);
  });

  it('reports one finding per group even when several rules are open', () => {
    const result = openSecurityGroups([
      {
        groupId: 'sg-7',
        groupName: 'multi',
        arn: 'arn:sg-7',
        region: 'us-east-1',
        inboundRules: [
          { protocol: 'tcp', fromPort: 22, toPort: 22, cidrs: ['0.0.0.0/0'] },
          { protocol: 'tcp', fromPort: 3389, toPort: 3389, cidrs: ['0.0.0.0/0'] },
        ],
      },
    ]);

    expect(result.findings).toHaveLength(1);
    expect(result.findings[0].detail).toContain('22');
    expect(result.findings[0].detail).toContain('3389');
  });
});

describe('publicS3Buckets', () => {
  it('flags a bucket with no public access block', () => {
    const result = publicS3Buckets([
      { name: 'assets', region: 'us-east-1', publicAccessBlockAll: false, isPublicByPolicy: false, hasPublicAcl: false },
    ]);

    expect(result.findings).toHaveLength(1);
    expect(result.findings[0].severity).toBe('critical');
  });

  it('flags a bucket made public by its policy even when a block is configured', () => {
    const result = publicS3Buckets([
      { name: 'leaky', region: 'us-east-1', publicAccessBlockAll: true, isPublicByPolicy: true, hasPublicAcl: false },
    ]);

    expect(result.findings).toHaveLength(1);
    expect(result.findings[0].detail).toContain('policy');
  });

  it('flags a bucket with a public ACL', () => {
    const result = publicS3Buckets([
      { name: 'acl', region: 'us-east-1', publicAccessBlockAll: true, isPublicByPolicy: false, hasPublicAcl: true },
    ]);

    expect(result.findings[0].detail).toContain('ACL');
  });

  it('ignores a fully blocked private bucket', () => {
    const result = publicS3Buckets([
      { name: 'safe', region: 'us-east-1', publicAccessBlockAll: true, isPublicByPolicy: false, hasPublicAcl: false },
    ]);

    expect(result.findings).toEqual([]);
  });
});

describe('rootAccessKeys', () => {
  it('flags an account whose root user has access keys', () => {
    const result = rootAccessKeys({ accountAccessKeysPresent: 1 }, '123456789012');

    expect(result.findings).toHaveLength(1);
    expect(result.findings[0].severity).toBe('critical');
  });

  it('passes an account with no root keys', () => {
    const result = rootAccessKeys({ accountAccessKeysPresent: 0 }, '123456789012');

    expect(result.findings).toEqual([]);
  });
});

describe('publicRdsInstances', () => {
  it('flags a publicly accessible database', () => {
    const result = publicRdsInstances([
      { arn: 'arn:db-1', identifier: 'prod', publiclyAccessible: true, storageEncrypted: true, region: 'us-east-1' },
    ]);

    expect(result.findings).toHaveLength(1);
    expect(result.findings[0].severity).toBe('high');
  });

  it('ignores a private database', () => {
    const result = publicRdsInstances([
      { arn: 'arn:db-2', identifier: 'internal', publiclyAccessible: false, storageEncrypted: true, region: 'us-east-1' },
    ]);

    expect(result.findings).toEqual([]);
  });
});

describe('iamUsersWithoutMfa', () => {
  it('flags a user with a console password and no MFA device', () => {
    const result = iamUsersWithoutMfa([
      {
        userName: 'jdoe',
        arn: 'arn:user/jdoe',
        hasConsolePassword: true,
        mfaDeviceCount: 0,
        accessKeys: [],
        passwordLastUsed: null,
      },
    ]);

    expect(result.findings).toHaveLength(1);
    expect(result.findings[0].severity).toBe('high');
  });

  it('ignores a user with MFA enrolled', () => {
    const result = iamUsersWithoutMfa([
      {
        userName: 'safe',
        arn: 'arn:user/safe',
        hasConsolePassword: true,
        mfaDeviceCount: 1,
        accessKeys: [],
        passwordLastUsed: null,
      },
    ]);

    expect(result.findings).toEqual([]);
  });

  it('ignores a service user with no console access, since MFA does not apply', () => {
    const result = iamUsersWithoutMfa([
      {
        userName: 'ci-bot',
        arn: 'arn:user/ci-bot',
        hasConsolePassword: false,
        mfaDeviceCount: 0,
        accessKeys: [],
        passwordLastUsed: null,
      },
    ]);

    expect(result.findings).toEqual([]);
  });
});

describe('staleAccessKeys', () => {
  const now = new Date('2026-08-27T00:00:00.000Z');

  it('flags a key older than 90 days', () => {
    const result = staleAccessKeys(
      [
        {
          userName: 'jdoe',
          arn: 'arn:user/jdoe',
          hasConsolePassword: false,
          mfaDeviceCount: 0,
          accessKeys: [{ accessKeyId: 'AKIA1', createDate: '2026-01-01T00:00:00.000Z', lastUsedDate: null }],
          passwordLastUsed: null,
        },
      ],
      now
    );

    expect(result.findings).toHaveLength(1);
    expect(result.findings[0].detail).toContain('AKIA1');
  });

  it('ignores a freshly rotated key', () => {
    const result = staleAccessKeys(
      [
        {
          userName: 'jdoe',
          arn: 'arn:user/jdoe',
          hasConsolePassword: false,
          mfaDeviceCount: 0,
          accessKeys: [{ accessKeyId: 'AKIA2', createDate: '2026-08-01T00:00:00.000Z', lastUsedDate: null }],
          passwordLastUsed: null,
        },
      ],
      now
    );

    expect(result.findings).toEqual([]);
  });
});

describe('inactiveIamUsers', () => {
  const now = new Date('2026-08-27T00:00:00.000Z');

  it('flags a user whose password and keys have all been unused for 90 days', () => {
    const result = inactiveIamUsers(
      [
        {
          userName: 'ghost',
          arn: 'arn:user/ghost',
          hasConsolePassword: true,
          mfaDeviceCount: 1,
          accessKeys: [{ accessKeyId: 'AKIA3', createDate: '2025-01-01T00:00:00.000Z', lastUsedDate: '2026-01-01T00:00:00.000Z' }],
          passwordLastUsed: '2026-02-01T00:00:00.000Z',
        },
      ],
      now
    );

    expect(result.findings).toHaveLength(1);
  });

  it('ignores a user active last week', () => {
    const result = inactiveIamUsers(
      [
        {
          userName: 'active',
          arn: 'arn:user/active',
          hasConsolePassword: true,
          mfaDeviceCount: 1,
          accessKeys: [],
          passwordLastUsed: '2026-08-20T00:00:00.000Z',
        },
      ],
      now
    );

    expect(result.findings).toEqual([]);
  });

  it('ignores a user with no recorded activity at all, since a brand new user looks identical', () => {
    const result = inactiveIamUsers(
      [
        {
          userName: 'new',
          arn: 'arn:user/new',
          hasConsolePassword: true,
          mfaDeviceCount: 1,
          accessKeys: [],
          passwordLastUsed: null,
        },
      ],
      now
    );

    expect(result.findings).toEqual([]);
  });
});

describe('unencryptedVolumes', () => {
  it('flags an unencrypted volume', () => {
    const result = unencryptedVolumes([
      { volumeId: 'vol-1', arn: 'arn:vol-1', name: 'data', encrypted: false, region: 'us-east-1' },
    ]);

    expect(result.findings).toHaveLength(1);
    expect(result.findings[0].severity).toBe('medium');
  });

  it('ignores an encrypted volume', () => {
    const result = unencryptedVolumes([
      { volumeId: 'vol-2', arn: 'arn:vol-2', name: null, encrypted: true, region: 'us-east-1' },
    ]);

    expect(result.findings).toEqual([]);
  });
});

describe('unencryptedRdsStorage', () => {
  it('flags a database with unencrypted storage', () => {
    const result = unencryptedRdsStorage([
      { arn: 'arn:db-3', identifier: 'legacy', publiclyAccessible: false, storageEncrypted: false, region: 'us-east-1' },
    ]);

    expect(result.findings).toHaveLength(1);
  });

  it('ignores an encrypted database', () => {
    const result = unencryptedRdsStorage([
      { arn: 'arn:db-4', identifier: 'modern', publiclyAccessible: false, storageEncrypted: true, region: 'us-east-1' },
    ]);

    expect(result.findings).toEqual([]);
  });
});

describe('expiringCertificates', () => {
  const now = new Date('2026-08-27T00:00:00.000Z');

  function cert(overrides: Partial<Record<string, unknown>> = {}) {
    return {
      arn: 'arn:aws:acm:us-east-1:123:certificate/abc',
      domainName: 'example.com',
      notAfter: '2026-12-01T00:00:00.000Z',
      inUse: true,
      region: 'us-east-1',
      ...overrides,
    };
  }

  it('flags an already-expired certificate as critical', () => {
    const result = expiringCertificates([cert({ notAfter: '2026-08-01T00:00:00.000Z' })], now);

    expect(result.findings).toHaveLength(1);
    expect(result.findings[0].severity).toBe('critical');
    expect(result.findings[0].detail).toContain('expired');
  });

  it('flags a certificate expiring within 30 days as high', () => {
    const result = expiringCertificates([cert({ notAfter: '2026-09-10T00:00:00.000Z' })], now);

    expect(result.findings[0].severity).toBe('high');
    expect(result.findings[0].detail).toContain('14 days');
  });

  it('flags a certificate expiring within 90 days as medium', () => {
    const result = expiringCertificates([cert({ notAfter: '2026-10-20T00:00:00.000Z' })], now);

    expect(result.findings[0].severity).toBe('medium');
  });

  // A cert 200 days out is not actionable, and listing it buries the ones that are.
  it('ignores a certificate expiring beyond 90 days', () => {
    const result = expiringCertificates([cert({ notAfter: '2027-06-01T00:00:00.000Z' })], now);

    expect(result.findings).toEqual([]);
  });

  it('treats the 30-day boundary as high, not medium', () => {
    const result = expiringCertificates([cert({ notAfter: '2026-09-26T00:00:00.000Z' })], now);

    expect(result.findings[0].severity).toBe('high');
  });

  // Absent data is not evidence of a problem — same rule as inactive IAM users.
  it('ignores a certificate with no expiry date rather than guessing', () => {
    const result = expiringCertificates([cert({ notAfter: null })], now);

    expect(result.findings).toEqual([]);
  });

  it('names the domain and says whether the certificate is in use', () => {
    const result = expiringCertificates([cert({ notAfter: '2026-09-10T00:00:00.000Z', inUse: false })], now);

    expect(result.findings[0].resourceName).toBe('example.com');
    expect(result.findings[0].detail).toContain('not attached');
  });

  it('reports nothing for an account with no certificates', () => {
    const result = expiringCertificates([], now);

    expect(result.status).toBe('ok');
    expect(result.findings).toEqual([]);
  });
});
