'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { createClient } from '@/lib/supabase/client';
import type { Company, ProfileRole } from '@/lib/types';
import UploadedFilesList from '../files/UploadedFilesList';
import CostReportTab from '../reports/CostReportTab';
import CompareTab from '../reports/CompareTab';
import styles from './AppShell.module.css';

type TabKey = 'aws' | 'azure' | 'compare' | 'files';

interface AppShellProps {
  userId: string;
  role: ProfileRole;
  companyId: string | null;
}

export default function AppShell({ role, companyId }: AppShellProps) {
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
        <button type="button" className={styles.signOut} onClick={handleSignOut}>
          Sign out
        </button>
      </div>

      <div className={styles.tabList} role="tablist">
        <button type="button" role="tab" aria-selected={activeTab === 'aws'} onClick={() => setActiveTab('aws')}>
          AWS
        </button>
        <button type="button" role="tab" aria-selected={activeTab === 'azure'} onClick={() => setActiveTab('azure')}>
          Azure
        </button>
        <button type="button" role="tab" aria-selected={activeTab === 'compare'} onClick={() => setActiveTab('compare')}>
          Compare
        </button>
        <button type="button" role="tab" aria-selected={activeTab === 'files'} onClick={() => setActiveTab('files')}>
          Uploaded Files
        </button>
      </div>

      <div className={styles.panel}>
        {!effectiveCompanyId ? (
          <p>Select a company to view its data.</p>
        ) : (
          <>
            {activeTab === 'aws' && <CostReportTab companyId={effectiveCompanyId} cloudProvider="aws" />}
            {activeTab === 'azure' && <CostReportTab companyId={effectiveCompanyId} cloudProvider="azure" />}
            {activeTab === 'compare' && <CompareTab companyId={effectiveCompanyId} />}
            {activeTab === 'files' && <UploadedFilesList companyId={effectiveCompanyId} />}
          </>
        )}
      </div>
    </div>
  );
}
