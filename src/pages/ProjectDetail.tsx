import { useEffect, useState, type ReactNode } from "react";
import { ArrowLeft, ExternalLink, FileCode2, FolderOpen, FolderX, Lock, Play, Save, Square, SquareTerminal, Trash2 } from "lucide-react";
import { api, type Project, type ProjectSettings, proxied } from "../api";
import { Badge, Button, Card, DatabaseSelect, DocrootInput, Empty, Field, Modal, PageHeader, Select, Toggle, TypeBadge, defaultLabel, defaultPhp, useApp } from "../ui";
import { t } from "../i18n";

export default function ProjectDetail({ path }: { path: string }) {
  const { snap, go } = useApp();
  const project = snap.projects.find((p) => p.path === path);
  const back = (
    <button type="button" className="mb-3 inline-flex items-center gap-1.5 text-muted hover:text-fg" onClick={() => go({ name: "projects" })}>
      <ArrowLeft size={15} /> {t("Projects")}
    </button>
  );
  if (!project)
    return (
      <>
        {back}
        <Empty icon={FolderX} title={t("This project doesn't exist")}>{path}</Empty>
      </>
    );
  return <Detail project={project} back={back} />;
}

function Detail({ project: p, back }: { project: Project; back: ReactNode }) {
  const { snap, go, run, busy, toast } = useApp();
  const node = proxied(p.type);
  const pinnedPhp = snap.config.projects[p.path]?.php ?? "";
  const phpDefault = defaultPhp(snap);
  const current: ProjectSettings = {
    php: snap.php.includes(pinnedPhp) ? pinnedPhp : "", node: p.node, db_name: p.db_name, domain: p.domain, ssl: p.ssl, docroot: p.docroot, node_port: p.node_port, node_cmd: p.node_cmd, db: p.db, python: p.python,
  };
  const [orig, setOrig] = useState(current);
  const [form, setForm] = useState(current);
  const [removing, setRemoving] = useState(false);
  const set = (patch: ProjectSettings) => setForm((f) => ({ ...f, ...patch }));
  const key = (s: ProjectSettings, k: string) => s[k as keyof ProjectSettings];
  // fields the user hasn't touched follow the project (e.g. a name changed in .env); edited ones stay
  const snapshot = JSON.stringify(current);
  useEffect(() => {
    setForm((f) => Object.fromEntries(Object.entries(current).map(([k, v]) => [k, key(f, k) === key(orig, k) ? v : key(f, k)])));
    setOrig(current);
  }, [snapshot]);
  const db = snap.instances.find((x) => x.id === form.db) ?? (!form.db ? snap.instances.find((x) => x.family === "mysql" && x.default) : undefined);
  const synced = p.type === "laravel" || p.type === "symfony" || p.type === "wordpress";
  const nodeVersions = [...new Set([...snap.node.installed, ...(p.node ? [p.node] : [])])];

  // only what was changed, so a save can't write back values that changed elsewhere meanwhile
  const save = async () => {
    const changed = Object.fromEntries(Object.entries(form).filter(([k, v]) => v !== key(orig, k)));
    if (await run("save", () => api.setProject(p.path, changed))) toast(t("Project settings saved."), true);
  };

  return (
    <>
      <PageHeader
        back={back}
        title={<span className="flex items-center gap-3">{p.name} <TypeBadge type={p.type} /></span>}
        subtitle={
          <button type="button" className="inline-flex items-center gap-1 text-accent hover:underline" onClick={() => run("open", () => api.openUrl(p.url))}>
            {p.ssl && <Lock size={12} />} {p.url}
          </button>
        }
        actions={
          <>
            {node &&
              (p.node_running ? (
                <Button icon={Square} busy={busy.node} onClick={() => run("node", () => api.stopNode(p.path))}>{t("Stop")}</Button>
              ) : (
                <Button icon={Play} busy={busy.node} onClick={() => run("node", () => api.startNode(p.path))}>{t("Start")}</Button>
              ))}
            <Button icon={FolderOpen} onClick={() => run("open", () => api.openDir(p.path))}>Folder</Button>
            <Button icon={SquareTerminal} onClick={() => run("open", () => api.openTerminal(p.path))}>Terminal</Button>
            <Button variant="primary" icon={ExternalLink} onClick={() => run("open", () => api.openUrl(p.url))}>{t("Open")}</Button>
          </>
        }
      />

      <Card title={t("Settings")} className="mb-4">
        <div className="grid gap-4 p-4 sm:grid-cols-2">
          <div className="sm:col-span-2">
            <Field label={t("Path")}>{(id) => <input id={id} className="input" value={p.path} readOnly />}</Field>
          </div>
          <Field label={t("Domain")}>{(id) => <input id={id} className="input" value={form.domain} onChange={(e) => set({ domain: e.target.value })} />}</Field>
          <Field label={t("Document root")} hint={t("Relative to the project folder, e.g. public or public_html.")}>
            {(id) => <DocrootInput id={id} base={p.path} value={form.docroot ?? ""} onChange={(docroot) => set({ docroot })} />}
          </Field>
          {!node && (
            <Field label={t("PHP version")} hint={!snap.php.length && t("Install PHP in the Binaries tab.")}>
              {(id) => (
                <Select id={id} value={form.php} onChange={(e) => set({ php: e.target.value })}>
                  <option value="">{defaultLabel(phpDefault && `PHP ${phpDefault}`)}</option>
                  {snap.php.map((v) => <option key={v} value={v}>PHP {v}</option>)}
                </Select>
              )}
            </Field>
          )}
          <Field label={t("Node.js version")} hint={snap.node.nvm !== "ok" && t("Per-project versions require nvm for Windows 2.x (Binaries).")}>
            {(id) => (
              <Select id={id} value={form.node} disabled={snap.node.nvm !== "ok"} onChange={(e) => set({ node: e.target.value })}>
                <option value="">{defaultLabel(snap.node.default && `Node.js ${snap.node.default}`)}</option>
                {nodeVersions.map((v) => <option key={v} value={v}>{v}</option>)}
              </Select>
            )}
          </Field>
          <Field
            label={t("Database server")}
            hint={
              form.db === "sqlite"
                ? `${p.sqlite ?? t("SQLite file")}${synced ? ` · ${t(".env is updated on save.")}` : ""}`
                : db &&
              `127.0.0.1:${db.port} · ${db.family === "postgres" ? snap.config.pg_user : snap.config.mysql_user}${synced ? ` · ${t(p.type === "wordpress" ? "wp-config.php is updated on save." : ".env is updated on save.")}` : ""}`
            }
          >
            {(id) => <DatabaseSelect id={id} value={form.db ?? ""} type={p.type} onChange={(db) => set({ db })} />}
          </Field>
          <Field label={t("Database name")} hint={form.db !== "sqlite" && t("Created on save when it changes.")}>
            {(id) => <input id={id} className="input" value={form.db === "sqlite" ? "" : form.db_name} disabled={form.db === "sqlite"} onChange={(e) => set({ db_name: e.target.value.trim() })} />}
          </Field>
          {snap.installed.python.length > 0 && (
            <Field label={t("Python version")} hint={t("Used by python and pip in this project's folder.")}>
              {(id) => (
                <Select id={id} value={form.python ?? ""} onChange={(e) => set({ python: e.target.value })}>
                  <option value="">{defaultLabel(`Python ${snap.components.python ?? ""}`)}</option>
                  {form.python && !snap.installed.python.some((x) => x.series === form.python) && <option value={form.python}>{form.python} — {t("not installed")}</option>}
                  {snap.installed.python.map((x) => <option key={x.series} value={x.series}>Python {x.version}</option>)}
                </Select>
              )}
            </Field>
          )}
          {node && (
            <>
              <Field label={t("App port")}>
                {(id) => <input id={id} type="number" className="input" value={form.node_port} onChange={(e) => set({ node_port: Number(e.target.value) })} />}
              </Field>
              <Field label={t("Start command")}>{(id) => <input id={id} className="input font-mono" value={form.node_cmd} onChange={(e) => set({ node_cmd: e.target.value })} />}</Field>
            </>
          )}
          <div className="flex items-center gap-3 sm:col-span-2">
            <Toggle label="HTTPS (SSL)" checked={!!form.ssl} onChange={(ssl) => set({ ssl })} />
            <span>HTTPS (SSL)</span>
          </div>
        </div>
        <div className="flex justify-end border-t border-line px-4 py-3">
          <Button variant="primary" icon={Save} busy={busy.save} onClick={save}>{t("Save")}</Button>
        </div>
      </Card>

      <Card title={t("Server configuration")} className="mb-4">
        <ul className="divide-y divide-line">
          {(["apache", "nginx"] as const).map((server) => {
            const custom = p.custom_vhost[server];
            const port = snap.config.ports[`${server}_${p.ssl ? "https" : "http"}`];
            const url = `${p.ssl ? "https" : "http"}://${p.domain}${port === (p.ssl ? 443 : 80) ? "" : `:${port}`}`;
            return (
              <li key={server} className="flex flex-wrap items-center gap-4 p-4">
                <div className="min-w-0 flex-1">
                  <p className="flex items-center gap-2 font-medium">
                    {server === "nginx" ? "Nginx" : "Apache"}
                    {custom ? <Badge tone="warning">{t("custom")}</Badge> : <Badge tone="success">{t("automatic")}</Badge>}
                    <button type="button" className="text-[13px] font-normal text-accent hover:underline" onClick={() => run("open", () => api.openUrl(url))}>{url}</button>
                  </p>
                  <p className="font-mono text-xs text-muted">{custom ? `${p.domain}.conf` : `auto.${p.domain}.conf`}</p>
                  <p className="mt-1 text-[13px] text-muted">
                    {custom
                      ? t("lokaldev doesn't generate this project's config. Reload the server to apply changes to the file.")
                      : t("Generated automatically from the settings above. A custom domain.conf file in the vhosts folder takes precedence.")}
                  </p>
                </div>
                <Button variant="subtle" icon={FolderOpen} onClick={() => run("open", () => api.openVhosts(server))}>{t("Vhosts folder")}</Button>
                {custom && <Button busy={busy[`vhostReset-${server}`]} onClick={() => run(`vhostReset-${server}`, () => api.vhostReset(p.path, server))}>{t("Restore automatic")}</Button>}
                <Button icon={FileCode2} busy={busy[`vhost-${server}`]} onClick={() => run(`vhost-${server}`, () => api.vhostCustomize(p.path, server))}>
                  {custom ? t("Edit") : t("Create custom")}
                </Button>
              </li>
            );
          })}
        </ul>
      </Card>

      <Card title={t("Danger zone")}>
        <div className="flex items-center justify-between gap-4 p-4">
          <div>
            <p className="font-medium">{t("Delete project")}</p>
            <p className="text-[13px] text-muted">
              {t("Removes the project's configuration from lokaldev.")}
              {!p.imported && ` ${t("Projects inside the projects folder will reappear unless you delete their files.")}`}
            </p>
          </div>
          <Button variant="danger" icon={Trash2} onClick={() => setRemoving(true)}>{t("Delete project")}</Button>
        </div>
      </Card>

      {removing && <RemoveModal project={p} onClose={() => setRemoving(false)} onDone={() => go({ name: "projects" })} />}
    </>
  );
}

function RemoveModal({ project, onClose, onDone }: { project: Project; onClose: () => void; onDone: () => void }) {
  const { run, busy } = useApp();
  const [files, setFiles] = useState(false);
  const [name, setName] = useState("");
  const remove = async () => {
    if (await run("remove", () => api.removeProject(project.path, files))) onDone();
  };
  return (
    <Modal
      title={t("Delete project")}
      onClose={onClose}
      footer={
        <>
          <Button onClick={onClose}>{t("Cancel")}</Button>
          <Button variant="danger" busy={busy.remove} disabled={name !== project.name} onClick={remove}>{t("Delete")}</Button>
        </>
      }
    >
      <label className="flex items-start gap-2">
        <input type="checkbox" className="mt-1 accent-[var(--c-danger)]" checked={files} onChange={(e) => setFiles(e.target.checked)} />
        <span>
          {t("Also delete files")}
          <span className="block text-[13px] text-muted">{project.path}</span>
        </span>
      </label>
      <Field label={t("Type “{name}” to confirm", { name: project.name })}>
        {(id) => <input id={id} className="input" autoFocus value={name} onChange={(e) => setName(e.target.value)} />}
      </Field>
    </Modal>
  );
}
