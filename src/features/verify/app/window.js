import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { onPath } from '../../../core/exec.js';
import { spawnSync } from '../../../core/proc.js';
import { tail } from '../../../core/text.js';
import { blankness } from './png.js';
import { CRASH, shotPath, sleep, startApp } from './run.js';

/**
 * A desktop app or native game: start it, find the window it opens, capture that window. Fails when
 * it crashes, never shows a window, or the window is blank (a renderer that draws nothing).
 * Windows captures the window itself (PrintWindow, so other windows on top do not matter); macOS and
 * Linux capture the screen. ponytail: macOS takes the whole screen; capture by window id if that misleads.
 */

/** Windows: find the window (by title, or any window started since `since`) and save it as a PNG. */
const PS1 = `param([string]$Title, [string]$Since, [string]$Out)
Add-Type -AssemblyName System.Drawing
Add-Type @"
using System; using System.Runtime.InteropServices;
public class WololoWin {
  [DllImport("user32.dll")] public static extern bool GetClientRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern bool PrintWindow(IntPtr h, IntPtr dc, uint f);
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
  public struct RECT { public int L, T, R, B; }
}
"@
[WololoWin]::SetProcessDPIAware() | Out-Null
$since = [datetime]::Parse($Since)
$p = Get-Process | Where-Object { $_.MainWindowHandle -ne 0 -and $(if ($Title -eq '*') { try { $_.StartTime -ge $since } catch { $false } } else { $_.MainWindowTitle -like "*$Title*" }) } | Select-Object -First 1
if (-not $p) { Write-Output 'NOWINDOW'; exit 0 }
$r = New-Object WololoWin+RECT
[WololoWin]::GetClientRect($p.MainWindowHandle, [ref]$r) | Out-Null
$w = [Math]::Max(1, $r.R - $r.L); $h = [Math]::Max(1, $r.B - $r.T)
$bmp = New-Object System.Drawing.Bitmap $w, $h
$g = [System.Drawing.Graphics]::FromImage($bmp); $dc = $g.GetHdc()
# 3 = client area only (what the app draws, not the title bar) + full content (DirectX/GL windows)
[WololoWin]::PrintWindow($p.MainWindowHandle, $dc, 3) | Out-Null
$g.ReleaseHdc($dc); $g.Dispose()
$bmp.Save($Out, [System.Drawing.Imaging.ImageFormat]::Png)
Write-Output "OK $($p.MainWindowTitle)"
`;

/**
 * Capture the window into `out`.
 * @param {string} title @param {Date} since @param {string} out
 * @returns {{ found: boolean, error?: string }}
 */
function capture(title, since, out) {
  if (process.platform === 'win32') {
    const script = join(tmpdir(), `wololo-capture-${process.pid}.ps1`);
    writeFileSync(script, PS1);
    const r = spawnSync('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script, '-Title', title, '-Since', since.toISOString(), '-Out', out], { encoding: 'utf8' });
    rmSync(script, { force: true });
    if (/NOWINDOW/.test(r.stdout ?? '')) return { found: false };
    return existsSync(out) ? { found: true } : { found: false, error: `could not capture the window: ${tail(`${r.stdout}${r.stderr}`, 5)}` };
  }
  if (process.platform === 'darwin') {
    const r = spawnSync('screencapture', ['-x', out]);
    return r.status === 0 ? { found: true } : { found: false, error: 'screencapture failed (allow screen recording for the terminal in System Settings)' };
  }
  if (!onPath('import')) return { found: false, error: 'no screenshot tool: install ImageMagick (its import command captures X11 windows)' };
  let id = 'root';
  if (title !== '*' && onPath('xdotool')) {
    const found = spawnSync('xdotool', ['search', '--name', title], { encoding: 'utf8' }).stdout?.trim().split('\n')[0];
    if (!found) return { found: false };
    id = found;
  }
  const r = spawnSync('import', ['-window', id, out]);
  return r.status === 0 ? { found: true } : { found: false, error: 'import could not capture the screen (is there a display? set DISPLAY, or run under xvfb-run)' };
}

/**
 * @param {import('./index.js').AppCheck} check @param {import('./index.js').Where} where
 * @returns {Promise<import('./index.js').AppResult>}
 */
export async function runWindow(check, where) {
  const since = new Date(Date.now() - 1000);
  const app = startApp(/** @type {string} */ (check.start), where.cwd);
  const out = shotPath(where, 'png');
  rmSync(out, { force: true });
  const title = check.window ?? '*';
  /** @type {string[]} */
  const problems = [];
  try {
    await Promise.race([app.exited, sleep(check.waitMs ?? 5000)]);
    const end = Date.now() + (check.readyMs ?? 30_000);
    /** @type {{ found: boolean, error?: string }} */
    let shot = { found: false };
    while (app.exit() === null && !(shot = capture(title, since, out)).found && !shot.error && Date.now() < end) await sleep(1000);
    const crash = CRASH.exec(app.output());
    if (app.exit() !== null && !shot.found) problems.push(`\`${check.start}\` exited (${app.exit()}) without showing a window:\n${tail(app.output(), 15)}`);
    else if (shot.error) problems.push(shot.error);
    else if (!shot.found) problems.push(`no window${title === '*' ? '' : ` titled "${title}"`} appeared within ${Math.round(((check.waitMs ?? 5000) + (check.readyMs ?? 30_000)) / 1000)}s`);
    else {
      const b = blankness(readFileSync(out));
      if (b?.blank) problems.push(`the window is blank (one colour covers ${Math.round(b.share * 100)}% of it): nothing was drawn`);
    }
    if (crash && !(check.allow ?? []).some((a) => crash[0].includes(a))) problems.push(`it printed a crash: ${app.output().slice(crash.index).split('\n').slice(0, 3).join(' | ').slice(0, 300)}`);
    return { ok: problems.length === 0, problems, screenshot: existsSync(out) ? out : undefined };
  } finally {
    app.stop();
  }
}
