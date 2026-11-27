import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { deflateSync } from 'node:zlib';
import { test } from 'node:test';
import { kindOf, runAppCheck } from '../src/features/verify/app/index.js';
import { blankness } from '../src/features/verify/app/png.js';
import { findBrowser } from '../src/features/verify/app/web.js';

const dir = mkdtempSync(join(tmpdir(), 'wololo-app-'));
const page = (/** @type {string} */ name, /** @type {string} */ body) => writeFileSync(join(dir, name), `<!doctype html><html><body style="margin:0">${body}</body></html>`);
const where = (/** @type {string} */ name) => ({ cwd: dir, root: dir, name });
const draw2d = `<canvas id="c" width="300" height="200"></canvas><script>const g = document.getElementById('c').getContext('2d'); for (let i = 0; i < 30; i++) { g.fillStyle = 'hsl(' + i * 12 + ',70%,50%)'; g.fillRect(i * 10, (i * 37) % 180, 40, 20); }</script>`;

page('good.html', draw2d);
page('webgl.html', `<canvas id="c" width="300" height="200"></canvas><script>const gl = document.getElementById('c').getContext('webgl'); gl.enable(gl.SCISSOR_TEST); for (let i = 0; i < 12; i++) { gl.scissor(i * 25, 0, 25, 200); gl.clearColor(i / 12, 1 - i / 12, 0.5, 1); gl.clear(gl.COLOR_BUFFER_BIT); }</script>`);
page('blank.html', '<canvas id="c" width="300" height="200"></canvas>');
page('broken-asset.html', `${draw2d}<img src="sprites/villager.png">`);
page('throws.html', `${draw2d}<script>undefinedRenderer.start()</script>`);
page('no-canvas.html', '<div>loading…</div>');

