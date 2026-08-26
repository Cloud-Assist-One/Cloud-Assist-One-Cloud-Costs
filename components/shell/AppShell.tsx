'use client';

import { useEffect, useState, useSyncExternalStore } from 'react';
import Image from 'next/image';
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
import AdminUserEmails from '../admin/AdminUserEmails';
import ArchiveTab from './ArchiveTab';
import SupportTab from '../support/SupportTab';
import SupportRequestsTab from '../support/SupportRequestsTab';
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
  | 'support'
  | 'archive'
  | 'settings'
  | 'supportRequests'
  | 'admin';

// The "Archive this period" action only makes sense while looking at one of
// the single-cloud-provider report tabs, not Compare/Line Items/Files/etc.
const SINGLE_PROVIDER_TABS: TabKey[] = ['aws', 'azure', 'gcp', 'snowflake'];

// A sentinel company-switcher value rather than a real company id: picking it
// puts staff/admin in the admin tools instead of mirroring a client's portal.
// It can never collide with a company, since companies are keyed by uuid.
const ADMIN_PORTAL = '__admin_portal__';

// The only tabs that exist in the admin portal. Everything else on the tab
// strip is a view of one company's data and has no meaning without one.
const ADMIN_TABS: TabKey[] = ['supportRequests', 'admin'];

function greetingFor(hour: number): string {
  if (hour < 12) return 'Good morning';
  if (hour < 18) return 'Good afternoon';
  return 'Good evening';
}

// The greeting depends on the viewer's own clock, which the server can't
// know. useSyncExternalStore is how React models exactly that: the server
// snapshot is null (rendering no greeting), and the client swaps in the real
// one on hydration without a cascading extra render.
const subscribeToClock = () => () => {};
const readLocalGreeting = () => greetingFor(new Date().getHours());
const readServerGreeting = () => null;

interface AppShellProps {
  userId: string;
  role: ProfileRole;
  companyId: string | null;
  userEmail: string;
}

