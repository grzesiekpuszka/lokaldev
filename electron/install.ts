import { port, timezone } from "./config";
import fs from "node:fs";
import path from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { ComponentId, ComponentRelease, PhpRelease } from "../src/api";
import { syncExtensions } from "./phpext";
import { seriesOf } from "./versions";
import { versionKey, emit, exists, p, run } from "./util";
import { t } from "../src/i18n";

const headers = { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) lokaldev" };

async function get(url: string) {
  const r = await fetch(url, { headers });
  if (!r.ok) throw new Error(`${url}: HTTP ${r.status}`);
  return r;
}
const text = async (url: string) => (await get(url)).text();
const json = async (url: string) => (await get(url)).json();
const find = (page: string, f: (s: string) => boolean) => page.split(/["'<>() ]/).find(f);

export const MARKERS: Record<string, string> = {
  php: "php-cgi.exe",
  apache: "bin/httpd.exe",
  nginx: "nginx.exe",
  mysql: "bin/mysqld.exe",
  mariadb: "bin/mariadbd.exe",
  postgres: "bin/postgres.exe",
  mongodb: "bin/mongod.exe",
  redis: "redis-server.exe",
  memcached: "bin/memcached.exe",
  git: "cmd/git.exe",
  python: "python.exe",
  sqlite: "sqlite3.exe",
  mailpit: "mailpit.exe",
  phpmyadmin: "config.sample.inc.php",
};

// downloaded as a single PHP archive, run by the shims through PHP
const PHARS: Record<string, string> = { composer: "composer.phar", wpcli: "wp-cli.phar" };

export const componentDir =(what: string, series: string) => p("bin", what, series);

export async function phpReleases(): Promise<(PhpRelease & { zip: string })[]> {
  const data = await json("https://downloads.php.net/~windows/releases/releases.json");
  return Object.entries<any>(data)
    .map(([minor, v]) => {
      const build = Object.keys(v).find((k) => k.startsWith("nts-") && k.endsWith("-x64"));
      return build && { minor, version: v.version as string, zip: v[build].zip.path as string };
    })
    .filter((r): r is PhpRelease & { zip: string } => !!r)
    .sort((a, b) => versionKey(a.minor).localeCompare(versionKey(b.minor)));
}

type Release = ComponentRelease & { urls: string[] };

/** Newest version of each series, newest series first. */
function latestPerSeries(id: ComponentId, list: { version: string; url: string }[], limit = 4) {
  const latest = new Map<string, { version: string; url: string }>();
  for (const x of list) {
    const s = seriesOf(id, x.version);
    if (!latest.has(s) || versionKey(x.version) > versionKey(latest.get(s)!.version)) latest.set(s, x);
  }
  return [...latest].sort((a, b) => versionKey(b[0]).localeCompare(versionKey(a[0]))).slice(0, limit);
}

const mysqlRelease = async (series: string): Promise<Release | undefined> => {
  const page = await text(`https://dev.mysql.com/downloads/mysql/${series}.html`).catch(() => "");
  const prefix = `mysql-${series}.`;
  const file = find(page, (s) => s.startsWith(prefix) && /^\d+-winx64\.zip$/.test(s.slice(prefix.length)));
  if (!file) return;
  const version = file.match(/mysql-([\d.]+)-/)![1];
  const urls = [`https://cdn.mysql.com/Downloads/MySQL-${series}/${file}`, `https://cdn.mysql.com/archives/mysql-${series}/${file}`];
  return { series, version, note: series === "8.4" ? "LTS" : series === "8.0" ? "" : "Innovation", urls };
};

/** Installable release lines of a component (latest version of each), newest first. */
async function releases(id: ComponentId): Promise<Release[]> {
  switch (id) {
    case "apache": {
      const href = find(
        await text("https://www.apachelounge.com/download/"),
        (s) => s.includes("/binaries/httpd-") && /win64/i.test(s) && s.endsWith(".zip"),
      );
      if (!href) throw new Error(t("Couldn't find Apache on apachelounge.com"));
      const version = href.match(/httpd-([\d.]+)/)?.[1] ?? "";
      return [{ series: seriesOf(id, version), version, note: "", urls: [href.startsWith("http") ? href : `https://www.apachelounge.com${href}`] }];
    }
    case "nginx": {
      const files = [...new Set((await text("https://nginx.org/en/download.html")).match(/nginx-\d+\.\d+\.\d+\.zip/g) ?? [])];
      const latest = new Map<string, string>();
      for (const f of files) {
        const v = f.match(/nginx-([\d.]+)\.zip/)![1];
        const s = seriesOf(id, v);
        if (!latest.has(s) || versionKey(v) > versionKey(latest.get(s)!)) latest.set(s, v);
      }
      return [...latest]
        .sort((a, b) => versionKey(b[0]).localeCompare(versionKey(a[0])))
        .slice(0, 5)
        .map(([series, version]) => ({ series, version, note: Number(series.split(".")[1]) % 2 ? "mainline" : "stable", urls: [`https://nginx.org/download/nginx-${version}.zip`] }));
    }
    case "mysql": {
      const main = await text("https://dev.mysql.com/downloads/mysql/").catch(() => "");
      // the newest Innovation release (9.x, then year-based numbers like 26.7) is the one on the main download page
      const innovation = find(main, (s) => /^mysql-\d+\.\d+\.\d+-winx64\.zip$/.test(s) && !s.startsWith("mysql-8."))?.match(/mysql-(\d+\.\d+)/)?.[1];
      const list = await Promise.all([...new Set([innovation, "8.4", "8.0"].filter(Boolean) as string[])].map(mysqlRelease));
      return list.filter((r): r is Release => !!r);
    }
    case "mariadb": {
      const majors = (await json("https://downloads.mariadb.org/rest-api/mariadb/")).major_releases.filter((r: any) => r.release_status === "Stable");
      // exact versions and file URLs are looked up when a series is installed
      return majors.map((r: any) => ({ series: r.release_id, version: r.release_id, note: r.release_support_type === "Long Term Support" ? "LTS" : "", urls: [] }));
    }
    case "postgres": {
      const versions = (await json("https://www.postgresql.org/versions.json")).filter((v: any) => v.supported);
      return versions
        .sort((a: any, b: any) => Number(b.major) - Number(a.major))
        .map((v: any) => {
          const version = `${v.major}.${v.latestMinor}`;
          return { series: String(v.major), version, note: "", urls: [`https://get.enterprisedb.com/postgresql/postgresql-${version}-1-windows-x64-binaries.zip`] };
        });
    }
    case "mongodb": {
      const data = await json("https://downloads.mongodb.org/full.json");
      const list = data.versions
        .filter((v: any) => v.production_release)
        .map((v: any) => ({ version: v.version, url: v.downloads.find((d: any) => d.target === "windows" && d.arch === "x86_64")?.archive?.url }))
        .filter((x: any) => x.url);
      // x.0 are the yearly major releases, the others short-lived rapid releases
      return latestPerSeries(id, list).map(([series, x]) => ({ series, version: x.version, note: series.endsWith(".0") ? "" : "Rapid", urls: [x.url] }));
    }
    case "redis": {
      // Redis has no official Windows build; redis-windows/redis-windows compiles the upstream releases with MSYS2
      const rels = await json("https://api.github.com/repos/redis-windows/redis-windows/releases?per_page=30");
      const list = rels
        .filter((r: any) => !r.prerelease)
        .map((r: any) => ({ version: r.tag_name.replace(/^v/, ""), url: r.assets.find((a: any) => /-Windows-x64-msys2\.zip$/.test(a.name))?.browser_download_url }))
        .filter((x: any) => x.url);
      return latestPerSeries(id, list).map(([series, x]) => ({ series, version: x.version, note: "", urls: [x.url] }));
    }
    case "memcached": {
      const rel = await json("https://api.github.com/repos/jefyt/memcached-windows/releases/latest");
      const asset = rel.assets.find((a: any) => /^memcached-[\d.]+-win64-mingw\.zip$/.test(a.name));
      const version = asset.name.match(/memcached-([\d.]+)-/)[1];
      return [{ series: seriesOf(id, version), version, note: "", urls: [asset.browser_download_url] }];
    }
    case "git": {
      // MinGit: the official portable Git for Windows without bash or an installer
      const rel = await json("https://api.github.com/repos/git-for-windows/git/releases/latest");
      const asset = rel.assets.find((a: any) => /^MinGit-[\d.]+-64-bit\.zip$/.test(a.name));
      const version = asset.name.match(/MinGit-([\d.]+)-64-bit/)[1];
      return [{ series: seriesOf(id, version), version, note: "MinGit", urls: [asset.browser_download_url] }];
    }
    case "python": {
      // the official NuGet package is a full portable Python (pip, venv), unlike the embeddable zip
      const versions: string[] = (await json("https://api.nuget.org/v3-flatcontainer/python/index.json")).versions.filter((v: string) => /^\d+\.\d+\.\d+$/.test(v));
      return latestPerSeries(id, versions.map((v) => ({ version: v, url: `https://api.nuget.org/v3-flatcontainer/python/${v}/python.${v}.nupkg` }))).map(([series, x]) => ({
        series, version: x.version, note: "", urls: [x.url],
      }));
    }
    case "sqlite": {
      const file = find(await text("https://www.sqlite.org/download.html"), (s) => /^\d{4}\/sqlite-tools-win-x64-\d+\.zip$/.test(s));
      if (!file) throw new Error(t("Couldn't find {name} on {site}", { name: "SQLite", site: "sqlite.org" }));
      // 3540000 = 3.54.0
      const [, major, minor, patch] = file.match(/-(\d)(\d\d)(\d\d)\d\d\.zip$/)!;
      const version = `${major}.${Number(minor)}.${Number(patch)}`;
      return [{ series: seriesOf(id, version), version, note: "CLI", urls: [`https://www.sqlite.org/${file}`] }];
    }
    case "mailpit": {
      const rel = await json("https://api.github.com/repos/axllent/mailpit/releases/latest");
      const asset = rel.assets.find((a: any) => a.name === "mailpit-windows-amd64.zip");
      const version = rel.tag_name.replace(/^v/, "");
      return [{ series: seriesOf(id, version), version, note: "", urls: [asset.browser_download_url] }];
    }
    case "phpmyadmin": {
      const version = (await text("https://www.phpmyadmin.net/home_page/version.txt")).split("\n")[0].trim();
      return [{ series: seriesOf(id, version), version, note: "", urls: [`https://files.phpmyadmin.net/phpMyAdmin/${version}/phpMyAdmin-${version}-all-languages.zip`] }];
    }
    case "composer": {
      const data = await json("https://getcomposer.org/versions");
      return [data.stable[0].version, data["2.2"][0].version].map((version: string) => ({
        series: seriesOf(id, version),
        version,
        note: version.startsWith("2.2.") ? "LTS, PHP 5.3+" : "",
        urls: [`https://getcomposer.org/download/${version}/composer.phar`],
      }));
    }
    case "wpcli": {
      const rel = await json("https://api.github.com/repos/wp-cli/wp-cli/releases/latest");
      const asset = rel.assets.find((a: any) => /^wp-cli-[\d.]+\.phar$/.test(a.name));
      const version = rel.tag_name.replace(/^v/, "");
      return [{ series: seriesOf(id, version), version, note: "", urls: [asset.browser_download_url] }];
    }
  }
  throw new Error(t("Unknown component: {name}", { name: id }));
}

export const componentReleases = async (id: ComponentId): Promise<ComponentRelease[]> =>
  (await releases(id)).map(({ series, version, note }) => ({ series, version, note }));

async function sources(what: string, series: string): Promise<{ url: string; version: string }[]> {
  if (what === "php") {
    const r = (await phpReleases()).find((r) => r.minor === series);
    if (!r) throw new Error(t("Unknown PHP version {version}", { version: series }));
    const base = "https://downloads.php.net/~windows/releases";
    return [`${base}/${r.zip}`, `${base}/archives/${r.zip}`].map((url) => ({ url, version: r.version }));
  }
  if (what === "mariadb") {
    const latest: any = Object.values((await json(`https://downloads.mariadb.org/rest-api/mariadb/${series}/latest/`)).releases)[0];
    const file = latest.files.find((f: any) => /winx64\.zip$/.test(f.file_name));
    return [{ url: file.file_download_url.replace(/^http:/, "https:"), version: latest.release_id }];
  }
  const r = (await releases(what as ComponentId)).find((x) => x.series === series);
  if (!r) throw new Error(t("Unknown version {version}", { version: series }));
  return r.urls.map((url) => ({ url, version: r.version }));
}

export async function download(url: string, file: string, id: string) {
  const r = await get(url);
  const total = Number(r.headers.get("content-length") ?? 0);
  let done = 0;
  let last = 0;
  const progress = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      done += chunk.length;
      if (done - last > 1 << 20) {
        last = done;
        emit("progress", { id, done, total });
      }
      callback(null, chunk);
    },
  });
  try {
    // pipeline propagates network and disk errors (full disk, access denied) instead of hanging
    await pipeline(Readable.fromWeb(r.body as never), progress, fs.createWriteStream(file));
  } catch (e) {
    fs.rmSync(file, { force: true });
    throw e;
  }
}

