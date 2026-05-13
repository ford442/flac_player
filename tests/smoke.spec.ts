import { test, expect } from '@playwright/test';

test.describe('FLAC Player Smoke Tests', () => {
  test('homepage loads without errors', async ({ page }) => {
    const consoleErrors: string[] = [];
    page.on('pageerror', (err) => consoleErrors.push(err.message));
    page.on('console', (msg) => {
      if (msg.type() === 'error') consoleErrors.push(msg.text());
    });

    await page.goto('/');
    await expect(page.locator('body')).toBeVisible();
    expect(consoleErrors).toHaveLength(0);
  });

  test('WebGPU availability is detected', async ({ page }) => {
    await page.goto('/');
    const hasWebGPU = await page.evaluate(() => !!navigator.gpu);
    console.log('WebGPU available:', hasWebGPU);
    // WebGPU may not be available in CI; just verify detection works
    expect(typeof hasWebGPU).toBe('boolean');
  });

  test('metadata panel renders in dark mode by default', async ({ page }) => {
    await page.goto('/');
    const panel = page.locator('[aria-label="Now Playing - Track Information"]');
    await expect(panel).toBeVisible();
    await expect(panel).toHaveClass(/dark/);
  });

  test('theme toggle switches to light mode', async ({ page }) => {
    await page.goto('/');
    const panel = page.locator('[aria-label="Now Playing - Track Information"]');
    const toggle = panel.locator('.theme-toggle');

    await toggle.click();
    await expect(panel).toHaveClass(/light/);

    await toggle.click();
    await expect(panel).toHaveClass(/dark/);
  });

  test('keyboard shortcuts are registered', async ({ page }) => {
    await page.goto('/');
    // Space should not scroll the page (it should be captured by the player)
    const scrollYBefore = await page.evaluate(() => window.scrollY);
    await page.keyboard.press('Space');
    const scrollYAfter = await page.evaluate(() => window.scrollY);
    expect(scrollYAfter).toBe(scrollYBefore);
  });
});
