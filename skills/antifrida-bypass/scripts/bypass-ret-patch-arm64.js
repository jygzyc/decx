// bypass-ret-patch-arm64.js — confirmed, targeted RET patch (ARM64)
//
// Purpose: after the locate/trace phases confirm "these entries only do detection /
//      thread polling", write RET directly at the function entries so they return
//      immediately. This is the last resort — writing .text can trigger integrity
//      detection in self-checking .so files, so you must first hold evidence that
//      "this function IS the detection entry" (magic number observation + a cross-check
//      against the decompilation).
// Usage: frida -U -f <pkg> -l bypass-ret-patch-arm64.js
//      With AUTO_ARM=true (the default) the script polls for TARGET_MODULE and arms the
//      moment it maps — matching the early-anchor timing on its own. The empty target
//      table keeps the default run inert: filling offsets IS the activation step.
//      To patch from another script's anchor instead, call retPatch(base) manually.
// Source: community write-up; see references/methodology.md § Provenance
// Note: offsets are version-specific — a new .so version must be re-located by
//      decompiling; reusing offsets across versions is the most common "blind hooking"
//      mistake. Mind the return-value semantics: some callers check w0 (look at the call
//      site to see whether it tests for zero or non-zero before writing RET).

'use strict';

if (Process.arch !== 'arm64') throw new Error('bypass-ret-patch-arm64.js is arm64-only (ret opcode)');

// ↓ Evidence chain: every offset must be explainable as "what it is" — cross-confirmed
//   via decompilation + magic number observation
const RET_PATCH_TARGETS = [
    // { offset: 0x0, note: 'detection-thread creation/polling entry — fill in after confirming via decompilation + observation' },
    // { offset: 0x..., note: 'your target: fill in after confirming via decompilation + observation' },
];

function retPatch(base) {
    if (RET_PATCH_TARGETS.length === 0) {
        console.log('[-] RET_PATCH_TARGETS is empty — fill evidence-confirmed offsets first (Rule 4)');
        return;
    }
    for (const t of RET_PATCH_TARGETS) {
        const addr = base.add(t.offset);
        try {
            // patchCode leaves no persistent RWX page behind (a W^X anomaly is itself a signal)
            Memory.patchCode(addr, 4, function (code) { code.writeU32(0xd65f03c0); });
            console.log('[patch] RET → +0x' + t.offset.toString(16) + '  (' + t.note + ')');
        } catch (e) {
            console.log('[patch-fail] +0x' + t.offset.toString(16) + ': ' + e.message);
        }
    }
}

// AUTO_ARM polls for the module and patches the moment it maps — same timing as the
// early anchor, without wiring an invasive write into an observe-only script. With an
// empty target table retPatch() is inert, so the default stays safe (Rule 4).
const AUTO_ARM = true;
const TARGET_MODULE = 'libtarget.so'; // ← your target
if (AUTO_ARM) {
    const t = setInterval(() => {
        const mod = Process.findModuleByName(TARGET_MODULE);
        if (!mod) return;
        clearInterval(t);
        retPatch(mod.base);
    }, 50);
} else {
    console.log('== ret-patch-arm64 ready (manual mode): call retPatch(base) once the anchor reports the base.');
    console.log('== Only enable the offset table once the evidence is confirmed; writing .text carries self-check risk (see the bypass tiers in SKILL.md).');
}
