// detect.js — one script for the whole locate → trace loop: name the killer, confirm the
// mechanism, close on the feature it matched. Passive: nothing is patched, nothing is
// blocked; the process must stay free to die so the log records exactly where it died.
//
// This file merges the old locate-*/trace-* script set. Sections are independent sensors
// with a single CONFIG block below — the defaults are the canonical first run (load
// chain + exception classification); everything else opts in after the first log narrows
// the target. Do NOT enable every sensor at once: each extra hook is crash surface and
// a detectable artifact (SKILL.md Rules 2–3). The invasive half (patching what this
// script names) lives in bypass-apply-located.js and the special bypass-* scripts.
//
// Usage:
//   1. first run, defaults:  frida -U -f <pkg> -l scripts/detect.js
//      → load chain + JNI_OnLoad + constructor phases + kill-path VERDICT + exception
//        classification. The VERDICT line names the phase; no KILL line at all means a
//        direct-syscall kill — the last log line names the suspect .so.
//   2. flip the sensors the VERDICT points at (procWatch / threadWatch / registerNatives),
//      set anchor.targetSo + observe[] for the detector's magic values, then stalker for
//      the instruction chain, then featureMatch to name the matched feature class.
//   3. spend the evidence in bypass-apply-located.js (PATCHES + MASKS + VERIFY).
//
// RPC (from the frida REPL): __loadChain() __jniOnLoads() __threadReport()
//      __featureReport() __excSnap() __stalkerWhere() __stalkerDump(n) __stalkerStop()
//      __stalkerArm() — plus observerFor(base) to arm the observe table by hand.
//
// Source: community write-ups; see references/methodology.md § Provenance. Offsets are
// pinned to the analyzed build — re-locate per build (SKILL.md Rule 5).

'use strict';

// ═══════════════════════════════ CONFIG ═══════════════════════════════
const CONFIG = {
    // ── load chain: dlopen/android_dlopen_ext + call_constructors + JNI_OnLoad + kill VERDICT (canonical first run) ──
    loadChain: {
        enabled: true,
        only: [],               // watch only these module names (empty = every non-system module)
        showSystem: false,      // also log linker/libc/libart loads
        jniOnLoad: true,        // locate + hook JNI_OnLoad of every loaded module
        killPaths: true,        // hook exit/abort/raise/kill/tgkill/... → phase VERDICT on death
    },
    // ── who reads /proc/self/**, attributed to the caller module ──
    procWatch: { enabled: false },
    // ── who creates threads, from where, named what (clone/clone3, not pthread_create) ──
    threadWatch: {
        enabled: false,
        ourLib: '',             // only creators whose chain touches this module ('' = all app threads)
        showAll: false,         // also log threads created purely from system libs
        nameWatch: true,        // also observe pthread_setname_np renames + caller
    },
    // ── runtime-registered JNI methods (RegisterNatives traffic, read-only) ──
    registerNatives: { enabled: false },
    // ── exception classification + kill-shape attribution (snapshot-based) ──
    exceptionHunt: { enabled: true, snapshot: true },
    // ── anchor: fire onAnchor while the target's constructors are (not yet) running ──
    anchor: {
        targetSo: '',           // e.g. 'libtarget.so' — '' = disarmed
        mode: 'early-import',   // 'early-import' (.init_proc window) | 'call-constructors' (earliest)
        property: 'ro.build.version.sdk', // early-import mode: import the .init path calls first
    },
    // ── detector return-value table, armed by the anchor (offsets + branch semantics from the decompiler) ──
    observe: [
        // { offset: 0x1234, name: 'sub_1234', note: '==1 → confirmed kill branch' },
    ],
    // ── Stalker: ONE thread (or one module's call/ret), dump the chain on fault ──
    stalker: {
        enabled: false,
        tid: 0,                 // explicit thread id; 0 = resolve from name
        name: '',               // thread name from the locate pass (late threads caught via setname hook)
        module: '',             // set = module-scope call/ret mode instead of thread pinning
        mode: 'call',           // 'call' (cheap, usually enough) | 'insn' (heavy final narrowing)
        includeModule: '',      // instrument only this module ('' = all non-Frida code)
        armOnModule: '',        // start recording on first instruction inside this module
        ringMax: 120000,
        dumpN: 400,
    },
    // ── feature classes the target could match right now (hypotheses, not proof) ──
    featureMatch: { enabled: false, deepScan: false, scanTotalMB: 256, fdMax: 512 },
};

// ═══════════════════════════════ shared helpers ═══════════════════════════════
const FRIDA_HINT = /frida|gum|gadget|linjector|pool-frida/i;
const FRIDA_NAMES = ['gum-js-loop', 'gmain', 'gdbus', 'pool-frida', 'pool-spawner', 'frida'];
const SKIP_MOD = /^(libc\.so|libm\.so|libdl\.so|libz\.so|liblog\.so|libart\.so|libnativehelper\.so|libnativeloader\.so|libc\+\+_shared\.so|linker|linker64)$/;
const SIG_STRINGS = ['frida', 'gum-js-loop', 'gum-log-file', 'linjector-', 'GumScript', 'gumjs-runtime', 're.frida.server', 'frida-agent', 'gadget'];
const THREAD_HINTS = /gum-js-loop|gmain|pool-frida|gdbus|frida/i;
const PORT_HITS = { '69A2': 27042, '69A3': 27043 };

function exp(name) {
    try { if (typeof Module.findGlobalExportByName === 'function') { const p = Module.findGlobalExportByName(name); if (p) return p; } } catch (e) { /* older Frida */ }
    try { return Module.findExportByName('libc.so', name); } catch (e) { return null; }
}

function shortName(p) {
    if (p === null || p === undefined) return String(p);
    const i = p.lastIndexOf('/');
    return i >= 0 ? p.slice(i + 1) : p;
}

function modOff(addr) {
    if (addr === null || addr === undefined) return '?';
    const m = Process.findModuleByAddress(addr);
    return m ? m.name + '+0x' + addr.sub(m.base).toString(16) : addr.toString();
}

function pcOf(ctx) { return ctx && ctx.pc !== undefined ? ctx.pc : (ctx && ctx.rip !== undefined ? ctx.rip : (ctx && ctx.eip)); }

function shortBacktrace(ctx, depth) {
    let frames = null;
    try { frames = Thread.backtrace(ctx, Backtracer.ACCURATE); } catch (e) { /* fall through */ }
    if (!frames) { try { frames = Thread.backtrace(ctx, Backtracer.FUZZY); } catch (e) { return []; } }
    return frames.slice(0, depth || 12);
}

function allRanges() {
    let out = [];
    try { out = Process.enumerateRanges('---'); } catch (e) { /* older Frida */ }
    if (!out.length) { try { out = Process.enumerateRanges('r-x'); } catch (e) { /* give up */ } }
    return out;
}

function inR(r, a) { return a.compare(r.base) >= 0 && a.compare(r.base.add(r.size)) < 0; }

function asciiPattern(s) {
    return s.split('').map(function (c) { return ('0' + c.charCodeAt(0).toString(16)).slice(-2); }).join(' ');
}

