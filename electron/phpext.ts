import fs from "node:fs";
import path from "node:path";
import { download, extract } from "./install";
import { installedPhp } from "./config";
import { phpIniSet } from "./phpini";
import { installedSeries } from "./versions";
import { exists, p, versionKey } from "./util";

// PHP extensions that go with a service; installed and enabled for every PHP version when either side is installed
const EXTENSIONS: Record<string, string> = { redis: "redis", memcached: "memcached", mongodb: "mongodb" };
const PECL = "https://downloads.php.net/~windows/pecl/releases";

const listing = async (url: string) => {
  const r = await fetch(url);
  return r.ok ? r.text() : "";
};

/** Newest PECL build of an extension for a PHP minor version (nts, x64). */
async function peclZip(name: string, php: string) {
  const versions = [...(await listing(`${PECL}/${name}/`)).matchAll(/href="(?:[^"]*\/)?([\d.]+)\/"/g)]
    .map((m) => m[1])
    .sort((a, b) => versionKey(b).localeCompare(versionKey(a)));
  for (const v of versions.slice(0, 6)) {
    const file = (await listing(`${PECL}/${name}/${v}/`)).match(new RegExp(`php_${name}-${v.replace(/\./g, "\\.")}-${php.replace(".", "\\.")}-nts-v[cs]\\d+-x64\\.zip`))?.[0];
    if (file) return `${PECL}/${name}/${v}/${file}`;
  }
}

/** Puts php_<name>.dll into ext\ (its helper DLLs next to php.exe) and enables it; false when no build exists for that PHP. */
async function installExtension(name: string, php: string) {
  const dir = p("bin", "php", php);
  if (!exists(path.join(dir, "ext", `php_${name}.dll`))) {
    const url = await peclZip(name, php);
    if (!url) return false;
    const zip = p("tmp", `php_${name}-${php}.zip`);
    const tmp = p("tmp", `php_${name}-${php}`);
    await download(url, zip, `ext-${name}-${php}`);
    try {
      await extract(zip, tmp, `php_${name}.dll`);
      for (const f of fs.readdirSync(tmp).filter((f) => f.toLowerCase().endsWith(".dll"))) {
        fs.copyFileSync(path.join(tmp, f), f.toLowerCase() === `php_${name}.dll` ? path.join(dir, "ext", f) : path.join(dir, f));
      }
    } finally {
      fs.rmSync(zip, { force: true });
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  }
  await phpIniSet(php, { extensions: { [name]: true } });
  return true;
}

/** After installing a service: its extension for every PHP; after installing PHP: the extensions of every installed service. */
export async function syncExtensions(what: string, version: string) {
  const pairs =
    what === "php"
      ? Object.keys(EXTENSIONS).filter((id) => installedSeries(id as never).length).map((id) => [EXTENSIONS[id], version])
      : EXTENSIONS[what]
        ? installedPhp().map((php) => [EXTENSIONS[what], php])
        : [];
  // a missing build (e.g. mongodb for PHP 7.4) or a network error must not fail the install itself
  for (const [name, php] of pairs) await installExtension(name, php).catch(() => false);
}
