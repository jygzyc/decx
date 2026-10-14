// bypass-apply-located.js — bypass: neutralize exactly what locate and trace found, mask the
// standard Frida features (port / process / path), then self-test with raw syscalls.
//
// Three parts, all in this one file (the user-facing flow):
//   1) PATCH  — hook/patch the function or single instruction that tracing named, via the
//               PATCHES table below (module + offset + mode). No blind offsets: every
//               entry must correspond to a traced finding. Timing: entries apply when the
//               module maps — or in its constructor window when ANCHOR.targetSo is set
//               (the only window that beats a .init_array detector).
//   2) MASK   — the ordinary Frida feature counters (MASKS): LISTEN port, process/thread
//               names, /proc paths. Forged at the read level, raw-syscall based.
//   3) VERIFY — re-run the feature probes in two views: the hooked libc view (what a
//               normal detector sees — PASS/FAIL lives here) and the raw-syscall
//               residual (what a direct-syscall detector still sees — INFO only).
//               The real acceptance test stays manual: reproduce the traced trigger and
//               confirm the process survives it.
//
// Usage: frida -U -f <pkg> -l bypass-apply-located.js
//   (arm64-only: instruction patch opcodes, raw syscall numbers, and register access
//    are aarch64 — port per-ABI before using elsewhere)
// Source: DECX-authored for this skill; techniques per references/methodology.md § Provenance
// Evidence rule (SKILL.md Rule 4): never fill PATCHES from a guess or from another
//   version's offsets. Mode meanings:
//     'replace0' — Interceptor.replace with a `long` callback returning 0. Use for
//                  detection/kill functions whose caller tests w0/x0 (a `void` replacement
//                  SIGSEGVs where the caller does `cbz x0`).
//     'ret'      — bare ARM64 `ret` at the entry (void/dead-end functions).
//     'ret0'     — `mov w0, #0 ; ret` (8 bytes) at the entry, no interceptor involved.
//     'nop'      — a single 4-byte instruction → NOP. Use for the instruction-level case
//                  (a `svc` doing the kill, a conditional branch that selects the kill
//                  path) — NOP only when the following instruction is still valid code.
'use strict';

if (Process.arch !== 'arm64') {
    throw new Error('bypass-apply-located.js is arm64-only (syscall numbers, patch opcodes, register access)');
}

// ─── 1) PATCH: the traced finding ───────────────────────────────────────────────
const PATCHES = [
    // { module: 'libtarget.so', offset: 0x0, mode: 'replace0', note: 'traced: kill path guarded by cbz x0' },
    // { module: 'libtarget.so', offset: 0x0, mode: 'nop',      note: 'traced: svc #0 doing the exit' },
];
const WAIT_MS = 20000;              // module may map later than script load

// ─── anchor (optional): apply PATCHES in the target's constructor window ───────
// Default is polling (below): the patch lands when the module maps — too late for a
// .init_array detector. Set targetSo to patch in the only windows still in front of it:
//   mode 'early-import'      — first read of `property` from inside the target's .init_proc
//                              (mapped, .init_array not reached; pick the property from the
//                              target's .init decompilation — the placeholder is only a shape)
//   mode 'call-constructors' — linker soinfo::call_constructors onEnter (earliest reliable
//                              point; soname read from soinfo+0x158, Android 10+ arm64)
// Entries for other modules keep polling. The anchor hook is itself a detection point:
// keep PATCHES scoped and never depend on the hook after it fires (single-shot).
const ANCHOR = { targetSo: '', mode: 'early-import', property: 'ro.build.version.sdk' };