/** Extracts with Windows' bsdtar and moves the folder that contains `marker` to `dest`. */
export async function extract(zip: string, dest: string, marker: string) {
  const tmp = `${dest}.tmp`;
  fs.rmSync(tmp, { recursive: true, force: true });
  fs.mkdirSync(tmp, { recursive: true });
  const tar = path.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "tar.exe");
  const { code, out } = await run(tar, ["-xf", zip, "-C", tmp]);
  if (code) throw new Error(t("Extraction failed: {out}", { out }));
  const findRoot = (dir: string, depth: number): string | undefined => {
    if (exists(path.join(dir, marker))) return dir;
    if (!depth) return;
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const found = e.isDirectory() && findRoot(path.join(dir, e.name), depth - 1);
      if (found) return found;
    }
  };
  const root = findRoot(tmp, 2);
  if (!root) throw new Error(t("Invalid archive"));
  fs.rmSync(dest, { recursive: true, force: true });
  fs.renameSync(root, dest);
  fs.rmSync(tmp, { recursive: true, force: true });
}

async function phpIni(dir: string) {
  const ext = [
    "curl", "exif", "fileinfo", "gd", "gd2", "intl", "mbstring", "mysqli", "openssl", "pdo_mysql", "pdo_pgsql",
    "pdo_sqlite", "pgsql", "sodium", "sqlite3", "zip",
  ];
  const cacert = p("ssl", "cacert.pem");
  if (!exists(cacert)) await download("https://curl.se/ca/cacert.pem", cacert, "cacert").catch(() => {});
  const ini = fs
    .readFileSync(path.join(dir, "php.ini-development"), "utf8")
    .split(/\r?\n/)
    .map((l) => {
      const m = l.match(/^;(zend_)?extension=(\w+)\s*$/);
      return m && (ext.includes(m[2]) || m[2] === "opcache") ? l.slice(1) : l;
    })
    .join("\n");
  fs.writeFileSync(
    path.join(dir, "php.ini"),
    `${ini}
[lokaldev]
extension_dir = "ext"
memory_limit = 512M
upload_max_filesize = 256M
post_max_size = 256M
max_execution_time = 300
SMTP = 127.0.0.1
smtp_port = ${port("mailpit_smtp")}
sendmail_from = lokal@localhost
date.timezone = ${timezone()}
curl.cainfo = "${cacert}"
openssl.cafile = "${cacert}"
`,
  );
}

