param([int]$ProcessId = 0)
# Shows the game's frame rate in a small box in the top-left corner of the Xenia window, for example "16 / 60 FPS":
# 16 frames shown in the last second, out of the 60 the game allows (30 without the FPS patch).
# Read-only: it reads a few numbers from the running game and never changes the game, Xenia or your saves.
# Sims3ModLoader.ps1 starts it when the counter is turned on in "Sims 3 Pets FPS Patch.bat".
# It closes by itself when the game closes, and hides while another window is in front.

# The window code needs Windows PowerShell, which every Windows 10 and 11 PC has; hand over to it if this is PowerShell 7.
if ($PSVersionTable.PSEdition -eq 'Core') {
  $ps = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
  Start-Process -FilePath $ps -WindowStyle Hidden -ArgumentList "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$PSCommandPath`" -ProcessId $ProcessId"
  exit
}

Add-Type -ReferencedAssemblies System.Windows.Forms, System.Drawing -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.Runtime.InteropServices;
using System.Windows.Forms;

public class FpsCounterWindow : Form {
  [DllImport("kernel32.dll")] static extern IntPtr OpenProcess(uint access, bool inherit, int pid);
  [DllImport("kernel32.dll")] static extern bool ReadProcessMemory(IntPtr h, ulong addr, byte[] buf, IntPtr size, out IntPtr got);
  [DllImport("user32.dll")] static extern bool SetProcessDPIAware();
  [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr hwnd, out uint pid);
  [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc cb, IntPtr lp);
  [DllImport("user32.dll")] static extern IntPtr GetWindow(IntPtr hwnd, uint cmd);
  [DllImport("user32.dll")] static extern bool IsWindow(IntPtr hwnd);
  [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr hwnd);
  [DllImport("user32.dll")] static extern bool IsIconic(IntPtr hwnd);
  [DllImport("user32.dll")] static extern bool GetClientRect(IntPtr hwnd, out RECT r);
  [DllImport("user32.dll")] static extern bool ClientToScreen(IntPtr hwnd, ref POINT p);
  [DllImport("user32.dll")] static extern bool SetWindowPos(IntPtr hwnd, IntPtr after, int x, int y, int w, int h, uint flags);
  delegate bool EnumProc(IntPtr hwnd, IntPtr lp);
  [StructLayout(LayoutKind.Sequential)] struct RECT { public int L, T, R, B; }
  [StructLayout(LayoutKind.Sequential)] struct POINT { public int X, Y; }

  // Addresses inside The Sims 3 Pets (Sims3.xex, module hash DF7B98E763E34184).
  const ulong GameModule = 0x88000000UL;       // start of the game's code: "MZ" once it has loaded
  const ulong DeviceImport = 0x88000818UL;     // the game's import of the kernel's VdGlobalDevice variable
  const ulong FrameLimitCode = 0x8911FD50UL;   // li r11,N: 2 = 30 FPS (stock), 1 = 60 FPS patch, 0 = unlocked patch
  const uint PresentCount = 0x423C;            // graphics device field: frames the game has shown so far

  readonly Process xenia;
  readonly IntPtr reader;
  readonly Stopwatch clock = Stopwatch.StartNew();
  readonly Queue<KeyValuePair<double, long>> samples = new Queue<KeyValuePair<double, long>>();
  readonly Timer timer = new Timer();
  ulong guestBase;
  double nextBaseSearch, nextWindowSearch, nextText;
  IntPtr gameWindow;
  string number = "", suffix = "";
  int boxHeight;
  Font bigFont, smallFont;

  public static void Run(int pid) {
    try { SetProcessDPIAware(); } catch { }
    Process p;
    try { p = Process.GetProcessById(pid); } catch { return; }
    Application.Run(new FpsCounterWindow(p));
  }

  FpsCounterWindow(Process p) {
    xenia = p;
    reader = OpenProcess(0x0410, false, p.Id);   // query + read only
    FormBorderStyle = FormBorderStyle.None;
    ShowInTaskbar = false;
    StartPosition = FormStartPosition.Manual;
    TopMost = true;
    BackColor = Color.FromArgb(18, 18, 18);
    Opacity = 0.8;
    DoubleBuffered = true;
    Bounds = new Rectangle(-32000, -32000, 10, 10);
    timer.Interval = 250;
    timer.Tick += delegate { Tick(); };
    timer.Start();
  }