// ─── 2) MASK: the ordinary Frida features ──────────────────────────────────────
// Two explicit gates: ENABLE_RUNTIME_MASKS must be true AND the per-feature flag —
// enable a feature only after the locate pass proved the app probes that source.
const ENABLE_RUNTIME_MASKS = false;
const MASKS = { port: false, process: false, path: false };
const PORT = 27042;                 // your frida-server port (rusda/randomized → set it)
const FRIDA_RE = /frida|gum-js|gumjs|gum-log|linjector|gadget|memfd:frida|pool-frida|\bgmain\b/;
const FRIDA_NAMES = ['gum-js-loop', 'gmain', 'gdbus', 'pool-frida', 'pool-spawner', 'frida'];
const SAFE_LINK = '/system/framework/services.jar';

// ─── raw syscalls (arm64 numbers; used for all our own file IO → no self-recursion,
//     and for VERIFY so the probe is honest) ─────────────────────────────────────
const SYS = { openat: 56, close: 57, read: 63, write: 64 };
const AT_FDCWD = -100, O_RDONLY = 0, O_CREAT_WRONLY_TRUNC = 0x241;
const syscallAddr = Module.getExportByName(null, 'syscall');
const _sys = new NativeFunction(syscallAddr, 'long', ['long', 'pointer', 'long', 'long', 'long', 'long']);
function rawRead(path, cap) {
    cap = cap || 4 * 1024 * 1024;
    const fd = _sys(SYS.openat, AT_FDCWD, Memory.allocUtf8String(path), O_RDONLY, 0, 0);
    if (fd < 0) return null;
    const b = Memory.alloc(65536); let out = '';
    for (;;) {
        const n = _sys(SYS.read, fd, b, 65536, 0, 0);
        if (n <= 0) break;
        out += b.readUtf8String(n);
        if (out.length >= cap) break;
    }
    _sys(SYS.close, fd, 0, 0, 0, 0);
    return out;
}
const FAKE_DIRS = ['/data/data/', '/data/user/0/'];
function rawWrite(path, text) {
    const fd = _sys(SYS.openat, AT_FDCWD, Memory.allocUtf8String(path), O_CREAT_WRONLY_TRUNC, 0x1a4, 0);
    if (fd < 0) return false;
    const b = Memory.allocUtf8String(text);
    const ok = _sys(SYS.write, fd, b, text.length, 0, 0) === text.length;
    _sys(SYS.close, fd, 0, 0, 0, 0);
    return ok;
}
const PKG = (function () {
    const c = rawRead('/proc/self/cmdline', 512);
    return c ? c.split('\0')[0] : 'pkg';
})();
const FAKE_DIR = (function () {
    for (const d of FAKE_DIRS) {
        const p = d + PKG + '/cache';
        if (rawWrite(p + '/.afb', 'x')) return p;
    }
    return null;
})();
if (!FAKE_DIR) console.log('[mask] no app-writable dir found — MASK disabled, PATCH still active');

let FAKE_SEQ = 0;
function forge(content) {           // fresh content per read; same dir, sequence-named
    if (!FAKE_DIR) return null;
    const p = FAKE_DIR + '/.afb' + (++FAKE_SEQ);
    return rawWrite(p, content) ? p : null;
}

// filter helpers for the forged views
const fridaLine = l => FRIDA_RE.test(l) || l.indexOf('/data/local/tmp') !== -1;
function forgeNet(path) {
    const real = rawRead(path, 1 << 20);
    if (real === null) return null;
    const hex = PORT.toString(16).toUpperCase().padStart(4, '0');
    const keep = real.split('\n').filter(l => l.indexOf(':' + hex) === -1);
    return forge(keep.join('\n'));
}
function forgeMaps(path) {
    const real = rawRead(path, 8 << 20);
    if (real === null) return null;
    return forge(real.split('\n').filter(l => !fridaLine(l))
        .map(l => l.replace(/\/data\/local\/tmp/g, '/data')).join('\n'));
}
function forgeComm(path) {          // only rewrite actual Frida thread names
    const real = rawRead(path, 64);
    if (real === null) return null;
    const name = real.split('\n')[0].trim();
    if (FRIDA_NAMES.indexOf(name) === -1) return null;
    return forge(PKG.substring(0, 15) + '\n');
}
function forgeStatus(path) {
    const real = rawRead(path, 1 << 20);
    if (real === null) return null;
    return forge(real.replace(/^TracerPid:\s*\d+$/m, 'TracerPid:\t0'));
}
function forgedPath(path) {
    if (!FAKE_DIR) return null;
    if (MASKS.port && /\/proc\/(self|\d+)\/net\/(tcp6?|udp6?)$/.test(path)) return forgeNet(path);
    if (MASKS.path && /\/proc\/(self|\d+)\/maps$/.test(path)) return forgeMaps(path);
    if (MASKS.process) {
        if (/\/proc\/(self|\d+)\/cmdline$/.test(path)) return forge(PKG + '\0');
        if (/\/proc\/(self|\d+)\/status$/.test(path)) return forgeStatus(path);
        if (/\/proc\/(self|\d+)\/(task\/\d+\/)?comm$/.test(path)) return forgeComm(path);
    }
    return null;
}

