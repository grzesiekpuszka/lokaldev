import { app, BrowserWindow, dialog, ipcMain, nativeTheme, shell } from "electron";
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import type { ComponentId, Config, CreateSpec, DbEngine, JsTool, PortKey, Project, ProjectSettings, ServiceId, Snapshot, WebServer } from "../src/api";
import { checkDocroot, checkDomain, config, defaultDbName, defaultPhp, detect, fileDbName, installedPhp, norm, port, projects, saveConfig, timezone } from "./config";
import { createProject } from "./create";
import { databases, dbCreate, dbDrop, requireInstance } from "./db";
import { familyOf, instance, parseInstance, projectInstanceId, usedInstanceIds } from "./instances";
import { sqliteFile, syncProjectCredentials, syncProjectDb, syncProjectMail } from "./projectdb";
import { applyCredentials } from "./dbauth";
import { exportAll, exportDatabase, importDump, inspectDump } from "./dump";
import { componentReleases, install, phpReleases, recoverUpdates, uninstall, update } from "./install";
import { afterUpdate, applyUpdate, checkUpdates, downloadUpdate, forgetBinary, scheduleChecks, updateState } from "./updates";
import { activeSeries, activeVersion, COMPONENTS, dbRoot, DEFAULT_DB_ROOT, installedSeries, migrateLayout } from "./versions";
import { installTool, jsTools, systemGit, uninstallTool } from "./tools";
import { freshEnvWith, setUserEnv } from "./env";
import { nodeDefault, nodeInstall, nodeReleases, nodeState, nodeUninstall, nvmInstall, pinNode } from "./node";
import * as svc from "./services";
import { composerHome, pathEnabled, setPath, SHIMS, syncShims } from "./shims";
import { caTrusted, trustCa } from "./ssl";
import { autoFile, customFile, sitesDir } from "./conf";
import { cleanupOrphans, errorText, exists, p, ROOT } from "./util";
import { t } from "../src/i18n";
import { balloon, createTray, destroyTray, setJumpList } from "./tray";
import { phpIniGet, phpIniSet } from "./phpini";
import { myIniGet, myIniSet } from "./myini";
import { pgConfFile, pgConfGet, pgConfSet } from "./pgconf";

// a second launch only hands its arguments to the running instance (see "second-instance") and exits at once
if (!app.requestSingleInstanceLock()) app.exit(0);

// Service operations run one at a time; installs and reads don't wait in this queue.
let queue: Promise<unknown> = Promise.resolve();
const serial = <T>(fn: () => Promise<T>) => {
  if (quitting) return Promise.reject(new Error(t("lokaldev is shutting down")));
  const next = queue.then(fn, fn);
  queue = next.catch(() => {});
  return next;
};

/** Keeps the MySQL-compatible engine on an installed one when the chosen one isn't: MariaDB first, then MySQL. */
function pickDbEngine() {
  const cfg = config();
  if (activeVersion(cfg.db_engine)) return;
  const installed = (["mariadb", "mysql"] as const).find((e) => activeVersion(e));
  if (installed) saveConfig({ ...cfg, db_engine: installed });
}

async function reloadIfStale() {
  syncShims();
  await svc.reloadWeb();
}

async function state(): Promise<Snapshot> {
  const [node, tools, system_git, path_enabled, ca_trusted] = await Promise.all([nodeState(), jsTools(), systemGit(), pathEnabled(), caTrusted()]);
  return {
    root: ROOT,
    config: config(),
    projects: projects().map((x) => ({ ...x, node_running: svc.nodeRunning(x.path), custom_vhost: { apache: exists(customFile("apache", x.domain)), nginx: exists(customFile("nginx", x.domain)) }, sqlite: sqliteFile(x) })),
    php: installedPhp(),
    components: Object.fromEntries(COMPONENTS.map((id) => [id, activeVersion(id)])) as Snapshot["components"],
    installed: Object.fromEntries(COMPONENTS.map((id) => [id, installedSeries(id)])) as Snapshot["installed"],
    services: svc.services(),
    instances: svc.instances(),
    updates: updateState(),
    runtime: { electron: process.versions.electron, chrome: process.versions.chrome, node: process.versions.node, timezone: timezone() },
    node,
    tools,
    system_git,
    dirty: svc.dirty(),
    path_enabled,
    ca_trusted,
  };
}

