import { useEffect, useState, type ReactNode } from "react";
import { Download, FolderOpen, Info, RefreshCw, RotateCcw, Save, ShieldCheck } from "lucide-react";
import { version } from "../../package.json";
import logo from "../../resources/icon.svg";
import { api, type Lang, type PortKey, type Theme } from "../api";
import { Badge, Button, Card, Field, Notice, PageHeader, Select, Toggle, cx, progressText, useApp } from "../ui";
import { languages, plural, t } from "../i18n";

const themes: [Theme, string][] = [["system", "System"], ["light", "Light"], ["dark", "Dark"]];

const portFields: [PortKey, string][] = [
  ["apache_http", "Apache HTTP"], ["apache_https", "Apache HTTPS"], ["nginx_http", "Nginx HTTP"], ["nginx_https", "Nginx HTTPS"],
  ["mysql", "MySQL / MariaDB"], ["postgres", "PostgreSQL"], ["mongodb", "MongoDB"], ["redis", "Redis"], ["memcached", "Memcached"],
  ["mailpit_smtp", "Mailpit SMTP"], ["mailpit_web", "Mailpit web UI"], ["phpmyadmin", "phpMyAdmin"],
];

const tabs = [
  ["general", "General"],
  ["ports", "Ports"],
  ["databases", "Databases"],
  ["cli", "Command line"],
  ["https", "HTTPS"],
  ["updates", "Updates"],
  ["about", "About"],
] as const;

type Tab = (typeof tabs)[number][0];

export default function Settings({ tab: initial }: { tab?: string }) {
  const [tab, setTab] = useState<Tab>(tabs.some(([id]) => id === initial) ? (initial as Tab) : "general");
  return (
    <>
      <PageHeader title={t("Settings")} />
      <div role="tablist" className="mb-5 flex gap-1 border-b border-line">
        {tabs.map(([id, label]) => (
          <button
            key={id}
            type="button"
            role="tab"
            aria-selected={tab === id}
            onClick={() => setTab(id)}
            className={cx("-mb-px border-b-2 px-3 py-2 text-[13px] font-medium", tab === id ? "border-accent text-fg" : "border-transparent text-muted hover:text-fg")}
          >
            {t(label)}
          </button>
        ))}
      </div>
      <div className="space-y-4">
        {tab === "general" && <General />}
        {tab === "ports" && <Ports />}
        {tab === "databases" && <Databases />}
        {tab === "cli" && <CommandLine />}
        {tab === "https" && <Https />}
        {tab === "updates" && <Updates />}
        {tab === "about" && <About />}
      </div>
    </>
  );
}

function General() {
  const { snap, busy, setConfig } = useApp();
  const { config } = snap;
  const [tld, setTld] = useState(config.tld);
  const zones = Intl.supportedValuesOf("timeZone");

  const pickDir = async () => {
    const dir = await api.pickFolder(config.projects_dir || undefined);
    if (dir) setConfig({ projects_dir: dir });
  };

  return (
    <>
      <Card title={t("Projects")}>
        <div className="grid gap-4 p-4 md:grid-cols-[1fr_200px]">
          <Field label={t("Projects folder")} hint={t("Every subfolder is detected as a project automatically.")}>
            {(id) => (
              <div className="flex gap-2">
                <input id={id} className="input font-mono text-[13px]" value={config.projects_dir} placeholder={t("not selected")} readOnly />
                <Button icon={FolderOpen} onClick={pickDir}>{t("Choose")}</Button>
              </div>
            )}
          </Field>
          <Field label={t("Top-level domain")} hint={t("e.g. project.{tld}", { tld: tld || "test" })}>
            {(id) => (
              <input
                id={id}
                className="input"
                value={tld}
                onChange={(e) => setTld(e.target.value.replace(/^\./, "").toLowerCase())}
                onBlur={() => tld && tld !== config.tld && setConfig({ tld })}
                onKeyDown={(e) => e.key === "Enter" && e.currentTarget.blur()}
              />
            )}
          </Field>
        </div>
      </Card>

      <Card title={t("Time zone")}>
        <SettingRow title={t("Time zone")} desc={t("Used by PHP (date.timezone), PostgreSQL and Node.js/Python apps. MySQL and MariaDB keep the system time zone.")}>
          <Select className="w-64" value={config.timezone} disabled={busy.config} onChange={(e) => setConfig({ timezone: e.target.value })}>
            <option value="">{t("System ({zone})", { zone: Intl.DateTimeFormat().resolvedOptions().timeZone })}</option>
            {zones.map((z) => <option key={z} value={z}>{z}</option>)}
          </Select>
        </SettingRow>
      </Card>

      <Card title={t("Appearance")}>
        <div className="flex items-center justify-between gap-4 border-b border-line p-4">
          <span id="theme-label">{t("Theme")}</span>
          <Segmented labelledBy="theme-label" options={themes.map(([v, label]): [Theme, string] => [v, t(label)])} value={config.theme} onChange={(theme) => setConfig({ theme })} />
        </div>
        <div className="flex items-center justify-between gap-4 p-4">
          <label htmlFor="language">{t("Interface language")}</label>
          <Select id="language" className="w-48" value={config.language} disabled={busy.config} onChange={(e) => setConfig({ language: e.target.value as Lang })}>
            {languages.map(([code, name]) => <option key={code} value={code}>{name}</option>)}
          </Select>
        </div>
      </Card>

      <Card title={t("Startup")}>
        <SettingRow title={t("Launch at Windows startup")} desc={t("lokaldev starts minimized to the notification area.")}>
          <Toggle label={t("Launch at Windows startup")} checked={config.launch_at_login} onChange={(v) => setConfig({ launch_at_login: v })} />
        </SettingRow>
        <SettingRow title={t("Start services on launch")} desc={t("The selected services start when lokaldev opens.")}>
          <Toggle label={t("Start services on launch")} checked={config.start_all_on_launch} onChange={(v) => setConfig({ start_all_on_launch: v })} />
        </SettingRow>
        {config.start_all_on_launch && <LaunchServices />}
      </Card>
    </>
  );
}

