import { version } from "../package.json";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  Database, Download, FolderKanban, LayoutGrid, Loader2, Moon, ScrollText, Server, Settings as SettingsIcon, Sun, X, type LucideIcon,
} from "lucide-react";
import logo from "../resources/icon.svg";
import { api, onProgress, type Config, type Progress, type Snapshot } from "./api";
import { AppContext, StatusDot, cx, type AppCtx, type Page } from "./ui";
import Dashboard from "./pages/Dashboard";
import Projects from "./pages/Projects";
import ProjectDetail from "./pages/ProjectDetail";
import NewProject from "./pages/NewProject";
import Services from "./pages/Services";
import Databases from "./pages/Databases";
import Logs from "./pages/Logs";
import Binaries from "./pages/Binaries";
import Settings from "./pages/Settings";
import { setLang, t } from "./i18n";

const nav: [Page["name"], string, LucideIcon][] = [
  ["dashboard", "Dashboard", LayoutGrid],
  ["projects", "Projects", FolderKanban],
  ["services", "Services", Server],
  ["databases", "Databases", Database],
  ["logs", "Logs", ScrollText],
  ["binaries", "Binaries", Download],
];

const darkQuery = window.matchMedia("(prefers-color-scheme: dark)");

export default function App() {
  const [snap, setSnap] = useState<Snapshot | null>(null);
  const [page, setPage] = useState<Page>({ name: "dashboard" });
  const [busy, setBusy] = useState<Record<string, boolean>>({});
  const [progress, setProgress] = useState<Record<string, Progress>>({});
  const [toasts, setToasts] = useState<{ id: number; msg: string; ok?: boolean }[]>([]);
  const [systemDark, setSystemDark] = useState(darkQuery.matches);
  const lastError = useRef("");

  const toast = useCallback((msg: string, ok?: boolean) => {
    const id = Date.now() + Math.random();
    setToasts((t) => [...t, { id, msg, ok }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), ok ? 3000 : 8000);
  }, []);

  const refresh = useCallback(async () => {
    try {
      setSnap(await api.state());
      lastError.current = "";
    } catch (e) {
      if (String(e) !== lastError.current) toast(String(e));
      lastError.current = String(e);
    }
  }, [toast]);

  const run = useCallback(
    async (key: string, fn: () => Promise<unknown>) => {
      setBusy((b) => ({ ...b, [key]: true }));
      try {
        await fn();
        return true;
      } catch (e) {
        toast(String(e));
        return false;
      } finally {
        setBusy(({ [key]: _, ...b }) => b);
        setProgress(({ [key]: _, ...p }) => p);
        await refresh();
      }
    },
    [refresh, toast],
  );

  useEffect(() => {
    refresh();
    const timer = setInterval(refresh, 4000);
    window.addEventListener("focus", refresh);
    const onScheme = (e: MediaQueryListEvent) => setSystemDark(e.matches);
    darkQuery.addEventListener("change", onScheme);
    const unlisten = onProgress((p) => setProgress((prev) => ({ ...prev, [p.id]: p })));
    return () => {
      clearInterval(timer);
      window.removeEventListener("focus", refresh);
      darkQuery.removeEventListener("change", onScheme);
      unlisten.then((f) => f()).catch(() => {});
    };
  }, [refresh]);

  const theme = snap?.config.theme ?? "system";
  const dark = theme === "dark" || (theme === "system" && systemDark);
  useEffect(() => {
    document.documentElement.classList.toggle("dark", dark);
  }, [dark]);

  const go = useCallback((p: Page) => {
    setPage(p);
    document.querySelector("main")?.scrollTo(0, 0);
  }, []);

  if (snap) setLang(snap.config.language);

  const toastView = (
    <div className="fixed right-4 bottom-4 z-50 flex w-96 flex-col gap-2" aria-live="polite">
      {toasts.map((item) => (
        <div key={item.id} role={item.ok ? "status" : "alert"} className={cx("flex items-start gap-2 rounded-lg border border-line border-l-4 bg-surface px-3 py-2.5 shadow-lg", item.ok ? "border-l-success" : "border-l-danger")}>
          <p className="flex-1 text-[13px] break-words whitespace-pre-wrap select-text">{item.msg}</p>
          <button type="button" aria-label={t("Close")} className="text-muted hover:text-fg" onClick={() => setToasts((x) => x.filter((y) => y.id !== item.id))}>
            <X size={14} />
          </button>
        </div>
      ))}
    </div>
  );

  if (!snap)
    return (
      <div className="flex h-full items-center justify-center gap-2 text-muted">
        <Loader2 className="animate-spin" size={18} /> {t("Loading…")}
        {toastView}
      </div>
    );

  const setConfig = (patch: Partial<Config>) => run("config", () => api.setConfig(patch));
  const ctx: AppCtx = { snap, go, refresh, run, busy, progress, toast, setConfig };
  const active = page.name === "project" ? "projects" : page.name;

  return (
    <AppContext.Provider value={ctx}>
      <div className="flex h-full">
        <aside className="flex w-56 shrink-0 flex-col">
          <div className="flex items-center gap-2.5 px-5 pt-6 pb-5">
            <img src={logo} alt="" className="size-8" />
            <span className="text-[17px] font-semibold tracking-tight">lokal<span className="text-muted">dev</span></span>
          </div>
          <nav className="flex-1 space-y-0.5 overflow-auto px-3">
            {nav.map(([name, label, Icon]) => (
              <NavItem key={name} icon={Icon} label={t(label)} active={active === name} badge={name === "binaries" ? Object.keys(snap.updates.binaries).length : 0} onClick={() => go({ name } as Page)} />
            ))}
            <NavItem icon={SettingsIcon} label={t("Settings")} active={active === "settings"} onClick={() => go({ name: "settings" })} />
          </nav>
          <button
            type="button"
            onClick={() => go({ name: "services" })}
            className="mx-3 mb-2 space-y-1.5 rounded-xl px-3 py-2.5 text-left hover:bg-black/4 dark:hover:bg-white/5"
          >
            {snap.services.filter((x) => x.installed).map((x) => (
              <span key={x.id} className="flex items-center gap-2 text-xs">
                <StatusDot on={x.running} />
                <span className={cx("truncate", x.running ? "text-fg" : "text-muted")}>{x.name}</span>
              </span>
            ))}
            {!snap.services.some((x) => x.installed) && <span className="text-xs text-muted">{t("No services installed")}</span>}
          </button>
          <div className="flex items-center justify-between px-5 pb-4 text-xs text-muted">
            <span>v{version}</span>
            <button
              type="button"
              aria-label={dark ? t("Light mode") : t("Dark mode")}
              title={dark ? t("Light mode") : t("Dark mode")}
              className="rounded-md p-1.5 hover:bg-black/5 hover:text-fg dark:hover:bg-white/8"
              onClick={() => setConfig({ theme: dark ? "light" : "dark" })}
            >
              {dark ? <Sun size={15} /> : <Moon size={15} />}
            </button>
          </div>
        </aside>
        <main className="my-2 mr-2 flex-1 overflow-auto rounded-2xl border border-line bg-surface">
          <div className="mx-auto max-w-6xl px-10 py-8">
            {page.name === "dashboard" && <Dashboard />}
            {page.name === "projects" && <Projects />}
            {page.name === "project" && <ProjectDetail key={page.path} path={page.path} />}
            {page.name === "new" && <NewProject />}
            {page.name === "services" && <Services />}
            {page.name === "databases" && <Databases />}
            {page.name === "logs" && <Logs />}
            {page.name === "binaries" && <Binaries />}
            {page.name === "settings" && <Settings key={page.tab} tab={page.tab} />}
          </div>
        </main>
      </div>
      {toastView}
    </AppContext.Provider>
  );
}

function NavItem({ icon: Icon, label, active, badge, onClick }: { icon: LucideIcon; label: string; active?: boolean; badge?: number; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-current={active ? "page" : undefined}
      className={cx(
        "flex h-9 w-full items-center gap-3 rounded-lg px-3 text-left transition-colors",
        active ? "bg-surface font-medium shadow-[0_1px_3px_rgba(0,0,0,0.06)] ring-1 ring-line" : "text-muted hover:bg-black/4 hover:text-fg dark:hover:bg-white/5",
      )}
    >
      <Icon size={17} className={active ? "text-accent" : undefined} />
      <span className="flex-1">{label}</span>
      {!!badge && <span className="rounded-full bg-accent px-1.5 text-[11px] leading-[18px] font-semibold text-white" title={t("Updates available")}>{badge}</span>}
    </button>
  );
}