/** Applies a partial config; merged with the current config inside the queue so quick successive changes don't undo each other. */
function setConfig(patch: Partial<Config>) {
  return serial(async () => {
    const prev = config();
    if (patch.db_dir !== undefined && patch.db_dir) {
      const dir = path.resolve(patch.db_dir);
      const inside = (a: string, b: string) => (a + path.sep).toLowerCase().startsWith((b + path.sep).toLowerCase());
      if (inside(dir, p("bin")) || inside(dbRoot(prev.db_dir), dir) || inside(dir, dbRoot(prev.db_dir)))
        throw new Error(t("Choose a folder outside the app's binaries and the current databases folder"));
      patch = { ...patch, db_dir: norm(dir).toLowerCase() === norm(DEFAULT_DB_ROOT).toLowerCase() ? "" : dir };
    }
    const next: Config = { ...prev, ...patch, versions: { ...prev.versions, ...patch.versions }, ports: { ...prev.ports, ...patch.ports } };
    next.tld = next.tld.trim().toLowerCase();
    if (!/^[a-z0-9-]+$/.test(next.tld)) throw new Error(t("Invalid domain: {domain}", { domain: next.tld }));
    const ports = Object.values(next.ports);
    if (ports.some((x) => !Number.isInteger(x) || x < 1 || x > 65535)) throw new Error(t("Ports must be numbers from 1 to 65535"));
    const twice = ports.find((x, i) => ports.indexOf(x) !== i);
    if (twice) throw new Error(t("Port {port} is used twice", { port: twice }));
    for (const user of [next.mysql_user, next.pg_user]) {
      if (!/^[A-Za-z0-9_]+$/.test(user)) throw new Error(t("Database user: letters, digits and _ only"));
    }
    const movedPorts = (Object.keys(next.ports) as PortKey[]).filter((k) => prev.ports[k] !== next.ports[k]);
    // extra database versions get new ports after a changed family port
    for (const family of ["mysql", "postgres"] as const) {
      if (!movedPorts.includes(family)) continue;
      next.db_ports = Object.fromEntries(Object.entries(next.db_ports).filter(([id]) => familyOf(parseInstance(id)?.engine ?? "mysql") !== family));
    }
    // extra database versions keep their ports: a service can't take one of them
    for (const [id, port] of Object.entries(next.db_ports)) {
      if (ports.includes(port)) throw new Error(t("Port {port} is used by {name}", { port, name: id }));
    }
    // services whose binaries or ports change: another active version, MySQL <-> MariaDB, a new port.
    // They are stopped with the old config, so the right binaries and data folders are used for the shutdown.
    const affected = new Set<ServiceId>();
    if (prev.db_engine !== next.db_engine) affected.add("db");
    for (const k of movedPorts) {
      const service = k.split("_")[0];
      if (service !== "mysql" && service !== "postgres") affected.add(service as ServiceId);
    }
    for (const id of COMPONENTS) {
      if (activeSeries(id) === activeSeries(id, next.versions[id])) continue;
      const service = id === prev.db_engine ? "db" : (["apache", "nginx", "postgres", "mongodb", "redis", "memcached", "mailpit", "phpmyadmin"] as ServiceId[]).find((s) => s === id);
      if (service) affected.add(service);
    }
    const restart = [...affected].filter((s) => svc.serviceRunning(s));
    const wasRunning = svc.runningInstanceIds();
    for (const s of restart) await svc.stopService(s);
    // the databases folder moves with the services stopped, so the new paths are used when they start again
    const restartData = dbRoot(prev.db_dir) !== dbRoot(next.db_dir) ? await svc.moveDbRoot(dbRoot(prev.db_dir), dbRoot(next.db_dir)) : null;
    saveConfig(next);
    await restartData?.();
    nativeTheme.themeSource = next.theme;
    if (prev.launch_at_login !== next.launch_at_login) applyLoginItem(next.launch_at_login);
    if (prev.language !== next.language) setJumpList();
    // instances whose port changed (default engine/version or a family port) restart on the new port
    for (const id of svc.movedInstanceIds()) await svc.stopInstance(id);
    for (const s of restart) await svc.startService(s);
    const used = usedInstanceIds();
    for (const id of wasRunning) if (used.has(id) && instance(id)) await svc.startInstance(id);
    // projects follow their database server in .env / wp-config.php (unpinned ones: the default of the family they use)
    const dbChanged = prev.db_engine !== next.db_engine || movedPorts.some((k) => k === "mysql" || k === "postgres") || ["mysql", "mariadb", "postgres"].some((id) => prev.versions[id as ComponentId] !== next.versions[id as ComponentId]);
    if (dbChanged) for (const x of projects()) syncProjectDb(x);
    // new global database login: running servers switch now, the others when they start; projects on the old login follow
    for (const family of ["mysql", "postgres"] as const) {
      const key = family === "postgres" ? "pg" : "mysql";
      const from = { user: prev[`${key}_user`], password: prev[`${key}_password`] };
      const to = { user: next[`${key}_user`], password: next[`${key}_password`] };
      if (from.user === to.user && from.password === to.password) continue;
      try {
        for (const inst of svc.instances()) if (inst.family === family && inst.running) await applyCredentials(inst);
      } catch (e) {
        // keep the old login in Settings, so saving the same change again retries it
        saveConfig({ ...config(), [`${key}_user`]: from.user, [`${key}_password`]: from.password });
        throw e;
      }
      for (const x of projects()) syncProjectCredentials(x, family, from, to);
      if (family === "mysql" && svc.serviceRunning("phpmyadmin")) {
        await svc.stopService("phpmyadmin");
        await svc.startService("phpmyadmin");
      }
    }
    if (prev.timezone !== next.timezone) await applyTimezone();
    if (movedPorts.includes("mailpit_smtp")) {
      for (const x of projects()) syncProjectMail(x, prev.ports.mailpit_smtp, next.ports.mailpit_smtp);
      for (const v of installedPhp()) {
        await phpIniSet(v, { settings: { smtp_port: String(next.ports.mailpit_smtp) } });
        await svc.restartPhp(v);
      }
    }
    await reloadIfStale();
  });
}

