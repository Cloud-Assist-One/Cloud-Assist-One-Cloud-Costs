import {
  openNsgRules,
  openSqlFirewallRules,
  publicBlobStorage,
  sqlPublicNetworkAccess,
  entraUsersWithoutMfa,
  insecureStorageTransport,
  appServiceNotHttpsOnly,
} from './securityChecks';

describe('openNsgRules', () => {
  function nsg(rule: Record<string, unknown>) {
    return [
      {
        id: '/subscriptions/s1/nsg/nsg-1',
        name: 'nsg-1',
        location: 'eastus',
        rules: [
          {
            name: 'rule-1',
            direction: 'Inbound',
            access: 'Allow',
            protocol: 'Tcp',
            destinationPortRanges: ['22'],
            sourceAddressPrefixes: ['*'],
            ...rule,
          },
        ],
      },
    ];
  }

  it('flags SSH open to any source', () => {
    const result = openNsgRules(nsg({}));

    expect(result.findings).toHaveLength(1);
    expect(result.findings[0].severity).toBe('critical');
    expect(result.findings[0].detail).toContain('22');
  });

  it('treats the Internet service tag as public', () => {
    const result = openNsgRules(nsg({ sourceAddressPrefixes: ['Internet'] }));

    expect(result.findings).toHaveLength(1);
  });

  it('treats 0.0.0.0/0 as public', () => {
    const result = openNsgRules(nsg({ sourceAddressPrefixes: ['0.0.0.0/0'] }));

    expect(result.findings).toHaveLength(1);
  });

  it('expands a port range and flags the sensitive ports inside it', () => {
    const result = openNsgRules(nsg({ destinationPortRanges: ['3000-6000'] }));

    expect(result.findings[0].detail).toContain('3306');
    expect(result.findings[0].detail).toContain('5432');
  });

  it('treats a wildcard port as all ports', () => {
    const result = openNsgRules(nsg({ destinationPortRanges: ['*'] }));

    expect(result.findings[0].detail).toContain('all ports');
  });

  it('ignores a rule scoped to a private source', () => {
    const result = openNsgRules(nsg({ sourceAddressPrefixes: ['10.0.0.0/8'] }));

    expect(result.findings).toEqual([]);
  });

  it('ignores a Deny rule', () => {
    const result = openNsgRules(nsg({ access: 'Deny' }));

    expect(result.findings).toEqual([]);
  });

  it('ignores an outbound rule', () => {
    const result = openNsgRules(nsg({ direction: 'Outbound' }));

    expect(result.findings).toEqual([]);
  });

  it('ignores a non-sensitive port open to the internet', () => {
    const result = openNsgRules(nsg({ destinationPortRanges: ['443'] }));

    expect(result.findings).toEqual([]);
  });
});

describe('openSqlFirewallRules', () => {
  it('flags a rule spanning the whole IPv4 range', () => {
    const result = openSqlFirewallRules([
      {
        id: '/subscriptions/s1/servers/sql-1',
        name: 'sql-1',
        location: 'eastus',
        publicNetworkAccess: 'Enabled',
        firewallRules: [{ name: 'open-to-world', startIpAddress: '0.0.0.0', endIpAddress: '255.255.255.255' }],
      },
    ]);

    expect(result.findings).toHaveLength(1);
    expect(result.findings[0].severity).toBe('critical');
  });

  it('does not flag the Allow-Azure-services rule, which is 0.0.0.0 to 0.0.0.0', () => {
    const result = openSqlFirewallRules([
      {
        id: '/subscriptions/s1/servers/sql-2',
        name: 'sql-2',
        location: 'eastus',
        publicNetworkAccess: 'Enabled',
        firewallRules: [{ name: 'AllowAllWindowsAzureIps', startIpAddress: '0.0.0.0', endIpAddress: '0.0.0.0' }],
      },
    ]);

    expect(result.findings).toEqual([]);
  });

  it('ignores a narrowly scoped office IP rule', () => {
    const result = openSqlFirewallRules([
      {
        id: '/subscriptions/s1/servers/sql-3',
        name: 'sql-3',
        location: 'eastus',
        publicNetworkAccess: 'Enabled',
        firewallRules: [{ name: 'office', startIpAddress: '203.0.113.5', endIpAddress: '203.0.113.5' }],
      },
    ]);

    expect(result.findings).toEqual([]);
  });
});

