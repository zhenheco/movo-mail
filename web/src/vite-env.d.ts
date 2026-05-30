/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_DEFAULT_MAILBOX?: string;
  readonly VITE_DEFAULT_FROM?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