/** PHP's date.timezone and PostgreSQL's timezone follow the Settings; running servers restart to pick it up. */
async function applyTimezone() {
  const tz = timezone();
  for (const v of installedPhp()) {
    await phpIniSet(v, { settings: { "date.timezone": tz } });
    await svc.restartPhp(v);
  }
  for (const inst of svc.instances().filter((x) => x.family === "postgres")) {
    if (!exists(pgConfFile(inst.series))) continue;
    pgConfSet(inst.series, { settings: { timezone: tz, log_timezone: tz } });
    if (inst.running) {
      await svc.stopInstance(inst.id);
      await svc.startInstance(inst.id);
    }
  }
}

/** Stops the running services that use a component series (to replace its files); returns them to start again. */
async function stopUsers(what: string, series: string) {
  const running = (ids: ServiceId[]) => ids.filter((id) => svc.serviceRunning(id));
  const active = activeSeries(what as ComponentId) === series;
  let ids: ServiceId[] = [];
  if (what === "php") ids = running(["apache", "nginx", ...(defaultPhp() === series ? (["phpmyadmin"] as ServiceId[]) : [])]);
  else if (["mysql", "mariadb", "postgres"].includes(what)) ids = running([`db:${what}-${series}`, ...(what === "postgres" && active ? (["pgadmin"] as ServiceId[]) : [])]);
  else if (active && ["apache", "nginx", "mongodb", "redis", "memcached", "mailpit", "phpmyadmin"].includes(what)) ids = running([what as ServiceId]);
  for (const id of ids) await svc.stopService(id);
  return ids.filter((id) => id !== "pgadmin");
}

