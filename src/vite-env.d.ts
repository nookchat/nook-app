/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_NOOK_SERVER?: string
  /** tldraw needs one for the whiteboards to work on a real domain. */
  readonly VITE_TLDRAW_LICENSE_KEY?: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}

/** The version in package.json. */
declare const __NOOK_VERSION__: string
/** The short commit it was built from, or empty. */
declare const __NOOK_COMMIT__: string

declare module 'virtual:twemoji' {
  /** Every Twemoji picture there is, by name, joined with commas. */
  const names: string
  export default names
}
