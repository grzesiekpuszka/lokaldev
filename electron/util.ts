import { app, BrowserWindow } from "electron";
import { execFile, spawn, type ChildProcess, type SpawnOptions } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";

export const ROOT = app.isPackaged ? path.dirname(process.execPath) : process.cwd();
export const DATA = path.join(ROOT, "data");
export const p = (...parts: string[]) => path.join(DATA, ...parts);
export const fwd = (s: string) => s.replace(/\\/g, "/");
export const exists = (f: string) => fs.existsSync(f);
export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

for (const d of ["bin/php", "etc", "db", "logs", "ssl", "shims", "tmp"]) fs.mkdirSync(p(d), { recursive: true });

export function emit(event: string, payload: unknown) {
  for (const w of BrowserWindow.getAllWindows()) w.webContents.send(event, payload);
}

export function errorText(e: unknown) {
  return e instanceof Error ? e.message : String(e);
}

/** Runs a program to completion; never rejects on a non-zero exit code. */
export function run(file: string, args: string[], opts: { cwd?: string; env?: NodeJS.ProcessEnv; timeout?: number } = {}) {
  return new Promise<{ code: number; out: string; stdout: string }>((resolve) => {
    execFile(file, args, { ...opts, windowsHide: true, maxBuffer: 64 << 20 }, (err, stdout, stderr) => {
      const code = err ? (typeof err.code === "number" ? err.code : 1) : 0;
      resolve({ code, stdout, out: `${stdout}${stderr}${err && !stdout && !stderr ? err.message : ""}` });
    });
  });
}

// PIDs of everything we spawn, persisted so a crashed session's leftovers can be cleaned up on next start.
const tracked = new Map<number, string>();
const saveTracked = () => fs.writeFileSync(p("run.json"), JSON.stringify([...tracked]));

export async function cleanupOrphans() {
  let list: [number, string][] = [];
  try {
    list = JSON.parse(fs.readFileSync(p("run.json"), "utf8"));
  } catch {}
  for (const [pid, image] of list) {
    const { out } = await run("tasklist", ["/FI", `PID eq ${pid}`, "/FO", "CSV", "/NH"]);
    if (out.toLowerCase().includes(`"${image.toLowerCase()}"`)) await killTree(pid);
  }
  saveTracked();
}

export function spawnLogged(file: string, args: string[], log: string, opts: SpawnOptions = {}): ChildProcess {
  const fd = fs.openSync(log, "a");
  const child = spawn(file, args, { ...opts, stdio: ["ignore", fd, fd], windowsHide: true });
  fs.closeSync(fd);
  if (child.pid) {
    const pid = child.pid;
    tracked.set(pid, path.basename(file));
    saveTracked();
    child.on("exit", () => {
      tracked.delete(pid);
      saveTracked();
    });
  }
  child.on("error", () => {});
  return child;
}

/** Runs a program elevated (UAC prompt) and waits for it to finish. */
export async function runElevated(file: string, args: string) {
  const command = `Start-Process '${file}' -Verb RunAs -Wait -WindowStyle Hidden -ArgumentList '${args.replace(/'/g, "''")}'`;
  await run("powershell", ["-NoProfile", "-Command", command]);
}

export const alive = (c?: ChildProcess) => !!c && c.exitCode === null && c.signalCode === null;

export async function killTree(pid?: number) {
  if (pid) await run("taskkill", ["/PID", String(pid), "/T", "/F"]);
}

export async function waitExit(c: ChildProcess, ms: number) {
  for (let t = 0; t < ms && alive(c); t += 200) await sleep(200);
  return !alive(c);
}

export function portOpen(port: number) {
  return new Promise<boolean>((resolve) => {
    const s = net.connect(port, "127.0.0.1");
    s.once("connect", () => (s.destroy(), resolve(true)));
    s.once("error", () => resolve(false));
  });
}

export async function waitPort(port: number, c: ChildProcess, ms: number) {
  for (let t = 0; t < ms; t += 250) {
    if (await portOpen(port)) return true;
    if (!alive(c)) return false;
    await sleep(250);
  }
  return false;
}

export function tail(file: string, lines = 10) {
  try {
    return fs.readFileSync(file, "utf8").trimEnd().split(/\r?\n/).slice(-lines).join("\n");
  } catch {
    return "";
  }
}

/** Error lines from the end of a log (falls back to the plain tail), so the cause isn't buried in notes. */
export function tailErrors(file: string) {
  const last = tail(file, 40).split("\n");
  const errors = last.filter((l) => /error|fatal|invalid|unrecognized|unknown/i.test(l));
  return (errors.length ? errors.slice(-6) : last.slice(-10)).join("\n");
}

export const slug = (s: string) =>
  s.toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "") || "app";

export const versionKey = (v: string) => v.split(".").map((n) => n.padStart(5, "0")).join(".");
