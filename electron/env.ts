import { run } from "./util";

const USER = "HKCU\\Environment";
const MACHINE = "HKLM\\SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Environment";

/** Reads a raw (unexpanded) environment value from the registry. */
export async function regValue(key: string, name: string) {
  const { stdout } = await run("reg", ["query", key, "/v", name]);
  return stdout.match(new RegExp(`${name}\\s+REG_(?:EXPAND_)?SZ\\s+(.*)`, "i"))?.[1]?.trim() ?? "";
}

export const expand = (s: string) => s.replace(/%([^%]+)%/g, (m, v) => process.env[v] ?? m);

export const userValue = async (name: string) => expand((await regValue(USER, name)) || (await regValue(MACHINE, name)));

/** PATH as a freshly opened terminal would see it (the app's own env may be stale). */
export async function freshPath() {
  const [machine, user] = await Promise.all([regValue(MACHINE, "Path"), regValue(USER, "Path")]);
  return expand(`${machine};${user}`);
}

// setx broadcasts WM_SETTINGCHANGE so new terminals pick up registry edits; the dummy variable is removed right away.
async function broadcast() {
  await run("setx", ["LOKAL_PING", "1"]);
  await run("reg", ["delete", USER, "/v", "LOKAL_PING", "/f"]);
}

export async function setUserEnv(name: string, value: string | null) {
  const r =
    value === null
      ? await run("reg", ["delete", USER, "/v", name, "/f"])
      : await run("reg", ["add", USER, "/v", name, "/t", "REG_EXPAND_SZ", "/d", value, "/f"]);
  if (r.code && value !== null) throw new Error(r.out);
  await broadcast();
}

const same = (a: string, b: string) => a.replace(/\\+$/, "").toLowerCase() === b.replace(/\\+$/, "").toLowerCase();

export async function inUserPath(dir: string) {
  return (await regValue(USER, "Path")).split(";").some((x) => same(x, dir));
}

/** Adds (at the front) or removes a folder in the user PATH, keeping the rest of the value untouched. */
export async function setUserPath(dir: string, enabled: boolean) {
  const parts = (await regValue(USER, "Path")).split(";").filter((x) => x && !same(x, dir));
  if (enabled) parts.unshift(dir);
  await setUserEnv("Path", parts.join(";"));
}
