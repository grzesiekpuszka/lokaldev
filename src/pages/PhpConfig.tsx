import { useEffect, useState } from "react";
import { Loader2, Save, Search } from "lucide-react";
import { api, type PhpIni } from "../api";
import { t } from "../i18n";
import { Button, Field, Modal, Select, Toggle, cx, useApp } from "../ui";

const KEYS = [
  "memory_limit", "upload_max_filesize", "post_max_size", "max_execution_time", "max_input_time", "max_input_vars",
  "display_errors", "error_reporting", "date.timezone", "short_open_tag", "opcache.enable", "opcache.validate_timestamps",
];

const SWITCHES: Record<string, [string, string]> = {
  display_errors: ["On", "Off"],
  short_open_tag: ["On", "Off"],
  "opcache.enable": ["1", "0"],
  "opcache.validate_timestamps": ["1", "0"],
};

const HINTS: Record<string, string> = {
  memory_limit: "e.g. 512M, -1 = no limit",
  upload_max_filesize: "e.g. 256M",
  post_max_size: "Should be at least upload_max_filesize",
  max_execution_time: "Seconds, 0 = no limit",
  error_reporting: "e.g. E_ALL",
  "date.timezone": "e.g. Europe/Warsaw",
};

type Tab = "extensions" | "settings" | "raw";

export default function PhpConfig({ version, onClose }: { version: string; onClose: () => void }) {
  const { run, busy, toast } = useApp();
  const [tab, setTab] = useState<Tab>("extensions");
  const [ini, setIni] = useState<PhpIni>();
  const [extensions, setExtensions] = useState<Record<string, boolean>>({});
  const [settings, setSettings] = useState<Record<string, string>>({});
  const [raw, setRaw] = useState("");
  const [query, setQuery] = useState("");

  const load = () =>
    api.phpIniGet(version).then((data) => {
      setIni(data);
      setExtensions(Object.fromEntries(data.extensions.map((e) => [e.name, e.enabled])));
      setSettings(data.settings);
      setRaw(data.raw);
    }, (e) => (toast(String(e)), onClose()));

  useEffect(() => {
    load();
  }, [version]);

  const changed = ini && {
    extensions: Object.fromEntries(Object.entries(extensions).filter(([n, on]) => ini.extensions.find((e) => e.name === n)?.enabled !== on)),
    settings: Object.fromEntries(Object.entries(settings).filter(([k, v]) => (ini.settings[k] ?? "") !== v)),
    raw: raw !== ini.raw,
  };
  // the extensions and settings tabs are saved together; the raw tab replaces the whole file
  const dirty = !!changed && (tab === "raw" ? changed.raw : Object.keys(changed.extensions).length + Object.keys(changed.settings).length > 0);

  const save = () =>
    run("phpIni", async () => {
      const warnings = await api.phpIniSet(version, tab === "raw" ? { raw } : { extensions: changed!.extensions, settings: changed!.settings });
      if (warnings) toast(`${t("PHP reported problems with the new configuration:")}\n${warnings}`);
      await load();
    });

  const q = query.toLowerCase();
  const tabs: [Tab, string][] = [["extensions", t("Extensions")], ["settings", t("Settings")], ["raw", "php.ini"]];

  return (
    <Modal
      title={t("PHP {version} configuration", { version })}
      wide
      onClose={onClose}
      footer={
        <>
          <p className="mr-auto self-center text-xs text-muted">{t("Saving restarts the PHP processes that use this version.")}</p>
          <Button onClick={onClose}>{t("Close")}</Button>
          <Button variant="primary" icon={Save} busy={busy.phpIni} disabled={!dirty} onClick={save}>{t("Save")}</Button>
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
      ) : tab === "extensions" ? (
        <>
          <div className="relative">
            <Search size={15} className="absolute top-2.5 left-3 text-muted" />
            <input className="input pl-9" placeholder={t("Search extensions…")} aria-label={t("Search extensions…")} value={query} onChange={(e) => setQuery(e.target.value)} />
          </div>
          <ul className="grid max-h-[50vh] gap-x-6 overflow-auto sm:grid-cols-2">
            {ini.extensions.filter((e) => e.name.includes(q)).map((e) => (
              <li key={e.name} className="flex items-center justify-between gap-3 border-b border-line py-2">
                <span className="font-mono text-[13px]">
                  {e.name}
                  {e.zend && <span className="ml-2 font-sans text-xs text-muted">zend</span>}
                </span>
                <Toggle label={e.name} checked={!!extensions[e.name]} onChange={(on) => setExtensions((x) => ({ ...x, [e.name]: on }))} />
              </li>
            ))}
          </ul>
        </>
      ) : tab === "settings" ? (
        <div className="grid max-h-[55vh] gap-4 overflow-auto pr-1 sm:grid-cols-2">
          {KEYS.map((key) => (
              <Field key={key} label={key} hint={HINTS[key] && t(HINTS[key])}>
                {(id) =>
                  SWITCHES[key] ? (
                    <Select id={id} value={settings[key] ?? ""} onChange={(e) => setSettings((s) => ({ ...s, [key]: e.target.value }))}>
                      <option value="">{t("(default)")}</option>
                      {SWITCHES[key].map((v) => <option key={v} value={v}>{v}</option>)}
                    </Select>
                  ) : (
                    <input id={id} className="input font-mono text-[13px]" value={settings[key] ?? ""} placeholder={t("(default)")} onChange={(e) => setSettings((s) => ({ ...s, [key]: e.target.value }))} />
                  )
                }
              </Field>
          ))}
        </div>
      ) : (
        <textarea
          aria-label="php.ini"
          spellCheck={false}
          className="h-[55vh] w-full resize-none rounded-lg border border-line bg-surface-2 p-3 font-mono text-xs leading-relaxed outline-none focus:border-accent"
          value={raw}
          onChange={(e) => setRaw(e.target.value)}
        />
      )}
    </Modal>
  );
}
