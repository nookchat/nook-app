/**
 * The steps every sharing check starts with, in one place.
 *
 * A screen is shared from voice, the invite is in the space's menu, and a
 * viewer watches by choosing the stream. Three clicks each that used to be
 * one, so they live here rather than in every file.
 */

/** Make a space, stand in the lounge, share, and return the invite link. */
export async function hostAndShare(host) {
  await host.getByRole('button', { name: 'New space' }).click()
  await host.click('.voice-channel .rail-item:has-text("lounge")', { timeout: 15_000 })
  await host.waitForSelector('.voice-bar:not(.hidden)', { timeout: 15_000 })
  await host.click('button[aria-label="Share screen"]')
  await host.click('.space-title-button')
  await host.click('.menu-item:has-text("Invite")')
  const box = host.locator('.share-code')
  await box.waitFor({ timeout: 15_000 })
  const link = await box.getAttribute('data-link')
  await host.keyboard.press('Escape')
  return link
}

/** Open the link and pick the first stream offered. */
export async function joinAndWatch(viewer, link, timeoutMs = 30_000) {
  await viewer.goto(link, { waitUntil: 'domcontentloaded' })
  await viewer.waitForSelector('.stream-tab[data-watch="peer"]', { timeout: timeoutMs })
  await viewer.click('.stream-tab[data-watch="peer"]')
}
