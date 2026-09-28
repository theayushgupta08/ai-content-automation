import Link from 'next/link';
import type { ReactNode } from 'react';

const PAGES = [
  ['/legal/terms', 'Terms of Service'],
  ['/legal/privacy', 'Privacy Policy'],
  ['/legal/subprocessors', 'Sub-processors'],
];

export default function LegalLayout({ children }: { children: ReactNode }) {
  return (
    <div className="grid gap-8 md:grid-cols-[180px_1fr]">
      <nav className="flex gap-3 text-sm md:flex-col" style={{ color: 'var(--muted)' }}>
        {PAGES.map(([href, label]) => (
          <Link key={href} href={href}>
            {label}
          </Link>
        ))}
      </nav>
      <article className="legal max-w-3xl">{children}</article>
    </div>
  );
}
