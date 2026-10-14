import { app } from "electron";
import { spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { UpdateState } from "../src/api";
import { config, installedPhp } from "./config";
import { binaryUpdates, download, extract } from "./install";
import { balloon } from "./tray";
import { exists, p, ROOT } from "./util";
import { COMPONENTS, installedSeries } from "./versions";
import { t } from "../src/i18n";

const REPO = "grzesiekpuszka/lokaldev";
const DIR = p("tmp", "update");
const STATE = p("updates.json");
const DAY = 24 * 60 * 60 * 1000;

type Saved = Omit<UpdateState, "current" | "downloaded"> & { zip?: string; sha?: string; notified?: string };

let saved: Saved = load();

/** SemVer precedence of lokaldev versions: 1.0.1-beta.5 < 1.0.1 < 1.0.2-alpha; build metadata (+…) is ignored. */
export function newerVersion(a: string, b: string) {
  const parse = (v: string) => {
    const [main, pre] = v.split("+")[0].split(/-(.*)/s);
    return { nums: main.split(".").map(Number), pre: pre ? pre.split(".") : [] };
  };
  const x = parse(a);
  const y = parse(b);
  for (let i = 0; i < 3; i++) if ((x.nums[i] ?? 0) !== (y.nums[i] ?? 0)) return (x.nums[i] ?? 0) > (y.nums[i] ?? 0);
  if (!x.pre.length || !y.pre.length) return !x.pre.length && !!y.pre.length;
  for (let i = 0; i < Math.max(x.pre.length, y.pre.length); i++) {
    const [p, q] = [x.pre[i], y.pre[i]];
    if (p === undefined || q === undefined) return q === undefined;
    if (p === q) continue;
    const [pn, qn] = [/^\d+$/.test(p), /^\d+$/.test(q)];
    if (pn && qn) return Number(p) > Number(q);
    if (pn !== qn) return qn; // numeric identifiers sort before alphanumeric ones
    return p > q;
  }
  return false;
}

function load(): Saved {
  try {
    return JSON.parse(fs.readFileSync(STATE, "utf8"));
  } catch {
    return { checked: null, app: null, binaries: {} };
  }
}

function save(patch: Partial<Saved>) {
  saved = { ...saved, ...patch };
  fs.writeFileSync(STATE, JSON.stringify(saved, null, 2));
}

const downloaded = () => !!saved.app && exists(path.join(DIR, "app", "lokaldev.exe")) && readText(path.join(DIR, "app.version")) === saved.app.version;
const readText = (file: string) => (exists(file) ? fs.readFileSync(file, "utf8").trim() : "");

export function updateState(): UpdateState {
  const { checked, app: release, binaries } = saved;
  // an update installed meanwhile (or a manual copy) makes a stored release stale
  const current = app.getVersion();
  const newer = release && newerVersion(release.version, current) ? release : null;
  return { current, checked, app: newer, binaries, downloaded: !!newer && downloaded() };
}

function installedBinaries() {
  const php = installedPhp().map((series) => ({ what: "php", series, version: readText(p("bin", "php", series, ".version")) }));
  const components = COMPONENTS.flatMap((what) => installedSeries(what).map((x) => ({ what, ...x })));
  return [...php, ...components].filter((x) => x.version);
}

/** Looks for a new lokaldev release and newer binaries; a new app version is announced once in the tray. */
export async function checkUpdates() {
  const res = await fetch(`https://api.github.com/repos/${REPO}/releases/latest`, { headers: { "User-Agent": "lokaldev", Accept: "application/vnd.github+json" } });
  let release: Saved["app"] = null;
  let zip: string | undefined;
  let sha: string | undefined;
  let incomplete = false;
  if (res.ok) {
    const r = await res.json();
    const version = String(r.tag_name).replace(/^v/, "");
    const asset = (suffix: string) => r.assets.find((a: any) => a.name.endsWith(suffix))?.browser_download_url;
    zip = asset("-win-x64.zip");
    sha = asset("-win-x64.zip.sha256");
    if (zip && sha && newerVersion(version, app.getVersion())) release = { version, notes: r.body ?? "", page: r.html_url };
    // a release still getting its files: look again at the next hourly tick instead of tomorrow
    else if (newerVersion(version, app.getVersion())) incomplete = true;
  } else if (res.status !== 404) throw new Error(`GitHub: HTTP ${res.status}`); // 404 = no release published yet
  const binaries = await binaryUpdates(installedBinaries());
  save({ checked: incomplete ? saved.checked : new Date().toISOString(), app: release, binaries, zip, sha });
  if (release && saved.notified !== release.version) {
    balloon(t("lokaldev {version} is available.", { version: release.version }));
    save({ notified: release.version });
  }
  return updateState();
}

/** At most once a day, while "Check for updates automatically" is on. */
export function scheduleChecks(onChange: () => void) {
  const tick = () => {
    if (!config().update_check) return;
    if (saved.checked && Date.now() - Date.parse(saved.checked) < DAY) return;
    checkUpdates().then(onChange, () => {});
  };
  setTimeout(tick, 15000);
  setInterval(tick, 60 * 60 * 1000);
}

/** A binary that was just updated (or removed) no longer counts. */
export function forgetBinary(what: string, series: string) {
  const { [`${what}/${series}`]: _, ...rest } = saved.binaries;
  save({ binaries: rest });
}

async function sha256(file: string) {
  const hash = crypto.createHash("sha256");
  for await (const chunk of fs.createReadStream(file)) hash.update(chunk as Buffer);
  return hash.digest("hex");
}

/** Downloads and unpacks the new version into data\tmp\update\app; nothing of the running app is touched. */
export function downloadUpdate() {
  downloading ??= fetchUpdate().finally(() => (downloading = null));
  return downloading;
}
let downloading: Promise<void> | null = null;

async function fetchUpdate() {
  // one consistent release: a check during the download may already see a newer one
  const release = updateState().app;
  const { zip: zipUrl, sha: shaUrl } = saved;
  if (!release || !zipUrl || !shaUrl) throw new Error(t("No update available"));
  fs.rmSync(DIR, { recursive: true, force: true });
  fs.mkdirSync(DIR, { recursive: true });
  const zip = path.join(DIR, "lokaldev.zip");
  await download(zipUrl, zip, "update");
  const expected = (await (await fetch(shaUrl, { headers: { "User-Agent": "lokaldev" } })).text()).trim().split(/\s+/)[0].toLowerCase();
  if ((await sha256(zip)) !== expected) {
    fs.rmSync(DIR, { recursive: true, force: true });
    throw new Error(t("The downloaded update is damaged (checksum mismatch). Try again."));
  }
  await extract(zip, path.join(DIR, "app"), "lokaldev.exe");
  fs.rmSync(zip, { force: true });
  fs.writeFileSync(path.join(DIR, "app.version"), release.version);
}

/**
 * Quits and lets updater.exe (window-less, from shim/updater.cs) swap the files once lokaldev has exited: the entries
 * the new package contains go to data\tmp\update\backup, the new ones are copied in, the new exe starts. If anything
 * fails, the backup is put back and the old version starts. It runs from a copy, as the app folder gets replaced.
 */
export function applyUpdate(running: string[]) {
  if (!downloaded()) throw new Error(t("Download the update first"));
  // services that run now start again in the new version
  fs.writeFileSync(path.join(DIR, "resume.json"), JSON.stringify(running));
  const updater = path.join(DIR, "updater.exe");
  fs.copyFileSync(app.isPackaged ? path.join(process.resourcesPath, "updater.exe") : path.join(ROOT, "resources", "updater.exe"), updater);
  // the new version starts with the same arguments (e.g. --hidden), minus one-shot actions
  const args = process.argv.slice(1).filter((a) => !["--updated", "--update-failed", "--start-all", "--stop-all", "--quit"].includes(a));
  spawn(updater, [ROOT, path.join(DIR, "app"), path.join(DIR, "backup"), String(process.pid), ...args], { detached: true, stdio: "ignore" }).unref();
  app.quit();
}

/**
 * On start: reports the result of an update and returns the services that ran before it; otherwise removes what the
 * previous update left (its backup is kept for one start).
 */
export function afterUpdate(): string[] {
  // files the updater couldn't put back stay out of data\tmp, so nothing cleans them up before a manual restore
  if (exists(path.join(DIR, "rollback-failed"))) {
    const keep = p(`update-backup-${Date.now()}`);
    fs.renameSync(DIR, keep);
    balloon(t("The update failed and not all files of the previous version could be restored. They are in {dir} (see update.log).", { dir: keep }));
    return [];
  }
  const updated = process.argv.includes("--updated");
  if (!updated && !process.argv.includes("--update-failed")) {
    fs.rmSync(DIR, { recursive: true, force: true });
    return [];
  }
  balloon(updated ? t("Updated to lokaldev {version}.", { version: app.getVersion() }) : t("The update couldn't be installed; the previous version was restored."));
  try {
    return JSON.parse(fs.readFileSync(path.join(DIR, "resume.json"), "utf8"));
  } catch {
    return [];
  }
}
