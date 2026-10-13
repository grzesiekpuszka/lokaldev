import fs from "node:fs";
import type { DbConf, DbEngine } from "../src/api";
import { exists, fwd, p } from "./util";
import { seriesDataDir, seriesDir } from "./versions";

/** Directives offered in the settings tab; anything else is edited in the raw my.ini tab. */
export const MY_SETTINGS = [
  "innodb_buffer_pool_size", "max_connections", "max_allowed_packet", "wait_timeout", "character-set-server",
  "collation-server", "sql_mode", "default-time-zone", "slow_query_log", "long_query_time",
];

/** One my.ini per installed series: options and paths differ between versions. */
export const myIniFile = (engine: DbEngine, series: string) => p("etc", `${engine}-${series}.ini`);

/** Keys lokaldev depends on; they are rewritten on every start, everything else is left to the user. */
const managed = (engine: DbEngine, series: string, port: number): Record<string, string> => ({
  basedir: `"${fwd(seriesDir(engine, series))}"`,
  datadir: `"${fwd(seriesDataDir(engine, series))}"`,
  port: String(port),
  "bind-address": "127.0.0.1",
  "log-error": `"${fwd(p("logs", `${engine}-${series}_error.log`))}"`,
});

// MySQL treats - and _ in option names as the same character
const keyRe = (key: string) => new RegExp(`^\\s*${key.replace(/[-_]/g, "[-_]").replace(/\./g, "\\.")}\\s*(=\\s*(.*?))?\\s*$`, "i");

function section(lines: string[]) {
  let start = lines.findIndex((l) => /^\s*\[mysqld\]\s*$/i.test(l));
  if (start < 0) {
    lines.push("[mysqld]");
    start = lines.length - 1;
  }
  const next = lines.findIndex((l, i) => i > start && /^\s*\[.+\]\s*$/.test(l));
  return { start, end: next < 0 ? lines.length : next };
}

function set(lines: string[], key: string, value: string) {
  const { start, end } = section(lines);
  const at = lines.findIndex((l, i) => i > start && i < end && keyRe(key).test(l));
  if (value === "") {
    if (at > 0) lines.splice(at, 1);
  } else if (at > 0) lines[at] = `${key}=${value}`;
  else {
    let pos = end;
    while (pos - 1 > start && !lines[pos - 1].trim()) pos--; // keep blank lines before the next section
    lines.splice(pos, 0, `${key}=${value}`);
  }
}

const read = (file: string) => (exists(file) ? fs.readFileSync(file, "utf8").split(/\r?\n/) : []);

/** Creates the config on first use (from the older one-per-engine file, if any) and re-applies the managed keys; returns its path. */
export function ensureMyIni(engine: DbEngine, series: string, port: number) {
  const file = myIniFile(engine, series);
  const legacy = p("etc", `${engine}.ini`);
  const fresh = !exists(file) && !exists(legacy);
  const lines = read(exists(file) ? file : legacy);
  for (const [k, v] of Object.entries(managed(engine, series, port))) set(lines, k, v);
  if (fresh) {
    set(lines, "character-set-server", "utf8mb4");
    set(lines, "collation-server", "utf8mb4_unicode_ci");
  }
  fs.writeFileSync(file, lines.join("\r\n").trimEnd() + "\r\n");
  return file;
}

export function myIniGet(engine: DbEngine, series: string, port: number): DbConf {
  const lines = read(ensureMyIni(engine, series, port));
  const { start, end } = section(lines);
  const settings: Record<string, string> = {};
  for (const key of MY_SETTINGS) {
    for (const l of lines.slice(start + 1, end)) {
      const m = l.match(keyRe(key));
      if (m) settings[key] = m[2] ?? "";
    }
  }
  return { settings, raw: lines.join("\n"), managed: Object.keys(managed(engine, series, port)) };
}

export function myIniSet(engine: DbEngine, series: string, port: number, change: { raw?: string; settings?: Record<string, string> }) {
  const file = ensureMyIni(engine, series, port);
  if (change.raw !== undefined) fs.writeFileSync(file, change.raw.split(/\r?\n/).join("\r\n"));
  else {
    const lines = read(file);
    for (const [k, v] of Object.entries(change.settings ?? {})) set(lines, k, v);
    fs.writeFileSync(file, lines.join("\r\n"));
  }
  ensureMyIni(engine, series, port);
}