function assertDomainFree(domain: string | undefined, dir: string) {
  const owner = domain && projects().find((x) => x.domain.toLowerCase() === domain && x.path !== dir);
  if (owner) throw new Error(t("Domain {domain} is already used by project {name}", { domain: domain!, name: owner.name }));
}

/** Creates the project's database on its server (started if needed) and points the project's config at it. */
async function useDatabase(x: Project) {
  const id = x.db === "sqlite" ? null : projectInstanceId(x.db);
  if (id && instance(id)) {
    if (!svc.instanceRunning(id)) await svc.startInstance(id);
    await dbCreate(id, x.db_name);
  }
  syncProjectDb(x, true);
}

function setProject(dir: string, settings: ProjectSettings) {
  return serial(async () => {
    const cfg = config();
    const key = norm(dir);
    if (settings.domain !== undefined) settings = { ...settings, domain: checkDomain(settings.domain) };
    assertDomainFree(settings.domain, key);
    if (settings.docroot !== undefined) checkDocroot(settings.docroot);
    if (settings.node !== undefined) pinNode(key, settings.node);
    const { node: _, ...rest } = settings;
    const dbChanged = settings.db !== undefined && (settings.db || "") !== (cfg.projects[key]?.db || "");
    const nameChanged = settings.db_name !== undefined && settings.db_name !== projects().find((x) => x.path === key)?.db_name;
    // a new document root may hold another kind of app (e.g. WordPress in public_html)
    if (settings.docroot !== undefined && settings.docroot !== cfg.projects[key]?.docroot && cfg.projects[key]?.type) {
      rest.type = detect(key, settings.docroot).type;
    }
    saveConfig({ ...cfg, projects: { ...cfg.projects, [key]: { ...cfg.projects[key], ...rest } } });
    const project = projects().find((x) => x.path === key);
    if ((dbChanged || nameChanged) && project) {
      try {
        await useDatabase({ ...project, db_name: settings.db_name ?? project.db_name });
      } catch (e) {
        // back to the previous database, so saving the same change again retries it
        const c = config();
        saveConfig({ ...c, projects: { ...c.projects, [key]: { ...c.projects[key], db: cfg.projects[key]?.db, db_name: cfg.projects[key]?.db_name } } });
        throw e;
      }
    }
    await reloadIfStale();
  });
}

function removeProject(dir: string, deleteFiles: boolean) {
  return serial(async () => {
    const key = norm(dir);
    await svc.stopNode(key);
    const cfg = config();
    const { [key]: _, ...rest } = cfg.projects;
    saveConfig({ ...cfg, projects: rest, imported: cfg.imported.filter((x) => norm(x) !== key) });
    if (deleteFiles) fs.rmSync(key, { recursive: true, force: true });
    await reloadIfStale();
  });
}

async function openTerminal(dir: string) {
  const env = await freshEnvWith(SHIMS);
  const wt = spawn("wt.exe", ["-d", dir], { env, detached: true, stdio: "ignore" });
  wt.on("error", () => spawn("cmd.exe", ["/c", "start", "powershell", "-NoExit"], { cwd: dir, env, detached: true, stdio: "ignore" }));
  wt.unref();
}

const USED_BY: Record<string, ServiceId> = {
  apache: "apache", nginx: "nginx", mongodb: "mongodb", redis: "redis", memcached: "memcached", mysql: "db", mariadb: "db", postgres: "postgres", mailpit: "mailpit", phpmyadmin: "phpmyadmin",
};

