#!/usr/bin/env node
'use strict';
/*
 * Стенд: вместо python с hs-cap.py. Шлёт тот же поток, что и он, из нарисованных плиток:
 * пусто, предупреждение 500 м, то же с шумом видео, пусто. И так по кругу.
 */
const path = require('path');
const S = require(path.join(__dirname, '..', 'src', 'hudradar.js'));
const T = require('./tiles.js');
let seq = 0;
const hdr = (flags) => { const b = Buffer.alloc(16); b.write('HSF1', 0, 'latin1'); b.writeUInt32LE(++seq, 4); b.writeUInt32LE(102, 8); b.writeUInt32LE(flags, 12); return b; };
const steps = [];
const frame = (band) => steps.push(() => process.stdout.write(Buffer.concat([hdr(0), T.title(), T.noisy(band)])));
const same = (n) => { for (let i = 0; i < n; i++) steps.push(() => process.stdout.write(hdr(i === 2 ? 3 : 1))); };
frame(T.idleBand()); same(6);
frame(S.sampleBand()); same(12);
frame(S.sampleBand()); same(12);
frame(T.idleBand()); same(30);
let i = 0;
setInterval(() => { steps[i++ % steps.length](); }, 100);
