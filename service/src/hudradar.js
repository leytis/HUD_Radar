'use strict';
/*
 * hudradar - служба: предупреждения приложения HUD Speed с дашборда CarPlay на проекции BMW (iDrive 7, MGU).
 *
 * Как устроено:
 *   hs-cap.py читает из видеопамяти плитку HUD Speed (только чтение, композитор не участвует);
 *   эта программа решает, есть ли на плитке предупреждение, вырезает значок, лимит и дистанцию, убирает тёмный
 *   фон и отправляет картинку в проекцию через cluster-render (инструмент из MGU Store).
 *   Цифры не распознаются: картинка переносится как есть. База камер остаётся в приложении HUD Speed.
 *
 * Управление (приложение Radar HUD):
 *   /dev/shm/hudradar/control/control.json   настройки от приложения: { mode, show, size, pos, bright, demo }
 *   /dev/shm/hudradar/status.json            что служба делает сейчас, раз в секунду
 *   <state>/config.json              последние настройки: с ними служба стартует, пока приложение не запущено
 *
 * Режимы: auto - место в проекции занято, пока на экране CarPlay; on - всегда; off - служба ничего не показывает
 * и экран не читает.
 *
 * Служба работает от root, а приложения на головном устройстве нет. Поэтому в папку, куда пишут приложения,
 * она сама ничего не пишет, а читает оттуда только небольшой обычный файл.
 *
 * Все отсчёты времени идут по монотонным часам: обычные головное устройство переводит по GPS, и они могут
 * прыгнуть назад.
 *
 * Служба никогда не завершается сама: её перезапускает systemd, а частые перезапуски он считает сбоем.
 * Node 8. В репозитории это исходник; в Store ставится один файл, собранный service/build.js.
 */
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const VERSION = '1.0.2';

/* ---------- ресурсы: в собранном файле они внутри него, при запуске из исходников лежат рядом ---------- */
/* global __BUNDLE */
const bundled = typeof __BUNDLE !== 'undefined';
function resource(name) { return bundled ? __BUNDLE.files[name] : fs.readFileSync(path.join(__dirname, name), 'utf8'); }
function clusterRenderClient() { return bundled ? __BUNDLE.clusterRender() : require('./cluster_render_client.js'); }

const SHM = process.env.HR_SHM || '/dev/shm/hudradar';
const STATE = process.env.HR_STATE || '/var/opt/hudradar/state';
const PYTHON = process.env.HR_PYTHON || '/var/opt/mgu-python/current/bin/python3';
const CR_SOCKET = process.env.HR_CR_SOCKET || '/dev/shm/cluster-render/render.sock';

/* ---------- геометрия (в точках плитки 600x236, плитка на экране в 1316,482) ---------- */
const TITLE = { x: 112, y: 26, w: 100, h: 32 };
const BAND = { x: 60, y: 96, w: 488, h: 100 };
const TITLE_BYTES = TITLE.w * TITLE.h * 4, BAND_BYTES = BAND.w * BAND.h * 4;
// внутри полосы BAND:
const R_TEAL = { x: 424, y: 20, w: 41, h: 56 };     // значок GPS: он есть, пока предупреждения нет
const R_DIST = { x: 320, y: 30, w: 168, h: 38 };    // дистанция
const R_ICON1 = { x: 10, y: 5, w: 91, h: 90 };      // первый значок
const SRC_LEFT = { x: 2, w: 236 };                  // значки и точки
const SRC_ICON = { x: 2, w: 104 };                  // только первый значок
const SRC_RIGHT = { x: 330, w: 158 };               // дистанция
const OUT_W = 400, OUT_H = BAND.h, GAP = 16;
const SCENE_W = 800, CENTRE_Y = 222;                // сцена проекции 800x480; здесь середина картинки при pos 0

const HOLD_MS = 4000;          // плитка закрыта окном BMW: столько держим последнее предупреждение
const STALE_MS = 150000;       // одно и то же предупреждение дольше этого не показываем
const ON_MS = 80;              // предупреждение должно продержаться на плитке столько, прежде чем попадёт на стекло
const OFF_MS = 1500;           // и столько плитка должна быть пустой, прежде чем оно уйдёт
const DEMO_MS = 8000;

const HOLD_OFF_MS = 5000;      // CarPlay ушёл с экрана: столько ещё держим место (короткий заход в меню BMW его не отдаёт)
const REMAKE_MS = [5000, 60000];   // слой отвергнут: когда пробовать снова

function log(s) { process.stdout.write(s + '\n'); }
/** Milliseconds on a clock that never jumps (the head unit's wall clock is set from GPS). */
function mono() { const t = process.hrtime(); return t[0] * 1000 + Math.floor(t[1] / 1e6); }

