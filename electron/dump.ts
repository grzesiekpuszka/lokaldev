import { spawn } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import zlib from "node:zlib";
import type { DumpDatabase, DumpInfo, ImportResult } from "../src/api";
import { plural, t } from "../src/i18n";
import { databases, requireInstance, sql } from "./db";
import { defaultInstanceId, instance, instanceBin, parseInstance, type Instance } from "./instances";
import { mysqlLogin, pgEnv } from "./dbauth";
import { instanceRunning, startInstance } from "./services";
import { emit, p, run } from "./util";

type Family = "mysql" | "postgres"; // "mysql" = MySQL or MariaDB

const SYSTEM = ["information_schema", "mysql", "performance_schema", "sys", "postgres", "template0", "template1"];
const TAR = path.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "tar.exe");

const quote = (family: Family, name: string) => (family === "postgres" ? `"${name}"` : `\`${name}\``);

async function ensureRunning(inst: Instance) {
  if (!instanceRunning(inst.id)) await startInstance(inst.id);
}

/** Where an archive folder goes: the same engine and series if installed, otherwise its family's default ("mysql/" and "postgres/" are the pre-0.5 layout). */
function archiveTarget(folder: string) {
  const family: Family = folder.startsWith("postgres") ? "postgres" : "mysql";
  return (parseInstance(folder) && instance(folder)?.id) || defaultInstanceId(family);
}

/** Waits for a child process and turns a non-zero exit into an error carrying the tail of its stderr. */
async function finish(child: ReturnType<typeof spawn>, stderr: () => string) {
  const [code] = await once(child, "close");
  if (code) throw new Error(stderr().trim().split(/\r?\n/).slice(-6).join("\n") || `exit code ${code}`);
}

function capture(child: ReturnType<typeof spawn>) {
  let err = "";
  child.stderr?.on("data", (d) => (err = (err + d).slice(-8000)));
  return () => err;
}

// ---------- export ----------

/** Streams a plain-SQL dump of one database into a gzip file. */
export async function exportDatabase(instanceId: string, name: string, file: string, id = `export-${name}`, label = name) {
  const inst = requireInstance(instanceId);
  await ensureRunning(inst);
  const child =
    inst.family === "postgres"
      ? spawn(instanceBin(inst, "pg_dump"), ["-w", "--no-owner", "--no-privileges", "-d", name], { windowsHide: true, env: pgEnv(inst) })
      : spawn(instanceBin(inst, "mysqldump"), [
          ...mysqlLogin(inst), "--single-transaction", "--routines", "--triggers", "--events", "--hex-blob",
          "--default-character-set=utf8mb4", name,
        ], { windowsHide: true });
  const stderr = capture(child);
  const out = fs.createWriteStream(file);
  let done = 0;
  let last = 0;
  child.stdout!.on("data", (d: Buffer) => {
    done += d.length;
    if (done - last > 1 << 20) {
      last = done;
      emit("progress", { id, done, label });
    }
  });
  try {
    await Promise.all([new Promise((res, rej) => child.stdout!.pipe(zlib.createGzip()).pipe(out).on("finish", res).on("error", rej)), finish(child, stderr)]);
  } catch (e) {
    fs.rmSync(file, { force: true });
    throw e;
  }
}

