import fs from "node:fs";
import path from "node:path";
import type { NodeRelease, NodeState } from "../src/api";
import { freshEnv, userValue } from "./env";
import { download } from "./install";
import { emit, exists, p, run, versionKey } from "./util";
import { t } from "../src/i18n";

const nvmHome = () => userValue("NVM_HOME");

let cache: { at: number; state: NodeState; exe: string } | undefined;

async function nvm() {
  if (!cache || Date.now() - cache.at > 30000) {
    const home = await nvmHome();
    const exe = path.join(home, "nvm.exe");
    const state: NodeState = { nvm: "missing", nvm_version: "", installed: [], default: "" };
    if (home && exists(exe)) {
      state.nvm_version = (await run(exe, ["-v"])).out.trim().replace(/^v/, "");
      state.nvm = Number(state.nvm_version.split(".")[0]) >= 2 ? "ok" : "old";
      const dir = exists(path.join(home, "installs")) ? path.join(home, "installs") : home;
      state.installed = fs
        .readdirSync(dir)
        .filter((d) => /^v\d+\.\d+\.\d+$/.test(d))
        .map((d) => d.slice(1))
        .sort((a, b) => versionKey(b).localeCompare(versionKey(a)));
      state.default = (await run(exe, ["default"])).out.match(/(\d+\.\d+\.\d+)/)?.[1] ?? "";
    }
    cache = { at: Date.now(), state, exe };
  }
  return cache;
}

export const nodeState = async () => (await nvm()).state;

async function nvmRun(...args: string[]) {
  const { exe, state } = await nvm();
  if (state.nvm === "missing") throw new Error(t("nvm for Windows isn't installed"));
  const r = await run(exe, args, { env: await freshEnv() });
  cache = undefined;
  if (r.code) throw new Error(r.out.trim() || t("nvm {args} failed", { args: args.join(" ") }));
}

/** The installer wipes the Node versions of an existing nvm 2.x: only run it when 1.x or no nvm is verified, right now. */
async function assertNoNvm2() {
  cache = undefined;
  const s = await nodeState();
  if (s.nvm === "ok") throw new Error(t("nvm for Windows 2.x is already installed"));
  if (s.nvm === "old" && !/^\d+\.\d+/.test(s.nvm_version)) throw new Error(t("Can't read the version of the installed nvm, so it isn't replaced."));
}

export async function nvmInstall() {
  await assertNoNvm2();
  const rel = await (await fetch("https://api.github.com/repos/nvm-windows/nvm/releases/latest")).json();
  const asset = rel.assets.find((a: { name: string }) => /-x64-setup\.exe$/.test(a.name));
  if (!asset) throw new Error(t("Couldn't find the nvm for Windows installer"));
  const file = p("tmp", asset.name);
  await download(asset.browser_download_url, file, "nvm");
  // it may have been installed meanwhile
  await assertNoNvm2().catch((e) => {
    fs.rmSync(file, { force: true });
    throw e;
  });
  emit("progress", { id: "nvm", stage: "install" });
  const r = await run(file, ["/VERYSILENT", "/SUPPRESSMSGBOXES", "/NORESTART", "/SP-"]);
  fs.rmSync(file, { force: true });
  cache = undefined;
  if ((await nodeState()).nvm !== "ok") throw new Error(t("nvm installation failed (code {code})", { code: r.code }));
}

export async function nodeReleases(): Promise<NodeRelease[]> {
  const list: { version: string; lts: string | false; date: string }[] = await (
    await fetch("https://nodejs.org/dist/index.json")
  ).json();
  const seen = new Set<string>();
  return list
    .filter((r) => Number(r.version.slice(1).split(".")[0]) >= 18)
    .filter((r) => !seen.has(r.version.split(".")[0]) && seen.add(r.version.split(".")[0]))
    .map((r) => ({ version: r.version.slice(1), lts: r.lts || null, date: r.date }));
}

export async function nodeInstall(version: string) {
  emit("progress", { id: `node-${version}`, stage: "install" });
  await nvmRun("install", version);
}

export const nodeUninstall = (version: string) => nvmRun("uninstall", version);
export const nodeDefault = (version: string) => nvmRun("use", version);

/** Pins the project's Node version in .nvmrc (read by nvm's shims), or removes the pin. */
export function pinNode(dir: string, version: string) {
  const file = path.join(dir, ".nvmrc");
  if (version) fs.writeFileSync(file, `${version}\n`);
  else fs.rmSync(file, { force: true });
}
