import { useEffect, useRef, useState } from "react";
import ImportProject from "./ImportProject";
import {
  AlertTriangle, ArrowLeft, ArrowRight, Boxes, Braces, Check, CheckCircle2, Code2, Database, FileCode2, Folder, FolderInput, FolderPlus, Globe, Hexagon, Layers, Loader2,
  Newspaper, Settings2, XCircle, type LucideIcon,
} from "lucide-react";
import { api, onTaskLog, type CreateSpec } from "../api";
import { Button, Field, Modal, Notice, PageHeader, Select, Toggle, cx, dbName as serverName, progressText, slug, typeColor, typeLabels, useApp } from "../ui";
import { t } from "../i18n";

type Kind = CreateSpec["type"];

const types: { id: Kind; name: string; desc: string; tags: string[]; icon: LucideIcon }[] = [
  { id: "laravel", name: "Laravel", desc: "Full-stack PHP framework with Eloquent ORM", tags: ["Artisan", "Queues", "Scheduler"], icon: Layers },
  { id: "symfony", name: "Symfony", desc: "Professional PHP framework for web applications", tags: ["Console", "Doctrine ORM"], icon: Boxes },
  { id: "wordpress", name: "WordPress", desc: "Popular CMS for websites and blogs", tags: ["Multisite"], icon: Newspaper },
  { id: "node", name: "Node.js", desc: "Node.js app (Express, Next.js, Nuxt…)", tags: ["Express", "Next.js", "Vite"], icon: Hexagon },
  { id: "python", name: "Python", desc: "Python app (Django, Flask, FastAPI…)", tags: ["venv", "pip"], icon: Braces },
  { id: "custom", name: "Custom PHP", desc: "Any PHP app or framework", tags: ["Flexible setup"], icon: FileCode2 },
  { id: "empty", name: "Empty project", desc: "Only the folder and the web server config", tags: ["Static", "PHP"], icon: FolderPlus },
];

const steps: [string, LucideIcon][] = [
  ["Project type", Folder],
  ["Details", Settings2],
  ["Services", Database],
  ["Domain", Globe],
  ["Summary", Check],
];

