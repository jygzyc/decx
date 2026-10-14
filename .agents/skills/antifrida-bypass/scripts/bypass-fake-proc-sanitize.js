// bypass-fake-proc-sanitize.js — /proc faking and string sanitization (generic version)
//
// Purpose: once the locate phase confirms detection reads /proc/{maps,task,mounts,exe}
//      looking for frida artifacts, sanitize the signature strings at the read-result
//      level. This is an "evidence-based bypass" — first observe what is read, then
//      sanitize exactly that.
// Techniques (mapped to detection vectors):
//   open("/proc/*/maps")   → redirect to a forged file in a private directory, with
//                            per-string content replacement
//   fgets line-by-line     → line-level sanitize, write back into the buffer
//   strstr match           → onLeave return NULL, so the "contains" check is always false
//   readlink/readlinkat    → rewrite hits to /system/framework/services.jar
// Switches:
//   FAKE_MAPS    redirect maps (note: fd behavior differences after replacement can
//                crash — run once with OBSERVE_ONLY first)
//   OBSERVE_ONLY log only, never tamper (strongly recommended for the first run)
// Usage: frida -U -f <pkg> -l bypass-fake-proc-sanitize.js
// Source: community write-up; see references/methodology.md § Provenance
//       (apkunpacker, github.com/apkunpacker/AntiFrida_Bypass); signature table collected
//       from the original text.
// Risks: the original itself notes "HookMaps=true → high chance of crash" and "read hook →
//      might give crash on some apps". Thread name detection that reassembles words via
//      byte-by-byte read(1) cannot be sanitized — that one requires fixing the frida-server
//      thread name at its source (rusda (pre-patched frida-server)).

'use strict';

const OBSERVE_ONLY = true;   // ← must be true on the first run: see what detection reads first
const FAKE_MAPS = false;     // ← maps redirect switch (the highest crash-risk item)

const FRIDA_STRINGS = [
    'frida-agent-64.so', 'frida-agent-32.so', 'frida-agent', 'frida-helper-32.so',
    'frida-helper-64.so', 'frida-helper', 'frida-server', 'frida_agent_main', 'frida',
    're.frida.server', 're.frida', 'linjector', 'gum-js-loop', 'gmain', 'gdbus',
    'pool-frida', 'pool-spawner',
];
const ROOT_STRINGS = ['magisk', '/sbin/.magisk', 'libriru', 'xposed', 'mirror', 'system_root'];
const ALL = FRIDA_STRINGS.concat(ROOT_STRINGS);

function sanitize(s) {          // free-length — only for content written to a forged FILE
    for (const bad of ALL) s = s.replaceAll(bad, '/system');
    return s.replace(/\/data\/local\/tmp/g, '/data');
}
function sanitizeInPlace(s) {   // same length in, same length out — safe for live buffers
    let out = s;
    for (const bad of ALL) out = out.replaceAll(bad, '.'.repeat(bad.length));
    return out.replace(/\/data\/local\/tmp/g, '/data/lokal/tmP');
}
function hit(s) { return ALL.some(b => s.indexOf(b) !== -1); }
function safeRead(addr, cap) {
    try { return addr.readUtf8String(cap); } catch (e) { return null; }
}

function processName() {
    try {
        const fd = new NativeFunction(Module.getExportByName('libc.so', 'open'),
            'int', ['pointer', 'int'])(Memory.allocUtf8String('/proc/self/cmdline'), 0);
        const buf = Memory.alloc(512);
        new NativeFunction(Module.getExportByName('libc.so', 'read'),
            'int', ['int', 'pointer', 'int'])(fd, buf, 512);
        new NativeFunction(Module.getExportByName('libc.so', 'close'),
            'int', ['int'])(fd);
        return buf.readCString();
    } catch (e) { console.log('[warn] package name unreadable (' + e.message + ') — PKG=unknown, package-keyed masks will miss'); return 'unknown'; }
}
const PKG = processName();
const who = a => { const m = Process.findModuleByAddress(a); return m ? m.name : '??'; };

