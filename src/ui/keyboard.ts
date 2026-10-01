/**
 * The keyboard on a phone. iOS lays it over the page and slides the page up under it, so the
 * page takes the height that is left, and the bottom inset for the home bar goes while the
 * keyboard covers it: the message box then sits right on the keyboard, not a gap above it.
 */
export function fitKeyboard(): void {
  const view = window.visualViewport
  if (!view) return
  const root = document.documentElement
  /**
   * The tallest the view has been at each width: the height with no keyboard. A browser that
   * resizes the page for the keyboard (Android, and Safari that follows interactive-widget)
   * makes the window as short as the view, so the window's height alone cannot tell.
   */
  const tallest = new Map<number, number>()
  const fit = (): void => {
    const width = Math.round(window.innerWidth)
    const full = Math.max(tallest.get(width) ?? 0, view.height, window.innerHeight)
    tallest.set(width, full)
    // Zoomed in, the view is small for another reason. A computer's window is short for its own.
    const open =
      window.matchMedia('(pointer: coarse)').matches && Math.abs(view.scale - 1) < 0.01 && view.height < full - 120
    root.classList.toggle('keyboard-open', open)
    if (open) {
      root.style.setProperty('--app-height', `${Math.round(view.height)}px`)
      // iOS scrolls the page to show the box; the page is already the right height, so it stays put.
      if (window.scrollY !== 0) window.scrollTo(0, 0)
    } else {
      root.style.removeProperty('--app-height')
    }
  }
  view.addEventListener('resize', fit)
  view.addEventListener('scroll', fit)
  fit()
}

/** On a touch screen, the message box asks the keyboard for no suggestions and no corrections. */
export function quietKeyboard(box: HTMLTextAreaElement | HTMLInputElement): void {
  if (!window.matchMedia('(pointer: coarse)').matches) return
  box.setAttribute('autocomplete', 'off')
  box.setAttribute('autocorrect', 'off')
  box.spellcheck = false
}
