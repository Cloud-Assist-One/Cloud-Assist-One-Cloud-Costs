export type ProfileRole = 'client' | 'staff' | 'admin';
export type CloudProvider = 'aws' | 'azure' | 'gcp' | 'snowflake';
export type UploadStatus = 'processing' | 'processed' | 'error';

export interface Company {
  id: string;
  name: string;
  created_at: string;
  subscription_tier: string;
}

export type BillingPeriodStatus = 'active' | 'archived';

export interface BillingPeriod {
  id: string;
  company_id: string;
  status: BillingPeriodStatus;
  created_at: string;
  archived_at: string | null;
  /**
   * Stamped when the period is archived, from the billing month its uploads
   * and pulls were for. Null on the active period, and on anything archived
   * before this was recorded. One archived period per month per company.
   */
  billing_month: string | null;
}

export interface Profile {
  id: string;
  company_id: string | null;
  email: string;
  role: ProfileRole;
  created_at: string;
}

export interface UploadedFile {
  id: string;
  company_id: string;
  period_id: string;
  cloud_provider: CloudProvider;
  filename: string;
  storage_path: string;
  status: UploadStatus;
  error_message: string | null;
  row_count: number | null;
  uploaded_by: string;
  created_at: string;
  billing_month: string | null;
}

export interface CostRecord {
  id: string;
  company_id: string;
  period_id: string;
  cloud_provider: CloudProvider;
  service_name: string;
  usage_date: string;
  cost: number;
  account_id: string | null;
  source_file_id: string;
  created_at: string;

  // Billing line-item detail. Nullable because they only populate when a
  // provider export (CUR, Azure usage export) carries them; a service-level
  // pull fills almost none of these. See
  // supabase/migrations/20260829000000_billing_line_item_fields.sql.
  resource_id: string | null;
  resource_group: string | null;
  region: string | null;
  availability_zone: string | null;
  instance_type: string | null;
  database_engine: string | null;
  meter_category: string | null;
  meter_name: string | null;
  usage_type: string | null;
  operation: string | null;
  subscription_id: string | null;
  subscription_name: string | null;
  purchase_type: string | null;
  reservation_id: string | null;
  reservation_name: string | null;
  quantity: number | null;
  unit: string | null;
  unit_price: number | null;
  effective_price: number | null;
  currency: string | null;
  charge_type: string | null;
  tags: Record<string, string> | null;
}

export type TodoStatus = 'open' | 'done';

export interface ReviewNote {
  id: string;
  company_id: string;
  period_id: string;
  cost_record_id: string | null;
  author_id: string;
  note_text: string | null;
  voice_note_path: string | null;
  created_at: string;
}

export interface ReviewTodo {
  id: string;
  company_id: string;
  period_id: string;
  cost_record_id: string | null;
  title: string;
  status: TodoStatus;
  created_by: string;
  created_at: string;
  completed_at: string | null;
}

export interface TimeEntry {
  id: string;
  company_id: string;
  period_id: string;
  staff_id: string;
  entry_date: string;
  minutes_spent: number;
  description: string;
  created_at: string;
}

export interface CloudProviderCredentials {
  id: string;
  company_id: string;
  provider: CloudProvider;
  label: string;
  auth_type: 'keys' | 'role';
  region: string | null;
  metadata: Record<string, unknown>;
  created_by: string;
  created_at: string;
  updated_at: string;
}

export interface AwsCredentialSummary {
  id: string;
  label: string;
  accessKeyIdMasked: string;
  region: string;
  tagKey: string;
}

export interface AzureCredentialSummary {
  id: string;
  label: string;
  tenantId: string;
  clientId: string;
  subscriptionId: string;
  tagKey: string;
}

export interface GcpCredentialSummary {
  id: string;
  label: string;
  projectId: string;
}

export interface SnowflakeCredentialSummary {
  id: string;
  label: string;
  account: string;
  username: string;
}

export interface Ec2InstanceRow {
  instanceId: string;
  name: string | null;
  instanceType: string;
  state: string;
  availabilityZone: string | null;
  privateIp: string | null;
  publicIp: string | null;
  launchTime: string | null;
  tagValue: string | null;
}

export interface LambdaFunctionRow {
  functionName: string;
  runtime: string | null;
  memorySize: number | null;
  timeout: number | null;
  lastModified: string | null;
  tagValue: string | null;
}

export interface EcsServiceRow {
  cluster: string;
  serviceName: string;
  desiredCount: number;
  runningCount: number;
  launchType: string | null;
  createdAt: string | null;
  tagValue: string | null;
}

export interface RdsInstanceRow {
  dbInstanceIdentifier: string;
  engine: string;
  dbInstanceClass: string;
  status: string;
  multiAz: boolean;
  allocatedStorage: number;
  instanceCreateTime: string | null;
  tagValue: string | null;
}

export interface DynamoTableRow {
  tableName: string;
  creationDateTime: string | null;
  tagValue: string | null;
}

export interface ApiRow {
  id: string;
  name: string;
  type: 'REST' | 'HTTP';
  createdDate: string | null;
  endpoint: string | null;
  tagValue: string | null;
}

export interface S3BucketRow {
  name: string;
  creationDate: string | null;
  tagValue: string | null;
}

