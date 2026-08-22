'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { createClient } from '@/lib/supabase/client';
import type { Company, ProfileRole } from '@/lib/types';
import UploadedFilesList from '../files/UploadedFilesList';
import CostReportTab from '../reports/CostReportTab';
import CompareTab from '../reports/CompareTab';
import LineItemsTab from '../reports/LineItemsTab';
import TrendSidebar from '../reports/TrendSidebar';
import NotesFeed from '../notes/NotesFeed';
import AdminCompanies from '../admin/AdminCompanies';
import AdminUsers from '../admin/AdminUsers';
import ArchiveTab from './ArchiveTab';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Button } from '@/components/ui/button';
import ThemeToggle from './ThemeToggle';
import styles from './AppShell.module.css';

type TabKey = 'aws' | 'azure' | 'compare' | 'lineItems' | 'files' | 'notes' | 'archive' | 'admin';

const REPORT_TABS: TabKey[] = ['aws', 'azure', 'compare', 'lineItems'];

interface AppShellProps {
  userId: string;
  role: ProfileRole;
  companyId: string | null;
}

export default function AppShell({ userId, role, companyId }: AppShellProps) {
  const [activeTab, setActiveTab] = useState<TabKey>('aws');
  const [companies, setCompanies] = useState<Company[]>([]);
  const [selectedCompanyId, setSelectedCompanyId] = useState<string | null>(companyId);
  const [activePeriodId, setActivePeriodId] = useState<string | null>(null);
  const [viewingPeriodId, setViewingPeriodId] = useState<string | null>(null);
  const [lineItemsFilter, setLineItemsFilter] = useState<string[] | undefined>(undefined);
  const router = useRouter();

  useEffect(() => {
    if (role !== 'staff') return;

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

  const effectiveCompanyId = role === 'staff' ? selectedCompanyId : companyId;

  // Switching companies always resets back to that company's active period —
  // never carries over "viewing an archived period" from the previous company.
  useEffect(() => {
    let cancelled = false;

    async function loadActivePeriod() {
      setViewingPeriodId(null);
      setActivePeriodId(null);
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

    const response = await fetch('/api/periods/archive', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ companyId: effectiveCompanyId }),
    });
    if (response.ok) {
      const body = await response.json();
      setActivePeriodId(body.newPeriodId);
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
        <h1>Cloud Cost Review Portal</h1>
        {role === 'staff' && (
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
        {!viewingArchivedPeriod && activePeriodId && (
          <Button type="button" variant="outline" size="sm" onClick={handleArchive}>
            Archive this period
          </Button>
        )}
        <Button type="button" variant="outline" size="sm" onClick={handleSignOut}>
          Sign out
        </Button>
        <ThemeToggle />
      </div>

      <Tabs value={activeTab} onValueChange={(value) => setActiveTab(value as TabKey)} className={`mb-6 print-hidden`}>
        <TabsList>
          <TabsTrigger value="aws">AWS</TabsTrigger>
          <TabsTrigger value="azure">Azure</TabsTrigger>
          <TabsTrigger value="compare">Compare</TabsTrigger>
          <TabsTrigger value="lineItems">Line Items</TabsTrigger>
          <TabsTrigger value="files">Uploaded Files</TabsTrigger>
          <TabsTrigger value="notes">Notes & Follow-ups</TabsTrigger>
          <TabsTrigger value="archive">Archive</TabsTrigger>
          {role === 'staff' && <TabsTrigger value="admin">Admin</TabsTrigger>}
        </TabsList>
      </Tabs>

      {viewingArchivedPeriod && (
        <div className={styles.archiveBanner}>
          <span>Viewing archived period</span>
          <button type="button" onClick={() => setViewingPeriodId(null)}>
            Back to current
          </button>
        </div>
      )}

      <div className={styles.panel}>
        {activeTab === 'admin' && role === 'staff' ? (
          <div className={styles.adminSections}>
            <AdminCompanies />
            <AdminUsers />
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
        ) : !effectiveCompanyId ? (
          <p>Select a company to view its data.</p>
        ) : !periodIdForReports ? (
          <p>Loading…</p>
        ) : (
          <div className={REPORT_TABS.includes(activeTab) ? styles.reportLayout : undefined}>
            {REPORT_TABS.includes(activeTab) && (
              <TrendSidebar key={effectiveCompanyId} companyId={effectiveCompanyId} />
            )}
            <div className={styles.reportContent}>
              {activeTab === 'aws' && (
                <CostReportTab
                  companyId={effectiveCompanyId}
                  cloudProvider="aws"
                  periodId={periodIdForReports}
                  onServiceClick={(serviceName) => handleServiceDrillDown([serviceName])}
                />
              )}
              {activeTab === 'azure' && (
                <CostReportTab
                  companyId={effectiveCompanyId}
                  cloudProvider="azure"
                  periodId={periodIdForReports}
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
                  isStaff={role === 'staff'}
                  periodId={periodIdForReports}
                  isReadOnly={viewingArchivedPeriod}
                />
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