export default function AppShell({ userId, role, companyId, userEmail }: AppShellProps) {
  const canManage = role === 'staff' || role === 'admin';
  // Staff and admin land in the admin portal: signing in to work on the
  // product shouldn't drop you inside some client's report.
  const [activeTab, setActiveTab] = useState<TabKey>(canManage ? 'supportRequests' : 'aws');
  const [companies, setCompanies] = useState<Company[]>([]);
  const [selectedCompanyId, setSelectedCompanyId] = useState<string | null>(
    canManage ? ADMIN_PORTAL : companyId
  );
  const [activePeriodId, setActivePeriodId] = useState<string | null>(null);
  const [viewingPeriodId, setViewingPeriodId] = useState<string | null>(null);
  const [lineItemsFilter, setLineItemsFilter] = useState<string[] | undefined>(undefined);
  const [archiveError, setArchiveError] = useState<string | null>(null);
  const [companyName, setCompanyName] = useState<string | null>(null);
  const greeting = useSyncExternalStore(subscribeToClock, readLocalGreeting, readServerGreeting);
  const [awsSubTab, setAwsSubTab] = useState<'overview' | 'resources' | 'iamUsers'>('overview');
  const [azureSubTab, setAzureSubTab] = useState<'overview' | 'resources' | 'users'>('overview');
  const [adminSubTab, setAdminSubTab] = useState<'companies' | 'users' | 'emails'>('companies');
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

  const isAdminPortal = canManage && selectedCompanyId === ADMIN_PORTAL;
  // The admin portal is deliberately company-less, so every company-scoped
  // effect and panel below sees null and skips its work.
  const effectiveCompanyId = canManage ? (isAdminPortal ? null : selectedCompanyId) : companyId;

  // Switching between the admin portal and a client's portal changes which
  // tabs exist, so the current tab has to move if it just disappeared. Done
  // here rather than in an effect: an effect would render the missing tab
  // once before correcting it.
  function handleCompanyChange(value: string) {
    setSelectedCompanyId(value);
    const toAdminPortal = value === ADMIN_PORTAL;
    setActiveTab((prev) => {
      if (toAdminPortal) return ADMIN_TABS.includes(prev) ? prev : 'supportRequests';
      return ADMIN_TABS.includes(prev) ? 'aws' : prev;
    });
  }

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

  // Staff/admin already have the company list loaded for the switcher, but a
  // client user doesn't, so look the name up either way (RLS lets a client
  // read their own company).
  useEffect(() => {
    let cancelled = false;

    async function loadCompanyName() {
      if (!effectiveCompanyId) {
        setCompanyName(null);
        return;
      }
      const known = companies.find((company) => company.id === effectiveCompanyId);
      if (known) {
        setCompanyName(known.name);
        return;
      }
      const supabase = createClient();
      const { data } = await supabase.from('companies').select('name').eq('id', effectiveCompanyId).maybeSingle();
      if (!cancelled) setCompanyName(data?.name ?? null);
    }

    loadCompanyName();
    return () => {
      cancelled = true;
    };
  }, [effectiveCompanyId, companies]);

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
    <div className={`${styles.wrapper} ${activeTab === 'lineItems' ? styles.wrapperWide : ''}`}>
      <div className={`${styles.topBar} print-hidden`}>
        <div className={styles.brand}>
          <Image
            src="/cao-logo.png"
            alt="Cloud Assist One"
            width={925}
            height={875}
            className={styles.logo}
            priority
          />
          <h1>Cloud Cost Assistant</h1>
        </div>
        {canManage && (
          <div className={styles.companySwitcher}>
            <label htmlFor="company-switcher">Viewing company</label>
            <select
              id="company-switcher"
              value={selectedCompanyId ?? ''}
              onChange={(e) => handleCompanyChange(e.target.value)}
            >
              <option value={ADMIN_PORTAL}>Admin Portal</option>
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
        <div className={styles.identity}>
          <span className={styles.greeting}>
            {greeting ? `${greeting},` : ''} {isAdminPortal ? 'Admin Portal' : companyName ?? ''}
          </span>
          <span className={styles.userEmail}>{userEmail}</span>
        </div>
        {/* Grouped so the bar wraps as whole blocks rather than stranding a
            single control on its own line. */}
        <div className={styles.controls}>
          <ThemeToggle />
          <AccentColorPicker />
          <Button type="button" variant="outline" size="sm" onClick={handleSignOut}>
            Sign out
          </Button>
        </div>
      </div>

      <Tabs value={activeTab} onValueChange={(value) => setActiveTab(value as TabKey)} className={`mb-6 print-hidden`}>
        {/* The two modes are mutually exclusive: the admin portal shows only
            admin tools, and mirroring a client's portal shows only what that
            client sees. */}
        <TabsList>
          {isAdminPortal ? (
            <>
              <TabsTrigger value="supportRequests">Support Requests</TabsTrigger>
              <TabsTrigger value="admin">Admin</TabsTrigger>
            </>
          ) : (
            <>
              <TabsTrigger value="aws">{CLOUD_PROVIDER_LABELS.aws}</TabsTrigger>
              <TabsTrigger value="azure">{CLOUD_PROVIDER_LABELS.azure}</TabsTrigger>
              <TabsTrigger value="gcp">{CLOUD_PROVIDER_LABELS.gcp}</TabsTrigger>
              <TabsTrigger value="snowflake">{CLOUD_PROVIDER_LABELS.snowflake}</TabsTrigger>
              <TabsTrigger value="compare">Compare</TabsTrigger>
              <TabsTrigger value="lineItems">Line Items</TabsTrigger>
              <TabsTrigger value="files">Uploaded Files</TabsTrigger>
              <TabsTrigger value="notes">Notes & Follow-ups</TabsTrigger>
              <TabsTrigger value="support">Support</TabsTrigger>
              <TabsTrigger value="archive">Archive</TabsTrigger>
              <TabsTrigger value="settings">Settings</TabsTrigger>
            </>
          )}
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
            <Tabs
              value={adminSubTab}
              onValueChange={(value) => setAdminSubTab(value as 'companies' | 'users' | 'emails')}
            >
              <TabsList>
                <TabsTrigger value="companies">Companies</TabsTrigger>
                <TabsTrigger value="users">Users</TabsTrigger>
                <TabsTrigger value="emails">Email Management</TabsTrigger>
              </TabsList>
            </Tabs>
            {adminSubTab === 'companies' ? (
              <AdminCompanies isAdmin={role === 'admin'} />
            ) : adminSubTab === 'users' ? (
              <AdminUsers isAdmin={role === 'admin'} />
            ) : (
              <AdminUserEmails />
            )}
          </div>
        ) : activeTab === 'supportRequests' && canManage ? (
          <SupportRequestsTab />
        ) : activeTab === 'support' ? (
          effectiveCompanyId ? (
            <SupportTab companyId={effectiveCompanyId} userEmail={userEmail} />
          ) : (
            <p>Select a company to view its data.</p>
          )
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
          <div
            className={
              activeTab === 'lineItems'
                ? styles.lineItemsContent
                : isWideCloudView
                  ? styles.resourcesContent
                  : styles.reportContent
            }
          >
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