const REPORTED = new Set();
const cbRefs = [];                  // Rule 6: NativeCallbacks and forged-path buffers must stay referenced
function failOnce(tag, what, e) {
    const key = tag + ':' + what;
    if (REPORTED.has(key)) return;
    REPORTED.add(key);
    console.log('[fail] ' + tag + ' ' + what + ': ' + e.message);
}

const MASKS_ON = ENABLE_RUNTIME_MASKS && (MASKS.port || MASKS.process || MASKS.path);
if (FAKE_DIR && MASKS_ON) {
    let IN_FAKE = false;
    for (const name of ['open', 'openat']) {
        const addr = Module.findExportByName('libc.so', name);
        if (!addr) continue;
        Interceptor.attach(addr, {
            onEnter(args) {
                if (IN_FAKE) return;
                const idx = name === 'openat' ? 1 : 0;
                let path; try { path = args[idx].readCString(); } catch (e) { return; }
                if (!path || path.indexOf('/proc/') === -1) return;
                IN_FAKE = true;
                try {
                    const f = forgedPath(path);
                    if (f) {
                        // Replace the argument register — never overwrite the caller's
                        // path buffer in place (the forged path is usually longer, and
                        // the original may be a read-only literal).
                        const buf = Memory.allocUtf8String(f);
                        cbRefs.push(buf);   // the kernel dereferences this after onEnter
                        args[idx] = buf;
                        console.log('[mask] ' + path + ' → forged');
                    }
                } catch (e) { failOnce('fake-open', path, e); } finally { IN_FAKE = false; }
            }
        });
    }
    for (const name of ['readlink', 'readlinkat']) {
        const addr = Module.findExportByName('libc.so', name);
        if (!addr) continue;
        Interceptor.attach(addr, {
            onLeave(rv) {
                if (rv.toInt32() <= 0) return;
                const buf = name === 'readlink' ? this.context.x1 : this.context.x2;   // arm64 arg order
                try {
                    const s = buf.readCString();
                    if (s && (FRIDA_RE.test(s) || (FAKE_DIR && s.indexOf(FAKE_DIR) !== -1))) {
                        buf.writeUtf8String(SAFE_LINK);
                        console.log('[mask] readlink ' + s + ' → ' + SAFE_LINK);
                    }
                } catch (e) { failOnce('mask-readlink', 'rv=' + rv, e); }
            }
        });
    }
    console.log('[mask] enabled=' + ENABLE_RUNTIME_MASKS + ' port=' + MASKS.port + ' process=' + MASKS.process + ' path=' + MASKS.path +
        ' port_filter=' + PORT + ' dir=' + FAKE_DIR);
} else if (ENABLE_RUNTIME_MASKS) {
    console.log('[mask] masks requested but not active: writable dir=' + !!FAKE_DIR +
        ' flags=' + JSON.stringify(MASKS));
}

