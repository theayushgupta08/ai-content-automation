'use client';

import {
  ClerkProvider,
  SignInButton,
  SignedIn,
  SignedOut,
  UserButton,
  useAuth,
} from '@clerk/nextjs';
import { useCallback, type ReactNode } from 'react';
import { AuthContext } from './auth';

function ClerkHeadersBridge({ children }: { children: ReactNode }) {
  const { getToken } = useAuth();
  const getHeaders = useCallback(async (): Promise<Record<string, string>> => {
    const token = await getToken();
    return token ? { Authorization: `Bearer ${token}` } : {};
  }, [getToken]);
  return <AuthContext.Provider value={{ getHeaders }}>{children}</AuthContext.Provider>;
}

/** Wraps the app in Clerk when NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY is set. */
export function ClerkAuthProvider({ children }: { children: ReactNode }) {
  return (
    <ClerkProvider>
      <ClerkHeadersBridge>{children}</ClerkHeadersBridge>
    </ClerkProvider>
  );
}

export function ClerkUserMenu() {
  return (
    <>
      <SignedOut>
        <SignInButton mode="modal">
          <button className="btn btn-ghost">Sign in</button>
        </SignInButton>
      </SignedOut>
      <SignedIn>
        <UserButton />
      </SignedIn>
    </>
  );
}
