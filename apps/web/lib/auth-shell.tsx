'use client';

import dynamic from 'next/dynamic';
import type { ReactNode } from 'react';
import { DevAuthProvider, clerkEnabled } from './auth';

// The Clerk SDK throws at module evaluation without a publishable key, and Next's server
// bundle evaluates client-component references eagerly. Loading it client-side only, and only
// when a key is configured, keeps the app buildable and runnable without Clerk (DEV_AUTH mode).
const ClerkAuthProvider = dynamic(() => import('./clerk-auth').then((m) => m.ClerkAuthProvider), {
  ssr: false,
});
const ClerkUserMenu = dynamic(() => import('./clerk-auth').then((m) => m.ClerkUserMenu), {
  ssr: false,
});

export function AuthShell({ children }: { children: ReactNode }) {
  if (clerkEnabled) return <ClerkAuthProvider>{children}</ClerkAuthProvider>;
  return <DevAuthProvider>{children}</DevAuthProvider>;
}

export function UserMenu() {
  if (clerkEnabled) return <ClerkUserMenu />;
  return <span className="badge">dev workspace</span>;
}