/** Services started on launch: all by default, so newly installed ones are included until switched off. */
function LaunchServices() {
  const { snap, setConfig } = useApp();
  // local copy: quick clicks build on each other instead of on a snapshot the first save hasn't updated yet
  const [skip, setSkip] = useState(snap.config.launch_skip);
  const saved = JSON.stringify(snap.config.launch_skip);
  useEffect(() => setSkip(snap.config.launch_skip), [saved]);
  const save = (next: string[]) => {
    setSkip(next);
    setConfig({ launch_skip: next });
  };
  const list = snap.services.filter((s) => s.installed && s.id !== "pgadmin");
  const all = list.every((s) => !skip.includes(s.id));
  const toggle = (id: string, on: boolean) => save(on ? skip.filter((x) => x !== id) : [...skip, id]);
  return (
    <ul className="border-b border-line bg-surface-2/50 py-1 pr-4 pl-8">
      <li className="flex items-center justify-between py-2 font-medium">
        {t("All services")}
        <Toggle label={t("All services")} checked={all} onChange={(on) => save(on ? [] : list.map((s) => s.id))} />
      </li>
      {list.map((s) => (
        <li key={s.id} className="flex items-center justify-between border-t border-line py-2 text-[13px]">
          {s.name}
          <Toggle label={s.name} checked={!skip.includes(s.id)} onChange={(on) => toggle(s.id, on)} />
        </li>
      ))}
    </ul>
  );
}

function Ports() {
  const { snap, busy, setConfig } = useApp();
  const [ports, setPorts] = useState(snap.config.ports);
  const changed = portFields.some(([k]) => ports[k] !== snap.config.ports[k]);
  return (
    <Card title={t("Ports")}>
      <div className="grid gap-4 p-4 sm:grid-cols-3">
        {portFields.map(([key, label]) => (
          <Field key={key} label={label}>
            {(id) => <input id={id} type="number" min={1} max={65535} className="input" value={ports[key] || ""} onChange={(e) => setPorts({ ...ports, [key]: Number(e.target.value) })} />}
          </Field>
        ))}
      </div>
      <div className="flex items-center gap-4 border-t border-line px-4 py-3">
        <p className="flex-1 text-[13px] text-muted">
          {t("Other MySQL/MariaDB and PostgreSQL versions take the next free ports. Saving restarts the affected services and updates the projects' .env / wp-config.php.")}
        </p>
        <Button variant="primary" icon={Save} busy={busy.config} disabled={!changed} onClick={() => setConfig({ ports })}>{t("Save")}</Button>
      </div>
    </Card>
  );
}

function Databases() {
  const { snap, busy, setConfig } = useApp();
  const c = snap.config;
  const current = c.db_dir || `${snap.root}\\databases`;
  const pick = async () => {
    const dir = await api.pickFolder(current);
    if (dir) setConfig({ db_dir: dir });
  };
  return (
    <>
      <Card title={t("Data folder")}>
        <div className="space-y-2 p-4">
          <div className="flex gap-2">
            <input className="input font-mono text-[13px]" value={current} readOnly aria-label={t("Data folder")} />
            <Button icon={FolderOpen} busy={busy.config} onClick={pick}>{t("Choose")}</Button>
            {c.db_dir && <Button disabled={busy.config} onClick={() => setConfig({ db_dir: "" })}>{t("Default")}</Button>}
          </div>
          <p className="text-[13px] text-muted">
            {t("MySQL, MariaDB, PostgreSQL, MongoDB, Redis and Mailpit keep their data here, each version in its own subfolder. Changing it moves the existing data and restarts the running databases.")}
          </p>
        </div>
      </Card>
      <Credentials
        title={t("MySQL & MariaDB credentials")}
        note={t("Shared by all MySQL and MariaDB versions. Running servers switch to the new login when you save; projects that use the old one are updated.")}
        userKey="mysql_user"
        passwordKey="mysql_password"
        user={c.mysql_user}
        password={c.mysql_password}
      />
      <Credentials
        title={t("PostgreSQL credentials")}
        note={t("PostgreSQL uses its own superuser account; the default is postgres with no password.")}
        userKey="pg_user"
        passwordKey="pg_password"
        user={c.pg_user}
        password={c.pg_password}
      />
    </>
  );
}