  protected override bool ShowWithoutActivation { get { return true; } }
  protected override CreateParams CreateParams {
    get {
      var cp = base.CreateParams;
      // Layered + transparent: clicks go straight through to the game. Tool window + no-activate: never takes focus, not in Alt+Tab.
      cp.ExStyle |= 0x00080000 | 0x00000020 | 0x00000080 | 0x08000000 | 0x00000008;
      return cp;
    }
  }

  double Seconds() { return clock.Elapsed.TotalSeconds; }

  bool Read32(ulong addr, out uint value) {
    value = 0;
    var b = new byte[4]; IntPtr got;
    if (reader == IntPtr.Zero || !ReadProcessMemory(reader, addr, b, (IntPtr)4, out got) || (long)got != 4) return false;
    value = ((uint)b[0] << 24) | ((uint)b[1] << 16) | ((uint)b[2] << 8) | b[3];   // the Xbox 360 is big-endian
    return true;
  }

  // Xenia maps the console's memory at a power-of-two address; find which one by looking for the game's code.
  bool FindGuestBase() {
    for (int n = 32; n <= 46; n++) {
      uint w; ulong at = 1UL << n;
      if (Read32(at + GameModule, out w) && w == 0x4D5A9000) { guestBase = at; return true; }
    }
    return false;
  }

  IntPtr FindGameWindow() {
    IntPtr best = IntPtr.Zero; long bestArea = 0;
    EnumWindows(delegate(IntPtr w, IntPtr lp) {
      uint owner; GetWindowThreadProcessId(w, out owner);
      if (owner != (uint)xenia.Id || !IsWindowVisible(w) || GetWindow(w, 4) != IntPtr.Zero) return true;
      RECT r; GetClientRect(w, out r);
      long area = (long)(r.R - r.L) * (r.B - r.T);
      if (area > bestArea) { bestArea = area; best = w; }
      return true;
    }, IntPtr.Zero);
    return best;
  }

  void Tick() {
    if (xenia.HasExited) { timer.Stop(); Close(); return; }
    double now = Seconds();
    if (guestBase == 0) {
      if (now < nextBaseSearch) { HideBox(); return; }
      nextBaseSearch = now + 1;
      if (!FindGuestBase()) { HideBox(); return; }
    }
    uint code, slot, device, presents;
    if (!Read32(guestBase + FrameLimitCode, out code) || !Read32(guestBase + DeviceImport, out slot) || slot == 0 ||
        !Read32(guestBase + slot, out device) || device == 0 || !Read32(guestBase + device + PresentCount, out presents)) {
      samples.Clear(); HideBox(); return;   // the game is still starting up
    }
    if ((code & 0xFFFFFF00) != 0x39600000) { HideBox(); return; }   // not the version of the game these addresses are for

    // Frames shown over the last second; the number on screen changes twice a second.
    if (samples.Count > 0 && presents < samples.Peek().Value) samples.Clear();
    samples.Enqueue(new KeyValuePair<double, long>(now, presents));
    while (samples.Count > 1 && now - samples.Peek().Key > 1.05) samples.Dequeue();
    var first = samples.Peek();
    if (now - first.Key < 0.7) { HideBox(); return; }
    if (now >= nextText || number == "") {
      nextText = now + 0.5;
      int fps = (int)Math.Round((presents - first.Value) / (now - first.Key));
      uint mode = code & 0xFF;
      string n = fps.ToString();
      string sfx = mode == 1 ? "/ 60 FPS" : mode == 0 ? "FPS (no limit)" : "/ 30 FPS";
      if (n != number || sfx != suffix) { number = n; suffix = sfx; Invalidate(); }
    }
    PlaceBox();
  }

  void HideBox() { if (Visible) Hide(); }

