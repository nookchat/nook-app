/**
 * Everybody a check opens has chosen a name already.
 *
 * Somebody new is asked for a name before anything else (src/ui/welcome.ts).
 * A check about something else does not want to stop at that, so every page
 * this browser opens gets a name of its own, different for each context,
 * before the app looks. e2e.mjs goes through the question itself.
 */

export function nameEveryone(browser) {
  const newContext = browser.newContext.bind(browser)
  browser.newContext = async (...args) => {
    const context = await newContext(...args)
    await context.addInitScript((name) => {
      if (!localStorage.getItem('cathode.name.v1')) localStorage.setItem('cathode.name.v1', name)
    }, `Tester ${Math.random().toString(36).slice(2, 6)}`)
    return context
  }
  browser.newPage = async (...args) => (await browser.newContext(...args)).newPage()
  return browser
}
