import fs from "node:fs";
import path from "node:path";
import { proxied, type Project } from "../src/api";
import { port } from "./config";
import { wanted } from "./dbauth";
import { defaultInstanceId, instance, projectInstanceId, type Instance } from "./instances";
import { exists } from "./util";

/** Sets KEY=value lines in a .env file (uncommenting "# KEY=" lines, appending missing keys). */
export function setEnv(file: string, values: Record<string, string>) {
  let s = fs.readFileSync(file, "utf8");
  for (const [k, v] of Object.entries(values)) {
    const re = new RegExp(`^#?\\s*${k}=.*$`, "m");
    s = re.test(s) ? s.replace(re, `${k}=${v}`) : `${s.trimEnd()}\n${k}=${v}\n`;
  }
  fs.writeFileSync(file, s);
}

export const user = (inst: Instance) => wanted(inst.family).user;
export const password = (inst: Instance) => wanted(inst.family).password;

/** Laravel < 11 has no "mariadb" connection; use "mysql" there. */
const laravelConnection = (dir: string, inst: Instance) => {
  if (inst.engine === "postgres") return "pgsql";
  if (inst.engine === "mysql") return "mysql";
  const config = path.join(dir, "config", "database.php");
  return exists(config) && fs.readFileSync(config, "utf8").includes("'mariadb'") ? "mariadb" : "mysql";
};

const SERVER_KEYS = ["DB_HOST", "DB_PORT", "DB_DATABASE", "DB_USERNAME", "DB_PASSWORD"];

/** The project's SQLite file: Laravel database/database.sqlite (or DB_DATABASE), Symfony var/data.db. */
export function sqliteFile(x: Project) {
  const env = path.join(x.path, ".env");
  const s = exists(env) ? fs.readFileSync(env, "utf8") : "";
  if (x.type === "laravel" && /^DB_CONNECTION=sqlite$/m.test(s)) {
    const file = s.match(/^DB_DATABASE=(.+)$/m)?.[1].trim();
    return file ? path.resolve(x.path, file) : path.join(x.path, "database", "database.sqlite");
  }
  const url = x.type === "symfony" && s.match(/^DATABASE_URL="?sqlite:\/\/\/([^"\r\n]+)"?/m)?.[1];
  return url ? path.normalize(url.replace("%kernel.project_dir%", x.path)) : null;
}

/** Switches a Laravel/Symfony project to an SQLite file (created empty if missing). */
function useSqlite(x: Project) {
  const env = path.join(x.path, ".env");
  if (!exists(env)) return;
  if (x.type === "laravel") {
    const s = fs.readFileSync(env, "utf8").replace(new RegExp(`^(${SERVER_KEYS.join("|")})=`, "gm"), "# $1=");
    fs.writeFileSync(env, s);
    setEnv(env, { DB_CONNECTION: "sqlite" });
  } else if (x.type === "symfony") {
    setEnv(env, { DATABASE_URL: `"sqlite:///%kernel.project_dir%/var/data.db"` });
  }
  const file = sqliteFile({ ...x, db: "sqlite" });
  if (file && !exists(file)) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, "");
  }
}

/** Doctrine needs the server version; MariaDB is marked with a suffix. */
export const serverVersion = (inst: Instance) => (inst.engine === "postgres" ? inst.series : inst.engine === "mariadb" ? `${inst.version}-MariaDB` : inst.version);

/**
 * Points a project's framework config at its database instance: Laravel and Symfony .env, WordPress wp-config.php.
 * Credentials are only reset when the project moves between MySQL-compatible and PostgreSQL.
 */
