import crypto from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { proxied, type DbEngine, type DbInstance, type Project, type Service, type ServiceId, type WebServer } from "../src/api";
import { apache, customStamp, nginx, phpPort, updateHosts, WORKERS } from "./conf";
import { config, defaultPhp, port, projects, signature, timezone } from "./config";
import { pgConfSet } from "./pgconf";
import { activeSeries, activeVersion as componentVersion, binDir, dataDir, dbRoot, seriesDataDir, seriesDir } from "./versions";
import { allInstances, defaultInstanceId, instance, instanceBin, instanceLabel, LABELS, parseInstance, usedInstanceIds, type Instance } from "./instances";
import { applied as login, applyCredentials } from "./dbauth";
import { ensureMyIni } from "./myini";
import { projectUses } from "./projectdb";
import { freshPath, setUserEnv, userValue } from "./env";
import { alive, portOpen, exists, fwd, killTree, p, run, sleep, slug, spawnLogged, tail, tailErrors, waitExit, waitPort } from "./util";
import { t } from "../src/i18n";

const procs = new Map<string, ChildProcess>();
const pools = new Map<string, Pool>();

/** Keeps WORKERS php-cgi processes alive for one PHP version (php-cgi on Windows serves one request at a time). */
class Pool {
  private stopped = false;
  private children: ChildProcess[] = [];

  constructor(private ver: string) {
    for (let i = 0; i < WORKERS; i++) this.spawn(i);
  }

  private spawn(i: number) {
    if (this.stopped) return;
    const dir = p("bin", "php", this.ver);
    const c = spawnLogged(path.join(dir, "php-cgi.exe"), ["-b", `127.0.0.1:${phpPort(this.ver) + i}`], p("logs", `php-${this.ver}.log`), {
      cwd: dir,
      env: { ...process.env, PHP_FCGI_MAX_REQUESTS: "0" },
    });
    this.children[i] = c;
    c.on("exit", () => setTimeout(() => this.spawn(i), 1000));
  }

  /** Resolves once the workers are gone (they keep files of the PHP folder open until then). */
  stop() {
    this.stopped = true;
    for (const c of this.children) c.kill();
    return Promise.all(this.children.map((c) => waitExit(c, 5000)));
  }
}

const running = (key: string) => alive(procs.get(key));
export const nodeRunning = (dir: string) => running(`node:${dir}`);

async function stop(key: string) {
  const c = procs.get(key);
  procs.delete(key);
  if (c) await killTree(c.pid);
}

// Apache and Nginx can run side by side, both serving every project on their own ports
export const WEB_SERVERS: WebServer[] = ["apache", "nginx"];
export const webPorts = (server: WebServer) => [port(`${server}_http`), port(`${server}_https`)];
const WEB_NAMES: Record<WebServer, string> = { apache: "Apache", nginx: "Nginx" };
const applied = new Map<WebServer, string>();
export const webRunning = (server?: WebServer) => (server ? running(server) : WEB_SERVERS.some((s) => running(s)));
const stamp = (server: WebServer) => signature() + customStamp(server);
const stale = (server: WebServer) => running(server) && applied.get(server) !== stamp(server);
export const dirty = () => WEB_SERVERS.some(stale);

/** Refuses to start when another program holds a port: lokaldev would otherwise treat that server as its own (and later shut it down). */
async function ensureFree(ports: number[], name: string) {
  for (const port of ports) {
    // a just-stopped server of ours may need a moment to release the port
    for (let i = 0; await portOpen(port); i++) {
      if (i >= 10) throw new Error(t("Port {port} is already in use by another program, so {name} can't start.", { port, name }));
      await sleep(200);
    }
  }
}

/** Projects plus localhost (a listing of the projects folder), which goes first so it is also the default site. */
function sites(): Project[] {
  const cfg = config();
  const list = projects();
  if (!cfg.projects_dir) return list;
  const localhost: Project = {
    name: "localhost", path: cfg.projects_dir, type: "custom", domain: "localhost", url: "https://localhost", php: defaultPhp(), node: "",
    ssl: true, docroot: "", imported: false, node_port: 0, node_cmd: "", node_running: false, custom_vhost: { apache: false, nginx: false }, db: "", db_name: "", sqlite: null, python: "",
  };
  return [localhost, ...list];
}