/* ---------- что на плитке ---------- */
function count(buf, bw, r, pred) {
    let n = 0;
    for (let y = r.y; y < r.y + r.h; y++) for (let x = r.x; x < r.x + r.w; x++) {
        const i = (y * bw + x) * 4;
        if (pred(buf[i + 2], buf[i + 1], buf[i])) n++;
    }
    return n;
}
const isWhite = (r, g, b) => r > 200 && g > 200 && b > 200;
const isTeal = (r, g, b) => g > 170 && b > 140 && r < 90;

/** The title's letters as a bit mask (1 = a light pixel). Mid-grey threshold: steady under the video's noise. */
function titleMask(title) {
    const m = Buffer.alloc(TITLE.w * TITLE.h);
    for (let i = 0; i < m.length; i++) m[i] = (title[i * 4 + 2] + title[i * 4 + 1] + title[i * 4] > 420) ? 1 : 0;
    return m;
}
function maskMatch(a, b) {
    let both = 0, any = 0;
    for (let i = 0; i < a.length; i++) { if (a[i] && b[i]) both++; if (a[i] || b[i]) any++; }
    return any ? both / any : 0;
}
/** How many pixels of two bands differ by more than the video's noise. One changed digit is a few hundred. */
function bandDiff(a, b) {
    let n = 0;
    for (let i = 0; i < a.length; i += 4) {
        const d0 = a[i] - b[i], d1 = a[i + 1] - b[i + 1], d2 = a[i + 2] - b[i + 2];
        if (d0 > 30 || d0 < -30 || d1 > 30 || d1 < -30 || d2 > 30 || d2 < -30) n++;
    }
    return n;
}
/**
 * What the tile shows: 'idle' (HUD Speed's logo and the GPS mark), 'alert' (a warning with its distance),
 * or 'unknown' (another screen, a BMW window over the tile, a frame caught mid-change).
 */
function classify(title, band, refMask) {
    const tm = maskMatch(titleMask(title), refMask);
    const teal = count(band, BAND.w, R_TEAL, isTeal);
    const dist = count(band, BAND.w, R_DIST, isWhite);
    const icon = count(band, BAND.w, R_ICON1, isWhite);
    const info = { title: Math.round(tm * 100) / 100, teal: teal, dist: dist, icon: icon, leftOk: icon >= 3500 };
    if (tm < 0.55) info.state = 'unknown';
    else if (teal >= 400) info.state = 'idle';
    else if (teal < 60 && dist >= 250) info.state = 'alert';
    else info.state = 'unknown';
    return info;
}

/* ---------- картинка для проекции ---------- */
/** Columns [x0, x1) of the band that hold anything lit, or null. */
function extent(band, x0, x1) {
    let a = -1, b = -1;
    for (let x = x0; x < x1; x++) {
        let lit = false;
        for (let y = 4; y < BAND.h - 4 && !lit; y += 2) {
            const i = (y * BAND.w + x) * 4;
            lit = band[i] > 70 || band[i + 1] > 70 || band[i + 2] > 70;
        }
        if (lit) { if (a < 0) a = x; b = x + 1; }
    }
    return a < 0 ? null : { x: a, w: b - a };
}
/** A part of the band as RGBA with the dark background see-through (dark is see-through on the glass). */
function cut(band, x0, w) {
    const out = Buffer.alloc(w * BAND.h * 4);
    for (let y = 0; y < BAND.h; y++) for (let x = 0; x < w; x++) {
        const s = (y * BAND.w + x0 + x) * 4, d = (y * w + x) * 4;
        const b = band[s], g = band[s + 1], r = band[s + 2], m = Math.max(r, g, b);
        const a = m <= 44 ? 0 : m >= 104 ? 255 : Math.round((m - 44) * 4.25);
        out[d] = r; out[d + 1] = g; out[d + 2] = b; out[d + 3] = a;
    }
    return { w: w, data: out };
}
/**
 * The picture for the glass (OUT_W x OUT_H RGBA): the icons and the distance moved together, centred.
 * show: 'all' (as on the tile), 'icon' (the first icon and the distance), 'dist' (the distance only).
 * keptLeft: the icons' part from the last frame that showed them whole, for when a BMW window covers them now.
 */
