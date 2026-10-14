import fs from "node:fs";
import path from "node:path";
import type { DbFamily } from "../src/api";
import { config, saveConfig } from "./config";
import { instanceBin, type Instance } from "./instances";
import { run } from "./util";
import { seriesDataDir, seriesDir } from "./versions";

export type Creds = { user: string; password: string };

const DEFAULTS: Record<DbFamily, Creds> = { mysql: { user: "root", password: "" }, postgres: { user: "postgres", password: "" } };

/** Credentials chosen in Settings. */
export function wanted(family: DbFamily): Creds {
  const c = config();
  return family === "postgres" ? { user: c.pg_user || "postgres", password: c.pg_password } : { user: c.mysql_user || "root", password: c.mysql_password };
}

/** Credentials an instance actually has (fresh servers: root / postgres without a password). */
export const applied = (inst: Pick<Instance, "id" | "family">): Creds => config().db_applied[inst.id] ?? DEFAULTS[inst.family];

/** Client arguments / environment that log in to an instance. */
export function mysqlLogin(inst: Instance) {
  const c = applied(inst);
  // --no-defaults (must come first): the [client] section written for terminals must not override this login
  return ["--no-defaults", `--user=${c.user}`, ...(c.password ? [`--password=${c.password}`] : []), "-h127.0.0.1", `-P${inst.port}`];
}
export function pgEnv(inst: Instance) {
  const c = applied(inst);
  return { ...process.env, PGUSER: c.user, PGPASSWORD: c.password, PGHOST: "127.0.0.1", PGPORT: String(inst.port) };
}

/** [client] in my.ini next to a MySQL/MariaDB series' bin: a plain `mysql` in a terminal logs in to that version. */
export function writeClientIni(inst: Instance) {
  const c = applied(inst);
  const lines = ["[client]", `user=${c.user}`, ...(c.password ? [`password="${c.password.replace(/[\\"]/g, "\\$&")}"`] : []), "host=127.0.0.1", `port=${inst.port}`];
  fs.writeFileSync(path.join(seriesDir(inst.engine, inst.series), "my.ini"), `${lines.join("\r\n")}\r\n`);
}

const my = (s: string) => `'${s.replace(/\\/g, "\\\\").replace(/'/g, "\\'")}'`;
const pg = (s: string) => `'${s.replace(/'/g, "''")}'`;

async function query(inst: Instance, sql: string) {
  const r =
    inst.family === "postgres"
      ? await run(instanceBin(inst, "psql"), ["-w", "-d", "postgres", "-At", "-v", "ON_ERROR_STOP=1", "-c", sql], { env: pgEnv(inst) })
      : await run(instanceBin(inst, "mysql"), [...mysqlLogin(inst), "-N", "-B", "-e", sql]);
  if (r.code) throw new Error(r.out.trim());
  return r.stdout.split(/\r?\n/).filter(Boolean);
}

/** PostgreSQL only checks passwords when pg_hba.conf asks for them; without a password it stays "trust". */
function setPgAuth(inst: Instance, method: "trust" | "scram-sha-256") {
  const file = path.join(seriesDataDir("postgres", inst.series), "pg_hba.conf");
  const lines = fs.readFileSync(file, "utf8").split(/\r?\n/);
  const out = lines.map((l) => (/^\s*(local|host)\s/.test(l) ? l.replace(/\b(trust|scram-sha-256|md5|password)\s*$/, method) : l));
  fs.writeFileSync(file, out.join("\n"));
}

function remember(inst: Instance, c: Creds) {
  const cfg = config();
  saveConfig({ ...cfg, db_applied: { ...cfg.db_applied, [inst.id]: c } });
}

/** Brings a running instance to the credentials from Settings; called after every start and when Settings change. */
export async function applyCredentials(inst: Instance) {
  const want = wanted(inst.family);
  const done = () => applied(inst).user === want.user && applied(inst).password === want.password;
  // a change interrupted after the server got the new login leaves the old one unusable
  if (!done() && !(await query(inst, "SELECT 1").then(() => true, () => false))) remember(inst, want);
  const have = applied(inst);
  if (!done()) {
    if (inst.family === "mysql") {
      if (want.user === "root") {
        for (const host of await query(inst, "SELECT host FROM mysql.user WHERE user = 'root'")) {
          await query(inst, `ALTER USER 'root'@${my(host)} IDENTIFIED BY ${my(want.password)}`);
        }
      } else {
        for (const host of ["localhost", "%"]) {
          const account = `${my(want.user)}@${my(host)}`;
          await query(inst, `CREATE USER IF NOT EXISTS ${account}; ALTER USER ${account} IDENTIFIED BY ${my(want.password)}; GRANT ALL PRIVILEGES ON *.* TO ${account} WITH GRANT OPTION`);
        }
      }
      remember(inst, want);
      if (have.user !== "root" && have.user !== want.user) await query(inst, `DROP USER IF EXISTS ${my(have.user)}@'localhost', ${my(have.user)}@'%'`);
    } else {
      const role = `"${want.user}"`;
      const password = want.password ? pg(want.password) : "NULL";
      await query(
        inst,
        `DO $$BEGIN IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = ${pg(want.user)}) THEN CREATE ROLE ${role} LOGIN SUPERUSER; END IF; END$$; ALTER ROLE ${role} WITH LOGIN SUPERUSER PASSWORD ${password}`,
      );
      // remembered before pg_hba.conf changes: until the reload both logins work
      remember(inst, want);
      setPgAuth(inst, want.password ? "scram-sha-256" : "trust");
      await query(inst, "SELECT pg_reload_conf()");
    }
  }
  if (inst.family === "mysql") writeClientIni(inst);
}
