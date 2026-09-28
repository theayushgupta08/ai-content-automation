import { NextResponse } from 'next/server';
import { clerkMiddleware, createRouteMatcher } from '@clerk/nextjs/server';

const clerkEnabled = Boolean(process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY);
const isProtected = createRouteMatcher(['/new(.*)', '/jobs(.*)']);

// With Clerk configured, dashboard routes require a session; without it (local dev) the API's
// DEV_AUTH mode accepts anonymous requests as the dev workspace.
export default clerkEnabled
  ? clerkMiddleware(async (auth, req) => {
      if (isProtected(req)) await auth.protect();
    })
  : () => NextResponse.next();

export const config = {
  matcher: ['/((?!_next|.*\\..*).*)'],
};
