import { ExternalLink, Play, Square } from "lucide-react";
import { api } from "../api";
import { Badge, Button, PageHeader, StatusPill, Toggle, serviceStatus, useApp } from "../ui";
import { plural, t } from "../i18n";

const groups = [["web", "Web servers"], ["db", "Databases"], ["cache", "Cache"], ["tools", "Tools"]] as const;

export default function Services() {
  const { snap, go, run, busy } = useApp();

  return (
    <>
      <PageHeader
        title={t("Services")}
        subtitle={t("Web server, databases and tools")}
        actions={
          <>
            <Button icon={Square} busy={busy.stopAll} onClick={() => run("stopAll", api.stopAll)}>{t("Stop all")}</Button>
            <Button variant="primary" icon={Play} busy={busy.startAll} onClick={() => run("startAll", api.startAll)}>{t("Start all")}</Button>
          </>
        }
      />

      <div className="space-y-6">
        {groups.map(([group, title]) => (
          <section key={group}>
            <h2 className="mb-2 text-xs font-semibold tracking-wide text-muted uppercase">{t(title)}</h2>
            <div className="grid gap-3 md:grid-cols-2 lg:grid-cols-3">
              {snap.services.filter((s) => s.group === group).map((s) => (
                <div key={s.id} className="flex flex-col rounded-xl bg-surface-2 p-4">
                  <div className="flex items-start justify-between gap-2">
                    <p className="flex items-center gap-2 font-semibold">
                      {s.name}
                      {s.default && <Badge tone="accent">{t("default")}</Badge>}
                    </p>
                    <Toggle
                      label={t(s.running ? "Stop {name}" : "Start {name}", { name: s.name })}
                      checked={s.running}
                      disabled={!s.installed || busy[s.id]}
                      onChange={(on) => run(s.id, () => (on ? api.startService(s.id) : api.stopService(s.id)))}
                    />
                  </div>
                  <div className="mt-2 mb-4 flex flex-wrap items-center gap-x-2 gap-y-1">
                    <StatusPill status={serviceStatus(s, busy[s.id])} />
                    {s.installed && s.ports.length > 0 && <span className="text-xs text-muted">port {s.ports.join(", ")}</span>}
                    {s.installed && s.projects !== null && <span className="text-xs text-muted">· {plural(s.projects, "{n} project", "{n} projects")}</span>}
                  </div>
                  <div className="mt-auto flex gap-2">
                    {!s.installed && s.id === "pgadmin" && <p className="text-[13px] text-muted">{t("pgAdmin is installed together with PostgreSQL.")}</p>}
                    {!s.installed && s.id !== "pgadmin" && (
                      <button type="button" className="text-[13px] font-medium text-accent hover:underline" onClick={() => go({ name: "binaries" })}>
                        {t("Install from Binaries")}
                      </button>
                    )}
                    {s.installed && s.url && (
                      <Button size="sm" variant="subtle" icon={ExternalLink} disabled={!s.running} onClick={() => run("open", () => api.openUrl(s.url!))}>
                        {t("Open web UI")}
                      </Button>
                    )}
                  </div>
                </div>
              ))}
            </div>
          </section>
        ))}
      </div>

    </>
  );
}
