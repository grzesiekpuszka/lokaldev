import { spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { CreateSpec } from "../src/api";
import { config, defaultPhp, norm, port, saveConfig } from "./config";
import { instance, projectInstanceId } from "./instances";
import { wanted } from "./dbauth";
import { envValue, password, phpString, serverVersion, setEnv, urlLogin, user } from "./projectdb";
import { dbCreate } from "./db";
import { download, extract } from "./install";
import { freshPath } from "./env";
import { pinNode } from "./node";
import { startInstance } from "./services";
import { emit, exists, p } from "./util";
import { binDir } from "./versions";
import { t } from "../src/i18n";

const log = (line: string) => emit("task-log", line);

/** Runs a command and streams its output to the wizard's log window. */
function stream(file: string, args: string[], cwd: string, env: NodeJS.ProcessEnv) {
  log(`> ${[path.basename(file), ...args].join(" ")}`);
  return new Promise<void>((resolve, reject) => {
    const c = spawn(file, args, { cwd, env, windowsHide: true });
    const lines = (d: Buffer) => d.toString().split(/\r?\n|\r/).filter((l) => l.trim()).forEach(log);
    c.stdout.on("data", lines);
    c.stderr.on("data", lines);
    c.on("error", reject);
    c.on("exit", (code) => (code ? reject(new Error(t("Command exited with code {code}", { code }))) : resolve()));
  });
}

export async function createProject(spec: CreateSpec) {
  const dir = norm(spec.path);
  if (!spec.name.trim()) throw new Error(t("Enter a project name"));
  if (spec.import) {
    if (!exists(dir)) throw new Error(t("The folder doesn't exist"));
  } else if (exists(dir) && fs.readdirSync(dir).length) {
    throw new Error(t("The target folder isn't empty"));
  }

  const phpDir = p("bin", "php", spec.php || defaultPhp());
  const phpExe = path.join(phpDir, "php.exe");
  const phar = path.join(binDir("composer"), "composer.phar");
  // composer and npm need git for some packages
  const env = { ...process.env, PATH: `${phpDir};${path.join(binDir("git"), "cmd")};${await freshPath()}`, COMPOSER_NO_INTERACTION: "1" };
  const composer = (args: string[], cwd: string) => {
    if (!exists(phar)) throw new Error(t("Composer isn't installed (Binaries → Tools)"));
    return stream(phpExe, [phar, ...args], cwd, env);
  };
  const npm = (cmd: string) => stream("cmd.exe", ["/d", "/s", "/c", cmd], dir, env);

  const sqlite = spec.database === "sqlite";
  const target = spec.database === "none" || sqlite ? null : instance(projectInstanceId(spec.database) ?? "");
  if (spec.database && spec.database !== "none" && !sqlite && !target) throw new Error(t("{name} isn't installed", { name: spec.database }));
  const inst = spec.import ? null : target; // an imported project gets its database after it's saved (main.ts)
  if (inst) {
    log(t("Starting the database…"));
    await startInstance(inst.id);
    log(t("Creating database {name}…", { name: spec.db_name }));
    await dbCreate(inst.id, spec.db_name);
  }

  if (!spec.import) {
    fs.mkdirSync(path.dirname(dir), { recursive: true });
    const dbEnv: Record<string, string> = inst
      ? {
          DB_CONNECTION: inst.engine === "postgres" ? "pgsql" : inst.engine,
          DB_HOST: "127.0.0.1",
          DB_PORT: String(inst.port),
          DB_DATABASE: spec.db_name,
          DB_USERNAME: envValue(user(inst)),
          DB_PASSWORD: envValue(password(inst)),
        }
      : {};
    const url = `${spec.ssl ? "https" : "http"}://${spec.domain}`;

    switch (spec.type) {
      case "laravel":
        await composer(["create-project", "laravel/laravel", dir, "--prefer-dist", "--no-interaction"], path.dirname(dir));
        setEnv(path.join(dir, ".env"), {
          APP_NAME: JSON.stringify(spec.name),
          APP_URL: url,
          ...dbEnv,
          MAIL_MAILER: "smtp",
          MAIL_HOST: "127.0.0.1",
          MAIL_PORT: String(port("mailpit_smtp")),
        });
        // Laravel's skeleton already uses SQLite (database/database.sqlite)
        if (sqlite) setEnv(path.join(dir, ".env"), { DB_CONNECTION: "sqlite" });
        if (inst || sqlite) await stream(phpExe, ["artisan", "migrate", "--force"], dir, env);
        break;
      case "symfony":
        await composer(["create-project", "symfony/skeleton", dir, "--prefer-dist", "--no-interaction"], path.dirname(dir));
        if (spec.install_deps) await composer(["require", "webapp", "--no-interaction"], dir);
        setEnv(path.join(dir, ".env"), {
          MAILER_DSN: `smtp://127.0.0.1:${port("mailpit_smtp")}`,
          ...(sqlite ? { DATABASE_URL: `"sqlite:///%kernel.project_dir%/var/data.db"` } : {}),
          ...(inst
            ? {
                DATABASE_URL: `"${inst.family === "postgres" ? "postgresql" : "mysql"}://${urlLogin(inst)}@127.0.0.1:${inst.port}/${spec.db_name}?serverVersion=${serverVersion(inst)}&charset=utf8mb4"`,
              }
            : {}),
        });
        break;
      case "wordpress": {
        log(t("Downloading WordPress…"));
        const zip = p("tmp", "wordpress.zip");
        await download("https://wordpress.org/latest.zip", zip, "wordpress");
        await extract(zip, dir, "wp-load.php");
        fs.rmSync(zip, { force: true });
        let wp = fs.readFileSync(path.join(dir, "wp-config-sample.php"), "utf8")
          .replace("'database_name_here'", () => phpString(spec.db_name || "wordpress"))
          .replace("'username_here'", () => phpString(wanted("mysql").user))
          .replace("'password_here'", () => phpString(wanted("mysql").password))
          .replace("'localhost'", `'127.0.0.1:${inst?.port ?? port("mysql")}'`);
        wp = wp.replace(/put your unique phrase here/g, () => crypto.randomBytes(48).toString("base64url"));
        fs.writeFileSync(path.join(dir, "wp-config.php"), wp);
        break;
      }
      case "node":
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(
          path.join(dir, "package.json"),
          JSON.stringify(
            { name: path.basename(dir).toLowerCase(), private: true, scripts: { dev: "node --watch index.js", start: "node index.js" } },
            null,
            2,
          ),
        );
        fs.writeFileSync(
          path.join(dir, "index.js"),
          `const http = require("node:http");\nconst port = process.env.PORT || ${spec.node_port};\n\nhttp\n  .createServer((req, res) => res.end("Hello from ${spec.name}"))\n  .listen(port, () => console.log(\`Listening on \${port}\`));\n`,
        );
        break;
      case "python":
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(path.join(dir, "requirements.txt"), "");
        fs.writeFileSync(
          path.join(dir, "app.py"),
          `import os
from http.server import BaseHTTPRequestHandler, HTTPServer


class Handler(BaseHTTPRequestHandler):
    def do_GET(self):
        self.send_response(200)
        self.send_header("Content-Type", "text/plain; charset=utf-8")
        self.end_headers()
        self.wfile.write(b"Hello from ${spec.name.replace(/[\\"]/g, "")}")


port = int(os.environ.get("PORT", ${spec.node_port}))
print(f"Listening on {port}", flush=True)
HTTPServer(("127.0.0.1", port), Handler).serve_forever()
`,
        );
        if (spec.install_deps) {
          const python = path.join(spec.python ? p("bin", "python", spec.python) : binDir("python"), "python.exe");
          if (!exists(python)) throw new Error(t("{name} isn't installed", { name: "Python" }));
          await stream(python, ["-m", "venv", ".venv"], dir, env);
        }
        break;
      case "empty":
        fs.mkdirSync(dir, { recursive: true });
        break;
      default:
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(path.join(dir, "index.php"), "<?php\n\nphpinfo();\n");
    }
  }
  if (spec.node) pinNode(dir, spec.node);
  if (!spec.import && spec.install_deps && spec.type === "laravel") await npm("npm install");

  const latest = config();
  const inDir = latest.projects_dir && path.dirname(dir).toLowerCase() === norm(latest.projects_dir).toLowerCase();
  saveConfig({
    ...latest,
    imported: inDir || latest.imported.some((x) => norm(x) === dir) ? latest.imported : [...latest.imported, dir],
    projects: {
      ...latest.projects,
      [dir]: {
        type: spec.type === "empty" ? "custom" : spec.type,
        php: spec.php || undefined,
        domain: spec.domain,
        ssl: spec.ssl,
        docroot: spec.import ? spec.docroot : spec.docroot || undefined,
        node_port: spec.type === "node" || spec.type === "python" ? spec.node_port : undefined,
        node_cmd: spec.type === "node" || spec.type === "python" ? spec.node_cmd : undefined,
        python: spec.python || undefined,
        // the default MySQL-compatible server is implied; anything else is pinned
        db: sqlite ? "sqlite" : target && !(target.default && target.family === "mysql") ? target.id : undefined,
        db_name: target ? spec.db_name : undefined,
      },
    },
  });
  log(t("Project created."));
}