// ─── PATCH: apply, waiting for the module if needed ─────────────────────────────
const PENDING = PATCHES.slice();
function patchOne(base, p) {
    const addr = base.add(p.offset);
    if (p.mode === 'replace0') {
        const cb = new NativeCallback(function () { return 0; }, 'long', []);
        cbRefs.push(cb);
        Interceptor.replace(addr, cb);
    } else {
        Memory.patchCode(addr, 8, function (code) {
            if (p.mode === 'ret') code.writeU32(0xd65f03c0);
            else if (p.mode === 'nop') code.writeU32(0xd503201f);
            else if (p.mode === 'ret0') { code.writeU32(0x52800000); code.writeU32(0xd65f03c0); }
            else throw new Error('unknown mode ' + p.mode);
        });
    }
    console.log('[patch] ' + p.module + '+0x' + p.offset.toString(16) + ' ' + p.mode +
        (p.note ? '  (' + p.note + ')' : ''));
}
function armPending(skipModule) {   // skipModule: entries the anchor owns
    for (let i = PENDING.length - 1; i >= 0; i--) {
        const p = PENDING[i];
        if (skipModule && p.module === skipModule) continue;
        const m = Process.findModuleByName(p.module);
        if (!m) continue;
        try { patchOne(m.base, p); } catch (e) { console.log('[patch-fail] ' + p.module + '+0x' + p.offset.toString(16) + ': ' + e.message); }
        PENDING.splice(i, 1);
    }
}
if (!PATCHES.length) console.log('[patch] PATCHES is empty — fill it from the traced finding before relying on this script');

// ─── anchor machinery: fire once, inside the constructor window of ANCHOR.targetSo ───
function fireAnchor(m) {
    console.log('[anchor] ' + ANCHOR.targetSo + ' base=' + m.base + ' — ' +
        (ANCHOR.mode === 'call-constructors' ? 'constructors NOT yet run' : 'inside .init_proc, .init_array ahead') +
        '; applying its PATCHES');
    for (let i = PENDING.length - 1; i >= 0; i--) {
        const p = PENDING[i];
        if (p.module !== ANCHOR.targetSo) continue;
        try { patchOne(m.base, p); } catch (e) { console.log('[patch-fail] ' + p.module + '+0x' + p.offset.toString(16) + ': ' + e.message); }
        PENDING.splice(i, 1);
    }
}

function installAnchor() {
    if (Process.findModuleByName(ANCHOR.targetSo)) {
        console.log('[anchor] ' + ANCHOR.targetSo + ' already loaded — the constructor window is gone; its entries poll instead');
        return false;
    }
    if (ANCHOR.mode === 'call-constructors') {
        let cc = null;
        for (const ln of ['linker64', 'linker']) {
            cc = Module.findExportByName(ln, '__dl__ZN6soinfo17call_constructorsEv');
            if (cc) break;
            const lm = Process.findModuleByName(ln);
            if (!lm) continue;
            for (const x of lm.enumerateExports()) { if (/call_constructors/.test(x.name)) { cc = x.address; break; } }
            if (cc) break;
        }
        if (!cc) { console.log('[anchor] call_constructors not found — anchor module entries will poll instead'); return false; }
        let warned = false;
        const listener = Interceptor.attach(cc, {
            onEnter(args) {
                let soname = null;
                try { soname = args[0].add(0x158).readPointer().readCString(); } catch (e) { /* unreadable */ }
                if (soname === null) {
                    if (!warned) { warned = true; console.log('[anchor] WARNING: soname unreadable from soinfo — verify +0x158 against this linker build'); }
                    return;
                }
                if (soname !== ANCHOR.targetSo) return;
                const m = Process.findModuleByName(ANCHOR.targetSo);
                if (!m) return;
                listener.detach();
                fireAnchor(m);
            }
        });
        console.log('[anchor] watching linker call_constructors → ' + ANCHOR.targetSo);
        return true;
    }
    // early-import mode: android_dlopen_ext onEnter names the module → the first
    // .init-called import proves "mapped, .init_array not reached".
    const ext = Module.findExportByName(null, 'android_dlopen_ext');
    const propGet = Module.findExportByName('libc.so', '__system_property_get');
    if (!propGet) { console.log('[anchor] __system_property_get not found — anchor module entries will poll instead'); return false; }
    let importHook = null;
    const armImportHook = function () {
        if (importHook !== null) return;
        importHook = Interceptor.attach(propGet, {
            onEnter(args) {
                let name;
                try { name = args[0].readCString(); } catch (_) { return; }
                if (name !== ANCHOR.property) return;
                const m = Process.findModuleByName(ANCHOR.targetSo);
                if (!m) return;
                const caller = this.returnAddress;
                if (caller.compare(m.base) < 0 || caller.compare(m.base.add(m.size)) >= 0) return;
                importHook.detach();
                importHook = true;   // fired sentinel
                fireAnchor(m);
            }
        });
        console.log('[anchor] import hook armed: ' + ANCHOR.targetSo + ' reading ' + ANCHOR.property);
    };
    if (ext) {
        Interceptor.attach(ext, {
            onEnter(args) {
                const p = args[0].readCString();
                if (p && p.indexOf(ANCHOR.targetSo) !== -1) armImportHook();
            }
        });
        console.log('[anchor] watching android_dlopen_ext → ' + ANCHOR.targetSo);
    } else {
        armImportHook();
    }
    return true;
}