// 1) open / openat → fake maps (optional)
let IN_FAKE = false;             // the forge itself opens /proc/*/maps — never recurse
const keptBufs = [];             // forged-path buffers must outlive the open call (Rule 6)
for (const name of ['open', 'openat']) {
    const addr = Module.findExportByName('libc.so', name);
    if (!addr) continue;
    Interceptor.attach(addr, {
        onEnter(args) {
            if (IN_FAKE) return;
            const idx = name === 'openat' ? 1 : 0;
            const path = safeRead(args[idx], 512);
            if (!path || path.indexOf('/proc') === -1) return;
            if (/\/(maps)$/.test(path) || /\/task\//.test(path) || /\/mounts$/.test(path))
                console.log('[open] ' + path + '  caller=' + who(this.returnAddress));
            if (OBSERVE_ONLY || !FAKE_MAPS || !/\/maps$/.test(path)) return;
            IN_FAKE = true;
            try {
                // Fake it: read the original file → sanitize → write to a private dir →
                // REPLACE THE ARGUMENT POINTER (never overwrite the caller's path buffer
                // in place: the forged path is longer and the original may be a literal).
                const open_ = new NativeFunction(addr, 'int', ['pointer', 'int']);
                const read_ = new NativeFunction(Module.getExportByName('libc.so', 'read'),
                    'int', ['int', 'pointer', 'int']);
                const close_ = new NativeFunction(Module.getExportByName('libc.so', 'close'), 'int', ['int']);
                const fd = open_(args[idx], 0);
                if (fd < 0) return;
                let out = '';
                const b = Memory.alloc(65536);
                let n;
                while ((n = read_(fd, b, 65536)) > 0) out += b.readUtf8String(n);
                close_(fd);
                const fakePath = '/data/data/' + PKG + '/fake_maps';
                // Write with libc (Frida 17 dropped the File API) so the forged content
                // is produced by the same layer the detector will read it through.
                const fopen_ = new NativeFunction(Module.getExportByName('libc.so', 'fopen'),
                    'pointer', ['pointer', 'pointer']);
                const fwrite_ = new NativeFunction(Module.getExportByName('libc.so', 'fwrite'),
                    'ulong', ['pointer', 'ulong', 'ulong', 'pointer']);
                const fclose_ = new NativeFunction(Module.getExportByName('libc.so', 'fclose'),
                    'int', ['pointer']);
                const fake = sanitize(out);
                const fp = fopen_(Memory.allocUtf8String(fakePath), Memory.allocUtf8String('w'));
                if (fp.isNull()) return;
                fwrite_(Memory.allocUtf8String(fake), 1, fake.length, fp);
                fclose_(fp);
                const buf = Memory.allocUtf8String(fakePath);
                keptBufs.push(buf);
                args[idx] = buf;
            } finally { IN_FAKE = false; }
        }
    });
}

// 2) fgets → line-level sanitize (in-place: the replacement must never grow the line,
//    or it overflows the caller's fgets buffer)
const fgetsAddr = Module.findExportByName('libc.so', 'fgets');
if (fgetsAddr) Interceptor.attach(fgetsAddr, {
    onLeave(rv) {
        if (rv.isNull()) return;
        const line = safeRead(rv, 65536);
        if (!line || !hit(line)) return;
        if (OBSERVE_ONLY) { console.log('[fgets] hit: ' + line.trim()); return; }
        rv.writeUtf8String(sanitizeInPlace(line));
    }
});

// 3) strstr → return NULL on a signature hit
const strstrAddr = Module.findExportByName('libc.so', 'strstr');
if (strstrAddr) Interceptor.attach(strstrAddr, {
    onEnter(args) {
        this.arg0 = safeRead(args[0], 4096);
        this.arg1 = safeRead(args[1], 256);
    },
    onLeave(rv) {
        if (!this.arg0 || !this.arg1) return;
        if (hit(this.arg0) || hit(this.arg1)) {
            if (OBSERVE_ONLY) console.log('[strstr] "' + this.arg1 + '" in "' + this.arg0.substring(0, 60) + '"  caller=' + who(this.returnAddress || ptr(0)));
            else rv.replace(ptr(0));
        }
    }
});

// 4) readlink / readlinkat → rewrite the result on a signature hit.
//    readlink does NOT NUL-terminate: the result length is the return value, the
//    caller's buffer capacity comes from the size argument — save both in onEnter.
let rlFailLogged = false;
const READLINK_REPL = '/system/framework/services.jar';
for (const name of ['readlink', 'readlinkat']) {
    const addr = Module.findExportByName('libc.so', name);
    if (!addr) continue;
    Interceptor.attach(addr, {
        onEnter(args) {
            this.rlBuf = name === 'readlink' ? args[1] : args[2];
            this.rlCap = (name === 'readlink' ? args[2] : args[3]).toInt32();
        },
        onLeave(rv) {
            const n = rv.toInt32();
            if (n <= 0) return;
            try {
                const s = this.rlBuf.readUtf8String(n);
                if (!s || !hit(s)) return;
                if (OBSERVE_ONLY) { console.log('[readlink] ' + s); return; }
                if (READLINK_REPL.length > this.rlCap) {
                    if (!rlFailLogged) { rlFailLogged = true; console.log('[warn] readlink buffer too small for replacement (' + this.rlCap + 'B) — skipped'); }
                    return;
                }
                this.rlBuf.writeUtf8String(READLINK_REPL);
                rv.replace(ptr(READLINK_REPL.length));   // keep the length honest
            } catch (e) {
                if (!rlFailLogged) { rlFailLogged = true; console.log('[warn] readlink rewrite failed: ' + e.message); }
            }
        }
    });
}

console.log('== fake-proc-sanitize ready OBSERVE_ONLY=' + OBSERVE_ONLY + ' FAKE_MAPS=' + FAKE_MAPS + ' pkg=' + PKG);
console.log('== After the first observation run confirms what detection reads, set OBSERVE_ONLY to false and enable items one by one.');
