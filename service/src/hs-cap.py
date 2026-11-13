#!/var/opt/mgu-python/current/bin/python3
"""
hs-cap.py - читает из видеопамяти две маленькие области плитки HUD Speed на дашборде CarPlay
и пишет их в stdout для службы hudradar. Только читает: композитор и экран не трогает.

Запись в stdout (little-endian):
  16 байт заголовка: b'HSF1', номер, время этой проверки в десятых долях мс, флаги (0 - кадр с данными, 1 - без изменений, 2 - экран не найден,
  3 - кадр не удалось прочитать целиком, композитор его перерисовывал)
  при флаге 0 следом идут пиксели BGRA: заголовок плитки (TITLE), затем полоса с предупреждением (BAND)

  python3 hs-cap.py [период_мс=100]

Каждый период читается только маленькая область PROBE (около 2 мс). Плитка целиком читается, когда PROBE
изменилась, и отправляется после того, как два чтения подряд совпали: кадр, пойманный посреди смены, не уходит.
"""
import ctypes, fcntl, mmap, os, struct, sys, time
from operator import sub

def _ioc(d, nr, size): return (d << 30) | (size << 16) | (0x64 << 8) | nr
def IOWR(nr, size): return _ioc(3, nr, size)
def IOW(nr, size): return _ioc(1, nr, size)

GETRESOURCES = IOWR(0xA0, 64)
GETCRTC = IOWR(0xA1, 104)
GETPLANERES = IOWR(0xB5, 16)
GETPLANE = IOWR(0xB6, 32)
GETFB = IOWR(0xAD, 28)
SET_CLIENT_CAP = IOW(0x0D, 16)
GEM_CLOSE = IOW(0x09, 8)
I915_MMAP_GTT = IOWR(0x64, 16)

SCREEN = (1920, 720)
TILE_X, TILE_Y = 1316, 482                 # плитка на экране
TITLE = (112, 26, 100, 32)                 # x, y, w, h внутри плитки: буквы "D Speed"
BAND = (60, 96, 488, 100)                  # значки, точки, дистанция
PROBE = (380, 116, 168, 56)                # дистанция и значок GPS: по этой области видно, что плитка изменилась
PERIOD = (int(sys.argv[1]) if len(sys.argv) > 1 else 100) / 1000.0
FULL_EVERY = 2.0                           # с, как часто перечитывать плитку целиком, даже если PROBE не менялась
SETTLE = 0.04                              # с между двумя чтениями, которые должны совпасть

out = sys.stdout.buffer
def log(s):
    sys.stderr.write('cap: ' + s + '\n'); sys.stderr.flush()

def io(fd, req, buf):
    fcntl.ioctl(fd, req, buf, True)
    return buf

def plane_ids(fd):
    b = bytearray(16); io(fd, GETPLANERES, b)
    n = struct.unpack_from('I', b, 8)[0]
    arr = (ctypes.c_uint32 * max(n, 1))()
    b = bytearray(16)
    struct.pack_into('Q', b, 0, ctypes.addressof(arr)); struct.pack_into('I', b, 8, n)
    io(fd, GETPLANERES, b)
    return list(arr)[:n]

def plane_fb(fd, pid):
    p = bytearray(32); struct.pack_into('I', p, 0, pid)
    io(fd, GETPLANE, p)
    return struct.unpack_from('I', p, 8)[0]

class Fb(object):
    """One read of a framebuffer: a handle and a mapping, both released on close."""
    def __init__(self, fd, fb):
        f = bytearray(28); struct.pack_into('I', f, 0, fb)
        io(fd, GETFB, f)
        _, self.w, self.h, self.pitch, self.bpp, _, self.handle = struct.unpack_from('IIIIIII', f, 0)
        self.fd = fd; self.m = None
        if not self.handle:
            raise OSError('no handle for fb %d' % fb)
        try:
            if (self.w, self.h) != SCREEN or self.bpp != 32:
                raise OSError('fb %d is %dx%d/%d' % (fb, self.w, self.h, self.bpp))
            g = bytearray(16); struct.pack_into('I', g, 0, self.handle)
            io(fd, I915_MMAP_GTT, g)
            off = struct.unpack_from('Q', g, 8)[0]
            self.m = mmap.mmap(fd, (self.pitch * self.h + 4095) & ~4095, mmap.MAP_SHARED, mmap.PROT_READ, offset=off)
        except Exception:
            self.close(); raise
    def region(self, r):
        x, y, w, h = r
        m, p = self.m, self.pitch
        x0 = (TILE_X + x) * 4; n = w * 4
        return b''.join([m[(TILE_Y + y + i) * p + x0:(TILE_Y + y + i) * p + x0 + n] for i in range(h)])
    def close(self):
        if self.m is not None:
            try: self.m.close()
            except Exception: pass
            self.m = None
        if self.handle:
            try: io(self.fd, GEM_CLOSE, bytearray(struct.pack('II', self.handle, 0)))
            except OSError: pass
            self.handle = 0

