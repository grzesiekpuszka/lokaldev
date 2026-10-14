import fs from "node:fs";
import type { DbConf } from "../src/api";
import path from "node:path";
import { seriesDataDir } from "./versions";

/** Directives offered in the settings tab; anything else is edited in the raw postgresql.conf tab. */
export const PG_SETTINGS = [
  "max_connections", "shared_buffers", "work_mem", "maintenance_work_mem", "effective_cache_size", "timezone",
  "log_min_duration_statement", "log_statement",
];

// port and listen_addresses come from the command line (-p, -h), which overrides the file
const MANAGED = ["port", "listen_addresses"];

export const pgConfFile = (series: string) => path.join(seriesDataDir("postgres", series), "postgresql.conf");

const active = (key: string) => new RegExp(`^\\s*${key}\\s*=\\s*(.*)$`, "i");
const commented = (key: string) => new RegExp(`^\\s*#\\s*${key}\\s*=`, "i");
const unquote = (v: string) => v.replace(/\s+#.*$/, "").trim().replace(/^'(.*)'$/, "$1");
// numbers, sizes/durations and booleans go in bare; everything else needs single quotes
const format = (v: string) => (/^(-?\d+(\.\d+)?\s*(B|kB|MB|GB|TB|us|ms|s|min|h|d)?|on|off|true|false)$/i.test(v) || /^'.*'$/.test(v) ? v : `'${v.replace(/'/g, "''")}'`);

const read = (series: string) => fs.readFileSync(pgConfFile(series), "utf8").split(/\r?\n/);

export function pgConfGet(series: string): DbConf {
  const lines = read(series);
  const settings: Record<string, string> = {};
  for (const key of PG_SETTINGS) {
    for (const l of lines) {
      const m = l.match(active(key));
      if (m) settings[key] = unquote(m[1]);
    }
  }
  return { settings, raw: lines.join("\n"), managed: MANAGED };
}

export function pgConfSet(series: string, change: { raw?: string; settings?: Record<string, string> }) {
  let lines = change.raw !== undefined ? change.raw.split(/\r?\n/) : read(series);
  if (change.raw === undefined) {
    for (const [key, value] of Object.entries(change.settings ?? {})) {
      // the last line of a key wins: earlier duplicates (e.g. added in the raw tab) are commented out
      const all = lines.flatMap((l, i) => (active(key).test(l) ? [i] : []));
      const at = all.at(-1) ?? -1;
      for (const i of value === "" ? all : all.slice(0, -1)) lines[i] = `#${lines[i].trimStart()}`; // commented out = the built-in default
      if (value === "") continue;
      const line = `${key} = ${format(value)}`;
      if (at >= 0) lines[at] = line;
      else {
        // put it where the stock file documents it, otherwise at the end
        const doc = lines.findIndex((l) => commented(key).test(l));
        if (doc >= 0) lines.splice(doc + 1, 0, line);
        else lines = [...lines, line];
      }
    }
  }
  fs.writeFileSync(pgConfFile(series), lines.join("\n"));
}