const handlers: Record<string, (a: any) => unknown> = {
  state: () => state(),
  set_config: ({ patch }: { patch: Partial<Config> }) => setConfig(patch),
  set_project: ({ path, settings }: { path: string; settings: ProjectSettings }) => setProject(path, settings),
  detect_project: ({ path: dir, docroot }: { path: string; docroot?: string }) => {
    if (docroot !== undefined) checkDocroot(docroot);
    const d = detect(dir, docroot);
    return { ...d, name: path.basename(dir), db_name: fileDbName(dir, d.type, d.docroot) || defaultDbName(path.basename(dir)) };
  },
  create_project: ({ spec }: { spec: CreateSpec }) =>
    serial(async () => {
      spec = { ...spec, domain: checkDomain(spec.domain) };
      assertDomainFree(spec.domain, norm(spec.path));
      await createProject(spec);
      // an imported project gets its database the same way as a changed one in the project settings
      const project = spec.import && spec.database !== "none" && projects().find((x) => x.path === norm(spec.path));
      if (project) await useDatabase({ ...project, db_name: spec.db_name });
      syncShims();
      for (const s of svc.WEB_SERVERS) if (activeVersion(s)) await svc.startServer(s);
    }),
  remove_project: ({ path, deleteFiles }: { path: string; deleteFiles: boolean }) => removeProject(path, deleteFiles),

  check_updates: () => checkUpdates(),
  download_update: () => downloadUpdate(),
  apply_update: () => applyUpdate(svc.services().filter((s) => s.running && s.id !== "pgadmin").map((s) => s.id)),
  update_component: ({ what, version }: { what: string; version: string }) =>
    serial(async () => {
      let stopped: ServiceId[] = [];
      try {
        await update(what, version, async () => {
          stopped = await stopUsers(what, version);
        });
        forgetBinary(what, version);
      } finally {
        syncShims();
        for (const s of stopped) await svc.startService(s);
      }
    }),

  start_service: ({ id }: { id: ServiceId }) => serial(() => svc.startService(id)),
  stop_service: ({ id }: { id: ServiceId }) => serial(() => svc.stopService(id)),
  start_all: () => serial(svc.startAll),
  reload_web: () => serial(svc.reloadWeb),
  stop_all: () => serial(svc.stopAll),
  start_node: ({ path }: { path: string }) => serial(() => svc.startNode(norm(path))),
  stop_node: ({ path }: { path: string }) => serial(() => svc.stopNode(norm(path))),

  php_releases: () => phpReleases().then((list) => list.map(({ minor, version }) => ({ minor, version }))),
  component_releases: ({ id }: { id: ComponentId }) => componentReleases(id),
  install: async ({ what, version }: { what: string; version: string }) => {
    await install(what, version);
    pickDbEngine();
    syncShims();
    // the PHP extension that came with it (redis, memcached, mongodb) reaches running PHP after a restart
    if (["redis", "memcached", "mongodb"].includes(what)) {
      await serial(async () => {
        for (const v of installedPhp()) await svc.restartPhp(v);
        if (svc.serviceRunning("phpmyadmin")) {
          await svc.stopService("phpmyadmin");
          await svc.startService("phpmyadmin");
        }
      });
    }
  },
  uninstall: ({ what, version }: { what: string; version: string }) =>
    serial(async () => {
      const id = USED_BY[what];
      const inUse = what === "php" || activeSeries(what as ComponentId) === version;
      const instanceUp = ["mysql", "mariadb", "postgres"].includes(what) && svc.instanceRunning(`${what}-${version}`);
      if (instanceUp || (what === "php" && svc.webRunning()) || (id && inUse && svc.serviceRunning(id))) throw new Error(t("Stop the service that uses this component first"));
      uninstall(what, version);
      if (what === "mailpit" && !installedSeries("mailpit").length) await setUserEnv("MP_DATABASE", null);
      pickDbEngine();
      syncShims();
    }),

  nvm_install: () => nvmInstall(),
  node_releases: () => nodeReleases(),
  node_install: ({ version }: { version: string }) => nodeInstall(version),
  node_uninstall: ({ version }: { version: string }) => nodeUninstall(version),
  node_default: ({ version }: { version: string }) => nodeDefault(version),
  install_tool: ({ tool }: { tool: JsTool }) => installTool(tool),
  uninstall_tool: ({ tool }: { tool: JsTool }) => uninstallTool(tool),

  databases: () => databases(),
  db_create: ({ instance, name }: { instance: string; name: string }) => dbCreate(instance, name),
  db_drop: ({ instance, name }: { instance: string; name: string }) => dbDrop(instance, name),
  db_export: async ({ instance, name }: { instance: string; name: string }) => {
    const stamp = new Date().toISOString().slice(0, 16).replace(/[-:]/g, "").replace("T", "-");
    const r = await dialog.showSaveDialog(BrowserWindow.getFocusedWindow()!, {
      defaultPath: `${name}-${instance}-${stamp}.sql.gz`,
      filters: [{ name: "SQL (gzip)", extensions: ["gz"] }],
    });
    if (r.canceled || !r.filePath) return null;
    await exportDatabase(instance, name, r.filePath);
    return r.filePath;
  },
  db_export_all: async () => {
    const stamp = new Date().toISOString().slice(0, 10).replace(/-/g, "");
    const r = await dialog.showSaveDialog(BrowserWindow.getFocusedWindow()!, {
      defaultPath: `lokal-databases-${stamp}.zip`,
      filters: [{ name: "ZIP", extensions: ["zip"] }],
    });
    if (r.canceled || !r.filePath) return null;
    await serial(() => exportAll(r.filePath!));
    return r.filePath;
  },
  pick_dump: async () => {
    const r = await dialog.showOpenDialog(BrowserWindow.getFocusedWindow()!, {
      properties: ["openFile"],
      filters: [{ name: t("Database dumps"), extensions: ["sql", "gz", "zip"] }],
    });
    return r.canceled ? null : r.filePaths[0];
  },
  db_inspect: ({ file }: { file: string }) => inspectDump(file),
  db_import: ({ spec }: { spec: Parameters<typeof importDump>[0] }) => serial(() => importDump(spec)),

  logs: () => fs.readdirSync(p("logs")).filter((f) => f.endsWith(".log")).sort(),
  log_read: ({ name }: { name: string }) => {
    const text = fs.readFileSync(p("logs", path.basename(name)), "utf8");
    return text.split(/\r?\n/).slice(-500).join("\n");
  },
  log_clear: ({ name }: { name: string }) => fs.writeFileSync(p("logs", path.basename(name)), ""),

  set_path: ({ enabled }: { enabled: boolean }) => setPath(enabled),
  trust_ca: () => trustCa(),
  open_dir: ({ path: dir }: { path: string }) => shell.openPath(dir).then((err) => err && Promise.reject(new Error(err))),
  open_terminal: ({ path: dir }: { path: string }) => openTerminal(dir),
  open_pgadmin: () => openPgAdmin(),
  open_phpmyadmin: () => openWebTool("phpmyadmin"),
  open_mailpit: () => openWebTool("mailpit"),
  open_url: ({ url }: { url: string }) => openLink(url),
  // config editors work per database instance ("mariadb-11.4", "postgres-17")
  db_config_get: ({ id }: { id: string }) => {
    const inst = requireInstance(id);
    if (inst.family === "mysql") return myIniGet(inst.engine as DbEngine, inst.series, inst.port);
    // creating the cluster must not race a PostgreSQL start that initialises it too
    return serial(async () => {
      await svc.initPostgres(inst.series);
      return pgConfGet(inst.series);
    });
  },
  db_config_set: ({ id, change }: { id: string; change: { raw?: string; settings?: Record<string, string> } }) =>
    serial(async () => {
      const inst = requireInstance(id);
      if (inst.family === "postgres") pgConfSet(inst.series, change);
      else myIniSet(inst.engine as DbEngine, inst.series, inst.port, change);
      if (svc.instanceRunning(id)) {
        await svc.stopInstance(id);
        await svc.startInstance(id);
      }
    }),
  php_ini_get: ({ version }: { version: string }) => phpIniGet(version),
  php_ini_set: ({ version, change }: { version: string; change: Parameters<typeof phpIniSet>[1] }) =>
    serial(async () => {
      const warnings = await phpIniSet(version, change);
      // php-cgi workers and phpMyAdmin's built-in server read php.ini only at startup
      await svc.restartPhp(version);
      if (svc.serviceRunning("phpmyadmin") && defaultPhp() === version) {
        await svc.stopService("phpmyadmin");
        await svc.startService("phpmyadmin");
      }
      return warnings;
    }),
  open_vhosts: ({ server }: { server: WebServer }) => {
    fs.mkdirSync(sitesDir(server), { recursive: true });
    return shell.openPath(sitesDir(server));
  },
  vhost_customize: ({ path: dir, server }: { path: string; server: WebServer }) =>
    serial(async () => {
      const x = projects().find((p) => p.path === norm(dir));
      if (!x) throw new Error(t("Project not found"));
      const custom = customFile(server, x.domain);
      if (!exists(custom)) {
        if (!exists(autoFile(server, x.domain))) svc.writeWebConfig(server);
        fs.copyFileSync(autoFile(server, x.domain), custom);
      }
      await shell.openPath(custom);
      await reloadIfStale();
    }),
  vhost_reset: ({ path: dir, server }: { path: string; server: WebServer }) =>
    serial(async () => {
      const x = projects().find((p) => p.path === norm(dir));
      if (x) fs.rmSync(customFile(server, x.domain), { force: true });
      await reloadIfStale();
    }),
  pick_folder: async ({ defaultPath }: { defaultPath?: string }) => {
    const r = await dialog.showOpenDialog(BrowserWindow.getFocusedWindow()!, {
      properties: ["openDirectory", "createDirectory"],
      defaultPath: defaultPath || undefined,
    });
    return r.canceled ? null : r.filePaths[0];
  },
};

