import type { Database } from "../src/api";
import { instance, instanceBin, type Instance } from "./instances";
import { instances } from "./services";
import { mysqlLogin, pgEnv } from "./dbauth";
import { run } from "./util";
import { t } from "../src/i18n";

const SYSTEM = ["information_schema", "mysql", "performance_schema", "sys", "postgres"];

/** Runs a query on a database instance and returns the result rows. */
export async function sql(inst: Instance, query: string) {
  const r =
    inst.family === "postgres"
      ? await run(instanceBin(inst, "psql"), ["-w", "-d", "postgres", "-At", "-c", query], { env: pgEnv(inst) })
      : await run(instanceBin(inst, "mysql"), [...mysqlLogin(inst), "-N", "-B", "-e", query]);
  if (r.code) throw new Error(r.out.trim());
  return r.stdout.split(/\r?\n/).filter(Boolean);
}

/** Databases of every running instance. */
export async function databases(): Promise<Database[]> {
  const list: Database[] = [];
  for (const inst of instances().filter((x) => x.running)) {
    const query = inst.family === "postgres" ? "SELECT datname FROM pg_database WHERE NOT datistemplate ORDER BY 1" : "SHOW DATABASES";
    for (const name of await sql(inst, query)) {
      list.push({ engine: inst.engine, instance: inst.id, port: inst.port, name, system: SYSTEM.includes(name) });
    }
  }
  return list;
}

export function requireInstance(id: string) {
  const inst = instance(id);
  if (!inst) throw new Error(t("{name} isn't installed", { name: id }));
  return inst;
}

function check(name: string) {
  // imported databases may use any identifier MySQL/PostgreSQL accept unquoted plus "-" and "$"
  if (!/^[A-Za-z0-9_$-]+$/.test(name)) throw new Error(t("Database name: lowercase letters, digits and _ only"));
}

export async function dbCreate(instanceId: string, name: string) {
  check(name);
  const inst = requireInstance(instanceId);
  if (inst.family === "mysql") {
    await sql(inst, `CREATE DATABASE IF NOT EXISTS \`${name}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`);
  } else if (!(await sql(inst, `SELECT 1 FROM pg_database WHERE datname = '${name}'`)).length) {
    await sql(inst, `CREATE DATABASE "${name}"`);
  }
}

export async function dbDrop(instanceId: string, name: string) {
  check(name);
  const inst = requireInstance(instanceId);
  await sql(inst, inst.family === "postgres" ? `DROP DATABASE IF EXISTS "${name}"` : `DROP DATABASE IF EXISTS \`${name}\``);
}
