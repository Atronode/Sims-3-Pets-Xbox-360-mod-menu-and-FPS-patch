param([int]$ProcessId = 0, [string]$Log = '', [switch]$PetFix)
# -PetFix: leave memexport readback exactly as Xenia's settings have it (pets look right, lower frame rate).
# Keeps The Sims 3 Pets fast without breaking portraits.
# Xenia's "readback" settings copy the game's pictures back from the graphics card. Only portraits and thumbnails need
# that, but Xenia does it for every picture, which is what holds the game far below 60 FPS on many PCs.
# The "Smart screen copies" patch (in the FPS patch file) makes the game ask before each portrait or thumbnail; this
# helper then switches readback on, says "go", and switches it off again a moment after the last one.
# If this helper is not running, the game uses Xenia's own settings, exactly as before.
# Sims3ModLoader.ps1 starts it hidden; it closes by itself when the game closes.

if ($PSVersionTable.PSEdition -eq 'Core') {
  $ps = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
  $a = "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$PSCommandPath`" -ProcessId $ProcessId"
  if ($Log) { $a += " -Log `"$Log`"" }
  if ($PetFix) { $a += " -PetFix" }
  Start-Process -FilePath $ps -WindowStyle Hidden -ArgumentList $a
  exit
}

Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;

public static class SmartReadback {
  [StructLayout(LayoutKind.Sequential)] struct MBI { public ulong Base, AllocBase; public uint AllocProt, pad0; public ulong Size; public uint State, Protect, Type, pad1; }
  [DllImport("kernel32.dll")] static extern IntPtr OpenProcess(uint access, bool inherit, int pid);
  [DllImport("kernel32.dll")] static extern bool ReadProcessMemory(IntPtr h, ulong addr, byte[] buf, IntPtr size, out IntPtr got);
  [DllImport("kernel32.dll")] static extern bool WriteProcessMemory(IntPtr h, ulong addr, byte[] buf, IntPtr size, out IntPtr done);
  [DllImport("kernel32.dll")] static extern IntPtr VirtualQueryEx(IntPtr h, ulong addr, out MBI m, IntPtr len);
  [DllImport("winmm.dll")] static extern uint timeBeginPeriod(uint ms);
  [StructLayout(LayoutKind.Sequential)] struct PowerThrottling { public uint Version, ControlMask, StateMask; }
  [DllImport("kernel32.dll")] static extern bool SetProcessInformation(IntPtr process, int infoClass, ref PowerThrottling info, uint size);
  [DllImport("kernel32.dll")] static extern IntPtr GetCurrentProcess();

  // The game side, written by the patch: a mailbox in spare space at the end of Sims3.xex's data section.
  const ulong Mailbox = 0x89597760UL;
  const uint Magic = 0x53334350;              // "S3CP"
  // Where this Xenia build keeps the two settings (xenia_canary.exe canary_experimental@cf206a3bd), relative to the exe.
  const ulong KnownResolveOffset = 0x103A9E0UL, KnownMemexportOffset = 0x16727DFUL;
  // The game's graphics device (found through its VdGlobalDevice import) counts frames handed to the GPU and frames
  // the GPU has finished. Readback goes off once the frame holding the last requested copy has finished.
  const ulong DeviceImport = 0x88000818UL;
  const uint PresentCount = 0x423C, FlipCount = 0x4240;
  const uint FramesAfter = 2;                 // the requesting frame, plus one more for safety
  const double FallbackSeconds = 2.0;         // if the frame counters can't be read, wait this long instead

  static IntPtr h; static Process xenia; static StreamWriter log; static bool verbose; static Stopwatch clock = Stopwatch.StartNew();
  static ulong guest, resolveAt, memexportAt; static uint device; static byte[] onResolve; static byte onMemexport; static bool isOn = true;
  static bool petFix;   // true: never touch memexport readback
  static uint presentsAtRequest; static bool haveFrames; static double onSince;

  static void Say(string s) { if (log != null) { log.WriteLine(DateTime.Now.ToString("HH:mm:ss.fff") + " " + s); log.Flush(); } }
  static byte[] Read(ulong a, int n) { var b = new byte[n]; IntPtr g; return ReadProcessMemory(h, a, b, (IntPtr)n, out g) && (long)g == n ? b : null; }
  static bool Write(ulong a, byte[] d) { IntPtr n; return WriteProcessMemory(h, a, d, (IntPtr)d.Length, out n) && (long)n == d.Length; }
  static uint BE(byte[] b, int o) { return ((uint)b[o] << 24) | ((uint)b[o + 1] << 16) | ((uint)b[o + 2] << 8) | b[o + 3]; }
  static byte[] BEBytes(uint v) { return new byte[] { (byte)(v >> 24), (byte)(v >> 16), (byte)(v >> 8), (byte)v }; }

  static bool ValidResolve(ulong a) {
    var b = Read(a, 32); if (b == null) return false;
    if (BitConverter.ToUInt64(b, 16) != 4 || BitConverter.ToUInt64(b, 24) != 15 || b[4] != 0) return false;
    string s = Encoding.ASCII.GetString(b, 0, 4);
    return s == "full" || s == "fast" || s == "none";
  }
  static bool ValidBool(ulong a) { var b = Read(a, 1); return b != null && b[0] <= 1; }

  // Any Xenia build: find each setting through its registered name (the setting object keeps a pointer to its storage).
  static List<KeyValuePair<ulong, ulong>> Regions(uint typeMask) {
    var list = new List<KeyValuePair<ulong, ulong>>(); ulong a = 0x10000;
    while (a < 0x7FFFFFFFFFFFUL) {
      MBI m; if (VirtualQueryEx(h, a, out m, (IntPtr)Marshal.SizeOf(typeof(MBI))) == IntPtr.Zero) break;
      if (m.State == 0x1000 && (m.Protect & 0x100) == 0 && (m.Protect & 0x66) != 0 && (m.Type & typeMask) != 0 && m.Size <= 0x4000000UL)
        list.Add(new KeyValuePair<ulong, ulong>(m.Base, m.Size));
      a = m.Base + m.Size;
    }
    return list;
  }
  static ulong FindStorage(string name, int storageOffset, ulong imgLo, ulong imgHi) {
    byte[] pat = Encoding.ASCII.GetBytes(name + "\0");
    var regions = Regions(0x20000);
    var texts = new List<ulong>();
    foreach (var r in regions) {
      var buf = Read(r.Key, (int)r.Value); if (buf == null) continue;
      for (int i = 0; i + pat.Length <= buf.Length; i++) {
        if (buf[i] != pat[0]) continue; bool ok = true;
        for (int j = 1; j < pat.Length && ok; j++) ok = buf[i + j] == pat[j];
        if (ok) texts.Add(r.Key + (ulong)i);
      }
    }
    foreach (var r in regions) {
      var buf = Read(r.Key, (int)r.Value); if (buf == null) continue;
      for (int i = 0; i + storageOffset + 8 <= buf.Length; i += 8) {
        ulong p = BitConverter.ToUInt64(buf, i);
        if (!texts.Contains(p) || BitConverter.ToUInt64(buf, i + 16) != (ulong)name.Length) continue;
        ulong storage = BitConverter.ToUInt64(buf, i + storageOffset);
        if (storage >= imgLo && storage < imgHi) return storage;
      }
    }
    return 0;
  }

  static bool FindSettings() {
    ulong imgLo = (ulong)xenia.MainModule.BaseAddress.ToInt64(), imgHi = imgLo + (ulong)xenia.MainModule.ModuleMemorySize;
    resolveAt = imgLo + KnownResolveOffset; memexportAt = imgLo + KnownMemexportOffset;
    if (ValidResolve(resolveAt) && ValidBool(memexportAt)) { Say("Xenia settings found at the known places"); return true; }
    Say("Not the known Xenia build; searching for the settings by name");
    resolveAt = FindStorage("readback_resolve", 64, imgLo, imgHi);
    memexportAt = FindStorage("readback_memexport", 40, imgLo, imgHi);
    bool ok = resolveAt != 0 && memexportAt != 0 && ValidResolve(resolveAt) && ValidBool(memexportAt);
    Say(ok ? "Xenia settings found by name" : "Could not find Xenia's readback settings; leaving them alone");
    return ok;
  }

  // Both readbacks are switched together, for the frame rate. The game builds pet fur on the GPU with memory export;
  // the "Pets look right" patch keeps it correct with memexport readback off. -PetFix (Pet safe mode) leaves memexport
  // readback on instead, at the cost of a GPU wait per pet.
  static void SetOn(bool on) {
    if (on == isOn) return;
    Write(resolveAt, on ? onResolve : Encoding.ASCII.GetBytes("none"));
    if (!petFix) Write(memexportAt, new byte[] { on ? onMemexport : (byte)0 });
    isOn = on;
    if (on) onSince = clock.Elapsed.TotalSeconds;
  }

  static bool Frames(out uint presents, out uint flips) {
    presents = flips = 0;
    if (device == 0) return false;
    var b = Read(guest + device + PresentCount, 8);
    if (b == null) return false;
    presents = BE(b, 0); flips = BE(b, 4);
    return true;
  }

  static void FindDevice() {
    var s = Read(guest + DeviceImport, 4); if (s == null) { device = 0; return; }
    uint slot = BE(s, 0); if (slot == 0) { device = 0; return; }
    var d = Read(guest + slot, 4); device = d == null ? 0 : BE(d, 0);
  }

  public static void Run(int pid, string logPath, bool keepMemexport) {
    petFix = keepMemexport;
    if (!string.IsNullOrEmpty(logPath)) { log = new StreamWriter(logPath, true); verbose = Environment.GetEnvironmentVariable("SIMS3_HELPER_VERBOSE") == "1"; }
    try { xenia = Process.GetProcessById(pid); } catch { return; }
    h = OpenProcess(0x0438, false, pid);   // query, read and write memory
    if (h == IntPtr.Zero) { Say("Could not open Xenia"); return; }
    // Windows slows hidden background programs down (efficiency mode, coarse timers). If this helper answers late, the
    // game gives up waiting and makes that copy with readback off, which stores garbage in a photo, a portrait or a
    // Sim's baked outfit. So opt out of both and run at high priority; the helper sleeps between checks, so it costs nothing.
    bool unthrottled = false;
    try { var pt = new PowerThrottling { Version = 1, ControlMask = 0x1 | 0x4, StateMask = 0 }; unthrottled = SetProcessInformation(GetCurrentProcess(), 4, ref pt, (uint)Marshal.SizeOf(typeof(PowerThrottling))); } catch { }
    try { Process.GetCurrentProcess().PriorityClass = ProcessPriorityClass.High; } catch { }
    timeBeginPeriod(1);
    Thread.CurrentThread.Priority = ThreadPriority.AboveNormal;
    Say(unthrottled ? "Windows power throttling off for this helper" : "Windows power throttling could not be switched off (older Windows); carrying on");
    bool settings = false, armed = false; uint lastReq = 0; double lastReqTime = 0, nextSlowCheck = 0;
    try {
      while (true) {
        double now = clock.Elapsed.TotalSeconds;
        if (now >= nextSlowCheck) {
          nextSlowCheck = now + 0.5;
          if (xenia.HasExited) break;
          if (guest == 0) {
            for (int n = 32; n <= 46 && guest == 0; n++) { var m = Read((1UL << n) + 0x88000000UL, 4); if (m != null && BE(m, 0) == 0x4D5A9000) guest = 1UL << n; }
          }
          if (guest != 0) FindDevice();   // the device is made again when the game reloads its code
        }
        if (guest == 0) { Thread.Sleep(50); continue; }
        var mb = Read(guest + Mailbox, 24);
        if (mb == null || BE(mb, 0) != Magic) {
          // The game's code is not loaded yet, is being reloaded, or the patch is not installed.
          if (armed) { SetOn(true); armed = false; Say("Game code reloading: readback back to normal until it returns"); }
          Thread.Sleep(50); continue;
        }
        if (!settings) {
          settings = FindSettings();
          if (!settings) { Thread.Sleep(1000); while (!xenia.HasExited) Thread.Sleep(1000); break; }
          var cur = Read(resolveAt, 4); onResolve = cur; onMemexport = Read(memexportAt, 1)[0];
          string mode = Encoding.ASCII.GetString(cur);
          Say("Xenia's own settings: readback_resolve=" + mode + " readback_memexport=" + onMemexport);
          if (mode == "none" && (petFix || onMemexport == 0)) { Say("Readback is already off in Xenia's settings; nothing to do"); while (!xenia.HasExited) Thread.Sleep(1000); break; }
          Say(petFix ? "Pet fix on: memexport readback is left as Xenia's settings have it" : "Pet fix off: memexport readback goes off with resolve readback");
          isOn = true;
        }
        uint alive = BE(mb, 4), req = BE(mb, 8), timeouts = BE(mb, 16);
        if (!armed || alive == 0) {
          // Start (or restart after the game code reloaded, or after the game gave up waiting): readback on, then arm.
          SetOn(true);
          if (armed) Say("The game stopped waiting (timeouts so far: " + timeouts + "); re-arming");
          lastReq = req; Write(guest + Mailbox + 12, BEBytes(req));
          Write(guest + Mailbox + 4, BEBytes(1));
          armed = true; lastReqTime = now; Say("Armed: readback off except for portraits and thumbnails");
          continue;
        }
        uint presents, flips;
        if (req != lastReq) {
          bool wasOff = !isOn;
          SetOn(true);
          Write(guest + Mailbox + 12, BEBytes(req));
          // The game is still inside the frame that asked (it waits for this answer), so that frame is presents + 1.
          haveFrames = Frames(out presents, out flips);
          if (haveFrames) presentsAtRequest = presents;
          if (wasOff) Say("On for copy site " + BE(mb, 20) + " (request " + req + ")");
          else if (verbose) Say("  request " + req + " from copy site " + BE(mb, 20));
          lastReq = req; lastReqTime = now;
        } else if (isOn) {
          // Off once the GPU has finished the frame that held the last requested copy (and one more), or after a
          // long quiet spell if the frame counters can't be read.
          bool done;
          if (haveFrames && Frames(out presents, out flips) && presents >= presentsAtRequest)
            done = flips - presentsAtRequest >= FramesAfter && flips - presentsAtRequest < 0x80000000u;
          else
            done = now - lastReqTime > FallbackSeconds;
          if (done) { SetOn(false); Say(string.Format("Off after {0:0} ms", (now - onSince) * 1000)); }
        }
        Thread.Sleep(1);
      }
    } catch (Exception e) { Say("Stopped: " + e.Message); }
    finally {
      try { if (!xenia.HasExited && settings) { SetOn(true); if (guest != 0) Write(guest + Mailbox + 4, BEBytes(0)); } } catch { }
      Say("Exit");
      if (log != null) log.Close();
    }
  }
}
'@

$target = $null
if ($ProcessId) { $target = Get-Process -Id $ProcessId -ErrorAction SilentlyContinue }
else { for ($i = 0; $i -lt 240 -and -not $target; $i++) { $target = Get-Process xenia_canary -ErrorAction SilentlyContinue | Select-Object -First 1; if (-not $target) { Start-Sleep -Milliseconds 500 } } }
if ($target) { [SmartReadback]::Run($target.Id, $Log, [bool]$PetFix) }
