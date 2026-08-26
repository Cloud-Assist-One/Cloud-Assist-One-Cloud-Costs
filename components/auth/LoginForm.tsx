'use client';

import { useState, FormEvent } from 'react';
import Image from 'next/image';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { createClient } from '@/lib/supabase/client';
import MarketingHeader from './MarketingHeader';
import styles from './LoginForm.module.css';

export default function LoginForm() {
  const router = useRouter();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [resetSent, setResetSent] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    setSubmitting(true);
    setError(null);
    setResetSent(false);

    const supabase = createClient();
    const { error: signInError } = await supabase.auth.signInWithPassword({ email, password });

    setSubmitting(false);

    if (signInError) {
      setError('Invalid email or password.');
      return;
    }

    router.refresh();
  }

  async function handleResetPassword() {
    if (!email) {
      setError('Enter your email above first, then click "Forgot password?"');
      return;
    }

    setError(null);
    const supabase = createClient();
    const { error: resetError } = await supabase.auth.resetPasswordForEmail(email, {
      redirectTo: `${window.location.origin}/reset-password`,
    });

    if (resetError) {
      setError('Could not send the reset email. Please try again.');
      return;
    }

    setResetSent(true);
  }

  return (
    <div className={styles.page}>
      <MarketingHeader />
      <div className={styles.wrapper}>
        <form className={styles.form} onSubmit={handleSubmit} noValidate>
          {/* The logo carries the product name, so it replaces the heading —
              but the accessible name still has to exist for screen readers
              and for the form's own labelling. */}
          <Image
            src="/cao-logo.png"
            alt="Cloud Assist One — Cloud Cost Assistant"
            width={925}
            height={875}
            className={styles.logo}
            priority
          />

          <label htmlFor="login-email">Email</label>
          <input
            id="login-email"
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            required
          />

          <label htmlFor="login-password">Password</label>
          <input
            id="login-password"
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            required
          />

          {error && (
            <p role="alert" className={styles.error}>
              {error}
            </p>
          )}
          {resetSent && (
            <p role="status" className={styles.status}>
              Password reset email sent — check your inbox.
            </p>
          )}

          <button type="submit" className={styles.submit} disabled={submitting}>
            {submitting ? 'Signing in…' : 'Sign in'}
          </button>
          <button type="button" className={styles.linkButton} onClick={handleResetPassword}>
            Forgot password?
          </button>

          <Link href="/signup" className={styles.tryIt}>
            Try It — start a free account
          </Link>
        </form>
      </div>
    </div>
  );
}
