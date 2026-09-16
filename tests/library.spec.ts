import { test, expect, type Page } from '@playwright/test';
import { mockLibraryApi, mockAudioFixtures, MOCK_TRACKS } from './helpers/playwrightApi';

async function openLibrary(page: Page) {
  await page.getByRole('button', { name: 'Open Advanced Library' }).click();
  await page.getByRole('button', { name: '📚 Library' }).click();
  await expect(page.getByText('Track One', { exact: true })).toBeVisible({ timeout: 15_000 });
}

const trackCard = (page: Page, title: string) =>
  page.getByRole('listitem', { name: new RegExp(`^${title} by`) });

test.describe('Library features', () => {
  test.beforeEach(async ({ page }) => {
    await mockLibraryApi(page);
    await mockAudioFixtures(page);
  });

  test('rates and tags a track from the keyboard, using API tag suggestions', async ({ page }) => {
    let patchBody: Record<string, unknown> | undefined;
    await page.route('**/api/songs/track-1/suggest-tags', route => route.fulfill({
      status: 200, contentType: 'application/json',
      body: JSON.stringify({ suggestions: ['ambient', 'chill'], source: 'test' }),
    }));
    await page.route('**/api/songs/track-1', route => {
      if (route.request().method() !== 'PATCH') return route.continue();
      patchBody = route.request().postDataJSON();
      return route.fulfill({ status: 200, contentType: 'application/json', body: '{}' });
    });

    await page.goto('/');
    await openLibrary(page);

    const card = trackCard(page, 'Track One');
    await card.focus();
    await page.keyboard.press('e');

    const rating = card.getByRole('radiogroup', { name: 'Rating' });
    await rating.getByRole('radio', { name: 'Trash' }).focus();
    await page.keyboard.press('4');
    await expect(rating.getByRole('radio', { name: '4 stars' })).toHaveAttribute('aria-checked', 'true');

    await card.getByRole('button', { name: 'Add suggested tag ambient' }).click();
    const tagBox = card.getByRole('combobox', { name: 'Tags' });
    await tagBox.fill('late-night');
    await tagBox.press('Enter');

    await card.getByRole('button', { name: 'Save' }).click();
    await expect.poll(() => patchBody).toMatchObject({ rating: 4, tags: ['ambient', 'late-night'] });
    await expect(page.getByText('Changes saved')).toBeVisible();
  });

  test('downloads a track for offline and evicts it from the library row', async ({ page }) => {
    await page.goto('/');
    await openLibrary(page);

    const card = trackCard(page, 'Track One');
    await card.getByTestId('offline-badge-download').click();
    await expect(card.getByTestId('offline-badge-cached')).toBeVisible({ timeout: 10_000 });
    await expect(page.getByText('Saved for offline')).toBeVisible();
    // fetchSongs prefixes relative URLs with API_BASE_URL, so match on the path suffix.
    const cachedKeys = await page.evaluate(async () =>
      (await (await caches.open('flac-player-tracks-v1')).keys()).map(r => r.url));
    expect(cachedKeys.some(u => u.endsWith(MOCK_TRACKS[0].url))).toBe(true);

    await card.getByTestId('offline-badge-cached').click();
    await expect(card.getByTestId('offline-badge-download')).toBeVisible();
  });

  test('offline download failure surfaces a toast', async ({ page }) => {
    await page.route('**/fixtures/test-two.flac**', route => route.fulfill({ status: 404, body: '' }));
    await page.goto('/');
    await openLibrary(page);

    await trackCard(page, 'Track Two').getByTestId('offline-badge-download').click();
    await expect(page.getByText(/Offline download failed/)).toBeVisible();
  });

  test('shares the queue via the share API', async ({ page, context }) => {
    await context.grantPermissions(['clipboard-read', 'clipboard-write']);
    let sharedIds: unknown;
    await page.route('**/api/share', route => {
      sharedIds = route.request().postDataJSON()?.track_ids;
      return route.fulfill({
        status: 200, contentType: 'application/json',
        body: JSON.stringify({ share_id: 'abc', short_url: 'https://example.test/s/abc', full_url: 'https://example.test/s/abc' }),
      });
    });
    await page.addInitScript((tracks) => {
      localStorage.setItem('flac_player_queue', JSON.stringify({ tracks, currentIndex: -1, shuffle: false, repeat: 'off' }));
    }, MOCK_TRACKS);

    await page.goto('/');
    await openLibrary(page);
    await page.getByRole('button', { name: /📋 Queue/ }).first().click();
    await page.getByRole('button', { name: 'Share queue' }).click();

    await expect.poll(() => sharedIds).toEqual(['track-1', 'track-2']);
    await expect(page.getByText('Shareable playlist link copied to clipboard!')).toBeVisible();
  });

  test('loads the next library page with an offset instead of refetching', async ({ page }) => {
    const page1 = Array.from({ length: 200 }, (_, i) => ({
      id: `p1-${i}`, name: `Song ${i}.flac`, title: `Song ${i}`, author: 'Pager', url: '/fixtures/test.flac', duration: 1,
    }));
    const offsets: string[] = [];
    await page.unroute('**/api/songs?**');
    await page.route('**/api/songs?**', route => {
      const offset = new URL(route.request().url()).searchParams.get('offset') ?? '0';
      offsets.push(offset);
      const body = offset === '0' ? page1 : [{ ...MOCK_TRACKS[0], id: 'p2-0', title: 'Page Two Song' }];
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
    });

    await page.goto('/');
    await page.getByRole('button', { name: 'Open Advanced Library' }).click();
    await page.getByRole('button', { name: '📚 Library' }).click();
    await expect(page.getByText('Song 0', { exact: true })).toBeVisible({ timeout: 15_000 });

    await page.getByRole('button', { name: /Load more/ }).click();
    await expect(page.getByText('Page Two Song', { exact: true })).toBeVisible();
    expect(offsets).toContain('200');
    await expect(page.getByRole('button', { name: /Load more/ })).toHaveCount(0);
  });
});
