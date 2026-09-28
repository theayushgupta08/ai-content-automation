import type { Metadata } from 'next';
import Link from 'next/link';
import { LEGAL } from '@/lib/legal';

export const metadata: Metadata = { title: `Privacy Policy — ${LEGAL.product}` };

export default function PrivacyPage() {
  const { company, product } = LEGAL;
  return (
    <>
      <h1>Privacy Policy</h1>
      <p className="meta">Effective {LEGAL.effectiveDate}</p>
      <p>
        This policy explains what {company} collects when you use {product}, why, who we share it
        with, and the choices you have. It applies to the website, dashboard and API.
      </p>

      <h2>1. What we collect</h2>
      <table>
        <thead>
          <tr>
            <th>Category</th>
            <th>Examples</th>
            <th>Source</th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <td>Account</td>
            <td>Name, email address, sign-in identifiers</td>
            <td>You, via our sign-in provider (Clerk)</td>
          </tr>
          <tr>
            <td>Content</td>
            <td>Story ideas, character descriptions, generated scripts, images, audio, videos</td>
            <td>You, and the models that process your inputs</td>
          </tr>
          <tr>
            <td>Billing</td>
            <td>Plan, credit balance and ledger, invoices, last four digits of your card</td>
            <td>You and Stripe (we never see full card numbers)</td>
          </tr>
          <tr>
            <td>Usage and device</td>
            <td>Job metadata, timestamps, IP address, browser, request logs, error reports</td>
            <td>Automatically, when you use the service</td>
          </tr>
          <tr>
            <td>Communications</td>
            <td>Support emails, lifecycle emails we sent you and whether they were delivered</td>
            <td>You and our email provider</td>
          </tr>
        </tbody>
      </table>

      <h2>2. Why we use it</h2>
      <ul>
        <li>
          <strong>To provide the service</strong> (contract): generating your videos, storing them
          so you can download them, billing, support.
        </li>
        <li>
          <strong>Safety and abuse prevention</strong> (legitimate interest and legal obligation):
          automated moderation of inputs and outputs, rate limiting, fraud checks.
        </li>
        <li>
          <strong>Service emails</strong> (contract): welcome, video ready, low credits, renewal and
          payment notices. We do not send marketing email without consent.
        </li>
        <li>
          <strong>Improvement</strong> (legitimate interest): aggregated statistics on quality, cost
          and reliability. We do not train generative models on your content without your explicit
          opt-in.
        </li>
        <li>
          <strong>Legal</strong>: complying with law, enforcing our terms, defending claims.
        </li>
      </ul>

      <h2>3. Who we share it with</h2>
      <p>
        We use a small number of providers to run the service. Each processes only what its role
        requires under a data-processing agreement. The current list, with what each receives, is on
        the <Link href="/legal/subprocessors">sub-processors page</Link>. We also disclose data when
        required by law or to protect rights, safety or the integrity of the service. We do not sell
        personal data.
      </p>

      <h2>4. International transfers</h2>
      <p>
        Our infrastructure runs in the United States, and some providers process data in other
        countries. Where data leaves the EEA, UK or Switzerland we rely on adequacy decisions or
        standard contractual clauses with the recipient.
      </p>

      <h2>5. Retention</h2>
      <ul>
        <li>Content and job history: for as long as your account exists.</li>
        <li>
          Deleted accounts: everything is erased {LEGAL.deletionGraceDays} days after you confirm
          deletion (the undo window), and removed from backups within 30 days after that. Model
          providers hold prompts transiently and per their own retention terms.
        </li>
        <li>Billing records: as long as tax and accounting law requires (typically 7 years).</li>
        <li>Request logs: 30 days; security logs up to 12 months.</li>
      </ul>

      <h2>6. Your rights</h2>
      <p>
        Depending on where you live you may have the right to access, correct, export, delete or
        restrict processing of your personal data, to object to processing based on legitimate
        interest, and to complain to a supervisory authority. Two of these are self-service in the
        dashboard:
      </p>
      <ul>
        <li>
          <Link href="/account">Export your data</Link>: a JSON file with every record we hold and
          links to every media file.
        </li>
        <li>
          <Link href="/account">Delete your account</Link>: schedules a full deletion with a{' '}
          {LEGAL.deletionGraceDays}-day undo window.
        </li>
      </ul>
      <p>
        For anything else, email <a href={`mailto:${LEGAL.privacyEmail}`}>{LEGAL.privacyEmail}</a>.
        We respond within 30 days and may ask you to verify your identity.
      </p>

      <h2>7. Security</h2>
      <p>
        Data is encrypted in transit and at rest. Access to production is limited to staff who need
        it, protected by multi-factor authentication, and logged. Media downloads use expiring
        signed links. We test our defences regularly and will notify you and the relevant
        authorities of a breach as the law requires.
      </p>

      <h2>8. Cookies</h2>
      <p>
        The dashboard uses strictly necessary cookies for sign-in sessions and security. We do not
        use advertising cookies or third-party trackers.
      </p>

      <h2>9. Children</h2>
      <p>
        The service is for adults. We do not knowingly collect data from anyone under 18; if you
        believe a minor has an account, contact us and we will delete it.
      </p>

      <h2>10. Changes</h2>
      <p>
        We will announce material changes by email or in the dashboard before they take effect, and
        keep prior versions available on request.
      </p>

      <h2>11. Contact</h2>
      <p>
        {company}, {LEGAL.address}. Privacy questions and requests:{' '}
        <a href={`mailto:${LEGAL.privacyEmail}`}>{LEGAL.privacyEmail}</a>.
      </p>
    </>
  );
}