function readFile(path, max) {
    max = max || 262144;
    const openFn = exp('open'), readFn = exp('read'), closeFn = exp('close');
    if (!openFn || !readFn || !closeFn) return null;
    const open = new NativeFunction(openFn, 'int', ['pointer', 'int']);
    const read = new NativeFunction(readFn, 'long', ['int', 'pointer', 'ulong']);
    const close = new NativeFunction(closeFn, 'int', ['int']);
    const fd = open(Memory.allocUtf8String(path), 0);
    if (fd < 0) return null;
    const buf = Memory.alloc(max);
    const n = read(fd, buf, max);
    close(fd);
    return n > 0 ? buf.readUtf8String(n) : null;
}

function readLink(path) {
    const p = exp('readlink');
    if (!p) return null;
    const fn = new NativeFunction(p, 'long', ['pointer', 'pointer', 'ulong']);
    const buf = Memory.alloc(512);
    const n = fn(Memory.allocUtf8String(path), buf, 512);
    return n > 0 ? buf.readUtf8String(n) : null;
}

function readComm(tid) {
    const raw = readFile('/proc/self/task/' + tid + '/comm', 128);
    return raw ? raw.split('\n')[0].trim() : null;
}

function dumpRegs(ctx) {
    if (!ctx) return;
    const names = ctx.pc !== undefined
        ? ['x0', 'x1', 'x2', 'x3', 'x4', 'x5', 'x6', 'x7', 'x8', 'x19', 'x20', 'x21', 'x22', 'x23', 'x24', 'x25', 'x26', 'x27', 'x28', 'x29', 'lr', 'sp', 'pc']
        : ['rax', 'rbx', 'rcx', 'rdx', 'rsi', 'rdi', 'rbp', 'rsp', 'r8', 'r9', 'r10', 'r11', 'r12', 'r13', 'r14', 'r15', 'rip'];
    const parts = [];
    names.forEach(function (n) { try { if (ctx[n] !== undefined) parts.push(n + '=' + ctx[n]); } catch (e) { /* unavailable */ } });
    console.log('    regs ' + parts.join(' '));
}

let seq = 0;   // global log sequence number

// ═══════════════════════════════ load chain ═══════════════════════════════
// Which .so load kills the process, and in which phase? Thread-local load stacks +
// constructor depth + JNI_OnLoad activity; the kill-path hooks (below) read this state
// and print the VERDICT. No KILL line at all = direct-syscall kill; the last line
// before the log stops names the suspect .so.
const threadState = new Map();   // tid → { loadStack: [], ctorDepth: 0, jniActive: null }
const jniHooked = new Set();

function ts() {
    const tid = Process.getCurrentThreadId();
    let s = threadState.get(tid);
    if (!s) { s = { loadStack: [], ctorDepth: 0, jniActive: null }; threadState.set(tid); }
    return s;
}

function inFlight() { const st = ts().loadStack; return st.length ? st[st.length - 1] : null; }

function loadInterested(path) {
    const n = shortName(path), lc = CONFIG.loadChain;
    if (lc.only.length) return lc.only.indexOf(n) >= 0;
    return lc.showSystem || !SKIP_MOD.test(n);
}

let sonameFn = null;
try {
    const linker = Process.findModuleByName('linker64') || Process.findModuleByName('linker');
    const sym = linker ? Module.findExportByName(linker.name, '__dl__ZNK6soinfo9get_sonameEv') : null;
    if (sym !== null) sonameFn = new NativeFunction(sym, 'pointer', ['pointer']);
} catch (e) { /* fall back to the in-flight dlopen path */ }

function soinfoName(soinfo) {
    if (!sonameFn || soinfo.isNull()) return null;
    try { const p = sonameFn(soinfo); return p.isNull() ? null : shortName(p.readUtf8String()); } catch (e) { return null; }
}

function tryAttachJni(modName) {
    if (!modName || jniHooked.has(modName)) return;
    let sym = null;
    try { sym = Module.findExportByName(modName, 'JNI_OnLoad'); } catch (e) { sym = null; }
    if (sym === null) return;
    jniHooked.add(modName);
    let where = sym.toString();
    try { const m = Process.findModuleByName(modName); if (m) where = m.base + '+0x' + sym.sub(m.base).toString(16); } catch (e) { /* absolute */ }
    console.log('[' + ++seq + '] JNI_OnLoad located: ' + modName + ' @ ' + where +
        '   ← this offset is the golden-window / anchor target');
    Interceptor.attach(sym, {
        onEnter() { ts().jniActive = modName; console.log('[' + ++seq + '] JNI_OnLoad.enter  ' + modName); },
        onLeave() { console.log('[' + ++seq + '] JNI_OnLoad.leave  ' + modName); ts().jniActive = null; }
    });
}

function hookOpen(fnName, addr) {
    Interceptor.attach(addr, {
        onEnter(args) {
            let path = null;
            try { path = args[0].isNull() ? '(null)' : shortName(args[0].readUtf8String()); } catch (e) { path = '?'; }
            const frame = { seq: ++seq, path: path, from: modOff(this.returnAddress) };
            ts().loadStack.push(frame);
            if (loadInterested(path)) console.log('[' + frame.seq + '] ' + fnName + '.enter  ' + path + '   from=' + frame.from);
        },
        onLeave(retval) {
            const frame = ts().loadStack.pop();
            if (!frame) return;
            const ok = !retval.isNull();
            if (loadInterested(frame.path)) {
                console.log('[' + frame.seq + '] ' + fnName + '.leave  ' + frame.path + ' → ' + (ok ? 'ok' : 'NULL (failed / already loaded)'));
            }
            if (ok && CONFIG.loadChain.jniOnLoad) tryAttachJni(shortName(frame.path));
        }
    });
    console.log('[hook] ' + fnName);
}

function hookCallConstructors() {
    try {
        const linker = Process.findModuleByName('linker64') || Process.findModuleByName('linker');
        const cc = linker ? Module.findExportByName(linker.name, '__dl__ZN6soinfo17call_constructorsEv') : null;
        if (cc === null) { console.log('[warn] call_constructors not exported — .init_array phase stays inferred'); return; }
        Interceptor.attach(cc, {
            onEnter(args) {
                const s = ts();
                s.ctorDepth++;
                const own = soinfoName(args[0]);
                const flight = inFlight();
                console.log('[' + ++seq + '] call_constructors.enter  so=' + (own || (flight ? flight.path : '?')) +
                    (s.ctorDepth > 1 ? '  (depth ' + s.ctorDepth + ')' : ''));
            },
            onLeave() {
                const s = ts();
                console.log('[' + ++seq + '] call_constructors.leave' + (s.ctorDepth > 1 ? '  (depth ' + s.ctorDepth + ')' : ''));
                s.ctorDepth = Math.max(0, s.ctorDepth - 1);
            }
        });
        console.log('[hook] call_constructors' + (sonameFn ? ' (soinfo name resolved)' : ' (no soname fn — using in-flight dlopen)'));
    } catch (e) { console.log('[warn] call_constructors hook failed: ' + e); }
}

