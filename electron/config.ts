import fs from "node:fs";
import path from "node:path";
import type { Config, PortKey, Project, ProjectType } from "../src/api";
import { exists, p, ROOT, slug, versionKey } from "./util";
import { setLang, t } from "../src/i18n";

const defaults: Config = {
  projects_dir: "",
  tld: "test",
  db_engine: "mariadb",
  default_php: "",
  ssl_default: true,
  theme: "system",
  language: "en",
  ports: {
    apache_http: 80, apache_https: 443, nginx_http: 8080, nginx_https: 8443, mysql: 3306, postgres: 5432,
    mongodb: 27017, redis: 6379, memcached: 11211,
    mailpit_smtp: 1025, mailpit_web: 8025, phpmyadmin: 8888,
  },
  mysql_user: "root",
  mysql_password: "",
  pg_user: "postgres",
  pg_password: "",
  db_applied: {},
  timezone: "",
  update_check: true,
  db_dir: "",
  db_ports: {},
  versions: {},
  launch_at_login: false,
  start_all_on_launch: false,
  launch_skip: [],
  projects: {},
  imported: [],
};

let cfg: Config = load();
setLang(cfg.language);

function load(): Config {
  try {
    const saved = JSON.parse(fs.readFileSync(p("config.json"), "utf8"));
    // 1.0.0-beta.4 had "none" for PHP, Python and the database; those projects go back to the defaults
    for (const s of Object.values(saved.projects ?? {}) as Record<string, unknown>[]) {
      for (const k of ["php", "python", "db"]) if (s[k] === "none") delete s[k];
    }
    return withProjectsDir({ ...defaults, ...saved, ports: { ...defaults.ports, ...saved.ports } });
  } catch {
    return withProjectsDir({ ...defaults });
  }
}

/** Projects go to the www folder next to the exe unless another folder was chosen. */
function withProjectsDir(c: Config): Config {
  if (c.projects_dir) return c;
  const dir = path.join(ROOT, "www");
  fs.mkdirSync(dir, { recursive: true });
  return { ...c, projects_dir: dir };
}

export const config = () => cfg;
export const port = (key: PortKey) => cfg.ports[key];

/** Time zone for PHP, PostgreSQL and app processes: the one from Settings, else the system's. */
export const timezone = () => cfg.timezone || Intl.DateTimeFormat().resolvedOptions().timeZone;

/** Address part for a port that isn't the protocol default (":8443"). */
export const portSuffix = (ssl: boolean, port: number) => (port === (ssl ? 443 : 80) ? "" : `:${port}`);

export function saveConfig(c: Config) {
  cfg = { ...defaults, ...c, ports: { ...defaults.ports, ...c.ports } };
  setLang(cfg.language);
  fs.writeFileSync(p("config.json"), JSON.stringify(cfg, null, 2));
}

export const norm = (dir: string) => path.resolve(dir);

export function installedPhp() {
  const dir = p("bin", "php");
  return fs
    .readdirSync(dir)
    .filter((v) => exists(path.join(dir, v, "php-cgi.exe")))
    .sort((a, b) => versionKey(a).localeCompare(versionKey(b)));
}

export function defaultPhp() {
  const php = installedPhp();
  return php.includes(cfg.default_php) ? cfg.default_php : (php.at(-1) ?? "");
}

/** The type a folder's own files point to, if any. */
function typeOf(dir: string): ProjectType | null {
  const has = (f: string) => exists(path.join(dir, f));
  let composer = "";
  try {
    composer = fs.readFileSync(path.join(dir, "composer.json"), "utf8");
  } catch {}
  if (composer.includes('"laravel/framework"')) return "laravel";
  if (composer.includes('"symfony/framework-bundle"')) return "symfony";
  if (["wp-config.php", "wp-config-sample.php", "wp-load.php"].some(has)) return "wordpress";
  if (["manage.py", "pyproject.toml", "requirements.txt"].some(has) && !composer && !has("index.php")) return "python";
  if (has("package.json") && !composer && !has("index.php")) return "node";
  return null;
}

/**
 * Project type and suggested document root. The document root (given, or the usual public/public_html/… folder) is
 * checked first, then every folder above it up to the project folder: WordPress in public_html is found there, while
 * a Laravel app with document root "public" is found by its composer.json one level up.
 */
export function detect(dir: string, docroot?: string): { type: ProjectType; docroot: string } {
  const start = docroot ?? ["public", "public_html", "htdocs", "www", "web"].find((d) => exists(path.join(dir, d))) ?? "";
  for (let rel = path.normalize(start); ; rel = path.dirname(rel)) {
    const level = rel === "." ? "" : rel;
    const type = typeOf(path.join(dir, level));
    if (type === "laravel" || type === "symfony") return { type, docroot: path.join(level, "public") };
    if (type === "wordpress") return { type, docroot: level };
    if (type) return { type, docroot: "" };
    if (!level || path.dirname(rel) === rel) break;
  }
  return { type: "custom", docroot: start };
}

