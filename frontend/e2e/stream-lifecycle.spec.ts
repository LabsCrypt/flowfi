import { test, expect } from '@playwright/test'

const MOCK_PUBLIC_KEY =
  'GD2Z4J7F6LP4DOLWQSCWX3T7WKUEXZD7M2JVH2INE7PSKBB2Z2KF5I5H'

test.describe('FlowFi Playwright E2E', () => {
  test.beforeEach(async ({ page }) => {
    await page.addInitScript((publicKey) => {
      window.freighter = {
        isConnected: async () => ({ isConnected: true }),
        setAllowed: async () => ({}),
        getAddress: async () => ({ address: publicKey }),
        getNetworkDetails: async () => ({
          networkPassphrase: 'Test SDF Network ; September 2015',
        }),
      }
    }, MOCK_PUBLIC_KEY)
  })

  test('connects Freighter wallet and navigates to create stream page', async ({
    page,
  }) => {
    await page.goto('/dashboard')

    await expect(
      page.locator('h2', { hasText: 'Connect a wallet' })
    ).toBeVisible()
    await page.getByRole('button', { name: /Connect Freighter/i }).click()

    await expect(
      page.locator('button', { hasText: 'Disconnect Wallet' })
    ).toBeVisible()
    await page.getByRole('link', { name: /Create Stream/i }).click()

    await expect(
      page.locator('h1', { hasText: 'Create New Stream' })
    ).toBeVisible()
    await expect(
      page.locator('label', { hasText: 'Recipient Address' })
    ).toBeVisible()
  })
})