/** Writes the server's main config and its sites-enabled files; returns the main config path. */
export function writeWebConfig(server: WebServer) {
  const list = sites();
  const versions = [...new Set(list.filter((x) => !proxied(x.type) && x.php).map((x) => x.php))];
  return { conf: server === "nginx" ? nginx(list, versions) : apache(list, versions), versions };
}

export async function startServer(server: WebServer) {
  await stopServer(server, true);
  const cfg = config();
  const name = WEB_NAMES[server];
  if (!cfg.projects_dir && !cfg.imported.length) throw new Error(t("Choose a projects folder first"));
  const exe = server === "nginx" ? path.join(binDir("nginx"), "nginx.exe") : path.join(binDir("apache"), "bin", "httpd.exe");
  if (!exists(exe)) throw new Error(t("{name} isn't installed", { name }));

  const [http, https] = webPorts(server);
  await ensureFree(sites().some((x) => x.ssl) ? [http, https] : [http], name);
  const { conf, versions } = writeWebConfig(server);
  for (const v of versions) if (!pools.has(v)) pools.set(v, new Pool(v));
  const args = server === "nginx" ? ["-p", `${fwd(binDir("nginx"))}/`, "-c", conf] : ["-f", conf];
  const log = p("logs", `${server}.log`);
  fs.writeFileSync(log, "");
  const c = spawnLogged(exe, args, log, { cwd: path.dirname(exe) });
  procs.set(server, c);
  if (!(await waitPort(http, c, 5000))) {
    await stopServer(server);
    throw new Error(`${t("{name} failed to start:", { name })}\n${tail(log)}\n${tail(p("logs", `${server}_error.log`))}`);
  }
  applied.set(server, stamp(server));
  await updateHosts(projects().map((x) => x.domain));
}

/** keepPools: the server is restarted right away, so the PHP workers stay. */
export async function stopServer(server: WebServer, keepPools = false) {
  await stop(server);
  if (keepPools || webRunning()) return;
  const stopping = [...pools.values()].map((pool) => pool.stop());
  pools.clear();
  await Promise.all(stopping);
}

/** Restarts running web servers whose config is out of date. */
export async function reloadWeb() {
  for (const s of WEB_SERVERS) if (stale(s)) await startServer(s);
}

/** php-cgi reads php.ini only at startup. */
export async function restartPhp(version: string) {
  if (!pools.has(version)) return;
  await pools.get(version)!.stop();
  pools.set(version, new Pool(version));
}

const instKey = (id: string) => `db:${id}`;
const instancePorts = new Map<string, number>(); // port each running instance was started on
export const instanceRunning = (id: string | null) => !!id && running(instKey(id));

async function startMysqlFamily(inst: Instance) {
  const label = instanceLabel(inst);
  const exe = instanceBin(inst, "mysqld");
  if (!exists(exe)) throw new Error(t("{name} isn't installed", { name: label }));
  const data = seriesDataDir(inst.engine, inst.series);
  const ini = ensureMyIni(inst.engine as DbEngine, inst.series, inst.port);
  const errLog = p("logs", `${inst.id}_error.log`);
  fs.writeFileSync(errLog, ""); // so a failed start reports only this attempt
  if (!exists(data)) {
    const init =
      inst.engine === "mysql"
        ? await run(exe, [`--defaults-file=${ini}`, "--initialize-insecure"])
        : await run(instanceBin(inst, "mariadb-install-db"), [`--datadir=${data}`]);
    if (init.code) {
      fs.rmSync(data, { recursive: true, force: true });
      throw new Error(`${t("{name} initialization failed:", { name: label })}\n${init.out}\n${tailErrors(errLog)}`);
    }
  }
  await ensureFree([inst.port], label);
  const c = spawnLogged(exe, [`--defaults-file=${ini}`], p("logs", `${inst.id}.log`));
  procs.set(instKey(inst.id), c);
  instancePorts.set(inst.id, inst.port);
  if (!(await waitPort(inst.port, c, 30000))) {
    await stop(instKey(inst.id));
    throw new Error(`${t("{name} failed to start:", { name: label })}\n${tailErrors(errLog)}`);
  }
  await applyCredentials(inst);
}

