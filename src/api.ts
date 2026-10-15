import type { Lang } from "./i18n";
// Contract between the React UI and the Electron main process (electron/). Keep both sides in sync.
declare global {
  interface Window {
    lokal: {
      invoke: (cmd: string, args?: unknown) => Promise<{ ok: true; value: unknown } | { ok: false; error: string }>;
      on: (event: string, cb: (payload: unknown) => void) => () => void;
    };
  }
}

async function invoke<T>(cmd: string, args?: unknown): Promise<T> {
  const r = await window.lokal.invoke(cmd, args);
  if (!r.ok) throw r.error;
  return r.value as T;
}

const listen = <T>(event: string, cb: (payload: T) => void) =>
  Promise.resolve(window.lokal.on(event, (p) => cb(p as T)));

export type Theme = "system" | "light" | "dark";
export type { Lang };
export type ProjectType = "laravel" | "symfony" | "wordpress" | "node" | "python" | "custom";

/** Node.js and Python projects run their own server; the web server proxies to their app port. */
export const proxied = (type: ProjectType) => type === "node" || type === "python";
export type WebServer = "apache" | "nginx";
export type DbEngine = "mysql" | "mariadb";
export type JsTool = "pnpm" | "deno" | "bun";
/** Ports of the default services, editable in Settings; extra database versions take the next free ports after mysql/postgres. */
export type PortKey =
  | "apache_http" | "apache_https" | "nginx_http" | "nginx_https" | "mysql" | "postgres" | "mongodb" | "redis" | "memcached"
  | "mailpit_smtp" | "mailpit_web" | "phpmyadmin";

export type DbFamily = "mysql" | "postgres"; // "mysql" = MySQL or MariaDB

/** A database server: one per installed engine+series; defaults run on ports.mysql / ports.postgres, the others on the next free ports. */
export interface DbInstance {
  id: string;            // "mariadb-11.4", "mysql-8.4", "postgres-17"
  engine: "mysql" | "mariadb" | "postgres";
  series: string;
  version: string;
  family: DbFamily;
  port: number;
  default: boolean;      // the default of its family
  running: boolean;
  used: boolean;         // a default or chosen by a project, so "Start all" starts it
}

export type ServiceId = WebServer | "db" | "postgres" | "mongodb" | "redis" | "memcached" | "mailpit" | "phpmyadmin" | "pgadmin" | `db:${string}`; // "db:<instance>" = any database instance
export type ComponentId =
  | "apache" | "nginx" | "mysql" | "mariadb" | "postgres" | "mongodb" | "redis" | "memcached" | "mailpit" | "phpmyadmin" | "composer"
  | "wpcli" | "git" | "python" | "sqlite";

/** Per-project overrides stored in config.json, keyed by absolute project path. Missing fields fall back to defaults. */
export interface ProjectSettings {
  type?: ProjectType;
  php?: string;        // "8.4"
  node?: string;       // "22.12.0" (written to .nvmrc via `nvm pin`)
  python?: string;     // "3.13"; unset/"" = the default Python
  domain?: string;     // "blog.test"
  ssl?: boolean;
  docroot?: string;    // relative to project path, "" = project root
  node_port?: number;  // node projects: app port the web server proxies to
  node_cmd?: string;   // node projects: e.g. "npm run dev"
  db?: string;         // database instance id ("mysql-8.4"), "sqlite"; unset/"" = the default MySQL-compatible instance
  db_name?: string;    // a changed db or db_name creates that database on save
}

