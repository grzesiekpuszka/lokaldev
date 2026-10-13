import { app } from "electron";
import { spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { UpdateState } from "../src/api";
import { config, installedPhp } from "./config";
import { binaryUpdates, download, extract } from "./install";
import { balloon } from "./tray";
import { exists, p, ROOT, versionKey } from "./util";
import { COMPONENTS, installedSeries } from "./versions";
import { t } from "../src/i18n";

const REPO = "grzesiekpuszka/lokaldev";
const DIR = p("tmp", "update");
const STATE = p("updates.json");
const DAY = 24 * 60 * 60 * 1000;
// next to the exe but not part of the package: never moved by an update
const KEEP = ["data", "www", "databases"];

type Saved = Omit<UpdateState, "current" | "downloaded"> & { zip?: string; sha?: string; notified?: string };

let saved: Saved = load();

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
  const newer = release && versionKey(release.version) > versionKey(current) ? release : null;
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
  if (res.ok) {
    const r = await res.json();
    const version = String(r.tag_name).replace(/^v/, "");
    const asset = (suffix: string) => r.assets.find((a: any) => a.name.endsWith(suffix))?.browser_download_url;
    zip = asset("-win-x64.zip");
    sha = asset("-win-x64.zip.sha256");
    if (zip && sha && versionKey(version) > versionKey(app.getVersion())) release = { version, notes: r.body ?? "", page: r.html_url };
  } else if (res.status !== 404) throw new Error(`GitHub: HTTP ${res.status}`); // 404 = no release published yet
  const binaries = await binaryUpdates(installedBinaries());
  save({ checked: new Date().toISOString(), app: release, binaries, zip, sha });
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
export async function downloadUpdate() {
  const release = updateState().app;
  if (!release || !saved.zip || !saved.sha) throw new Error(t("No update available"));
  fs.rmSync(DIR, { recursive: true, force: true });
  fs.mkdirSync(DIR, { recursive: true });
  const zip = path.join(DIR, "lokaldev.zip");
  await download(saved.zip, zip, "update");
  const expected = (await (await fetch(saved.sha, { headers: { "User-Agent": "lokaldev" } })).text()).trim().split(/\s+/)[0].toLowerCase();
  if ((await sha256(zip)) !== expected) {
    fs.rmSync(DIR, { recursive: true, force: true });
    throw new Error(t("The downloaded update is damaged (checksum mismatch). Try again."));
  }
  await extract(zip, path.join(DIR, "app"), "lokaldev.exe");
  fs.rmSync(zip, { force: true });
  fs.writeFileSync(path.join(DIR, "app.version"), release.version);
}

/**
 * Quits and lets a plain cmd script (no PowerShell — antivirus rule) swap the files once lokaldev has exited:
 * the app files the new package replaces go to data\tmp\update\backup, the new ones are copied in, the new exe starts. If anything
 * fails, the backup is put back and the old version starts.
 */
export function applyUpdate(running: string[]) {
  if (!downloaded()) throw new Error(t("Download the update first"));
  // services that run now start again in the new version
  fs.writeFileSync(path.join(DIR, "resume.json"), JSON.stringify(running));
  const backup = path.join(DIR, "backup");
  const keep = KEEP.map((d) => `if /i not "%%F"=="${d}"`).join(" ");
  // the new version starts with the same arguments (e.g. --hidden), minus one-shot actions
  const args = process.argv
    .slice(1)
    .filter((a) => !["--updated", "--update-failed", "--start-all", "--stop-all", "--quit"].includes(a))
    .map((a) => ` "${a.replace(/%/g, "%%")}"`)
    .join("");
  const script = `@echo off
setlocal
set "ROOT=${ROOT}"
set "NEW=${path.join(DIR, "app")}"
set "BACKUP=${backup}"
:wait
rem ping as a sleep: timeout needs a console
tasklist /FI "PID eq ${process.pid}" | find "${process.pid}" >nul && (ping -n 2 127.0.0.1 >nul & goto wait)
ping -n 3 127.0.0.1 >nul
if exist "%BACKUP%" rmdir /s /q "%BACKUP%"
mkdir "%BACKUP%"
rem only what the new package contains is replaced; folders the user keeps next to the exe stay
for /f "delims=" %%F in ('dir /b /a "%NEW%"') do ${keep} if exist "%ROOT%\\%%F" (
  move "%ROOT%\\%%F" "%BACKUP%\\" >nul || goto restore
)
robocopy "%NEW%" "%ROOT%" /E /R:3 /W:1 /NFL /NDL /NJH /NJS /NP >nul
if errorlevel 8 goto restore
start "" "%ROOT%\\lokaldev.exe" --updated${args}
exit /b 0
:restore
robocopy "%BACKUP%" "%ROOT%" /E /R:3 /W:1 /NFL /NDL /NJH /NJS /NP >nul
start "" "%ROOT%\\lokaldev.exe" --update-failed${args}
`;
  const file = path.join(DIR, "apply.cmd");
  fs.writeFileSync(file, script.replace(/\n/g, "\r\n"));
  spawn("cmd.exe", ["/d", "/c", file], { detached: true, stdio: "ignore", windowsHide: true }).unref();
  app.quit();
}

/**
 * On start: reports the result of an update and returns the services that ran before it; otherwise removes what the
 * previous update left (its backup is kept for one start).
 */
export function afterUpdate(): string[] {
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