class Maps(object):
    """The framebuffers' mappings, each kept for a short while: the compositor swaps between the same few buffers."""
    TTL = 2.0
    def __init__(self, fd):
        self.fd = fd; self.maps = {}
    def get(self, fb):
        now = time.monotonic()
        e = self.maps.get(fb)
        if e and now - e[1] < self.TTL: return e[0]
        if e: e[0].close(); del self.maps[fb]
        for k in [k for k, v in self.maps.items() if now - v[1] >= self.TTL]:
            self.maps[k][0].close(); del self.maps[k]
        f = Fb(self.fd, fb)
        self.maps[fb] = (f, now)
        return f
    def clear(self):
        for v in self.maps.values(): v[0].close()
        self.maps = {}

def changed(a, b, step=5, need=5):
    """
    Two reads differ by more than the video stream's noise (CarPlay is a video: every frame differs a little).
    Fine enough to tell a digit half way through its cross-fade from the finished one: only one digit of the
    distance changes between 500 and 400, and it must not be sent, or kept, half faded.
    """
    if b is None or len(a) != len(b): return True
    n = 0
    for d in map(sub, a[0::step], b[0::step]):
        if d > 26 or d < -26:
            n += 1
            if n >= need: return True
    return False

def has_picture(data):
    """Not an all-black buffer (the primary plane under the HMI's is black)."""
    return any(data[i] or data[i + 1] or data[i + 2] for i in range(0, len(data), 404))

def find_plane(fd):
    """The plane whose framebuffer is the 1920x720 picture of the centre display (the highest such plane with content)."""
    for pid in sorted(plane_ids(fd), reverse=True):
        try:
            fb = plane_fb(fd, pid)
            if not fb: continue
            f = Fb(fd, fb)
            try:
                if has_picture(f.region(BAND)) or has_picture(f.region(TITLE)): return pid
            finally:
                f.close()
        except OSError:
            continue
    return 0

def main():
    fd = os.open('/dev/dri/card0', os.O_RDWR | os.O_CLOEXEC)
    try: io(fd, SET_CLIENT_CAP, bytearray(struct.pack('QQ', 2, 1)))
    except OSError as e: log('universal planes: %s' % e)
    maps = Maps(fd)
    st = {'torn': 0}

    def read(regions, plane):
        """The regions from the buffer on screen, or None when it was redrawn under every try. 0 when the plane has no buffer."""
        for attempt in range(3):
            fb = plane_fb(fd, plane)
            if not fb: return 0
            f = maps.get(fb)
            data = b''.join([f.region(r) for r in regions])
            if plane_fb(fd, plane) == fb: return data       # the buffer stayed on screen while it was read
            st['torn'] += 1
        return None

    plane = 0; seq = 0; last_sent = None; last_probe = None; last_full = 0.0; black = 0
    t_read = 0.0; n_read = 0; t_stat = time.monotonic(); sent = 0; fulls = 0; slow = 0
    log('hs-cap started, check every %d ms' % (PERIOD * 1000))
    while True:
        t0 = time.monotonic()
        flags = 1; data = b''
        try:
            if not plane:
                maps.clear()
                plane = find_plane(fd)
                if plane: log('plane %d' % plane)
                last_probe = None
            if not plane:
                flags = 2
            else:
                probe = read([PROBE], plane)
                if probe == 0:
                    plane = 0; maps.clear(); flags = 2
                elif probe is None:
                    flags = 3
                elif changed(probe, last_probe, 5, 3) or t0 - last_full >= FULL_EVERY:
                    # the tile whole, once two reads in a row agree
                    a = read([TITLE, BAND], plane); stable = False
                    for attempt in range(10):
                        if not a: break
                        time.sleep(SETTLE)
                        b = read([TITLE, BAND], plane)
                        if b and not changed(b, a): a = b; stable = True; break
                        a = b
                    fulls += 1
                    if a == 0:
                        plane = 0; maps.clear(); flags = 2
                    elif not stable:
                        flags = 3; last_probe = None             # still changing: look again next time
                    else:
                        last_full = time.monotonic(); last_probe = probe
                        black = 0 if has_picture(a) else black + 1
                        if black > 8: plane = 0; black = 0       # this plane went black: look again
                        if changed(a, last_sent): last_sent = a; data = a; flags = 0; sent += 1
        except OSError as e:
            log('read: %s' % e); plane = 0; maps.clear(); flags = 2
        if flags == 2: last_sent = None
        seq += 1
        try:
            out.write(struct.pack('<4sIII', b'HSF1', seq, int((time.monotonic() - t0) * 10000), flags))
            if flags == 0: out.write(data)
            out.flush()
        except (BrokenPipeError, OSError):
            break                                                  # the service is gone
        dt = time.monotonic() - t0
        t_read += dt; n_read += 1
        if time.monotonic() - t_stat > 60:
            avg = t_read / n_read * 1000
            log('avg %.1f ms per check, %d whole-tile reads, %d redrawn-while-read retries, %d changed frames in the last minute' % (avg, fulls, st['torn'], sent))
            slow = slow + 1 if avg > 50 else 0
            if slow >= 2:
                log('checks are too slow for two minutes: stopping, so the head unit is not loaded'); sys.exit(3)
            t_read = 0.0; n_read = 0; st['torn'] = 0; sent = 0; fulls = 0; t_stat = time.monotonic()
        time.sleep(max(0.02, PERIOD - dt))

if __name__ == '__main__':
    try:
        main()
    except KeyboardInterrupt:
        pass
