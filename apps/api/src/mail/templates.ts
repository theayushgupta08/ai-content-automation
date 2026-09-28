/**
 * Lifecycle email templates. Plain HTML with inline styles (email clients ignore most CSS)
 * plus a text alternative. Every user-supplied value is escaped.
 */

export interface Rendered {
  subject: string;
  html: string;
  text: string;
}

export const BRAND = 'Storyframe';

export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function button(label: string, href: string): string {
  return `<p style="margin:24px 0"><a href="${escapeHtml(href)}" style="display:inline-block;background:#6d5dfc;color:#fff;text-decoration:none;padding:12px 20px;border-radius:8px;font-weight:600">${escapeHtml(label)}</a></p>`;
}

function layout(title: string, body: string, footer = ''): string {
  return `<!doctype html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>${escapeHtml(title)}</title></head>
<body style="margin:0;background:#f5f5f7;font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:#1c1c1e">
<table role="presentation" width="100%" cellspacing="0" cellpadding="0"><tr><td align="center" style="padding:32px 16px">
<table role="presentation" width="100%" style="max-width:560px;background:#fff;border-radius:12px;padding:32px" cellspacing="0" cellpadding="0"><tr><td>
<p style="margin:0 0 24px;font-weight:700;font-size:18px"><span style="color:#6d5dfc">&#9654;</span> ${BRAND}</p>
${body}
<p style="margin:32px 0 0;color:#8e8e93;font-size:12px">${footer || `You are receiving this because you have a ${BRAND} account.`}</p>
</td></tr></table>
</td></tr></table>
</body></html>`;
}

function fmtDuration(sec: number): string {
  const s = Math.round(sec);
  return s >= 60 ? `${Math.floor(s / 60)} min ${s % 60} s` : `${s} s`;
}

function fmtMoney(amountMinor: number, currency: string): string {
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: currency.toUpperCase(),
  }).format(amountMinor / 100);
}

function fmtDate(d: Date): string {
  return d.toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' });
}

export function welcome(p: {
  name?: string | null;
  webUrl: string;
  trialCredits: number;
}): Rendered {
  const hi = p.name ? `Hi ${escapeHtml(p.name)},` : 'Hi,';
  const newUrl = `${p.webUrl}/new`;
  return {
    subject: `Welcome to ${BRAND}: your first video is on us`,
    html: layout(
      `Welcome to ${BRAND}`,
      `<h1 style="font-size:22px;margin:0 0 16px">Welcome to ${BRAND}</h1>
<p>${hi}</p>
<p>Type a one-line story idea and ${BRAND} writes the script, designs the characters, animates every scene, adds voice, music and subtitles, and hands you a finished MP4.</p>
<p>Your workspace starts with <strong>${p.trialCredits} free credits</strong>, enough for a short video in the standard tier.</p>
${button('Make your first video', newUrl)}
<p style="color:#636366">Tip: name your characters and describe them in one sentence each. The pipeline keeps them consistent across scenes.</p>`,
    ),
    text: `Welcome to ${BRAND}

${p.name ? `Hi ${p.name},` : 'Hi,'}

Type a one-line story idea and ${BRAND} writes the script, designs the characters, animates every scene, adds voice, music and subtitles, and hands you a finished MP4.

Your workspace starts with ${p.trialCredits} free credits, enough for a short video in the standard tier.

Make your first video: ${newUrl}
`,
  };
}

export function videoReady(p: {
  title?: string | null;
  jobUrl: string;
  durationSec?: number | null;
  credits?: number | null;
  first: boolean;
}): Rendered {
  const title = p.title?.trim() || 'Your video';
  const details = [
    p.durationSec ? fmtDuration(p.durationSec) : null,
    p.credits != null ? `${p.credits} credits` : null,
  ]
    .filter(Boolean)
    .join(' · ');
  const subject = p.first ? `Your first ${BRAND} video is ready` : `"${title}" is ready`;
  return {
    subject,
    html: layout(
      subject,
      `<h1 style="font-size:22px;margin:0 0 16px">${p.first ? 'Your first video is ready' : 'Your video is ready'}</h1>
<p><strong>${escapeHtml(title)}</strong>${details ? ` <span style="color:#636366">· ${escapeHtml(details)}</span>` : ''}</p>
<p>Watch it, download the MP4 and the subtitle file, or start another one.</p>
${button('Watch and download', p.jobUrl)}
${p.first ? `<p style="color:#636366">Not happy with a scene? Regenerating a single scene costs a fraction of a full video. Reply to this email if anything looks off; a human reads every reply.</p>` : ''}`,
    ),
    text: `${p.first ? 'Your first video is ready' : 'Your video is ready'}

${title}${details ? ` (${details})` : ''}

Watch and download: ${p.jobUrl}
`,
  };
}

