import { createContext, useContext, useEffect, useId, type ButtonHTMLAttributes, type ReactNode, type SelectHTMLAttributes } from "react";
import { FolderOpen, Loader2, X, type LucideIcon } from "lucide-react";
import { api, type Config, type DbInstance, type Progress, type ProjectType, type Snapshot } from "./api";
import { t } from "./i18n";

export type Page =
  | { name: "dashboard" | "projects" | "services" | "databases" | "logs" | "binaries" }
  | { name: "settings"; tab?: string }
  | { name: "project"; path: string }
  | { name: "new" };

export interface AppCtx {
  snap: Snapshot;
  go: (page: Page) => void;
  refresh: () => Promise<void>;
  run: (key: string, fn: () => Promise<unknown>) => Promise<boolean>;
  busy: Record<string, boolean>;
  progress: Record<string, Progress>;
  toast: (msg: string, ok?: boolean) => void; // ok: a confirmation instead of an error
  setConfig: (patch: Partial<Config>) => Promise<boolean>;
}

export const AppContext = createContext<AppCtx | null>(null);
export const useApp = () => useContext(AppContext)!;

export const cx = (...c: (string | false | null | undefined)[]) => c.filter(Boolean).join(" ");

export const slug = (s: string) =>
  s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/ł/g, "l").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");

export function progressText(p?: Progress) {
  if (!p) return null;
  if (p.stage === "extract") return t("extracting…");
  if (p.stage === "install") return t("installing…");
  const mb = (n = 0) => (n / 1048576).toFixed(1);
  const amount = p.total ? `${Math.floor(((p.done ?? 0) / p.total) * 100)}% · ${mb(p.done)}/${mb(p.total)} MB` : p.done ? `${mb(p.done)} MB` : "";
  if (p.label) return amount ? `${p.label} · ${amount}` : p.label;
  return amount || t("downloading…");
}

export const engineNames = { mysql: "MySQL", mariadb: "MariaDB", postgres: "PostgreSQL" } as const;
export const dbName = (x: Pick<DbInstance, "engine" | "version">) => `${engineNames[x.engine]} ${x.version}`;

export const typeLabels = { laravel: "Laravel", symfony: "Symfony", wordpress: "WordPress", node: "Node.js", python: "Python", custom: "PHP" } as const;

type Variant = "primary" | "default" | "subtle" | "danger";
const variants: Record<Variant, string> = {
  primary: "bg-accent text-on-accent border-transparent hover:bg-accent-hover",
  default: "bg-surface border-line text-fg hover:bg-surface-2",
  subtle: "bg-transparent border-transparent text-fg hover:bg-black/5 dark:hover:bg-white/8",
  danger: "bg-danger text-white dark:text-black border-transparent hover:opacity-90",
};

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant;
  icon?: LucideIcon;
  busy?: boolean;
  size?: "sm" | "md";
}

export function Button({ variant = "default", icon: Icon, busy, size = "md", className, children, disabled, ...rest }: ButtonProps) {
  return (
    <button
      type="button"
      {...rest}
      disabled={disabled || busy}
      className={cx(
        "inline-flex shrink-0 items-center justify-center gap-1.5 rounded-lg border font-medium whitespace-nowrap transition-colors disabled:cursor-default",
        busy ? "cursor-progress" : "disabled:opacity-50",
        size === "sm" ? "h-7 px-2.5 text-[13px]" : "h-9 px-3.5",
        variants[variant],
        className,
      )}
    >
      {busy ? <Loader2 size={15} className="animate-spin" /> : Icon && <Icon size={15} />}
      {children}
    </button>
  );
}

export function IconButton({ icon: Icon, label, ...rest }: { icon: LucideIcon; label: string } & ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      {...rest}
      className="inline-flex size-7 items-center justify-center rounded-md text-muted hover:bg-black/5 hover:text-fg disabled:opacity-40 dark:hover:bg-white/8"
    >
      <Icon size={16} />
    </button>
  );
}

export function Card({ title, actions, className, children }: { title?: ReactNode; actions?: ReactNode; className?: string; children: ReactNode }) {
  return (
    <section className={cx("rounded-xl border border-line bg-surface", className)}>
      {title && (
        <header className="flex items-center justify-between gap-3 px-4 pt-4 pb-2">
          <h2 className="text-[13px] font-semibold tracking-wide text-muted uppercase">{title}</h2>
          {actions && <div className="flex items-center gap-2">{actions}</div>}
        </header>
      )}
      {children}
    </section>
  );
}

