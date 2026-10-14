import { useEffect, useState, type ReactNode } from "react";
import { ChevronRight, Download, RefreshCw, SlidersHorizontal, Trash2 } from "lucide-react";
import PhpConfig from "./PhpConfig";
import DbConfig from "./DbConfig";
import { api, type ComponentId, type ComponentRelease, type DbEngine, type JsTool, type NodeRelease, type PhpRelease } from "../api";
import { Badge, Button, Modal, PageHeader, cx, progressText, useApp } from "../ui";
import { t } from "../i18n";

const groups: [string, [ComponentId, string, string?][]][] = [
  ["Web servers", [["apache", "Apache"], ["nginx", "Nginx"]]],
  ["Databases", [["mysql", "MySQL"], ["mariadb", "MariaDB"], ["postgres", "PostgreSQL", "Includes pgAdmin 4"], ["mongodb", "MongoDB", "Includes mongosh"]]],
  ["Cache", [["redis", "Redis", "Windows build by redis-windows"], ["memcached", "Memcached"]]],
  ["Python", [["python", "Python", "Includes pip and venv"]]],
  ["Tools", [["git", "Git", "MinGit, without bash"], ["composer", "Composer"], ["sqlite", "SQLite"], ["mailpit", "Mailpit"], ["phpmyadmin", "phpMyAdmin"]]],
];

const jsTools: [JsTool, string, string][] = [
  ["pnpm", "pnpm", "package manager"],
  ["deno", "Deno", "JS/TS runtime"],
  ["bun", "Bun", "runtime and package manager"],
];

const MYSQL = ["mysql", "mariadb"];

const semver = (v: string) => v.replace(/^v/, "").split(".").map(Number);
const newer = (a: string, b: string) => {
  const [x, y] = [semver(a), semver(b)];
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return (y[i] ?? 0) - (x[i] ?? 0);
  return 0;
};

