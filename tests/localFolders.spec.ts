// Local folders in Chromium (#284). The directory picker is stubbed to return a real
// FileSystemDirectoryHandle from OPFS, so the handle really persists in IndexedDB,
// clones into the scan worker and reopens files after a reload.
import { test, expect, type Page } from '@playwright/test';
import fs from 'fs';
import path from 'path';
import { mockLibraryApi, mockAudioFixtures } from './helpers/playwrightApi';

test.use({ launchOptions: { args: ['--autoplay-policy=no-user-gesture-required'] } });

const FIXTURES = [
  ['Album/01 Seek.flac', 'seek-index-40s.flac'],
  ['Album/02 Gapless A.flac', 'gapless-a.flac'],
  ['Gapless B.flac', 'gapless-b.flac'],
] as const;

async function seedOpfsFolder(page: Page): Promise<void> {
  const files = FIXTURES.map(([dest, fixture]) => ({
    dest,
    b64: fs.readFileSync(path.join(process.cwd(), 'tests/fixtures', fixture)).toString('base64'),
  }));
  await page.evaluate(async (entries) => {
    const root = await navigator.storage.getDirectory();
    const music = await root.getDirectoryHandle('Music', { create: true });
    for (const { dest, b64 } of entries) {
      const parts = dest.split('/');
      let dir = music;
      for (const part of parts.slice(0, -1)) dir = await dir.getDirectoryHandle(part, { create: true });
      const handle = await dir.getFileHandle(parts[parts.length - 1]!, { create: true });
      const writable = await (handle as FileSystemFileHandle & { createWritable(): Promise<FileSystemWritableFileStream> }).createWritable();
      await writable.write(Uint8Array.from(atob(b64), (c) => c.charCodeAt(0)));
      await writable.close();
    }
    await music.getFileHandle('notes.txt', { create: true });
  }, files);
}

async function openLibrary(page: Page) {
  await page.getByRole('button', { name: 'Open Advanced Library' }).click();
  await page.getByRole('button', { name: '📚 Library' }).click();
}

const folderTrack = (page: Page, title: string) => page.getByRole('listitem', { name: new RegExp(`^${title} by`) });

test.describe('Local folders (#284)', () => {
  test.beforeEach(async ({ page }) => {
    await mockLibraryApi(page);
    await mockAudioFixtures(page);
    await page.addInitScript(() => {
      Object.assign(window, {
        showDirectoryPicker: async () => (await navigator.storage.getDirectory()).getDirectoryHandle('Music'),
      });
    });
  });

  test('grant a folder, list its FLAC files, survive a reload, play on the hi-fi path', async ({ page }) => {
    const localRequests: string[] = [];
    page.on('request', (r) => { if (r.url().startsWith('local:')) localRequests.push(r.url()); });

    await page.goto('/');
    await seedOpfsFolder(page);
    await openLibrary(page);

    // The scan runs in a worker (the handle is cloned into it), not on the main thread.
    const workers: string[] = [];
    page.on('worker', (w) => workers.push(w.url()));
    await page.getByRole('button', { name: '📁 Add folder' }).click();
    await expect(page.getByText('"Music": 3 tracks (3 new or changed)')).toBeVisible({ timeout: 20_000 });
    expect(workers.length).toBeGreaterThan(0);
    const folder = page.getByTestId('local-folder');
    await expect(folder).toHaveAttribute('data-access', 'granted');
    await expect(folder).toContainText('3 tracks');

    await page.getByLabel('Storage Source').selectOption('local');
    await expect(page.getByTestId('library-track')).toHaveCount(3);
    // No edit / trash for folder tracks.
    await expect(folderTrack(page, '01 Seek').getByRole('button', { name: 'Edit' })).toHaveCount(0);

    await page.reload();
    await openLibrary(page);
    await expect(page.getByTestId('local-folder')).toHaveAttribute('data-access', 'granted', { timeout: 15_000 });
    await page.getByLabel('Storage Source').selectOption('local');
    await expect(page.getByTestId('library-track')).toHaveCount(3);

    const first = folderTrack(page, '01 Seek');
    await first.focus();
    await page.keyboard.press('Enter');
    await expect(page.getByRole('button', { name: 'Pause' })).toBeVisible({ timeout: 20_000 });

    await page.getByRole('button', { name: '⚙️ Settings' }).click();
    await expect(page.getByText('Hi-Fi streaming', { exact: true })).toBeVisible();
    expect(localRequests).toEqual([]);
  });

  test('without File System Access: webkitdirectory pick, then "pick again" after a reload (rows stay)', async ({ page }, testInfo) => {
    await page.addInitScript(() => { delete (window as { showDirectoryPicker?: unknown }).showDirectoryPicker; });
    const dir = testInfo.outputPath('Music');
    for (const [dest, fixture] of FIXTURES) {
      fs.mkdirSync(path.dirname(path.join(dir, dest)), { recursive: true });
      fs.copyFileSync(path.join(process.cwd(), 'tests/fixtures', fixture), path.join(dir, dest));
    }

    await page.goto('/');
    await openLibrary(page);
    await expect(page.getByText('This browser cannot remember folders')).toBeVisible();
    await page.getByTestId('local-folder-input').setInputFiles(dir);
    await expect(page.getByText('"Music": 3 tracks (3 new or changed)')).toBeVisible({ timeout: 20_000 });

    await page.reload();
    await openLibrary(page);
    const folder = page.getByTestId('local-folder');
    await expect(folder).toHaveAttribute('data-access', 'unavailable', { timeout: 15_000 });
    await expect(folder.getByRole('button', { name: 'Pick folder again' })).toBeVisible();
    await page.getByLabel('Storage Source').selectOption('local');
    await expect(page.getByTestId('library-track')).toHaveCount(3);

    // Playing before re-picking explains what to do instead of failing silently.
    await folderTrack(page, '01 Seek').focus();
    await page.keyboard.press('Enter');
    await expect(page.getByText(/Pick the folder "Music" again/)).toBeVisible({ timeout: 10_000 });
  });
});
