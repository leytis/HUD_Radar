'use strict';
/* Стенд: притворяется службой cluster-render. Печатает, что ему прислали. Сокет: первый аргумент. */
const net = require('net'), fs = require('fs');
const P = process.argv[2];
try { fs.unlinkSync(P); } catch (e) { /* none */ }
net.createServer((c) => {
    let buf = Buffer.alloc(0);
    const ev = (o) => { const b = Buffer.from(JSON.stringify(o)); const m = Buffer.alloc(5 + b.length); m.writeUInt32LE(b.length + 1, 0); m[4] = 0x4a; b.copy(m, 5); c.write(m); };
    c.on('data', (d) => {
        buf = Buffer.concat([buf, d]);
        while (buf.length >= 5) {
            const len = buf.readUInt32LE(0);
            if (buf.length < 4 + len) break;
            const t = buf[4], body = buf.slice(5, 4 + len);
            buf = buf.slice(4 + len);
            if (t === 0x4a) {
                const o = JSON.parse(body);
                console.log('J ' + JSON.stringify(o));
                if (o.op === 'hello') ev({ ev: 'hello', proto: 1, backend: 'fake', targets: 'map:1088x480,panel:1920x720,hud:800x480' });
                if (o.op === 'set' && o.visible === 1) { ev({ ev: 'target', target: 'hud', state: 'shown' }); ev({ ev: 'layer', ref: o.ref, state: 'shown' }); }
                if (o.op === 'set' && o.visible === 0) ev({ ev: 'target', target: 'hud', state: 'idle' });
            } else if (t === 0x46) console.log('F ' + body.readUInt32LE(0) + ' ' + body.length);
        }
    });
    c.on('error', () => {});
}).listen(P, () => console.log('up'));