/** Only web links leave the app; file:, ms-settings: and other schemes could start programs. */
function openLink(url: string) {
  if (!/^https?:$/.test(new URL(url).protocol)) throw new Error(t("Only http and https links can be opened"));
  return shell.openExternal(url);
}

ipcMain.handle("invoke", async (e, cmd: string, args: unknown) => {
  try {
    // only lokaldev's own page may call into the main process
    if (!win || e.sender !== win.webContents || e.senderFrame !== win.webContents.mainFrame) throw new Error(t("Unknown command: {cmd}", { cmd }));
    const handler = handlers[cmd];
    if (!handler) throw new Error(t("Unknown command: {cmd}", { cmd }));
    return { ok: true, value: (await handler(args ?? {})) ?? null };
  } catch (e) {
    return { ok: false, error: errorText(e) };
  }
});

let win: BrowserWindow | undefined;
let quitting = false;

function createWindow(show: boolean) {
  nativeTheme.themeSource = config().theme;
  win = new BrowserWindow({
    width: 1320,
    height: 860,
    minWidth: 1000,
    minHeight: 640,
    title: "lokaldev",
    show,
    backgroundColor: nativeTheme.shouldUseDarkColors ? "#202020" : "#f3f3f3",
    autoHideMenuBar: true,
    webPreferences: { preload: path.join(__dirname, "preload.cjs"), sandbox: true, contextIsolation: true, nodeIntegration: false },
  });
  // links open in the browser; the window itself never navigates away from lokaldev
  win.webContents.setWindowOpenHandler(({ url }) => (openLink(url).catch(() => {}), { action: "deny" }));
  win.webContents.on("will-navigate", (e, url) => {
    if (url !== win?.webContents.getURL()) e.preventDefault();
  });
  // closing the window keeps lokaldev (and its services) running in the notification area
  win.on("close", (e) => {
    if (quitting) return;
    e.preventDefault();
    win!.hide();
    // shown once ever, after the window is closed for the first time
    if (!exists(p("tray-hint-shown"))) {
      fs.writeFileSync(p("tray-hint-shown"), "");
      balloon(t("lokaldev is still running in the notification area."));
    }
  });
  if (process.env.ELECTRON_RENDERER_URL) win.loadURL(process.env.ELECTRON_RENDERER_URL);
  else win.loadFile(path.join(__dirname, "renderer", "index.html"));
}

