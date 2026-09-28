import type { Metadata } from 'next';
import Link from 'next/link';
import type { ReactNode } from 'react';
import './globals.css';
import { AuthShell, UserMenu } from '@/lib/auth-shell';

export const metadata: Metadata = {
  title: 'Storyframe — one line to a finished video',
  description:
    'Type a one-line story idea and get a fully produced short video: script, characters, animation, voice, music and subtitles.',
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body className="min-h-screen">
        <AuthShell>
          <header className="border-b" style={{ borderColor: 'var(--border)' }}>
            <div className="mx-auto flex max-w-5xl items-center justify-between px-4 py-4">
              <Link href="/" className="text-lg font-bold tracking-tight">
                <span style={{ color: 'var(--accent)' }}>▶</span> Storyframe
              </Link>
              <nav className="flex items-center gap-4 text-sm" style={{ color: 'var(--muted)' }}>
                <Link href="/jobs">My videos</Link>
                <Link href="/billing">Plan & credits</Link>
                <Link href="/account">Account</Link>
                <Link href="/new" className="btn" style={{ padding: '0.4rem 0.8rem' }}>
                  New video
                </Link>
                <UserMenu />
              </nav>
            </div>
          </header>
          <main className="mx-auto max-w-5xl px-4 py-8">{children}</main>
          <footer className="border-t" style={{ borderColor: 'var(--border)' }}>
            <div
              className="mx-auto flex max-w-5xl flex-wrap gap-4 px-4 py-6 text-xs"
              style={{ color: 'var(--muted)' }}
            >
              <span>© {new Date().getFullYear()} Storyframe</span>
              <Link href="/legal/terms">Terms</Link>
              <Link href="/legal/privacy">Privacy</Link>
              <Link href="/legal/subprocessors">Sub-processors</Link>
              <Link href="/account">Your data</Link>
            </div>
          </footer>
        </AuthShell>
      </body>
    </html>
  );
}
