import Image from 'next/image';
import styles from './MarketingHeader.module.css';

const MARKETING_SITE = 'https://cloud-assist-one-cloud.vercel.app';

// The portal has no marketing pages of its own, so every link here points back
// at the main site. No "Login" entry: this header only appears on the login
// page, where that link would lead nowhere.
const LINKS = [
  { label: 'Services', href: `${MARKETING_SITE}/#services` },
  { label: 'Why Us', href: `${MARKETING_SITE}/#why-us` },
  { label: 'Process', href: `${MARKETING_SITE}/process.html` },
  { label: 'Clients', href: `${MARKETING_SITE}/clients.html` },
  { label: 'Contact', href: `${MARKETING_SITE}/contact.html` },
];

export default function MarketingHeader() {
  return (
    <header className={styles.header}>
      <div className={styles.nav}>
        <a className={styles.brand} href={MARKETING_SITE}>
          <Image src="/cao-logo.png" alt="Cloud Assist One" width={925} height={875} className={styles.brandLogo} />
          <span className={styles.brandName}>Cloud Assist One</span>
        </a>
        <nav className={styles.links}>
          {LINKS.map((link) => (
            <a key={link.label} className={styles.link} href={link.href}>
              {link.label}
            </a>
          ))}
          {/* Points at the marketing site's contact form, which replaced the
              mailto CTA there -- this header mirrors that site's nav, so it
              must not be the last place still opening a mail client. */}
          <a className={styles.cta} href={`${MARKETING_SITE}/contact.html`}>
            Get Started
          </a>
        </nav>
      </div>
    </header>
  );
}
