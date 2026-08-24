export type ProfileRole = 'client' | 'staff' | 'admin';
export type CloudProvider = 'aws' | 'azure' | 'gcp' | 'snowflake';
export type UploadStatus = 'processing' | 'processed' | 'error';

export interface Company {
  id: string;
  name: string;
  created_at: string;
}

export type BillingPeriodStatus = 'active' | 'archived';

export interface BillingPeriod {
  id: string;
  company_id: string;
  status: BillingPeriodStatus;
  created_at: string;
  archived_at: string | null;
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
}

export interface AzureCredentialSummary {
  id: string;
  label: string;
  tenantId: string;
  clientId: string;
  subscriptionId: string;
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
}

export interface LambdaFunctionRow {
  functionName: string;
  runtime: string | null;
  memorySize: number | null;
  timeout: number | null;
  lastModified: string | null;
}

export interface EcsServiceRow {
  cluster: string;
  serviceName: string;
  desiredCount: number;
  runningCount: number;
  launchType: string | null;
  createdAt: string | null;
}

export interface RdsInstanceRow {
  dbInstanceIdentifier: string;
  engine: string;
  dbInstanceClass: string;
  status: string;
  multiAz: boolean;
  allocatedStorage: number;
  instanceCreateTime: string | null;
}

export interface DynamoTableRow {
  tableName: string;
  creationDateTime: string | null;
}

export interface ApiRow {
  id: string;
  name: string;
  type: 'REST' | 'HTTP';
  createdDate: string | null;
  endpoint: string | null;
}

export interface S3BucketRow {
  name: string;
  creationDate: string | null;
}

export interface IamUserRow {
  userName: string;
  userId: string;
  arn: string;
  path: string;
  createDate: string | null;
  passwordLastUsed: string | null;
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
      users: AwsResourceResult<IamUserRow>;
    };

export interface AzureVmRow {
  name: string;
  vmSize: string | null;
  provisioningState: string | null;
  resourceGroup: string;
  location: string | null;
  timeCreated: string | null;
}

export interface AzureFunctionAppRow {
  name: string;
  state: string | null;
  kind: string;
  resourceGroup: string;
  location: string | null;
  createdAt: string | null;
}

export interface AzureContainerGroupRow {
  name: string;
  resourceGroup: string;
  location: string | null;
  provisioningState: string | null;
  containerImages: string;
  createdAt: string | null;
}

export interface AzureSqlDatabaseRow {
  serverName: string;
  databaseName: string;
  resourceGroup: string;
  status: string | null;
  serviceObjective: string | null;
  creationDate: string | null;
}

export interface AzureCosmosDbAccountRow {
  name: string;
  resourceGroup: string;
  location: string | null;
  kind: string | null;
  provisioningState: string | null;
  createdAt: string | null;
}

export interface AzureApiManagementRow {
  name: string;
  resourceGroup: string;
  location: string | null;
  skuName: string | null;
  createdAtUtc: string | null;
}

export interface AzureStorageAccountRow {
  name: string;
  resourceGroup: string;
  location: string | null;
  kind: string | null;
  skuName: string | null;
  creationTime: string | null;
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
