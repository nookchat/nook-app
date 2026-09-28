/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_NOOK_SERVER?: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}

declare module 'virtual:twemoji' {
  /** Every Twemoji picture there is, by name, joined with commas. */
  const names: string
  export default names
}
