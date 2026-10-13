import { useCallback, useEffect, useState } from "react";
import { ChevronRight, Database as DbIcon, Download, ExternalLink, FileUp, FolderOpen, Plus, Trash2 } from "lucide-react";
import ImportDump from "./ImportDump";
import { api, type Database, type DbInstance } from "../api";
import { Badge, Button, Card, Field, IconButton, Modal, Notice, PageHeader, Select, dbName, engineNames, progressText, useApp } from "../ui";
import { plural, t } from "../i18n";

export default function Databases() {
  const { snap, run, busy, progress, toast } = useApp();
  const [list, setList] = useState<Database[]>([]);
  const [creating, setCreating] = useState(false);
  const [dropping, setDropping] = useState<Database>();
  const [importing, setImporting] = useState(false);
  const saved = (file: string | null) => file && toast(t("Saved to {file}", { file }));
  const running = (id: string) => !!snap.services.find((s) => s.id === id)?.running;
  const instances = snap.instances.filter((x) => x.running);
  // connection details of the running servers, or of the defaults while nothing runs
  const sqlite = snap.projects.filter((x) => x.sqlite);
  const login = (family: string) =>
    family === "postgres" ? { user: snap.config.pg_user, password: snap.config.pg_password } : { user: snap.config.mysql_user, password: snap.config.mysql_password };
  const shown = instances.length ? instances : snap.instances.filter((x) => x.default);

  const load = useCallback(() => api.databases().then(setList, (e) => toast(String(e))), [toast]);
  useEffect(() => {
    if (instances.length) load();
    else setList([]);
  }, [instances.map((x) => x.id).join(), load]);

  return (
    <>
      <PageHeader
        title={t("Databases")}
        subtitle={t("Databases in running engines")}
        actions={
          <>
            <Button icon={ExternalLink} disabled={!running("phpmyadmin")} onClick={() => run("open", () => api.openUrl(`http://127.0.0.1:${snap.config.ports.phpmyadmin}`))}>phpMyAdmin</Button>
            <Button icon={ExternalLink} disabled={!snap.components.postgres} busy={busy.pgadmin} onClick={() => run("pgadmin", api.openPgAdmin)}>pgAdmin</Button>
            <Button icon={Download} busy={busy["export-all"]} disabled={!instances.length} onClick={() => run("export-all", async () => saved(await api.dbExportAll()))}>
              {busy["export-all"] ? progressText(progress["export-all"]) ?? t("Exporting…") : t("Export all")}
            </Button>
            <Button icon={FileUp} disabled={!snap.instances.length} onClick={() => setImporting(true)}>{t("Import")}</Button>
            <Button variant="primary" icon={Plus} disabled={!instances.length} onClick={() => setCreating(true)}>{t("New database")}</Button>
          </>
        }
      />

      <div className="mb-4 grid gap-3 md:grid-cols-2">
        {shown.map((x) => (
          <Credentials
            key={x.id}
            title={dbName(x)}
            rows={[["Host", `127.0.0.1:${x.port}`], [t("User"), login(x.family).user], [t("Password"), login(x.family).password || t("(none)")]]}
          />
        ))}
      </div>

      {!instances.length ? (
        <Notice icon={DbIcon}>{t("Start {engine} or PostgreSQL in the Services tab to see databases.", { engine: engineNames[snap.config.db_engine] })}</Notice>
      ) : (
        <div className="space-y-4">
          {instances.map((x) => (
            <EngineList
              key={x.id}
              inst={x}
              list={list.filter((d) => d.instance === x.id)}
              onDrop={setDropping}
              onExport={(d) => run(`export-${d.name}`, async () => saved(await api.dbExport(d.instance, d.name)))}
            />
          ))}
        </div>
      )}

      {sqlite.length > 0 && (
        <Card title="SQLite" className="mt-4">
          <ul className="divide-y divide-line">
            {sqlite.map((x) => (
              <li key={x.path} className="flex items-center gap-3 px-4 py-2">
                <DbIcon size={15} className="text-muted" />
                <span className="font-medium">{x.name}</span>
                <span className="min-w-0 flex-1 truncate font-mono text-xs text-muted select-text" title={x.sqlite!}>{x.sqlite}</span>
                <IconButton icon={FolderOpen} label={t("Open folder")} onClick={() => run("open", () => api.openDir(x.sqlite!.replace(/[\\/][^\\/]+$/, "")))} />
              </li>
            ))}
          </ul>
        </Card>
      )}

      {importing && <ImportDump onClose={() => setImporting(false)} onDone={load} />}
      {creating && (
        <CreateModal
          instances={instances}
          onClose={() => setCreating(false)}
          onCreate={async (instance, name) => {
            if (await run("dbCreate", () => api.dbCreate(instance, name))) {
              setCreating(false);
              load();
            }
          }}
        />
      )}
      {dropping && (
        <DropModal
          db={dropping}
          onClose={() => setDropping(undefined)}
          onDrop={async () => {
            if (await run("dbDrop", () => api.dbDrop(dropping.instance, dropping.name))) {
              setDropping(undefined);
              load();
            }
          }}
        />
      )}
    </>
  );
}

