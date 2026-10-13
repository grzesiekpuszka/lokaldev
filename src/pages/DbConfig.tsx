import { useEffect, useState } from "react";
import { Loader2, Save } from "lucide-react";
import { api, type DbConf } from "../api";
import { t } from "../i18n";
import { Button, Field, Modal, Select, cx, dbName, useApp } from "../ui";

const MYSQL_KEYS = [
  "innodb_buffer_pool_size", "max_connections", "max_allowed_packet", "wait_timeout", "character-set-server",
  "collation-server", "sql_mode", "default-time-zone", "slow_query_log", "long_query_time",
];

const PG_KEYS = [
  "max_connections", "shared_buffers", "work_mem", "maintenance_work_mem", "effective_cache_size", "timezone",
  "log_min_duration_statement", "log_statement",
];


const HINTS: Record<string, string> = {
  shared_buffers: "e.g. 256MB; about 25% of RAM",
  work_mem: "e.g. 16MB; per sort/hash operation",
  maintenance_work_mem: "e.g. 256MB; VACUUM, CREATE INDEX",
  effective_cache_size: "e.g. 4GB; planner hint, allocates nothing",
  timezone: "e.g. Europe/Warsaw or UTC",
  log_min_duration_statement: "Milliseconds, -1 = off",
  innodb_buffer_pool_size: "e.g. 512M; the biggest performance factor",
  max_connections: "e.g. 151",
  max_allowed_packet: "e.g. 64M; raise for large imports",
  wait_timeout: "Seconds",
  sql_mode: "Empty value = server default",
  "default-time-zone": "e.g. +00:00 or SYSTEM",
  long_query_time: "Seconds, logged when slow_query_log = 1",
};

type Tab = "settings" | "raw";

/** Config of one database instance ("mariadb-11.4", "postgres-17"). */
export default function DbConfig({ id: instanceId, onClose }: { id: string; onClose: () => void }) {
  const { snap, run, busy, toast } = useApp();
  const inst = snap.instances.find((x) => x.id === instanceId);
  const engine = inst?.engine;
  const [tab, setTab] = useState<Tab>("settings");
  const [ini, setIni] = useState<DbConf>();
  const [settings, setSettings] = useState<Record<string, string>>({});
  const [raw, setRaw] = useState("");
  const name = inst ? dbName(inst) : instanceId;
  const file = engine === "postgres" ? "postgresql.conf" : "my.ini";
  const keys = engine === "postgres" ? PG_KEYS : MYSQL_KEYS;
  const hint = (key: string) => (engine === "postgres" && key === "max_connections" ? "e.g. 100" : HINTS[key]);

  const load = () =>
    api.dbConfigGet(instanceId).then((data) => {
      setIni(data);
      setSettings(data.settings);
      setRaw(data.raw);
    }, (e) => (toast(String(e)), onClose()));

  useEffect(() => {
    load();
  }, [instanceId]);

  const changedSettings = ini ? Object.fromEntries(Object.entries(settings).filter(([k, v]) => (ini.settings[k] ?? "") !== v)) : {};
  const dirty = !!ini && (tab === "raw" ? raw !== ini.raw : Object.keys(changedSettings).length > 0);

  const save = () =>
    run("myIni", async () => {
      try {
        await api.dbConfigSet(instanceId, tab === "raw" ? { raw } : { settings: changedSettings });
      } finally {
        await load();
      }
    });

  const tabs: [Tab, string][] = [["settings", t("Settings")], ["raw", file]];

  return (
    <Modal
      title={t("{name} configuration", { name })}
      wide
      onClose={onClose}
      footer={
        <>
          <p className="mr-auto self-center text-xs text-muted">{t("Saving restarts the database if it's running.")}</p>
          <Button onClick={onClose}>{t("Close")}</Button>
          <Button variant="primary" icon={Save} busy={busy.myIni} disabled={!dirty} onClick={save}>{t("Save")}</Button>
        </>
      }
    >
      <div role="tablist" className="flex gap-1 border-b border-line">
        {tabs.map(([id, label]) => (
          <button
            key={id}
            type="button"
            role="tab"
            aria-selected={tab === id}
            onClick={() => setTab(id)}
            className={cx("-mb-px border-b-2 px-3 py-2 text-[13px] font-medium", tab === id ? "border-accent text-fg" : "border-transparent text-muted hover:text-fg")}
          >
            {label}
          </button>
        ))}
      </div>

      {!ini ? (
        <p className="flex items-center gap-2 py-8 text-muted"><Loader2 size={16} className="animate-spin" /> {t("Loading…")}</p>
      ) : tab === "settings" ? (
        <div className="grid max-h-[55vh] gap-4 overflow-auto pr-1 sm:grid-cols-2">
          {keys.map((key) => (
            <Field key={key} label={key} hint={hint(key) && t(hint(key))}>
              {(id) =>
                key === "slow_query_log" || key === "log_statement" ? (
                  <Select id={id} value={settings[key] ?? ""} onChange={(e) => setSettings((s) => ({ ...s, [key]: e.target.value }))}>
                    <option value="">{t("(default)")}</option>
                    {(key === "log_statement" ? ["none", "ddl", "mod", "all"] : ["1", "0"]).map((v) => <option key={v} value={v}>{v}</option>)}
                  </Select>
                ) : (
                  <input id={id} className="input font-mono text-[13px]" value={settings[key] ?? ""} placeholder={t("(default)")} onChange={(e) => setSettings((s) => ({ ...s, [key]: e.target.value }))} />
                )
              }
            </Field>
          ))}
        </div>
      ) : (
        <>
          <p className="text-xs text-muted">{t(engine === "postgres" ? "lokaldev sets these at startup, values in the file are ignored: {keys}." : "lokaldev rewrites these keys on every start: {keys}.", { keys: ini.managed.join(", ") })}</p>
          <textarea
            aria-label={file}
            spellCheck={false}
            className="h-[50vh] w-full resize-none rounded-lg border border-line bg-surface-2 p-3 font-mono text-xs leading-relaxed outline-none focus:border-accent"
            value={raw}
            onChange={(e) => setRaw(e.target.value)}
          />
        </>
      )}
    </Modal>
  );
}
