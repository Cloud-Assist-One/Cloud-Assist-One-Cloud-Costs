'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { createClient } from '@/lib/supabase/client';
import type { Company, ProfileRole } from '@/lib/types';
import { CLOUD_PROVIDER_LABELS } from '@/lib/cloudProvider';
import UploadedFilesList from '../files/UploadedFilesList';
import CostReportTab from '../reports/CostReportTab';
import CompareTab from '../reports/CompareTab';
import LineItemsTab from '../reports/LineItemsTab';
import NotesFeed from '../notes/NotesFeed';
import AdminCompanies from '../admin/AdminCompanies';
import AdminUsers from '../admin/AdminUsers';
import ArchiveTab from './ArchiveTab';
import SettingsTab from '../settings/SettingsTab';
import AwsResourcesTab from '../reports/AwsResourcesTab';
import AwsIamUsersTab from '../reports/AwsIamUsersTab';
import AzureResourcesTab from '../reports/AzureResourcesTab';
import AzureUsersTab from '../reports/AzureUsersTab';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Button } from '@/components/ui/button';
import ThemeToggle from './ThemeToggle';
import AccentColorPicker from './AccentColorPicker';
import styles from './AppShell.module.css';

type TabKey =
  | 'aws'
  | 'azure'
  | 'gcp'
  | 'snowflake'
  | 'compare'
  | 'lineItems'
  | 'files'
  | 'notes'
  | 'archive'
  | 'settings'
  | 'admin';

// The "Archive this period" action only makes sense while looking at one of
// the single-cloud-provider report tabs, not Compare/Line Items/Files/etc.
const SINGLE_PROVIDER_TABS: TabKey[] = ['aws', 'azure', 'gcp', 'snowflake'];

interface AppShellProps {
  userId: string;
  role: ProfileRole;
  companyId: string | null;
  userEmail: string;
}

