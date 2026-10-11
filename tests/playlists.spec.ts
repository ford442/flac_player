import { test, expect, type Page } from '@playwright/test';
import { mockLibraryApi, mockAudioFixtures, MOCK_TRACKS } from './helpers/playwrightApi';

async function openPlaylists(page: Page) {
  await page.getByRole('button', { name: 'Open Advanced Library' }).click();
  await page.getByRole('button', { name: /Playlists/ }).click();
  await expect(page.getByRole('heading', { name: 'Playlists' })).toBeVisible({ timeout: 15_000 });
}

test.describe('Local playlists', () => {
  test.beforeEach(async ({ page }) => {
    await mockLibraryApi(page);
    await mockAudioFixtures(page);
    // Production host without playlist routes: must not matter.
    await page.route('**/api/playlists**', route => route.fulfill({ status: 404, body: '' }));
    // Seed the queue once; later reloads must not overwrite what the app saved.
    await page.addInitScript((tracks) => {
      if (!sessionStorage.getItem('seeded')) {
        sessionStorage.setItem('seeded', '1');
        localStorage.setItem('flac_player_queue', JSON.stringify({ tracks, currentIndex: -1, shuffle: false, repeat: 'off' }));
      }
    }, MOCK_TRACKS);
  });

  test('saves the queue as a playlist that survives reload, can be reordered, and deletes offline', async ({ page }) => {
    const writes: string[] = [];
    page.on('request', req => { if (req.method() !== 'GET' && req.url().includes('/api/')) writes.push(req.url()); });

    await page.goto('/');
    await openPlaylists(page);
    await expect(page.getByText(/No saved playlists yet/)).toBeVisible();

    await page.getByLabel('New playlist name').fill('Night drive');
    await page.getByRole('button', { name: /Save queue/ }).click();
    await expect(page.getByTestId('local-playlist')).toContainText('Night drive');
    await expect(page.getByTestId('local-playlist')).toContainText('2 tracks');

    // Reload: still there, with the same ids (shown by title once expanded).
    await page.reload();
    await openPlaylists(page);
    const card = page.getByTestId('local-playlist');
    await expect(card).toContainText('Night drive');
    await card.getByRole('button', { name: 'Edit' }).click();
    const rows = card.getByRole('listitem');
    await expect(rows.nth(0)).toContainText('Track One');
    await expect(rows.nth(1)).toContainText('Track Two');

    // Reorder (keyboard-accessible control) and rename, then confirm persistence.
    await card.getByRole('button', { name: 'Move Track One down' }).click();
    await expect(rows.nth(0)).toContainText('Track Two');
    await card.getByRole('button', { name: /Rename/ }).click();
    await page.getByLabel('Rename playlist').fill('Late drive');
    await page.getByLabel('Rename playlist').press('Enter');

    await page.reload();
    await openPlaylists(page);
    await expect(page.getByTestId('local-playlist')).toContainText('Late drive');
    await page.getByTestId('local-playlist').getByRole('button', { name: 'Edit' }).click();
    await expect(page.getByTestId('local-playlist').getByRole('listitem').nth(0)).toContainText('Track Two');

    // Delete never leaves the browser.
    writes.length = 0;
    await page.getByRole('button', { name: /Delete/ }).click();
    await page.getByRole('button', { name: 'Confirm delete' }).click();
    await expect(page.getByTestId('local-playlist')).toHaveCount(0);
    expect(writes).toEqual([]);

    await page.reload();
    await openPlaylists(page);
    await expect(page.getByText(/No saved playlists yet/)).toBeVisible();
  });

  test('empty cloud list does not read as "zero playlists" when local ones exist', async ({ page }) => {
    await page.goto('/');
    await openPlaylists(page);
    await page.getByLabel('New playlist name').fill('Keepers');
    await page.getByRole('button', { name: /Save queue/ }).click();
    await expect(page.getByTestId('local-playlist')).toHaveCount(1);
    await expect(page.getByText(/doesn.t affect the 1 saved on this device/)).toBeVisible();
  });
});
