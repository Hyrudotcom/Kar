import { expect, test } from '@playwright/test';

// Requires `npm run export:web` first. Visual inspection base; mobile builder extends this.
test('two Dutch tabs render', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByText('Mijn lijst').first()).toBeVisible();
  await expect(page.getByText('Goedkoopste route').first()).toBeVisible();
});