// ═══════════════════════════════ kill paths + exception classification ═══════════════════════════════
// One set of hooks serves two questions: which phase did the load chain die in
// (VERDICT, from loadChain state), and what shape was the kill (deliberate / fault /
// yanked mapping, from the snapshot below). A direct-syscall kill touches neither —
// that absence is itself the signal.
let SNAP = [], SNAP_M = [];

function takeSnap() {
    SNAP = allRanges().map(function (r) {
        return { base: r.base, end: r.base.add(r.size), prot: r.protection, path: r.file ? r.file.path : null, moduleName: null, fridaLooking: false };
    });
    SNAP_M = Process.enumerateModules().map(function (m) { return { name: m.name, base: m.base, end: m.base.add(m.size), path: m.path }; });
    SNAP.forEach(function (r) {
        const m = SNAP_M.find(function (mm) { return r.base.compare(mm.base) >= 0 && r.base.compare(mm.end) < 0; });
        if (m) { r.moduleName = m.name; if (!r.path) r.path = m.path; }
        r.fridaLooking = FRIDA_HINT.test(r.moduleName || '') || FRIDA_HINT.test(r.path || '');
    });
    console.log('[exc] snapshot: ' + SNAP.length + ' ranges, ' + SNAP_M.length + ' modules, ' +
        SNAP.filter(function (r) { return r.fridaLooking; }).length + ' Frida-looking');
}

function findInSnap(addr) { for (let i = 0; i < SNAP.length; i++) { if (inR(SNAP[i], addr)) return SNAP[i]; } return null; }

function snapOff(addr) {
    if (addr === null || addr === undefined) return '?';
    const m = Process.findModuleByAddress(addr);
    if (m) return m.name + '+0x' + addr.sub(m.base).toString(16);
    const r = Process.findRangeByAddress ? Process.findRangeByAddress(addr) : null;
    const snap = findInSnap(addr);
    if (snap && !r) return addr.toString() + '  [UNMAPPED NOW — was ' + snap.prot + ' ' + (snap.path || 'anon') + (snap.fridaLooking ? ' · FRIDA' : '') + ']';
    if (snap) return addr.toString() + '  [anon ' + snap.prot + (snap.fridaLooking ? ' · FRIDA' : '') + ']';
    return addr.toString() + '  [never mapped]';
}

function classify(details) {
    const pc = (function () { try { return pcOf(details.context); } catch (e) { return null; } })();
    const faddr = details.memory && details.memory.address ? details.memory.address : details.address;
    if (details.type === 'abort' || details.type === 'system') return 'deliberate-kill';
    if (pc) {
        const cur = Process.findRangeByAddress ? Process.findRangeByAddress(pc) : null;
        const snap = findInSnap(pc);
        if (!cur && snap) return snap.fridaLooking ? 'frida-mapping-yanked' : 'unmapped-code-fault';
    }
    if (faddr) {
        const nearby = findInSnap(faddr);
        const fpc = pc ? findInSnap(pc) : null;
        if ((nearby && nearby.fridaLooking) || (fpc && fpc.fridaLooking)) return 'detector-probe';
        const sn = SNAP.find(function (r) { return Math.abs(r.base.sub(faddr).toInt32()) < 0x10000; });
        if (sn && sn.fridaLooking) return 'detector-probe';
    }
    return pc ? 'in-module-fault' : 'unknown';
}

function killVerdict() {
    const s = ts(), flight = inFlight();
    if (s.ctorDepth > 0) {
        console.log('    VERDICT: died inside call_constructors → detection runs in .init_array');
        console.log('    NEXT: CONFIG.anchor mode=call-constructors; do NOT patch blindly (Rule 4).');
    } else if (s.jniActive) {
        console.log('    VERDICT: died inside JNI_OnLoad of ' + s.jniActive + ' → golden window');
        console.log('    NEXT: patch between android_dlopen_ext onLeave and JNI_OnLoad entry; verify original bytes first.');
    } else if (flight) {
        console.log('    VERDICT: died while loading ' + flight.path + ' (before/after constructors)');
        console.log('    NEXT: check whether the log above shows call_constructors for it.');
    } else {
        console.log('    VERDICT: died outside any load (post-init detection / poller)');
        console.log('    NEXT: CONFIG.threadWatch.enabled = true for the poller thread.');
    }
}

function hookKillPaths() {
    // name → arg indexes for the note line
    const targets = [
        ['exit', 'code', 0], ['_exit', 'code', 0], ['_Exit', 'code', 0], ['exit_group', 'code', 0],
        ['abort', null, -1], ['raise', 'signo', 0], ['kill', 'sig', 1],
        ['tgkill', 'tid/sig', 1], ['pthread_kill', 'sig', 1], ['pthread_exit', 'ret', 0],
    ];
    let armed = 0;
    targets.forEach(function (spec) {
        const name = spec[0];
        const p = exp(name);
        if (!p) return;
        Interceptor.attach(p, {
            onEnter(args) {
                const a0 = args[0] && args[0].toInt32 ? args[0].toInt32() : 0;
                const a1 = args.length > 1 && args[1].toInt32 ? args[1].toInt32() : 0;
                let note = '';
                if (spec[1] === 'code') note = 'code=' + a0;
                else if (spec[1] === 'signo') note = 'signo=' + a0;
                else if (spec[1] === 'sig') note = 'sig=' + a1;
                else if (spec[1] === 'tid/sig') note = 'tid=' + a1 + ' sig=' + (args[2] ? args[2].toInt32() : 0);
                else if (spec[1] === 'ret') note = 'retval=' + a0;
                const bt = shortBacktrace(this.context, 12);
                console.log('\n=== KILL ' + name + '(' + note + ') from ' + modOff(bt[0] || NULL) + '  tid=' + Process.getCurrentThreadId() + ' ===');
                bt.forEach(function (a, i) { console.log('    #' + i + ' ' + modOff(a)); });
                if (CONFIG.loadChain.enabled) killVerdict();
                if (name === 'raise' && (a0 === 5 || a0 === 11)) {
                    console.log('    → raise(SIGTRAP)/raise(SIGSEGV): a self-check poking its own signal handler; the\n' +
                        '      handler round-trips through the caller frames above — see bypass-signal-selfcheck-neutralize.js.');
                }
            }
        });
        armed++;
    });
    console.log('[hook] kill paths armed (' + armed + '): exit/_exit/exit_group/abort/raise/kill/tgkill/pthread_kill/pthread_exit');
}

// ═══════════════════════════════ /proc access watch ═══════════════════════════════
// Detection threads scan maps for frida-agent and read task/<tid>/status byte by byte
// for the gum-js-loop/gmain names — every read shows up here, attributed to its caller.
const PROC_WATCH = /\/proc\/(self|\d+)\//;

