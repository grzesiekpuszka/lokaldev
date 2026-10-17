import fs from "node:fs";
import path from "node:path";
import type { PhpIni } from "../src/api";
import { t } from "../src/i18n";
import { exists, p, run } from "./util";

/** Directives offered in the settings tab; anything else is edited in the raw php.ini tab. */
export const PHP_SETTINGS = [
  "memory_limit", "upload_max_filesize", "post_max_size", "max_execution_time", "max_input_time", "max_input_vars",
  "display_errors", "error_reporting", "date.timezone", "short_open_tag", "opcache.enable", "opcache.validate_timestamps",
];

const ZEND = ["opcache", "xdebug"];
const SKIP = ["dl_test", "zend_test"];
// PECL extensions listed even before their DLL is there; enabling one downloads it (phpext.ts)
export const DOWNLOADABLE = ["imagick"];
// Overrides live in our own section at the end of the file, so the stock php.ini stays untouched.
const SECTION = /^\[(lokaldev|lokal\.dev|Lokal|LaraGone)\]\s*$/;

const dir = (version: string) => p("bin", "php", version);
const iniFile = (version: string) => path.join(dir(version), "php.ini");
// real directives only: the doc examples in php.ini are written as ";   extension=mysqli"
const extLine = (name: string) => new RegExp(`^\\s*;?(zend_)?extension\\s*=\\s*"?(php_)?${name}(\\.dll)?"?\\s*(;.*)?$`, "i");
const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

function read(version: string) {
  if (!exists(iniFile(version))) throw new Error(t("PHP {version} is not installed", { version }));
  return fs.readFileSync(iniFile(version), "utf8").split(/\r?\n/);
}

export function phpIniGet(version: string): PhpIni {
  const lines = read(version);
  const extensions = fs
    .readdirSync(path.join(dir(version), "ext"))
    .map((f) => f.match(/^php_(\w+)\.dll$/i)?.[1])
    .filter((n): n is string => !!n && !SKIP.includes(n))
    .map((name) => ({ name, zend: ZEND.includes(name), enabled: lines.some((l) => extLine(name).test(l) && !l.trim().startsWith(";")), download: false }));
  for (const name of DOWNLOADABLE) if (!extensions.some((e) => e.name === name)) extensions.push({ name, zend: false, enabled: false, download: true });
  extensions.sort((a, b) => a.name.localeCompare(b.name));
  const settings: Record<string, string> = {};
  for (const key of PHP_SETTINGS) {
    const re = new RegExp(`^\\s*${escape(key)}\\s*=\\s*(.*?)\\s*$`, "i");
    for (const l of lines) {
      const m = l.match(re);
      if (m) settings[key] = m[1].replace(/^"(.*)"$/, "$1"); // last occurrence wins, as in PHP
    }
  }
  return { extensions, settings, raw: lines.join("\n") };
}

function apply(lines: string[], extensions: Record<string, boolean>, settings: Record<string, string>) {
  for (const [name, on] of Object.entries(extensions)) {
    const matches = lines.flatMap((l, i) => (extLine(name).test(l) ? [i] : []));
    for (const i of matches) lines[i] = `${on ? "" : ";"}${lines[i].replace(/^\s*;\s*/, "")}`;
    if (!matches.length && on) lines.push(`${ZEND.includes(name) ? "zend_extension" : "extension"}=${name}`);
  }
  while (lines.length && !lines[lines.length - 1].trim()) lines.pop();
  let start = lines.findIndex((l) => SECTION.test(l));
  if (start < 0) {
    lines.push("", "[lokaldev]");
    start = lines.length - 1;
  }
  for (const [key, value] of Object.entries(settings)) {
    const re = new RegExp(`^\\s*;?\\s*${escape(key)}\\s*=`, "i");
    const line = `${key} = ${/[\s;"]/.test(value) && !/^".*"$/.test(value) ? `"${value}"` : value}`;
    const at = lines.findIndex((l, i) => i > start && re.test(l));
    if (value === "") {
      if (at > 0) lines.splice(at, 1);
    } else if (at > 0) lines[at] = line;
    else lines.push(line);
  }
  return lines;
}

/** Saves php.ini (raw text, or extension/settings changes) and returns PHP's startup warnings, if any. */
export async function phpIniSet(version: string, change: { raw?: string; extensions?: Record<string, boolean>; settings?: Record<string, string> }) {
  const lines = change.raw !== undefined ? change.raw.split(/\r?\n/) : apply(read(version), change.extensions ?? {}, change.settings ?? {});
  fs.writeFileSync(iniFile(version), lines.join("\r\n"));
  const r = await run(path.join(dir(version), "php.exe"), ["-m"], { cwd: dir(version) });
  // the CLI prints startup warnings to both stdout and stderr
  const warnings = r.out
    .split(/\r?\n/)
    .map((l) => l.trim().replace(/^PHP\s+/, "").replace(/\s+/g, " "))
    .filter((l) => /^(Warning|Fatal error|Parse error)/i.test(l));
  return [...new Set(warnings)].join("\n");
}
