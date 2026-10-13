// Dev loop: Vite for the UI, esbuild for the main process, Electron pointed at the dev server.
import { spawn, execSync } from "node:child_process";
import { createServer } from "vite";

const server = await createServer();
await server.listen();
const url = server.resolvedUrls.local[0];

execSync("pnpm build:main", { stdio: "inherit" });
const electron = spawn("pnpm", ["exec", "electron", "."], {
  stdio: "inherit",
  shell: true,
  env: { ...process.env, ELECTRON_RENDERER_URL: url },
});
electron.on("exit", async (code) => {
  await server.close();
  process.exit(code ?? 0);
});
