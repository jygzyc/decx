// bypass-ssl-plaintext-capture.js — capture TLS plaintext at the native choke point
//
// Purpose: the SDK's reporting/telemetry channel is often the only place the app's
//      verdict (and the guard's evidence) becomes visible in cleartext. Java-layer
//      capture (SSLSocket / okhttp interceptors) dies quickly under guards; hooking
//      the native SSL_read/SSL_write exports survives longer because it happens
//      below the guard's Java surface and outside the guarded library itself.
// Usage: frida -U -f <pkg> -l bypass-ssl-plaintext-capture.js
//      Tune MODULE_RE if the exports live elsewhere; MAX_CHARS caps each dump.
// Notes: read-only observation — it bypasses nothing, it gives you the app's own
//      words. If the log floods, capture only inside a checker window (set a flag in
//      the checker's onEnter/onLeave and gate dump() on it — methodology, IO
//      correlation).
// Source: community write-up; see references/methodology.md § Provenance
'use strict';

const MODULE_RE = /ssl|crypto|conscrypt|boringssl/i;   // modules allowed to own the export
const MAX_CHARS = 256;                                  // cap per dump: never flood on binary data

function dump(ptr, len, tag) {
    if (!ptr || ptr.isNull() || len <= 0) return;
    try {
        const cap = Math.min(len, MAX_CHARS);
        const s = ptr.readUtf8String(cap);
        if (s) console.log(tag + ' ' + len + 'B: ' + s.replace(/[\r\n]+/g, '\\n'));
        else console.log(tag + ' ' + len + 'B <non-utf8>');
    } catch (e) {
        console.log(tag + ' ' + len + 'B <unreadable>');
    }
}

function arm(name, handler) {
    const addr = Module.findExportByName(null, name);
    if (!addr) {
        console.log('[ssl] ' + name + ' not exported anywhere — adjust MODULE_RE or the target');
        return false;
    }
    const owner = Process.findModuleByAddress(addr);
    if (owner && !MODULE_RE.test(owner.name)) {
        console.log('[ssl] ' + name + ' belongs to ' + owner.name + ' — outside MODULE_RE, skipped');
        return false;
    }
    Interceptor.attach(addr, handler);
    console.log('[ssl] hooked ' + name + ' in ' + (owner ? owner.name : '<unknown>'));
    return true;
}

// SSL_write(SSL *ssl, const void *buf, int num) — plaintext is in the buffer on enter
arm('SSL_write', {
    onEnter(args) { dump(args[1], args[2].toInt32(), '[ssl.w]'); }
});

// SSL_read(SSL *ssl, void *buf, int num) — the buffer is only valid on return
arm('SSL_read', {
    onEnter(args) { this.buf = args[1]; this.n = args[2].toInt32(); },
    onLeave(retval) {
        const got = retval.toInt32();
        if (got > 0) dump(this.buf, Math.min(got, this.n), '[ssl.r]');
    }
});
