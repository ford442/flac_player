/**
 * Manual/dev verification for Convert tab (ffmpeg.wasm).
 * Usage: node scripts/verify-convert.mjs [baseURL]
 * Requires a running webpack dev server (default http://localhost:3001).
 */
import { chromium } from 'playwright';
import { readFileSync } from 'fs';
import path from 'path';

const base = process.argv[2] || 'http://localhost:3001';
const flacPath = path.resolve('tests/fixtures/test.flac');
const mp3Path = path.resolve('tests/fixtures/test.mp3');

const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({ acceptDownloads: true });
const page = await context.newPage();

page.on('pageerror', (e) => console.log('pageerror:', e.message));

console.log('goto', base);
await page.goto(base, { waitUntil: 'domcontentloaded', timeout: 60_000 });
await page.waitForTimeout(2000);
await page.evaluate(() => {
  document.getElementById('webpack-dev-server-client-overlay')?.remove();
  document.querySelector('iframe#webpack-dev-server-client-overlay')?.remove();
});

const advanced = page.getByRole('button', { name: /Open Advanced Library/i });
if (await advanced.isVisible().catch(() => false)) {
  await advanced.click({ force: true });
  await page.waitForTimeout(400);
}

await page.getByRole('button', { name: /Convert/i }).click();
await page.getByText('Convert audio').waitFor({ timeout: 15_000 });
console.log('Convert tab open');

const fileInput = page
  .getByRole('button', { name: /Drop MP3 or FLAC files/i })
  .locator('input[type="file"]');

async function convertOne(filePath, expectExt) {
  await page.getByRole('button', { name: 'Clear all' }).click().catch(() => {});
  await fileInput.setInputFiles(filePath);
  const baseName = path.basename(filePath);
  await page.getByText(baseName, { exact: true }).waitFor({ timeout: 10_000 });

  const downloadPromise = page.waitForEvent('download', { timeout: 240_000 });
  await page.getByRole('button', { name: /Convert & download/i }).click();
  await page.getByText('Downloaded').waitFor({ timeout: 240_000 });
  const download = await downloadPromise;
  const name = download.suggestedFilename();
  if (!name.endsWith(expectExt)) {
    throw new Error(`expected ${expectExt}, got ${name}`);
  }
  const out = `/tmp/verify-${name}`;
  await download.saveAs(out);
  const size = readFileSync(out).length;
  console.log(`OK ${baseName} → ${name} (${size} bytes)`);
  if (size < 500) throw new Error('output too small');
}

await convertOne(flacPath, '.mp3');
await convertOne(mp3Path, '.flac');

// Reject unsupported
await page.getByRole('button', { name: 'Clear all' }).click();
await fileInput.setInputFiles({
  name: 'notes.txt',
  mimeType: 'text/plain',
  buffer: Buffer.from('hello'),
});
await page.getByText('Only .mp3 and .flac').waitFor({ timeout: 10_000 });
console.log('OK rejected .txt');

await browser.close();
console.log('All convert checks passed');