export interface IamUserRow {
  userName: string;
  userId: string;
  arn: string;
  path: string;
  createDate: string | null;
  passwordLastUsed: string | null;
  tagValue: string | null;
}

export interface AwsResourceResult<T> {
  data: T[];
  error: string | null;
}

export type AwsResourcesResponse =
  | { connected: false }
  | {
      connected: true;
      region: string;
      fetchedAt: string;
      tagKey: string;
      ec2: AwsResourceResult<Ec2InstanceRow>;
      lambda: AwsResourceResult<LambdaFunctionRow>;
      ecs: AwsResourceResult<EcsServiceRow>;
      rds: AwsResourceResult<RdsInstanceRow>;
      dynamodb: AwsResourceResult<DynamoTableRow>;
      apis: AwsResourceResult<ApiRow>;
      s3: AwsResourceResult<S3BucketRow>;
    };

export type AwsIamUsersResponse =
  | { connected: false }
  | {
      connected: true;
      fetchedAt: string;
      tagKey: string;
      users: AwsResourceResult<IamUserRow>;
    };

export interface PullBillingSuccessResponse {
  uploadedFileId: string;
  status: 'processed';
  rowCount: number;
  newPeriodId?: string;
  /**
   * Set when the pull succeeded but not as configured — currently only when
   * AWS refused to group by the connection's tag, so the data came back
   * without billing codes.
   */
  warning?: string;
}

export interface AzureVmRow {
  name: string;
  vmSize: string | null;
  provisioningState: string | null;
  resourceGroup: string;
  location: string | null;
  timeCreated: string | null;
  tagValue: string | null;
}

export interface AzureFunctionAppRow {
  name: string;
  state: string | null;
  kind: string;
  resourceGroup: string;
  location: string | null;
  createdAt: string | null;
  tagValue: string | null;
}

export interface AzureContainerGroupRow {
  name: string;
  resourceGroup: string;
  location: string | null;
  provisioningState: string | null;
  containerImages: string;
  createdAt: string | null;
  tagValue: string | null;
}

export interface AzureSqlDatabaseRow {
  serverName: string;
  databaseName: string;
  resourceGroup: string;
  status: string | null;
  serviceObjective: string | null;
  creationDate: string | null;
  tagValue: string | null;
}

export interface AzureCosmosDbAccountRow {
  name: string;
  resourceGroup: string;
  location: string | null;
  kind: string | null;
  provisioningState: string | null;
  createdAt: string | null;
  tagValue: string | null;
}

export interface AzureApiManagementRow {
  name: string;
  resourceGroup: string;
  location: string | null;
  skuName: string | null;
  createdAtUtc: string | null;
  tagValue: string | null;
}

export interface AzureStorageAccountRow {
  name: string;
  resourceGroup: string;
  location: string | null;
  kind: string | null;
  skuName: string | null;
  creationTime: string | null;
  tagValue: string | null;
}

export interface AzureAdUserRow {
  id: string;
  displayName: string | null;
  userPrincipalName: string | null;
  createdDateTime: string | null;
}

export interface AzureResourceResult<T> {
  data: T[];
  error: string | null;
}

export type AzureResourcesResponse =
  | { connected: false }
  | {
      connected: true;
      fetchedAt: string;
      tagKey: string;
      virtualMachines: AzureResourceResult<AzureVmRow>;
      functionApps: AzureResourceResult<AzureFunctionAppRow>;
      containerGroups: AzureResourceResult<AzureContainerGroupRow>;
      sqlDatabases: AzureResourceResult<AzureSqlDatabaseRow>;
      cosmosDbAccounts: AzureResourceResult<AzureCosmosDbAccountRow>;
      apiManagementServices: AzureResourceResult<AzureApiManagementRow>;
      storageAccounts: AzureResourceResult<AzureStorageAccountRow>;
    };

export type AzureAdUsersResponse =
  | { connected: false }
  | {
      connected: true;
      fetchedAt: string;
      users: AzureResourceResult<AzureAdUserRow>;
    };

export interface SupportRequest {
  id: string;
  company_id: string;
  submitted_by: string;
  first_name: string;
  email: string;
  phone: string | null;
  phone_ext: string | null;
  topics: string[];
  details: string | null;
  created_at: string;
}

// The admin grid spans every client, so it carries the company name alongside
// each request to keep them distinguishable.
export interface SupportRequestWithCompany extends SupportRequest {
  company_name: string;
}

export type FindingSeverity = 'critical' | 'high' | 'medium' | 'low';

export interface Finding {
  severity: FindingSeverity;
  /** ARN (AWS) or full resource ID (Azure). Used for the billing cost join. */
  resourceId: string;
  resourceName: string;
  region: string | null;
  /** Why this resource tripped the check, in plain language. */
  detail: string;
  /** Cost-leakage tabs only. null means "not in the last billing pull", not "free". */
  monthlyCost: number | null;
}

export interface CheckResult {
  checkId: string;
  title: string;
  source: 'native' | 'builtin';
  status: 'ok' | 'unavailable';
  unavailableReason: string | null;
  findings: Finding[];
}

export type FindingsResponse =
  | { connected: false }
  | { connected: true; fetchedAt: string; region: string | null; checks: CheckResult[] };
