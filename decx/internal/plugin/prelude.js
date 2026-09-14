/**
 * Prelude for the embedded DECX plugin runtime.
 *
 * It defines the Node-ish globals that plugins use (Buffer, console, process,
 * TextEncoder, TextDecoder) on top of the small host object that the Go side
 * installs at `globalThis.__decxHost`. Everything here is plain ES2020 that the
 * embedded engine evaluates before it loads a plugin entry.
 */
(function () {
  "use strict";

  const host = globalThis.__decxHost || {
    stderrWrite: function () {},
    stdoutWrite: function () {},
  };

  // ── UTF-8 codec ─────────────────────────────────────────────────────────

  const REPLACEMENT = 0xfffd;

  function utf8Encode(text) {
    const bytes = [];
    for (let i = 0; i < text.length; i++) {
      let code = text.charCodeAt(i);
      if (code >= 0xd800 && code <= 0xdbff && i + 1 < text.length) {
        const next = text.charCodeAt(i + 1);
        if (next >= 0xdc00 && next <= 0xdfff) {
          code = 0x10000 + ((code - 0xd800) << 10) + (next - 0xdc00);
          i += 1;
        }
      }
      if (code < 0x80) {
        bytes.push(code);
      } else if (code < 0x800) {
        bytes.push(0xc0 | (code >> 6), 0x80 | (code & 0x3f));
      } else if (code < 0x10000) {
        bytes.push(0xe0 | (code >> 12), 0x80 | ((code >> 6) & 0x3f), 0x80 | (code & 0x3f));
      } else {
        bytes.push(
          0xf0 | (code >> 18),
          0x80 | ((code >> 12) & 0x3f),
          0x80 | ((code >> 6) & 0x3f),
          0x80 | (code & 0x3f),
        );
      }
    }
    return bytes;
  }

  function utf8Decode(view, start, end) {
    let text = "";
    let i = start;
    while (i < end) {
      const first = view[i];
      let code = 0;
      let size = 1;
      if (first < 0x80) {
        code = first;
      } else if ((first & 0xe0) === 0xc0) {
        code = first & 0x1f;
        size = 2;
      } else if ((first & 0xf0) === 0xe0) {
        code = first & 0x0f;
        size = 3;
      } else if ((first & 0xf8) === 0xf0) {
        code = first & 0x07;
        size = 4;
      } else {
        code = -1;
      }
      let valid = code >= 0 && i + size <= end;
      if (valid) {
        for (let k = 1; k < size; k++) {
          const next = view[i + k];
          if ((next & 0xc0) !== 0x80) {
            valid = false;
            break;
          }
          code = (code << 6) | (next & 0x3f);
        }
      }
      if (!valid) {
        text += String.fromCharCode(REPLACEMENT);
        i += 1;
        continue;
      }
      if (code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff)) {
        text += String.fromCharCode(REPLACEMENT);
        i += size;
        continue;
      }
      if (code < 0x10000) {
        text += String.fromCharCode(code);
      } else {
        const adjusted = code - 0x10000;
        text += String.fromCharCode(0xd800 + (adjusted >> 10), 0xdc00 + (adjusted & 0x3ff));
      }
      i += size;
    }
    return text;
  }

  function normalizeEncoding(encoding) {
    const label = String(encoding === undefined || encoding === null ? "utf8" : encoding).toLowerCase();
    switch (label) {
      case "utf8":
      case "utf-8":
        return "utf8";
      case "hex":
        return "hex";
      case "base64":
        return "base64";
      case "latin1":
      case "binary":
        return "latin1";
      case "ascii":
        return "ascii";
      default:
        throw new TypeError("Unknown encoding: " + encoding);
    }
  }

  const HEX = "0123456789abcdef";

  function encodeString(text, encoding) {
    switch (normalizeEncoding(encoding)) {
      case "utf8":
        return utf8Encode(text);
      case "latin1":
      case "ascii": {
        const bytes = [];
        for (let i = 0; i < text.length; i++) bytes.push(text.charCodeAt(i) & 0xff);
        return bytes;
      }
      case "hex": {
        const bytes = [];
        for (let i = 0; i + 1 < text.length; i += 2) bytes.push(parseInt(text.substr(i, 2), 16) & 0xff);
        return bytes;
      }
      case "base64": {
        const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
        const bytes = [];
        let buffer = 0;
        let bits = 0;
        for (let i = 0; i < text.length; i++) {
          const ch = text[i];
          if (ch === "=") break;
          const value = alphabet.indexOf(ch);
          if (value < 0) continue;
          buffer = (buffer << 6) | value;
          bits += 6;
          if (bits >= 8) {
            bits -= 8;
            bytes.push((buffer >> bits) & 0xff);
          }
        }
        return bytes;
      }
      default:
        return [];
    }
  }

  function decodeString(view, start, end, encoding) {
    switch (normalizeEncoding(encoding)) {
      case "utf8":
        return utf8Decode(view, start, end);
      case "latin1":
      case "ascii": {
        let text = "";
        for (let i = start; i < end; i++) text += String.fromCharCode(view[i]);
        return text;
      }
      case "hex": {
        let text = "";
        for (let i = start; i < end; i++) text += HEX[view[i] >> 4] + HEX[view[i] & 0x0f];
        return text;
      }
      case "base64": {
        const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
        let text = "";
        for (let i = start; i < end; i += 3) {
          const a = view[i];
          const hasB = i + 1 < end;
          const hasC = i + 2 < end;
          const b = hasB ? view[i + 1] : 0;
          const c = hasC ? view[i + 2] : 0;
          text += alphabet[a >> 2];
          text += alphabet[((a & 0x03) << 4) | (b >> 4)];
          text += hasB ? alphabet[((b & 0x0f) << 2) | (c >> 6)] : "=";
          text += hasC ? alphabet[c & 0x3f] : "=";
        }
        return text;
      }
      default:
        return "";
    }
  }

  function makeView(value, offset, length) {
    const view = new Uint8Array(value, offset, length);
    Object.setPrototypeOf(view, Buffer.prototype);
    return view;
  }

  // ── Buffer ──────────────────────────────────────────────────────────────

  class Buffer extends Uint8Array {
    static alloc(size, fill, encoding) {
      const length = Number(size) || 0;
      if (length < 0) throw new RangeError("Invalid typed array length");
      const buffer = makeView(new ArrayBuffer(length), 0, length);
      if (fill !== undefined) buffer.fill(fill, 0, length, encoding);
      return buffer;
    }

    static allocUnsafe(size) {
      return Buffer.alloc(size);
    }

    static from(value, encodingOrOffset, length) {
      if (typeof value === "string") {
        const bytes = encodeString(value, encodingOrOffset);
        const buffer = Buffer.alloc(bytes.length);
        for (let i = 0; i < bytes.length; i++) buffer[i] = bytes[i];
        return buffer;
      }
      if (value instanceof ArrayBuffer) {
        const offset = Number(encodingOrOffset) || 0;
        const size = length === undefined ? value.byteLength - offset : Number(length);
        return makeView(value, offset, size);
      }
      if (ArrayBuffer.isView(value) || value instanceof Buffer) {
        const source = new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
        const buffer = Buffer.alloc(source.length);
        buffer.set(source);
        return buffer;
      }
      if (Array.isArray(value)) {
        const buffer = Buffer.alloc(value.length);
        for (let i = 0; i < value.length; i++) buffer[i] = Number(value[i]) & 0xff;
        return buffer;
      }
      if (value && typeof value === "object" && typeof value.length === "number") {
        return Buffer.from(Array.prototype.slice.call(value));
      }
      throw new TypeError("The first argument must be a string, Buffer, ArrayBuffer or Array");
    }

    static concat(list, totalLength) {
      const parts = Array.prototype.slice.call(list);
      let size = 0;
      for (const part of parts) {
        if (!ArrayBuffer.isView(part)) throw new TypeError("list argument must be an Array of Buffers");
        size += part.byteLength;
      }
      if (totalLength !== undefined) size = Number(totalLength) || 0;
      const buffer = Buffer.alloc(size);
      let offset = 0;
      for (const part of parts) {
        const view = new Uint8Array(part.buffer, part.byteOffset, part.byteLength);
        const room = Math.min(view.length, Math.max(0, size - offset));
        buffer.set(view.subarray(0, room), offset);
        offset += view.length;
        if (offset >= size) break;
      }
      return buffer;
    }

    static isBuffer(value) {
      return value instanceof Buffer;
    }

    static byteLength(value, encoding) {
      if (typeof value !== "string") {
        if (ArrayBuffer.isView(value)) return value.byteLength;
        if (value instanceof ArrayBuffer) return value.byteLength;
        throw new TypeError("The first argument must be a string, Buffer or ArrayBuffer");
      }
      return encodeString(value, encoding).length;
    }

    readUInt8(offset) {
      return this[offset];
    }

    readInt8(offset) {
      const value = this[offset];
      return value & 0x80 ? value - 0x100 : value;
    }

    readUInt16LE(offset) {
      return this[offset] | (this[offset + 1] << 8);
    }

    readUInt16BE(offset) {
      return (this[offset] << 8) | this[offset + 1];
    }

    readInt16LE(offset) {
      const value = this.readUInt16LE(offset);
      return value & 0x8000 ? value - 0x10000 : value;
    }

    readInt16BE(offset) {
      const value = this.readUInt16BE(offset);
      return value & 0x8000 ? value - 0x10000 : value;
    }

    readUInt32LE(offset) {
      return (this[offset] | (this[offset + 1] << 8) | (this[offset + 2] << 16) | (this[offset + 3] << 24)) >>> 0;
    }

    readUInt32BE(offset) {
      return ((this[offset] << 24) | (this[offset + 1] << 16) | (this[offset + 2] << 8) | this[offset + 3]) >>> 0;
    }

    readInt32LE(offset) {
      return this[offset] | (this[offset + 1] << 8) | (this[offset + 2] << 16) | (this[offset + 3] << 24);
    }

    readInt32BE(offset) {
      return (this[offset] << 24) | (this[offset + 1] << 16) | (this[offset + 2] << 8) | this[offset + 3];
    }

    readBigUInt64LE(offset) {
      let value = 0n;
      for (let i = 7; i >= 0; i--) value = (value << 8n) | BigInt(this[offset + i]);
      return value;
    }

    readBigUInt64BE(offset) {
      let value = 0n;
      for (let i = 0; i < 8; i++) value = (value << 8n) | BigInt(this[offset + i]);
      return value;
    }

    readBigInt64LE(offset) {
      let value = this.readBigUInt64LE(offset);
      if (value & 0x8000000000000000n) value -= 0x10000000000000000n;
      return value;
    }

    readBigInt64BE(offset) {
      let value = this.readBigUInt64BE(offset);
      if (value & 0x8000000000000000n) value -= 0x10000000000000000n;
      return value;
    }

    writeUInt8(value, offset) {
      this[offset] = Number(value) & 0xff;
      return offset + 1;
    }

    writeInt8(value, offset) {
      this[offset] = Number(value) & 0xff;
      return offset + 1;
    }

    writeUInt16LE(value, offset) {
      const number = Number(value) & 0xffff;
      this[offset] = number & 0xff;
      this[offset + 1] = (number >> 8) & 0xff;
      return offset + 2;
    }

    writeUInt16BE(value, offset) {
      const number = Number(value) & 0xffff;
      this[offset] = (number >> 8) & 0xff;
      this[offset + 1] = number & 0xff;
      return offset + 2;
    }

    writeUInt32LE(value, offset) {
      const number = Number(value) >>> 0;
      this[offset] = number & 0xff;
      this[offset + 1] = (number >> 8) & 0xff;
      this[offset + 2] = (number >> 16) & 0xff;
      this[offset + 3] = (number >> 24) & 0xff;
      return offset + 4;
    }

    writeUInt32BE(value, offset) {
      const number = Number(value) >>> 0;
      this[offset] = (number >> 24) & 0xff;
      this[offset + 1] = (number >> 16) & 0xff;
      this[offset + 2] = (number >> 8) & 0xff;
      this[offset + 3] = number & 0xff;
      return offset + 4;
    }

    writeBigUInt64LE(value, offset) {
      let number = BigInt(value);
      for (let i = 0; i < 8; i++) {
        this[offset + i] = Number(number & 0xffn);
        number >>= 8n;
      }
      return offset + 8;
    }

    writeBigUInt64BE(value, offset) {
      let number = BigInt(value);
      for (let i = 7; i >= 0; i--) {
        this[offset + i] = Number(number & 0xffn);
        number >>= 8n;
      }
      return offset + 8;
    }

    write(string, offset, length, encoding) {
      const start = Number(offset) || 0;
      let label = encoding;
      let max = length;
      if (typeof length === "string") {
        label = length;
        max = undefined;
      }
      let bytes = encodeString(String(string), label);
      if (max !== undefined) bytes = bytes.slice(0, Number(max));
      const room = Math.max(0, Math.min(bytes.length, this.length - start));
      for (let i = 0; i < room; i++) this[start + i] = bytes[i];
      return room;
    }

    fill(value, start, end, encoding) {
      const from = start === undefined ? 0 : Number(start);
      const to = end === undefined ? this.length : Number(end);
      if (typeof value === "string") {
        const bytes = encodeString(value, encoding);
        if (bytes.length === 0) return this;
        for (let i = from; i < to; i++) this[i] = bytes[(i - from) % bytes.length];
        return this;
      }
      return Uint8Array.prototype.fill.call(this, value, from, to);
    }

    toString(encoding, start, end) {
      const from = start === undefined ? 0 : Number(start);
      const to = end === undefined ? this.length : Number(end);
      return decodeString(this, from, to, encoding);
    }

    slice(start, end) {
      const from = start === undefined ? 0 : Number(start);
      const to = end === undefined ? this.length : Number(end);
      const view = Uint8Array.prototype.subarray.call(
        this,
        from < 0 ? Math.max(this.length + from, 0) : from,
        to < 0 ? Math.max(this.length + to, 0) : to,
      );
      Object.setPrototypeOf(view, Buffer.prototype);
      return view;
    }

    subarray(start, end) {
      const view = Uint8Array.prototype.subarray.call(this, start, end);
      Object.setPrototypeOf(view, Buffer.prototype);
      return view;
    }

    copy(target, targetStart, sourceStart, sourceEnd) {
      const to = targetStart === undefined ? 0 : Number(targetStart);
      const from = sourceStart === undefined ? 0 : Number(sourceStart);
      const end = sourceEnd === undefined ? this.length : Number(sourceEnd);
      const count = Math.max(0, Math.min(end, this.length) - from);
      for (let i = 0; i < count; i++) target[to + i] = this[from + i];
      return count;
    }

    equals(other) {
      if (!ArrayBuffer.isView(other) || other.byteLength !== this.length) return false;
      for (let i = 0; i < this.length; i++) if (this[i] !== other[i]) return false;
      return true;
    }

    compare(other) {
      const length = Math.min(this.length, other.length);
      for (let i = 0; i < length; i++) {
        if (this[i] !== other[i]) return this[i] < other[i] ? -1 : 1;
      }
      if (this.length === other.length) return 0;
      return this.length < other.length ? -1 : 1;
    }

    indexOf(value, byteOffset, encoding) {
      const start = byteOffset === undefined ? 0 : Math.max(0, Number(byteOffset));
      let needle;
      if (typeof value === "number") {
        needle = [value & 0xff];
      } else if (typeof value === "string") {
        needle = encodeString(value, encoding);
      } else if (ArrayBuffer.isView(value)) {
        needle = [];
        for (let i = 0; i < value.byteLength; i++) needle.push(value[i]);
      } else {
        throw new TypeError("value must be a string, number or Buffer");
      }
      if (needle.length === 0) return start <= this.length ? start : this.length;
      for (let i = start; i + needle.length <= this.length; i++) {
        let found = true;
        for (let k = 0; k < needle.length; k++) {
          if (this[i + k] !== needle[k]) {
            found = false;
            break;
          }
        }
        if (found) return i;
      }
      return -1;
    }

    includes(value, byteOffset, encoding) {
      return this.indexOf(value, byteOffset, encoding) !== -1;
    }
  }

  // ── TextEncoder / TextDecoder ───────────────────────────────────────────

  class TextEncoder {
    get encoding() {
      return "utf-8";
    }

    encode(text) {
      const bytes = utf8Encode(String(text === undefined ? "" : text));
      const view = new Uint8Array(bytes.length);
      for (let i = 0; i < bytes.length; i++) view[i] = bytes[i];
      return view;
    }
  }

  class TextDecoder {
    constructor(label) {
      this.encoding = String(label === undefined ? "utf-8" : label).toLowerCase();
    }

    decode(input) {
      if (input === undefined) return "";
      const view = ArrayBuffer.isView(input) ? input : new Uint8Array(input);
      return utf8Decode(new Uint8Array(view.buffer, view.byteOffset, view.byteLength), 0, view.byteLength);
    }
  }

  // ── console ─────────────────────────────────────────────────────────────

  function format(values) {
    return values
      .map(function (value) {
        if (typeof value === "string") return value;
        if (value instanceof Error) return value.stack || String(value);
        try {
          return JSON.stringify(value);
        } catch {
          return String(value);
        }
      })
      .join(" ");
  }

  const console = {
    log: function () {
      host.stderrWrite(format(Array.prototype.slice.call(arguments)) + "\n");
    },
    info: function () {
      host.stderrWrite(format(Array.prototype.slice.call(arguments)) + "\n");
    },
    debug: function () {
      host.stderrWrite(format(Array.prototype.slice.call(arguments)) + "\n");
    },
    warn: function () {
      host.stderrWrite(format(Array.prototype.slice.call(arguments)) + "\n");
    },
    error: function () {
      host.stderrWrite(format(Array.prototype.slice.call(arguments)) + "\n");
    },
  };

  // ── process ─────────────────────────────────────────────────────────────

  function parseJson(text, fallback) {
    if (typeof text !== "string" || text === "") return fallback;
    try {
      const value = JSON.parse(text);
      return value === null || value === undefined ? fallback : value;
    } catch {
      return fallback;
    }
  }

  const process = {
    argv: parseJson(globalThis.__decxArgvJson, []),
    env: parseJson(globalThis.__decxEnvJson, {}),
    platform: globalThis.__decxPlatform || "linux",
    arch: globalThis.__decxArch || "amd64",
    pid: 0,
    version: "",
    versions: {},
    cwd: function () {
      return globalThis.__decxCwd || ".";
    },
    chdir: function () {
      throw new Error("process.chdir() is not supported by the DECX plugin runtime");
    },
    exit: function (code) {
      const error = new Error("process.exit(" + String(code === undefined ? 0 : code) + ")");
      error.code = "PLUGIN_EXIT";
      error.exitCode = code === undefined ? 0 : Number(code);
      throw error;
    },
    stdout: {
      write: function (text) {
        host.stdoutWrite(String(text));
        return true;
      },
    },
    stderr: {
      write: function (text) {
        host.stderrWrite(String(text));
        return true;
      },
    },
  };

  globalThis.Buffer = Buffer;
  globalThis.console = console;
  globalThis.process = process;
  globalThis.TextEncoder = TextEncoder;
  globalThis.TextDecoder = TextDecoder;
  globalThis.global = globalThis;
})();