describe('publicBlobStorage', () => {
  it('flags an account that allows public blob access', () => {
    const result = publicBlobStorage([
      {
        id: '/subscriptions/s1/storage/sa-1',
        name: 'sa-1',
        location: 'eastus',
        allowBlobPublicAccess: true,
        httpsOnly: true,
        minimumTlsVersion: 'TLS1_2',
      },
    ]);

    expect(result.findings).toHaveLength(1);
    expect(result.findings[0].severity).toBe('critical');
  });

  it('ignores an account with public blob access disabled', () => {
    const result = publicBlobStorage([
      {
        id: '/subscriptions/s1/storage/sa-2',
        name: 'sa-2',
        location: 'eastus',
        allowBlobPublicAccess: false,
        httpsOnly: true,
        minimumTlsVersion: 'TLS1_2',
      },
    ]);

    expect(result.findings).toEqual([]);
  });
});

describe('sqlPublicNetworkAccess', () => {
  it('flags a server reachable over the public endpoint', () => {
    const result = sqlPublicNetworkAccess([
      {
        id: '/subscriptions/s1/servers/sql-4',
        name: 'sql-4',
        location: 'eastus',
        publicNetworkAccess: 'Enabled',
        firewallRules: [],
      },
    ]);

    expect(result.findings).toHaveLength(1);
    expect(result.findings[0].severity).toBe('high');
  });

  it('ignores a server restricted to private endpoints', () => {
    const result = sqlPublicNetworkAccess([
      {
        id: '/subscriptions/s1/servers/sql-5',
        name: 'sql-5',
        location: 'eastus',
        publicNetworkAccess: 'Disabled',
        firewallRules: [],
      },
    ]);

    expect(result.findings).toEqual([]);
  });
});

describe('entraUsersWithoutMfa', () => {
  it('flags an enabled user with no MFA method registered', () => {
    const result = entraUsersWithoutMfa([
      { id: 'user-1', displayName: 'Jane Doe', userPrincipalName: 'jane@example.com', accountEnabled: true, mfaRegistered: false },
    ]);

    expect(result.findings).toHaveLength(1);
    expect(result.findings[0].resourceName).toBe('jane@example.com');
  });

  it('ignores a user with MFA registered', () => {
    const result = entraUsersWithoutMfa([
      { id: 'user-2', displayName: 'Safe', userPrincipalName: 'safe@example.com', accountEnabled: true, mfaRegistered: true },
    ]);

    expect(result.findings).toEqual([]);
  });

  it('ignores a disabled account, which cannot sign in at all', () => {
    const result = entraUsersWithoutMfa([
      { id: 'user-3', displayName: 'Gone', userPrincipalName: 'gone@example.com', accountEnabled: false, mfaRegistered: false },
    ]);

    expect(result.findings).toEqual([]);
  });
});

describe('insecureStorageTransport', () => {
  it('flags an account that allows plain HTTP', () => {
    const result = insecureStorageTransport([
      {
        id: '/subscriptions/s1/storage/sa-3',
        name: 'sa-3',
        location: 'eastus',
        allowBlobPublicAccess: false,
        httpsOnly: false,
        minimumTlsVersion: 'TLS1_2',
      },
    ]);

    expect(result.findings).toHaveLength(1);
    expect(result.findings[0].detail).toContain('HTTP');
  });

  it('flags an account still accepting TLS 1.0', () => {
    const result = insecureStorageTransport([
      {
        id: '/subscriptions/s1/storage/sa-4',
        name: 'sa-4',
        location: 'eastus',
        allowBlobPublicAccess: false,
        httpsOnly: true,
        minimumTlsVersion: 'TLS1_0',
      },
    ]);

    expect(result.findings).toHaveLength(1);
    expect(result.findings[0].detail).toContain('TLS1_0');
  });

  it('ignores an HTTPS-only account on TLS 1.2', () => {
    const result = insecureStorageTransport([
      {
        id: '/subscriptions/s1/storage/sa-5',
        name: 'sa-5',
        location: 'eastus',
        allowBlobPublicAccess: false,
        httpsOnly: true,
        minimumTlsVersion: 'TLS1_2',
      },
    ]);

    expect(result.findings).toEqual([]);
  });
});

describe('appServiceNotHttpsOnly', () => {
  it('flags an app that accepts plain HTTP', () => {
    const result = appServiceNotHttpsOnly([
      { id: '/subscriptions/s1/sites/app-1', name: 'app-1', location: 'eastus', httpsOnly: false },
    ]);

    expect(result.findings).toHaveLength(1);
  });

  it('ignores an HTTPS-only app', () => {
    const result = appServiceNotHttpsOnly([
      { id: '/subscriptions/s1/sites/app-2', name: 'app-2', location: 'eastus', httpsOnly: true },
    ]);

    expect(result.findings).toEqual([]);
  });
});
