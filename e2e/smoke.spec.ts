import { expect, test } from '@playwright/test';

// Requires `npm run export:web` first. The web export runs on the in-memory demo backend
// (docs/architecture.md section 7): sign in with any 6-digit code.
test('sign in with an e-mail code, add an item, two Dutch tabs, no unverified prices', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Kar' })).toBeVisible();
  await page.getByRole('textbox', { name: 'E-mailadres' }).fill('anna@voorbeeld.nl');
  await page.getByRole('button', { name: 'Stuur code' }).click();
  await page.getByRole('textbox').first().fill('123456');

  await expect(page.getByText('Mijn lijst').first()).toBeVisible({ timeout: 10_000 });
  await expect(page.getByText('Goedkoopste route').first()).toBeVisible();
  // D2-01: the tab labels are not cut off (they were squeezed to 10 px of their 18 px line).
  for (const name of ['Mijn lijst', 'Goedkoopste route']) {
    const box = await page.getByRole('tab', { name }).getByText(name).boundingBox();
    expect(box && box.height).toBeGreaterThanOrEqual(15);
    expect(box!.y + box!.height).toBeLessThanOrEqual(page.viewportSize()!.height);
  }
  await page.screenshot({ path: 'test-results/tabs.png' });

  const add = page.getByRole('textbox').first();
  await add.fill('2 pak hagelslag');
  await add.press('Enter');
  await expect(page.getByText(/hagelslag/i).first()).toBeVisible();

  await page.getByText('Goedkoopste route').first().click();
  await expect(page.getByText('Geen geverifieerde prijzen beschikbaar')).toBeVisible({ timeout: 10_000 });
  await expect(page.getByText(/€/)).toHaveCount(0);
  await page.screenshot({ path: 'test-results/route.png' });
  expect(errors).toEqual([]);
});
