// Copied as php.exe, composer.exe, mysql.exe, ... into data\shims. Picks the binary for the
// project containing the current directory (longest prefix in shims.txt), else the default.
// Built with the C# 5 compiler that ships with Windows: scripts/build-shim.mjs
using System;
using System.Diagnostics;
using System.IO;

static class Shim
{
    static int Main()
    {
        string exe = Process.GetCurrentProcess().MainModule.FileName;
        string dir = Path.GetDirectoryName(exe);
        string tool = Path.GetFileNameWithoutExtension(exe).ToLowerInvariant();
        string map = Path.Combine(dir, "shims.txt");
        string[] lines = File.Exists(map) ? File.ReadAllLines(map) : new string[0];
        string cwd = (Environment.CurrentDirectory.TrimEnd('\\') + "\\").ToLowerInvariant();

        // kind = shims.txt key: php, db (MySQL/MariaDB clients), pg (PostgreSQL clients), else the tool itself (httpd, nginx, mailpit)
        string kind = tool;
        if (tool == "php" || tool == "composer" || tool == "wp") kind = "php";
        else if (tool.StartsWith("mysql") || tool.StartsWith("mariadb")) kind = "db";
        else if (tool == "psql" || tool.StartsWith("pg_") || tool == "createdb" || tool == "dropdb") kind = "pg";

        string bin = Resolve(lines, kind, cwd);
        if (bin == null)
        {
            Console.Error.WriteLine("lokaldev: " + tool + " is not installed");
            return 1;
        }

        // a value can also name the program itself (pip -> python.exe -m pip)
        string program = bin.EndsWith(".exe") ? bin : Path.Combine(bin, (kind == "php" ? "php" : tool) + ".exe");
        if (!File.Exists(program) && kind == "db") program = Path.Combine(bin, OtherName(tool) + ".exe");

        string args = RawArgs();
        if (tool == "composer" || tool == "wp") args = "\"" + Resolve(lines, tool, cwd) + "\" " + args;
        // e.g. httpd/nginx get lokaldev's config
        string extra = Resolve(lines, tool + "args", cwd);
        if (extra != null) args = extra + " " + args;

        Console.CancelKeyPress += delegate(object s, ConsoleCancelEventArgs e) { e.Cancel = true; };
        var info = new ProcessStartInfo(program, args) { UseShellExecute = false };
        // MySQL/MariaDB clients read user/host/port from my.ini next to their bin folder; psql needs the env
        if (kind == "pg")
        {
            string port = Resolve(lines, "pgport", cwd);
            if (port != null) info.EnvironmentVariables["PGPORT"] = port;
            if (Environment.GetEnvironmentVariable("PGUSER") == null) info.EnvironmentVariables["PGUSER"] = Resolve(lines, "pguser", cwd) ?? "postgres";
            string password = Resolve(lines, "pgpassword", cwd);
            if (Environment.GetEnvironmentVariable("PGPASSWORD") == null && !string.IsNullOrEmpty(password)) info.EnvironmentVariables["PGPASSWORD"] = password;
        }
        try
        {
            using (var p = Process.Start(info))
            {
                p.WaitForExit();
                return p.ExitCode;
            }
        }
        catch (Exception e)
        {
            Console.Error.WriteLine("lokaldev: " + program + ": " + e.Message);
            return 1;
        }
    }

    // mysql* <-> mariadb* names: MariaDB ships only mariadb-* names in newer builds, MySQL never has them
    static string OtherName(string tool)
    {
        string[,] names = { { "mysql", "mariadb" }, { "mysqldump", "mariadb-dump" }, { "mysqladmin", "mariadb-admin" }, { "mysqlcheck", "mariadb-check" }, { "mysqlimport", "mariadb-import" } };
        for (int i = 0; i < names.GetLength(0); i++)
        {
            if (names[i, 0] == tool) return names[i, 1];
            if (names[i, 1] == tool) return names[i, 0];
        }
        return tool;
    }

    // Lines: kind|path prefix (lowercase, trailing \, empty = default)|value
    static string Resolve(string[] lines, string kind, string cwd)
    {
        string best = null;
        int bestLen = -1;
        foreach (string line in lines)
        {
            string[] p = line.Split(new[] { '|' }, 3);
            if (p.Length == 3 && p[0] == kind && cwd.StartsWith(p[1]) && p[1].Length > bestLen)
            {
                best = p[2];
                bestLen = p[1].Length;
            }
        }
        return best;
    }

    // Arguments exactly as typed, so quoting survives the hop to the real binary.
    static string RawArgs()
    {
        string cmd = Environment.CommandLine;
        int i = 0;
        if (cmd.StartsWith("\"")) i = cmd.IndexOf('"', 1) + 1;
        else while (i < cmd.Length && cmd[i] != ' ' && cmd[i] != '\t') i++;
        return cmd.Substring(Math.Min(i, cmd.Length)).TrimStart();
    }
}