function compose(band, leftOk, keptLeft, show) {
    let left = null;
    if (show !== 'dist') {
        const src = show === 'icon' ? SRC_ICON : SRC_LEFT;
        if (leftOk) { const e = extent(band, src.x, src.x + src.w); if (e) left = cut(band, e.x, e.w); }
        else left = keptLeft || null;
    }
    const re = extent(band, SRC_RIGHT.x, SRC_RIGHT.x + SRC_RIGHT.w);
    const right = re ? cut(band, re.x, re.w) : null;
    const total = (left ? left.w : 0) + (left && right ? GAP : 0) + (right ? right.w : 0);
    const out = Buffer.alloc(OUT_W * OUT_H * 4);
    let x = Math.max(0, Math.floor((OUT_W - total) / 2));
    [left, right].forEach((p) => {
        if (!p) return;
        const w = Math.min(p.w, OUT_W - x);
        for (let y = 0; y < OUT_H && w > 0; y++) p.data.copy(out, (y * OUT_W + x) * 4, y * p.w * 4, (y * p.w + w) * 4);
        x += p.w + GAP;
    });
    return { image: out, left: left };
}

/* ---------- образец для кнопки «Пример», пока служба не видела настоящего предупреждения ---------- */
const FONT = {      // 5 x 7, по строкам
    '0': '01110,10001,10011,10101,11001,10001,01110', '5': '11111,10000,11110,00001,00001,10001,01110',
    '6': '00110,01000,10000,11110,10001,10001,01110', 'm': '00000,00000,10001,11011,10101,10001,10001',
};
/** A band laid out like the real tile's (a camera icon, a limit sign, the dots, the distance), drawn here. */
function sampleBand() {
    const b = Buffer.alloc(BAND_BYTES);
    for (let i = 0; i < b.length; i += 4) { b[i] = 26; b[i + 1] = 20; b[i + 2] = 17; b[i + 3] = 255; }
    const px = (x, y, r, g, bl) => { if (x >= 0 && y >= 0 && x < BAND.w && y < BAND.h) { const i = (y * BAND.w + x) * 4; b[i] = bl; b[i + 1] = g; b[i + 2] = r; } };
    const rect = (x0, y0, w, h, c) => { for (let y = y0; y < y0 + h; y++) for (let x = x0; x < x0 + w; x++) px(x, y, c[0], c[1], c[2]); };
    const disc = (cx, cy, r0, r1, c) => { for (let y = cy - r1; y <= cy + r1; y++) for (let x = cx - r1; x <= cx + r1; x++) { const d = Math.sqrt((x - cx) * (x - cx) + (y - cy) * (y - cy)); if (d >= r0 && d <= r1) px(x, y, c[0], c[1], c[2]); } };
    const glyph = (ch, x0, y0, k, c) => { FONT[ch].split(',').forEach((row, j) => row.split('').forEach((v, i) => { if (v === '1') rect(x0 + i * k, y0 + j * k, k, k, c); })); return 6 * k; };
    const WHITE = [255, 255, 255], BLACK = [20, 20, 20], RED = [226, 30, 40], GREEN = [60, 210, 90];
    rect(10, 6, 90, 88, WHITE);                                      // a camera, schematically
    rect(30, 34, 50, 34, BLACK); rect(42, 26, 18, 8, BLACK); disc(55, 51, 0, 10, WHITE); disc(55, 51, 0, 5, BLACK);
    rect(112, 6, 90, 88, WHITE);                                     // the limit sign
    disc(157, 50, 33, 40, RED);
    glyph('6', 139, 36, 4, BLACK); glyph('0', 159, 36, 4, BLACK);
    [28, 50, 72].forEach((y) => disc(226, y, 0, 4, GREEN));          // the dots
    let x = 372;                                                     // the distance, as the tile writes it
    '500'.split('').forEach((ch) => { x += glyph(ch, x, 37, 4, WHITE); });
    glyph('m', x + 6, 37, 4, WHITE);
    return b;
}