export function syncProjectDb(x: Project, chosen = false) {
  const pinned = !!x.db || chosen; // chosen: the user just picked this database (also "default") in the project settings
  if (x.db === "none") return;
  if (x.db === "sqlite") return useSqlite(x);
  const inst = instance(projectInstanceId(x.db) ?? "");
  if (!inst) return;
  if (x.type === "laravel") {
    const env = path.join(x.path, ".env");
    if (!exists(env)) return;
    let text = fs.readFileSync(env, "utf8");
    // coming back from SQLite: restore the commented-out connection lines
    if (pinned && /^DB_CONNECTION=sqlite/m.test(text)) {
      text = text.replace(new RegExp(`^#\\s*(${SERVER_KEYS.join("|")})=`, "gm"), "$1=");
      fs.writeFileSync(env, text.replace(/^DB_CONNECTION=sqlite$/m, "DB_CONNECTION=mysql"));
      text = fs.readFileSync(env, "utf8");
    }
    const wasPostgres = /^DB_CONNECTION=pgsql/m.test(text);
    if (!pinned && (wasPostgres || /^DB_CONNECTION=sqlite/m.test(text))) return; // not on the default MySQL-compatible server
    setEnv(env, {
      DB_CONNECTION: laravelConnection(x.path, inst),
      DB_HOST: "127.0.0.1",
      DB_PORT: String(inst.port),
      ...(wasPostgres !== (inst.family === "postgres") ? { DB_USERNAME: user(inst), DB_PASSWORD: password(inst) } : {}),
    });
  } else if (x.type === "symfony") {
    const env = path.join(x.path, ".env");
    const current = exists(env) ? fs.readFileSync(env, "utf8").match(/^DATABASE_URL="?([^"\r\n]*)"?/m)?.[1] : undefined;
    if (!current) return;
    const m = current.match(/^(\w+):\/\/([^@/]*)@[^/]*\/([^?]*)/);
    const name = m?.[3] || path.basename(x.path).replace(/\W/g, "_");
    const sameFamily = !!m && (m[1].startsWith("postgres") === (inst.family === "postgres"));
    if (!pinned && !sameFamily) return;
    const scheme = inst.family === "postgres" ? "postgresql" : "mysql";
    const credentials = sameFamily ? m![2] : urlLogin(inst);
    setEnv(env, { DATABASE_URL: `"${scheme}://${credentials}@127.0.0.1:${inst.port}/${name}?serverVersion=${serverVersion(inst)}&charset=utf8mb4"` });
  } else if (x.type === "wordpress") {
    const file = path.join(x.path, "wp-config.php");
    if (!exists(file)) return;
    const s = fs.readFileSync(file, "utf8");
    fs.writeFileSync(file, s.replace(/define\(\s*'DB_HOST'\s*,\s*'[^']*'\s*\)/, `define( 'DB_HOST', '127.0.0.1:${inst.port}' )`));
  }
}

/** Follows a changed Mailpit SMTP port in projects that point at it (Laravel MAIL_PORT, Symfony MAILER_DSN). */
export function syncProjectMail(x: Project, from: number, to: number) {
  const env = path.join(x.path, ".env");
  if ((x.type !== "laravel" && x.type !== "symfony") || !exists(env)) return;
  const s = fs.readFileSync(env, "utf8");
  if (x.type === "laravel" && /^MAIL_HOST=127\.0\.0\.1$/m.test(s) && new RegExp(`^MAIL_PORT=${from}$`, "m").test(s)) setEnv(env, { MAIL_PORT: String(to) });
  if (x.type === "symfony") fs.writeFileSync(env, s.split(`smtp://127.0.0.1:${from}`).join(`smtp://127.0.0.1:${to}`));
}

type Uses = { db: string | null; mail: boolean; redis: boolean; memcached: boolean; mongodb: boolean };

/** Which database instance and other services a project uses, read from its settings and config files. */
export function projectUses(x: Project): Uses {
  const env = path.join(x.path, x.type === "wordpress" ? "wp-config.php" : ".env");
  const s = exists(env) ? fs.readFileSync(env, "utf8") : "";
  const smtp = port("mailpit_smtp");
  let family: "mysql" | "postgres" | null = null;
  let mail = !proxied(x.type) && !!x.php; // php.ini sends mail() to Mailpit
  const driver = (value: string) => new RegExp(`^(CACHE_STORE|CACHE_DRIVER|SESSION_DRIVER|QUEUE_CONNECTION|BROADCAST_CONNECTION)=${value}$`, "m").test(s);
  const laravel = x.type === "laravel";
  const symfony = x.type === "symfony";
  const other = {
    redis: (laravel && driver("redis")) || (symfony && s.includes("redis://")),
    memcached: (laravel && driver("memcached")) || (symfony && s.includes("memcached://")),
    mongodb: (laravel && /^(DB_CONNECTION=mongodb|MONGODB_URI=.+)$/m.test(s)) || (symfony && s.includes("mongodb://")),
  };
  if (x.type === "laravel") {
    const conn = s.match(/^DB_CONNECTION=(\w+)/m)?.[1];
    family = conn === "pgsql" ? "postgres" : conn === "mysql" || conn === "mariadb" ? "mysql" : null;
    mail = /^MAIL_HOST=127\.0\.0\.1$/m.test(s) && new RegExp(`^MAIL_PORT=${smtp}$`, "m").test(s);
  } else if (x.type === "symfony") {
    const scheme = s.match(/^DATABASE_URL="?(\w+):/m)?.[1];
    family = scheme?.startsWith("postgres") ? "postgres" : scheme === "mysql" ? "mysql" : null;
    mail = s.includes(`smtp://127.0.0.1:${smtp}`);
  } else if (x.type === "wordpress") family = "mysql";
  return { db: x.db === "none" ? null : x.db || (family && defaultInstanceId(family)), mail, ...other };
}

/** "user" or "user:password" for a database URL. */
export const urlLogin = (inst: Instance) => [user(inst), password(inst)].filter(Boolean).map(encodeURIComponent).join(":");

/**
 * Follows changed global credentials in projects that still use the old ones: Laravel DB_USERNAME/DB_PASSWORD,
 * Symfony DATABASE_URL, WordPress DB_USER/DB_PASSWORD. Projects with their own credentials are left alone.
 */
export function syncProjectCredentials(x: Project, family: "mysql" | "postgres", from: { user: string; password: string }, to: { user: string; password: string }) {
  const file = path.join(x.path, x.type === "wordpress" ? "wp-config.php" : ".env");
  if (!exists(file)) return;
  let s = fs.readFileSync(file, "utf8");
  const pgsql = /^DB_CONNECTION=pgsql$/m.test(s);
  if (x.type === "laravel" && pgsql === (family === "postgres")) {
    const user = s.match(/^DB_USERNAME=(.*)$/m)?.[1] ?? "";
    const pass = s.match(/^DB_PASSWORD=(.*)$/m)?.[1] ?? "";
    if (user === from.user && pass === from.password) setEnv(file, { DB_USERNAME: to.user, DB_PASSWORD: to.password });
    return;
  }
  if (x.type === "symfony") {
    const login = (c: { user: string; password: string }) => [c.user, c.password].filter(Boolean).map(encodeURIComponent).join(":");
    const scheme = family === "postgres" ? "postgres(?:ql)?" : "mysql";
    s = s.replace(new RegExp(`^(DATABASE_URL="?${scheme}://)${login(from).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}@`, "m"), `$1${login(to)}@`);
  } else if (x.type === "wordpress" && family === "mysql") {
    const define = (key: string, from: string, to: string) => {
      const re = new RegExp(`define\\(\\s*'${key}'\\s*,\\s*'([^']*)'\\s*\\)`);
      const cur = s.match(re)?.[1];
      if (cur === from) s = s.replace(re, `define( '${key}', '${to.replace(/'/g, "\\'")}' )`);
    };
    if (s.match(/define\(\s*'DB_USER'\s*,\s*'([^']*)'/)?.[1] === from.user) {
      define("DB_USER", from.user, to.user);
      define("DB_PASSWORD", from.password, to.password);
    }
  } else return;
  fs.writeFileSync(file, s);
}
