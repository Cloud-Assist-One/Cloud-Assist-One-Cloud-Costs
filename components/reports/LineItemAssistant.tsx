'use client';

import { useState, type FormEvent } from 'react';
import type { AssistantFilters } from '@/lib/assistantFilters';
import styles from './LineItemAssistant.module.css';

interface LineItemAssistantProps {
  companyId: string;
  /** Applied to the tab, which then shows exactly what was set. */
  onFilters: (filters: AssistantFilters) => void;
}

/** Human-readable summary of what the assistant actually applied. */
function describe(filters: AssistantFilters): string {
  const parts: string[] = [];
  if (filters.searchText) parts.push(`matching “${filters.searchText}”`);
  if (filters.cloudProvider) parts.push(filters.cloudProvider.toUpperCase());
  if (filters.serviceNames?.length) parts.push(filters.serviceNames.join(', '));
  if (filters.billingCode) parts.push(`billing code ${filters.billingCode}`);
  if (filters.accountId) parts.push(`account ${filters.accountId}`);
  if (filters.region) parts.push(filters.region);
  if (filters.dateFrom || filters.dateTo) {
    parts.push(`${filters.dateFrom ?? 'the start'} to ${filters.dateTo ?? 'the end'}`);
  }
  if (filters.costMin !== undefined) parts.push(`at least $${filters.costMin}`);
  if (filters.costMax !== undefined) parts.push(`at most $${filters.costMax}`);
  if (filters.excludeZeroCost) parts.push('excluding $0 lines');

  return parts.length > 0 ? `Filtered to ${parts.join(' · ')}` : 'No filter needed for that — showing everything.';
}

export default function LineItemAssistant({ companyId, onFilters }: LineItemAssistantProps) {
  const [question, setQuestion] = useState('');
  const [asking, setAsking] = useState(false);
  const [applied, setApplied] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    const asked = question.trim();
    if (!asked || asking) return;

    setAsking(true);
    setError(null);
    setApplied(null);

    try {
      const response = await fetch('/api/line-items/assistant', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ companyId, question: asked }),
      });
      const body = await response.json();

      if (!response.ok) {
        setError(body.error ?? 'The assistant could not answer that.');
        return;
      }

      onFilters(body.filters ?? {});
      // Stated rather than silently applied: the filter bar below shows every
      // field that was set, and this says it in words. An assistant that
      // changes what you are looking at without saying how is a black box.
      setApplied(describe(body.filters ?? {}));
    } catch {
      setError('Could not reach the assistant.');
    } finally {
      setAsking(false);
    }
  }

  return (
    <form className={`${styles.assistant} print-hidden`} onSubmit={handleSubmit}>
      <label className={styles.label} htmlFor="line-items-question">
        Ask
      </label>
      <input
        id="line-items-question"
        className={styles.question}
        value={question}
        onChange={(e) => setQuestion(e.target.value)}
        placeholder="What did we spend on EC2 in us-east-1 over $100?"
        disabled={asking}
      />
      <button type="submit" disabled={asking || question.trim() === ''}>
        {asking ? 'Thinking…' : 'Ask'}
      </button>

      {error && (
        <span role="alert" className={styles.error}>
          {error}
        </span>
      )}
      {applied && !error && (
        <span role="status" className={styles.applied}>
          {applied}
        </span>
      )}
    </form>
  );
}