/* ---------- проекция ---------- */
const CLAIM_DIR = '/dev/shm/mgu-hud', CLAIM_ID = 'hudradar';
class Hud {
    constructor() {
        this.cr = null; this.layer = 0; this.geo = null; this.hold = false; this.image = null;
        this.visible = false; this.target = ''; this.holder = ''; this.disabled = false; this.claimTimer = null;
        this.remakeTimer = null; this.remakes = 0;
        this.blank = Buffer.alloc(OUT_W * OUT_H * 4);
    }
    start() {
        const ClusterRender = clusterRenderClient().ClusterRender;
        const cr = this.cr = new ClusterRender(CLAIM_ID, CR_SOCKET);
        cr.on('ready', () => {
            log('hud: connected to cluster-render (' + cr.backend + ')');
            if (!this.layer && this.geo && !this.remakeTimer) this._make();
            this._apply(true);
        });
        cr.on('disconnected', () => { this.target = ''; log('hud: cluster-render went away, reconnecting'); });
        cr.on('target', (name, state, holder, reason, guideDisabled, disabled) => {
            if (name !== 'hud') return;
            const was = this.target + (this.disabled ? '!' : '');
            this.target = state; this.holder = holder || ''; this.disabled = !!disabled;
            const now = state + (disabled ? '!' : '');
            if (now !== was) log('hud: target ' + (disabled ? 'disabled by the mapping guard' : state + (holder ? ' behind ' + holder : '')));
        });
        cr.on('layer', (ref, state, reason) => {
            if (ref !== this.layer) return;
            if (state === 'error') { log('hud: layer error' + (reason ? ' (' + reason + ')' : '')); this._remake(); }
            else if (state === 'shown') this.remakes = 0;
        });
        cr.on('refused', (op, ref, reason) => {
            log('hud: refused ' + op + ' ' + ref + ': ' + reason);
            if (ref && ref === this.layer && op === 'layer') this._remake();
        });
        cr.on('error', (e) => log('hud: ' + (e && e.message)));
        cr.connect();
    }
    _make() {
        const g = this.geo;
        this.layer = this.cr.image({ target: 'hud', klass: 'overlay', x: g.x, y: g.y, w: g.w, h: g.h, iw: OUT_W, ih: OUT_H,
            fps: 30, visible: false, opacity: g.opacity, sampling: 'bilinear' });
        this.visible = false;
    }
    /** The renderer refused the layer: drop it and make it again later (5 s, then once a minute). */
    _remake() {
        if (this.remakeTimer || !this.cr) return;
        try { if (this.layer) this.cr.drop(this.layer); } catch (e) { /* gone with the connection */ }
        this.layer = 0; this.visible = false; this._claim(false);
        const wait = REMAKE_MS[Math.min(this.remakes++, REMAKE_MS.length - 1)];
        this.remakeTimer = setTimeout(() => {
            this.remakeTimer = null;
            if (!this.cr || !this.cr.ready || this.layer || !this.geo) return;
            this._make(); this._apply(true);
        }, wait);
    }
    /** Where and how bright: { x, y, w, h, opacity }. */
    configure(geo) {
        this.geo = geo;
        if (!this.cr || !this.cr.ready) return;
        if (this.layer) this.cr.set(this.layer, geo); else if (!this.remakeTimer) this._make();
    }
    /** hold: keep the slot on the glass all the time (a clear picture when there is nothing to show). */
    setHold(on) { if (this.hold !== on) { this.hold = on; this._apply(false); } }
    /** The picture to show, or null for none. */
    show(image) { this.image = image; this._apply(true); }
    _apply(pixels) {
        const want = !!(this.hold || this.image);
        if (!this.cr || !this.cr.ready || !this.layer) return;
        if (want && (pixels || !this.visible)) this.cr.pixels(this.layer, null, this.image || this.blank);
        if (want !== this.visible) { this.cr.set(this.layer, { visible: want }); this.visible = want; this._claim(want); }
    }
    /**
     * For the status file: shown | waiting (BMW's own content has the slot: parked behind it, or giving way to a
     * pop-up) | starting | hidden (nothing asked for) | unavailable | disabled (the mapping guard) | off (no renderer).
     */
    state() {
        if (!this.cr || !this.cr.ready) return 'off';
        if (this.disabled) return 'disabled';
        if (!this.layer) return 'unavailable';
        if (!this.visible) return 'hidden';
        if (this.target === 'shown' || this.target === 'lingering') return 'shown';
        if (this.target === 'parked' || this.target === 'waiting') return 'waiting';
        if (this.target === 'unavailable') return 'unavailable';
        return 'starting';
    }
    stop() {
        if (this.remakeTimer) { clearTimeout(this.remakeTimer); this.remakeTimer = null; }
        this.hold = false; this.image = null; this._apply(false); this._claim(false);
        if (this.cr) { try { if (this.layer) this.cr.drop(this.layer); this.cr.removeAllListeners(); this.cr.close(); } catch (e) { /* closing */ } this.cr = null; }
    }
    /* другие приложения из Store уступают проекцию тому, чья заявка свежая (kit/runtime/hud_claim.js в idrive7-apps) */
    _claim(on) {
        const touch = (held) => {
            try {
                try { fs.mkdirSync(CLAIM_DIR); fs.chmodSync(CLAIM_DIR, 0o1777); } catch (e) { /* there */ }
                const f = path.join(CLAIM_DIR, CLAIM_ID), tmp = f + '.' + process.pid + '.tmp';   // .tmp: the others skip it
                writeNew(tmp, JSON.stringify({ held: held, at: Date.now() }) + '\n'); fs.renameSync(tmp, f);
            } catch (e) { /* no tmpfs */ }
        };
        if (this.claimTimer) { clearInterval(this.claimTimer); this.claimTimer = null; }
        touch(on);
        if (on) this.claimTimer = setInterval(() => touch(true), 2000);
    }
}

