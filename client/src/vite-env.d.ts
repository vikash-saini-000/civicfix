/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_CIVICFIX_API_MODE?: string;
  readonly VITE_CIVICFIX_API_BASE_URL?: string;
  readonly VITE_CIVICFIX_API_TIMEOUT_MS?: string;
  readonly VITE_CIVICFIX_AUTH_MODE?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