/** Creates a PostgreSQL cluster (and its postgresql.conf) on first use. */
export async function initPostgres(series = activeSeries("postgres")) {
  const bin = path.join(seriesDir("postgres", series ?? "none"), "bin");
  if (!series || !exists(bin)) throw new Error(t("{name} isn't installed", { name: "PostgreSQL" }));
  const data = seriesDataDir("postgres", series);
  if (!exists(path.join(data, "PG_VERSION"))) {
    fs.rmSync(data, { recursive: true, force: true });
    const r = await run(path.join(bin, "initdb.exe"), ["-D", data, "-U", "postgres", "-A", "trust", "-E", "UTF8", "--locale=C"]);
    if (r.code) throw new Error(`${t("{name} initialization failed:", { name: "PostgreSQL" })}\n${r.out}`);
    pgConfSet(series, { settings: { timezone: timezone(), log_timezone: timezone() } });
  }
  return { bin, data };
}

async function startPostgresInstance(inst: Instance) {
  const label = instanceLabel(inst);
  const { bin, data } = await initPostgres(inst.series);
  const log = p("logs", `${inst.id}.log`);
  fs.writeFileSync(log, ""); // so a failed start reports only this attempt
  await ensureFree([inst.port], label);
  const c = spawnLogged(path.join(bin, "postgres.exe"), ["-D", data, "-p", String(inst.port), "-h", "127.0.0.1"], log);
  procs.set(instKey(inst.id), c);
  instancePorts.set(inst.id, inst.port);
  if (!(await waitPort(inst.port, c, 20000))) {
    await stop(instKey(inst.id));
    throw new Error(`${t("{name} failed to start:", { name: label })}\n${tailErrors(log)}`);
  }
  await applyCredentials(inst);
}

export async function startInstance(id: string | null) {
  const inst = id ? instance(id) : null;
  if (!inst) throw new Error(t("{name} isn't installed", { name: id ?? "MySQL/MariaDB" }));
  if (instanceRunning(inst.id)) return;
  await (inst.family === "postgres" ? startPostgresInstance(inst) : startMysqlFamily(inst));
}

export async function stopInstance(id: string | null) {
  const c = id ? procs.get(instKey(id)) : undefined;
  const parsed = id ? parseInstance(id) : null;
  if (!id || !c || !parsed) return;
  if (parsed.engine === "postgres") {
    await run(path.join(seriesDir("postgres", parsed.series), "bin", "pg_ctl.exe"), ["stop", "-D", seriesDataDir("postgres", parsed.series), "-m", "fast"]);
  } else {
    const creds = login({ id, family: "mysql" });
    const password = creds.password ? [`--password=${creds.password}`] : [];
    await run(instanceBin(parsed, "mysqladmin"), ["--no-defaults", `--user=${creds.user}`, ...password, "-h127.0.0.1", `--port=${instancePorts.get(id)}`, "shutdown"]);
  }
  if (!(await waitExit(c, 10000))) await killTree(c.pid);
  procs.delete(instKey(id));
  instancePorts.delete(id);
}

// "db" and "postgres" are the default instances
export const startDb = () => startInstance(defaultInstanceId("mysql"));
export const stopDb = () => stopInstance(defaultInstanceId("mysql"));

/** Messages live in <databases folder>\mailpit\mailpit.db (kept across Mailpit updates); MP_DATABASE points a terminal `mailpit` there too. */
const mailpitDb = () => path.join(dbRoot(), "mailpit", "mailpit.db");

