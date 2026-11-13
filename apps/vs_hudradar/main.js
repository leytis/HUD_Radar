'use strict';
/**
 * Radar HUD - пульт службы hudradar.
 *
 * Служба (инструмент «Radar HUD service» из того же источника) читает плитку HUD Speed с дашборда CarPlay
 * и показывает предупреждение на проекции. Это приложение только управляет ею и показывает, что она делает:
 *
 *   настройки  -> /dev/shm/hudradar/control/control.json   (служба читает и запоминает их у себя)
 *   состояние  <- /dev/shm/hudradar/status.json            (служба пишет раз в секунду)
 *
 * Обе папки делает служба. Приложение их не создаёт: нет папки - значит, служба не запущена.
 *
 * Приложению не нужно работать постоянно: служба стартует вместе с головным устройством с последними настройками.
 */
const fs = require('fs');
const path = require('path');
const mgu = require('./kit/mgu');
const G = require('./kit/gauges');

const DIR = '/dev/shm/hudradar';
const CONTROL = path.join(DIR, 'control', 'control.json');
const STATUS = path.join(DIR, 'status.json');
const W = 1600, H = 520;
const MODES = ['auto', 'on', 'off'];
const MODE_NAME = { auto: 'Авто', on: 'Включено', off: 'Выключено' };
const SHOW_NAME = { all: 'всё как на плитке', icon: 'значок и дистанция', dist: 'только дистанция' };