/** A PNG of w x h RGB pixels from a colour function, to test the blank detector without a screen. */
function png(/** @type {number} */ w, /** @type {number} */ h, /** @type {(x: number, y: number) => number[]} */ at) {
  const raw = Buffer.alloc((w * 3 + 1) * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) raw.set(at(x, y), y * (w * 3 + 1) + 1 + x * 3);
  const chunk = (/** @type {string} */ type, /** @type {Buffer} */ body) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(body.length);
    return Buffer.concat([len, Buffer.from(type), body, Buffer.alloc(4)]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr.set([8, 2, 0, 0, 0], 8);
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

test('one app check for any project: a url opens a browser, a window title a desktop app, otherwise a terminal', () => {
  assert.equal(kindOf({ url: 'index.html' }), 'web');
  assert.equal(kindOf({ start: 'cargo run', window: 'My Game' }), 'window');
  assert.equal(kindOf({ start: 'mytool --help' }), 'terminal');
});

test('blank detection reads real PNGs: one colour is blank, a drawn picture is not', () => {
  assert.equal(blankness(png(40, 30, () => [20, 20, 20]))?.blank, true);
  assert.equal(blankness(png(100, 100, (x, y) => (x > 97 && y > 97 ? [255, 255, 255] : [0, 0, 128])))?.blank, true, 'a resize grip in the corner is still blank');
  assert.equal(blankness(png(40, 30, (x, y) => [x * 6, y * 8, 128]))?.blank, false);
  assert.equal(blankness(png(40, 30, (x) => (x < 30 ? [0, 0, 128] : [200, 50, 0])))?.blank, false, 'a quarter drawn is not blank');
  assert.equal(blankness(png(40, 30, (x) => (x < 20 ? [255, 0, 0] : [0, 0, 255])), { x: 0, y: 0, width: 10, height: 30 })?.blank, true, 'only the region asked about');
});

test('terminal apps: what they print is the screen; crashes, silence and missing text fail', { timeout: 60_000 }, async () => {
  const ok = await runAppCheck({ start: 'node -e "console.log(\'Villagers: 12  Food: 340\')"', expect: 'Villagers' }, where('cli-ok'));
  assert.deepEqual(ok.problems, []);
  assert.match(readFileSync(/** @type {string} */ (ok.screenshot), 'utf8'), /Food: 340/, 'the screen text is kept');
  const crash = await runAppCheck({ start: 'node -e "throw new TypeError(\'boom\')"' }, where('cli-crash'));
  assert.match(crash.problems.join('\n'), /exited with 1[\s\S]*crashed: TypeError: boom/);
  const silent = await runAppCheck({ start: 'node -e ""' }, where('cli-silent'));
  assert.match(silent.problems.join('\n'), /printed nothing/);
  const missing = await runAppCheck({ start: 'node -e "console.log(\'hi\')"', expect: 'Villagers' }, where('cli-missing'));
  assert.match(missing.problems.join('\n'), /never shows "Villagers"/);
  const tui = await runAppCheck({ start: 'node -e "console.log(\'dashboard\'); setInterval(() => {}, 1000)"', waitMs: 800 }, where('cli-tui'));
  assert.deepEqual(tui.problems, [], 'a program that keeps running is judged on what it showed, then stopped');
  assert.match((await runAppCheck({}, where('nothing'))).problems.join(), /nothing to run/);
});

const browser = findBrowser();

test('web apps: a page that draws passes with a screenshot; blank, broken assets, errors and missing elements fail', { timeout: 180_000 }, async () => {
  if (!browser) {
    const r = await runAppCheck({ url: 'good.html' }, where('none'));
    assert.match(r.problems.join(), /no Chrome, Chromium or Edge found/, 'without a browser the check fails loudly, never passes silently');
    return;
  }
  const good = await runAppCheck({ url: 'good.html', expect: 'canvas', waitMs: 300 }, where('good'));
  assert.deepEqual(good.problems, []);
  assert.ok(good.screenshot && existsSync(good.screenshot) && statSync(good.screenshot).size > 1000, 'a real screenshot is kept');
  assert.deepEqual((await runAppCheck({ url: 'webgl.html', expect: 'canvas', waitMs: 500 }, where('webgl'))).problems, [], 'WebGL draws headless too (a game renderer)');
  assert.match((await runAppCheck({ url: 'blank.html', expect: 'canvas', waitMs: 300 }, where('blank'))).problems.join('\n'), /"canvas" is blank/);
  assert.match((await runAppCheck({ url: 'broken-asset.html', expect: 'canvas', waitMs: 300 }, where('asset'))).problems.join('\n'), /villager\.png/, 'an asset that fails to load is named');
  assert.match((await runAppCheck({ url: 'throws.html', expect: 'canvas', waitMs: 300 }, where('throws'))).problems.join('\n'), /uncaught: ReferenceError: undefinedRenderer/);
  assert.match((await runAppCheck({ url: 'no-canvas.html', expect: 'canvas', waitMs: 300 }, where('missing'))).problems.join('\n'), /nothing matches "canvas"/);
  assert.deepEqual((await runAppCheck({ url: 'broken-asset.html', expect: 'canvas', waitMs: 300, allow: ['villager.png'] }, where('allowed'))).problems, [], 'allow ignores a known problem');
});

test('web apps: the app is started first; a 404 from it fails, and a server that dies says so', { timeout: 180_000 }, async () => {
  if (!browser) return;
  writeFileSync(
    join(dir, 'server.mjs'),
    `import { createServer } from 'node:http'; import { readFileSync } from 'node:fs';
createServer((q, s) => { try { s.end(readFileSync('.' + (q.url === '/' ? '/good.html' : q.url))); } catch { s.statusCode = 404; s.end('no'); } }).listen(5291);`,
  );
  page('good-with-missing.html', `${draw2d}<script src="/main.js"></script>`);
  assert.deepEqual((await runAppCheck({ start: 'node server.mjs', url: 'http://127.0.0.1:5291/', expect: 'canvas', waitMs: 300 }, where('served'))).problems, []);
  assert.match((await runAppCheck({ start: 'node server.mjs', url: 'http://127.0.0.1:5291/good-with-missing.html', expect: 'canvas', waitMs: 300 }, where('served-404'))).problems.join('\n'), /404 http:\/\/127\.0\.0\.1:5291\/main\.js/);
  assert.match((await runAppCheck({ start: 'node -e "process.exit(3)"', url: 'http://127.0.0.1:5292/', waitMs: 0 }, where('dies'))).problems.join('\n'), /exited \(3\) before/);
  assert.match((await runAppCheck({ start: 'node -e "setTimeout(() => {}, 1e6)"', url: 'http://127.0.0.1:5293/', waitMs: 0, readyMs: 1500 }, where('never'))).problems.join('\n'), /never answered/);
});

/** A real window: a WinForms form, drawn or left blank (Windows only; other platforms capture the screen). */
const form = (/** @type {string} */ title, /** @type {boolean} */ drawn) =>
  `powershell -NoProfile -Command "Add-Type -AssemblyName System.Windows.Forms; $f = New-Object Windows.Forms.Form; $f.Text = '${title}'; $f.BackColor = 'Navy'; ${drawn ? "foreach ($i in 0..11) { $p = New-Object Windows.Forms.Panel; $p.BackColor = [Drawing.Color]::FromArgb(($i * 20), (255 - $i * 20), 90); $p.SetBounds(($i * 25), ($i * 10), 40, 60); $f.Controls.Add($p) };" : ''} [void]$f.ShowDialog()"`;

test('desktop apps: the window is found and captured; blank windows, no window and crashes fail', { timeout: 180_000, skip: process.platform !== 'win32' && 'window capture by title is tested on Windows' }, async () => {
  const drawn = await runAppCheck({ start: form('wololo drawn', true), window: 'wololo drawn', waitMs: 1500 }, where('win-drawn'));
  assert.deepEqual(drawn.problems, []);
  assert.ok(drawn.screenshot && statSync(drawn.screenshot).size > 500);
  const blank = await runAppCheck({ start: form('wololo blank', false), window: 'wololo blank', waitMs: 1500 }, where('win-blank'));
  assert.match(blank.problems.join('\n'), /window is blank/);
  const crash = await runAppCheck({ start: 'node -e "console.error(\'Error: no GPU adapter\'); process.exit(2)"', window: '*', waitMs: 500 }, where('win-crash'));
  assert.match(crash.problems.join('\n'), /exited \(2\) without showing a window[\s\S]*no GPU adapter/);
  const none = await runAppCheck({ start: 'node -e "setTimeout(() => {}, 1e6)"', window: 'never-opens', waitMs: 500, readyMs: 1500 }, where('win-none'));
  assert.match(none.problems.join('\n'), /no window titled "never-opens"/);
});
