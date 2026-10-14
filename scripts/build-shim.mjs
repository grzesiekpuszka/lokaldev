// Compiles shim/shim.cs (terminal shim) and shim/updater.cs (window-less update installer) into resources/ with the C#
// compiler built into Windows (.NET Framework 4.x).
import { execFileSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import path from "node:path";

const csc = path.join(process.env.WINDIR ?? "C:\\Windows", "Microsoft.NET", "Framework64", "v4.0.30319", "csc.exe");
mkdirSync("resources", { recursive: true });
execFileSync(csc, ["/nologo", "/optimize+", "/target:exe", "/out:resources\\shim.exe", "shim\\shim.cs"], { stdio: "inherit" });
execFileSync(csc, ["/nologo", "/optimize+", "/target:winexe", "/out:resources\\updater.exe", "shim\\updater.cs"], { stdio: "inherit" });
