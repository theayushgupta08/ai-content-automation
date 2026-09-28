// Screenshots dashboard pages with the preinstalled Chromium. Usage:
//   node scripts/screenshot.mjs http://localhost:3000/jobs/<id> .local/job.png
import { chromium } from 'playwright-core';

const [url, out] = process.argv.slice(2);
if (!url || !out) {
  console.error('usage: node scripts/screenshot.mjs <url> <out.png>');
  process.exit(2);
}
const browser = await chromium.launch({
  executablePath: process.env.CHROMIUM_PATH || '/opt/pw-browsers/chromium',
  args: ['--no-sandbox'],
});
const page = await browser.newPage({ viewport: { width: 1280, height: 1400 } });
const errors = [];
page.on('pageerror', (e) => errors.push(String(e)));
page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
await page.goto(url, { waitUntil: 'networkidle' });
await page.waitForTimeout(1500);
await page.screenshot({ path: out, fullPage: true });
await browser.close();
if (errors.length) {
  console.error('browser errors:\n' + errors.join('\n'));
  process.exit(1);
}
console.log(`saved ${out}`);