export interface Config {
  projects_dir: string;
  tld: string;                 // "test"
  db_engine: DbEngine;         // the default MySQL-compatible engine (on ports.mysql)
  default_php: string;
  ssl_default: boolean;
  theme: Theme;
  language: Lang;              // UI and error message language, default "en"
  ports: Record<PortKey, number>;
  mysql_user: string;          // global MySQL/MariaDB login ("root")
  mysql_password: string;      // "" = no password
  pg_user: string;             // global PostgreSQL superuser ("postgres")
  pg_password: string;
  db_applied: Record<string, { user: string; password: string }>; // login each database instance actually has (internal)
  timezone: string;            // IANA name; "" = the system's
  update_check: boolean;       // look for updates once a day
  db_dir: string;              // where database data lives; "" = data\db
  db_ports: Record<string, number>; // ports of non-default database instances, allocated automatically
  versions: Partial<Record<ComponentId, string>>; // active series per component, e.g. { mariadb: "11.4" }; newest installed when unset
  launch_at_login: boolean;    // start with Windows, hidden in the notification area
  start_all_on_launch: boolean; // start services when lokaldev opens
  launch_skip: string[];       // services left out of that (new services start by default)
  projects: Record<string, ProjectSettings>;
  imported: string[];          // project paths outside projects_dir
}

export interface Project {
  name: string;
  path: string;
  type: ProjectType;
  domain: string;
  url: string;                 // https://… when ssl, else http://…
  php: string;                 // "" when no PHP installed
  node: string;                // "" when not pinned
  python: string;              // "" = the default Python
  ssl: boolean;
  docroot: string;             // relative
  imported: boolean;
  node_port: number;
  node_cmd: string;
  node_running: boolean;       // node projects only
  custom_vhost: Record<WebServer, boolean>; // a hand-written <domain>.conf overrides the generated auto.<domain>.conf
  db: string;                  // database instance setting ("" = default MySQL-compatible instance, "sqlite" = a file)
  sqlite: string | null;       // SQLite file when the project uses one
  db_name: string;             // from .env / wp-config.php, else the saved or a name made from the folder
}

export interface Service {
  id: ServiceId;
  name: string;                // "Apache 2.4.69", "MariaDB 11.4.8", "PostgreSQL 17.6", "Mailpit", "phpMyAdmin"
  installed: boolean;
  running: boolean;
  ports: number[];
  url: string | null;          // web UI if any (Mailpit, phpMyAdmin)
  group: "web" | "db" | "cache" | "tools";
  projects: number | null;     // projects using it; null = not tied to projects (phpMyAdmin)
  default?: boolean;           // the default database server of its family
}

/** lokaldev releases on GitHub and newer versions of installed binaries. */
export interface UpdateState {
  current: string;                 // running app version
  checked: string | null;          // ISO time of the last check
  app: { version: string; notes: string; page: string } | null; // a newer lokaldev release
  binaries: Record<string, string>; // "php/8.4" → newest version of that installed series
  downloaded: boolean;             // the app update is unpacked and ready for "Restart to update"
}

export interface NodeState {
  nvm: "missing" | "old" | "ok"; // "old" = nvm-windows 1.x (no per-project support)
  nvm_version: string;
  installed: string[];           // "22.23.3", newest first
  default: string;
}

export interface Snapshot {
  root: string;                  // portable folder of the exe
  config: Config;
  projects: Project[];
  php: string[];                 // installed PHP minor versions, ascending ("7.4", "8.4")
  components: Record<ComponentId, string | null>; // version of the active series, null = not installed
  installed: Record<ComponentId, { series: string; version: string }[]>; // all installed series, newest first
  services: Service[];
  instances: DbInstance[];
  updates: UpdateState;
  runtime: { electron: string; chrome: string; node: string; timezone: string }; // About; timezone = the one in effect       // installed database servers, defaults first
  node: NodeState;
  system_git: string | null;     // Git found outside lokaldev (version); then lokaldev doesn't offer its own
  tools: Record<JsTool, { version: string | null; managed: boolean }>; // managed = installed by lokaldev in data\bin
  dirty: boolean;               // web server running with stale config → offer reload
  path_enabled: boolean;         // shims dir is on user PATH
  ca_trusted: boolean;           // local CA installed in the user Root store
}

export interface PhpIni {
  extensions: { name: string; zend: boolean; enabled: boolean }[]; // every php_*.dll in ext/
  settings: Record<string, string>;                                // effective values of the common directives
  raw: string;
}


