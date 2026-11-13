'use strict';
/* Нарисованные плитки для проверок. Настоящих картинок HUD Speed в репозитории нет. */
const fs = require('fs'), path = require('path');
const S = require(path.join(__dirname, '..', 'src', 'hudradar.js'));
const mask = Buffer.from(fs.readFileSync(path.join(__dirname, '..', 'src', 'title-mask.b64'), 'utf8').trim(), 'base64');

/** The title region as the service's mask has it: light where the letters are. */
function title() {
    const b = Buffer.alloc(S.TITLE.w * S.TITLE.h * 4);
    for (let i = 0; i < mask.length; i++) { const v = mask[i] ? 235 : 22; b[i * 4] = v; b[i * 4 + 1] = v; b[i * 4 + 2] = v; b[i * 4 + 3] = 255; }
    return b;
}
/** A band with nothing but the teal mark where the tile shows its GPS sign: no warning. */
function idleBand() {
    const b = Buffer.alloc(S.BAND.w * S.BAND.h * 4);
    for (let i = 0; i < b.length; i += 4) { b[i] = 26; b[i + 1] = 20; b[i + 2] = 17; b[i + 3] = 255; }
    for (let y = 24; y < 72; y++) for (let x = 428; x < 462; x++) { const i = (y * S.BAND.w + x) * 4; b[i] = 190; b[i + 1] = 210; b[i + 2] = 40; }
    return b;
}
/** The same picture as a video frame brings it: every level a little off. */
function noisy(d) {
    const o = Buffer.from(d);
    for (let i = 0; i < o.length; i++) { if (i % 4 === 3) continue; const v = o[i] + Math.floor(Math.random() * 13) - 6; o[i] = v < 0 ? 0 : v > 255 ? 255 : v; }
    return o;
}
module.exports = { title, idleBand, noisy, mask };
