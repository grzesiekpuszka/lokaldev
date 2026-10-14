import { app, Menu, Tray } from "electron";
import path from "node:path";
import { t } from "../src/i18n";
import { ROOT } from "./util";

export interface TrayActions {
  show: () => void;
  startAll: () => void;
  stopAll: () => void;
  phpMyAdmin: () => void;
  pgAdmin: () => void;
  installed: (id: "phpmyadmin" | "pgadmin") => boolean;
  quit: () => void;
  status: () => string;
}

const icon = app.isPackaged ? path.join(process.resourcesPath, "icon.ico") : path.join(ROOT, "resources", "icon.ico");
let tray: Tray | undefined;

/** Notification-area icon: left click opens the window, right click shows the quick actions. */
export function createTray(a: TrayActions) {
  tray = new Tray(icon);
  tray.setToolTip("lokaldev");
  tray.on("click", a.show);
  tray.on("right-click", () => {
    tray!.setToolTip(`lokaldev · ${a.status()}`);
    tray!.popUpContextMenu(
      Menu.buildFromTemplate([
        { label: t("Open lokaldev"), click: a.show },
        { label: a.status(), enabled: false },
        { type: "separator" },
        { label: t("Start all"), click: a.startAll },
        { label: t("Stop all"), click: a.stopAll },
        { type: "separator" },
        { label: "phpMyAdmin", click: a.phpMyAdmin, visible: a.installed("phpmyadmin") },
        { label: "pgAdmin", click: a.pgAdmin, visible: a.installed("pgadmin") },
        { type: "separator", visible: a.installed("phpmyadmin") || a.installed("pgadmin") },
        { label: t("Quit"), click: a.quit },
      ]),
    );
  });
}

/**
 * Messages go through the tray icon instead of Electron notifications: a toast left in the
 * notification center outlives the app and clicking it relaunches lokaldev after it was quit.
 */
export function balloon(content: string) {
  tray?.displayBalloon({ title: "lokaldev", content, iconType: "none", noSound: true });
}

export function destroyTray() {
  tray?.removeBalloon();
  tray?.destroy();
  tray = undefined;
}

/** The same actions in the taskbar icon's jump list; they reach the running instance as command-line flags. */
export function setJumpList() {
  if (!app.isPackaged) return;
  const task = (flag: string, title: string) => ({
    program: process.execPath,
    arguments: flag,
    iconPath: process.execPath,
    iconIndex: 0,
    title: t(title),
    description: t(title),
  });
  app.setUserTasks([task("--start-all", "Start all"), task("--stop-all", "Stop all"), task("--quit", "Quit")]);
}
