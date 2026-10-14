import { ArrowRight, Download, ExternalLink, FolderOpen, FolderKanban, Lock, Play, Plus, RefreshCw, ShieldAlert, Sparkles, Square, Terminal } from "lucide-react";
import { AppUpdateButton } from "./Settings";
import { api, proxied } from "../api";
import { Button, Empty, Notice, StatusPill, Toggle, TypeBadge, cx, serviceStatus, useApp } from "../ui";
import { plural, t } from "../i18n";

export default function Dashboard() {
  const { snap, go, run, busy, setConfig } = useApp();
  const { config, projects, services, node } = snap;
  const installed = services.filter((s) => s.installed);
  const running = installed.filter((s) => s.running).length;
  const overall =
    !installed.length ? [t("No services"), "bg-warning"] : running === installed.length ? [t("All running"), "bg-success"] : running ? [t("Partially running"), "bg-warning"] : [t("Stopped"), "bg-muted/50"];

  const hour = new Date().getHours();
  const greeting = hour < 12 ? t("Good morning") : hour < 18 ? t("Good afternoon") : t("Good evening");

  const chooseDir = async () => {
    const dir = await api.pickFolder();
    if (dir) setConfig({ projects_dir: dir });
  };

  return (
    <>
      <div className="mb-8 flex flex-wrap items-center justify-between gap-4">
        <div>
          <p className="flex items-center gap-2 text-[13px] text-muted">
            <span className={cx("size-2 rounded-full", overall[1])} /> {overall[0]} · {t("{running}/{total} services", { running, total: installed.length })}
          </p>
          <h1 className="mt-1 text-[26px] font-semibold tracking-tight">{greeting}</h1>
        </div>
        <div className="flex gap-2">
          {running > 0 ? (
            <Button icon={Square} busy={busy.stopAll} onClick={() => run("stopAll", api.stopAll)}>{t("Stop all")}</Button>
          ) : (
            <Button icon={Play} busy={busy.startAll} disabled={!installed.length} onClick={() => run("startAll", api.startAll)}>{t("Start all")}</Button>
          )}
          {installed.some((s) => s.id === "phpmyadmin") && (
            <Button icon={ExternalLink} busy={busy.pma} onClick={() => run("pma", api.openPhpMyAdmin)}>phpMyAdmin</Button>
          )}
          {installed.some((s) => s.id === "mailpit") && (
            <Button icon={ExternalLink} busy={busy.mailpit} onClick={() => run("mailpit", api.openMailpit)}>Mailpit</Button>
          )}
          {installed.some((s) => s.id === "pgadmin") && (
            <Button icon={ExternalLink} busy={busy.pgadmin} onClick={() => run("pgadmin", api.openPgAdmin)}>pgAdmin</Button>
          )}
          <Button variant="primary" icon={Plus} onClick={() => go({ name: "new" })}>{t("New project")}</Button>
        </div>
      </div>

      <div className="mb-8 space-y-2 empty:hidden">
        {snap.updates.app && (
          <Notice icon={Sparkles} action={<AppUpdateButton size="sm" />}>
            {t("lokaldev {version} is available.", { version: snap.updates.app.version })}{" "}
            <button type="button" className="text-accent hover:underline" onClick={() => go({ name: "settings", tab: "updates" })}>{t("What's new")}</button>
          </Notice>
        )}
        {Object.keys(snap.updates.binaries).length > 0 && (
          <Notice icon={Download} action={<Button size="sm" onClick={() => go({ name: "binaries" })}>{t("Go to Binaries")}</Button>}>
            {plural(Object.keys(snap.updates.binaries).length, "{n} installed version can be updated.", "{n} installed versions can be updated.")}
          </Notice>
        )}
        {snap.dirty && (
          <Notice icon={RefreshCw} action={<Button size="sm" variant="primary" busy={busy.web} onClick={() => run("web", api.reloadWeb)}>{t("Reload")}</Button>}>
            {t("The configuration has changed — the web server needs a reload.")}
          </Notice>
        )}
        {!snap.path_enabled && (
          <Notice icon={Terminal} action={<Button size="sm" busy={busy.path} onClick={() => run("path", () => api.setPath(true))}>{t("Add to PATH")}</Button>}>
            {t("php, composer, mysql and psql aren't available in the terminal.")}
          </Notice>
        )}
        {!snap.ca_trusted && (
          <Notice icon={ShieldAlert} tone="warning" action={<Button size="sm" busy={busy.ca} onClick={() => run("ca", api.trustCa)}>{t("Trust certificate")}</Button>}>
            {t("The local certificate isn't trusted — browsers will show a warning for HTTPS.")}
          </Notice>
        )}
      </div>

      <section className="mb-10">
        <SectionTitle title={t("Services")} action={() => go({ name: "services" })} />
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
          {!running && <p className="text-[13px] text-muted">{t("No services are running.")}</p>}
          {services.filter((s) => s.running).map((s) => (
            <div key={s.id} className="flex items-center gap-3 rounded-xl bg-surface-2 px-4 py-3">
              <div className="min-w-0 flex-1">
                <p className="truncate font-medium">{s.name}</p>
                <div className="mt-1 flex items-center gap-2">
                  <StatusPill status={serviceStatus(s, busy[s.id])} />
                  {s.installed && <span className="text-xs text-muted">:{s.ports.join(", :")}</span>}
                </div>
              </div>
              {s.running && s.url && (
                <button type="button" aria-label={t("Open {name}", { name: s.name })} className="text-muted hover:text-accent" onClick={() => run("open", () => api.openUrl(s.url!))}>
                  <ExternalLink size={16} />
                </button>
              )}
              {s.installed ? (
                <Toggle
                  label={t(s.running ? "Stop {name}" : "Start {name}", { name: s.name })}
                  checked={s.running}
                  disabled={busy[s.id]}
                  onChange={(on) => run(s.id, () => (on ? api.startService(s.id) : api.stopService(s.id)))}
                />
              ) : (
                <Button size="sm" variant="subtle" onClick={() => go({ name: "binaries" })}>{t("Install")}</Button>
              )}
            </div>
          ))}
        </div>
      </section>

      <section>
        <SectionTitle title={t("Projects")} action={projects.length ? () => go({ name: "projects" }) : undefined} />
        {!config.projects_dir && !projects.length ? (
          <Empty icon={FolderOpen} title={t("Choose a projects folder")}>
            <p className="mb-3">{t("Every subfolder will be detected as a project with its own domain.")}</p>
            <Button variant="primary" icon={FolderOpen} onClick={chooseDir}>{t("Choose folder")}</Button>
          </Empty>
        ) : projects.length === 0 ? (
          <Empty icon={FolderKanban} title={t("No projects")}>
            <Button variant="primary" onClick={() => go({ name: "new" })}>{t("Create your first project")}</Button>
          </Empty>
        ) : (
          <ul className="divide-y divide-line">
            {projects.slice(0, 6).map((p) => (
              <li key={p.path} className="group flex items-center gap-4 py-3">
                <button type="button" className="min-w-0 flex-1 text-left" onClick={() => go({ name: "project", path: p.path })}>
                  <span className="block truncate font-medium group-hover:text-accent">{p.name}</span>
                  <span className="block truncate text-xs text-muted">
                    {[!proxied(p.type) && p.php && `PHP ${p.php}`, p.node && `Node ${p.node}`].filter(Boolean).join(" · ") || "—"}
                  </span>
                </button>
                <TypeBadge type={p.type} />
                <button type="button" className="flex w-52 items-center justify-end gap-1 truncate text-[13px] text-accent hover:underline" onClick={() => run("open", () => api.openUrl(p.url))}>
                  {p.ssl && <Lock size={12} className="shrink-0" />}
                  <span className="truncate">{p.domain}</span>
                </button>
              </li>
            ))}
          </ul>
        )}
        <p className="mt-6 text-xs text-muted">
          PHP: {snap.php.length ? snap.php.join(", ") : t("none")} · Node.js: {node.default || t("none")}
        </p>
      </section>
    </>
  );
}

function SectionTitle({ title, action }: { title: string; action?: () => void }) {
  return (
    <div className="mb-3 flex items-center justify-between">
      <h2 className="text-[13px] font-semibold tracking-wide text-muted uppercase">{title}</h2>
      {action && (
        <button type="button" className="flex items-center gap-1 text-[13px] text-accent hover:underline" onClick={action}>
          {t("View all")} <ArrowRight size={13} />
        </button>
      )}
    </div>
  );
}
