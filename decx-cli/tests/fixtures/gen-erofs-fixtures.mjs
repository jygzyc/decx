/**
 * Regenerate the EROFS test fixtures (requires mkfs.erofs / fsck.erofs from
 * erofs-utils 1.9.x on PATH):
 *
 *   node tests/fixtures/gen-erofs-fixtures.mjs
 *
 * - apex_payload_erofs.img   lz4 + fragments (compact indexes, PLAIN pcluster,
 *                            symlink, empty file, fragment tail)
 * - apex_payload_erofs_ztp.img  lz4 + ztailpacking inline tail
 * - apex_payload_erofs_deflate.img  deflate + compr_cfgs block
 *
 * Every jar/apk is a REAL zip (with a classes.dex entry) so the framework
 * processor's unzip path can work on them; files are padded to the exact
 * sizes asserted by tests/erofs-reader.test.ts.
 */
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import { mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { deflateRawSync } from "node:zlib";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import * as os from "node:os";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT = __dirname;

// ── minimal zip writer (stored + deflated entries) ─────────────────────────
function makeZip(entries, { store = false } = {}) {
  /** entries: [{ name, data }] — returns Buffer; with store=true every entry
   * is stored uncompressed so the total size is linear in the data lengths. */
  const chunks = [];
  const central = [];
  let offset = 0;
  for (const e of entries) {
    const name = Buffer.from(e.name, "utf8");
    const crc = crc32(e.data);
    const raw = store ? e.data : deflateRawSync(e.data, { level: 9 });
    const useDeflate = !store && raw.length < e.data.length;
    const data = useDeflate ? raw : e.data;
    const method = useDeflate ? 8 : 0;
    const lfh = Buffer.alloc(30);
    lfh.writeUInt32LE(0x04034b50, 0);
    lfh.writeUInt16LE(20, 4);
    lfh.writeUInt16LE(0, 6);
    lfh.writeUInt16LE(method, 8);
    lfh.writeUInt16LE(0, 10);
    lfh.writeUInt16LE(0x2100, 12);
    lfh.writeUInt32LE(crc, 14);
    lfh.writeUInt32LE(data.length, 18);
    lfh.writeUInt32LE(e.data.length, 22);
    lfh.writeUInt16LE(name.length, 26);
    lfh.writeUInt16LE(0, 28);
    chunks.push(lfh, name, data);
    const cdh = Buffer.alloc(46);
    cdh.writeUInt32LE(0x02014b50, 0);
    cdh.writeUInt16LE(20, 4);
    cdh.writeUInt16LE(20, 6);
    cdh.writeUInt16LE(0, 8);
    cdh.writeUInt16LE(method, 10);
    cdh.writeUInt16LE(0, 12);
    cdh.writeUInt16LE(0x2100, 14);
    cdh.writeUInt32LE(crc, 16);
    cdh.writeUInt32LE(data.length, 20);
    cdh.writeUInt32LE(e.data.length, 24);
    cdh.writeUInt16LE(name.length, 28);
    cdh.writeUInt16LE(0, 30);
    cdh.writeUInt16LE(0, 32);
    cdh.writeUInt16LE(0, 34);
    cdh.writeUInt16LE(0, 36);
    cdh.writeUInt32LE(0, 38);
    cdh.writeUInt32LE(offset, 42);
    central.push(cdh, name);
    offset += lfh.length + name.length + data.length;
  }
  const centralBuf = Buffer.concat(central);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(centralBuf.length, 12);
  eocd.writeUInt32LE(offset, 16);
  eocd.writeUInt16LE(0, 20);
  return Buffer.concat([...chunks, centralBuf, eocd]);
}

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(buf) {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function zipSizedTo(exactSize, { dexSeed, manifestText, manifestPad = 0 }) {
  // all entries stored => zip length is linear in data lengths:
  //   zipSize = 2*(30+46+2*nameLen) + 22 + manifestLen + dexLen
  const manifest = Buffer.from(manifestText + " ".repeat(manifestPad), "utf8");
  const overhead =
    2 * (30 + 46) + 22 +
    2 * Buffer.byteLength("META-INF/MANIFEST.MF") +
    2 * Buffer.byteLength("classes.dex") + manifest.length;
  const dexLen = exactSize - overhead;
  if (dexLen < 64) throw new Error(`no room for dex in ${exactSize} bytes`);
  const dex = pseudoRandom(dexLen, dexSeed);
  const zip = makeZip(
    [
      { name: "META-INF/MANIFEST.MF", data: manifest },
      { name: "classes.dex", data: dex },
    ],
    { store: true },
  );
  if (zip.length !== exactSize) throw new Error(`zip is ${zip.length}, want ${exactSize}`);
  return zip;
}

/** deterministic pseudo-random bytes (incompressible) */
function pseudoRandom(n, seed) {
  const out = Buffer.alloc(n);
  let x = seed | 0;
  for (let i = 0; i < n; i++) {
    x = (x * 1103515245 + 12345) & 0x7fffffff;
    out[i] = (x >> 16) & 0xff;
  }
  return out;
}

// ── fixture 1: lz4 + fragments ──────────────────────────────────────────────
function buildTree1() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "erofs-fx1-"));
  mkdirSync(path.join(dir, "app/CtsShim"), { recursive: true });
  mkdirSync(path.join(dir, "etc"), { recursive: true });
  mkdirSync(path.join(dir, "javalib"), { recursive: true });

  const manifest = Buffer.alloc(25);
  manifest.write("APEX manifest payload", 0, "utf8");
  writeFileSync(path.join(dir, "apex_manifest.pb"), manifest);

  // base.apk: small real zip (~700 B)
  const apk = makeZip([
    { name: "classes.dex", data: Buffer.from("dex-shim-base-0123456789abcdef", "utf8") },
  ]);
  writeFileSync(path.join(dir, "app/CtsShim/base.apk"), apk);

  // classes.txt: 278999 B, classes Klass0000..Klass2999, exact length via padding
  writeFileSync(path.join(dir, "etc/classes.txt"), sizedText());
  function sizedText() {
    const lines = [];
    for (let i = 0; i < 3000; i++) {
      lines.push(`public final class Klass${String(i).padStart(4, "0")} { static final int N${i} = ${i}; }`);
    }
    // exact length: pad with spaces, keep "*/ } }" as the final bytes
    const TAIL = "/* padding for exact size */ } }";
    const target = 278999 - Buffer.byteLength(TAIL, "utf8");
    let head = lines.join("\n");
    if (Buffer.byteLength(head, "utf8") > target) throw new Error("classes.txt too long: " + head.length);
    head = head + "\n" + " ".repeat(target - Buffer.byteLength(head, "utf8") - 2);
    const buf = Buffer.from(head + "\n" + TAIL, "utf8");
    if (buf.length !== 278999) throw new Error("classes.txt size mismatch: " + buf.length);
    return buf;
  }

  // core-oj.jar: exactly 40000 B, incompressible dex (PLAIN pcluster)
  const jar = zipSizedTo(40000, { dexSeed: 42, manifestText: "Manifest-Version: 1.0\nName: core-oj\n" });
  writeFileSync(path.join(dir, "javalib/core-oj.jar"), jar);
  writeFileSync(path.join(dir, "javalib/empty.bin"), Buffer.alloc(0));
  symlinkSync("core-oj.jar", path.join(dir, "javalib/link.jar"));
  return dir;
}

