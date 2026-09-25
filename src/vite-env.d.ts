/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_CATHODE_SERVER?: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}