const tones = {
  neutral: "bg-idle-soft text-muted",
  accent: "bg-accent-soft text-accent",
  success: "bg-success-soft text-success",
  warning: "bg-warning-soft text-warning",
  danger: "bg-danger-soft text-danger",
};

export function Badge({ tone = "neutral", children }: { tone?: keyof typeof tones; children: ReactNode }) {
  return <span className={cx("inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium whitespace-nowrap", tones[tone])}>{children}</span>;
}

export function StatusDot({ on, label }: { on: boolean; label?: string }) {
  return <span role="img" aria-label={label ?? (on ? t("Running") : t("Stopped"))} className={cx("inline-block size-2 shrink-0 rounded-full", on ? "bg-success" : "bg-muted/40")} />;
}

export type Status = "running" | "stopped" | "missing" | "busy";

const statusStyle: Record<Status, [string, string, string]> = {
  running: ["Running", "bg-success-soft text-success", "bg-success"],
  stopped: ["Stopped", "bg-idle-soft text-muted", "bg-muted/50"],
  missing: ["Not installed", "bg-warning-soft text-warning", "bg-warning"],
  busy: ["Working…", "bg-accent-soft text-accent", "bg-accent animate-pulse"],
};

export function StatusPill({ status, label }: { status: Status; label?: string }) {
  const [text, pill, dot] = statusStyle[status];
  return (
    <span className={cx("inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-xs font-medium whitespace-nowrap", pill)}>
      <span className={cx("size-1.5 rounded-full", dot)} />
      {label ?? t(text)}
    </span>
  );
}

export const serviceStatus = (s: { installed: boolean; running: boolean }, busy?: boolean): Status =>
  busy ? "busy" : !s.installed ? "missing" : s.running ? "running" : "stopped";

export function TypeBadge({ type }: { type: ProjectType }) {
  const color = `var(--c-${type === "custom" ? "php" : type})`;
  return (
    <span
      className="inline-flex items-center rounded-full px-2 py-0.5 text-xs font-semibold whitespace-nowrap"
      style={{ color, background: `color-mix(in srgb, ${color} 13%, transparent)` }}
    >
      {typeLabels[type]}
    </span>
  );
}

export const typeColor = (type: ProjectType) => `var(--c-${type === "custom" ? "php" : type})`;

export function Toggle({ checked, onChange, label, disabled }: { checked: boolean; onChange: (v: boolean) => void; label: string; disabled?: boolean }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={cx(
        "relative inline-flex h-5 w-10 shrink-0 items-center rounded-full border transition-colors disabled:opacity-50",
        checked ? "border-accent bg-accent" : "border-muted bg-transparent",
      )}
    >
      <span className={cx("size-3 rounded-full transition-transform", checked ? "translate-x-[22px] bg-on-accent" : "translate-x-[3px] bg-muted")} />
    </button>
  );
}

export function Field({ label, hint, children }: { label: string; hint?: ReactNode; children: (id: string) => ReactNode }) {
  const id = useId();
  return (
    <div className="space-y-1">
      <label htmlFor={id} className="block text-[13px] font-medium">{label}</label>
      {children(id)}
      {hint && <p className="text-xs text-muted">{hint}</p>}
    </div>
  );
}

/** Docroot relative to `base`, typed or picked with the folder dialog (must stay inside `base`). */
export function DocrootInput({ id, base, value, onChange }: { id: string; base: string; value: string; onChange: (v: string) => void }) {
  const { toast } = useApp();
  const browse = async () => {
    const dir = await api.pickFolder(value ? `${base}\\${value}` : base);
    if (!dir) return;
    const norm = (s: string) => s.replace(/\//g, "\\").replace(/\\+$/, "");
    const root = norm(base);
    const picked = norm(dir).toLowerCase();
    if (picked !== root.toLowerCase() && !picked.startsWith(`${root.toLowerCase()}\\`)) return toast(t("The document root must be inside the project folder."));
    onChange(norm(dir).slice(root.length).replace(/^\\+/, "").replace(/\\/g, "/"));
  };
  return (
    <div className="flex gap-2">
      <input id={id} className="input font-mono text-[13px]" value={value} placeholder={t("(project folder)")} onChange={(e) => onChange(e.target.value)} />
      <Button icon={FolderOpen} onClick={browse}>{t("Choose")}</Button>
    </div>
  );
}

export function Select({ className, children, ...rest }: SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <select {...rest} className={cx("input appearance-auto pr-1", className)}>
      {children}
    </select>
  );
}

