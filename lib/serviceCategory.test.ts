import { categorizeService } from './serviceCategory';

describe('categorizeService', () => {
  it('categorizes AWS compute services', () => {
    expect(categorizeService('Amazon EC2')).toBe('Compute');
  });

  it('categorizes Azure compute services', () => {
    expect(categorizeService('Azure App Service')).toBe('Compute');
  });

  it('categorizes AWS storage services', () => {
    expect(categorizeService('Amazon S3')).toBe('Storage');
  });

  it('categorizes Azure storage services', () => {
    expect(categorizeService('Azure Blob Storage')).toBe('Storage');
  });

  it('categorizes AWS database services', () => {
    expect(categorizeService('Amazon RDS')).toBe('Database');
  });

  it('categorizes Azure database services', () => {
    expect(categorizeService('Azure SQL Database')).toBe('Database');
  });

  it('categorizes networking services from either cloud', () => {
    expect(categorizeService('Amazon CloudFront')).toBe('Networking');
    expect(categorizeService('Azure Virtual Network')).toBe('Networking');
  });

  it('categorizes Google Cloud compute services', () => {
    expect(categorizeService('Compute Engine')).toBe('Compute');
    expect(categorizeService('Cloud Run')).toBe('Compute');
    expect(categorizeService('Kubernetes Engine')).toBe('Compute');
  });

  it('categorizes Google Cloud storage services', () => {
    expect(categorizeService('Cloud Storage')).toBe('Storage');
  });

  it('categorizes Google Cloud database services', () => {
    expect(categorizeService('Cloud SQL')).toBe('Database');
    expect(categorizeService('BigQuery')).toBe('Database');
  });

  it('categorizes Google Cloud networking services', () => {
    expect(categorizeService('Cloud Load Balancing')).toBe('Networking');
  });

  it('falls back to Other for an unrecognized service name', () => {
    expect(categorizeService('Some Unknown Service')).toBe('Other');
  });
});
