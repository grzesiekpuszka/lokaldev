import fs from "node:fs";
import path from "node:path";
import type { ComponentId } from "../src/api";
import { config } from "./config";
import { exists, p, ROOT, versionKey } from "./util";

export const COMPONENTS: ComponentId[] = [
  "apache", "nginx", "mysql", "mariadb", "postgres", "mongodb", "redis", "memcached", "mailpit", "phpmyadmin", "composer",
  "wpcli", "git", "python", "sqlite",
];
type DataEngine = "mysql" | "mariadb" | "postgres" | "mongodb";

/** Release line a version belongs to: installs of one series replace each other, different series live side by side. */
export function seriesOf(id: ComponentId, version: string) {
  const parts = version.split(".");
  if (id === "postgres" || id === "mailpit" || id === "sqlite" || id === "wpcli") return parts[0];
  if (id === "composer") return version.startsWith("2.2.") ? "2.2" : parts[0];
  return parts.slice(0, 2).join(".");
}

const readVersion = (dir: string) => {
  try {
    return fs.readFileSync(path.join(dir, ".version"), "utf8").trim();
  } catch {
    return null;
  }
};

/** Installed series of a component, newest first. */
export function installedSeries(id: ComponentId) {
  const root = p("bin", id);
  if (!exists(root)) return [];
  return fs
    .readdirSync(root)
    .filter((series) => /^\d+(\.\d+)*$/.test(series)) // not 11.4.old/.new/.tmp left by an update
    .map((series) => ({ series, version: readVersion(path.join(root, series)) }))
    .filter((x): x is { series: string; version: string } => !!x.version)
    .sort((a, b) => versionKey(b.series).localeCompare(versionKey(a.series)));
}

/** The series in use: the one chosen in the config if still installed, else the newest. */
export function activeSeries(id: ComponentId, chosen = config().versions[id]) {
  const installed = installedSeries(id);
  return installed.find((x) => x.series === chosen)?.series ?? installed[0]?.series ?? null;
}

export const activeVersion = (id: ComponentId) => {
  const series = activeSeries(id);
  return series ? readVersion(p("bin", id, series)) : null;
};

export const seriesDir = (id: ComponentId, series: string) => p("bin", id, series);
/** Root of all database data (Settings → Databases → data folder, default: "databases" next to the exe); a subfolder per service and version. */
export const DEFAULT_DB_ROOT = path.join(ROOT, "databases");
export const dbRoot = (dir = config().db_dir) => dir || DEFAULT_DB_ROOT;
export const seriesDataDir = (engine: DataEngine, series: string) => path.join(dbRoot(), `${engine}-${series}`);

/** Folder of the active series (points to a missing folder when nothing is installed). */
export const binDir = (id: ComponentId) => p("bin", id, activeSeries(id) ?? "none");

/** Databases keep a data folder per series: data files aren't compatible across major versions. */
export const dataDir = (engine: DataEngine) => seriesDataDir(engine, activeSeries(engine) ?? "none");

/** Moves installs from the old single-version layout (bin\<id>\...) to bin\<id>\<series>\..., data folders likewise. */
export function migrateLayout() {
  // databases used to live in data\db
  if (!config().db_dir && exists(p("db")) && !exists(DEFAULT_DB_ROOT)) fs.renameSync(p("db"), DEFAULT_DB_ROOT);
  for (const id of COMPONENTS) {
    const root = p("bin", id);
    const version = readVersion(root);
    if (!version) continue;
    const tmp = `${root}.migrating`;
    fs.renameSync(root, tmp);
    fs.mkdirSync(root);
    fs.renameSync(tmp, path.join(root, seriesOf(id, version)));
  }
  for (const engine of ["mysql", "mariadb", "postgres"] as const) {
    const old = path.join(dbRoot(), engine);
    if (exists(old) && activeSeries(engine) && !exists(dataDir(engine))) fs.renameSync(old, dataDir(engine));
  }
}