export async function install(what: string, version = "", dest = componentDir(what, version)) {
  const id = `${what}-${version}`; // progress id, e.g. "php-8.4", "mariadb-11.4"
  const file = p("tmp", `${id}.download`);
  let ver = "";
  let lastError: unknown;
  for (const s of await sources(what, version)) {
    try {
      await download(s.url, file, id);
      ver = s.version;
      lastError = undefined;
      break;
    } catch (e) {
      lastError = e;
    }
  }
  if (lastError) throw lastError;
  try {
    if (PHARS[what]) {
      fs.mkdirSync(dest, { recursive: true });
      fs.renameSync(file, path.join(dest, PHARS[what]));
    } else {
      emit("progress", { id, stage: "extract" });
      await extract(file, dest, MARKERS[what]);
    }
  } finally {
    fs.rmSync(file, { force: true });
  }
  if (what === "mongodb") await installMongosh(dest, id);
  fs.writeFileSync(path.join(dest, ".version"), ver);
  if (what === "php") await phpIni(dest);
  if (dest === componentDir(what, version)) await syncExtensions(what, version);
}

/** MongoDB 6+ ships without a shell; mongosh goes into the series folder. */
async function installMongosh(dest: string, id: string) {
  const rel = await json("https://api.github.com/repos/mongodb-js/mongosh/releases/latest");
  const asset = rel.assets.find((a: any) => /-win32-x64\.zip$/.test(a.name));
  const file = p("tmp", "mongosh.download");
  await download(asset.browser_download_url, file, id);
  try {
    await extract(file, path.join(dest, "mongosh"), "bin/mongosh.exe");
  } finally {
    fs.rmSync(file, { force: true });
  }
}