export function videoFailed(p: {
  title?: string | null;
  jobUrl: string;
  reason?: string | null;
  refunded: boolean;
}): Rendered {
  const title = p.title?.trim() || 'Your video';
  const subject = `We couldn't finish "${title}"`;
  return {
    subject,
    html: layout(
      subject,
      `<h1 style="font-size:22px;margin:0 0 16px">We couldn't finish this one</h1>
<p><strong>${escapeHtml(title)}</strong> stopped before the final render${p.reason ? `: ${escapeHtml(p.reason)}` : '.'}</p>
<p>${p.refunded ? 'The credits held for it have been returned to your balance.' : 'You were only charged for the scenes that completed.'} Trying again usually works; provider hiccups are the most common cause.</p>
${button('View the job', p.jobUrl)}`,
    ),
    text: `We couldn't finish "${title}"${p.reason ? `: ${p.reason}` : ''}.

${p.refunded ? 'The credits held for it have been returned to your balance.' : 'You were only charged for the scenes that completed.'}

View the job: ${p.jobUrl}
`,
  };
}

export function lowCredits(p: {
  available: number;
  planName: string;
  billingUrl: string;
  renewsAt?: Date | null;
}): Rendered {
  const subject = `${p.available} credits left in your ${BRAND} workspace`;
  const renew = p.renewsAt
    ? `Your ${escapeHtml(p.planName)} plan refills on ${fmtDate(p.renewsAt)}.`
    : `You are on the ${escapeHtml(p.planName)} plan.`;
  return {
    subject,
    html: layout(
      subject,
      `<h1 style="font-size:22px;margin:0 0 16px">Running low on credits</h1>
<p>Your workspace has <strong>${p.available} credits</strong> left. ${renew}</p>
<p>Top up with a credit pack, or move to a bigger plan to keep making videos without interruption.</p>
${button('Manage plan and credits', p.billingUrl)}`,
    ),
    text: `Running low on credits

Your workspace has ${p.available} credits left. ${p.renewsAt ? `Your ${p.planName} plan refills on ${fmtDate(p.renewsAt)}.` : `You are on the ${p.planName} plan.`}

Manage plan and credits: ${p.billingUrl}
`,
  };
}

export function renewalUpcoming(p: {
  planName: string;
  amountMinor: number;
  currency: string;
  renewsAt: Date;
  billingUrl: string;
}): Rendered {
  const amount = fmtMoney(p.amountMinor, p.currency);
  const subject = `Your ${BRAND} ${p.planName} plan renews on ${fmtDate(p.renewsAt)}`;
  return {
    subject,
    html: layout(
      subject,
      `<h1 style="font-size:22px;margin:0 0 16px">Upcoming renewal</h1>
<p>Your <strong>${escapeHtml(p.planName)}</strong> plan renews on <strong>${fmtDate(p.renewsAt)}</strong> for <strong>${amount}</strong>, and your credits refill the same day.</p>
<p>Nothing to do if that is fine. To change plans, update your card or cancel, use the billing portal.</p>
${button('Manage billing', p.billingUrl)}`,
    ),
    text: `Upcoming renewal

Your ${p.planName} plan renews on ${fmtDate(p.renewsAt)} for ${amount}, and your credits refill the same day.

Manage billing: ${p.billingUrl}
`,
  };
}

export function paymentFailed(p: {
  planName: string;
  amountMinor: number;
  currency: string;
  billingUrl: string;
}): Rendered {
  const amount = fmtMoney(p.amountMinor, p.currency);
  const subject = `Payment for your ${BRAND} ${p.planName} plan didn't go through`;
  return {
    subject,
    html: layout(
      subject,
      `<h1 style="font-size:22px;margin:0 0 16px">Payment didn't go through</h1>
<p>We couldn't charge <strong>${amount}</strong> for your <strong>${escapeHtml(p.planName)}</strong> plan. We will retry over the next few days; if it keeps failing the plan pauses and no new credits are added.</p>
<p>Updating your card in the billing portal fixes it right away.</p>
${button('Update payment method', p.billingUrl)}`,
    ),
    text: `Payment didn't go through

We couldn't charge ${amount} for your ${p.planName} plan. We will retry over the next few days; if it keeps failing the plan pauses and no new credits are added.

Update payment method: ${p.billingUrl}
`,
  };
}

export function deletionScheduled(p: {
  workspaceName: string;
  purgeAt: Date;
  accountUrl: string;
}): Rendered {
  const subject = `Your ${BRAND} account will be deleted on ${fmtDate(p.purgeAt)}`;
  return {
    subject,
    html: layout(
      subject,
      `<h1 style="font-size:22px;margin:0 0 16px">Deletion scheduled</h1>
<p>We received a request to delete the workspace <strong>${escapeHtml(p.workspaceName)}</strong>, its videos, characters, billing history and account. Everything is permanently erased on <strong>${fmtDate(p.purgeAt)}</strong>.</p>
<p>Running jobs were canceled and their credits returned. Until then you can change your mind with one click.</p>
${button('Keep my account', p.accountUrl)}
<p style="color:#636366">If you did not request this, sign in and cancel the deletion, then change your password with your sign-in provider.</p>`,
    ),
    text: `Deletion scheduled

We received a request to delete the workspace "${p.workspaceName}", its videos, characters, billing history and account. Everything is permanently erased on ${fmtDate(p.purgeAt)}.

Running jobs were canceled and their credits returned. Until then you can cancel the deletion here: ${p.accountUrl}

If you did not request this, sign in and cancel the deletion, then change your password with your sign-in provider.
`,
  };
}
