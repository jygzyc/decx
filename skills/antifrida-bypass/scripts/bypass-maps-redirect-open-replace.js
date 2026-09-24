// Source: community write-up; see references/methodology.md § Provenance
// Notes: the bypass example from that article's "detecting /proc/self/maps" section — using
// maps as the example: Interceptor.replace libc `open`, redirect reads of
// /proc/<pid>/maps to a forged file, hide frida traces via per-string replacement.
// Inputs: run bypass-fake-proc-sanitize.js in OBSERVE_ONLY mode first to confirm that
// maps (and only maps) is what the detector reads.
// Caveats: (1) chunks are read in 512-byte pieces, so a marker straddling a chunk boundary
// can survive in the forged copy — re-read whole-file or drop chunking if the detector still
// finds you; (2) the legacy Frida `File` class is gone in Frida 17 — this version writes the
// forged file with libc fopen/fwrite/fclose instead; (3) `open` is variadic, so the mode
// argument is carried through.
// Usage: frida -U -f <pkg> -l bypass-maps-redirect-open-replace.js  (self-arms on load:
//        calls mapsRedirect() once FAKE_MAPS_PATH is set to a path the app can write)
'use strict';

const replacementRefs = new Set(); // keep NativeCallbacks alive (SKILL.md Rule 6)

const FAKE_MAPS_PATH = '/data/data/<your.package>/maps'; // pick a path the app can write
const MARKERS = [
    '/data/local/tmp/re.frida.server/frida-agent-64.so',
    're.frida.server',
    'frida-agent-64.so',
    'frida-agent-32.so',
    'frida',
    '/data/local/tmp',
];

function mapsRedirect() {
    const fakeMaps = Memory.allocUtf8String(FAKE_MAPS_PATH);
    const openPtr = Module.getExportByName('libc.so', 'open');
    const open = new NativeFunction(openPtr, 'int', ['pointer', 'int', 'int']);
    const read = new NativeFunction(Module.getExportByName('libc.so', 'read'), 'int', ['int', 'pointer', 'int']);
    const fopen = new NativeFunction(Module.getExportByName('libc.so', 'fopen'), 'pointer', ['pointer', 'pointer']);
    const fwrite = new NativeFunction(Module.getExportByName('libc.so', 'fwrite'), 'int', ['pointer', 'int', 'int', 'pointer']);
    const strlen = new NativeFunction(Module.getExportByName('libc.so', 'strlen'), 'ulong', ['pointer']);
    const fclose = new NativeFunction(Module.getExportByName('libc.so', 'fclose'), 'int', ['pointer']);
    const close = new NativeFunction(Module.getExportByName('libc.so', 'close'), 'int', ['int']);

    const replacement = new NativeCallback(function (pathname, flag, mode) {
        const fd = open(pathname, flag, mode);
        if (pathname.isNull() || fd < 0) return fd;
        const ch = pathname.readCString();
        if (ch && ch.indexOf('/proc/') >= 0 && ch.indexOf('maps') >= 0) {
            console.log('[maps-redirect] forging copy for: ' + ch);
            const fp = fopen(fakeMaps, Memory.allocUtf8String('w'));
            if (fp.isNull()) return fd; // cannot forge — fall through to the real fd
            const buf = Memory.alloc(512);
            let n;
            while ((n = read(fd, buf, 512)) > 0) {
                let s;
                try { s = buf.readUtf8String(n); } catch (e) { s = buf.readCString(); }
                for (const marker of MARKERS) s = s.replaceAll(marker, 'FakingMaps');
                const out = Memory.allocUtf8String(s);
                fwrite(out, 1, strlen(out), fp);
            }
            fclose(fp);
            close(fd);
            return open(fakeMaps, flag, mode); // hand back the sanitized copy
        }
        return fd;
    }, 'int', ['pointer', 'int', 'int']);
    replacementRefs.add(replacement);
    Interceptor.replace(openPtr, replacement);
}

mapsRedirect();