function hookProcWatch() {
    function log(ctx, kind, detail) {
        const m = Process.findModuleByAddress(ctx.returnAddress !== undefined ? ctx.returnAddress : ptr(0));
        console.log('[PROC] ' + kind + ' ' + detail + '  caller=' + (m ? m.name : '??'));
    }
    for (const name of ['open', 'openat', 'fopen', '__openat', 'access', 'faccessat']) {
        const addr = exp(name);
        if (!addr) continue;
        Interceptor.attach(addr, {
            onEnter(args) {
                const hasDirfd = name === 'openat' || name === '__openat' || name === 'faccessat';
                const p = hasDirfd ? args[1] : args[0];
                if (p.isNull()) return;
                try { const path = p.readCString(); if (path && PROC_WATCH.test(path)) log(this, name, '"' + path + '"'); } catch (_) { /* bad pointer */ }
            }
        });
    }
    let pathFailLogged = false;
    for (const name of ['readlink', 'readlinkat']) {
        const addr = exp(name);
        if (!addr) continue;
        Interceptor.attach(addr, {
            onEnter(args) {
                const p = name === 'readlinkat' ? args[1] : args[0];
                if (p.isNull()) return;
                try { const path = p.readCString(); if (path && PROC_WATCH.test(path)) log(this, name, '"' + path + '"'); } catch (e) {
                    if (!pathFailLogged) { pathFailLogged = true; console.log('[warn] readlink path unreadable: ' + e.message); }
                }
            }
        });
    }
    console.log('[hook] proc-watch: /proc path accesses attributed to callers');
}

// ═══════════════════════════════ thread creation watch ═══════════════════════════════
// clone/clone3 — deliberately NOT pthread_create (a defense can feature-detect that
// hook; clone sits one level downstream). Export hooks can still miss a direct-syscall
// path: absence of output is not proof of absence. Observe only — blocking a thread
// creation freezes the app with it (the freeze traps the app, not the detector).
const CLONE_FLAGS = [
    [0x00000100, 'VM'], [0x00000200, 'FS'], [0x00000400, 'FILES'], [0x00000800, 'SIGHAND'],
    [0x00001000, 'PIDFD'], [0x00010000, 'THREAD'], [0x00020000, 'NEWNS'], [0x00040000, 'SYSVSEM'],
    [0x00080000, 'SETTLS'], [0x00100000, 'PARENT_SETTID'], [0x00200000, 'CHILD_CLEARTID'],
    [0x01000000, 'CHILD_SETTID'], [0x10000000, 'NEWUSER'],
];
const threadStats = { total: 0, byCreator: {} };

function decodeFlags(f) {
    const out = [];
    let rest = f;
    for (const [bit, name] of CLONE_FLAGS) { if (f & bit) { out.push(name); rest &= ~bit; } }
    if (rest) out.push('0x' + rest.toString(16));
    return out.join('|') || '0';
}

function creatorFrames(ctx, depth) {
    const list = [];
    try {
        for (const a of Thread.backtrace(ctx, Backtracer.FUZZY).slice(0, depth)) {
            const m = Process.findModuleByAddress(a);
            list.push(m ? { mod: m.name, off: '0x' + a.sub(m.base).toString(16) } : { mod: '??', off: a.toString() });
        }
    } catch (e) { /* keep what we have */ }
    return list;
}

function fmtFrames(list) { return list.map(function (f) { return f.mod + '+' + f.off; }).join('  <-  '); }

function hookThreadWatch() {
    const tw = CONFIG.threadWatch;
    const SYSTEM = /^(libc\.so|libm\.so|libdl\.so|libz\.so|liblog\.so|libart\.so|libnativehelper\.so|libnativeloader\.so|libc\+\+_shared\.so|linker|linker64|libbase\.so|libutils\.so|libbinder\.so|libandroid\.so)$/;
    const hasOurLib = list => !tw.ourLib || list.some(f => f.mod === tw.ourLib);
    const hasAppFrame = list => list.some(f => !SYSTEM.test(f.mod));
    const show = list => tw.ourLib ? hasOurLib(list) : (tw.showAll || hasAppFrame(list));

    const cloneAddr = exp('clone');
    if (cloneAddr) {
        Interceptor.attach(cloneAddr, {
            onEnter(args) {
                this.frames = creatorFrames(this.context, 7);
                this.flags = args[2].toInt32();
                this.entry = args[0];
                this.creatorName = readComm(Process.getCurrentThreadId());
            },
            onLeave(rv) {
                const tid = rv.toInt32();
                const list = this.frames;
                if (!show(list)) return;
                if (tid === 0) { console.log('      [child] thread started tid=' + Process.getCurrentThreadId()); return; }
                if (tid < 0) return;
                threadStats.total++;
                const top = list.find(f => !SYSTEM.test(f.mod)) || list[0] || { mod: '??', off: '?' };
                threadStats.byCreator[top.mod] = (threadStats.byCreator[top.mod] || 0) + 1;
                const entryMod = Process.findModuleByAddress(this.entry);
                console.log('[thread #' + threadStats.total + '] tid=' + tid + '  flags=' + decodeFlags(this.flags) +
                    '  entry=' + (entryMod ? entryMod.name + '+0x' + this.entry.sub(entryMod.base).toString(16) : this.entry.toString()));
                console.log('      creator: ' + fmtFrames(list));
                const snap = this.creatorName;
                setTimeout(function () {
                    const name = readComm(tid);
                    if (name !== null && name !== snap) console.log('      → tid ' + tid + ' name settles: "' + name + '"');
                }, 60);
            }
        });
        console.log('[hook] clone');
    } else {
        console.log('[warn] libc clone not found — this build may use clone3 only');
    }

    const clone3Addr = exp('clone3');
    if (clone3Addr) {
        Interceptor.attach(clone3Addr, {
            onEnter(args) {
                this.frames = creatorFrames(this.context, 7);
                try { this.flags = args[0].readU64().toNumber(); } catch (e) { this.flags = 0; }
            },
            onLeave(rv) {
                const tid = rv.toInt32();
                if (tid <= 0 || !show(this.frames)) return;
                console.log('[thread3] tid=' + tid + '  flags=' + decodeFlags(this.flags) + '  creator: ' + fmtFrames(this.frames));
            }
        });
        console.log('[hook] clone3');
    }

    if (tw.nameWatch) {
        const sn = exp('pthread_setname_np');
        if (sn !== null) {
            Interceptor.attach(sn, {
                onEnter(args) {
                    let name = '?';
                    try { name = args[1].readUtf8String(); } catch (e) { /* keep ? */ }
                    const list = creatorFrames(this.context, 5);
                    if (tw.ourLib && !hasOurLib(list) && !tw.showAll) return;
                    console.log('[name] "' + name + '" caller_tid=' + Process.getCurrentThreadId() + ' pthread=' + args[0] + '  from: ' + fmtFrames(list));
                }
            });
            console.log('[hook] pthread_setname_np (observer)');
        }
    }
}

