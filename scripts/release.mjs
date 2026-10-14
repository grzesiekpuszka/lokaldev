// pnpm release [notes.md]: builds, zips release/win-unpacked and publishes it as a GitHub release (needs GITHUB_TOKEN).
// The release is created as a draft and published only after both files are uploaded, so the app never sees half a
// release. Running it again after a failure continues with the same tag and draft.
import { execFileSync, execSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const REPO = "grzesiekpuszka/lokaldev";
const token = process.env.GITHUB_TOKEN;
if (!token) throw new Error("Set GITHUB_TOKEN (a token with Contents: read and write for the repository).");

const git = (...args) => execFileSync("git", args, { encoding: "utf8" }).trim();
const { version } = JSON.parse(fs.readFileSync("package.json", "utf8"));
const tag = `v${version}`;
if (git("status", "--porcelain")) throw new Error("Commit or stash the changes first.");
// an existing tag is only fine on this very commit (a retry); never move it
if (git("tag", "-l", tag) && git("rev-parse", `${tag}^{commit}`) !== git("rev-parse", "HEAD")) {
  throw new Error(`${tag} already exists on another commit — bump the version in package.json.`);
}

const headers = { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json", "User-Agent": "lokaldev-release" };
const api = async (url, init = {}) => {
  const res = await fetch(url.startsWith("https://") ? url : `https://api.github.com/repos/${REPO}${url}`, { ...init, headers: { ...headers, ...init.headers } });
  if (!res.ok) throw new Error(`${init.method ?? "GET"} ${url}: HTTP ${res.status} ${await res.text()}`);
  return res.status === 204 ? null : res.json();
};
// drafts aren't found by tag, only in the list
let release = (await api("/releases?per_page=50")).find((r) => r.tag_name === tag);
if (release && !release.draft) throw new Error(`${tag} is already published: ${release.html_url}`);

// the first build right after quitting the app may hit locked files
try {
  execSync("pnpm dist", { stdio: "inherit" });
} catch {
  execSync("pnpm dist", { stdio: "inherit" });
}

const dir = path.join("release", "win-unpacked");
// data, projects and databases of a local test run are not part of the package
const entries = fs.readdirSync(dir).filter((name) => !["data", "www", "databases"].includes(name));
const name = `lokaldev-${version}-win-x64.zip`;
const zip = path.join("release", name);
fs.rmSync(zip, { force: true });
const tar = path.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "tar.exe");
execFileSync(tar, ["-a", "-c", "-f", zip, "-C", dir, ...entries], { stdio: "inherit" });
const hash = crypto.createHash("sha256").update(fs.readFileSync(zip)).digest("hex");
fs.writeFileSync(`${zip}.sha256`, `${hash}  ${name}\n`);

// notes: the given file, else notes/v<version>.md, else the commit subjects since the previous tag
const notesFile = process.argv[2] ?? (fs.existsSync(`notes/${tag}.md`) ? `notes/${tag}.md` : null);
let notes = notesFile && fs.readFileSync(notesFile, "utf8");
if (!notes) {
  let previous = "";
  try {
    previous = git("describe", "--tags", "--abbrev=0", "HEAD^");
  } catch {} // first release
  notes = git("log", "--no-merges", "--pretty=format:- %s", previous ? `${previous}..HEAD` : "HEAD");
}

if (!git("tag", "-l", tag)) git("tag", tag);
execFileSync("git", ["push", "origin", "HEAD", tag], { stdio: "inherit" });

const body = JSON.stringify({ tag_name: tag, name: `lokaldev ${version}`, body: notes, draft: true });
release = release ? await api(`/releases/${release.id}`, { method: "PATCH", body }) : await api("/releases", { method: "POST", body });
const upload = release.upload_url.replace(/\{.*$/, "");
for (const [file, type] of [[zip, "application/zip"], [`${zip}.sha256`, "text/plain"]]) {
  // a retry replaces what a failed run uploaded
  const old = release.assets.find((a) => a.name === path.basename(file));
  if (old) await api(`/releases/assets/${old.id}`, { method: "DELETE" });
  const asset = await api(`${upload}?name=${encodeURIComponent(path.basename(file))}`, { method: "POST", headers: { "Content-Type": type }, body: fs.readFileSync(file) });
  if (asset.size !== fs.statSync(file).size) throw new Error(`Uploading ${path.basename(file)} is incomplete — run pnpm release again.`);
}
release = await api(`/releases/${release.id}`, { method: "PATCH", body: JSON.stringify({ draft: false, make_latest: "true" }) });
// the published zip is the package; the local build isn't used for anything else
fs.rmSync("release", { recursive: true, force: true });
console.log(`Published ${release.html_url}`);
