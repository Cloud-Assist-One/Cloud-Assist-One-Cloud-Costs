interface CategoryRule {
  category: string;
  patterns: RegExp[];
}

const CATEGORY_RULES: CategoryRule[] = [
  {
    category: 'Compute',
    patterns: [
      /ec2/i,
      /app service/i,
      /lambda/i,
      /azure functions/i,
      /virtual machine/i,
      /compute engine/i,
      /app engine/i,
      /cloud run/i,
      /kubernetes engine/i,
      /\bgke\b/i,
    ],
  },
  {
    category: 'Storage',
    patterns: [/\bs3\b/i, /blob storage/i, /storage account/i, /cloud storage/i],
  },
  {
    category: 'Database',
    patterns: [/\brds\b/i, /sql database/i, /dynamodb/i, /cosmos db/i, /cloud sql/i, /bigquery/i, /firestore/i],
  },
  {
    category: 'Networking',
    patterns: [
      /cloudfront/i,
      /\bcdn\b/i,
      /virtual network/i,
      /load balancer/i,
      /elastic load balancing/i,
      /cloud cdn/i,
      /cloud load balancing/i,
      /virtual private cloud/i,
    ],
  },
];

export function categorizeService(serviceName: string): string {
  for (const rule of CATEGORY_RULES) {
    if (rule.patterns.some((pattern) => pattern.test(serviceName))) {
      return rule.category;
    }
  }
  return 'Other';
}