export default function NewProject() {
  const { snap, go, run, busy, progress } = useApp();
  const { config, components } = snap;
  const [step, setStep] = useState(0);
  const [type, setType] = useState<Kind>("laravel");
  const app = type === "node" || type === "python"; // runs its own server behind the proxy
  const [importDir, setImportDir] = useState<string>();
  const [name, setName] = useState("");
  const [path, setPath] = useState<string>();
  const [php, setPhp] = useState(snap.php.includes(config.default_php) ? config.default_php : (snap.php.at(-1) ?? ""));
  const [node, setNode] = useState("");
  const [python, setPython] = useState("");
  const [nodePort, setNodePort] = useState(3000);
  const [nodeCmd, setNodeCmd] = useState("npm run dev");
  const [deps, setDeps] = useState(true);
  const [database, setDatabase] = useState<CreateSpec["database"]>("none");
  const [dbName, setDbName] = useState<string>();
  const [domain, setDomain] = useState<string>();
  const [ssl, setSsl] = useState(config.ssl_default);
  const [docroot, setDocroot] = useState("");
  const [creating, setCreating] = useState(false);

  const s = slug(name);
  const spec: CreateSpec = {
    type,
    name: name.trim(),
    path: path ?? (config.projects_dir && s ? `${config.projects_dir.replace(/[\\/]+$/, "")}\\${s}` : ""),
    import: false,
    php: app ? "" : php,
    node,
    python,
    database,
    db_name: dbName ?? s.replace(/-/g, "_"),
    domain: domain ?? (s ? `${s}.${config.tld}` : ""),
    ssl,
    docroot,
    node_port: nodePort,
    node_cmd: nodeCmd,
    install_deps: deps,
  };

  const kindLabel = type === "empty" ? t("Empty project") : typeLabels[type];
  const noWeb = !components.apache && !components.nginx;
  const noPhp = !app && !snap.php.length;
  const noPython = type === "python" && !snap.installed.python.length;

  const chooseType = (type: Kind) => {
    setType(type);
    setNodePort(type === "python" ? 8000 : 3000);
    setNodeCmd(type === "python" ? "python app.py" : "npm run dev");
    setPath(undefined);
    setDocroot("");
    const mysql = snap.instances.find((x) => x.family === "mysql" && x.default);
    setDatabase((type === "laravel" || type === "wordpress") && mysql ? mysql.id : "none");
  };

  const pickImport = async () => {
    const dir = await api.pickFolder();
    if (dir) setImportDir(dir);
  };

  const browse = async () => {
    const dir = await api.pickFolder(config.projects_dir || undefined);
    if (dir) setPath(dir);
  };

  const valid = [
    true,
    !!spec.name && !!spec.path && (app || !!php) && (!app || nodePort > 0),
    database === "none" || database === "sqlite" || /^[a-z0-9_]+$/.test(spec.db_name),
    /^[a-z0-9.-]+$/i.test(spec.domain),
    !noWeb && !noPhp && !noPython,
  ];

  return (
    <>
      <PageHeader
        title={t("New project")}
        back={
          <button type="button" className="mb-3 inline-flex items-center gap-1.5 text-muted hover:text-fg" onClick={() => go({ name: "projects" })}>
            <ArrowLeft size={15} /> {t("Projects")}
          </button>
        }
      />

      {(noWeb || noPhp || noPython) && (
        <div className="mb-5">
          <Notice icon={AlertTriangle} tone="warning" action={<Button size="sm" onClick={() => go({ name: "binaries" })}>{t("Go to Binaries")}</Button>}>
            {[noWeb && t("No web server installed (Apache or Nginx)."), noPhp && t("No PHP version installed."), noPython && t("No Python version installed.")].filter(Boolean).join(" ")}
          </Notice>
        </div>
      )}

      <ol className="mb-8 grid grid-cols-5 gap-2">
        {steps.map(([label], i) => (
          <li key={label}>
            <button
              type="button"
              disabled={i > step}
              onClick={() => setStep(i)}
              aria-current={i === step ? "step" : undefined}
              className="w-full text-left text-[13px] disabled:cursor-default"
            >
              <span className={cx("mb-2 block h-1 rounded-full", i < step ? "bg-accent" : i === step ? "bg-accent/60" : "bg-line")} />
              <span className={cx("flex items-center gap-1.5", i === step ? "font-semibold text-fg" : i < step ? "text-accent" : "text-muted")}>
                {i < step && <Check size={13} />}
                {t(label)}
              </span>
            </button>
          </li>
        ))}
      </ol>

      <div>
        {step === 0 && (
          <>
            <StepTitle title={t("Choose a project type")} sub={t("Framework or environment for the new project")} />
            <div className="grid gap-3 md:grid-cols-3">
              {types.map((x) => (
                <TypeCard key={x.id} {...x} selected={type === x.id} onClick={() => chooseType(x.id)} />
              ))}
              <button
                type="button"
                onClick={pickImport}
                className="flex gap-3 rounded-xl border border-dashed border-muted/50 p-4 text-left hover:bg-surface-2"
              >
                <span className="flex size-9 shrink-0 items-center justify-center rounded-md bg-surface-2 text-muted">
                  <FolderInput size={18} />
                </span>
                <span>
                  <span className="block font-semibold">{t("Import project")}</span>
                  <span className="block text-[13px] text-muted">{t("Open an existing project folder")}</span>
                </span>
              </button>
            </div>
          </>
        )}

        {step === 1 && (
          <>
            <StepTitle title={t("Project details")} sub={t("New {type} project", { type: kindLabel })} />
            <div className="grid gap-4 md:grid-cols-2">
              <Field label={t("Name")}>{(id) => <input id={id} className="input" autoFocus value={name} required onChange={(e) => setName(e.target.value)} placeholder={t("my-project")} />}</Field>
              <Field label={t("Path")} hint={!config.projects_dir && !path && t("Choose a projects folder in Settings first, or enter a path.")}>
                {(id) => (
                  <div className="flex gap-2">
                    <input id={id} className="input font-mono text-[13px]" value={spec.path} onChange={(e) => setPath(e.target.value)} />
                    <Button onClick={browse}>{t("Browse")}</Button>
                  </div>
                )}
              </Field>
              {!app && (
                <div className="space-y-1 md:col-span-2">
                  <p className="text-[13px] font-medium">{t("PHP version")}</p>
                  <div role="radiogroup" aria-label={t("PHP version")} className="flex flex-wrap gap-2">
                    {snap.php.map((v) => (
                      <button
                        key={v}
                        type="button"
                        role="radio"
                        aria-checked={php === v}
                        onClick={() => setPhp(v)}
                        className={cx("h-8 rounded-md border px-3.5 font-medium", php === v ? "border-accent bg-accent-soft text-accent" : "border-line hover:bg-surface-2")}
                      >
                        PHP {v}
                      </button>
                    ))}
                    {!snap.php.length && <span className="text-muted">{t("No PHP versions installed.")}</span>}
                  </div>
                </div>
              )}
              <Field label={t("Node.js version")}>
                {(id) => (
                  <Select id={id} value={node} disabled={snap.node.nvm !== "ok"} onChange={(e) => setNode(e.target.value)}>
                    <option value="">{t("none")}</option>
                    {snap.node.installed.map((v) => <option key={v} value={v}>{v}</option>)}
                  </Select>
                )}
              </Field>
              {snap.installed.python.length > 0 && (
                <Field label={t("Python version")}>
                  {(id) => (
                    <Select id={id} value={python} onChange={(e) => setPython(e.target.value)}>
                      <option value="">{t("Default — {name}", { name: `Python ${components.python ?? ""}` })}</option>
                      {snap.installed.python.map((x) => <option key={x.series} value={x.series}>Python {x.version}</option>)}
                    </Select>
                  )}
                </Field>
              )}
              {snap.node.nvm !== "ok" && (
                <div className="flex items-center gap-3 rounded-md bg-surface-2 p-3 text-[13px] md:row-span-1">
                  <p className="flex-1 text-muted">
                    {snap.node.nvm === "old"
                      ? t("The installed nvm {version} doesn't support per-project versions — nvm for Windows 2.x is required.", { version: snap.node.nvm_version })
                      : t("Node.js requires nvm for Windows 2.x.")}
                  </p>
                  <Button size="sm" busy={busy.nvm} onClick={() => run("nvm", api.nvmInstall)}>
                    {busy.nvm ? progressText(progress.nvm) ?? t("Installing…") : snap.node.nvm === "old" ? t("Update nvm") : t("Install nvm")}
                  </Button>
                </div>
              )}
              {app && (
                <>
                  <Field label={t("App port")}>
                    {(id) => <input id={id} type="number" min={1} max={65535} className="input" value={nodePort} onChange={(e) => setNodePort(Number(e.target.value))} />}
                  </Field>
                  <Field label={t("Start command")}>{(id) => <input id={id} className="input font-mono" value={nodeCmd} onChange={(e) => setNodeCmd(e.target.value)} />}</Field>
                </>
              )}
              <label className="flex items-center gap-2 md:col-span-2">
                <input type="checkbox" className="size-4 accent-[var(--c-accent)]" checked={deps} onChange={(e) => setDeps(e.target.checked)} />
                {t("Install dependencies")}
              </label>
            </div>
          </>
        )}

        {step === 2 && (
          <>
            <StepTitle title={t("Services")} sub={t("The database will be created automatically")} />
            <div role="radiogroup" aria-label={t("Database")} className="mb-5 grid gap-3 md:grid-cols-3">
              <DbOption label={t("None")} checked={database === "none"} onClick={() => setDatabase("none")} />
              {snap.instances.map((x) => (
                <DbOption key={x.id} label={serverName(x)} note={`port ${x.port}`} checked={database === x.id} onClick={() => setDatabase(x.id)} />
              ))}
              {(type === "laravel" || type === "symfony") && (
                <DbOption label="SQLite" note={t("a file in the project")} checked={database === "sqlite"} onClick={() => setDatabase("sqlite")} />
              )}
            </div>
            {database !== "none" && database !== "sqlite" && (
              <div className="max-w-sm">
                <Field label={t("Database name")} hint={t("Lowercase letters, digits and underscores.")}>
                  {(id) => <input id={id} className="input" value={spec.db_name} onChange={(e) => setDbName(e.target.value)} />}
                </Field>
              </div>
            )}
          </>
        )}

        {step === 3 && (
          <>
            <StepTitle title={t("Domain and server")} sub={`${t("Served by {server}", { server: `Apache (${config.ports.apache_http}/${config.ports.apache_https}) · Nginx (${config.ports.nginx_http}/${config.ports.nginx_https})` })}${app ? ` ${t("as a proxy to port {port}", { port: nodePort })}` : ""}`} />
            <div className="grid gap-4 md:grid-cols-2">
              <Field label={t("Domain")}>{(id) => <input id={id} className="input" value={spec.domain} onChange={(e) => setDomain(e.target.value)} />}</Field>
              {!app && (
                <Field label={t("Document root")} hint={t("Leave empty to detect automatically.")}>
                  {(id) => (
                    <input id={id} className="input" value={docroot} placeholder={type === "laravel" || type === "symfony" ? "public" : "."} onChange={(e) => setDocroot(e.target.value)} />
                  )}
                </Field>
              )}
              <div className="flex items-center gap-3 md:col-span-2">
                <Toggle label="HTTPS (SSL)" checked={ssl} onChange={setSsl} />
                <span>HTTPS (SSL)</span>
              </div>
            </div>
          </>
        )}

        {step === 4 && (
          <>
            <StepTitle title={t("Summary")} sub={t("Review the settings before creating the project")} />
            <dl className="grid grid-cols-[180px_1fr] gap-x-4 gap-y-2.5">
              {[
                [t("Type"), kindLabel],
                [t("Name"), spec.name],
                [t("Path"), spec.path],
                ...(!app ? [["PHP", spec.php || "—"]] : []),
                ["Node.js", spec.node || t("none")],
                ...(snap.installed.python.length ? [["Python", python || t("default")]] : []),
                ...(app ? [[t("App"), `${nodeCmd} · port ${nodePort}`]] : []),
                [t("Database"), database === "none" ? t("none") : database === "sqlite" ? "SQLite" : `${serverName(snap.instances.find((x) => x.id === database)!)} · ${spec.db_name}`],
                [t("Address"), `${ssl ? "https" : "http"}://${spec.domain}`],
                ...(!app ? [[t("Document root"), docroot || t("auto-detect")]] : []),
                [t("Dependencies"), deps ? t("install") : t("skip")],
              ].map(([k, v]) => (
                <div key={k} className="contents">
                  <dt className="text-muted">{k}</dt>
                  <dd className="break-all">{v}</dd>
                </div>
              ))}
            </dl>
          </>
        )}
      </div>

      <div className="mt-8 flex justify-between border-t border-line pt-5">
        <Button icon={ArrowLeft} disabled={step === 0} onClick={() => setStep(step - 1)}>{t("Back")}</Button>
        {step < 4 ? (
          <Button variant="primary" disabled={!valid[step]} onClick={() => setStep(step + 1)}>
            {t("Next")} <ArrowRight size={15} />
          </Button>
        ) : (
          <Button variant="primary" icon={Code2} disabled={!valid.every(Boolean)} onClick={() => setCreating(true)}>{t("Create project")}</Button>
        )}
      </div>

      {creating && <CreateModal spec={spec} onClose={() => setCreating(false)} />}
      {importDir && <ImportProject dir={importDir} onClose={() => setImportDir(undefined)} />}
    </>
  );
}

