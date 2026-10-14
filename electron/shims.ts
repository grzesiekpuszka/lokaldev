import { app } from "electron";
import fs from "node:fs";
import path from "node:path";
import { config, defaultPhp, port, projects } from "./config";
import { inUserPath, setUserPath } from "./env";
import { wanted, writeClientIni } from "./dbauth";
import { allInstances, instance } from "./instances";
import { binDir, seriesDir } from "./versions";
import { exists, fwd, p, ROOT } from "./util";

const TOOLS = [
  "php", "composer",
  "mysql", "mysqldump", "mysqladmin", "mysqlcheck", "mysqlimport",
  "mariadb", "mariadb-dump", "mariadb-admin", "mariadb-check", "mariadb-import",
  "psql", "pg_dump", "pg_dumpall", "pg_restore", "pg_isready", "createdb", "dropdb",
  "httpd", "nginx", "mailpit", "redis-cli", "mongosh",
  "git", "python", "pip", "sqlite3",
];
const SHIMS = p("shims");
const source = app.isPackaged ? path.join(process.resourcesPath, "shim.exe") : path.join(ROOT, "resources", "shim.exe");

/** shims.txt key a tool resolves through (as in shim.cs). */
function kindOf(tool: string) {
  if (tool === "php" || tool === "composer") return "php";
  if (tool.startsWith("mysql") || tool.startsWith("mariadb")) return "db";
  if (tool === "psql" || tool.startsWith("pg_") || tool === "createdb" || tool === "dropdb") return "pg";
  return tool;
}

/** Copies the shim exes and rewrites shims.txt (kind | project path prefix | binary dir, or a <tool>args / pgport value). */
export function syncShims() {
  const lines: string[] = [];
  const php = defaultPhp();
  if (php) lines.push(`php||${p("bin", "php", php)}`);
  for (const x of projects()) if (x.php) lines.push(`php|${`${x.path}\\`.toLowerCase()}|${p("bin", "php", x.php)}`);
  const phar = path.join(binDir("composer"), "composer.phar");
  if (exists(phar)) lines.push(`composer||${phar}`);
  const db = path.join(binDir(config().db_engine), "bin");
  if (exists(db)) lines.push(`db||${db}`);
  const pg = path.join(binDir("postgres"), "bin");
  if (exists(pg)) lines.push(`pg||${pg}`, `pgport||${port("postgres")}`);
  // web servers run with lokaldev's config (e.g. "httpd -t", "nginx -t")
  if (exists(binDir("apache"))) lines.push(`httpd||${path.join(binDir("apache"), "bin")}`, `httpdargs||-f "${fwd(p("etc", "httpd.conf"))}"`);
  if (exists(binDir("nginx"))) lines.push(`nginx||${binDir("nginx")}`, `nginxargs||-p "${fwd(binDir("nginx"))}/" -c "${fwd(p("etc", "nginx.conf"))}"`);
  if (exists(binDir("mailpit"))) lines.push(`mailpit||${binDir("mailpit")}`);
  // clients connect to lokaldev's ports by default
  if (exists(binDir("redis"))) lines.push(`redis-cli||${binDir("redis")}`, `redis-cliargs||-p ${port("redis")}`);
  const mongosh = path.join(binDir("mongodb"), "mongosh", "bin");
  if (exists(mongosh)) lines.push(`mongosh||${mongosh}`, `mongoshargs||--port ${port("mongodb")}`);
  if (exists(binDir("git"))) lines.push(`git||${path.join(binDir("git"), "cmd")}`);
  const python = path.join(binDir("python"), "python.exe");
  if (exists(python)) lines.push(`python||${binDir("python")}`, `pip||${python}`, "pipargs||-m pip");
  for (const x of projects()) {
    const dir = x.python && seriesDir("python", x.python);
    if (!dir || !exists(path.join(dir, "python.exe"))) continue;
    const prefix = `${x.path}\\`.toLowerCase();
    lines.push(`python|${prefix}|${dir}`, `pip|${prefix}|${path.join(dir, "python.exe")}`);
  }
  if (exists(binDir("sqlite"))) lines.push(`sqlite3||${binDir("sqlite")}`);
  // projects pinned to another database instance use its binaries (and PGPORT for PostgreSQL)
  for (const x of projects()) {
    const inst = x.db ? instance(x.db) : null;
    if (!inst) continue;
    const prefix = `${x.path}\\`.toLowerCase();
    const bin = path.join(seriesDir(inst.engine, inst.series), "bin");
    if (inst.family === "postgres") lines.push(`pg|${prefix}|${bin}`, `pgport|${prefix}|${inst.port}`);
    else lines.push(`db|${prefix}|${bin}`);
  }
  // MySQL/MariaDB clients log in through [client] in my.ini next to their bin; psql gets the login from the shim
  for (const inst of allInstances()) if (inst.family === "mysql") writeClientIni(inst);
  const pgLogin = wanted("postgres");
  lines.push(`pguser||${pgLogin.user}`, `pgpassword||${pgLogin.password}`);
  fs.writeFileSync(path.join(SHIMS, "shims.txt"), lines.join("\n"));

  // a shim only exists for tools lokaldev provides; otherwise it would shadow the same tool installed on the system
  const kinds = new Set(lines.map((l) => l.split("|")[0]));
  const exe = fs.readFileSync(source); // compared by content: rebuilt shims often keep the same size
  for (const tool of TOOLS) {
    const dst = path.join(SHIMS, `${tool}.exe`);
    try {
      if (!kinds.has(kindOf(tool)) || (tool === "composer" && !kinds.has("composer"))) fs.rmSync(dst, { force: true });
      else if (!exists(dst) || !fs.readFileSync(dst).equals(exe)) fs.writeFileSync(dst, exe);
    } catch {} // in use; keep it as it is
  }
}

export const pathEnabled = () => inUserPath(SHIMS);
export const setPath = (enabled: boolean) => setUserPath(SHIMS, enabled);

export { SHIMS };