  void SetSize(int h) {
    if (h == boxHeight && bigFont != null) return;
    boxHeight = h;
    if (bigFont != null) { bigFont.Dispose(); smallFont.Dispose(); }
    bigFont = new Font("Segoe UI Semibold", h * 0.68f, FontStyle.Regular, GraphicsUnit.Pixel);
    smallFont = new Font("Segoe UI", h * 0.44f, FontStyle.Regular, GraphicsUnit.Pixel);
    Invalidate();
  }

  int Ascent(Font f) { return (int)Math.Round(f.FontFamily.GetCellAscent(f.Style) * f.Size / f.FontFamily.GetEmHeight(f.Style)); }

  void PlaceBox() {
    double now = Seconds();
    if (now > nextWindowSearch || gameWindow == IntPtr.Zero || !IsWindow(gameWindow)) { gameWindow = FindGameWindow(); nextWindowSearch = now + 2; }
    if (gameWindow == IntPtr.Zero || IsIconic(gameWindow)) { HideBox(); return; }
    // Only over the game: hide while another program is in front.
    uint fgOwner; GetWindowThreadProcessId(GetForegroundWindow(), out fgOwner);
    if (fgOwner != (uint)xenia.Id) { HideBox(); return; }

    RECT c; GetClientRect(gameWindow, out c);
    int cw = c.R - c.L, ch = c.B - c.T;
    if (cw < 160 || ch < 120) { HideBox(); return; }
    // Xenia keeps the picture 16:9 and fills the rest with black bars; sit inside the picture, not on a bar.
    int pw = cw, ph = ch;
    if (cw * 9 > ch * 16) pw = ch * 16 / 9; else ph = cw * 9 / 16;
    var origin = new POINT(); origin.X = (cw - pw) / 2; origin.Y = (ch - ph) / 2;
    ClientToScreen(gameWindow, ref origin);

    // Sized to the picture and kept inside its top 5%, above where the game's own tutorial boxes start.
    SetSize(Math.Max(22, (int)Math.Round(ph * 0.04)));
    int margin = Math.Max(4, (int)Math.Round(ph * 0.006));
    int w = BoxWidth();
    // Topmost again every time, so it stays above Xenia in full screen as well. SWP_NOACTIVATE.
    SetWindowPos(Handle, new IntPtr(-1), origin.X + margin, origin.Y + margin, w, boxHeight, 0x0010);
    if (!Visible) Show();
  }

  int Pad() { return (int)Math.Round(boxHeight * 0.3); }

  int BoxWidth() {
    var flags = TextFormatFlags.NoPadding;
    return Pad() * 2 + TextRenderer.MeasureText(number, bigFont, Size.Empty, flags).Width + (int)Math.Round(boxHeight * 0.16)
         + TextRenderer.MeasureText(suffix, smallFont, Size.Empty, flags).Width;
  }

  protected override void OnPaint(PaintEventArgs e) {
    if (bigFont == null) return;
    var flags = TextFormatFlags.NoPadding;
    Size big = TextRenderer.MeasureText(number, bigFont, Size.Empty, flags);
    int top = (boxHeight - big.Height) / 2;
    TextRenderer.DrawText(e.Graphics, number, bigFont, new Point(Pad(), top), Color.White, flags);
    // The small text shares the number's baseline.
    int x = Pad() + big.Width + (int)Math.Round(boxHeight * 0.16);
    TextRenderer.DrawText(e.Graphics, suffix, smallFont, new Point(x, top + Ascent(bigFont) - Ascent(smallFont)), Color.FromArgb(180, 180, 180), flags);
  }
}
'@

$target = $null
if ($ProcessId) { $target = Get-Process -Id $ProcessId -ErrorAction SilentlyContinue }
else {
  # Started on its own: wait up to two minutes for Xenia to open.
  for ($i = 0; $i -lt 240 -and -not $target; $i++) { $target = Get-Process xenia_canary -ErrorAction SilentlyContinue | Select-Object -First 1; if (-not $target) { Start-Sleep -Milliseconds 500 } }
}
if ($target) { [FpsCounterWindow]::Run($target.Id) }
