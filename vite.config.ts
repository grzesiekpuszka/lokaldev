import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

// the built app loads nothing from outside (the dev server needs inline scripts and websockets, so no CSP there)
const csp = {
  name: "csp",
  apply: "build" as const,
  transformIndexHtml: (html: string) =>
    html.replace(
      "<head>",
      `<head>
    <meta http-equiv="Content-Security-Policy" content="default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; form-action 'none'" />`,
    ),
};

export default defineConfig({
  plugins: [react(), tailwindcss(), csp],
  base: "./",
  build: { outDir: "out/renderer", emptyOutDir: true },
  server: { port: 5173, strictPort: true },
});