// ═══════════════════════════════ RegisterNatives watch ═══════════════════════════════
// No Java_xxx exports, no method-name strings → the natives were registered at runtime.
// Read the JNINativeInterface slot (index 215, stable) to find the function, attach to
// the function itself — never modify the table (RELRO + globally visible).
function hookRegisterNatives() {
    Java.perform(function () {
        if (!Process.findModuleByName('libart.so')) { console.log('[-] libart.so not loaded'); return; }
        const Class = Java.use('java.lang.Class');
        const env = Java.vm.getEnv();
        const fns = env.handle.readPointer();
        const fnAddr = fns.add(215 * Process.pointerSize).readPointer();
        Interceptor.attach(fnAddr, {
            onEnter(args) {
                const count = args[3].toInt32();
                if (count <= 0) return;
                let cls = '<class?>';
                try { cls = Java.cast(args[1], Class).getName(); } catch (e) { /* raw jclass */ }
                for (let i = 0; i < count; i++) {
                    const m = args[2].add(i * 3 * Process.pointerSize);
                    try {
                        const name = m.readPointer().readCString();
                        const sig = m.add(Process.pointerSize).readPointer().readCString();
                        const fnp = m.add(2 * Process.pointerSize).readPointer();
                        console.log('[JNI] ' + cls + '.' + name + sig + '  → ' + modOff(fnp));
                    } catch (e) { console.log('[JNI] entry ' + i + ' unreadable: ' + e.message); }
                }
            }
        });
        console.log('[hook] RegisterNatives observed (attached to the function; VM table untouched)');
    });
}

// ═══════════════════════════════ anchor + detector observer ═══════════════════════════════
// Detection does not wait for JNI_OnLoad — it lives in .init/.init_proc/.init_array.
// The anchor fires onAnchor(base, module) in the earliest window that is still in front
// of the detector:
//   'early-import'      — android_dlopen_ext onEnter names the module → hook the first
//                         import its .init path calls (property below is a placeholder —
//                         pick one the decompilation proves runs before the detector);
//                         mapped + inside .init_proc + .init_array not reached.
//   'call-constructors' — linker soinfo::call_constructors onEnter: mapped, NO
//                         constructor run yet. Earliest reliable point.
// Caveat: the anchor hook (a global __system_property_get hook) is itself a detection
// point — keep onAnchor scoped, never depend on the hook once the base is pinned.
// onAnchor arms the observe table; PATCHING at this window is bypass-apply-located.js's
// ANCHOR option, not this script's job.
const anchorState = { listener: null, done: false };

function onAnchor(base, module) {
    console.log('[anchor] ' + CONFIG.anchor.targetSo + ' base=' + base + ' size=0x' + module.size.toString(16) +
        ' — mapped, constructors' + (CONFIG.anchor.mode === 'call-constructors' ? ' NOT yet run' : ' in .init_proc, .init_array ahead'));
    observerFor(base, module);
}

function installEarlyImportAnchor() {
    if (anchorState.listener !== null) return;
    const propGet = exp('__system_property_get');
    if (!propGet) { console.log('[-] __system_property_get not found'); return; }
    anchorState.listener = Interceptor.attach(propGet, {
        onEnter(args) {
            let name;
            try { name = args[0].readCString(); } catch (_) { return; }
            if (name !== CONFIG.anchor.property) return;
            const m = Process.findModuleByName(CONFIG.anchor.targetSo);
            if (!m) return;
            const caller = this.returnAddress;
            const end = m.base.add(m.size);
            if (caller.compare(m.base) < 0 || caller.compare(end) >= 0) return;
            const listener = anchorState.listener;
            anchorState.listener = null;
            listener.detach();
            onAnchor(m.base, m);
        }
    });
    console.log('[anchor] armed: waiting for ' + CONFIG.anchor.targetSo + ' to read ' + CONFIG.anchor.property);
}

function readSoNameRaw(soinfo) {
    // Android 10+ arm64: soname_ pointer at soinfo+0x158; verify against your linker build.
    try { return soinfo.add(0x158).readPointer().readCString(); } catch (e) { return null; }
}

function findCallConstructors() {
    for (const linker of ['linker64', 'linker']) {
        const addr = Module.findExportByName(linker, '__dl__ZN6soinfo17call_constructorsEv');
        if (addr) return { linker, addr };
    }
    for (const linker of ['linker64', 'linker']) {
        const m = Process.findModuleByName(linker);
        if (!m) continue;
        for (const exp2 of m.enumerateExports()) {
            if (/call_constructors/.test(exp2.name)) return { linker, addr: exp2.address };
        }
    }
    return null;
}

function armAnchor() {
    const an = CONFIG.anchor;
    if (!an.targetSo) return;
    if (an.mode === 'call-constructors') {
        const target = findCallConstructors();
        if (!target) { console.log('[-] call_constructors not found in linker exports'); return; }
        let warned = false;
        const listener = Interceptor.attach(target.addr, {
            onEnter(args) {
                if (anchorState.done) return;
                const soname = readSoNameRaw(args[0]);
                if (soname === null) {
                    if (!warned) { warned = true; console.log('[anchor] WARNING: soname unreadable from soinfo — verify +0x158 against this linker build'); }
                    return;
                }
                if (soname !== an.targetSo) return;
                const m = Process.findModuleByName(an.targetSo);
                if (!m) return;
                anchorState.done = true;
                onAnchor(m.base, m);
                setTimeout(function () { listener.detach(); }, 0);
            }
        });
        console.log('[anchor] watching ' + target.linker + ' call_constructors → ' + an.targetSo);
    } else {
        const dlopen = Module.findExportByName(null, 'android_dlopen_ext');
        if (!dlopen) { console.log('[-] android_dlopen_ext not found — arming the import hook immediately'); installEarlyImportAnchor(); return; }
        Interceptor.attach(dlopen, {
            onEnter(args) {
                const p = args[0].readCString();
                if (p && p.indexOf(an.targetSo) !== -1) {
                    console.log('[anchor] dlopen onEnter: ' + p + ' (init chain not yet running, anchor armed)');
                    installEarlyImportAnchor();
                }
            }
        });
        console.log('[anchor] watching android_dlopen_ext → ' + an.targetSo);
    }
}

function observerFor(base) {
    const OBSERVE = CONFIG.observe;
    if (!OBSERVE.length) { console.log('[-] CONFIG.observe is empty; add version-pinned offsets from the current build'); return; }
    for (const item of OBSERVE) {
        const addr = base.add(item.offset);
        try {
            Interceptor.attach(addr, {
                onLeave(retval) {
                    console.log('[' + item.name + '] ret=' + retval.toInt32() + '   (' + item.note + ')');
                }
            });
            console.log('[observe] ' + item.name + ' @ +0x' + item.offset.toString(16));
        } catch (e) { console.log('[observe-fail] ' + item.name + ': ' + e.message); }
    }
    console.log('== observation table ready — reproduce the detection scenario and read the return-value distribution.');
}
globalThis.observerFor = observerFor;

// ═══════════════════════════════ Stalker ═══════════════════════════════
// Two modes: stalker.module set = function-level call/ret trail scoped to one module
// (cheap, thread unknown); else pin ONE thread (tid or name) with a ring buffer and
// dump the last events on fault — read the dump backwards, the last frame inside the
// suspect .so is the detection source. If the fault pc is in NO mapped range, Stalker
// can never see it (the defense yanked the mapping) — that is the exceptionHunt case.
const RING = [];
let RING_HEAD = 0, RING_COUNT = 0, STALKER_ARMED = false, FOLLOWED = 0, ARM_RANGE = null, INC_RANGE = null;

function stalkerPush(line) {
    RING[RING_HEAD] = line;
    RING_HEAD = (RING_HEAD + 1) % CONFIG.stalker.ringMax;
    if (RING_COUNT < CONFIG.stalker.ringMax) RING_COUNT++;
}