export function uninstall(what: string, version = "") {
  fs.rmSync(componentDir(what, version), { recursive: true, force: true });
}

/** Newest release of each installed series that is newer than what is installed: "php/8.4" → "8.4.27". */
export async function binaryUpdates(installed: { what: string; series: string; version: string }[]) {
  const updates: Record<string, string> = {};
  const lists = new Map<string, Promise<{ series: string; version: string }[]>>();
  for (const x of installed) {
    try {
      let latest: string | undefined;
      // MariaDB's list only names the series; PHP has its own list
      if (x.what === "mariadb" || x.what === "php") latest = (await sources(x.what, x.series))[0]?.version;
      else {
        if (!lists.has(x.what)) lists.set(x.what, releases(x.what as ComponentId));
        latest = (await lists.get(x.what)!).find((r) => r.series === x.series)?.version;
      }
      if (latest && versionKey(latest) > versionKey(x.version)) updates[`${x.what}/${x.series}`] = latest;
    } catch {} // one unreachable source must not hide the others
  }
  return updates;
}

/**
 * Replaces an installed series with the newest release of that series; php.ini and DLLs added later (PECL) are kept.
 * The new files are prepared in <series>.new while the old ones stay in use; `stop` runs just before the swap.
 */
export async function update(what: string, series: string, stop: () => Promise<void>) {
  const dest = componentDir(what, series);
  const fresh = `${dest}.new`;
  const old = `${dest}.old`;
  fs.rmSync(fresh, { recursive: true, force: true });
  try {
    await install(what, series, fresh);
  } catch (e) {
    fs.rmSync(fresh, { recursive: true, force: true });
    throw e;
  }
  await stop();
  if (what === "php") {
    fs.copyFileSync(path.join(dest, "php.ini"), path.join(fresh, "php.ini"));
    for (const sub of ["ext", ""]) {
      for (const f of fs.readdirSync(path.join(dest, sub)).filter((f) => f.toLowerCase().endsWith(".dll"))) {
        if (!exists(path.join(fresh, sub, f))) fs.copyFileSync(path.join(dest, sub, f), path.join(fresh, sub, f));
      }
    }
  }
  fs.rmSync(old, { recursive: true, force: true });
  // a just-stopped service may hold its files for a moment
  for (let i = 0; ; i++) {
    try {
      fs.renameSync(dest, old);
      break;
    } catch {
      if (i === 10) {
        fs.rmSync(fresh, { recursive: true, force: true });
        throw new Error(t("Files of {name} are in use — close programs that use it and try again.", { name: `${what} ${series}` }));
      }
      await new Promise((r) => setTimeout(r, 500));
    }
  }
  try {
    fs.renameSync(fresh, dest);
  } catch (e) {
    fs.rmSync(dest, { recursive: true, force: true });
    fs.renameSync(old, dest);
    fs.rmSync(fresh, { recursive: true, force: true });
    throw e;
  }
  fs.rmSync(old, { recursive: true, force: true });
  await syncExtensions(what, series);
}

/**
 * Finishes or undoes a binary update interrupted by a crash: <series>.old is the previous install, put back when
 * <series> isn't complete (no .version yet). Leftover .new/.tmp folders are removed.
 */
export function recoverUpdates() {
  const bin = p("bin");
  if (!exists(bin)) return;
  for (const what of fs.readdirSync(bin)) {
    const root = path.join(bin, what);
    if (!fs.statSync(root).isDirectory()) continue;
    for (const name of fs.readdirSync(root)) {
      const dir = path.join(root, name);
      if (name.endsWith(".new") || name.endsWith(".tmp")) fs.rmSync(dir, { recursive: true, force: true });
      if (!name.endsWith(".old")) continue;
      const dest = dir.slice(0, -4);
      if (!exists(path.join(dest, ".version"))) {
        fs.rmSync(dest, { recursive: true, force: true });
        fs.renameSync(dir, dest);
      } else fs.rmSync(dir, { recursive: true, force: true });
    }
  }
}
