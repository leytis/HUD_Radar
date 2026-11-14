'use strict';
/*
 * Проверки службы. Запуск: node service/test/run.js
 * На головном устройстве Node 8.16, так что и проверки, и служба должны идти на нём (CI гоняет их на 8.16.2).
 */
const fs = require('fs'), os = require('os'), path = require('path');
const { spawn, spawnSync } = require('child_process');
const assert = require('assert');
const ROOT = path.join(__dirname, '..', '..');
const S = require('../src/hudradar.js');
const T = require('./tiles.js');

const tests = [];
const test = (name, fn) => tests.push([name, fn]);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'hudradar-'));
const until = async (what, fn, ms) => {
    const end = Date.now() + (ms || 8000);
    for (;;) { let v = null; try { v = fn(); } catch (e) { /* not yet */ } if (v) return v; if (Date.now() > end) throw new Error('timed out: ' + what); await sleep(100); }
};
const opaque = (img, x0, x1) => { let n = 0; for (let y = 0; y < S.OUT_H; y++) for (let x = x0; x < x1; x++) if (img[(y * S.OUT_W + x) * 4 + 3]) n++; return n; };

test('версии совпадают, собранный файл свежий', () => {
    const repo = JSON.parse(fs.readFileSync(path.join(ROOT, 'mgu-repo.json'), 'utf8'));
    const tool = repo.tools[0];
    assert.strictEqual(tool.version, S.VERSION, 'mgu-repo.json: версия службы');
    assert.ok(fs.existsSync(path.join(ROOT, tool.path, tool.service.exec)), 'нет собранного файла');
    const app = JSON.parse(fs.readFileSync(path.join(ROOT, 'apps', 'vs_hudradar', 'app.json'), 'utf8'));
    assert.ok(/^\d+\.\d+\.\d+$/.test(app.version));
    assert.ok(repo.apps.requires[tool.id], 'приложение должно требовать службу');
    const built = fs.readFileSync(path.join(ROOT, tool.path, tool.service.exec), 'utf8');
    const out = path.join(tmp(), 'hudradar');
    const r = spawnSync(process.execPath, [path.join(ROOT, 'service', 'build.js'), out]);
    assert.strictEqual(r.status, 0, String(r.stderr));
    assert.ok(fs.readFileSync(out, 'utf8') === built, 'service/prebuilt/hudradar устарел: node service/build.js');
});

test('плитка: пусто, предупреждение, чужой экран', () => {
    assert.strictEqual(S.classify(T.title(), T.idleBand(), T.mask).state, 'idle');
    const a = S.classify(T.noisy(T.title()), T.noisy(S.sampleBand()), T.mask);
    assert.strictEqual(a.state, 'alert'); assert.ok(a.leftOk);
    const black = Buffer.alloc(S.TITLE.w * S.TITLE.h * 4);
    assert.strictEqual(S.classify(black, S.sampleBand(), T.mask).state, 'unknown');
    // half-way between the two: neither
    const half = Buffer.from(T.idleBand()), al = S.sampleBand();
    for (let i = 0; i < half.length; i++) half[i] = (half[i] + al[i]) >> 1;
    assert.strictEqual(S.classify(T.title(), half, T.mask).state, 'unknown');
});

test('шум видео не считается сменой картинки, другая цифра считается', () => {
    const a = S.sampleBand();
    assert.ok(S.bandDiff(a, T.noisy(a)) <= 12);
    const b = Buffer.from(a);
    for (let y = 37; y < 65; y++) for (let x = 372; x < 392; x++) { const i = (y * S.BAND.w + x) * 4; b[i] = b[i + 1] = b[i + 2] = 20; }
    assert.ok(S.bandDiff(a, b) > 12);
});

test('что показывать: всё, значок и дистанция, только дистанция', () => {
    const band = S.sampleBand();
    const all = S.compose(band, true, null, 'all').image, icon = S.compose(band, true, null, 'icon').image, dist = S.compose(band, true, null, 'dist').image;
    assert.strictEqual(all.length, S.OUT_W * S.OUT_H * 4);
    const n = [all, icon, dist].map((i) => opaque(i, 0, S.OUT_W));
    assert.ok(n[0] > n[1] && n[1] > n[2] && n[2] > 200, n.join(' '));
    // centred: about as much on either side
    [all, icon, dist].forEach((img) => { let l = S.OUT_W, r = 0; for (let x = 0; x < S.OUT_W; x++) if (opaque(img, x, x + 1)) { l = Math.min(l, x); r = x; } assert.ok(Math.abs(l - (S.OUT_W - 1 - r)) <= 2, l + ' ' + r); });
    // the dark background is see-through
    const dark = Buffer.alloc(S.BAND.w * S.BAND.h * 4, 24);
    assert.strictEqual(opaque(S.compose(dark, false, null, 'all').image, 0, S.OUT_W), 0);
});

