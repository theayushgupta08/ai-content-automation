'use client';

import { createContext, useCallback, useContext, type ReactNode } from 'react';

export const clerkEnabled = Boolean(process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY);

interface AuthContextValue {
  /** Headers to attach to API requests (bearer token when Clerk is enabled). */
  getHeaders: () => Promise<Record<string, string>>;
}

const AuthContext = createContext<AuthContextValue>({ getHeaders: async () => ({}) });

/** Dev-mode provider: the API accepts unauthenticated requests as the dev workspace. */
export function DevAuthProvider({ children }: { children: ReactNode }) {
  const getHeaders = useCallback(async () => ({}), []);
  return <AuthContext.Provider value={{ getHeaders }}>{children}</AuthContext.Provider>;
}

export function useAuthHeaders(): AuthContextValue['getHeaders'] {
  return useContext(AuthContext).getHeaders;
}

export { AuthContext };