// ── fixture 2: ztailpacking ─────────────────────────────────────────────────
function buildTree2() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "erofs-fx2-"));
  mkdirSync(path.join(dir, "javalib"), { recursive: true });
  // service.jar: exactly 14379 B real zip whose manifest mentions com.example.ztp
  const jar = zipSizedTo(14379, {
    dexSeed: 7,
    manifestText: "Manifest-Version: 1.0\nBundle-SymbolicName: com.example.ztp\n",
  });
  writeFileSync(path.join(dir, "javalib/service.jar"), jar);
  return dir;
}

// ── fixture 3: deflate ──────────────────────────────────────────────────────
function buildTree3() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "erofs-fx3-"));
  mkdirSync(path.join(dir, "etc"), { recursive: true });
  mkdirSync(path.join(dir, "javalib"), { recursive: true });
  // table.csv: exactly 151774 B, first row starts with "0,z"
  const rows = ["0,z0,android,framework,table"];
  let i = 1;
  for (;;) {
    const row = `${i % 10},z${i},row,of,csv,data,${i}`;
    if (rows.join("\n").length + 1 + row.length > 151650) break;
    rows.push(row);
    i++;
  }
  let csv = rows.join("\n") + "\n";
  csv = csv + " ".repeat(151774 - Buffer.byteLength(csv, "utf8"));
  const buf = Buffer.from(csv, "utf8");
  if (buf.length !== 151774) throw new Error("table.csv size mismatch: " + buf.length);
  writeFileSync(path.join(dir, "etc/table.csv"), buf);
  const jar = zipSizedTo(9000, { dexSeed: 99, manifestText: "Manifest-Version: 1.0\nName: chart\n" });
  writeFileSync(path.join(dir, "javalib/chart.jar"), jar);
  return dir;
}

const plans = [
  { name: "apex_payload_erofs.img", build: buildTree1, args: ["-z", "lz4", "-E", "fragments"] },
  { name: "apex_payload_erofs_ztp.img", build: buildTree2, args: ["-z", "lz4", "-E", "ztailpacking"] },
  { name: "apex_payload_erofs_deflate.img", build: buildTree3, args: ["-z", "deflate"] },
];

for (const plan of plans) {
  const tree = plan.build();
  const img = path.join(OUT, plan.name);
  rmSync(img, { force: true });
  execFileSync("mkfs.erofs", [...plan.args, img, tree], { stdio: "inherit" });
  rmSync(tree, { recursive: true, force: true });
  console.log(`wrote ${plan.name}`);
}