/** my.ini ([mysqld] section) or postgresql.conf */
export interface DbConf {
  settings: Record<string, string>; // common directives present in the file
  raw: string;
  managed: string[];                // keys lokaldev controls itself (port, datadir, …)
}

/** A release line of a component: installs of one series replace each other, different series live side by side. */
export interface ComponentRelease { series: string; version: string; note: string }

export interface PhpRelease { minor: string; version: string }
export interface NodeRelease { version: string; lts: string | null; date: string }
export interface Database { engine: "mysql" | "mariadb" | "postgres"; instance: string; port: number; name: string; system: boolean }

/** A database found in a dump. source: archive folder ("mariadb-11.4"; "mysql"/"postgres" in older archives), otherwise the family. */
export interface DumpDatabase { family: DbFamily; source: string; name: string; system: boolean; instance: string | null; entry?: string } // instance: where an archive entry goes; entry: its path in the zip

export interface DumpInfo {
  file: string;
  kind: "single" | "multi" | "archive"; // one database / mysqldump --databases|--all-databases / lokaldev "export all" zip
  family: "mysql" | "postgres";
  databases: DumpDatabase[];           // empty for "single"
  suggested: string;                   // target name for "single", from the file name
}

export interface ImportResult { imported: string[]; failed: { name: string; error: string }[] }

export interface CreateSpec {
  type: ProjectType | "empty"; // "empty": only the folder and the vhost (saved as custom)
  name: string;
  path: string;                  // absolute target folder (must not exist or be empty); for import = existing folder
  import: boolean;
  php: string;
  node: string;                  // "" = don't pin
  python: string;                // "" = the default Python
  database: string;    // "none", "sqlite", "" (the default MySQL-compatible server) or a database instance id ("mariadb-11.4", "postgres-17")
  db_name: string;
  domain: string;
  ssl: boolean;
  docroot: string;               // "" = auto
  node_port: number;
  node_cmd: string;
  install_deps: boolean;         // npm install / composer install where relevant
}

/** Progress of downloads: id is "php-8.4", "apache", "node-22.12.0", "nvm", … */
export interface Progress { id: string; done?: number; total?: number; stage?: "extract" | "install"; label?: string }

