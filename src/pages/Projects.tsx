import { useState } from "react";
import { ExternalLink, FolderInput, FolderKanban, FolderOpen, Info, Lock, Plus, RefreshCw, Search, SquareTerminal } from "lucide-react";
import { api, type ProjectType, proxied } from "../api";
import { Button, Card, Empty, IconButton, PageHeader, Select, TypeBadge, typeLabels, useApp } from "../ui";
import ImportProject from "./ImportProject";
import { plural, t } from "../i18n";

export default function Projects() {
  const { snap, go, run, refresh, setConfig } = useApp();
  const [query, setQuery] = useState("");
  const [type, setType] = useState<ProjectType | "">("");
  const [importDir, setImportDir] = useState<string>();

  const pick = async () => {
    const dir = await api.pickFolder();
    return dir;
  };

  const q = query.toLowerCase();
  const list = snap.projects.filter((p) => (!type || p.type === type) && (p.name.toLowerCase().includes(q) || p.domain.includes(q)));

  return (
    <>
      <PageHeader
        title={t("Projects")}
        subtitle={plural(snap.projects.length, "{n} project", "{n} projects")}
        actions={
          <>
            <Button icon={FolderInput} onClick={async () => { const dir = await pick(); if (dir) setImportDir(dir); }}>{t("Import")}</Button>
            <Button icon={RefreshCw} onClick={refresh}>{t("Refresh")}</Button>
            <Button variant="primary" icon={Plus} onClick={() => go({ name: "new" })}>{t("New project")}</Button>
          </>
        }
      />

      <div className="mb-4 flex items-center gap-3 rounded-xl bg-surface-2 px-4 py-2.5">
        <FolderOpen size={16} className="text-muted" />
        <span className="text-muted">{t("Projects folder")}:</span>
        <span className="min-w-0 flex-1 truncate font-mono text-[13px]">{snap.config.projects_dir || t("not selected")}</span>
        <Button size="sm" onClick={async () => { const dir = await pick(); if (dir) setConfig({ projects_dir: dir }); }}>{t("Change")}</Button>
      </div>

      <div className="mb-4 flex gap-3">
        <div className="relative flex-1">
          <Search size={15} className="absolute top-2 left-2.5 text-muted" />
          <input className="input pl-8" placeholder={t("Search projects…")} aria-label={t("Search projects")} value={query} onChange={(e) => setQuery(e.target.value)} />
        </div>
        <Select className="w-44" aria-label={t("Project type")} value={type} onChange={(e) => setType(e.target.value as ProjectType | "")}>
          <option value="">{t("All types")}</option>
          {Object.entries(typeLabels).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
        </Select>
      </div>

      <Card>
        {list.length === 0 ? (
          <Empty icon={FolderKanban} title={snap.projects.length ? t("No results") : t("No projects")}>
            {!snap.projects.length && t("Create a new project or import an existing folder.")}
          </Empty>
        ) : (
          <table className="w-full text-left">
            <thead className="border-b border-line text-[13px] text-muted">
              <tr>
                <th className="px-4 py-2 font-medium">{t("Name")}</th>
                <th className="px-2 py-2 font-medium">{t("Type")}</th>
                <th className="px-2 py-2 font-medium">PHP</th>
                <th className="px-2 py-2 font-medium">Node</th>
                <th className="px-2 py-2 font-medium">{t("Domain")}</th>
                <th className="px-4 py-2" />
              </tr>
            </thead>
            <tbody className="divide-y divide-line">
              {list.map((p) => (
                <tr key={p.path} className="cursor-pointer hover:bg-surface-2" onClick={() => go({ name: "project", path: p.path })}>
                  <td className="max-w-0 px-4 py-2 w-[38%]">
                    <p className="truncate font-medium">{p.name}</p>
                    <p className="truncate text-xs text-muted">{p.path}</p>
                  </td>
                  <td className="px-2"><TypeBadge type={p.type} /></td>
                  <td className="px-2 text-[13px]">{proxied(p.type) ? "—" : p.php || "—"}</td>
                  <td className="px-2 text-[13px]">{p.node || "—"}</td>
                  <td className="px-2">
                    <button type="button" className="inline-flex items-center gap-1 text-accent hover:underline" onClick={(e) => { e.stopPropagation(); run("open", () => api.openUrl(p.url)); }}>
                      {p.ssl && <Lock size={12} aria-label="HTTPS" />}
                      {p.domain}
                    </button>
                  </td>
                  <td className="px-4" onClick={(e) => e.stopPropagation()}>
                    <div className="flex justify-end gap-0.5">
                      <IconButton icon={ExternalLink} label={t("Open in browser")} onClick={() => run("open", () => api.openUrl(p.url))} />
                      <IconButton icon={FolderOpen} label="Folder" onClick={() => run("open", () => api.openDir(p.path))} />
                      <IconButton icon={SquareTerminal} label="Terminal" onClick={() => run("open", () => api.openTerminal(p.path))} />
                      <IconButton icon={Info} label={t("Details")} onClick={() => go({ name: "project", path: p.path })} />
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>
      {importDir && <ImportProject dir={importDir} onClose={() => setImportDir(undefined)} />}
    </>
  );
}