test('настройки: мусор не проходит, место на стекле считается', () => {
    assert.deepStrictEqual(S.clean({ mode: 'rm -rf', show: 7, size: 'x', pos: 1e9, bright: -5 }), { mode: 'auto', show: 'all', size: 85, pos: 120, bright: 10 });
    assert.deepStrictEqual(S.clean(null), S.clean({}));
    assert.deepStrictEqual(S.geometry(S.clean({ size: 85, pos: 0, bright: 100 })), { x: 230, y: 180, w: 340, h: 85, opacity: 1 });
    const g = S.geometry(S.clean({ size: 130, pos: '-60', bright: 30 }));
    assert.ok(g.x >= 0 && g.x + g.w <= 800 && g.y >= 0 && g.y + g.h <= 480 && g.opacity === 0.3);
});

test('запись от root не идёт по ссылке, чужой файл читается только обычный и маленький', () => {
    const d = tmp(), victim = path.join(d, 'victim'), f = path.join(d, 'status.json');
    fs.writeFileSync(victim, 'keep');
    fs.symlinkSync(victim, f + '.' + process.pid + '.tmp');
    S.writeWhole(f, '{"a":1}\n');
    assert.strictEqual(fs.readFileSync(victim, 'utf8'), 'keep');
    assert.deepStrictEqual(S.readSmallJson(f), { a: 1 });
    fs.symlinkSync(f, path.join(d, 'link.json'));
    assert.strictEqual(S.readSmallJson(path.join(d, 'link.json')), null);
    fs.writeFileSync(path.join(d, 'big.json'), JSON.stringify({ a: new Array(5000).join('x') }));
    assert.strictEqual(S.readSmallJson(path.join(d, 'big.json')), null);
    if (spawnSync('mkfifo', [path.join(d, 'pipe.json')]).status === 0) assert.strictEqual(S.readSmallJson(path.join(d, 'pipe.json')), null);
});

test('показ: вспышка не показывается, предупреждение держится, уходит с задержкой', async () => {
    const shown = [];
    const tr = new S.Tracker(T.mask, (img) => shown.push(img ? 1 : 0), () => {});
    const logs = process.stdout.write; process.stdout.write = () => true;
    try {
        tr.frame(T.title(), T.idleBand());
        tr.frame(T.title(), S.sampleBand()); tr.frame(T.title(), T.idleBand());      // a flash
        await sleep(300); tr.same();
        assert.deepStrictEqual(shown, []);
        tr.frame(T.title(), S.sampleBand()); await sleep(260); tr.same();
        assert.deepStrictEqual(shown, [1]);
        tr.frame(T.title(), T.noisy(S.sampleBand()));                                 // the same, but for noise
        assert.deepStrictEqual(shown, [1]);
        tr.frame(T.title(), T.idleBand()); await sleep(120); tr.same();
        assert.deepStrictEqual(shown, [1], 'ушло раньше времени');
        await sleep(300); tr.same();
        assert.deepStrictEqual(shown, [1, 0]);
        assert.strictEqual(tr.stats.alerts, 1);
    } finally { process.stdout.write = logs; }
});