const anchorArmed = ANCHOR.targetSo ? installAnchor() : false;
const POLL_SKIP = anchorArmed ? ANCHOR.targetSo : null;
armPending(POLL_SKIP);
if (anchorArmed && PENDING.some(p => p.module === POLL_SKIP)) {
    console.log('[patch] ' + PENDING.filter(p => p.module === POLL_SKIP).length + ' entr(ies) held for the anchor window of ' + POLL_SKIP);
}
if (PENDING.some(p => p.module !== POLL_SKIP)) {
    console.log('[patch] waiting up to ' + WAIT_MS + ' ms for: ' + PENDING.filter(p => p.module !== POLL_SKIP).map(p => p.module).join(', '));
    const t0 = Date.now();
    const timer = setInterval(function () {
        armPending(POLL_SKIP);
        const left = PENDING.filter(p => p.module !== POLL_SKIP);
        if (!left.length || Date.now() - t0 > WAIT_MS) {
            clearInterval(timer);
            if (left.length) console.log('[patch] still unmapped: ' + left.map(p => p.module).join(', '));
        }
    }, 50);
}

// ─── 3) VERIFY: two views per probe ──────────────────────────────────────────
// The masks hook libc. A normal detector reads through libc and sees the forged view;
// a direct-syscall detector bypasses our hooks and sees the raw residual. Report both:
// PASS/FAIL applies to the hooked view (are the masks working?); the raw residual is
// INFO — if it leaks, this masking rung cannot defeat raw-syscall detection.
function hookedRead(path, cap) {
    cap = cap || 4 * 1024 * 1024;
    const open_ = new NativeFunction(Module.getExportByName('libc.so', 'open'), 'int', ['pointer', 'int']);
    const read_ = new NativeFunction(Module.getExportByName('libc.so', 'read'), 'long', ['int', 'pointer', 'long']);
    const close_ = new NativeFunction(Module.getExportByName('libc.so', 'close'), 'int', ['int']);
    const fd = open_(Memory.allocUtf8String(path), 0);
    if (fd < 0) return null;
    const b = Memory.alloc(65536); let out = '';
    for (;;) {
        const n = read_(fd, b, 65536);
        if (n <= 0) break;
        out += b.readUtf8String(n);
        if (out.length >= cap) break;
    }
    close_(fd);
    return out;
}

