import type { Metadata } from 'next';
import { LEGAL } from '@/lib/legal';

export const metadata: Metadata = { title: `Sub-processors — ${LEGAL.product}` };

const ROWS: Array<[string, string, string, string]> = [
  [
    'Clerk, Inc.',
    'Authentication and user accounts',
    'Name, email, sign-in metadata',
    'United States',
  ],
  [
    'Stripe, Inc.',
    'Payments, invoices, subscription management',
    'Name, email, billing details, card data (held by Stripe only)',
    'United States',
  ],
  [
    'Amazon Web Services, Inc.',
    'Hosting, databases, media storage',
    'All service data, encrypted at rest',
    'United States',
  ],
  [
    'Cloudflare, Inc.',
    'DNS, CDN and edge security',
    'IP addresses, request metadata',
    'Global edge',
  ],
  [
    'Temporal Technologies, Inc.',
    'Workflow orchestration (Temporal Cloud)',
    'Job identifiers and pipeline state; no media',
    'United States',
  ],
  [
    'Anthropic, PBC',
    'Story engine: script writing, scene breakdown, moderation',
    'Story ideas, character descriptions, generated scripts',
    'United States',
  ],
  [
    'fal.ai (Features and Labels, Inc.)',
    'Image and video generation, hosting models by Black Forest Labs (Flux), Kuaishou (Kling), Alibaba (Wan) and MiniMax',
    'Scene prompts, character reference images, keyframes',
    'United States',
  ],
  [
    'ElevenLabs, Inc.',
    'Speech synthesis, sound effects and music generation',
    'Script lines and sound descriptions',
    'United States',
  ],
  ['Resend, Inc.', 'Transactional email delivery', 'Email address, email content', 'United States'],
];

export default function SubprocessorsPage() {
  return (
    <>
      <h1>Sub-processors</h1>
      <p className="meta">Updated {LEGAL.effectiveDate}</p>
      <p>
        {LEGAL.company} uses the following third parties to process customer data on its behalf.
        Each is bound by a data-processing agreement, receives only the data its function needs, and
        may not use it for its own purposes. Generation providers receive prompts and intermediate
        media for the duration of a request; none of them are permitted to train on your content
        under our agreements.
      </p>
      <table>
        <thead>
          <tr>
            <th>Provider</th>
            <th>Purpose</th>
            <th>Data processed</th>
            <th>Location</th>
          </tr>
        </thead>
        <tbody>
          {ROWS.map(([name, purpose, data, location]) => (
            <tr key={name}>
              <td>{name}</td>
              <td>{purpose}</td>
              <td>{data}</td>
              <td>{location}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <p>
        We add or replace providers only after a security and privacy review, and announce changes
        to this list by email at least 14 days in advance to workspace owners who have asked to be
        notified at <a href={`mailto:${LEGAL.privacyEmail}`}>{LEGAL.privacyEmail}</a>.
      </p>
    </>
  );
}