function ringTail(n) {
    const out = [];
    const take = Math.min(n, RING_COUNT);
    let i = (RING_HEAD - take + CONFIG.stalker.ringMax) % CONFIG.stalker.ringMax;
    for (let k = 0; k < take; k++) { out.push(RING[i]); i = (i + 1) % CONFIG.stalker.ringMax; }
    return out;
}

function rangeOfModule(name) {
    try { const m = Process.getModuleByName(name); return { base: m.base, end: m.base.add(m.size) }; } catch (e) { return null; }
}

function stalkerRecord(addr, text) {
    const st = CONFIG.stalker;
    if (!STALKER_ARMED) {
        if (!st.armOnModule) { STALKER_ARMED = true; }
        else {
            if (ARM_RANGE === null) ARM_RANGE = rangeOfModule(st.armOnModule);
            if (!ARM_RANGE || !inR(ARM_RANGE, addr)) return;
            STALKER_ARMED = true;
            stalkerPush('== ARMED — first instruction inside ' + st.armOnModule + ': ' + modOff(addr) + '  ' + text);
        }
    }
    if (INC_RANGE !== null && !inR(INC_RANGE, addr)) return;
    stalkerPush(modOff(addr) + '  ' + text);
}

function stalkerFollow(tid) {
    if (FOLLOWED) return;
    FOLLOWED = tid;
    const st = CONFIG.stalker;
    if (typeof Stalker.exclude === 'function') {
        Process.enumerateModules().forEach(function (m) {
            if (FRIDA_HINT.test(m.name)) { try { Stalker.exclude(m); } catch (e) { /* older Frida wants a range */ } }
        });
    }
    if (st.includeModule) INC_RANGE = rangeOfModule(st.includeModule);
    const opts = {};
    if (st.mode === 'call') {
        opts.events = { call: true, ret: true };
        opts.onReceive = function (events) {
            try {
                Stalker.parse(events, { annotate: true }).forEach(function (ev) {
                    if (ev.type === 'call') stalkerPush('[call] ' + modOff(ev.target) + '   from ' + modOff(ev.location) + '  depth=' + ev.depth);
                    else if (ev.type === 'ret') stalkerPush('[ret]  ' + modOff(ev.location) + '  → ' + modOff(ev.target));
                });
            } catch (e) { /* parse failure must never break the target */ }
        };
    } else {
        opts.transform = function (iterator) {
            let insn;
            while ((insn = iterator.next()) !== null) {
                const addr = insn.address;
                const text = insn.toString();
                iterator.putCallout(function () { stalkerRecord(addr, text); });
            }
        };
    }
    Stalker.follow(tid, opts);
    console.log('[stalker] following tid=' + tid + ' mode=' + st.mode +
        (st.armOnModule ? ' arm-on=' + st.armOnModule : '') + (st.includeModule ? ' include=' + st.includeModule : ''));
}

function stalkerFollowNamed() {
    Process.enumerateThreads().forEach(function (t) {
        if (FOLLOWED) return;
        const name = t.name || readComm(t.id);
        if (name === CONFIG.stalker.name) { console.log('[stalker] "' + CONFIG.stalker.name + '" found: tid=' + t.id); stalkerFollow(t.id); }
    });
}

function stalkerModuleMode(name) {
    const m = Process.getModuleByName(name);
    Stalker.follow(Process.getCurrentThreadId(), {
        events: { call: true, ret: true },
        onReceive(events) {
            Stalker.parse(events).forEach(function (c) {
                const target = ptr(c[2]);   // call: callee · ret: return-to
                if (target.compare(m.base) >= 0 && target.compare(m.base.add(m.size)) < 0)
                    console.log('[' + c[0] + '] ' + DebugSymbol.fromAddress(target));
            });
        }
    });
    console.log('[stalker] module mode: call/ret targets inside ' + name + ' (this thread)');
}

function stalkerWake() {
    const st = CONFIG.stalker;
    STALKER_ARMED = st.armOnModule === '';
    if (st.module) { stalkerModuleMode(st.module); return; }
    if (st.tid) { stalkerFollow(st.tid); return; }
    if (!st.name) { console.log('[stalker] enabled but no tid/name/module set — disarmed'); return; }
    const sn = exp('pthread_setname_np');
    if (sn !== null) {
        Interceptor.attach(sn, {
            onEnter(args) { try { this.matches = args[1].readUtf8String() === st.name; } catch (_) { this.matches = false; } },
            onLeave() { if (this.matches && !FOLLOWED) setImmediate(stalkerFollowNamed); }
        });
    }
    stalkerFollowNamed();
    if (!FOLLOWED) console.log('[stalker] waiting for thread "' + st.name + '" (pthread_setname_np armed)');
}

// ═══════════════════════════════ feature match ═══════════════════════════════
// Reproduces the detector's own search space against the live process, tagged by class.
// HYPOTHESES only — a class is proven only when correlated with an observed detector
// read (procWatch / threadWatch / observer). The rung follows from the class:
//   anon-exec      → bypass-fake-proc-sanitize.js / bypass-maps-redirect-open-replace.js
//   strings        → WHERE the string lives decides the fix: maps lines → maps redirect;
//                    server memory → rusda; agent memory → renamed source build
//   elf-mismatch   → the check is code consistency, not a string: cut the check
//   thread-names   → server-side thread rename (rusda)
//   fds/ports      → patched server on a non-default port (-l 0.0.0.0:8888 + adb forward)
function featureCheckMappings() {
    console.log('\n== [A] anonymous-exec-mapping — r-x with no backing file, and named Frida modules');
    const mods = Process.enumerateModules().filter(function (m) { return FRIDA_HINT.test(m.name) || FRIDA_HINT.test(m.path || ''); });
    mods.forEach(function (m) {
        console.log('   module   ' + m.name + '  ' + m.base + '–' + m.base.add(m.size) + '  path=' + (m.path || '<none>'));
        if (/\(deleted\)/.test(m.path || '')) console.log('            path is "(deleted)" — the file behind it is gone (memfd/anonymous)');
    });
    const anon = allRanges().filter(function (r) { return !r.file && /x/.test(r.protection); });
    anon.forEach(function (r) {
        let name = null;
        try {
            const s = r.base.toString(16).replace('0x', ''), e = r.base.add(r.size).toString(16).replace('0x', '');
            name = readLink('/proc/self/map_files/' + s + '-' + e);
        } catch (e2) { /* EPERM/SELinux */ }
        const memfd = /memfd:/.test(name || ''), frida = FRIDA_HINT.test(name || '');
        console.log('   anon-rx  ' + r.base + '–' + r.base.add(r.size) + '  ' + r.protection + '  map_files=' + (name || '<unreadable>') +
            (memfd ? '  ← memfd (Frida 16+ agent style)' : '') + (frida ? '  ← FRIDA' : ''));
        if (!memfd && !frida) console.log('            anonymous executable mapping — a maps-scan detector could match this by class alone');
    });
    console.log('   → ' + mods.length + ' Frida-looking module(s), ' + anon.length + ' anonymous r-x range(s).');
    return mods.length + anon.length;
}