function showWindow() {
  if (!win || win.isDestroyed()) createWindow(true);
  else {
    if (win.isMinimized()) win.restore();
    win.show();
    win.focus();
  }
}

const notifyError = (e: unknown) => balloon(errorText(e));

const startAll = () => serial(() => svc.startAll()).catch(notifyError);

/** Shortcuts (Dashboard, tray): start the tool when it isn't running, then open it. */
const openWebTool = (id: "phpmyadmin" | "mailpit") =>
  serial(async () => {
    if (!svc.serviceRunning(id)) await svc.startService(id);
    await shell.openExternal(`http://127.0.0.1:${port(id === "mailpit" ? "mailpit_web" : id)}`);
  });
const openPgAdmin = () => serial(() => svc.startService("pgadmin"));
const stopAll = () => serial(svc.stopAll).catch(notifyError);

/** Flags come from the jump list, the login item (--hidden) or a second launch. */
function handleArgs(argv: string[]) {
  if (argv.includes("--quit")) return app.quit();
  if (argv.includes("--start-all")) startAll();
  else if (argv.includes("--stop-all")) stopAll();
  else if (!argv.includes("--hidden")) showWindow();
}

export function applyLoginItem(enabled: boolean) {
  if (app.isPackaged) app.setLoginItemSettings({ openAtLogin: enabled, path: process.execPath, args: ["--hidden"] });
}

