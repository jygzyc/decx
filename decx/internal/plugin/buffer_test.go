package plugin

import (
	"bytes"
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestFsReadSyncWritesIntoTypedArrays(t *testing.T) {
	dir := t.TempDir()
	target := filepath.Join(dir, "sample.bin")
	if err := os.WriteFile(target, []byte("0123456789"), 0o644); err != nil {
		t.Fatal(err)
	}
	quoted, err := json.Marshal(target)
	if err != nil {
		t.Fatal(err)
	}
	script := `const { fs } = globalThis.decx;
const target = ` + string(quoted) + `;
globalThis.handle = function () {
    const fd = fs.openSync(target, "r");
    const buffer = Buffer.alloc(10);
    const read = fs.readSync(fd, buffer, 0, 10, 0);
    const view = new Uint8Array(4);
    const viewRead = fs.readSync(fd, view, 0, 4, 6);
    fs.closeSync(fd);
    return { ok: true, data: { read, text: buffer.toString("utf-8"), viewRead, view: Array.from(view) } };
};`
	pluginDir := writePlugin(t, map[string]string{"src/index.js": script})
	var stderr bytes.Buffer
	response, err := Run(context.Background(), testDefinition(pluginDir), Request{Protocol: Protocol}, &stderr)
	if err != nil {
		t.Fatalf("%v (stderr: %s)", err, stderr.String())
	}
	var data struct {
		Read     int    `json:"read"`
		Text     string `json:"text"`
		ViewRead int    `json:"viewRead"`
		View     []int  `json:"view"`
	}
	if err := json.Unmarshal(response.Data, &data); err != nil {
		t.Fatal(err)
	}
	if data.Read != 10 || data.Text != "0123456789" {
		t.Fatalf("buffer read %+v", data)
	}
	if data.ViewRead != 4 || len(data.View) != 4 || data.View[0] != '6' || data.View[3] != '9' {
		t.Fatalf("view %+v", data)
	}
}

func TestCopyIntoBufferSharesTypedArrayMemory(t *testing.T) {
	rt, err := newRuntime(context.Background(), Definition{ID: "probe", Dir: t.TempDir()}, &bytes.Buffer{})
	if err != nil {
		t.Fatal(err)
	}
	defer rt.close()
	value := rt.evalValue(`(function () { globalThis.__probe = Buffer.alloc(4); globalThis.__probe[0] = 7; return globalThis.__probe; })()`, "probe.js")
	if value == nil || value.IsException() {
		t.Fatalf("probe buffer: %v", rt.engineError())
	}
	rt.copyIntoBuffer(value, 1, []byte{0xaa, 0xbb})
	hex := rt.evalValue(`globalThis.__probe.toString("hex")`, "probe.js")
	if hex == nil || hex.IsException() {
		t.Fatalf("probe hex: %v", rt.engineError())
	}
	if hex.ToString() != "07aabb00" {
		t.Fatalf("hex %s", hex.ToString())
	}
}

func TestFsWriteSyncHonoursOffsetLengthPosition(t *testing.T) {
	dir := t.TempDir()
	target := filepath.Join(dir, "sample.bin")
	quoted, err := json.Marshal(target)
	if err != nil {
		t.Fatal(err)
	}
	script := `const { fs } = globalThis.decx;
const target = ` + string(quoted) + `;
globalThis.handle = function () {
    const fd = fs.openSync(target, "w");
    const sliced = fs.writeSync(fd, Buffer.from("ABCDEF"), 1, 3, 2);
    const view = new Uint8Array([9, 8, 7, 6]);
    const clamped = fs.writeSync(fd, view, 1, 20, 0);
    const empty = fs.writeSync(fd, Buffer.from("zz"), 5, 5, 9);
    fs.closeSync(fd);
    return { ok: true, data: { sliced, clamped, empty } };
};`
	pluginDir := writePlugin(t, map[string]string{"src/index.js": script})
	var stderr bytes.Buffer
	response, err := Run(context.Background(), testDefinition(pluginDir), Request{Protocol: Protocol}, &stderr)
	if err != nil {
		t.Fatalf("%v (stderr: %s)", err, stderr.String())
	}
	var data struct {
		Sliced  int `json:"sliced"`
		Clamped int `json:"clamped"`
		Empty   int `json:"empty"`
	}
	if err := json.Unmarshal(response.Data, &data); err != nil {
		t.Fatal(err)
	}
	if data.Sliced != 3 || data.Clamped != 3 || data.Empty != 0 {
		t.Fatalf("write counts %+v", data)
	}
	// "BCD" lands at offset 2, then view bytes 8,7,6 overwrite offsets 0..2.
	body, err := os.ReadFile(target)
	if err != nil {
		t.Fatal(err)
	}
	if want := []byte{8, 7, 6, 'C', 'D'}; !bytes.Equal(body, want) {
		t.Fatalf("file = %v, want %v", body, want)
	}
}

func TestFsReadSyncClampsLengthAndRejectsNegative(t *testing.T) {
	dir := t.TempDir()
	target := filepath.Join(dir, "sample.bin")
	if err := os.WriteFile(target, []byte("0123456789"), 0o644); err != nil {
		t.Fatal(err)
	}
	quoted, err := json.Marshal(target)
	if err != nil {
		t.Fatal(err)
	}
	script := `const { fs } = globalThis.decx;
const target = ` + string(quoted) + `;
globalThis.handle = function () {
    const fd = fs.openSync(target, "r");
    const buffer = Buffer.alloc(4);
    const read = fs.readSync(fd, buffer, 0, 1 << 30, 0);
    let message = "";
    try { fs.readSync(fd, buffer, 0, -1, 0); } catch (error) { message = error.message; }
    fs.closeSync(fd);
    return { ok: true, data: { read, text: buffer.toString("utf-8"), message } };
};`
	pluginDir := writePlugin(t, map[string]string{"src/index.js": script})
	var stderr bytes.Buffer
	response, err := Run(context.Background(), testDefinition(pluginDir), Request{Protocol: Protocol}, &stderr)
	if err != nil {
		t.Fatalf("%v (stderr: %s)", err, stderr.String())
	}
	var data struct {
		Read    int    `json:"read"`
		Text    string `json:"text"`
		Message string `json:"message"`
	}
	if err := json.Unmarshal(response.Data, &data); err != nil {
		t.Fatal(err)
	}
	if data.Read != 4 || data.Text != "0123" {
		t.Fatalf("clamped read %+v", data)
	}
	if !strings.Contains(data.Message, "negative") {
		t.Fatalf("negative length message = %q", data.Message)
	}
}