function featureCheckStrings() {
    console.log('\n== [B] signature-string — what a Memory.scan over the mapped ranges finds');
    const fm = CONFIG.featureMatch;
    let budget = fm.scanTotalMB * 1024 * 1024, hits = 0, scanned = 0;
    const targets = [];
    Process.enumerateModules().filter(function (m) { return FRIDA_HINT.test(m.name) || FRIDA_HINT.test(m.path || ''); })
        .forEach(function (m) { targets.push({ base: m.base, size: m.size, label: 'module ' + m.name }); });
    allRanges().forEach(function (r) {
        const isAnonRx = !r.file && /x/.test(r.protection);
        if (isAnonRx) targets.push({ base: r.base, size: r.size, label: 'anon-rx' });
        else if (fm.deepScan && /r/.test(r.protection)) targets.push({ base: r.base, size: r.size, label: r.file ? r.file.path : 'anon-' + r.protection });
    });
    SIG_STRINGS.forEach(function (s) {
        const pat = asciiPattern(s);
        let found = 0;
        for (let i = 0; i < targets.length && found < 5; i++) {
            const t = targets[i];
            if (t.size > budget) continue;
            budget -= t.size; scanned += t.size;
            let res = [];
            try { res = Memory.scanSync(t.base, t.size, pat); } catch (e) { continue; }
            res.slice(0, 5 - found).forEach(function (hit) {
                const r = Process.findRangeByAddress(hit.address);
                console.log('   "' + s + '"  at ' + hit.address + '  (' + t.label + (r && !r.file ? ', anonymous' : (r && r.file ? ', ' + r.file.path : '')) + ')');
                found++; hits++;
            });
        }
        if (!found) console.log('   "' + s + '"  — not found in the scanned set' + (budget <= 0 ? ' (budget exhausted)' : ''));
    });
    console.log('   → ' + hits + ' hit(s) over ' + (scanned / 1048576).toFixed(1) + ' MB scanned.' + (fm.deepScan ? '' : ' deepScan widens this.'));
    return hits;
}

function readELFHeader(base) {
    let magic;
    try { magic = base.readU32(); } catch (e) { return null; }
    if (magic !== 0x464c457f) return null;
    const is64 = base.add(4).readU8() === 2;
    return is64
        ? { is64: true, phoff: base.add(0x20).readU64(), phentsize: base.add(0x36).readU16(), phnum: base.add(0x38).readU16() }
        : { is64: false, phoff: base.add(0x1c).readU32(), phentsize: base.add(0x2a).readU16(), phnum: base.add(0x2c).readU16() };
}

function featureCheckELF() {
    console.log('\n== [C] elf-vs-maps — PT_LOAD segments the header claims vs what the map shows');
    const mods = Process.enumerateModules().filter(function (m) { return FRIDA_HINT.test(m.name) || FRIDA_HINT.test(m.path || ''); });
    const anon = allRanges().filter(function (r) { return !r.file && /x/.test(r.protection); });
    const targets = mods.map(function (m) { return { base: m.base, size: m.size, label: m.name }; })
        .concat(anon.map(function (r) { return { base: r.base, size: r.size, label: 'anon-rx@' + r.base }; }));
    let checked = 0, bad = 0;
    targets.forEach(function (t) {
        const h = readELFHeader(t.base);
        if (!h) { console.log('   ' + t.label + '  no ELF magic at base — not an ELF image (anonymous code, or JIT)'); return; }
        checked++;
        const loads = [];
        if (h.phnum <= 128) {
            for (let i = 0; i < h.phnum; i++) {
                const p = t.base.add(h.phoff).add(i * h.phentsize);
                try {
                    if (h.is64) { if (p.readU32() === 1) loads.push({ flags: p.add(4).readU32(), vaddr: p.add(0x10).readU64() }); }
                    else { if (p.readU32() === 1) loads.push({ vaddr: p.add(0x8).readU32(), flags: p.add(0x18).readU32() }); }
                } catch (e) { break; }
            }
        }
        const misses = [];
        loads.forEach(function (p, i) {
            const vaddr = t.base.add(p.vaddr);
            const r = Process.findRangeByAddress ? Process.findRangeByAddress(vaddr) : null;
            const wantX = (p.flags & 0x1) !== 0, wantW = (p.flags & 0x2) !== 0, wantR = (p.flags & 0x4) !== 0;
            if (!r) { misses.push('PT_LOAD#' + i + ' vaddr=' + vaddr + ' NOT MAPPED'); return; }
            const prot = r.protection;
            if ((wantX && prot[2] !== 'x') || (wantW && prot[1] !== 'w') || (wantR && prot[0] !== 'r'))
                misses.push('PT_LOAD#' + i + ' vaddr=' + vaddr + ' flags=' + (p.flags & 0x7) + ' but map prot=' + prot);
        });
        if (misses.length) {
            bad++;
            console.log('   ' + t.label + '  MISMATCH (' + misses.length + '):');
            misses.forEach(function (m) { console.log('        ' + m); });
            console.log('        → a header-vs-maps consistency check could match here (rule out a RELRO transition first).');
        } else {
            console.log('   ' + t.label + '  consistent (' + loads.length + ' PT_LOAD verified)');
        }
    });
    console.log('   → ' + checked + ' ELF image(s) checked, ' + bad + ' inconsistent.');
    return bad;
}

function featureCheckThreads() {
    console.log('\n== [D] thread-name — pollers visible in task comm');
    let hits = 0;
    Process.enumerateThreads().forEach(function (t) {
        const name = t.name || readComm(t.id) || '';
        if (THREAD_HINTS.test(name)) { hits++; console.log('   tid=' + t.id + '  comm="' + name + '"  ← matches a known poller name'); }
    });
    console.log('   → ' + hits + ' thread(s) match. (rusda renames the built-in ones; an app-created poller keeps the SDK name.)');
    return hits;
}

function featureCheckFds() {
    console.log('\n== [E] fd-port — linjector/memfd fds and the frida-server default ports');
    let hits = 0;
    for (let fd = 0; fd < CONFIG.featureMatch.fdMax; fd++) {
        const target = readLink('/proc/self/fd/' + fd);
        if (target && /linjector|memfd:frida|gum|frida/i.test(target)) { hits++; console.log('   fd ' + fd + ' → ' + target); }
    }
    const tcp = readFile('/proc/self/net/tcp');
    if (tcp) {
        tcp.split('\n').slice(1).forEach(function (line) {
            const f = line.trim().split(/\s+/);
            if (f.length < 4) return;
            const port = (f[1].split(':')[1] || '').toUpperCase();
            if (PORT_HITS[port]) { hits++; console.log('   tcp LISTEN state=' + f[3] + ' local=' + f[1] + '  ← port ' + PORT_HITS[port] + ' (frida-server default)'); }
        });
    }
    const unix = readFile('/proc/self/net/unix');
    if (unix) unix.split('\n').forEach(function (line) { if (/linjector|frida/i.test(line)) { hits++; console.log('   unix ' + line.trim().slice(0, 120)); } });
    console.log('   → ' + hits + ' fd/port artifact(s).');
    return hits;
}