mgu.run({
    async start(ctx) {
        const { ui, settings, log } = ctx;
        let demo = 0, note = '', noteUntil = 0;
        // the head unit's wall clock is set from GPS and can jump: what is timed here runs on this one
        const mono = () => { const t = process.hrtime(); return t[0] * 1000 + Math.floor(t[1] / 1e6); };

        /** The settings as the service takes them; written whole (a temp file renamed over the old one). */
        function send() {
            const c = {
                mode: settings.get('mode'), show: settings.get('show'),
                size: Number(settings.get('size')), pos: Number(settings.get('pos')), bright: Number(settings.get('bright')),
                demo: demo, at: Date.now(),
            };
            try {
                const tmp = CONTROL + '.' + process.pid + '.tmp';
                fs.writeFileSync(tmp, JSON.stringify(c) + '\n');
                fs.renameSync(tmp, CONTROL);
                return true;
            } catch (e) {
                log.warn('control: ' + e.message);
                return false;
            }
        }
        /** What the service last said, or null when it is not there or went quiet (nothing new for 5 s). */
        let lastAt = 0, lastAtSeen = 0;
        function status() {
            try {
                const s = JSON.parse(fs.readFileSync(STATUS, 'utf8'));
                if (!s || typeof s !== 'object') return null;
                if (s.at !== lastAt) { lastAt = s.at; lastAtSeen = mono(); }
                return mono() - lastAtSeen < 5000 ? s : null;
            } catch (e) { return null; }
        }
        const say = (text) => { note = text; noteUntil = mono() + 4000; };

        settings.onChange(() => { send(); });
        ui.onClick('BTN_MODE', () => {
            const next = MODES[(MODES.indexOf(settings.get('mode')) + 1) % MODES.length];
            settings.set('mode', next);
            send();
            say('Режим: ' + MODE_NAME[next]);
        });
        ui.onClick('BTN_DEMO', () => {
            demo = Date.now();
            if (!send()) say('Служба не запущена: пример показать некому');
            else if (settings.get('mode') === 'off') say('Режим «Выключено»: пример всё равно покажется на 8 секунд');
            else say('Пример на проекции, 8 секунд');
        });
        send();
        setInterval(send, 15000);          // the folder is on tmpfs: a restarted service finds the settings again

        /** The headline and the hint under it for what the service reports. */
        function headline(s, t) {
            if (!s) {
                return ['Служба не отвечает', t.crit,
                    'Перезагрузите головное устройство: служба стартует с первого запуска после установки.'];
            }
            if (s.error) return ['Служба не может работать', t.crit, String(s.error)];
            if (s.hud === 'off') return ['Нет связи с Cluster renderer', t.crit, 'Установите или обновите Cluster renderer в MGU Store.'];
            if (s.hud === 'disabled') {
                return ['Проекция отключена защитой', t.crit,
                    'Cluster renderer отключил вывод на проекцию после сбоев дисплея. Сброс по SSH: cluster-render guard-reset'];
            }
            if (s.demo) return ['Пример на проекции', t.accent, 'Так выглядит предупреждение с текущими настройками.'];
            if (s.mode === 'off') return ['Выключено', t.dim, 'Предупреждения на проекцию не выводятся. Кнопка «Режим» включает.'];
            if (!s.carplay) {
                return ['Ждёт CarPlay', t.dim, s.mode === 'on' ?
                    'Место в проекции занято. Предупреждения появятся, когда на экране будет дашборд CarPlay.' :
                    'Проекция свободна. Служба включится, когда на экране появится CarPlay.'];
            }
            if (s.tile === 'alert' && s.hud === 'waiting') {
                return ['Камера впереди, но место занято', t.warn, 'Проекцию сейчас держит BMW: своя навигация или всплывающее окно.'];
            }
            if (s.tile === 'alert') return ['Предупреждение на проекции', t.warn, 'HUD Speed показывает камеру.'];
            if (s.tile === 'idle') return ['Готово', '#2fd27a', 'Плитка HUD Speed видна, камер впереди нет.'];
            return ['Не вижу плитку HUD Speed', t.warn,
                'Откройте дашборд CarPlay (экран с плитками). HUD Speed должен работать на телефоне в фоне.'];
        }
        const HUD_NAME = { shown: 'занята службой', waiting: 'занята BMW, ждём', starting: 'запрашиваем', hidden: 'свободна',
            unavailable: 'недоступна', disabled: 'отключена защитой', off: 'нет связи' };

        ctx.loop('MAIN', 2, () => {
            const t = ctx.theme(), s = status();
            const cv = ctx.canvas(W, H).clear(t.bg);
            G.frame(cv, t, ['Radar HUD'], 0, []);
            const head = headline(s, t);
            cv.text(head[0], 60, 150, 64, head[1], { font: 'bold' });
            cv.text(head[2], 60, 205, 28, t.dim, { font: 'label' });

            const rows = [
                ['Режим', MODE_NAME[settings.get('mode')] || '?'],
                ['Показывать', SHOW_NAME[settings.get('show')] || '?'],
                ['Размер и яркость', settings.get('size') + ' %, ' + settings.get('bright') + ' %'],
            ];
            const right = s ? [
                ['Проекция', HUD_NAME[s.hud] || String(s.hud || '?')],
                ['Предупреждений с запуска', String(s.alerts || 0)],
                ['Проверка плитки', s.checkMs ? s.checkMs + ' мс' : 'на паузе'],
            ] : [];
            const col = (list, x) => list.forEach((r, i) => {
                const y = 282 + i * 74;
                cv.text(r[0], x, y, 24, t.dim, { font: 'label' });
                cv.text(r[1], x, y + 36, 34, t.text, { font: 'bold' });
            });
            col(rows, 60); col(right, 860);

            if (mono() < noteUntil) {
                const w = cv.textWidth(note, 28, { font: 'bold' }) + 56;
                cv.roundRect(W - 60 - w, 98, w, 52, 26, t.accent);
                cv.text(note, W - 60 - w / 2, 134, 28, t.bg, { font: 'bold', align: 'center' });
            }
            cv.text('служба ' + (s && s.version ? s.version : 'не найдена') + ' · приложение ' + ctx.spec.version,
                W - 60, 500, 20, t.dim, { font: 'label', align: 'right' });
            return ui.image('MAIN_GFX', cv);
        });
    },
});
