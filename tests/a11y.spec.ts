import { test, expect, type Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { mockLibraryApi, mockAudioFixtures } from './helpers/playwrightApi';

const WCAG_TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'];

/** Serious and critical axe violations, summarized so a failure names the rule and nodes. */
async function seriousViolations(page: Page) {
  const { violations } = await new AxeBuilder({ page })
    .withTags(WCAG_TAGS)
    // webpack-dev-server's error overlay is tooling, not the app.
    .exclude('#webpack-dev-server-client-overlay')
    .analyze();
  return violations
    .filter(v => v.impact === 'serious' || v.impact === 'critical')
    .map(v => ({ id: v.id, impact: v.impact, nodes: v.nodes.map(n => n.target.join(' ')).slice(0, 5) }));
}

async function openFallbackTab(page: Page, tab: string) {
  await page.getByRole('button', { name: 'Open Advanced Library' }).click();
  await page.getByRole('button', { name: tab }).click();
}

test.describe('Accessibility', () => {
  test.beforeEach(async ({ page }) => {
    await mockLibraryApi(page);
    await mockAudioFixtures(page);
  });

  test('Now Playing (hardware GUI) has no serious axe violations', async ({ page }) => {
    await page.goto('/');
    await expect(page.getByRole('slider', { name: 'Volume' })).toBeVisible();
    expect(await seriousViolations(page)).toEqual([]);
  });

  test('Now Playing (advanced view) has no serious axe violations', async ({ page }) => {
    await page.goto('/');
    await openFallbackTab(page, '▶️ Now Playing');
    expect(await seriousViolations(page)).toEqual([]);
  });

  test('Library has no serious axe violations in grid or list view', async ({ page }) => {
    await page.goto('/');
    await openFallbackTab(page, '📚 Library');
    await expect(page.getByText('Track One', { exact: true })).toBeVisible({ timeout: 15_000 });
    expect(await seriousViolations(page)).toEqual([]);

    await page.getByRole('button', { name: '☰ List' }).click();
    await expect(page.getByRole('table', { name: 'Library' })).toBeVisible();
    expect(await seriousViolations(page)).toEqual([]);
  });

  test('EQ (settings) has no serious axe violations', async ({ page }) => {
    await page.goto('/');
    await openFallbackTab(page, '⚙️ Settings');
    await expect(page.getByText('Equalizer', { exact: false }).first()).toBeVisible();
    expect(await seriousViolations(page)).toEqual([]);
  });

  test('knobs and the volume slider work from the keyboard', async ({ page }) => {
    await page.goto('/');

    const knob = page.getByRole('slider', { name: 'PULSE' });
    await knob.focus();
    await expect(knob).toHaveAttribute('aria-valuenow', '0');
    await page.keyboard.press('ArrowUp');
    await expect(knob).toHaveAttribute('aria-valuenow', '1');
    await page.keyboard.press('PageUp');
    await expect(knob).toHaveAttribute('aria-valuenow', '11');
    await page.keyboard.press('End');
    await expect(knob).toHaveAttribute('aria-valuenow', '100');
    await page.keyboard.press('Home');
    await expect(knob).toHaveAttribute('aria-valuenow', '0');

    const volume = page.getByRole('slider', { name: 'Volume' });
    await volume.focus();
    await page.keyboard.press('End');
    await expect(volume).toHaveAttribute('aria-valuenow', '100');
    await page.keyboard.press('ArrowDown');
    await expect(volume).toHaveAttribute('aria-valuenow', '95');
    await page.keyboard.press('PageDown');
    await expect(volume).toHaveAttribute('aria-valuenow', '75');
    // The slider owns the arrow keys: the global ↓ (volume −10%) must not also fire.
    await page.keyboard.press('ArrowDown');
    await expect(volume).toHaveAttribute('aria-valuenow', '70');
  });

  test('Space on a focused button activates the button, not play/pause', async ({ page }) => {
    await page.goto('/');
    const help = page.getByRole('button', { name: 'Open Advanced Library' });
    await help.focus();
    await page.keyboard.press('Space');
    await expect(page.getByRole('button', { name: '← Back to GUI Player' })).toBeVisible();
  });

  test('keyboard help lists only wired shortcuts', async ({ page }) => {
    await page.goto('/');
    await expect(page.getByRole('slider', { name: 'Volume' })).toBeVisible();
    await page.keyboard.press('?');
    const dialog = page.getByRole('dialog', { name: /Keyboard Shortcuts/ });
    await expect(dialog).toBeVisible();
    await expect(dialog.getByText('Play / Pause')).toBeVisible();
    await expect(dialog.getByText('Toggle queue panel')).toBeVisible();
    await expect(dialog.getByText(/pile/i)).toHaveCount(0);
    await expect(dialog.getByText(/Rate current track/)).toHaveCount(0);
    await page.keyboard.press('Escape');
    await expect(dialog).toBeHidden();
  });
});
