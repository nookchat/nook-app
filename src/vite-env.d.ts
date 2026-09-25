/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_NOOK_SERVER?: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}
