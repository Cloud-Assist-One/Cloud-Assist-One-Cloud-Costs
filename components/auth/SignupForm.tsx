'use client';

import { useState, FormEvent } from 'react';
import Image from 'next/image';
import MarketingHeader from './MarketingHeader';
import styles from './SignupForm.module.css';

export default function SignupForm() {
  const [email, setEmail] = useState('');
  const [companyName, setCompanyName] = useState('');
  const [firstName, setFirstName] = useState('');
  const [lastName, setLastName] = useState('');
  const [phone, setPhone] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [submitted, setSubmitted] = useState(false);

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    setError(null);

    // Client-side check is a courtesy — the API validates and trims again,
    // since this route has no auth guard in front of it.
    if (!email.trim() || !companyName.trim() || !firstName.trim() || !lastName.trim()) {
      setError('Email, company name, first name, and last name are required.');
      return;
    }

    setSubmitting(true);
    const response = await fetch('/api/signup', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email: email.trim(),
        companyName: companyName.trim(),
        firstName: firstName.trim(),
        lastName: lastName.trim(),
        phone: phone.trim(),
      }),
    });
    const body = await response.json();
    setSubmitting(false);

    if (!response.ok) {
      setError(body.error ?? 'Could not create your account. Please try again.');
      return;
    }

    setSubmitted(true);
  }

  if (submitted) {
    return (
      <div className={styles.page}>
        <MarketingHeader />
        <div className={styles.wrapper}>
          <div className={styles.form}>
            <Image
              src="/cao-logo.png"
              alt="Cloud Assist One"
              width={925}
              height={875}
              className={styles.logo}
              priority
            />
            <p role="status" className={styles.status}>
              Check your email — we&apos;ve sent a sign-in link to {email}. Click it to verify your address and get
              started.
            </p>
          </div>
        </div>
      </div>
    );
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
            alt="Cloud Assist One"
            width={925}
            height={875}
            className={styles.logo}
            priority
          />

          <label htmlFor="signup-email">Email</label>
          <input
            id="signup-email"
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            required
          />

          <label htmlFor="signup-company-name">Company name</label>
          <input
            id="signup-company-name"
            value={companyName}
            onChange={(e) => setCompanyName(e.target.value)}
            required
          />

          <label htmlFor="signup-first-name">First name</label>
          <input
            id="signup-first-name"
            value={firstName}
            onChange={(e) => setFirstName(e.target.value)}
            required
          />

          <label htmlFor="signup-last-name">Last name</label>
          <input
            id="signup-last-name"
            value={lastName}
            onChange={(e) => setLastName(e.target.value)}
            required
          />

          <label htmlFor="signup-phone">Phone number (optional)</label>
          <input id="signup-phone" type="tel" value={phone} onChange={(e) => setPhone(e.target.value)} />

          {error && (
            <p role="alert" className={styles.error}>
              {error}
            </p>
          )}

          <button type="submit" className={styles.submit} disabled={submitting}>
            {submitting ? 'Creating your account…' : 'Create free account'}
          </button>
        </form>
      </div>
    </div>
  );
}
