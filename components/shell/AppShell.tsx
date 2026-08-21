'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { createClient } from '@/lib/supabase/client';
import type { Company, ProfileRole } from '@/lib/types';
import UploadedFilesList from '../files/UploadedFilesList';
import CostReportTab from '../reports/CostReportTab';
import CompareTab from '../reports/CompareTab';
import NotesFeed from '../notes/NotesFeed';
import AdminCompanies from '../admin/AdminCompanies';
import AdminUsers from '../admin/AdminUsers';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Button } from '@/components/ui/button';
import ThemeToggle from './ThemeToggle';
import styles from './AppShell.module.css';

type TabKey = 'aws' | 'azure' | 'compare' | 'files' | 'notes' | 'admin';

interface AppShellProps {
  userId: string;
  role: ProfileRole;
  companyId: string | null;
}

export default function AppShell({ userId, role, companyId }: AppShellProps) {
  const [activeTab, setActiveTab] = useState<TabKey>('aws');
  const [companies, setCompanies] = useState<Company[]>([]);
  const [selectedCompanyId, setSelectedCompanyId] = useState<string | null>(companyId);
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

  async function handleSignOut() {
    const supabase = createClient();
    await supabase.auth.signOut();
    router.refresh();
  }

  const effectiveCompanyId = role === 'staff' ? selectedCompanyId : companyId;

  return (
    <div className={styles.wrapper}>
      <div className={styles.topBar}>
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
        <Button type="button" variant="outline" size="sm" onClick={handleSignOut}>
          Sign out
        </Button>
        <ThemeToggle />
      </div>

      <Tabs value={activeTab} onValueChange={(value) => setActiveTab(value as TabKey)}>
        <TabsList>
          <TabsTrigger value="aws">AWS</TabsTrigger>
          <TabsTrigger value="azure">Azure</TabsTrigger>
          <TabsTrigger value="compare">Compare</TabsTrigger>
          <TabsTrigger value="files">Uploaded Files</TabsTrigger>
          <TabsTrigger value="notes">Notes & Follow-ups</TabsTrigger>
          {role === 'staff' && <TabsTrigger value="admin">Admin</TabsTrigger>}
        </TabsList>
      </Tabs>

      <div className={styles.panel}>
        {activeTab === 'admin' && role === 'staff' ? (
          <div className={styles.adminSections}>
            <AdminCompanies />
            <AdminUsers />
          </div>
        ) : !effectiveCompanyId ? (
          <p>Select a company to view its data.</p>
        ) : (
          <>
            {activeTab === 'aws' && <CostReportTab companyId={effectiveCompanyId} cloudProvider="aws" />}
            {activeTab === 'azure' && <CostReportTab companyId={effectiveCompanyId} cloudProvider="azure" />}
            {activeTab === 'compare' && <CompareTab companyId={effectiveCompanyId} />}
            {activeTab === 'files' && <UploadedFilesList companyId={effectiveCompanyId} />}
            {activeTab === 'notes' && (
              <NotesFeed companyId={effectiveCompanyId} userId={userId} isStaff={role === 'staff'} />
            )}
          </>
        )}
      </div>
    </div>
  );
}
