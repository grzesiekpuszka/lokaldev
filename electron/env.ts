import { run } from "./util";

const USER = "HKCU\\Environment";
const MACHINE = "HKLM\\SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Environment";

/** Raw (unexpanded) environment values of a registry key. */
async function regValues(key: string) {
  const { stdout } = await run("reg", ["query", key]);
  const values = new Map<string, string>(); // lowercase name → value
  for (const line of stdout.split(/\r?\n/)) {
    const m = line.match(/^ {4}(.+?) {4}REG_(?:EXPAND_)?SZ {4}(.*)$/);
    if (m) values.set(m[1].toLowerCase(), m[2].trim());
  }
  return values;
}

/** Reads a raw (unexpanded) environment value from the registry. */
export const regValue = async (key: string, name: string) => (await regValues(key)).get(name.toLowerCase()) ?? "";

/**
 * The environment a freshly opened terminal would get: the app's own env plus the current machine and user variables
 * from the registry (a tool installed while lokaldev runs may have added or moved some), with %VAR% expanded.
 */
export async function freshEnv(): Promise<NodeJS.ProcessEnv> {
  const [machine, user] = await Promise.all([regValues(MACHINE), regValues(USER)]);
  const vars = new Map(Object.entries(process.env).map(([k, v]) => [k.toLowerCase(), v ?? ""]));
  for (const [k, v] of [...machine, ...user]) if (k !== "path") vars.set(k, v);
  vars.set("path", `${machine.get("path") ?? ""};${user.get("path") ?? ""}`);
  // values can refer to each other (PATH → %NVM_HOME% → %APPDATA%); a few rounds cover real setups
  for (let i = 0; i < 3; i++) for (const [k, v] of vars) vars.set(k, v.replace(/%([^%]+)%/g, (m, name) => vars.get(name.toLowerCase()) ?? m));
  // keep the spelling of names the app already has (e.g. "Path"), so children don't get two of them
  const env: NodeJS.ProcessEnv = {};
  const names = new Map(Object.keys(process.env).map((k) => [k.toLowerCase(), k]));
  for (const [k, v] of vars) env[names.get(k) ?? k.toUpperCase()] = v;
  return env;
}

const pathKey = (env: NodeJS.ProcessEnv) => Object.keys(env).find((k) => k.toLowerCase() === "path") ?? "PATH";

/** freshEnv() with folders put in front of its PATH. */
export async function freshEnvWith(...dirs: string[]) {
  const env = await freshEnv();
  const key = pathKey(env);
  env[key] = [...dirs, env[key]].join(";");
  return env;
}

/** PATH as a freshly opened terminal would see it. */
export const freshPath = async () => {
  const env = await freshEnv();
  return env[pathKey(env)] ?? "";
};

/** A user (or else machine) variable from the registry, expanded; "" when it isn't set there. */
export async function userValue(name: string) {
  if (!(await regValue(USER, name)) && !(await regValue(MACHINE, name))) return "";
  const env = await freshEnv();
  return env[Object.keys(env).find((k) => k.toLowerCase() === name.toLowerCase()) ?? name] ?? "";
}

// setx broadcasts WM_SETTINGCHANGE so new terminals pick up registry edits; the dummy variable is removed right away.
async function broadcast() {
  await run("setx", ["LOKAL_PING", "1"]);
  await run("reg", ["delete", USER, "/v", "LOKAL_PING", "/f"]);
}

// registry edits are read-modify-write: one at a time, or a parallel install would undo the other's change
let lock: Promise<unknown> = Promise.resolve();
const locked = <T>(fn: () => Promise<T>) => {
  const next = lock.then(fn, fn);
  lock = next.catch(() => {});
  return next;
};

async function writeUserEnv(name: string, value: string | null) {
  const r =
    value === null
      ? await run("reg", ["delete", USER, "/v", name, "/f"])
      : await run("reg", ["add", USER, "/v", name, "/t", "REG_EXPAND_SZ", "/d", value, "/f"]);
  if (r.code && value !== null) throw new Error(r.out);
  await broadcast();
}

export const setUserEnv = (name: string, value: string | null) => locked(() => writeUserEnv(name, value));

const same = (a: string, b: string) => a.replace(/\\+$/, "").toLowerCase() === b.replace(/\\+$/, "").toLowerCase();

export async function inUserPath(dir: string) {
  return (await regValue(USER, "Path")).split(";").some((x) => same(x, dir));
}

/** Adds (at the front) or removes a folder in the user PATH, keeping the rest of the value untouched. */
export const setUserPath = (dir: string, enabled: boolean) =>
  locked(async () => {
    const parts = (await regValue(USER, "Path")).split(";").filter((x) => x && !same(x, dir));
    if (enabled) parts.unshift(dir);
    await writeUserEnv("Path", parts.join(";"));
  });
