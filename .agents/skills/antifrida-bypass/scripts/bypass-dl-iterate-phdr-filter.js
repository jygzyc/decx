// bypass-dl-iterate-phdr-filter.js — counter a linker-state scan (dl_iterate_phdr walk).
//
// Purpose: a detector that walks loaded ELFs via dl_iterate_phdr and kills on a frida
//      match. We hook dl_iterate_phdr's onEnter, swap args[0] for our own wrapper
//      callback, and return 0 for frida-related SOs — to the caller they look like they
//      were never enumerated. Applies wherever the scan is a plain callback walk; if the
//      detector keeps its own module list (or reads maps instead), this does nothing —
//      that is a locate/trace result, not a guess.
// Pitfall: once a NativeCallback is GC'd, every later linker call dereferences a dangling
//      pointer and the process dies instantly — so hold them in a Set (SKILL.md Rule 6).
// Note: a module loaded through a private linker (Frida 12+ linjector) may be visible in
//      maps but absent from dlpi_name — a name filter cannot catch it; that class is the
//      maps/anonymous-mapping vector, not this one.
// Usage: frida -U -f <pkg> -l bypass-dl-iterate-phdr-filter.js
// Config: FRIDA_SO_RE — names to hide. Extend it with what locate/trace showed the
//      detector actually matching (do not add names "just in case").
// Source: DECX-authored for this skill; techniques per references/methodology.md § Provenance
'use strict';

const FRIDA_SO_RE = /frida|gum-js|linjector|gadget/;

// struct dl_phdr_info starts with ElfW(Addr), then const char *dlpi_name.
const DLPI_NAME_OFFSET = Process.pointerSize;

const wrapperRefs = new Set();   // ★ must keep references to prevent GC (Rule 6)
const origFn = Module.findExportByName(null, 'dl_iterate_phdr');
if (origFn === null) {
    console.log('[skip] dl_iterate_phdr not exported — target cannot use this scan');
} else {
    let nameFailLogged = false;
    Interceptor.attach(origFn, {
        onEnter(args) {
            const original = new NativeFunction(args[0], 'int', ['pointer', 'size_t', 'pointer']);
            const wrap = new NativeCallback(function (info, size, data) {
                let name = '';
                try {
                    name = info.add(DLPI_NAME_OFFSET).readPointer().readCString();
                } catch (e) {
                    if (!nameFailLogged) { nameFailLogged = true; console.log('[warn] dlpi_name unreadable (' + e.message + ') — unnamed entries cannot be filtered'); }
                }
                if (name && FRIDA_SO_RE.test(name)) {
                    console.log('[filter] hidden from dl_iterate_phdr: ' + name);
                    return 0;   // skipped → as if it never existed
                }
                return original(info, size, data);
            }, 'int', ['pointer', 'size_t', 'pointer']);
            wrapperRefs.add(wrap);
            this.wrap = wrap;
            args[0] = wrap;
        },
        onLeave() {
            // dl_iterate_phdr invokes the callback synchronously; release this
            // wrapper after the walk instead of leaking one per scan.
            wrapperRefs.delete(this.wrap);
        }
    });
    console.log('[hook] dl_iterate_phdr → hiding ' + FRIDA_SO_RE);
}
