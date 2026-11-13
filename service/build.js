'use strict';
/*
 * Собирает службу в один исполняемый файл service/prebuilt/hudradar: MGU Store ставит инструмент одним файлом.
 * Внутрь попадают hudradar.js, клиент cluster-render, скрипт чтения экрана и маска заголовка плитки.
 *
 *   node service/build.js
 */
const fs = require('fs');
const path = require('path');

const src = path.join(__dirname, 'src'), out = path.join(__dirname, 'prebuilt', 'hudradar');
const read = (n) => fs.readFileSync(path.join(src, n), 'utf8');
const files = { 'hs-cap.py': read('hs-cap.py'), 'title-mask.b64': read('title-mask.b64').trim() };

const text = '#!/usr/bin/node\n' +
    '// Собрано service/build.js из service/src. Правьте исходники, не этот файл.\n' +
    '// cluster_render_client.js: MPL-2.0, (C) 2026 Robert Nisipeanu, https://github.com/robertnisipeanu/idrive-apps\n' +
    "'use strict';\n" +
    'const __BUNDLE = {\n' +
    '    files: ' + JSON.stringify(files) + ',\n' +
    '    clusterRender: function () { const module = { exports: {} }; (function (module, exports) {\n' +
    read('cluster_render_client.js') + '\n' +
    '    })(module, module.exports); return module.exports; },\n' +
    '};\n' +
    '(function () {\n' + read('hudradar.js') + '\n})();\n';

fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, text);
fs.chmodSync(out, 0o755);
console.log(out + ': ' + text.length + ' bytes');