async function mailpitDatabase() {
  const db = mailpitDb();
  fs.mkdirSync(path.dirname(db), { recursive: true });
  // older versions kept it directly in the databases folder
  for (const suffix of ["", "-shm", "-wal"]) {
    const old = path.join(dbRoot(), `mailpit.db${suffix}`);
    if (exists(old) && !exists(db + suffix)) fs.renameSync(old, db + suffix);
  }
  if ((await userValue("MP_DATABASE")).toLowerCase() !== db.toLowerCase()) await setUserEnv("MP_DATABASE", db).catch(() => {});
}

async function startMailpit() {
  if (running("mailpit")) return;
  const exe = path.join(binDir("mailpit"), "mailpit.exe");
  if (!exists(exe)) throw new Error(t("{name} isn't installed", { name: "Mailpit" }));
  await mailpitDatabase();
  const log = p("logs", "mailpit.log");
  const args = ["--listen", `127.0.0.1:${port("mailpit_web")}`, "--smtp", `127.0.0.1:${port("mailpit_smtp")}`, "--database", mailpitDb()];
  await ensureFree([port("mailpit_smtp"), port("mailpit_web")], "Mailpit");
  const c = spawnLogged(exe, args, log);
  procs.set("mailpit", c);
  if (!(await waitPort(port("mailpit_web"), c, 10000))) {
    await stop("mailpit");
    throw new Error(`${t("{name} failed to start:", { name: "Mailpit" })}\n${tail(log)}`);
  }
}

/** Starts a single-process service and waits for its port; the log gets only this attempt. */
async function startProcess(id: string, name: string, exe: string, args: string[], servicePort: number) {
  if (running(id)) return;
  if (!exists(exe)) throw new Error(t("{name} isn't installed", { name }));
  const log = p("logs", `${id}.log`);
  fs.writeFileSync(log, "");
  await ensureFree([servicePort], name);
  const c = spawnLogged(exe, args, log, { cwd: path.dirname(exe) });
  procs.set(id, c);
  if (!(await waitPort(servicePort, c, 30000))) {
    await stop(id);
    throw new Error(`${t("{name} failed to start:", { name })}\n${tail(log)}`);
  }
}

function startRedis() {
  const data = path.join(dbRoot(), "redis");
  fs.mkdirSync(data, { recursive: true });
  // the default snapshot rules, so data survives restarts
  const args = ["--port", String(port("redis")), "--bind", "127.0.0.1", "--dir", fwd(data), "--save", "3600 1 300 100 60 10000", "--logfile", ""];
  return startProcess("redis", "Redis", path.join(binDir("redis"), "redis-server.exe"), args, port("redis"));
}

/** Redis saves its snapshot on a clean shutdown. */
async function stopRedis() {
  const c = procs.get("redis");
  if (!c) return;
  await run(path.join(binDir("redis"), "redis-cli.exe"), ["-p", String(port("redis")), "shutdown"]);
  if (!(await waitExit(c, 10000))) await killTree(c.pid);
  procs.delete("redis");
}

const startMemcached = () =>
  startProcess("memcached", "Memcached", path.join(binDir("memcached"), "bin", "memcached.exe"), ["-p", String(port("memcached")), "-l", "127.0.0.1", "-U", "0", "-m", "64"], port("memcached"));

function startMongo() {
  const data = dataDir("mongodb");
  fs.mkdirSync(data, { recursive: true });
  const args = ["--dbpath", data, "--port", String(port("mongodb")), "--bind_ip", "127.0.0.1"];
  return startProcess("mongodb", "MongoDB", path.join(binDir("mongodb"), "bin", "mongod.exe"), args, port("mongodb"));
}

/** A clean shutdown through mongosh; killing mongod would leave the journal to be replayed. */
async function stopMongo() {
  const c = procs.get("mongodb");
  if (!c) return;
  const shell = path.join(binDir("mongodb"), "mongosh", "bin", "mongosh.exe");
  if (exists(shell)) await run(shell, ["--quiet", "--port", String(port("mongodb")), "--eval", "db.getSiblingDB('admin').shutdownServer()"]);
  if (!(await waitExit(c, 15000))) await killTree(c.pid);
  procs.delete("mongodb");
}

