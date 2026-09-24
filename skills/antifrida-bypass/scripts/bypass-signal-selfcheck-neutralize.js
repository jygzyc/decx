// bypass-signal-selfcheck-neutralize.js — neutralizing signal-based self-check anti-debug (generic template)
//
// Principle (signal self-check class):
//   The .so registers its own SIGTRAP handler during JNI load (its job: clear the
//   "being debugged" dirty flag + reinstall), then raises SIGTRAP and reads the flag
//   back: cleared to 0 = clean; still dirty = the signal was intercepted = judged as
//   being debugged → suicide.
//   Frida's exceptor installs a higher-priority signal handler that swallows SIGTRAP,
//   so attaching Frida always leaves the flag dirty.
// Neutralization point (before the signal is truly delivered, fooling both the
// decision input and the trigger source at once):
//   hook libc raise: at the exact moment "the arg is SIGTRAP and the caller is the target .so"
//     ① write 0 to the dirty flag (pretend the handler already ran)
//     ② change the signal number to 0 (raise(0) is a no-op, giving the exceptor
//       nothing to intercept)
// Usage: set TARGET_LIB / FLAG_OFFSET (from decompilation: the global flag that the
//      handler clears to 0).
// Source: community write-up; see references/methodology.md § Provenance
//      (countermeasures part 1 — the signal-selfcheck write-up).
// Note: other .so files may self-check with SIGSEGV/SIGBUS or other PinkPanic
//      variants — adapt SIGNAL and the flag semantics per decompilation; the dirty
//      flag offset is version-specific.

'use strict';

const TARGET_LIB = 'libtarget.so'; // ← target .so
const SIGNAL = 5;                 // SIGTRAP; adapt per decompilation
const FLAG_OFFSET = null;         // ← number from the current build's decompiled handler
                                  //    (relative to module base); null fails closed

if (FLAG_OFFSET === null) {
    throw new Error('FLAG_OFFSET is unset; refusing to write to the module header');
}

Interceptor.attach(Module.getExportByName('libc.so', 'raise'), {
    onEnter(args) {
        if (args[0].toInt32() !== SIGNAL) return;
        const m = Process.findModuleByAddress(this.returnAddress);
        if (!m || m.name !== TARGET_LIB) return;
        const flag = m.base.add(FLAG_OFFSET);
        const range = Process.findRangeByAddress(flag);
        if (!range || range.protection.indexOf('w') === -1) {
            console.log('[-] refusing FLAG write outside a writable mapping: ' + flag);
            return;
        }
        flag.writeS32(0);   // ① pretend the handler already cleared the flag to 0
        args[0] = ptr(0);   // ② change the signal to 0, a no-op
        console.log('[neutralize] ' + TARGET_LIB + ' raise(SIGTRAP) neutralized');
    }
});

console.log('== signal-selfcheck-neutralize ready: TARGET_LIB=' + TARGET_LIB +
    ' SIGNAL=' + SIGNAL + ' FLAG=+0x' + FLAG_OFFSET.toString(16));
