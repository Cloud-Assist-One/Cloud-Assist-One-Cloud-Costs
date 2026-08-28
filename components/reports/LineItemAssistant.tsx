'use client';

import { useState, type FormEvent } from 'react';
import type { AssistantFilters } from '@/lib/assistantFilters';
import styles from './LineItemAssistant.module.css';

interface LineItemAssistantProps {
  companyId: string;
  /** Applied to the tab, which then shows exactly what was set. */
  onFilters: (filters: AssistantFilters) => void;
  /**
   * Drop the filter this box applied.
   *
   * The tab owns what "no filter" means -- it opens with $0 lines hidden --
   * so clearing asks the tab to reset rather than sending an empty object and
   * silently turning that default off.
   */
  onClear: () => void;
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

export default function LineItemAssistant({ companyId, onFilters, onClear }: LineItemAssistantProps) {
  const [question, setQuestion] = useState('');
  const [asking, setAsking] = useState(false);
  const [applied, setApplied] = useState<{ key: string; value: string }[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Clearing the box undoes what the box did. Emptying the question while
  // leaving the grid filtered would strand a filter whose cause just
  // disappeared from the screen.
  function handleClear() {
    setQuestion('');
    setApplied(null);
    setError(null);
    onClear();
  }

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
    <form
      className={`${styles.assistant} ${asking ? styles.busy : ''} print-hidden`}
      onSubmit={handleSubmit}
    >
      <div className={styles.row}>
        {/* A processor, not a sparkle: this control compiles a sentence into a
            query, and the mark should say that rather than borrow the generic
            magic-wand shorthand every AI feature reaches for. */}
        <svg
          className={`${styles.icon} ${asking ? styles.thinking : ''}`}
          width="21"
          height="21"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.7"
          strokeLinecap="round"
          aria-hidden="true"
        >
          <rect x="6.5" y="6.5" width="11" height="11" rx="2.5" />
          <rect className={styles.core} x="10.5" y="10.5" width="3" height="3" rx="0.5" fill="currentColor" stroke="none" />
          <path d="M12 3v4M12 17v4M3 12h4M17 12h4" />
        </svg>
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
        {(question !== '' || applied || error) && (
          <button type="button" className={styles.clear} onClick={handleClear} disabled={asking}>
            Clear
          </button>
        )}
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
