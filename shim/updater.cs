// Installs a downloaded lokaldev update once the app has exited: the entries the new package contains are moved to a
// backup, the new files are copied in and the new exe starts. On any failure the new entries are removed, the backup is
// put back and the old version starts; what went wrong goes to update.log, and a "rollback-failed" file next to it
// tells the app that the backup still holds files it couldn't restore. A window-less exe (/target:winexe).
// Usage: updater.exe <root> <new> <backup> <pid> [app arguments...]
// Built with the C# 5 compiler that ships with Windows: scripts/build-shim.mjs
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Threading;

static class Updater
{
    // next to the exe but never part of an update, even if a package contained them
    static readonly string[] Keep = { "data", "www", "databases" };

    static int Main(string[] args)
    {
        string root = args[0], fresh = args[1], backup = args[2];
        int pid = int.Parse(args[3]);
        string dir = Path.GetDirectoryName(backup);
        string appArgs = "";
        for (int i = 4; i < args.Length; i++) appArgs += " \"" + args[i] + "\"";

        try
        {
            Process.GetProcessById(pid).WaitForExit();
        }
        catch (ArgumentException) { } // already gone
        Thread.Sleep(1500); // its child processes release their files

        var moved = new List<string>();
        var added = new List<string>();
        try
        {
            if (Directory.Exists(backup)) Directory.Delete(backup, true);
            Directory.CreateDirectory(backup);
            foreach (string entry in Directory.GetFileSystemEntries(fresh))
            {
                string name = Path.GetFileName(entry);
                if (Array.Exists(Keep, k => string.Equals(k, name, StringComparison.OrdinalIgnoreCase))) continue;
                string current = Path.Combine(root, name);
                if (File.Exists(current) || Directory.Exists(current))
                {
                    Retry(() => Move(current, Path.Combine(backup, name)));
                    moved.Add(name);
                }
                else added.Add(name);
            }
            foreach (string name in moved.Concat(added))
            {
                string from = Path.Combine(fresh, name), to = Path.Combine(root, name);
                if (Directory.Exists(from)) CopyTree(from, to);
                else Retry(() => File.Copy(from, to, true));
            }
            Start(root, "--updated" + appArgs);
            return 0;
        }
        catch (Exception e)
        {
            var log = new List<string> { DateTime.Now + " update failed: " + e };
            bool restored = true;
            foreach (string name in moved.Concat(added))
            {
                try
                {
                    Retry(() => Delete(Path.Combine(root, name)));
                }
                catch (Exception x)
                {
                    restored = false;
                    log.Add("can't remove " + name + ": " + x.Message);
                }
            }
            foreach (string name in moved)
            {
                try
                {
                    Retry(() => Move(Path.Combine(backup, name), Path.Combine(root, name)));
                }
                catch (Exception x)
                {
                    restored = false;
                    log.Add("can't restore " + name + ": " + x.Message);
                }
            }
            try
            {
                File.WriteAllLines(Path.Combine(dir, "update.log"), log);
                if (!restored) File.WriteAllText(Path.Combine(dir, "rollback-failed"), "");
            }
            catch (Exception) { }
            try
            {
                Start(root, "--update-failed" + appArgs);
            }
            catch (Exception) { }
            return 1;
        }
    }

    static IEnumerable<string> Concat(this IEnumerable<string> a, IEnumerable<string> b)
    {
        foreach (string x in a) yield return x;
        foreach (string x in b) yield return x;
    }

    static void Move(string from, string to)
    {
        if (Directory.Exists(from)) Directory.Move(from, to);
        else File.Move(from, to);
    }

    static void Delete(string path)
    {
        if (Directory.Exists(path)) Directory.Delete(path, true);
        else if (File.Exists(path)) File.Delete(path);
    }

    // files can stay locked for a moment after the app exits
    static void Retry(Action action)
    {
        for (int i = 0; ; i++)
        {
            try
            {
                action();
                return;
            }
            catch (IOException)
            {
                if (i == 20) throw;
                Thread.Sleep(500);
            }
            catch (UnauthorizedAccessException)
            {
                if (i == 20) throw;
                Thread.Sleep(500);
            }
        }
    }

    static void CopyTree(string from, string to)
    {
        Directory.CreateDirectory(to);
        foreach (string file in Directory.GetFiles(from))
        {
            string target = Path.Combine(to, Path.GetFileName(file));
            Retry(() => File.Copy(file, target, true));
        }
        foreach (string dir in Directory.GetDirectories(from)) CopyTree(dir, Path.Combine(to, Path.GetFileName(dir)));
    }

    static void Start(string root, string args)
    {
        var info = new ProcessStartInfo(Path.Combine(root, "lokaldev.exe"), args.TrimStart()) { UseShellExecute = false, WorkingDirectory = root };
        Process.Start(info);
    }
}