/* ---------- логика показа ---------- */
class Tracker {
    /** onPicture(image | null): the warning's picture changed, or there is none. onAlert(band): a warning began. */
    constructor(refMask, onPicture, onAlert) {
        this.ref = refMask; this.onPicture = onPicture; this.onAlert = onAlert; this.show = 'all';
        this.pending = null; this.state = 'none'; this.keptLeft = null; this.lastAlertAt = 0; this.shownSince = 0;
        this.shownBand = null; this.visible = false; this.candSince = 0; this.idleSince = 0; this.unknownLogged = false;
        this.stats = { frames: 0, alerts: 0, pictures: 0 };
    }
    /** A new picture of the tile. hs-cap.py sends one only once two reads in a row agreed. */
    frame(title, band) {
        this.stats.frames++;
        const info = classify(title, band, this.ref);
        this.pending = { info: info, band: Buffer.from(band) };
        this._commit(this.pending);
        this._tick();
    }
    /** The tile as last read, again. */
    same() { if (this.pending) this._commit(this.pending); this._tick(); }
    /** The screen cannot be read, or nobody is reading it. */
    lost() { this.pending = null; this._set('unknown'); this._tick(); }
    /** What to show changed ('all' | 'icon' | 'dist'): redraw the warning on the glass, if any. */
    setShow(show) {
        if (show === this.show) return;
        this.show = show; this.keptLeft = null;
        if (this.state === 'alert' && this.shownBand) { this.shownBand = null; if (this.pending) this._commit(this.pending); }
    }
    _put(image) { this.visible = !!image; this.onPicture(image); }
    _commit(p) {
        const st = p.info.state;
        if (st === 'alert') {
            const now = mono();
            this.idleSince = 0;
            if (this.state !== 'alert') {
                if (!this.candSince) this.candSince = now;
                if (now - this.candSince < ON_MS) return;          // a flash of a warning between two states is not shown
                this.stats.alerts++; log('alert on ' + JSON.stringify(p.info));
                if (p.info.leftOk) this.onAlert(p.band);
            }
            this.lastAlertAt = now;
            this.state = 'alert'; this.unknownLogged = false;
            /* the same warning as shown, but for the video's noise: nothing to send */
            const same = this.shownBand ? bandDiff(this.shownBand, p.band) <= 12 : false;
            if (same && this.visible && now - this.shownSince < STALE_MS) return;
            const c = compose(p.band, p.info.leftOk, this.keptLeft, this.show);
            if (p.info.leftOk) this.keptLeft = c.left;
            if (!same) { this.shownSince = now; this.stats.pictures++; }
            this.shownBand = p.band;
            this._put(now - this.shownSince < STALE_MS ? c.image : null);
        } else this._set(st, p.info);
    }
    _set(st, info) {
        this.candSince = 0;
        if (st === 'idle') {
            if (this.state === 'alert') {
                const now = mono();
                if (!this.idleSince) this.idleSince = now;
                if (now - this.idleSince < OFF_MS) return;
                log('alert off');
            }
            this.idleSince = 0;
            this.state = 'idle'; this.keptLeft = null; this.shownBand = null;
            if (this.visible) this._put(null);
        } else if (this.state === 'alert') {
            if (!this.unknownLogged) { log('tile hidden or changing ' + JSON.stringify(info || {})); this.unknownLogged = true; }
            return;                                              // _tick drops it after HOLD_MS
        } else this.state = 'unknown';
        this.unknownLogged = false;
    }
    _tick() {
        const now = mono();
        if (this.state === 'alert' && this.unknownLogged && now - this.lastAlertAt > HOLD_MS) {
            log('alert dropped: the tile stayed hidden');
            this.state = 'unknown'; this.keptLeft = null; this.shownBand = null; this.unknownLogged = false;
            if (this.visible) this._put(null);
        }
        if (this.state === 'alert' && this.visible && now - this.shownSince > STALE_MS) { log('alert dropped: unchanged too long'); this._put(null); }
    }
    /** Forget everything (the capture stopped). */
    reset() {
        this.pending = null; this.state = 'none'; this.keptLeft = null; this.shownBand = null; this.candSince = 0; this.idleSince = 0;
        this.unknownLogged = false;
        if (this.visible) this._put(null);
    }
}

