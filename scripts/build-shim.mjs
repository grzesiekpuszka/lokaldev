// Compiles shim/shim.cs into resources/shim.exe with the C# compiler built into Windows (.NET Framework 4.x).
import { execFileSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import path from "node:path";

const csc = path.join(process.env.WINDIR ?? "C:\\Windows", "Microsoft.NET", "Framework64", "v4.0.30319", "csc.exe");
mkdirSync("resources", { recursive: true });
execFileSync(csc, ["/nologo", "/optimize+", "/target:exe", "/out:resources\\shim.exe", "shim\\shim.cs"], { stdio: "inherit" });