export default function Binaries() {
  const { snap, run, busy, progress, toast, setConfig } = useApp();
  const [php, setPhp] = useState<PhpRelease[]>([]);
  const [nodes, setNodes] = useState<NodeRelease[]>([]);
  const [phpConfig, setPhpConfig] = useState<string>();
  const [dbConfig, setDbConfig] = useState<string>(); // database instance id
  const [releases, setReleases] = useState<Partial<Record<ComponentId, ComponentRelease[]>>>({});
  const [confirm, setConfirm] = useState<{ label: string; key: string; action: () => Promise<unknown> }>();
  const { node } = snap;

  useEffect(() => {
    api.phpReleases().then(setPhp, (e) => toast(String(e)));
    api.nodeReleases().then(setNodes, (e) => toast(String(e)));
    // version lists come from several sites; a failing one just shows its installed versions
    for (const [, items] of groups) {
      for (const [id] of items) api.componentReleases(id).then((r) => setReleases((x) => ({ ...x, [id]: r })), () => setReleases((x) => ({ ...x, [id]: [] })));
    }
  }, [toast]);

  const phpRows = [...new Set([...php.map((r) => r.minor), ...snap.php])].sort(newer);

  const lts: string[] = [];
  for (const r of nodes.filter((r) => r.lts).sort((a, b) => newer(a.version, b.version))) {
    const v = r.version.replace(/^v/, "");
    if (lts.length < 8 && !lts.some((x) => semver(x)[0] === semver(v)[0])) lts.push(v);
  }
  const nodeRows = [...new Set([...lts, ...node.installed])].sort(newer);
  const ltsName = (v: string) => nodes.find((r) => r.version.replace(/^v/, "") === v)?.lts;

  const uninstall = (label: string, key: string, action: () => Promise<unknown>) => setConfirm({ label, key, action });
  const working = (...prefixes: string[]) => Object.keys(busy).some((k) => prefixes.some((p) => k === p || k.startsWith(`${p}-`)));
  // one MySQL-compatible engine is the default; for other components (Apache and Nginx run side by side) the active series is
  const defaultComponent = (id: ComponentId) => !MYSQL.includes(id) || snap.config.db_engine === id;
  const setDefault = (id: ComponentId, series: string) =>
    setConfig({
      versions: { [id]: series },
      ...(MYSQL.includes(id) && { db_engine: id as DbEngine }),
    });
  const updates = Object.keys(snap.updates.binaries).map((k) => k.split("/") as [string, string]);
  const updateOne = (what: string, series: string) => run(`update-${what}-${series}`, () => api.updateComponent(what as ComponentId, series));
  const updateAll = async () => {
    for (const [what, series] of updates) await api.updateComponent(what as ComponentId, series);
  };
  const defaultPhp = snap.php.includes(snap.config.default_php) ? snap.config.default_php : snap.php.at(-1);
  const tools = jsTools.filter(([t]) => snap.tools[t].version).map(([t, name]) => `${name} ${snap.tools[t].version}`);

  return (
    <>
      <PageHeader
        title={t("Binaries")}
        subtitle={t("Language, server and tool versions stored in the app folder")}
        actions={
          <>
            <Button icon={RefreshCw} busy={busy.check} onClick={() => run("check", api.checkUpdates)}>{t("Check for updates")}</Button>
            {updates.length > 0 && (
              <Button variant="primary" busy={busy["update-all"]} onClick={() => run("update-all", updateAll)}>{t("Update all ({n})", { n: updates.length })}</Button>
            )}
          </>
        }
      />

      <div className="space-y-3">
        <Panel
          id="php"
          title="PHP"
          working={working("php")}
          summary={snap.php.length ? `${snap.php.join(", ")} · ${t("default {version}", { version: defaultPhp ?? "" })}` : t("no versions installed")}
        >
          <ul className="divide-y divide-line">
            {phpRows.map((minor) => {
              const installed = snap.php.includes(minor);
              const key = `php-${minor}`;
              return (
                <Row
                  key={minor}
                  name={`PHP ${minor}`}
                  info={php.find((r) => r.minor === minor)?.version}
                  tags={installed && snap.config.default_php === minor && <Badge tone="accent">{t("default")}</Badge>}
                  installed={installed}
                  busyKey={key}
                  onInstall={() => run(key, () => api.install("php", minor))}
                  onUninstall={() => uninstall(`PHP ${minor}`, key, () => api.uninstall("php", minor))}
                  update={snap.updates.binaries[`php/${minor}`]}
                  onUpdate={() => updateOne("php", minor)}
                  extra={installed && (
                    <>
                      {snap.config.default_php !== minor && (
                        <Button size="sm" variant="subtle" disabled={busy.config} onClick={() => setConfig({ default_php: minor })}>{t("Set as default")}</Button>
                      )}
                      <Button size="sm" variant="subtle" icon={SlidersHorizontal} onClick={() => setPhpConfig(minor)}>{t("Configure")}</Button>
                    </>
                  )}
                />
              );
            })}
            {!phpRows.length && <li className="px-4 py-3 text-muted">{t("Fetching versions…")}</li>}
          </ul>
        </Panel>

        <Panel
          id="node"
          title="Node.js"
          working={working("node", "nvm", "default")}
          summary={node.nvm === "missing" ? t("requires nvm for Windows") : node.installed.length ? `${node.installed.join(", ")} · ${t("default {version}", { version: node.default || "—" })}` : t("no versions installed")}
        >
          {node.nvm !== "ok" && (
            <div className="flex items-center gap-4 border-b border-line bg-surface-2 px-4 py-3">
              <p className="flex-1 text-[13px]">
                {node.nvm === "missing"
                  ? t("Node.js is managed by nvm for Windows. Install nvm 2.x to install Node.js versions and pin them per project (.nvmrc).")
                  : t("The installed nvm {version} doesn't support per-project versions — nvm for Windows 2.x is required.", { version: node.nvm_version })}
              </p>
              <Button size="sm" variant="primary" busy={busy.nvm} onClick={() => run("nvm", api.nvmInstall)}>
                {busy.nvm ? progressText(progress.nvm) ?? t("Installing…") : node.nvm === "old" ? t("Update nvm") : t("Install nvm")}
              </Button>
            </div>
          )}
          <ul className="divide-y divide-line">
            {nodeRows.map((v) => {
              const installed = node.installed.includes(v);
              const key = `node-${v}`;
              const line = ltsName(v);
              return (
                <Row
                  key={v}
                  name={`Node.js ${v}`}
                  tags={
                    <>
                      {line && <Badge>LTS {line}</Badge>}
                      {installed && node.default === v && <Badge tone="accent">{t("default")}</Badge>}
                    </>
                  }
                  installed={installed}
                  disabled={node.nvm === "missing"}
                  busyKey={key}
                  onInstall={() => run(key, () => api.nodeInstall(v))}
                  onUninstall={() => uninstall(`Node.js ${v}`, key, () => api.nodeUninstall(v))}
                  extra={installed && node.default !== v && (
                    <Button size="sm" variant="subtle" busy={busy[`default-${v}`]} onClick={() => run(`default-${v}`, () => api.nodeDefault(v))}>{t("Set as default")}</Button>
                  )}
                />
              );
            })}
          </ul>
        </Panel>

        <Panel id="js" title={t("JavaScript tools")} working={working("tool")} summary={tools.length ? tools.join(" · ") : t("none")}>
          <ul className="divide-y divide-line">
            {jsTools.map(([tool, name, note]) => {
              const { version, managed } = snap.tools[tool];
              const key = `tool-${tool}`;
              return (
                <li key={tool} className="flex min-h-12 items-center gap-3 px-4 py-2">
                  <div className="min-w-0 flex-1">
                    <p className="font-medium">{name}</p>
                    <p className="truncate text-xs text-muted">{version ?? t("not installed")} · {t(note)}</p>
                  </div>
                  {managed ? (
                    <Button size="sm" icon={Trash2} busy={busy[key]} onClick={() => uninstall(name, key, () => api.uninstallTool(tool))}>{t("Remove")}</Button>
                  ) : version ? (
                    <Badge tone="success">{t("external")}</Badge>
                  ) : (
                    <Button size="sm" variant="primary" icon={Download} busy={busy[key]} onClick={() => run(key, () => api.installTool(tool))}>
                      {busy[key] ? progressText(progress[key]) ?? t("Installing…") : t("Install")}
                    </Button>
                  )}
                </li>
              );
            })}
          </ul>
          <p className="border-t border-line px-4 py-2.5 text-xs text-muted">{t("Installed from official packages into the app folder and added to the user PATH. “External” = a version installed outside lokaldev.")}</p>
        </Panel>

        {groups.map(([title, items]) => {
          const active = items.filter(([id]) => snap.components[id] && defaultComponent(id)).map(([id, name]) => `${name} ${snap.components[id]}`);
          return (
            <Panel key={title} id={title} title={t(title)} working={working(...items.map(([id]) => id))} summary={active.length ? active.join(" · ") : t("none")}>
              <ul className="divide-y divide-line">
                {items.map(([id, name, note]) => {
                  const installed = snap.installed[id];
                  const defaultSeries = defaultComponent(id) ? installed.find((x) => x.version === snap.components[id])?.series : undefined;
                  const series = [...new Set([...(releases[id] ?? []).map((r) => r.series), ...installed.map((x) => x.series)])].sort(newer);
                  // a Git installed outside lokaldev is used as is; MinGit is only offered when there's none
                  const external = id === "git" && !installed.length && snap.system_git;
                  return [
                    <li key={id} className="flex items-baseline gap-2 bg-surface-2 px-4 py-1.5">
                      <span className="text-xs font-semibold tracking-wide text-muted uppercase">{name}</span>
                      {note && !external && <span className="text-xs text-muted">· {t(note)}</span>}
                      {!releases[id] && !external && <span className="text-xs text-muted">· {t("loading versions…")}</span>}
                    </li>,
                    ...(external
                      ? [
                          <li key="git-external" className="flex min-h-12 items-center gap-3 px-4 py-2">
                            <div className="min-w-0 flex-1">
                              <p className="font-medium">Git {snap.system_git}</p>
                              <p className="text-xs text-muted">{t("Installed on this computer; lokaldev uses it.")}</p>
                            </div>
                            <Badge tone="success">{t("external")}</Badge>
                          </li>,
                        ]
                      : []),
                    ...(external ? [] : series).map((s) => {
                      const release = releases[id]?.find((r) => r.series === s);
                      const own = installed.find((x) => x.series === s);
                      const key = `${id}-${s}`;
                      return (
                        <Row
                          key={key}
                          name={`${name} ${s}`}
                          info={own?.version ?? (release && release.version !== s ? release.version : undefined)}
                          tags={
                            <>
                              {release?.note && <Badge>{release.note}</Badge>}
                              {s === defaultSeries && <Badge tone="accent">{t("default")}</Badge>}
                            </>
                          }
                          installed={!!own}
                          busyKey={key}
                          onInstall={() => run(key, () => api.install(id, s))}
                          onUninstall={() => uninstall(`${name} ${s}`, key, () => api.uninstall(id, s))}
                          update={snap.updates.binaries[`${id}/${s}`]}
                          onUpdate={() => updateOne(id, s)}
                          extra={
                            own && (
                              <>
                                {s !== defaultSeries && (
                                  <Button size="sm" variant="subtle" disabled={busy.config} onClick={() => setDefault(id, s)}>
                                    {t("Set as default")}
                                  </Button>
                                )}
                                {(id === "mysql" || id === "mariadb" || id === "postgres") && (
                                  <Button size="sm" variant="subtle" icon={SlidersHorizontal} onClick={() => setDbConfig(key)}>{t("Configure")}</Button>
                                )}
                              </>
                            )
                          }
                        />
                      );
                    }),
                  ];
                })}
              </ul>
              {title === "Web servers" && <p className="border-t border-line px-4 py-2.5 text-xs text-muted">{t("Apache runs on ports {apache} and Nginx on {nginx}; both serve every project and can run at the same time.", { apache: `${snap.config.ports.apache_http}/${snap.config.ports.apache_https}`, nginx: `${snap.config.ports.nginx_http}/${snap.config.ports.nginx_https}` })}</p>}
              {title === "Databases" && <p className="border-t border-line px-4 py-2.5 text-xs text-muted">{t("Each database version keeps its own data. The default one runs on {mysql} / {postgres}, the others on the next free ports — projects can use any of them.", { mysql: snap.config.ports.mysql, postgres: snap.config.ports.postgres })}</p>}
            </Panel>
          );
        })}
      </div>

      {dbConfig && <DbConfig id={dbConfig} onClose={() => setDbConfig(undefined)} />}
      {phpConfig && <PhpConfig version={phpConfig} onClose={() => setPhpConfig(undefined)} />}
      {confirm && (
        <Modal
          title={t("Remove {name}?", { name: confirm.label })}
          onClose={() => setConfirm(undefined)}
          footer={
            <>
              <Button onClick={() => setConfirm(undefined)}>{t("Cancel")}</Button>
              <Button
                variant="danger"
                onClick={() => {
                  run(confirm.key, confirm.action);
                  setConfirm(undefined);
                }}
              >
                {t("Remove")}
              </Button>
            </>
          }
        >
          <p>{t("{name} files will be removed from the app folder. Projects using this version will stop working until you pick another one.", { name: confirm.label })}</p>
        </Modal>
      )}
    </>
  );
}