export default function AppShell({ userId, role, companyId, userEmail }: AppShellProps) {
  const canManage = role === 'staff' || role === 'admin';
  const [activeTab, setActiveTab] = useState<TabKey>('aws');
  const [companies, setCompanies] = useState<Company[]>([]);
  const [selectedCompanyId, setSelectedCompanyId] = useState<string | null>(companyId);
  const [activePeriodId, setActivePeriodId] = useState<string | null>(null);
  const [viewingPeriodId, setViewingPeriodId] = useState<string | null>(null);
  const [lineItemsFilter, setLineItemsFilter] = useState<string[] | undefined>(undefined);
  const [archiveError, setArchiveError] = useState<string | null>(null);
  const [awsSubTab, setAwsSubTab] = useState<'overview' | 'resources' | 'iamUsers'>('overview');
  const [azureSubTab, setAzureSubTab] = useState<'overview' | 'resources' | 'users'>('overview');
  const isWideCloudView =
    (activeTab === 'aws' && (awsSubTab === 'resources' || awsSubTab === 'iamUsers')) ||
    (activeTab === 'azure' && (azureSubTab === 'resources' || azureSubTab === 'users'));
  const router = useRouter();

  useEffect(() => {
    if (role !== 'staff' && role !== 'admin') return;

    let cancelled = false;

    async function loadCompanies() {
      const supabase = createClient();
      const { data } = await supabase.from('companies').select('*').order('name', { ascending: true });
      if (cancelled) return;
      setCompanies(data ?? []);
      if (data && data.length > 0) {
        setSelectedCompanyId((prev) => prev ?? data[0].id);
      }
    }

    loadCompanies();
    return () => {
      cancelled = true;
    };
  }, [role]);

  const effectiveCompanyId = canManage ? selectedCompanyId : companyId;

  // Switching companies always resets back to that company's active period —
  // never carries over "viewing an archived period" from the previous company.
  useEffect(() => {
    let cancelled = false;

    async function loadActivePeriod() {
      setViewingPeriodId(null);
      setActivePeriodId(null);
      setLineItemsFilter(undefined);
      if (!effectiveCompanyId) return;

      const supabase = createClient();
      const { data } = await supabase
        .from('billing_periods')
        .select('id')
        .eq('company_id', effectiveCompanyId)
        .eq('status', 'active')
        .single();
      if (!cancelled) {
        setActivePeriodId(data?.id ?? null);
      }
    }

    loadActivePeriod();
    return () => {
      cancelled = true;
    };
  }, [effectiveCompanyId]);

  async function handleSignOut() {
    const supabase = createClient();
    await supabase.auth.signOut();
    router.refresh();
  }

  async function handleArchive() {
    if (!effectiveCompanyId) return;
    const confirmed = window.confirm(
      'Archive this period? It will be frozen (read-only) and a new empty period will start.'
    );
    if (!confirmed) return;

    setArchiveError(null);
    try {
      const response = await fetch('/api/periods/archive', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ companyId: effectiveCompanyId }),
      });
      const body = await response.json();
      if (!response.ok) {
        setArchiveError(body.error ?? 'Could not archive this period.');
        return;
      }
      setActivePeriodId(body.newPeriodId);
    } catch {
      setArchiveError('Could not archive this period. Please check your connection and try again.');
    }
  }

  function handleServiceDrillDown(serviceNames: string[]) {
    setLineItemsFilter(serviceNames);
    setActiveTab('lineItems');
  }

  const viewingArchivedPeriod = viewingPeriodId !== null && viewingPeriodId !== activePeriodId;
  const periodIdForReports = viewingArchivedPeriod ? viewingPeriodId : activePeriodId;

  return (
    <div className={styles.wrapper}>
      <div className={`${styles.topBar} print-hidden`}>
        <h1>Cloud Cost Assistant</h1>
        {canManage && (
          <div className={styles.companySwitcher}>
            <label htmlFor="company-switcher">Viewing company</label>
            <select
              id="company-switcher"
              value={selectedCompanyId ?? ''}
              onChange={(e) => setSelectedCompanyId(e.target.value)}
            >
              {companies.map((company) => (
                <option key={company.id} value={company.id}>
                  {company.name}
                </option>
              ))}
            </select>
          </div>
        )}
        {!viewingArchivedPeriod && activePeriodId && SINGLE_PROVIDER_TABS.includes(activeTab) && (
          <Button type="button" variant="outline" size="sm" onClick={handleArchive}>
            Archive this period
          </Button>
        )}
        <span className={styles.userEmail}>{userEmail}</span>
        <ThemeToggle />
        <AccentColorPicker />
        <Button type="button" variant="outline" size="sm" onClick={handleSignOut}>
          Sign out
        </Button>
      </div>

      <Tabs value={activeTab} onValueChange={(value) => setActiveTab(value as TabKey)} className={`mb-6 print-hidden`}>
        <TabsList>
          <TabsTrigger value="aws">{CLOUD_PROVIDER_LABELS.aws}</TabsTrigger>
          <TabsTrigger value="azure">{CLOUD_PROVIDER_LABELS.azure}</TabsTrigger>
          <TabsTrigger value="gcp">{CLOUD_PROVIDER_LABELS.gcp}</TabsTrigger>
          <TabsTrigger value="snowflake">{CLOUD_PROVIDER_LABELS.snowflake}</TabsTrigger>
          <TabsTrigger value="compare">Compare</TabsTrigger>
          <TabsTrigger value="lineItems">Line Items</TabsTrigger>
          <TabsTrigger value="files">Uploaded Files</TabsTrigger>
          <TabsTrigger value="notes">Notes & Follow-ups</TabsTrigger>
          <TabsTrigger value="archive">Archive</TabsTrigger>
          <TabsTrigger value="settings">Settings</TabsTrigger>
          {canManage && <TabsTrigger value="admin">Admin</TabsTrigger>}
        </TabsList>
      </Tabs>

      {viewingArchivedPeriod && (
        <div className={styles.archiveBanner}>
          <span>Viewing archived period</span>
          <button
            type="button"
            className="print-hidden"
            onClick={() => {
              setViewingPeriodId(null);
              setLineItemsFilter(undefined);
            }}
          >
            Back to current
          </button>
        </div>
      )}

      {archiveError && (
        <p role="alert" className={styles.archiveError}>
          {archiveError}
        </p>
      )}

      <div className={styles.panel}>
        {activeTab === 'admin' && canManage ? (
          <div className={styles.adminSections}>
            <AdminCompanies isAdmin={role === 'admin'} />
            <AdminUsers isAdmin={role === 'admin'} />
          </div>
        ) : activeTab === 'archive' ? (
          effectiveCompanyId ? (
            <ArchiveTab
              companyId={effectiveCompanyId}
              onSelectPeriod={(periodId) => {
                setViewingPeriodId(periodId);
                setActiveTab('aws');
              }}
            />
          ) : (
            <p>Select a company to view its data.</p>
          )
        ) : activeTab === 'settings' ? (
          effectiveCompanyId ? (
            <SettingsTab companyId={effectiveCompanyId} />
          ) : (
            <p>Select a company to view its data.</p>
          )
        ) : !effectiveCompanyId ? (
          <p>Select a company to view its data.</p>
        ) : !periodIdForReports ? (
          <p>Loading…</p>
        ) : (
          <div className={isWideCloudView ? styles.resourcesContent : styles.reportContent}>
              {activeTab === 'aws' && (
                <div className={styles.cloudSubTabs}>
                  <Tabs
                    value={awsSubTab}
                    onValueChange={(value) => setAwsSubTab(value as 'overview' | 'resources' | 'iamUsers')}
                  >
                    <TabsList>
                      <TabsTrigger value="overview">Overview</TabsTrigger>
                      <TabsTrigger value="resources">Resources</TabsTrigger>
                      <TabsTrigger value="iamUsers">IAM Users</TabsTrigger>
                    </TabsList>
                  </Tabs>
                  {awsSubTab === 'overview' ? (
                    <CostReportTab
                      companyId={effectiveCompanyId}
                      cloudProvider="aws"
                      periodId={periodIdForReports}
                      isReadOnly={viewingArchivedPeriod}
                      onServiceClick={(serviceName) => handleServiceDrillDown([serviceName])}
                      onPeriodArchived={(newPeriodId) => setActivePeriodId(newPeriodId)}
                    />
                  ) : awsSubTab === 'resources' ? (
                    <AwsResourcesTab companyId={effectiveCompanyId} />
                  ) : (
                    <AwsIamUsersTab companyId={effectiveCompanyId} />
                  )}
                </div>
              )}
              {activeTab === 'azure' && (
                <div className={styles.cloudSubTabs}>
                  <Tabs
                    value={azureSubTab}
                    onValueChange={(value) => setAzureSubTab(value as 'overview' | 'resources' | 'users')}
                  >
                    <TabsList>
                      <TabsTrigger value="overview">Overview</TabsTrigger>
                      <TabsTrigger value="resources">Resources</TabsTrigger>
                      <TabsTrigger value="users">Users</TabsTrigger>
                    </TabsList>
                  </Tabs>
                  {azureSubTab === 'overview' ? (
                    <CostReportTab
                      companyId={effectiveCompanyId}
                      cloudProvider="azure"
                      periodId={periodIdForReports}
                      isReadOnly={viewingArchivedPeriod}
                      onServiceClick={(serviceName) => handleServiceDrillDown([serviceName])}
                      onPeriodArchived={(newPeriodId) => setActivePeriodId(newPeriodId)}
                    />
                  ) : azureSubTab === 'resources' ? (
                    <AzureResourcesTab companyId={effectiveCompanyId} />
                  ) : (
                    <AzureUsersTab companyId={effectiveCompanyId} />
                  )}
                </div>
              )}
              {activeTab === 'gcp' && (
                <CostReportTab
                  companyId={effectiveCompanyId}
                  cloudProvider="gcp"
                  periodId={periodIdForReports}
                  isReadOnly={viewingArchivedPeriod}
                  onServiceClick={(serviceName) => handleServiceDrillDown([serviceName])}
                />
              )}
              {activeTab === 'snowflake' && (
                <CostReportTab
                  companyId={effectiveCompanyId}
                  cloudProvider="snowflake"
                  periodId={periodIdForReports}
                  isReadOnly={viewingArchivedPeriod}
                  onServiceClick={(serviceName) => handleServiceDrillDown([serviceName])}
                />
              )}
              {activeTab === 'compare' && (
                <CompareTab
                  companyId={effectiveCompanyId}
                  periodId={periodIdForReports}
                  onCategoryClick={handleServiceDrillDown}
                />
              )}
              {activeTab === 'lineItems' && (
                <LineItemsTab
                  key={JSON.stringify(lineItemsFilter)}
                  companyId={effectiveCompanyId}
                  periodId={periodIdForReports}
                  initialServiceFilter={lineItemsFilter}
                />
              )}
              {activeTab === 'files' && (
                <UploadedFilesList
                  companyId={effectiveCompanyId}
                  periodId={periodIdForReports}
                  isReadOnly={viewingArchivedPeriod}
                />
              )}
              {activeTab === 'notes' && (
                <NotesFeed
                  companyId={effectiveCompanyId}
                  userId={userId}
                  isStaff={canManage}
                  periodId={periodIdForReports}
                  isReadOnly={viewingArchivedPeriod}
                />
              )}
          </div>
        )}
      </div>
    </div>
  );
}