const quote = (s: string) => s.replace(/\\/g, "\\\\").replace(/'/g, "\\'");

async function startPhpMyAdmin() {
  if (running("phpmyadmin")) return;
  const dir = binDir("phpmyadmin");
  if (!exists(dir)) throw new Error(t("{name} isn't installed", { name: "phpMyAdmin" }));
  const php = defaultPhp();
  if (!php) throw new Error(t("phpMyAdmin requires PHP to be installed"));
  const conf = path.join(dir, "config.inc.php");
  const secret = (exists(conf) && fs.readFileSync(conf, "utf8").match(/blowfish_secret'\] = '(\w+)'/)?.[1]) || crypto.randomBytes(16).toString("hex");
  const used = usedInstanceIds();
  // one server entry per MySQL-compatible instance in use (server dropdown in phpMyAdmin); rewritten on every start
  const servers = allInstances().filter((x) => x.family === "mysql" && (used.has(x.id) || instanceRunning(x.id)));
  fs.mkdirSync(p("tmp", "pma"), { recursive: true });
  const entry = (x: Instance, i: number) => `$i = ${i + 1};
$cfg['Servers'][$i]['verbose'] = '${LABELS[x.engine]} ${x.version} (:${x.port})';
$cfg['Servers'][$i]['host'] = '127.0.0.1';
$cfg['Servers'][$i]['port'] = '${x.port}';
$cfg['Servers'][$i]['auth_type'] = 'config';
$cfg['Servers'][$i]['user'] = '${quote(login(x).user)}';
$cfg['Servers'][$i]['password'] = '${quote(login(x).password)}';
$cfg['Servers'][$i]['AllowNoPassword'] = true;
`;
  fs.writeFileSync(
    conf,
    `<?php
$cfg['blowfish_secret'] = '${secret}';
$cfg['TempDir'] = '${fwd(p("tmp", "pma"))}';
${servers.map(entry).join("")}`,
  );
  const phpDir = p("bin", "php", php);
  const log = p("logs", "phpmyadmin.log");
  await ensureFree([port("phpmyadmin")], "phpMyAdmin");
  const c = spawnLogged(path.join(phpDir, "php.exe"), ["-S", `127.0.0.1:${port("phpmyadmin")}`, "-t", dir], log, { cwd: phpDir });
  procs.set("phpmyadmin", c);
  if (!(await waitPort(port("phpmyadmin"), c, 10000))) {
    await stop("phpmyadmin");
    throw new Error(`${t("{name} failed to start:", { name: "phpMyAdmin" })}\n${tail(log)}`);
  }
}

const pgAdminExe = () => path.join(binDir("postgres"), "pgAdmin 4", "runtime", "pgAdmin4.exe");

/** pgAdmin is a desktop app that comes with PostgreSQL; tracked like a service so its card can open and close it. */
async function startPgAdmin() {
  if (!exists(pgAdminExe())) throw new Error(t("pgAdmin isn't installed (install PostgreSQL)"));
  if (running("pgadmin")) return;
  procs.set("pgadmin", spawn(pgAdminExe(), [], { stdio: "ignore" }));
}

export async function startNode(dir: string) {
  const x = projects().find((x) => x.path === dir);
  if (!x) throw new Error(t("Project not found"));
  await stop(`node:${dir}`);
  const log = p("logs", `node-${slug(x.name)}.log`);
  fs.writeFileSync(log, "");
  // Python apps get the project's Python and its .venv first on PATH
  const python = x.type === "python" ? [path.join(dir, ".venv", "Scripts"), x.python ? seriesDir("python", x.python) : binDir("python")] : [];
  const env = { ...process.env, PATH: [...python, await freshPath()].join(";"), PORT: String(x.node_port), TZ: timezone() };
  const c = spawnLogged("cmd.exe", ["/d", "/s", "/c", x.node_cmd], log, { cwd: dir, env });
  procs.set(`node:${dir}`, c);
  await sleep(1500);
  if (!alive(c)) throw new Error(`${t("The app failed to start:")}\n${tail(log)}`);
}

export const stopNode = (dir: string) => stop(`node:${dir}`);

const starters: Record<string, () => Promise<void>> = {
  apache: () => startServer("apache"),
  nginx: () => startServer("nginx"),
  db: startDb,
  postgres: () => startInstance(defaultInstanceId("postgres")),
  mongodb: startMongo,
  redis: startRedis,
  memcached: startMemcached,
  mailpit: startMailpit,
  phpmyadmin: startPhpMyAdmin,
  pgadmin: startPgAdmin,
};

const stoppers: Record<string, () => Promise<void>> = {
  apache: () => stopServer("apache"),
  nginx: () => stopServer("nginx"),
  db: stopDb,
  postgres: () => stopInstance(defaultInstanceId("postgres")),
  mongodb: stopMongo,
  redis: stopRedis,
  memcached: () => stop("memcached"),
  mailpit: () => stop("mailpit"),
  phpmyadmin: () => stop("phpmyadmin"),
  pgadmin: () => stop("pgadmin"),
};

// "db:<instance>" addresses any database instance
export const startService = (id: ServiceId) => (id.startsWith("db:") ? startInstance(id.slice(3)) : starters[id]());
export const stopService = (id: ServiceId) => (id.startsWith("db:") ? stopInstance(id.slice(3)) : stoppers[id]());

export function serviceRunning(id: ServiceId) {
  if (id === "db") return instanceRunning(defaultInstanceId("mysql"));
  if (id === "postgres") return instanceRunning(defaultInstanceId("postgres"));
  if (id.startsWith("db:")) return instanceRunning(id.slice(3));
  return running(id);
}

export function services(): Service[] {
  const cfg = config();
  const db = componentVersion(cfg.db_engine);
  const pg = componentVersion("postgres");
  const used = usedInstanceIds();
  const list = projects();
  const uses = list.map(projectUses);
  const dbUsers = (id: string | null) => uses.filter((u) => id && u.db === id).length;
  // non-default instances get their own card while a project uses them (or they still run)
  const extra: Service[] = allInstances()
    .filter((x) => !x.default && (used.has(x.id) || instanceRunning(x.id)))
    .map((x) => ({
      id: `db:${x.id}` as ServiceId, name: `${LABELS[x.engine]} ${x.version}`, installed: true, running: instanceRunning(x.id), ports: [x.port], url: null,
      group: "db", projects: dbUsers(x.id),
    }));
  return [
    ...WEB_SERVERS.map((s): Service => {
      const v = componentVersion(s);
      return { id: s, name: `${WEB_NAMES[s]} ${v ?? ""}`.trim(), installed: !!v, running: running(s), ports: webPorts(s), url: null, group: "web", projects: list.length };
    }),
    {
      id: "db", name: `${cfg.db_engine === "mysql" ? "MySQL" : "MariaDB"} ${db ?? ""}`.trim(), installed: !!db, running: serviceRunning("db"), ports: [port("mysql")], url: null,
      group: "db", projects: dbUsers(defaultInstanceId("mysql")), default: true,
    },
    {
      id: "postgres", name: `PostgreSQL ${pg ?? ""}`.trim(), installed: !!pg, running: serviceRunning("postgres"), ports: [port("postgres")], url: null,
      group: "db", projects: dbUsers(defaultInstanceId("postgres")), default: true,
    },
    ...extra,
    ...(["mongodb", "redis", "memcached"] as const).map((id): Service => {
      const v = componentVersion(id);
      return {
        id, name: `${{ mongodb: "MongoDB", redis: "Redis", memcached: "Memcached" }[id]} ${v ?? ""}`.trim(), installed: !!v, running: running(id), ports: [port(id)],
        url: null, group: id === "mongodb" ? "db" : "cache", projects: uses.filter((u) => u[id]).length,
      };
    }),
    {
      id: "mailpit", name: "Mailpit", installed: !!componentVersion("mailpit"), running: running("mailpit"), ports: [port("mailpit_smtp"), port("mailpit_web")],
      url: `http://127.0.0.1:${port("mailpit_web")}`, group: "tools", projects: uses.filter((u) => u.mail).length,
    },
    {
      id: "phpmyadmin", name: "phpMyAdmin", installed: !!componentVersion("phpmyadmin"), running: running("phpmyadmin"), ports: [port("phpmyadmin")],
      url: `http://127.0.0.1:${port("phpmyadmin")}`, group: "tools", projects: null,
    },
    { id: "pgadmin", name: "pgAdmin 4", installed: exists(pgAdminExe()), running: running("pgadmin"), ports: [], url: null, group: "tools", projects: null },
  ];
}

/** All database instances with their state, for the UI. */
export function instances(): DbInstance[] {
  const used = usedInstanceIds();
  return allInstances().map((x) => ({ ...x, running: instanceRunning(x.id), used: used.has(x.id) }));
}

/** Services that keep data in the databases folder. */
const DATA_SERVICES = ["mongodb", "redis", "mailpit"];

/**
 * Moves the databases folder: data services stop, every subfolder (one per service and version) moves unless the new
 * folder already has it — then that one is used as is — and the services start again.
 */
/**
 * Moves the databases folder's contents with the data services stopped. A failure puts everything back; copies (another
 * drive) replace their originals only in the returned function, which runs once the config points to the new folder.
 */
export async function moveDbRoot(from: string, to: string) {
  const names = exists(from) ? fs.readdirSync(from) : [];
  const taken = names.filter((name) => exists(path.join(to, name)));
  if (taken.length) throw new Error(t("The new databases folder already contains {names}. Move or delete them first.", { names: taken.join(", ") }));
  const instances = runningInstanceIds();
  const others = DATA_SERVICES.filter((id) => running(id));
  const restart = async () => {
    for (const id of instances) await startInstance(id);
    for (const id of others) await startService(id as ServiceId);
  };
  for (const id of instances) await stopInstance(id);
  for (const id of others) await stopService(id as ServiceId);
  const moved: string[] = [];
  const copied: string[] = [];
  try {
    fs.mkdirSync(to, { recursive: true });
    for (const name of names) {
      try {
        fs.renameSync(path.join(from, name), path.join(to, name));
        moved.push(name);
      } catch {
        // another drive: copy now, remove the original after the switch
        copied.push(name);
        await fs.promises.cp(path.join(from, name), path.join(to, name), { recursive: true, errorOnExist: true, force: false });
      }
    }
  } catch (e) {
    for (const name of moved) fs.renameSync(path.join(to, name), path.join(from, name));
    for (const name of copied) await fs.promises.rm(path.join(to, name), { recursive: true, force: true });
    await restart();
    throw e;
  }
  return async () => {
    for (const name of copied) await fs.promises.rm(path.join(from, name), { recursive: true, force: true });
    await restart();
  };
}

/** Ids of the running database instances. */
export const runningInstanceIds = () => [...procs.keys()].filter((k) => k.startsWith("db:") && running(k)).map((k) => k.slice(3));

/** Running instances whose port changed since they started (the default engine or version changed). */
export const movedInstanceIds = () => runningInstanceIds().filter((id) => instancePorts.get(id) !== instance(id)?.port);

/** skip: services left out (the "Start services on launch" choices). */
export async function startAll(skip: string[] = []) {
  const errors: string[] = [];
  for (const s of services()) {
    if (!s.installed || s.running || s.id === "pgadmin" || skip.includes(s.id)) continue; // pgAdmin: a desktop app, opened on demand
    try {
      await startService(s.id);
    } catch (e) {
      errors.push(e instanceof Error ? e.message : String(e));
    }
  }
  if (errors.length) throw new Error(errors.join("\n\n"));
}

export async function stopAll() {
  for (const key of [...procs.keys()].filter((k) => k.startsWith("node:"))) await stop(key);
  for (const id of ["apache", "nginx", "mongodb", "redis", "memcached", "mailpit", "phpmyadmin"] as ServiceId[]) await stopService(id);
  for (const key of [...procs.keys()].filter((k) => k.startsWith("db:"))) await stopInstance(key.slice(3));
}