function StepTitle({ title, sub }: { title: string; sub: string }) {
  return (
    <div className="mb-5">
      <h2 className="text-lg font-semibold">{title}</h2>
      <p className="text-muted">{sub}</p>
    </div>
  );
}

function TypeCard({ id, name, desc, tags, icon: Icon, selected, onClick }: (typeof types)[number] & { selected: boolean; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={selected}
      className={cx("flex gap-3 rounded-xl border p-4 text-left transition-colors", selected ? "border-accent bg-accent-soft/60 ring-1 ring-accent" : "border-line hover:bg-surface-2")}
    >
      <span className="flex size-10 shrink-0 items-center justify-center rounded-xl" style={{ color: typeColor(id === "empty" ? "custom" : id), background: `color-mix(in srgb, ${typeColor(id === "empty" ? "custom" : id)} 14%, transparent)` }}>
        <Icon size={19} />
      </span>
      <span className="min-w-0">
        <span className="block font-semibold">{t(name)}</span>
        <span className="block text-[13px] text-muted">{t(desc)}</span>
        <span className="mt-2 flex flex-wrap gap-1">
          {tags.map((tag) => (
            <span key={tag} className="rounded-full bg-idle-soft px-2 py-px text-[11px] font-medium text-muted">{t(tag)}</span>
          ))}
        </span>
      </span>
    </button>
  );
}

