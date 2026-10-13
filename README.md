# lokaldev

A portable local development environment for Windows. Every project gets its own PHP, Node.js, Python and database versions, and the whole stack lives in one folder: no installer, no Docker, no WSL.

## Features

- **Projects:** Laravel, Symfony, WordPress, Node.js, Python, plain PHP or an empty folder, created from a wizard or imported. Each project gets a `.test` domain with trusted local HTTPS.
- **Web servers:** Apache and Nginx, side by side. Both serve every project.
- **Per-project versions:** PHP, Node.js (via nvm for Windows), Python and the database server are chosen per project.
- **Databases:** MySQL, MariaDB and PostgreSQL in several versions at once, plus SQLite for Laravel and Symfony. Projects' `.env` / `wp-config.php` follow their database automatically.
- **Services:** MongoDB, Redis, Memcached, Mailpit, phpMyAdmin and pgAdmin. The matching PHP extensions are installed for you.
- **Tools:** Git (MinGit), Composer, SQLite CLI, pnpm, Deno and Bun.
- **Database tools:** export and import single databases or everything at once, including Laragon / `mysqldump --all-databases` dumps.
- **Updates:** checks for new lokaldev releases and newer versions of installed binaries, and updates them in place.
- English and Polish interface.

## Requirements

Windows 10 or 11, 64-bit.

## Installation

1. Download `lokaldev-<version>-win-x64.zip` from [Releases](https://github.com/grzesiekpuszka/lokaldev/releases).
2. Unpack it anywhere, for example `D:\lokaldev`, and run `lokaldev.exe`.
3. In **Binaries**, install PHP, a web server and a database.
4. Create a project with **New project**, or import an existing folder.

Starting a web server asks for administrator rights once, to add the projects' domains to the hosts file. **Trust certificate** (Dashboard or Settings → HTTPS) asks once too, so browsers accept the local HTTPS certificates.

## Folders

Everything lives next to `lokaldev.exe`:

| Folder | Contents |
|---|---|
| `www\` | Projects (default projects folder; another one can be chosen in Settings) |
| `databases\` | Database data, one subfolder per server and version (location configurable) |
| `data\` | Binaries, configuration, certificates and logs |

To move or back up your environment, copy the whole folder.

## Default ports

| Service | Port |
|---|---|
| Apache | 80 / 443 |
| Nginx | 8080 / 8443 |
| MySQL / MariaDB | 3306 (other versions: 3307, 3308, …) |
| PostgreSQL | 5432 (other versions: 5433, …) |
| MongoDB | 27017 |
| Redis | 6379 |
| Memcached | 11211 |
| Mailpit | 1025 (SMTP), 8025 (web) |
| phpMyAdmin | 8888 |

All ports can be changed in **Settings → Ports**. Databases use `root` (MySQL/MariaDB) and `postgres` (PostgreSQL) without a password by default. You can change both logins in **Settings → Databases**.

## Terminal

Turn on **Settings → Command line → Add tools to the user PATH** to use `php`, `composer`, `mysql`, `psql`, `python`, `pip`, `git`, `redis-cli`, `mongosh` and other tools in any terminal. Inside a project folder they use that project's versions; elsewhere, the defaults. Node.js versions follow the project's `.nvmrc` through nvm for Windows.

## Updates

lokaldev checks once a day (or on **Settings → Updates → Check now**). A new version is downloaded only after you click **Download and install**. lokaldev then restarts into it and keeps your projects, databases and settings. Installed binaries with a newer release in the same series show an **Update** button in **Binaries**.

## Building from source

Requires Node.js 22+ and pnpm.

```
pnpm install
pnpm dev     # run with hot reload
pnpm dist    # portable build in release\win-unpacked
```

## Reporting problems

lokaldev is in beta. Please report bugs in [Issues](https://github.com/grzesiekpuszka/lokaldev/issues).
