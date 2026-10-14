import path from "node:path";
import type { DbFamily, DbInstance } from "../src/api";
import { config, projects, saveConfig } from "./config";
import { exists } from "./util";
import { t } from "../src/i18n";
import { activeSeries, installedSeries, seriesDir } from "./versions";

export type Engine = "mysql" | "mariadb" | "postgres";

const ENGINES: Engine[] = ["mariadb", "mysql", "postgres"];
export const LABELS: Record<Engine, string> = { mysql: "MySQL", mariadb: "MariaDB", postgres: "PostgreSQL" };
const basePort = (family: DbFamily) => config().ports[family];

export const familyOf = (engine: Engine): DbFamily => (engine === "postgres" ? "postgres" : "mysql");

/** "mariadb-11.4" → engine + series. */
export function parseInstance(id: string) {
  const engine = ENGINES.find((e) => id.startsWith(`${e}-`));
  return engine ? { engine, series: id.slice(engine.length + 1) } : null;
}

/** The default instance of a family: the default MySQL-compatible engine and PostgreSQL, each on its configured port. */
export function defaultInstanceId(family: DbFamily) {
  const engine: Engine = family === "postgres" ? "postgres" : config().db_engine;
  const series = activeSeries(engine);
  return series ? `${engine}-${series}` : null;
}

/** Stable port for a non-default instance: the next free one after the family's port, allocated once and kept in the config. */
function allocatedPort(id: string, family: DbFamily) {
  const cfg = config();
  if (cfg.db_ports[id]) return cfg.db_ports[id];
  const used = new Set([...Object.values(cfg.db_ports), ...Object.values(cfg.ports)]);
  let port = basePort(family) + 1;
  while (used.has(port)) port++;
  if (port > 65535) throw new Error(t("No free port for {name}", { name: id }));
  saveConfig({ ...cfg, db_ports: { ...cfg.db_ports, [id]: port } });
  return port;
}

/** Resolves an instance id to an installed server; null when that engine/series isn't installed. */
export function instance(id: string): Omit<DbInstance, "running" | "used"> | null {
  const parsed = parseInstance(id);
  const installed = parsed && installedSeries(parsed.engine).find((x) => x.series === parsed.series);
  if (!parsed || !installed) return null;
  const family = familyOf(parsed.engine);
  const isDefault = defaultInstanceId(family) === id;
  return {
    id,
    engine: parsed.engine,
    series: parsed.series,
    version: installed.version,
    family,
    port: isDefault ? basePort(family) : allocatedPort(id, family),
    default: isDefault,
  };
}

export type Instance = NonNullable<ReturnType<typeof instance>>;

/** Every installed database series, defaults first. */
export function allInstances(): Instance[] {
  return ENGINES.flatMap((engine) => installedSeries(engine).map((x) => instance(`${engine}-${x.series}`)!)).sort(
    (a, b) => Number(b.default) - Number(a.default),
  );
}

/** Instance a project uses: its own setting, or the default MySQL-compatible one. */
export const projectInstanceId = (dbSetting: string | undefined) => dbSetting || defaultInstanceId("mysql");

/** Instances that "Start all" brings up: the defaults plus every instance chosen by a project. */
export function usedInstanceIds() {
  const ids = new Set<string>();
  for (const family of ["mysql", "postgres"] as const) {
    const id = defaultInstanceId(family);
    if (id) ids.add(id);
  }
  for (const x of projects()) if (x.db && instance(x.db)) ids.add(x.db);
  return ids;
}

/** Binary of a database instance; MariaDB ships mariadb-* names, older builds also the mysql* ones. */
export function instanceBin(inst: Pick<Instance, "engine" | "series">, tool: string) {
  const MARIADB_NAMES: Record<string, string> = { mysqld: "mariadbd", mysqladmin: "mariadb-admin", mysql: "mariadb", mysqldump: "mariadb-dump" };
  const bin = path.join(seriesDir(inst.engine, inst.series), "bin");
  const file = path.join(bin, `${tool}.exe`);
  return inst.engine === "mariadb" && !exists(file) && MARIADB_NAMES[tool] ? path.join(bin, `${MARIADB_NAMES[tool]}.exe`) : file;
}

export const instanceLabel = (inst: Pick<Instance, "engine" | "series">) => `${LABELS[inst.engine]} ${inst.series}`;
