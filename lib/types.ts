export type ProfileRole = 'client' | 'staff';
export type CloudProvider = 'aws' | 'azure';
export type UploadStatus = 'processing' | 'processed' | 'error';

export interface Company {
  id: string;
  name: string;
  created_at: string;
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
  cloud_provider: CloudProvider;
  filename: string;
  storage_path: string;
  status: UploadStatus;
  error_message: string | null;
  row_count: number | null;
  uploaded_by: string;
  created_at: string;
}

export interface CostRecord {
  id: string;
  company_id: string;
  cloud_provider: CloudProvider;
  service_name: string;
  usage_date: string;
  cost: number;
  account_id: string | null;
  source_file_id: string;
  created_at: string;
}
