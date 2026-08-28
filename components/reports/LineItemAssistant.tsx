'use client';

import { useState, type FormEvent } from 'react';
import type { AssistantFilters } from '@/lib/assistantFilters';
import styles from './LineItemAssistant.module.css';

interface LineItemAssistantProps {
  companyId: string;
  /** Applied to the tab, which then shows exactly what was set. */
  onFilters: (filters: AssistantFilters) => void;
}

/**
 * The filter as the tokens it compiled to.
 *
 * Field names as the grid knows them, not prose: this is the query that ran,
 * and showing it is what makes an assistant that silently changes your view
 * into one you can check.
 */
export function compiledTokens(filters: AssistantFilters): { key: string; value: string }[] {
  const tokens: { key: string; value: string }[] = [];
  const add = (key: string, value: string | number | undefined) => {
    if (value !== undefined && value !== '') tokens.push({ key, value: String(value) });
  };

  add('search', filters.searchText);
  add('provider', filters.cloudProvider);
  if (filters.serviceNames?.length) add('service', filters.serviceNames.join(' | '));
  add('billing_code', filters.billingCode);
  add('account', filters.accountId);
  add('region', filters.region);
  add('from', filters.dateFrom);
  add('to', filters.dateTo);
  add('cost >=', filters.costMin);
  add('cost <=', filters.costMax);
  if (filters.excludeZeroCost) add('cost', '!= 0');

  return tokens;
}

export default function LineItemAssistant({ companyId, onFilters }: LineItemAssistantProps) {
  const [question, setQuestion] = useState('');
  const [asking, setAsking] = useState(false);
  const [applied, setApplied] = useState<{ key: string; value: string }[] | null>(null);
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
      // Shown rather than silently applied: these are the fields that were
      // set, spelled as the grid names them. An assistant that changes what
      // you are looking at without showing how is a black box.
      setApplied(compiledTokens(body.filters ?? {}));
    } catch {
      setError('Could not reach the assistant.');
    } finally {
      setAsking(false);
    }
  }

  return (
    <form className={`${styles.assistant} print-hidden`} onSubmit={handleSubmit}>
      <div className={styles.row}>
        <span className={`${styles.marker} ${asking ? styles.thinking : ''}`} aria-hidden="true">
          &gt;_
        </span>
        <label className="sr-only" htmlFor="line-items-question">
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
        <button type="submit" className={styles.ask} disabled={asking || question.trim() === ''}>
          {asking ? 'Reading' : 'Ask'}
        </button>
      </div>

      {error && (
        <span role="alert" className={styles.error}>
          {error}
        </span>
      )}

      {applied && !error && (
        <div role="status" className={styles.tokens}>
          {applied.length > 0 ? (
            applied.map((token) => (
              <span key={token.key} className={styles.token}>
                <span className={styles.tokenKey}>{token.key}</span>
                {token.value}
              </span>
            ))
          ) : (
            <span className={styles.empty}>no filter needed — showing everything</span>
          )}
        </div>
      )}
    </form>
  );
}