export const api = {
  state: () => invoke<Snapshot>("state"),
  // only the changed fields; the backend merges them into the current config (versions are merged per component)
  setConfig: (patch: Partial<Config>) => invoke<void>("set_config", { patch }),
  setProject: (path: string, settings: ProjectSettings) => invoke<void>("set_project", { path, settings }),
  detectProject: (path: string, docroot?: string) => invoke<{ type: ProjectType; docroot: string; name: string; db_name: string }>("detect_project", { path, docroot }),
  createProject: (spec: CreateSpec) => invoke<void>("create_project", { spec }), // streams "task-log"
  removeProject: (path: string, deleteFiles: boolean) => invoke<void>("remove_project", { path, deleteFiles }),

  startService: (id: ServiceId) => invoke<void>("start_service", { id }),
  stopService: (id: ServiceId) => invoke<void>("stop_service", { id }),
  startAll: () => invoke<void>("start_all"),
  stopAll: () => invoke<void>("stop_all"),
  startNode: (path: string) => invoke<void>("start_node", { path }),
  stopNode: (path: string) => invoke<void>("stop_node", { path }),

  phpReleases: () => invoke<PhpRelease[]>("php_releases"),
  componentReleases: (id: ComponentId) => invoke<ComponentRelease[]>("component_releases", { id }),
  // version = PHP minor or component series; progress id "<what>-<version>"
  install: (what: "php" | ComponentId, version: string) => invoke<void>("install", { what, version }),
  uninstall: (what: "php" | ComponentId, version: string) => invoke<void>("uninstall", { what, version }),

  nvmInstall: () => invoke<void>("nvm_install"),
  nodeReleases: () => invoke<NodeRelease[]>("node_releases"),
  nodeInstall: (version: string) => invoke<void>("node_install", { version }),
  nodeUninstall: (version: string) => invoke<void>("node_uninstall", { version }),
  nodeDefault: (version: string) => invoke<void>("node_default", { version }),
  installTool: (tool: JsTool) => invoke<void>("install_tool", { tool }), // progress id "tool-<name>"
  uninstallTool: (tool: JsTool) => invoke<void>("uninstall_tool", { tool }),

  databases: () => invoke<Database[]>("databases"),
  dbCreate: (instance: string, name: string) => invoke<void>("db_create", { instance, name }),
  dbDrop: (instance: string, name: string) => invoke<void>("db_drop", { instance, name }),
  // export/import open their own save/open dialogs; null = cancelled. Progress ids: "export-<name>", "export-all", "import".
  dbExport: (instance: string, name: string) => invoke<string | null>("db_export", { instance, name }),
  dbExportAll: () => invoke<string | null>("db_export_all"),
  pickDump: () => invoke<string | null>("pick_dump"),
  dbInspect: (file: string) => invoke<DumpInfo>("db_inspect", { file }),
  // databases: "<source>/<name>" keys for multi/archive; target: database name for single; instance: target of single/multi
  dbImport: (spec: { file: string; databases: string[]; target: string; instance: string; mode: "replace" | "merge" }) => invoke<ImportResult>("db_import", { spec }),

  checkUpdates: () => invoke<UpdateState>("check_updates"),
  downloadUpdate: () => invoke<void>("download_update"), // progress id "update"
  applyUpdate: () => invoke<void>("apply_update"),       // quits; the new version starts by itself
  updateComponent: (what: "php" | ComponentId, version: string) => invoke<void>("update_component", { what, version }), // progress id "<what>-<series>"

  logs: () => invoke<string[]>("logs"),                       // file names in logs/
  logRead: (name: string) => invoke<string>("log_read", { name }), // last ~500 lines
  logClear: (name: string) => invoke<void>("log_clear", { name }),

  setPath: (enabled: boolean) => invoke<void>("set_path", { enabled }),
  trustCa: () => invoke<void>("trust_ca"),
  openDir: (path: string) => invoke<void>("open_dir", { path }),
  openTerminal: (path: string) => invoke<void>("open_terminal", { path }),
  openPgAdmin: () => invoke<void>("open_pgadmin"),
  openPhpMyAdmin: () => invoke<void>("open_phpmyadmin"), // starts it first when it isn't running
  openMailpit: () => invoke<void>("open_mailpit"), // same
  dbConfigGet: (id: string) => invoke<DbConf>("db_config_get", { id }), // per database instance
  // restarts the database if running; rejects with the server's error lines when it doesn't come back
  dbConfigSet: (id: string, change: { raw?: string; settings?: Record<string, string> }) => invoke<void>("db_config_set", { id, change }),
  phpIniGet: (version: string) => invoke<PhpIni>("php_ini_get", { version }),
  // returns PHP startup warnings ("" when clean); restarts services using this version
  phpIniSet: (version: string, change: { raw?: string; extensions?: Record<string, boolean>; settings?: Record<string, string> }) =>
    invoke<string>("php_ini_set", { version, change }),
  vhostCustomize: (path: string, server: WebServer) => invoke<void>("vhost_customize", { path, server }), // copies the auto config to <domain>.conf and opens it
  vhostReset: (path: string, server: WebServer) => invoke<void>("vhost_reset", { path, server }),
  openVhosts: (server: WebServer) => invoke<void>("open_vhosts", { server }),
  reloadWeb: () => invoke<void>("reload_web"), // restarts web servers running with an outdated config
  openUrl: (url: string) => invoke<void>("open_url", { url }),
  pickFolder: (defaultPath?: string) => invoke<string | null>("pick_folder", { defaultPath }),
};

export const onProgress = (cb: (p: Progress) => void) => listen<Progress>("progress", cb);
export const onTaskLog = (cb: (line: string) => void) => listen<string>("task-log", cb);