function DbOption({ label, note, checked, disabled, onClick }: { label: string; note?: string; checked: boolean; disabled?: boolean; onClick: () => void }) {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={checked}
      disabled={disabled}
      onClick={onClick}
      className={cx(
        "flex items-center gap-3 rounded-xl border p-3.5 text-left disabled:opacity-50",
        checked ? "border-accent bg-accent-soft" : "border-line enabled:hover:bg-surface-2",
      )}
    >
      <span className={cx("flex size-4 items-center justify-center rounded-full border-2", checked ? "border-accent" : "border-muted")}>
        {checked && <span className="size-2 rounded-full bg-accent" />}
      </span>
      <span>
        <span className="block font-medium">{label}</span>
        {note && <span className="block text-xs text-muted">{note}</span>}
      </span>
    </button>
  );
}

function CreateModal({ spec, onClose }: { spec: CreateSpec; onClose: () => void }) {
  const { go, refresh } = useApp();
  const [log, setLog] = useState<string[]>([]);
  const [status, setStatus] = useState<"running" | "done" | "error">("running");
  const [error, setError] = useState("");
  const box = useRef<HTMLPreElement>(null);
  const started = useRef(false);

  useEffect(() => {
    if (started.current) return;
    started.current = true;
    onTaskLog((line) => setLog((l) => [...l, line]))
      .then((unlisten) => api.createProject(spec).finally(unlisten))
      .then(() => setStatus("done"))
      .catch((e) => {
        setError(String(e));
        setStatus("error");
      })
      .finally(refresh);
  });

  useEffect(() => {
    box.current?.scrollTo(0, box.current.scrollHeight);
  }, [log]);

  const close = () => status !== "running" && onClose();

  return (
    <Modal
      title={t("Creating project")}
      wide
      onClose={close}
      footer={
        status === "done" ? (
          <>
            <Button onClick={onClose}>{t("Close")}</Button>
            <Button variant="primary" onClick={() => go({ name: "project", path: spec.path })}>{t("Open project")}</Button>
          </>
        ) : (
          <Button disabled={status === "running"} onClick={onClose}>{t("Close")}</Button>
        )
      }
    >
      <div className="flex items-center gap-2 font-medium">
        {status === "running" && <><Loader2 size={16} className="animate-spin text-accent" /> {t("Creating “{name}”…", { name: spec.name })}</>}
        {status === "done" && <><CheckCircle2 size={16} className="text-success" /> {t("Done")}</>}
        {status === "error" && <><XCircle size={16} className="text-danger" /> {t("Couldn't create the project")}</>}
      </div>
      {error && <p className="rounded-md bg-danger/10 p-2.5 text-[13px] whitespace-pre-wrap text-danger select-text">{error}</p>}
      <pre ref={box} className="h-80 overflow-auto rounded-md bg-[#0c0c0c] p-3 font-mono text-xs leading-relaxed whitespace-pre-wrap text-[#cccccc]">
        {log.join("\n") || "…"}
      </pre>
    </Modal>
  );
}