function verify() {
    const rows = [];
    const add = (item, pass, detail) => rows.push([item, pass, detail]);

    const mapsH = hookedRead('/proc/self/maps', 8 << 20) || '';
    const mapsR = rawRead('/proc/self/maps', 8 << 20) || '';
    const leakH = mapsH.split('\n').filter(fridaLine).length;
    const leakR = mapsR.split('\n').filter(fridaLine).length;
    add('maps: frida lines [hooked libc view]', leakH === 0, leakH + ' line(s)');
    add('maps: frida lines [raw residual]', null, leakR + ' line(s) — a direct-syscall detector still sees these');

    const hex = PORT.toString(16).toUpperCase().padStart(4, '0');
    let portH = 0, portR = 0;
    for (const p of ['/proc/net/tcp', '/proc/net/tcp6']) {
        const h = hookedRead(p, 1 << 20) || '';
        const r = rawRead(p, 1 << 20) || '';
        portH += h.split('\n').filter(l => l.indexOf(':' + hex) !== -1).length;
        portR += r.split('\n').filter(l => l.indexOf(':' + hex) !== -1).length;
    }
    add('net: LISTEN port ' + PORT + ' [hooked libc view]', portH === 0, portH + ' line(s)');
    add('net: LISTEN port ' + PORT + ' [raw residual]', null, portR + ' line(s) — hide at the server (-l 0.0.0.0:<random>) or accept the limit');

    const cmdH = hookedRead('/proc/self/cmdline', 512) || '';
    add('process: cmdline == ' + PKG + ' [hooked libc view]', cmdH.split('\0')[0] === PKG, JSON.stringify(cmdH.split('\0')[0]));

    let commH = 0, commR = 0;
    for (const t of Process.enumerateThreads()) {
        const p = '/proc/self/task/' + t.id + '/comm';
        const h = hookedRead(p, 64) || '';
        const r = rawRead(p, 64) || '';
        if (FRIDA_NAMES.indexOf(h.split('\n')[0].trim()) !== -1) commH++;
        if (FRIDA_NAMES.indexOf(r.split('\n')[0].trim()) !== -1) commR++;
    }
    add('process: thread comm names [hooked libc view]', commH === 0, commH + ' frida-named thread(s)');
    add('process: thread comm names [raw residual]', null, commR + ' — only a server-side thread rename (patched build) fixes these');

    // residual, unfixable from the client: strings inside Frida's own memory.
    // rusda hides SERVER-side strings; the injected AGENT keeps its own copies —
    // those need a renamed source build, or cutting the detector that scans for them.
    let memHits = 0;
    for (const r of Process.enumerateRanges('r-x')) {
        try { if (Memory.scanSync(r.base, Math.min(r.size, 8 << 20), '66 72 69 64 61 2d 61 67 65 6e 74').length) memHits++; } catch (e) { memHits = -1; }
    }
    const memReport = memHits < 0 ? 'scan failed (see [fail] line)' : memHits + ' range(s)';
    add('[info] in-memory "frida-agent" in r-x ranges', null, memReport + ' — agent-side strings; client masks and rusda cannot fix these');

    const w = Math.max.apply(null, rows.map(r => r[0].length));
    let fails = 0;
    for (const r of rows) {
        const tag = r[1] === null ? 'INFO' : (r[1] ? 'PASS' : (fails++, 'FAIL'));
        console.log('  [' + tag + '] ' + r[0].padEnd(w) + '  ' + r[2]);
    }
    console.log(fails ? '== VERIFY: ' + fails + ' failing item(s) in the HOOKED view — the masks are not working; do not call the bypass done yet'
        : '== VERIFY: hooked libc view clean. INFO lines show the raw residual a direct-syscall detector still sees. Now reproduce the traced trigger: the process must survive it; if it still dies, re-trace, do not add blind patches.');
    return fails;
}
if (MASKS_ON) setTimeout(function () { console.log('\n== VERIFY (' + PKG + ')'); verify(); }, 1200);
globalThis.verify = verify;
globalThis.bypassStatus = function () {
    console.log('patched: ' + (PATCHES.length - PENDING.length) + '/' + PATCHES.length +
        '   pending: ' + PENDING.map(p => p.module + '+0x' + p.offset.toString(16)).join(', '));
    return verify();
};