/* ---------- настройки ---------- */
const DEFAULTS = { mode: 'auto', show: 'all', size: 85, pos: 0, bright: 100 };
function clean(c) {
    const o = Object.assign({}, DEFAULTS);
    if (!c || typeof c !== 'object') return o;
    if (['auto', 'on', 'off'].indexOf(c.mode) >= 0) o.mode = c.mode;
    if (['all', 'icon', 'dist'].indexOf(c.show) >= 0) o.show = c.show;
    const num = (v, lo, hi, d) => { const n = Number(v); return isFinite(n) ? Math.min(hi, Math.max(lo, n)) : d; };
    o.size = num(c.size, 40, 160, o.size); o.pos = num(c.pos, -120, 120, o.pos); o.bright = num(c.bright, 10, 100, o.bright);
    return o;
}
function readJson(file) { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { return null; } }
/**
 * A new file, never through a link: this runs as root and some folders it writes in are open to every app, where a
 * link left under the name would send the write anywhere.
 */
function writeNew(file, data) {
    try { fs.unlinkSync(file); } catch (e) { /* none */ }
    const fd = fs.openSync(file, 'wx', 0o644);             // O_EXCL: fails on anything there, a link included
    const b = Buffer.isBuffer(data) ? data : Buffer.from(String(data));
    try { fs.writeSync(fd, b, 0, b.length); } finally { fs.closeSync(fd); }
}
/** A file written whole or not at all: a new file renamed over the old one. */
function writeWhole(file, data) { const tmp = file + '.' + process.pid + '.tmp'; writeNew(tmp, data); fs.renameSync(tmp, file); }
/** A small plain file's JSON, or null: what an app left for us is read only if it is that (no link, no pipe). */
function readSmallJson(file) {
    try {
        const st = fs.lstatSync(file);
        if (!st.isFile() || st.size > 4096) return null;
        return JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch (e) { return null; }
}
function geometry(cfg) {
    const k = cfg.size / 100, w = Math.round(OUT_W * k), h = Math.round(OUT_H * k);
    return { x: Math.round((SCENE_W - w) / 2), y: Math.round(CENTRE_Y + cfg.pos - h / 2), w: w, h: h, opacity: Math.round(cfg.bright) / 100 };
}

/* ---------- CarPlay на экране? ---------- */
/**
 * While CarPlay is on the display, the head unit's carplay process runs its video decoder (threads named
 * NmeVideoDevice, NmePlayback); it stops them when the display goes to BMW's own menu. HR_CARPLAY_FILE: a test's
 * stand-in, a file holding 1 or 0.
 */
let carplayPid = 0;
function carplayOnScreen() {
    if (process.env.HR_CARPLAY_FILE) { try { return fs.readFileSync(process.env.HR_CARPLAY_FILE, 'utf8').trim() === '1'; } catch (e) { return false; } }
    const comm = (p) => { try { return fs.readFileSync(p, 'utf8').trim(); } catch (e) { return ''; } };
    if (!carplayPid || comm('/proc/' + carplayPid + '/comm') !== 'carplay') {
        carplayPid = 0;
        let pids = [];
        try { pids = fs.readdirSync('/proc').filter((d) => /^\d+$/.test(d)); } catch (e) { return false; }
        for (let i = 0; i < pids.length; i++) if (comm('/proc/' + pids[i] + '/comm') === 'carplay') { carplayPid = Number(pids[i]); break; }
        if (!carplayPid) return false;
    }
    let tasks = [];
    try { tasks = fs.readdirSync('/proc/' + carplayPid + '/task'); } catch (e) { return false; }
    for (let i = 0; i < tasks.length; i++) if (/^Nme(VideoDevice|Playback)/.test(comm('/proc/' + carplayPid + '/task/' + tasks[i] + '/comm'))) return true;
    return false;
}

/* ---------- служба ---------- */
function main() {
    log('hudradar ' + VERSION + (bundled ? '' : ' (from source)'));
    /*
     * SHM is ours alone (root, 0755): the status file. SHM/control is open to every app (1777, as /tmp): the app
     * leaves its settings there. An app that ran before us may have made SHM itself: it is taken over.
     */
    const CONTROL_DIR = path.join(SHM, 'control');
    const CONTROL = path.join(CONTROL_DIR, 'control.json'), STATUS = path.join(SHM, 'status.json');
    const CONFIG = path.join(STATE, 'config.json'), LAST = path.join(STATE, 'last-band.bin');
    const folder = (dir, mode) => {
        try { fs.mkdirSync(dir); } catch (e) { /* there */ }
        try {
            if (fs.lstatSync(dir).isSymbolicLink()) { fs.unlinkSync(dir); fs.mkdirSync(dir); }
            if (process.getuid && process.getuid() === 0) fs.chownSync(dir, 0, 0);
            fs.chmodSync(dir, mode);
        } catch (e) { log('folder ' + dir + ': ' + e.message); }
    };
    folder(SHM, 0o755); folder(CONTROL_DIR, 0o1777);
    try { fs.mkdirSync(STATE); } catch (e) { /* there, or its parent is missing */ }

    const refMask = Buffer.from(resource('title-mask.b64').trim(), 'base64');
    let cfg = clean(readJson(CONFIG));
    let error = '', carplay = false, carplaySeenAt = -1e9, capture = null, restarts = 0, retryAt = 0, stopping = false;
    let demoUntil = 0, alertImage = null, checkMs = 0;
    // a request for the example left from before this start is not one to show now
    const before = readSmallJson(CONTROL);
    let demoSeen = before && Number(before.demo) || 0;

    const hud = new Hud();
    const present = () => {                    // what goes on the glass: the example while it runs, else the warning
        if (mono() < demoUntil) return;
        hud.show(cfg.mode === 'off' ? null : alertImage);
    };
    const tracker = new Tracker(refMask, (image) => { alertImage = image; present(); }, (band) => {
        // keep one real warning for the Example button: this car's own, never shipped
        try { if (!fs.existsSync(LAST) || Date.now() - fs.statSync(LAST).mtimeMs > 86400000) writeWhole(LAST, band); } catch (e) { /* no state folder */ }
    });
    tracker.show = cfg.show;
    hud.configure(geometry(cfg));
    try { hud.start(); } catch (e) { error = 'Не установлен Cluster renderer из MGU Store'; log('hud: ' + e.message); }

    /* --- захват: скрипт идёт интерпретатору аргументом, файла на диске у него нет --- */
    const capScript = resource('hs-cap.py');
    function startCapture() {
        if (!fs.existsSync(PYTHON)) { error = 'Не установлен Python (mgu-python) из MGU Store'; retryAt = mono() + 30000; return; }
        const child = capture = spawn(PYTHON, ['-c', capScript, process.env.HR_PERIOD || '50'], { stdio: ['ignore', 'pipe', 'pipe'] });
        const startedAt = mono();
        let buf = Buffer.alloc(0), sum = 0, n = 0;
        child.stdout.on('data', (d) => {
            buf = buf.length ? Buffer.concat([buf, d]) : d;
            for (;;) {
                if (buf.length < 16) break;
                if (buf.toString('latin1', 0, 4) !== 'HSF1') { log('capture: stream out of step'); buf = Buffer.alloc(0); child.kill(); return; }
                const flags = buf.readUInt32LE(12), need = 16 + (flags === 0 ? TITLE_BYTES + BAND_BYTES : 0);
                if (buf.length < need) break;
                sum += buf.readUInt32LE(8) / 10; n++;
                if (n >= 20) { checkMs = Math.round(sum / n * 10) / 10; sum = 0; n = 0; }
                if (error && error.indexOf('Python') >= 0) error = '';
                if (flags === 0) tracker.frame(buf.slice(16, 16 + TITLE_BYTES), buf.slice(16 + TITLE_BYTES, need));
                else if (flags === 1) tracker.same();
                else if (flags === 2) tracker.lost();              // 3: the frame was being redrawn, nothing learnt
                buf = buf.slice(need);
            }
        });
        child.stderr.on('data', (d) => String(d).split('\n').forEach((l) => { if (l) log(l); }));
        child.on('error', (e) => log('capture: ' + e.message));
        child.on('exit', (code, sig) => {
            if (child.wanted || stopping) return;
            if (capture === child) capture = null;
            tracker.reset(); checkMs = 0;
            log('capture exited (' + (sig || code) + ')');
            if (mono() - startedAt > 600000) restarts = 0;          // it had run well: an exit now is a new story
            if (code === 3) { error = 'Чтение экрана слишком нагружает головное устройство: пауза 10 минут'; retryAt = mono() + 600000; }
            else if (++restarts > 30) { error = 'Чтение экрана не запускается: пауза 10 минут'; retryAt = mono() + 600000; restarts = 0; }
            else retryAt = mono() + 5000;
        });
    }
    /** Stop reading the display (the mode, or CarPlay left it). The next start reads the tile afresh. */
    function stopCapture() {
        if (!capture) return;
        const child = capture; capture = null; child.wanted = true;
        try { child.kill(); } catch (e) { /* gone */ }
        tracker.reset(); checkMs = 0;
    }

    /* --- пример --- */
    function demo() {
        let band = null;
        try { const b = fs.readFileSync(LAST); if (b.length === BAND_BYTES) band = b; } catch (e) { /* none kept yet */ }
        if (!band) band = sampleBand();
        demoUntil = mono() + DEMO_MS;
        hud.show(compose(band, true, null, cfg.show).image);
        log('example on the glass');
        setTimeout(() => { if (mono() >= demoUntil) { demoUntil = 0; present(); } }, DEMO_MS + 50);
    }

    /* --- раз в полсекунды: настройки, CarPlay, что должно работать --- */
    let controlStamp = '', lastCarplayCheck = -1e9, lastStatus = -1e9;
    function tick() {
        const now = mono();
        let stamp = '';
        try { const st = fs.lstatSync(CONTROL); stamp = st.ino + ':' + st.mtimeMs + ':' + st.size; } catch (e) { /* the app has not run since the start */ }
        if (stamp && stamp !== controlStamp) {
            controlStamp = stamp;
            const raw = readSmallJson(CONTROL);
            if (raw && typeof raw === 'object') {
                const next = clean(raw);
                if (JSON.stringify(next) !== JSON.stringify(cfg)) {
                    log('settings ' + JSON.stringify(next));
                    cfg = next;
                    hud.configure(geometry(cfg)); tracker.setShow(cfg.show);
                    try { writeWhole(CONFIG, JSON.stringify(cfg) + '\n'); } catch (e) { log('config: ' + e.message); }
                    present();
                }
                const d = Number(raw.demo) || 0;
                if (d && d !== demoSeen) { demoSeen = d; demo(); }
            }
        }

        if (now - lastCarplayCheck >= 1500) {
            lastCarplayCheck = now;
            const c = carplayOnScreen();
            if (c !== carplay) { carplay = c; log('carplay ' + (c ? 'on' : 'off') + ' the display'); }
            if (c) carplaySeenAt = now;
        }
        const demoOn = now < demoUntil;
        /*
         * Auto keeps the slot a little after CarPlay leaves the display: a look into BMW's menu and back does not
         * hand it over. Each hand-over is a new mapping for the cluster, and with BMW's route running ours waits
         * behind its card afterwards (cluster-render's README, "Arbitration").
         */
        hud.setHold(demoOn || cfg.mode === 'on' || (cfg.mode === 'auto' && (carplay || now - carplaySeenAt < HOLD_OFF_MS)));
        if (cfg.mode === 'on' || (cfg.mode === 'auto' && carplay)) {            // read the display at all?
            if (!capture && now >= retryAt) { if (error.indexOf('пауза') >= 0) error = ''; startCapture(); }
        } else stopCapture();

        if (now - lastStatus >= 1000) {
            lastStatus = now;
            const st = {
                version: VERSION, mode: cfg.mode, show: cfg.show, carplay: carplay,
                tile: tracker.state === 'none' ? 'unknown' : tracker.state, hud: hud.state(), holder: hud.holder, demo: demoOn,
                alerts: tracker.stats.alerts, pictures: tracker.stats.pictures, checkMs: capture ? checkMs : 0,
                error: error, at: Date.now(),
            };
            try { writeWhole(STATUS, JSON.stringify(st) + '\n'); } catch (e) { /* no tmpfs */ }
        }
    }
    setInterval(() => { try { tick(); } catch (e) { log('tick: ' + (e && e.stack || e)); } }, 500);
    setInterval(() => log('alive: mode ' + cfg.mode + ', carplay ' + (carplay ? 'on' : 'off') + ', tile ' + tracker.state + ', hud ' + hud.state() +
        ', ' + tracker.stats.alerts + ' alerts, ' + tracker.stats.pictures + ' pictures, check ' + checkMs + ' ms'), 600000);

    const finish = () => {                                            // systemd stops the service: leave cleanly
        if (stopping) return; stopping = true;
        log('stopping');
        if (capture) { try { capture.kill(); } catch (e) { /* gone */ } }
        try { hud.stop(); } catch (e) { /* the renderer is gone */ }
        try { fs.unlinkSync(STATUS); } catch (e) { /* none */ }
        setTimeout(() => process.exit(0), 300);
    };
    process.on('SIGINT', finish); process.on('SIGTERM', finish);
    // any other trouble is logged and lived through: an exit would only have systemd start the service again
    process.on('uncaughtException', (e) => { log('error: ' + (e && e.stack || e)); });
    process.on('unhandledRejection', (e) => { log('error: ' + (e && e.stack || e)); });
}

module.exports = { classify, compose, titleMask, bandDiff, sampleBand, clean, geometry, Tracker, Hud, writeNew, writeWhole, readSmallJson, mono,
    BAND, TITLE, OUT_W, OUT_H, VERSION };
if (require.main === module || bundled) main();
