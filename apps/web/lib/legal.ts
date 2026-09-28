/**
 * Legal identity used by the terms, privacy and sub-processor pages. Set the public env vars
 * per environment; the defaults are placeholders. These pages are a starting draft and must
 * be reviewed by counsel before launch.
 */
export const LEGAL = {
  company: process.env.NEXT_PUBLIC_COMPANY_NAME ?? 'Storyframe',
  product: 'Storyframe',
  address: process.env.NEXT_PUBLIC_COMPANY_ADDRESS ?? '[registered address]',
  jurisdiction: process.env.NEXT_PUBLIC_LEGAL_JURISDICTION ?? '[governing law and venue]',
  legalEmail: process.env.NEXT_PUBLIC_LEGAL_EMAIL ?? 'legal@example.com',
  privacyEmail: process.env.NEXT_PUBLIC_PRIVACY_EMAIL ?? 'privacy@example.com',
  supportEmail: process.env.NEXT_PUBLIC_SUPPORT_EMAIL ?? 'support@example.com',
  effectiveDate: 'September 28, 2026',
  deletionGraceDays: 7,
};