function Credentials({ title, rows }: { title: string; rows: [string, string][] }) {
  return (
    <div className="rounded-lg border border-line bg-surface px-4 py-3">
      <p className="mb-2 font-semibold">{title}</p>
      <dl className="grid grid-cols-[100px_1fr] gap-y-1 text-[13px]">
        {rows.map(([k, v]) => (
          <div key={k} className="contents">
            <dt className="text-muted">{k}</dt>
            <dd className="font-mono select-text">{v}</dd>
          </div>
        ))}
      </dl>
    </div>
  );
}

function EngineList({ inst, list, onDrop, onExport }: { inst: DbInstance; list: Database[]; onDrop: (db: Database) => void; onExport: (db: Database) => void }) {
  const { busy, progress } = useApp();
  const [showSystem, setShowSystem] = useState(false);
  const user = list.filter((d) => !d.system);
  const system = list.filter((d) => d.system);
  const row = (d: Database) => (
    <li key={d.name} className="flex items-center gap-3 px-4 py-2">
      <DbIcon size={15} className="text-muted" />
      <span className={d.system ? "flex-1 text-muted" : "flex-1 font-medium"}>{d.name}</span>
      {d.system ? (
        <Badge>{t("system")}</Badge>
      ) : (
        <>
          {busy[`export-${d.name}`] && <span className="text-xs text-muted">{progressText(progress[`export-${d.name}`]) ?? t("Exporting…")}</span>}
          <IconButton icon={Download} label={t("Export {name}", { name: d.name })} disabled={busy[`export-${d.name}`]} onClick={() => onExport(d)} />
          <IconButton icon={Trash2} label={t("Delete {name}", { name: d.name })} onClick={() => onDrop(d)} />
        </>
      )}
    </li>
  );
  return (
    <Card title={`${dbName(inst)} · :${inst.port}`} actions={<span className="text-[13px] text-muted">{plural(user.length, "{n} database", "{n} databases")}</span>}>
      {user.length ? <ul className="divide-y divide-line">{user.map(row)}</ul> : <p className="px-4 py-3 text-muted">{t("No user databases.")}</p>}
      {system.length > 0 && (
        <div className="border-t border-line">
          <button type="button" aria-expanded={showSystem} className="flex w-full items-center gap-1.5 px-4 py-2 text-[13px] text-muted hover:text-fg" onClick={() => setShowSystem(!showSystem)}>
            <ChevronRight size={14} className={showSystem ? "rotate-90 transition-transform" : "transition-transform"} />
            {t("System databases ({n})", { n: system.length })}
          </button>
          {showSystem && <ul className="divide-y divide-line border-t border-line">{system.map(row)}</ul>}
        </div>
      )}
    </Card>
  );
}

function CreateModal({ instances, onClose, onCreate }: { instances: DbInstance[]; onClose: () => void; onCreate: (instance: string, name: string) => void }) {
  const { busy } = useApp();
  const [instance, setInstance] = useState(instances[0].id);
  const [name, setName] = useState("");
  const valid = /^[a-z0-9_]+$/.test(name);
  return (
    <Modal
      title={t("New database")}
      onClose={onClose}
      footer={
        <>
          <Button onClick={onClose}>{t("Cancel")}</Button>
          <Button variant="primary" busy={busy.dbCreate} disabled={!valid} onClick={() => onCreate(instance, name)}>{t("Create")}</Button>
        </>
      }
    >
      <Field label={t("Server")}>
        {(id) => (
          <Select id={id} value={instance} onChange={(e) => setInstance(e.target.value)}>
            {instances.map((x) => <option key={x.id} value={x.id}>{dbName(x)} (:{x.port})</option>)}
          </Select>
        )}
      </Field>
      <Field label={t("Name")} hint={t("Lowercase letters, digits and underscores.")}>
        {(id) => <input id={id} className="input" autoFocus value={name} aria-invalid={!!name && !valid} onChange={(e) => setName(e.target.value)} />}
      </Field>
    </Modal>
  );
}

function DropModal({ db, onClose, onDrop }: { db: Database; onClose: () => void; onDrop: () => void }) {
  const { busy } = useApp();
  const [name, setName] = useState("");
  const [before, after] = t("Database {name} ({engine}) will be permanently deleted.", { engine: `${engineNames[db.engine]} :${db.port}` }).split("{name}");
  return (
    <Modal
      title={t("Delete database")}
      onClose={onClose}
      footer={
        <>
          <Button onClick={onClose}>{t("Cancel")}</Button>
          <Button variant="danger" busy={busy.dbDrop} disabled={name !== db.name} onClick={onDrop}>{t("Delete")}</Button>
        </>
      }
    >
      <p>{before}<b>{db.name}</b>{after}</p>
      <Field label={t("Type “{name}” to confirm", { name: db.name })}>
        {(id) => <input id={id} className="input" autoFocus value={name} onChange={(e) => setName(e.target.value)} />}
      </Field>
    </Modal>
  );
}
