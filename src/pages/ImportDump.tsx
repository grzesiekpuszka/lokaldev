import { useEffect, useRef, useState } from "react";
import { CheckCircle2, FileUp, Loader2, XCircle } from "lucide-react";
import { api, type Database, type DumpInfo, type ImportResult } from "../api";
import { plural, t } from "../i18n";
import { Badge, Button, Field, Modal, Select, cx, dbName, progressText, useApp } from "../ui";

const SAFE_NAME = /^[A-Za-z0-9_$-]+$/;
const key = (d: { source: string; name: string }) => `${d.source}/${d.name}`;

/** Picks a .sql / .sql.gz / .zip, shows which databases it holds and imports the selected ones. */
export default function ImportDump({ onClose, onDone }: { onClose: () => void; onDone: () => void }) {
  const { snap, run, busy, progress, toast } = useApp();
  const [info, setInfo] = useState<DumpInfo>();
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [target, setTarget] = useState("");
  const [instance, setInstance] = useState("");
  const [existing, setExisting] = useState<Database[]>([]);
  const [mode, setMode] = useState<"replace" | "merge">("replace");
  const [result, setResult] = useState<ImportResult>();
  const started = useRef(false);

  useEffect(() => {
    if (started.current) return;
    started.current = true;
    (async () => {
      const file = await api.pickDump();
      if (!file) return onClose();
      try {
        const data = await api.dbInspect(file);
        setInfo(data);
        setSelected(new Set(data.databases.filter((d) => !d.system).map(key)));
        setTarget(data.suggested);
        setInstance(snap.instances.find((x) => x.family === data.family && x.default)?.id ?? "");
        api.databases().then(setExisting, () => {});
      } catch (e) {
        toast(String(e));
        onClose();
      }
    })();
  });

  const label = (id: string | null) => {
    const x = snap.instances.find((i) => i.id === id);
    return x ? `${dbName(x)} (:${x.port})` : t("not installed");
  };
  const targets = snap.instances.filter((x) => x.family === info?.family);
  const exists = (name: string, inst: string | null) => existing.some((d) => d.name === name && d.instance === inst);
  const userDbs = info?.databases.filter((d) => !d.system) ?? [];
  const valid = !!info && (info.kind === "archive" || !!instance) && (info.kind === "single" ? SAFE_NAME.test(target) : selected.size > 0);
  const toggle = (k: string) => setSelected((s) => new Set(s.has(k) ? [...s].filter((x) => x !== k) : [...s, k]));

  const submit = () =>
    run("import", async () => {
      setResult(await api.dbImport({ file: info!.file, databases: [...selected], target, instance, mode }));
      onDone();
    });

  const kind = !info
    ? ""
    : info.kind === "archive"
      ? t("lokaldev archive")
      : info.kind === "multi"
        ? t("Dump of several databases")
        : t("Dump of a single database");

  return (
    <Modal
      title={t("Import databases")}
      wide
      onClose={() => !busy.import && onClose()}
      footer={
        result ? (
          <Button variant="primary" onClick={onClose}>{t("Close")}</Button>
        ) : (
          <>
            {busy.import && <span className="mr-auto self-center text-[13px] text-muted">{progressText(progress.import) ?? t("Importing…")}</span>}
            <Button disabled={busy.import} onClick={onClose}>{t("Cancel")}</Button>
            <Button variant="primary" icon={FileUp} busy={busy.import} disabled={!valid} onClick={submit}>{t("Import")}</Button>
          </>
        )
      }
    >
      {!info ? (
        <p className="flex items-center gap-2 py-8 text-muted"><Loader2 size={16} className="animate-spin" /> {t("Reading the file…")}</p>
      ) : result ? (
        <div className="space-y-3">
          {result.imported.length > 0 && (
            <p className="flex items-start gap-2">
              <CheckCircle2 size={18} className="mt-0.5 shrink-0 text-success" />
              <span>{plural(result.imported.length, "{n} database imported", "{n} databases imported")}: <span className="text-muted">{result.imported.join(", ")}</span></span>
            </p>
          )}
          {result.failed.map((f) => (
            <div key={f.name} className="rounded-lg bg-danger-soft p-3">
              <p className="flex items-center gap-2 font-medium text-danger"><XCircle size={16} /> {f.name}</p>
              <pre className="mt-1 text-xs whitespace-pre-wrap text-danger select-text">{f.error}</pre>
            </div>
          ))}
        </div>
      ) : (
        <div className="space-y-4">
          <div className="rounded-lg bg-surface-2 px-3 py-2 text-[13px]">
            <p className="truncate font-mono" title={info.file}>{info.file.split(/[\\/]/).pop()}</p>
            <p className="text-muted">{kind}</p>
          </div>

          {info.kind !== "archive" && (
            <Field label={t("Server")}>
              {(id) => (
                <Select id={id} value={instance} onChange={(e) => setInstance(e.target.value)}>
                  {!targets.length && <option value="">{t("not installed")}</option>}
                  {targets.map((x) => <option key={x.id} value={x.id}>{label(x.id)}</option>)}
                </Select>
              )}
            </Field>
          )}

          {info.kind === "single" ? (
            <Field label={t("Target database")} hint={t("Created if it doesn't exist.")}>
              {(id) => <input id={id} className="input font-mono" value={target} aria-invalid={!!target && !SAFE_NAME.test(target)} onChange={(e) => setTarget(e.target.value.trim())} />}
            </Field>
          ) : (
            <div>
              <div className="mb-1.5 flex items-center justify-between text-[13px]">
                <span className="font-medium">{t("Databases in the file")} ({selected.size}/{userDbs.length})</span>
                <span className="flex gap-3">
                  <button type="button" className="text-accent hover:underline" onClick={() => setSelected(new Set(userDbs.map(key)))}>{t("Select all")}</button>
                  <button type="button" className="text-accent hover:underline" onClick={() => setSelected(new Set())}>{t("Select none")}</button>
                </span>
              </div>
              <ul className="max-h-[40vh] divide-y divide-line overflow-auto rounded-lg border border-line">
                {info.databases.map((d) => (
                  <li key={key(d)}>
                    <label className={cx("flex items-center gap-3 px-3 py-1.5", d.system ? "text-muted" : "cursor-pointer hover:bg-surface-2")}>
                      <input type="checkbox" className="size-4 accent-[var(--c-accent)]" disabled={d.system} checked={selected.has(key(d))} onChange={() => toggle(key(d))} />
                      <span className="flex-1 font-mono text-[13px]">{d.name}</span>
                      {info.kind === "archive" && <span className="text-xs text-muted">{label(d.instance)}</span>}
                      {d.system ? <Badge>{t("system, skipped")}</Badge> : exists(d.name, info.kind === "archive" ? d.instance : instance) && <Badge tone="warning">{t("exists")}</Badge>}
                    </label>
                  </li>
                ))}
              </ul>
            </div>
          )}

          <fieldset className="space-y-1.5">
            <legend className="mb-1 text-[13px] font-medium">{t("Existing databases")}</legend>
            {(["replace", "merge"] as const).map((m) => (
              <label key={m} className="flex cursor-pointer items-start gap-2">
                <input type="radio" name="mode" className="mt-1 accent-[var(--c-accent)]" checked={mode === m} onChange={() => setMode(m)} />
                <span>
                  {m === "replace" ? t("Replace — drop and import from scratch") : t("Merge — import into the existing database")}
                </span>
              </label>
            ))}
          </fieldset>
        </div>
      )}
    </Modal>
  );
}
