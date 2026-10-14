import { useCallback, useEffect, useRef, useState } from "react";
import { Eraser, FileText, RefreshCw, ScrollText } from "lucide-react";
import { api } from "../api";
import { Button, Card, Empty, PageHeader, Toggle, cx, useApp } from "../ui";
import { t } from "../i18n";

export default function Logs() {
  const { run, busy, toast } = useApp();
  const [files, setFiles] = useState<string[]>([]);
  const [current, setCurrent] = useState("");
  const [text, setText] = useState("");
  const [auto, setAuto] = useState(false);
  const view = useRef<HTMLPreElement>(null);

  // the list is refreshed too: a service started for the first time adds its log
  const loadFiles = useCallback(() => {
    api.logs().then((l) => {
      setFiles(l);
      setCurrent((c) => (l.includes(c) ? c : l[0] || ""));
    }, (e) => toast(String(e)));
  }, [toast]);
  useEffect(loadFiles, [loadFiles]);

  const load = useCallback(() => {
    loadFiles();
    if (current) api.logRead(current).then(setText, (e) => toast(String(e)));
  }, [current, loadFiles, toast]);

  useEffect(load, [load]);
  useEffect(() => {
    if (!auto) return;
    const timer = setInterval(load, 2000);
    return () => clearInterval(timer);
  }, [auto, load]);
  useEffect(() => {
    view.current?.scrollTo(0, view.current.scrollHeight);
  }, [text]);

  return (
    <>
      <PageHeader title={t("Logs")} subtitle={t("Service and task logs")} />
      {!files.length ? (
        <Card>
          <Empty icon={ScrollText} title={t("No log files")}>
            <Button size="sm" icon={RefreshCw} onClick={loadFiles}>{t("Refresh")}</Button>
          </Empty>
        </Card>
      ) : (
        <div className="grid h-[calc(100vh-170px)] min-h-80 grid-cols-[220px_1fr] gap-3">
          <Card className="overflow-auto p-1.5">
            {files.map((f) => (
              <button
                key={f}
                type="button"
                onClick={() => setCurrent(f)}
                aria-current={f === current}
                className={cx("flex w-full items-center gap-2 rounded-md px-2.5 py-1.5 text-left text-[13px]", f === current ? "bg-accent-soft text-accent" : "hover:bg-surface-2")}
              >
                <FileText size={14} className="shrink-0" />
                <span className="truncate">{f}</span>
              </button>
            ))}
          </Card>
          <Card className="flex min-w-0 flex-col overflow-hidden">
            <div className="flex items-center gap-2 border-b border-line px-3 py-2">
              <span className="flex-1 truncate font-medium">{current}</span>
              <label className="flex items-center gap-2 text-[13px] text-muted">
                {t("Auto-refresh")}
                <Toggle label={t("Auto-refresh")} checked={auto} onChange={setAuto} />
              </label>
              <Button size="sm" icon={RefreshCw} onClick={load}>{t("Refresh")}</Button>
              <Button size="sm" icon={Eraser} busy={busy.logClear} onClick={() => run("logClear", () => api.logClear(current)).then(load)}>{t("Clear")}</Button>
            </div>
            <pre ref={view} className="flex-1 overflow-auto bg-surface-2 p-3 font-mono text-xs leading-relaxed whitespace-pre-wrap">
              {text || <span className="text-muted">{t("(empty)")}</span>}
            </pre>
          </Card>
        </div>
      )}
    </>
  );
}
