/**
 * The keyboard on a phone. iOS lays it over the page and slides the page up under it, so the
 * page takes the height that is left, and the bottom inset for the home bar goes while the
 * keyboard covers it: the message box then sits right on the keyboard, not a gap above it.
 */
export function fitKeyboard(): void {
  const view = window.visualViewport
  if (!view) return
  const root = document.documentElement
  const fit = (): void => {
    // Zoomed in, the view is small for another reason.
    const open = Math.abs(view.scale - 1) < 0.01 && view.height < window.innerHeight - 120
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
