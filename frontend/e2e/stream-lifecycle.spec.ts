import { test, expect } from '@playwright/test'

test.describe('FlowFi Playwright E2E', () => {
  test('connects wallet and navigates to create stream page', async ({
    page,
  }) => {
    await page.goto('/dashboard')

    await expect(
      page.locator('h2', { hasText: 'Connect a wallet' })
    ).toBeVisible()
    
    // 1. Click Albedo to safely bypass Freighter extension timeouts in headless CI
    await page.getByRole('button', { name: /Connect Albedo/i }).click()

    // 2. Specifically target the button element to satisfy Playwright's strict mode
    //    and click it to open the dropdown menu.
    await page.locator('button.wallet-chip').click()

    // 3. Now the menu is open and Playwright can verify the disconnect button
    await expect(
      page.locator('button', { hasText: 'Disconnect Wallet' })
    ).toBeVisible()
    
    // 4. Proceed with the rest of the flow
    await page.getByRole('link', { name: /Create Stream/i }).click()

    await expect(
      page.locator('h1', { hasText: 'Create New Stream' })
    ).toBeVisible()
    await expect(
      page.locator('label', { hasText: 'Recipient Address' })
    ).toBeVisible()
  })
})