function Credentials(props: { title: string; note: string; userKey: "mysql_user" | "pg_user"; passwordKey: "mysql_password" | "pg_password"; user: string; password: string }) {
  const { busy, setConfig } = useApp();
  const [user, setUser] = useState(props.user);
  const [password, setPassword] = useState(props.password);
  const valid = /^[A-Za-z0-9_]+$/.test(user);
  const changed = user !== props.user || password !== props.password;
  return (
    <Card title={props.title}>
      <div className="space-y-4 p-4">
        <Notice icon={Info}>{props.note}</Notice>
        <div className="grid max-w-xl gap-4 sm:grid-cols-2">
          <Field label={t("Username")}>{(id) => <input id={id} className="input" value={user} aria-invalid={!valid} onChange={(e) => setUser(e.target.value.trim())} />}</Field>
          <Field label={t("Password")} hint={t("Leave empty for no password (recommended for local development).")}>
            {(id) => <input id={id} className="input" value={password} placeholder={t("no password")} onChange={(e) => setPassword(e.target.value)} />}
          </Field>
        </div>
      </div>
      <div className="flex justify-end border-t border-line px-4 py-3">
        <Button variant="primary" icon={Save} busy={busy.config} disabled={!changed || !valid} onClick={() => setConfig({ [props.userKey]: user, [props.passwordKey]: password })}>
          {t("Save")}
        </Button>
      </div>
    </Card>
  );
}

function CommandLine() {
  const { snap, run, busy } = useApp();
  return (
    <Card title={t("Command line")}>
      <SettingRow
        title={t("Add tools to the user PATH")}
        desc={t("Inside a project folder, php, composer, mysql and psql use the version assigned to that project; elsewhere they use the default. nvm switches Node.js versions based on the .nvmrc file.")}
      >
        <Toggle label={t("Add tools to the user PATH")} checked={snap.path_enabled} disabled={busy.path} onChange={(v) => run("path", () => api.setPath(v))} />
      </SettingRow>
    </Card>
  );
}

function Https() {
  const { snap, run, busy, setConfig } = useApp();
  return (
    <Card title="HTTPS">
      <SettingRow title={t("Enable SSL by default")} desc={t("New projects get a certificate and an https:// address.")}>
        <Toggle label={t("Enable SSL by default")} checked={snap.config.ssl_default} onChange={(v) => setConfig({ ssl_default: v })} />
      </SettingRow>
      <SettingRow
        title={<span className="flex items-center gap-2">{t("Local certificate authority")} {snap.ca_trusted ? <Badge tone="success">{t("trusted")}</Badge> : <Badge tone="warning">{t("not trusted")}</Badge>}</span>}
        desc={t("Firefox requires security.enterprise_roots.enabled = true in about:config.")}
      >
        {!snap.ca_trusted && <Button icon={ShieldCheck} busy={busy.ca} onClick={() => run("ca", api.trustCa)}>{t("Trust certificate")}</Button>}
      </SettingRow>
    </Card>
  );
}

/** Downloads the new lokaldev and restarts into it (or only restarts when it is already downloaded). */
export function AppUpdateButton({ size }: { size?: "sm" }) {
  const { snap, run, busy, progress } = useApp();
  const u = snap.updates;
  if (!u.app) return null;
  if (u.downloaded) return <Button size={size} variant="primary" icon={RotateCcw} onClick={() => run("apply", api.applyUpdate)}>{t("Restart to update")}</Button>;
  const install = async () => {
    await api.downloadUpdate();
    await api.applyUpdate();
  };
  return (
    <Button size={size} variant="primary" icon={Download} busy={busy.update} onClick={() => run("update", install)}>
      {busy.update ? progressText(progress.update) ?? t("Downloading…") : t("Download and install")}
    </Button>
  );
}

