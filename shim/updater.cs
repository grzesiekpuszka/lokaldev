// Installs a downloaded lokaldev update once the app has exited: the entries the new package contains are moved to a
// backup, the new files are copied in and the new exe starts. On any failure the backup is put back and the old
// version starts. A window-less exe (/target:winexe), so nothing flashes on screen.
// Usage: updater.exe <root> <new> <backup> <pid> [app arguments...]
// Built with the C# 5 compiler that ships with Windows: scripts/build-shim.mjs
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Threading;

static class Updater
{
    // next to the exe but not part of the package
    static readonly string[] Keep = { "data", "www", "databases" };

    static int Main(string[] args)
    {
        string root = args[0], fresh = args[1], backup = args[2];
        int pid = int.Parse(args[3]);
        string appArgs = "";
        for (int i = 4; i < args.Length; i++) appArgs += " \"" + args[i] + "\"";

        try
        {
            Process.GetProcessById(pid).WaitForExit();
        }
        catch (ArgumentException) { } // already gone
        Thread.Sleep(1500); // its child processes release their files

        var moved = new List<string>();
        try
        {
            if (Directory.Exists(backup)) Directory.Delete(backup, true);
            Directory.CreateDirectory(backup);
            foreach (string entry in Directory.GetFileSystemEntries(fresh))
            {
                string name = Path.GetFileName(entry);
                if (Array.Exists(Keep, k => string.Equals(k, name, StringComparison.OrdinalIgnoreCase))) continue;
                string current = Path.Combine(root, name);
                if (!File.Exists(current) && !Directory.Exists(current)) continue;
                Retry(() => Move(current, Path.Combine(backup, name)));
                moved.Add(name);
            }
            CopyTree(fresh, root);
            Start(root, "--updated" + appArgs);
            return 0;
        }
        catch (Exception)
        {
            // put the old version back: drop what was copied over the moved entries, move them back
            foreach (string name in moved)
            {
                try
                {
                    string current = Path.Combine(root, name);
                    if (Directory.Exists(current)) Directory.Delete(current, true);
                    else if (File.Exists(current)) File.Delete(current);
                    Move(Path.Combine(backup, name), current);
                }
                catch (Exception) { }
            }
            Start(root, "--update-failed" + appArgs);
            return 1;
        }
    }

    static void Move(string from, string to)
    {
        if (Directory.Exists(from)) Directory.Move(from, to);
        else File.Move(from, to);
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
