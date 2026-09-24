/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** The Cathode server this deployment offers, such as https://cathode.example.org. */
  readonly VITE_CATHODE_SERVER?: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}