function Updates() {
  const { snap, go, run, busy, setConfig } = useApp();
  const u = snap.updates;
  const binaries = Object.keys(u.binaries).length;
  return (
    <>
      <Card title={t("lokaldev")}>
        <SettingRow title={t("Check for updates automatically")} desc={t("Once a day: new lokaldev releases and newer versions of installed binaries.")}>
          <Toggle label={t("Check for updates automatically")} checked={snap.config.update_check} onChange={(v) => setConfig({ update_check: v })} />
        </SettingRow>
        <div className="flex items-center gap-4 border-b border-line px-4 py-3.5 last:border-b-0">
          <div className="flex-1">
            <p className="font-medium">{t("Installed version {version}", { version: u.current })}</p>
            <p className="mt-0.5 text-[13px] text-muted">{u.checked ? t("Last checked {time}", { time: new Date(u.checked).toLocaleString() }) : t("Not checked yet")}</p>
          </div>
          <Button icon={RefreshCw} busy={busy.check} onClick={() => run("check", api.checkUpdates)}>{t("Check now")}</Button>
        </div>
        {u.app ? (
          <div className="space-y-3 p-4">
            <div className="flex items-center gap-3">
              <p className="flex-1 font-medium">{t("lokaldev {version} is available.", { version: u.app.version })}</p>
              <Button variant="subtle" onClick={() => run("open", () => api.openUrl(u.app!.page))}>{t("Release page")}</Button>
              <AppUpdateButton />
            </div>
            {u.app.notes && <pre className="max-h-64 overflow-auto rounded-lg bg-surface-2 p-3 text-xs whitespace-pre-wrap select-text">{u.app.notes}</pre>}
            <p className="text-xs text-muted">{t("lokaldev quits, replaces its files and starts again; services are stopped for a moment. Projects, databases and settings stay.")}</p>
          </div>
        ) : (
          u.checked && <p className="px-4 py-3 text-[13px] text-muted">{t("lokaldev is up to date.")}</p>
        )}
      </Card>
      <Card title={t("Binaries")}>
        <div className="flex items-center gap-4 p-4">
          <p className="flex-1 text-[13px]">{binaries ? plural(binaries, "{n} installed version can be updated.", "{n} installed versions can be updated.") : t("All installed versions are up to date.")}</p>
          {binaries > 0 && <Button onClick={() => go({ name: "binaries" })}>{t("Go to Binaries")}</Button>}
        </div>
      </Card>
    </>
  );
}

function About() {
  const { snap, run } = useApp();
  const rows: [string, ReactNode][] = [
    [t("Version"), version],
    ["Electron", snap.runtime.electron],
    ["Chromium", snap.runtime.chrome],
    ["Node.js", snap.runtime.node],
    [t("Time zone"), snap.runtime.timezone],
  ];
  return (
    <>
      <Card>
        <div className="flex items-center gap-4 p-5">
          <img src={logo} alt="" className="size-14" />
          <div>
            <p className="text-lg font-semibold">lokaldev <span className="text-[13px] font-normal text-muted">v{version}</span></p>
            <p className="text-[13px] text-muted">{t("Portable local development environment for PHP, Node.js and Python on Windows.")}</p>
          </div>
        </div>
        <dl className="grid grid-cols-[160px_1fr] gap-y-2 border-t border-line p-4 text-[13px]">
          {rows.map(([k, v]) => (
            <div key={k} className="contents">
              <dt className="text-muted">{k}</dt>
              <dd className="font-mono select-text">{v}</dd>
            </div>
          ))}
        </dl>
      </Card>
      <Card title={t("App folder")}>
        <div className="flex items-center gap-3 p-4">
          <span className="min-w-0 flex-1 truncate font-mono text-[13px] select-text">{snap.root}</span>
          <Button icon={FolderOpen} onClick={() => run("open", () => api.openDir(snap.root))}>{t("Open")}</Button>
        </div>
      </Card>
    </>
  );
}

function Segmented<T extends string>({ labelledBy, options, value, onChange }: { labelledBy: string; options: [T, string][]; value: T; onChange: (v: T) => void }) {
  return (
    <div role="radiogroup" aria-labelledby={labelledBy} className="inline-flex rounded-md border border-line bg-surface-2 p-0.5">
      {options.map(([v, label]) => (
        <button
          key={v}
          type="button"
          role="radio"
          aria-checked={value === v}
          onClick={() => onChange(v)}
          className={cx("h-7 rounded px-4 text-[13px]", value === v ? "bg-surface font-medium text-accent shadow-sm" : "text-muted hover:text-fg")}
        >
          {label}
        </button>
      ))}
    </div>
  );
}

function SettingRow({ title, desc, children }: { title: ReactNode; desc: string; children?: ReactNode }) {
  return (
    <div className="flex items-center gap-6 border-line px-4 py-3.5 not-last:border-b">
      <div className="flex-1">
        <div className="font-medium">{title}</div>
        <p className="mt-0.5 text-[13px] text-muted">{desc}</p>
      </div>
      {children}
    </div>
  );
}
