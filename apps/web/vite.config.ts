import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// Static assets for the hub to serve same-origin (decision 0017). No inline
// scripts: the entry is a module file, so the hub's CSP needs no 'unsafe-inline'.
export default defineConfig({
  plugins: [react(), tailwindcss()],
  build: {
    outDir: "dist",
    emptyOutDir: true,
    // noVNC 1.7 uses top-level await.
    target: "es2022",
    // Keep every asset a file: a data: URL script or font would need a CSP exception.
    assetsInlineLimit: 0,
    modulePreload: { polyfill: false },
  },
  server: {
    // `bun run dev:hub` on the default port, proxied so the UI stays same-origin.
    proxy: { "/v1": { target: "http://127.0.0.1:8787", ws: true } },
  },
});
