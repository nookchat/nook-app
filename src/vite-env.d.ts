/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_NOOK_SERVER?: string
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