/** Collapsed whenever the page opens; the summary line shows what's installed. */
function Panel({ title, summary, working, children }: { id: string; title: string; summary: string; working: boolean; children: ReactNode }) {
  const [open, setOpen] = useState(false);
  const toggle = () => setOpen(!open);
  return (
    <section className="rounded-xl border border-line">
      <button type="button" aria-expanded={open} onClick={toggle} className="flex w-full items-center gap-3 rounded-xl px-4 py-3.5 text-left hover:bg-surface-2">
        <ChevronRight size={16} className={cx("shrink-0 text-muted transition-transform", open && "rotate-90")} />
        <span className="font-semibold">{title}</span>
        <span className={cx("min-w-0 flex-1 truncate text-right text-[13px]", working ? "text-accent" : "text-muted")}>
          {working ? t("in progress…") : summary}
        </span>
      </button>
      {open && <div className="border-t border-line">{children}</div>}
    </section>
  );
}

interface RowProps {
  name: string;
  update?: string; // newer version of an installed series
  updateKey?: string; // "<what>-<series>" progress id
  onUpdate?: () => void;
  info?: string;
  note?: string;
  tags?: ReactNode;
  extra?: ReactNode;
  installed: boolean;
  disabled?: boolean;
  busyKey: string;
  onInstall: () => void;
  onUninstall: () => void;
}

