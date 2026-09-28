import * as t from './templates';

describe('mail templates', () => {
  it('escapes user-supplied text in html but not in text', () => {
    const r = t.videoReady({
      title: '<script>alert(1)</script> & "quotes"',
      jobUrl: 'https://app.example.com/jobs/1',
      durationSec: 61,
      credits: 25,
      first: false,
    });
    expect(r.html).not.toContain('<script>');
    expect(r.html).toContain('&lt;script&gt;');
    expect(r.html).toContain('&amp; &quot;quotes&quot;');
    expect(r.text).toContain('<script>alert(1)</script>');
    expect(r.subject).toContain('"<script>alert(1)</script> & "quotes"" is ready');
    expect(r.html).toContain('1 min 1 s');
    expect(r.html).toContain('25 credits');
  });

  it('marks the first video differently', () => {
    const first = t.videoReady({ title: 'A', jobUrl: 'u', first: true });
    const later = t.videoReady({ title: 'A', jobUrl: 'u', first: false });
    expect(first.subject).toMatch(/first/i);
    expect(later.subject).not.toMatch(/first/i);
  });

  it('welcome mentions trial credits and links to /new', () => {
    const r = t.welcome({ name: 'Mara', webUrl: 'https://app.example.com', trialCredits: 60 });
    expect(r.html).toContain('Hi Mara,');
    expect(r.html).toContain('60 free credits');
    expect(r.html).toContain('https://app.example.com/new');
    expect(r.text).toContain('https://app.example.com/new');
  });

  it('formats money and dates for renewals', () => {
    const r = t.renewalUpcoming({
      planName: 'Creator',
      amountMinor: 4900,
      currency: 'usd',
      renewsAt: new Date('2026-10-15T00:00:00Z'),
      billingUrl: 'https://app.example.com/billing',
    });
    expect(r.subject).toContain('October 15, 2026');
    expect(r.html).toContain('$49.00');
    expect(r.text).toContain('$49.00');
  });

  it('explains refunds on failure', () => {
    const refunded = t.videoFailed({ title: 'X', jobUrl: 'u', reason: null, refunded: true });
    const partial = t.videoFailed({ title: 'X', jobUrl: 'u', reason: 'blocked', refunded: false });
    expect(refunded.text).toContain('returned to your balance');
    expect(partial.text).toContain('only charged');
    expect(partial.html).toContain(': blocked');
  });

  it('every template has subject, html and text', () => {
    const all = [
      t.welcome({ webUrl: 'u', trialCredits: 1 }),
      t.videoReady({ jobUrl: 'u', first: true }),
      t.videoFailed({ jobUrl: 'u', refunded: true }),
      t.lowCredits({ available: 3, planName: 'Free', billingUrl: 'u' }),
      t.renewalUpcoming({
        planName: 'P',
        amountMinor: 1,
        currency: 'eur',
        renewsAt: new Date(),
        billingUrl: 'u',
      }),
      t.paymentFailed({ planName: 'P', amountMinor: 1, currency: 'gbp', billingUrl: 'u' }),
    ];
    for (const r of all) {
      expect(r.subject.length).toBeGreaterThan(5);
      expect(r.html).toContain('<!doctype html>');
      expect(r.text.trim().length).toBeGreaterThan(20);
    }
  });
});