/** A document root is a folder inside the project, relative to it. */
export function checkDocroot(docroot: string) {
  const rel = path.normalize(docroot || ".");
  if (path.isAbsolute(rel) || /^[a-z]:/i.test(rel) || rel === ".." || rel.startsWith(`..${path.sep}`)) {
    throw new Error(t("The document root must be inside the project folder."));
  }
}

/** WordPress keeps wp-config.php in its own folder (the document root) or one level above it. */
export const wpConfig = (dir: string, docroot: string) =>
  [path.join(dir, docroot, "wp-config.php"), path.join(dir, "wp-config.php")].find(exists) ?? path.join(dir, docroot, "wp-config.php");

/** The database name in the project's .env / wp-config.php, "" when there's none (or it's SQLite). */
export function fileDbName(dir: string, type: ProjectType, docroot: string) {
  const read = (f: string) => (exists(path.join(dir, f)) ? fs.readFileSync(path.join(dir, f), "utf8") : "");
  if (type === "laravel") {
    const s = read(".env");
    return /^DB_CONNECTION=sqlite/m.test(s) ? "" : (s.match(/^DB_DATABASE="?([^"\r\n]*)"?/m)?.[1].trim() ?? "");
  }
  if (type === "symfony") return read(".env").match(/^DATABASE_URL="?(?!sqlite)\w+:\/\/[^/]*\/([^?"\r\n]*)/m)?.[1] ?? "";
  if (type === "wordpress") {
    const file = wpConfig(dir, docroot);
    const name = (exists(file) ? fs.readFileSync(file, "utf8") : "").match(/define\(\s*'DB_NAME'\s*,\s*'([^']*)'/)?.[1] ?? "";
    return name === "database_name_here" ? "" : name;
  }
  return "";
}

export const defaultDbName = (name: string) => slug(name).replace(/-/g, "_");

export function projects(): Project[] {
  const dirs = new Map<string, boolean>();
  if (cfg.projects_dir && exists(cfg.projects_dir)) {
    for (const e of fs.readdirSync(cfg.projects_dir, { withFileTypes: true })) {
      if (e.isDirectory() && !e.name.startsWith(".")) dirs.set(norm(path.join(cfg.projects_dir, e.name)), false);
    }
  }
  for (const dir of cfg.imported) if (exists(dir) && !dirs.has(norm(dir))) dirs.set(norm(dir), true);

  const php = installedPhp();
  const def = defaultPhp();
  // explicit domains are reserved first; a default that collides (foo_bar vs foo-bar) gets a -2, -3… suffix
  const taken = new Set([...dirs.keys()].map((dir) => cfg.projects[dir]?.domain).filter(Boolean));
  const unique = (base: string) => {
    let domain = `${base}.${cfg.tld}`;
    for (let i = 2; taken.has(domain); i++) domain = `${base}-${i}.${cfg.tld}`;
    taken.add(domain);
    return domain;
  };
  return [...dirs]
    .sort(([a], [b]) => a.localeCompare(b, undefined, { sensitivity: "base" }))
    .map(([dir, imported]) => {
      const s = cfg.projects[dir] ?? {};
      const d = detect(dir, s.docroot);
      const name = path.basename(dir);
      const ssl = s.ssl ?? cfg.ssl_default;
      const domain = s.domain || unique(slug(name));
      const type = s.type && s.type !== "custom" ? s.type : d.type; // "custom" (also an empty project) follows what the files show
      let node = "";
      try {
        node = fs.readFileSync(path.join(dir, ".nvmrc"), "utf8").trim().replace(/^v/, "");
      } catch {}
      return {
        name,
        path: dir,
        type,
        domain,
        url: `${ssl ? "https" : "http"}://${domain}${portSuffix(ssl, port(ssl ? "apache_https" : "apache_http"))}`,
        php: s.php && php.includes(s.php) ? s.php : def,
        node,
        ssl,
        docroot: s.docroot ?? d.docroot,
        imported,
        node_port: s.node_port ?? 3000,
        node_cmd: s.node_cmd ?? "npm run dev",
        node_running: false,
        custom_vhost: { apache: false, nginx: false },
        sqlite: null,
        db: s.db ?? "",
        db_name: fileDbName(dir, type, s.docroot ?? d.docroot) || s.db_name || defaultDbName(name),
        python: s.python ?? "",
      };
    })
    .sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" }));
}

/** Everything that ends up in the generated web server config; used to detect a stale running server. */
export const signature = () =>
  JSON.stringify([projects().map((x) => [x.domain, x.path, x.docroot, x.php, x.ssl, x.type, x.node_port])]);
