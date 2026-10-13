import fs from "node:fs";
import path from "node:path";
import type { JsTool } from "../src/api";
import { freshPath, setUserEnv, setUserPath, userValue } from "./env";
import { download, extract } from "./install";
import { emit, exists, p, run } from "./util";
import { t } from "../src/i18n";

// Official release zips; each tool is extracted to data\bin\<tool> and that folder is added to the user PATH.
const RELEASES: Record<JsTool, { repo: string; asset: string; exe: string }> = {
  pnpm: { repo: "pnpm/pnpm", asset: "pnpm-win32-x64.zip", exe: "pnpm.exe" },
  deno: { repo: "denoland/deno", asset: "deno-x86_64-pc-windows-msvc.zip", exe: "deno.exe" },
  bun: { repo: "oven-sh/bun", asset: "bun-windows-x64.zip", exe: "bun.exe" },
};

const dir = (tool: JsTool) => p("bin", tool);

let cache: { at: number; value: Record<JsTool, { version: string | null; managed: boolean }> } | undefined;

/** Version of each tool: ours from data\bin, otherwise whatever a fresh terminal would find on PATH. */
export async function jsTools() {
  if (!cache || Date.now() - cache.at > 30000) {
    const env = { ...process.env, PATH: await freshPath() };
    const entries = await Promise.all(
      (Object.keys(RELEASES) as JsTool[]).map(async (t) => {
        if (exists(path.join(dir(t), ".version"))) {
          return [t, { version: fs.readFileSync(path.join(dir(t), ".version"), "utf8").trim(), managed: true }] as const;
        }
        const r = await run("cmd.exe", ["/d", "/c", `${t} --version`], { env, timeout: 15000 });
        return [t, { version: r.code ? null : (r.stdout.match(/\d+\.\d+\.\d+/)?.[0] ?? null), managed: false }] as const;
      }),
    );
    cache = { at: Date.now(), value: Object.fromEntries(entries) as Record<JsTool, { version: string | null; managed: boolean }> };
  }
  return cache.value;
}

export async function installTool(tool: JsTool) {
  const { repo, asset, exe } = RELEASES[tool];
  const rel = await (await fetch(`https://api.github.com/repos/${repo}/releases/latest`)).json();
  const url = rel.assets?.find((a: { name: string }) => a.name === asset)?.browser_download_url;
  if (!url) throw new Error(t("Couldn't find {asset} in {repo}", { asset, repo }));
  const zip = p("tmp", asset);
  await download(url, zip, `tool-${tool}`);
  emit("progress", { id: `tool-${tool}`, stage: "extract" });
  try {
    await extract(zip, dir(tool), exe);
  } finally {
    fs.rmSync(zip, { force: true });
  }
  fs.writeFileSync(path.join(dir(tool), ".version"), String(rel.tag_name).replace(/^(bun-)?v/, ""));
  await setUserPath(dir(tool), true);
  // pnpm keeps global packages in PNPM_HOME, which has to be set and on PATH
  if (tool === "pnpm" && !(await userValue("PNPM_HOME"))) await setUserEnv("PNPM_HOME", dir(tool));
  cache = undefined;
}

export async function uninstallTool(tool: JsTool) {
  await setUserPath(dir(tool), false);
  if (tool === "pnpm" && (await userValue("PNPM_HOME")).toLowerCase() === dir(tool).toLowerCase()) await setUserEnv("PNPM_HOME", null);
  fs.rmSync(dir(tool), { recursive: true, force: true });
  cache = undefined;
}