/** One zip with <instance>/<database>.sql.gz for every user database of the running instances. */
export async function exportAll(file: string) {
  const list = (await databases()).filter((d) => !d.system);
  if (!list.length) throw new Error(t("No databases to export — start MySQL/MariaDB or PostgreSQL first."));
  const dir = p("tmp", "export-all");
  fs.rmSync(dir, { recursive: true, force: true });
  try {
    for (const [i, d] of list.entries()) {
      fs.mkdirSync(path.join(dir, d.instance), { recursive: true });
      const label = `${d.name} (${i + 1}/${list.length})`;
      emit("progress", { id: "export-all", label });
      await exportDatabase(d.instance, d.name, path.join(dir, d.instance, `${d.name}.sql.gz`), "export-all", label);
    }
    fs.rmSync(file, { force: true });
    const r = await run(TAR, ["-a", "-c", "-f", file, "-C", dir, ...fs.readdirSync(dir)]);
    if (r.code) throw new Error(r.out);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

// ---------- inspect ----------

const isGzip = (file: string) => {
  const fd = fs.openSync(file, "r");
  const head = Buffer.alloc(2);
  fs.readSync(fd, head, 0, 2, 0);
  fs.closeSync(fd);
  return head[0] === 0x1f && head[1] === 0x8b;
};

const lines = (file: string, onBytes?: (n: number) => void) => {
  const input = fs.createReadStream(file);
  if (onBytes) input.on("data", (d) => onBytes((d as Buffer).length));
  return readline.createInterface({ input: isGzip(file) ? input.pipe(zlib.createGunzip()) : input, crlfDelay: Infinity });
};

// Statements that open a database section in mysqldump --databases / --all-databases output
const SECTION = [/^-- Current Database: `(.+)`/, /^CREATE DATABASE (?:\/\*!\d+ IF NOT EXISTS\*\/ |IF NOT EXISTS )?`(.+?)`/i, /^USE `(.+)`;/i];
const sectionOf = (line: string) => {
  for (const re of SECTION) {
    const m = line.match(re);
    if (m) return m[1];
  }
};

/** Looks into a .sql / .sql.gz / .zip to find out which databases it holds and what engine it was made for. */
export async function inspectDump(file: string): Promise<DumpInfo> {
  const entry = (family: Family, source: string, name: string, target: string | null): DumpDatabase => ({ family, source, name, system: SYSTEM.includes(name), instance: target });

  if (/\.zip$/i.test(file)) {
    const r = await run(TAR, ["-tf", file]);
    if (r.code) throw new Error(r.out);
    const databases = r.stdout
      .split(/\r?\n/)
      .map((l) => l.match(/^((?:mysql|mariadb|postgres)(?:-[\w.]+)?)\/(.+)\.sql(\.gz)?$/))
      .filter((m): m is RegExpMatchArray => !!m)
      .map((m) => ({ ...entry(m[1].startsWith("postgres") ? "postgres" : "mysql", m[1], m[2], archiveTarget(m[1])), entry: m[0] }));
    return { file, kind: "archive", family: "mysql", databases, suggested: "" };
  }

  let family: Family = "mysql";
  const names: string[] = [];
  let n = 0;
  for await (const line of lines(file)) {
    if (n++ < 30 && line.includes("PostgreSQL database dump")) family = "postgres";
    const name = family === "mysql" && line.length < 300 ? sectionOf(line) : undefined;
    if (name && !names.includes(name)) names.push(name);
  }
  const suggested = path.basename(file).replace(/(\.sql)?(\.gz)?$/i, "").replace(/[-_.]?\d{8}([-_.]?\d{4,6})?$/, "").replace(/[^A-Za-z0-9_$-]/g, "_");
  return names.length
    ? { file, kind: "multi", family, databases: names.map((x) => entry(family, family, x, null)), suggested: "" }
    : { file, kind: "single", family, databases: [], suggested };
}

// ---------- import ----------

const SAFE_NAME = /^[A-Za-z0-9_$-]+$/;

/** Splits a stream into raw lines (Buffers, "\n" included) without decoding: dumps can hold binary data. */
async function* rawLines(file: string, onBytes: (n: number) => void) {
  const input = fs.createReadStream(file, { highWaterMark: 1 << 20 });
  const stream = isGzip(file) ? input.pipe(zlib.createGunzip()) : input;
  input.on("data", (d) => onBytes((d as Buffer).length));
  let rest: Buffer | null = null;
  for await (const chunk of stream as AsyncIterable<Buffer>) {
    const buf: Buffer = rest ? Buffer.concat([rest, chunk]) : chunk;
    let start = 0;
    for (let i = buf.indexOf(10); i !== -1; i = buf.indexOf(10, start)) {
      yield buf.subarray(start, i + 1);
      start = i + 1;
    }
    rest = start < buf.length ? buf.subarray(start) : null;
  }
  if (rest) yield rest;
}

/**
 * Line filter for MySQL-compatible imports: keeps only the selected database sections and smooths over
 * MySQL <-> MariaDB differences (MariaDB's sandbox-mode marker, collations the other server lacks).
 * Only short lines and DDL are decoded; data lines pass through byte for byte.
 */
function compatFilter(target: Instance["engine"], selected: Set<string> | null) {
  let current: string | undefined;
  const swap = (line: Buffer, re: RegExp) => Buffer.from(line.toString("utf8").replace(re, "utf8mb4_unicode_ci"));
  // data rows: INSERT/REPLACE statements and the "(…)," continuation lines of extended inserts
  const isData = (line: Buffer) => line[0] === 0x28 || /^(INSERT|REPLACE) /.test(line.subarray(0, 8).toString());
  return (line: Buffer): Buffer | null => {
    if (selected && line.length < 300) {
      const name = sectionOf(line.toString("utf8"));
      if (name) current = name;
    }
    if (selected && current !== undefined && !selected.has(current)) return null;
    if (target === "mysql" && line.subarray(0, 10).toString() === "/*M!999999") return null;
    if (isData(line)) return line;
    if (target === "mysql" && line.includes("utf8mb4_uca1400_")) return swap(line, /utf8mb4_uca1400_[a-z_]+/g);
    if (target === "mariadb" && line.includes("utf8mb4_0900_")) return swap(line, /utf8mb4_0900_[a-z_]+/g);
    return line;
  };
}

/** Streams a dump into the engine's command-line client; a client error (e.g. SQL syntax) ends the import with its message. */
async function feed(inst: Instance, file: string, database: string | null, filter: ((l: Buffer) => Buffer | null) | null, progress: (n: number) => void) {
  // the client's own output (e.g. SELECTs in the dump) is dropped: an unread pipe would stall it
  const stdio: ["pipe", "ignore", "pipe"] = ["pipe", "ignore", "pipe"];
  const child =
    inst.family === "postgres"
      ? spawn(instanceBin(inst, "psql"), ["-w", "-v", "ON_ERROR_STOP=1", "-q", "-d", database ?? "postgres"], { windowsHide: true, env: pgEnv(inst), stdio })
      : spawn(
          instanceBin(inst, "mysql"),
          // --binary-mode: no translation of \0 or \r\n, so binary column data survives
          [...mysqlLogin(inst), "--default-character-set=utf8mb4", "--max-allowed-packet=1G", "--binary-mode", ...(database ? [database] : [])],
          { windowsHide: true, stdio },
        );
  const stderr = capture(child);
  const stdin = child.stdin!;
  stdin.on("error", () => {}); // EPIPE when the client stops on an error; its stderr is reported instead
  let exited = false;
  const closed = finish(child, stderr).finally(() => (exited = true));
  let batch: Buffer[] = [];
  let size = 0;
  const flush = async () => {
    if (!size || exited) return;
    const ok = stdin.write(Buffer.concat(batch));
    batch = [];
    size = 0;
    if (!ok) await Promise.race([once(stdin, "drain").catch(() => {}), closed.catch(() => {})]);
  };
  try {
    for await (const line of rawLines(file, progress)) {
      if (exited) break;
      const out = filter ? filter(line) : line;
      if (!out) continue;
      batch.push(out);
      size += out.length;
      if (size > 1 << 20) await flush();
    }
    await flush();
  } catch (e) {
    // e.g. a broken gzip: stop the client instead of leaving it waiting for more input
    child.kill();
    await closed.catch(() => {});
    throw e;
  }
  stdin.end();
  await closed;
}

/** spec.instance: target of a single/multi dump; archive folders go to the instance they came from (or their family's default). */
export async function importDump(spec: { file: string; databases: string[]; target: string; instance: string; mode: "replace" | "merge" }): Promise<ImportResult> {
  const info = await inspectDump(spec.file);
  const result: ImportResult = { imported: [], failed: [] };
  const total = fs.statSync(spec.file).size;

  const recreate = async (inst: Instance, name: string) => {
    if (!SAFE_NAME.test(name)) throw new Error(t("Invalid database name: {name}", { name }));
    const q = quote(inst.family, name);
    if (spec.mode === "replace") await sql(inst, `DROP DATABASE IF EXISTS ${q}`);
    // PostgreSQL has no CREATE DATABASE IF NOT EXISTS; an "already exists" error is fine when merging
    if (inst.family === "postgres") await sql(inst, `CREATE DATABASE ${q}`).catch(() => {});
    else await sql(inst, `CREATE DATABASE IF NOT EXISTS ${q} CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`);
  };
  const filterFor = (inst: Instance, selected: Set<string> | null) => (inst.family === "mysql" ? compatFilter(inst.engine, selected) : null);

  if (info.kind === "archive") {
    const dir = p("tmp", "import-all");
    fs.rmSync(dir, { recursive: true, force: true });
    fs.mkdirSync(dir, { recursive: true });
    try {
      const chosen = info.databases.filter((d) => spec.databases.includes(`${d.source}/${d.name}`) && !d.system);
      for (const [i, d] of chosen.entries()) {
        try {
          const inst = requireInstance(d.instance ?? d.source);
          await ensureRunning(inst);
          const entry = d.entry ?? `${d.source}/${d.name}.sql.gz`;
          const r = await run(TAR, ["-xf", spec.file, "-C", dir, entry]);
          if (r.code) throw new Error(r.out);
          await recreate(inst, d.name);
          emit("progress", { id: "import", label: `${d.name} (${i + 1}/${chosen.length})` });
          await feed(inst, path.join(dir, entry), d.name, filterFor(inst, null), () => {});
          result.imported.push(d.name);
        } catch (e) {
          result.failed.push({ name: d.name, error: e instanceof Error ? e.message : String(e) });
        }
      }
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
    return result;
  }

  const inst = requireInstance(spec.instance);
  if (inst.family !== info.family) throw new Error(t("This dump can't be imported into {name}", { name: inst.id }));
  await ensureRunning(inst);
  let done = 0;
  const progress = (label: string) => (n: number) => {
    done += n;
    emit("progress", { id: "import", done, total, label });
  };

  if (info.kind === "multi") {
    const chosen = info.databases.filter((d) => spec.databases.includes(`${d.source}/${d.name}`) && !d.system).map((d) => d.name);
    // the file creates the databases itself; replace mode drops them first
    for (const name of chosen) {
      if (!SAFE_NAME.test(name)) throw new Error(t("Invalid database name: {name}", { name }));
      if (spec.mode === "replace") await sql(inst, `DROP DATABASE IF EXISTS ${quote("mysql", name)}`);
    }
    await feed(inst, spec.file, null, filterFor(inst, new Set(chosen)), progress(plural(chosen.length, "{n} database", "{n} databases")));
    result.imported.push(...chosen);
    return result;
  }

  await recreate(inst, spec.target);
  await feed(inst, spec.file, spec.target, filterFor(inst, null), progress(spec.target));
  result.imported.push(spec.target);
  return result;
}