function Row({ name, info, note, tags, extra, installed, disabled, busyKey, onInstall, onUninstall, update, onUpdate }: RowProps) {
  const { busy, progress } = useApp();
  const working = busy[busyKey];
  const updating = busy[`update-${busyKey}`];
  return (
    <li className="flex min-h-12 items-center gap-3 px-4 py-2">
      <div className="min-w-0 flex-1">
        <p className="flex items-center gap-2 font-medium">
          {name} {tags}
          {installed && update && <Badge tone="warning">{t("{version} available", { version: update })}</Badge>}
        </p>
        {(info || note) && <p className="truncate text-xs text-muted">{[info, note].filter(Boolean).join(" · ")}</p>}
      </div>
      {extra}
      {installed && update && onUpdate && (
        <Button size="sm" variant="primary" icon={RefreshCw} busy={updating} disabled={working} onClick={onUpdate}>
          {updating ? progressText(progress[busyKey]) ?? t("Updating…") : t("Update")}
        </Button>
      )}
      {installed ? (
        <Button size="sm" icon={Trash2} busy={working} disabled={disabled} onClick={onUninstall}>{t("Remove")}</Button>
      ) : (
        <Button size="sm" variant="primary" icon={Download} busy={working} disabled={disabled} onClick={onInstall}>
          {working ? progressText(progress[busyKey]) ?? t("Installing…") : t("Install")}
        </Button>
      )}
    </li>
  );
}