function featureReport() {
    console.log('\n######## feature-match report (what the target can see) ########');
    const a = featureCheckMappings();
    const b = featureCheckStrings();
    const c = featureCheckELF();
    const d = featureCheckThreads();
    const e = featureCheckFds();
    console.log('\n######## classes: anon-exec=' + a + ' strings=' + b + ' elf-mismatch=' + c + ' thread-names=' + d + ' fds/ports=' + e + ' ########');
    console.log('HYPOTHESES only — correlate a class with an observed detector read before picking a rung.');
}
globalThis.__featureReport = featureReport;

// ═══════════════════════════════ unified fault handler ═══════════════════════════════
// One handler for both exception classification and the Stalker dump. Returns false —
// the process is allowed to die with the kill intact (swallowing an access-violation
// retries the faulting instruction and masks the evidence).
Process.setExceptionHandler(function (details) {
    try { if (FOLLOWED) { Stalker.unfollow(FOLLOWED); Stalker.flush(); } } catch (e) { /* not following */ }
    const tid = Process.getCurrentThreadId();
    const pc = (function () { try { return pcOf(details.context); } catch (e) { return null; } })();
    if (CONFIG.exceptionHunt.enabled) {
        const shape = classify(details);
        console.log('\n=== EXCEPTION ' + details.type + '  shape=' + shape + '  tid=' + tid + ' ===');
        if (pc) console.log('    pc            ' + snapOff(pc) + (tid === FOLLOWED ? '   (the traced thread)' : (FOLLOWED ? '   (NOT the traced thread — the killer may be another thread)' : '')));
        if (details.memory && details.memory.address) console.log('    fault address ' + snapOff(details.memory.address) + '  op=' + (details.memory.operation || '?'));
        else if (details.address) console.log('    fault address ' + snapOff(details.address));
        dumpRegs(details.context);
        if (details.context) {
            shortBacktrace(details.context, 12).forEach(function (a, i) {
                let isPc = false;
                try { isPc = pc !== null && a.equals(pc); } catch (e) { /* no pc */ }
                console.log('    #' + i + ' ' + snapOff(a) + (isPc ? '   <- fault pc' : ''));
            });
        }
        if (shape === 'frida-mapping-yanked') {
            console.log('    → Frida\'s own code page was unmapped by the target: the yanking code is the\n' +
                '      detector — find the munmap/mprotect caller (CONFIG.procWatch watches /proc; this needs munmap).');
        } else if (shape === 'detector-probe') {
            console.log('    → the faulting access is aimed at Frida\'s mapping: a probe. If the app survives the same\n' +
                '      signal, the detector installed its own handler to read the fault as a verdict (guard-page probe).');
        } else if (shape === 'deliberate-kill') {
            console.log('    → deliberate kill: the caller frames name the module that decided to die.');
        } else if (shape === 'in-module-fault' && !CONFIG.stalker.enabled) {
            console.log('    → ordinary fault inside mapped code — CONFIG.stalker on that thread gives the instruction chain.');
        }
    } else {
        console.log('\n=== EXCEPTION ' + details.type + '  tid=' + tid + ' ===');
    }
    if (CONFIG.stalker.enabled && RING_COUNT) {
        console.log('--- last ' + Math.min(CONFIG.stalker.dumpN, RING_COUNT) + ' recorded events (oldest → newest, ' + RING_COUNT + ' total) ---');
        ringTail(CONFIG.stalker.dumpN).forEach(function (l, i) { console.log('  ' + String(i + 1) + '. ' + l); });
        console.log('--- end of trace. Read backwards: the last frame inside the suspect .so is the source. ---');
    }
    return false;
});

// ═══════════════════════════════ RPC ═══════════════════════════════
globalThis.__loadChain = function () {
    const s = ts();
    const phase = s.ctorDepth > 0 ? 'CONSTRUCTORS(.init_array)' : (s.jniActive ? 'JNI_OnLoad(' + s.jniActive + ')' : 'LOAD');
    console.log('== in-flight: ' + (inFlight() ? inFlight().path : '(none)') + '  phase=' + phase);
};
globalThis.__jniOnLoads = function () { console.log('== JNI_OnLoad hooked: ' + Array.from(jniHooked).join(', ')); };
globalThis.__threadReport = function () {
    const rows = Object.keys(threadStats.byCreator).sort(function (a, b) { return threadStats.byCreator[b] - threadStats.byCreator[a]; });
    console.log('== threads created (filtered view): ' + threadStats.total);
    for (const m of rows) console.log('   ' + m + ': ' + threadStats.byCreator[m]);
    if (!rows.length) console.log('   (nothing matched the filter — set threadWatch.showAll and re-run)');
};
globalThis.__excSnap = function () { takeSnap(); };
globalThis.__stalkerWhere = function () { console.log('[stalker] traced tid=' + FOLLOWED + ' armed=' + STALKER_ARMED + ' events=' + RING_COUNT); };
globalThis.__stalkerDump = function (n) { ringTail(n || 200).forEach(function (l) { console.log('  ' + l); }); };
globalThis.__stalkerStop = function () { try { Stalker.unfollow(FOLLOWED); Stalker.flush(); } catch (e) { } FOLLOWED = FOLLOWED || -1; console.log('[stalker] stopped'); };
globalThis.__stalkerArm = function () { STALKER_ARMED = true; console.log('[stalker] armed manually'); };

// ═══════════════════════════════ boot ═══════════════════════════════
(function boot() {
    if (CONFIG.loadChain.enabled) {
        const dlopenAddr = exp('dlopen');
        const extAddr = Module.findExportByName(null, 'android_dlopen_ext');
        if (dlopenAddr) hookOpen('dlopen', dlopenAddr);
        if (extAddr) hookOpen('android_dlopen_ext', extAddr);
        if (!dlopenAddr && !extAddr) console.log('[warn] neither dlopen nor android_dlopen_ext resolved');
        hookCallConstructors();
        if (CONFIG.loadChain.killPaths) hookKillPaths();
    } else if (CONFIG.loadChain.killPaths) {
        hookKillPaths();
    }
    if (CONFIG.exceptionHunt.enabled && CONFIG.exceptionHunt.snapshot) takeSnap();
    if (CONFIG.procWatch.enabled) hookProcWatch();
    if (CONFIG.threadWatch.enabled) hookThreadWatch();
    if (CONFIG.registerNatives.enabled) setImmediate(hookRegisterNatives);
    armAnchor();
    if (CONFIG.stalker.enabled) { RING.length = CONFIG.stalker.ringMax; stalkerWake(); }
    if (CONFIG.featureMatch.enabled) featureReport();

    console.log('\n== detect.js ready (passive). Sensors on: ' +
        ['loadChain', 'procWatch', 'threadWatch', 'registerNatives', 'exceptionHunt', 'anchor', 'stalker', 'featureMatch']
            .filter(function (k) { return k === 'anchor' ? CONFIG.anchor.targetSo : CONFIG[k].enabled; }).join(', ') + ' ==');
    console.log('== first run: reproduce the death, read the VERDICT/shape lines, then enable the sensor they point at.');
})();
