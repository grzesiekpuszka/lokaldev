import { useEffect, useState } from "react";
import { FolderInput, Loader2 } from "lucide-react";
import { api, type ProjectType, proxied } from "../api";
import { Button, DocrootInput, Field, Modal, Select, Toggle, slug, typeLabels, useApp } from "../ui";
import { t } from "../i18n";

export default function ImportProject({ dir, onClose }: { dir: string; onClose: () => void }) {
  const { snap, go, run, busy, toast } = useApp();
  const { config } = snap;
  const [type, setType] = useState<ProjectType>();
  const [domain, setDomain] = useState("");
  const [docroot, setDocroot] = useState("");
  const [php, setPhp] = useState(snap.php.includes(config.default_php) ? config.default_php : (snap.php.at(-1) ?? ""));
  const [node, setNode] = useState("");
  const [ssl, setSsl] = useState(config.ssl_default);
  const [nodePort, setNodePort] = useState(3000);
  const [nodeCmd, setNodeCmd] = useState("npm run dev");

  useEffect(() => {
    api
      .detectProject(dir)
      .then((d) => {
        setType(d.type);
        setDocroot(d.docroot);
        setDomain(`${slug(d.name)}.${config.tld}`);
      })
      .catch((e) => (toast(String(e)), onClose()));
  }, [dir]);

  // another document root may hold another kind of app (e.g. WordPress in public_html)
  const changeDocroot = (value: string) => {
    setDocroot(value);
    api.detectProject(dir, value).then((d) => setType(d.type), () => {});
  };

  const isNode = !!type && proxied(type);
  const valid = !!type && /^[a-z0-9.-]+$/i.test(domain) && (isNode || !!php);

  const submit = () =>
    run("import", async () => {
      await api.createProject({
        type: type!,
        name: dir.split(/[\\/]/).filter(Boolean).pop() ?? "",
        path: dir,
        import: true,
        php: isNode ? "" : php,
        node,
        python: "",
        database: "none",
        db_name: "",
        domain,
        ssl,
        docroot,
        node_port: nodePort,
        node_cmd: nodeCmd,
        install_deps: false,
      });
      onClose();
      go({ name: "project", path: dir });
    });

  return (
    <Modal
      title={t("Import project")}
      wide
      onClose={onClose}
      footer={
        <>
          <Button onClick={onClose}>{t("Cancel")}</Button>
          <Button variant="primary" icon={FolderInput} busy={busy.import} disabled={!valid} onClick={submit}>{t("Import project")}</Button>
        </>
      }
    >
      {!type ? (
        <p className="flex items-center gap-2 py-6 text-muted"><Loader2 size={16} className="animate-spin" /> {t("Detecting project…")}</p>
      ) : (
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label={t("Path")}>{(id) => <input id={id} className="input font-mono text-[13px]" value={dir} readOnly />}</Field>
          <Field label={t("Type")}>
            {(id) => (
              <Select id={id} value={type} onChange={(e) => setType(e.target.value as ProjectType)}>
                {Object.entries(typeLabels).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
              </Select>
            )}
          </Field>
          <Field label={t("Domain")} hint={t("Defaults to the folder name.")}>
            {(id) => <input id={id} className="input" value={domain} onChange={(e) => setDomain(e.target.value.trim())} />}
          </Field>
          {!isNode && (
            <Field label={t("Document root")} hint={t("Folder served by the web server, e.g. public_html.")}>
              {(id) => <DocrootInput id={id} base={dir} value={docroot} onChange={changeDocroot} />}
            </Field>
          )}
          {!isNode && (
            <Field label={t("PHP version")}>
              {(id) => (
                <Select id={id} value={php} onChange={(e) => setPhp(e.target.value)}>
                  <option value="none">{t("none")}</option>
                  {snap.php.map((v) => <option key={v} value={v}>PHP {v}</option>)}
                </Select>
              )}
            </Field>
          )}
          <Field label={t("Node.js version")}>
            {(id) => (
              <Select id={id} value={node} disabled={snap.node.nvm !== "ok"} onChange={(e) => setNode(e.target.value)}>
                <option value="">{t("none")}</option>
                {snap.node.installed.map((v) => <option key={v} value={v}>{v}</option>)}
              </Select>
            )}
          </Field>
          {isNode && (
            <>
              <Field label={t("App port")}>
                {(id) => <input id={id} type="number" min={1} max={65535} className="input" value={nodePort} onChange={(e) => setNodePort(Number(e.target.value))} />}
              </Field>
              <Field label={t("Start command")}>{(id) => <input id={id} className="input font-mono" value={nodeCmd} onChange={(e) => setNodeCmd(e.target.value)} />}</Field>
            </>
          )}
          <div className="flex items-center gap-3 sm:col-span-2">
            <Toggle label="HTTPS (SSL)" checked={ssl} onChange={setSsl} />
            <span>HTTPS (SSL)</span>
          </div>
        </div>
      )}
    </Modal>
  );
}