export function Modal({ title, onClose, children, footer, wide }: { title: string; onClose: () => void; children: ReactNode; footer?: ReactNode; wide?: boolean }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  return (
    <div className="fixed inset-0 z-40 flex items-center justify-center bg-black/40 p-6" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div role="dialog" aria-modal aria-label={title} className={cx("flex max-h-full w-full flex-col overflow-hidden rounded-xl border border-line bg-surface shadow-2xl", wide ? "max-w-3xl" : "max-w-md")}>
        <div className="flex items-center justify-between px-5 pt-4 pb-2">
          <h2 className="text-base font-semibold">{title}</h2>
          <IconButton icon={X} label={t("Close")} onClick={onClose} />
        </div>
        <div className="space-y-3 overflow-auto px-5 pb-5">{children}</div>
        {footer && <div className="flex justify-end gap-2 border-t border-line bg-surface-2 px-5 py-3">{footer}</div>}
      </div>
    </div>
  );
}

export function PageHeader({ title, subtitle, actions, back }: { title: ReactNode; subtitle?: ReactNode; actions?: ReactNode; back?: ReactNode }) {
  return (
    <div className="mb-6">
      {back}
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div className="min-w-0">
          <h1 className="text-[26px] font-semibold tracking-tight">{title}</h1>
          {subtitle && <p className="mt-1 text-muted">{subtitle}</p>}
        </div>
        {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
      </div>
    </div>
  );
}

export function Empty({ icon: Icon, title, children }: { icon: LucideIcon; title: string; children?: ReactNode }) {
  return (
    <div className="flex flex-col items-center gap-2 px-6 py-12 text-center">
      <Icon size={32} className="text-muted" strokeWidth={1.5} />
      <p className="font-semibold">{title}</p>
      {children && <div className="max-w-md text-muted">{children}</div>}
    </div>
  );
}

export function Notice({ tone = "accent", icon: Icon, children, action }: { tone?: "accent" | "warning" | "danger"; icon: LucideIcon; children: ReactNode; action?: ReactNode }) {
  const color = { accent: "text-accent", warning: "text-warning", danger: "text-danger" }[tone];
  return (
    <div className={cx("flex items-center gap-3 rounded-xl px-4 py-3", { accent: "bg-accent-soft", warning: "bg-warning-soft", danger: "bg-danger-soft" }[tone])}>
      <Icon size={18} className={cx("shrink-0", color)} />
      <div className="min-w-0 flex-1">{children}</div>
      {action}
    </div>
  );
}

export const defaultLabel = (name?: string) => (name ? t("Default — {name}", { name }) : t("Default"));
export const defaultPhp = (snap: Snapshot) => (snap.php.includes(snap.config.default_php) ? snap.config.default_php : snap.php.at(-1));

/** Database server of a project: "" = the default MySQL-compatible server; SQLite for Laravel and Symfony; "none" if allowed. */
export function DatabaseSelect({ id, value, type, none, onChange }: { id: string; value: string; type: ProjectType; none?: boolean; onChange: (db: string) => void }) {
  const { snap } = useApp();
  const def = snap.instances.find((x) => x.family === "mysql" && x.default);
  const known = !value || value === "sqlite" || value === "none" || snap.instances.some((x) => x.id === value);
  return (
    <Select id={id} value={value} onChange={(e) => onChange(e.target.value)}>
      {none && <option value="none">{t("None")}</option>}
      <option value="">{defaultLabel(def && `${dbName(def)} (:${def.port})`)}</option>
      {!known && <option value={value}>{value} — {t("not installed")}</option>}
      {(type === "laravel" || type === "symfony") && <option value="sqlite">SQLite</option>}
      {snap.instances.map((x) => <option key={x.id} value={x.id}>{dbName(x)} (:{x.port})</option>)}
    </Select>
  );
}