test('служба целиком: режимы, настройки, пример, остановка', async () => {
    const d = tmp(), sock = path.join(d, 'cr.sock'), shm = path.join(d, 'shm'), cp = path.join(d, 'carplay');
    const status = () => JSON.parse(fs.readFileSync(path.join(shm, 'status.json'), 'utf8'));
    const control = (c) => { const f = path.join(shm, 'control', 'control.json'); fs.writeFileSync(f + '.tmp', JSON.stringify(c)); fs.renameSync(f + '.tmp', f); };
    fs.mkdirSync(path.join(d, 'state')); fs.writeFileSync(cp, '0');
    const crLog = [], svLog = [];
    const cr = spawn(process.execPath, [path.join(__dirname, 'fake-cluster-render.js'), sock]);
    cr.stdout.on('data', (b) => String(b).split('\n').forEach((l) => l && crLog.push(l)));
    await until('renderer up', () => crLog.length);
    const repo = JSON.parse(fs.readFileSync(path.join(ROOT, 'mgu-repo.json'), 'utf8')).tools[0];
    const sv = spawn(process.execPath, [path.join(ROOT, repo.path, repo.service.exec)], { env: Object.assign({}, process.env, {
        HR_SHM: shm, HR_STATE: path.join(d, 'state'), HR_CR_SOCKET: sock, HR_CARPLAY_FILE: cp, HR_PYTHON: path.join(__dirname, 'fake-capture.js') }) });
    sv.stdout.on('data', (b) => svLog.push(String(b))); sv.stderr.on('data', (b) => svLog.push(String(b)));
    try {
        let s = await until('first status', status);
        assert.strictEqual(s.mode, 'auto'); assert.strictEqual(s.hud, 'hidden'); assert.strictEqual(s.checkMs, 0);
        assert.strictEqual(fs.statSync(path.join(shm, 'control')).mode & 0o7777, 0o1777);
        assert.strictEqual(fs.statSync(shm).mode & 0o7777, 0o755);

        fs.writeFileSync(cp, '1');                                         // CarPlay on the display
        await until('slot held', () => status().hud === 'shown' && status().carplay);
        await until('a warning', () => status().tile === 'alert' && status().alerts >= 1, 12000);
        const frames = () => crLog.filter((l) => l[0] === 'F').length;
        assert.ok(frames() >= 2);

        control({ mode: 'auto', show: 'dist', size: 100, pos: '30', bright: 60, demo: 0 });
        await until('settings taken', () => status().show === 'dist');
        assert.ok(crLog.some((l) => l.indexOf('"w":400,"h":100,"opacity":0.6') > 0), 'место и яркость не дошли');
        assert.deepStrictEqual(JSON.parse(fs.readFileSync(path.join(d, 'state', 'config.json'), 'utf8')), { mode: 'auto', show: 'dist', size: 100, pos: 30, bright: 60 });

        fs.writeFileSync(cp, '0');                                         // BMW's menu: reading stops at once, the slot goes a little later
        await until('reading stopped', () => !status().carplay && status().checkMs === 0);
        assert.strictEqual(status().hud, 'shown', 'место отдано сразу');
        await until('slot given back', () => status().hud === 'hidden', 9000);

        control({ mode: 'off', show: 'dist', size: 100, pos: '30', bright: 60, demo: 0 });
        await until('off', () => status().mode === 'off');
        const before = frames();
        control({ mode: 'off', show: 'dist', size: 100, pos: '30', bright: 60, demo: 777 });
        await until('example', () => status().demo && status().hud === 'shown');
        assert.ok(frames() > before);
        await until('example over', () => !status().demo && status().hud === 'hidden', 12000);

        control({ mode: 'on', show: 'all', size: 85, pos: '0', bright: 100, demo: 777 });
        await until('always on', () => status().mode === 'on' && status().hud === 'shown' && status().checkMs > 0);
        assert.ok(!status().demo, 'старый запрос примера показан снова');
    } catch (e) { console.log(svLog.join('')); throw e; } finally {
        sv.kill('SIGTERM');
        await until('service gone', () => sv.exitCode !== null || sv.signalCode !== null);
        cr.kill();
    }
    assert.strictEqual(sv.exitCode, 0, 'служба должна выйти чисто');
    assert.ok(!fs.existsSync(path.join(shm, 'status.json')));
    assert.ok(crLog.some((l) => l.indexOf('"op":"drop"') > 0), 'слой не убран');
    assert.ok(svLog.join('').indexOf('error:') < 0, svLog.join(''));
});

(async () => {
    let failed = 0;
    for (const [name, fn] of tests) {
        try { await fn(); console.log('ok   ' + name); } catch (e) { failed++; console.log('FAIL ' + name + '\n' + (e && e.stack || e)); }
    }
    console.log(failed ? failed + ' failed' : 'all ' + tests.length + ' passed (node ' + process.version + ')');
    process.exit(failed ? 1 : 0);
})();