app.on("second-instance", (_e, argv) => handleArgs(argv));

app.whenReady().then(async () => {
  if (process.argv.includes("--quit")) return app.quit();
  await cleanupOrphans();
  if (config().launch_at_login) applyLoginItem(true);
  recoverUpdates();
  migrateLayout();
  pickDbEngine();
  syncShims();
  // PATH enabled before data\composer existed: set it up now
  pathEnabled().then((on) => (on ? composerHome(true) : undefined)).catch((e) => console.error(e));
  createWindow(!process.argv.includes("--hidden"));
  createTray({
    show: showWindow,
    startAll,
    stopAll,
    phpMyAdmin: () => openWebTool("phpmyadmin").catch(notifyError),
    mailpit: () => openWebTool("mailpit").catch(notifyError),
    pgAdmin: () => openPgAdmin().catch(notifyError),
    installed: (id) => !!svc.services().find((s) => s.id === id)?.installed,
    quit: () => app.quit(),
    status: () => {
      const installed = svc.services().filter((s) => s.installed);
      return t("{n}/{total} services running", { n: installed.filter((s) => s.running).length, total: installed.length });
    },
  });
  setJumpList();
  scheduleChecks(() => {});
  const resume = afterUpdate() as ServiceId[];
  if (resume.length) {
    serial(async () => {
      for (const id of resume) await svc.startService(id);
    }).catch(notifyError);
  } else if (process.argv.includes("--start-all")) startAll();
  else if (config().start_all_on_launch) serial(() => svc.startAll(config().launch_skip)).catch(notifyError);
  else if (process.argv.includes("--stop-all")) stopAll();
});

app.on("before-quit", (e) => {
  if (quitting) return;
  e.preventDefault();
  quitting = true;
  destroyTray();
  // let a running operation (start, import, project creation) finish first, but don't hang on it forever
  Promise.race([queue, new Promise((r) => setTimeout(r, 30000))])
    .then(() => svc.stopAll())
    .finally(() => app.exit(0));
});
