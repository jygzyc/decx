package plugin

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/jygzyc/decx/decx/internal/registry"
)

func writePlugin(t *testing.T, files map[string]string) string {
	t.Helper()
	dir := t.TempDir()
	for name, content := range files {
		target := filepath.Join(dir, filepath.FromSlash(name))
		if err := os.MkdirAll(filepath.Dir(target), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(target, []byte(content), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	return dir
}

func testDefinition(dir string) Definition {
	return Definition{ID: "framework", Entry: "src/index.js", Dir: dir}
}

func TestRunInvokesJavaScriptEntry(t *testing.T) {
	dir := writePlugin(t, map[string]string{
		"src/index.js": `globalThis.handle = function (request) {
  return {
    ok: true,
    data: {
      protocol: request.protocol,
      command: request.command.join(" "),
      args: request.args,
      positionals: request.positionals,
      context: request.context,
    },
  };
};`,
	})
	request, err := NewRequest([]string{"framework", "collect"}, []registry.Arg{
		{ID: "input", Long: "input", Kind: "value"},
		{ID: "module", Kind: "positional"},
	}, map[string][]string{"input": {"/tmp/collect"}, "module": {"system", "apex"}}, "/tmp/home", dir)
	if err != nil {
		t.Fatal(err)
	}
	var stderr bytes.Buffer
	response, err := Run(context.Background(), testDefinition(dir), request, &stderr)
	if err != nil {
		t.Fatalf("%v (stderr: %s)", err, stderr.String())
	}
	if !response.OK {
		t.Fatalf("response %+v", response)
	}
	var received struct {
		Protocol    int            `json:"protocol"`
		Command     string         `json:"command"`
		Args        map[string]any `json:"args"`
		Positionals []string       `json:"positionals"`
		Context     Context        `json:"context"`
	}
	if err := json.Unmarshal(response.Data, &received); err != nil {
		t.Fatal(err)
	}
	if received.Protocol != Protocol || received.Command != "framework collect" {
		t.Fatalf("request %+v", received)
	}
	if received.Args["input"] != "/tmp/collect" {
		t.Fatalf("args %+v", received.Args)
	}
	if len(received.Positionals) != 2 || received.Positionals[0] != "system" {
		t.Fatalf("positionals %+v", received.Positionals)
	}
	if received.Context.PluginDir != dir || received.Context.Home != "/tmp/home" {
		t.Fatalf("context %+v", received.Context)
	}
}

func TestRunSurfacesPluginFailures(t *testing.T) {
	dir := writePlugin(t, map[string]string{
		"src/index.js": `globalThis.handle = () => ({ ok: false, error: { code: "ADB_DEVICE_AMBIGUOUS", message: "several devices" } });`,
	})
	response, err := Run(context.Background(), testDefinition(dir), Request{Protocol: Protocol}, &bytes.Buffer{})
	if err != nil {
		t.Fatal(err)
	}
	if err := response.Err(); err == nil || !strings.Contains(err.Error(), "ADB_DEVICE_AMBIGUOUS") {
		t.Fatalf("error %v", err)
	}
}

func TestRunPreservesThrownErrorCodes(t *testing.T) {
	dir := writePlugin(t, map[string]string{
		"src/index.js": `globalThis.handle = function () {
  const error = new Error("several devices are connected");
  error.code = "ADB_DEVICE_AMBIGUOUS";
  throw error;
};`,
	})
	_, err := Run(context.Background(), testDefinition(dir), Request{Protocol: Protocol}, &bytes.Buffer{})
	var failure *ResponseError
	if err == nil {
		t.Fatal("exception accepted")
	}
	if !errors.As(err, &failure) {
		t.Fatalf("error %T %v", err, err)
	}
	if failure.Code != "ADB_DEVICE_AMBIGUOUS" || !strings.Contains(failure.Message, "several devices") {
		t.Fatalf("error %+v", failure)
	}
}

func TestRunRequiresHandleFunction(t *testing.T) {
	dir := writePlugin(t, map[string]string{"src/index.js": `globalThis.noop = {};`})
	if _, err := Run(context.Background(), testDefinition(dir), Request{Protocol: Protocol}, &bytes.Buffer{}); err == nil ||
		!strings.Contains(err.Error(), "handle") {
		t.Fatalf("missing handle accepted: %v", err)
	}
}

func TestHostModulesCoverThePluginSurface(t *testing.T) {
	dir := writePlugin(t, map[string]string{
		"src/index.js": `const { fs, path, crypto, child_process } = globalThis.decx;

globalThis.handle = function (request) {
    const source = path.join(request.context.pluginDir, "data", "sample.bin");
    fs.mkdirSync(path.dirname(source), { recursive: true });
    const buffer = Buffer.alloc(8);
    buffer.writeUInt32LE(0x11223344, 0);
    buffer.writeUInt16LE(0xbeef, 4);
    fs.writeFileSync(source, buffer);
    const read = fs.readFileSync(source);
    const stat = fs.statSync(source);
    console.log("host modules online");
    const command = process.platform === "win32" ? ["cmd", ["/c", "echo hi"]] : ["sh", ["-c", "echo hi"]];
    const child = child_process.spawnSync(command[0], command[1], { encoding: "utf-8" });
    return {
      ok: true,
      data: {
        hex: read.toString("hex"),
        roundTrip: read.readUInt16LE(4),
        size: stat.size,
        isFile: stat.isFile(),
        hash: crypto.createHash("sha256").update(read).digest("hex").slice(0, 8),
        child: (child.stdout || "").trim(),
        env: typeof process.env.PATH === "string",
        cwd: process.cwd(),
      },
    };
};`,
	})
	var stderr bytes.Buffer
	response, err := Run(context.Background(), testDefinition(dir), Request{Protocol: Protocol}, &stderr)
	if err != nil {
		t.Fatalf("%v (stderr: %s)", err, stderr.String())
	}
	var data map[string]any
	if err := json.Unmarshal(response.Data, &data); err != nil {
		t.Fatal(err)
	}
	if data["hex"] != "44332211efbe0000" {
		t.Fatalf("hex %v", data["hex"])
	}
	if data["roundTrip"] != float64(0xbeef) || data["size"] != float64(8) || data["isFile"] != true {
		t.Fatalf("stat %v", data)
	}
	digest := sha256.Sum256([]byte{0x44, 0x33, 0x22, 0x11, 0xef, 0xbe, 0x00, 0x00})
	expected := hex.EncodeToString(digest[:])[:8]
	if data["hash"] != expected {
		t.Fatalf("hash %v want %s", data["hash"], expected)
	}
	if data["child"] != "hi" {
		t.Fatalf("child %v (stderr: %s)", data["child"], stderr.String())
	}
	if data["env"] != true {
		t.Fatalf("env %v", data["env"])
	}
	if !strings.Contains(stderr.String(), "host modules online") {
		t.Fatalf("stderr %q", stderr.String())
	}
}

func TestRunFillsContextFromDefinition(t *testing.T) {
	dir := writePlugin(t, map[string]string{
		"index.js": `globalThis.handle = (request) => ({ ok: true, data: request.context });`,
	})
	response, err := Run(context.Background(), Definition{ID: "framework", Entry: "index.js", Dir: dir}, Request{Protocol: Protocol}, &bytes.Buffer{})
	if err != nil {
		t.Fatal(err)
	}
	var context Context
	if err := json.Unmarshal(response.Data, &context); err != nil {
		t.Fatal(err)
	}
	if context.PluginDir != dir {
		t.Fatalf("plugin dir %s", context.PluginDir)
	}
}

func TestDecodeResponseRejectsGarbage(t *testing.T) {
	for name, input := range map[string]string{
		"empty":         "",
		"not json":      "collecting...",
		"trailing data": `{"ok":true} {}`,
		"empty failure": `{"ok":false}`,
	} {
		if _, err := DecodeResponse([]byte(input)); err == nil {
			t.Fatalf("%s accepted", name)
		}
	}
	ok, err := DecodeResponse([]byte(`{"ok":true,"data":{"path":"/tmp/a.jar"}}`))
	if err != nil {
		t.Fatal(err)
	}
	if string(ok.Data) != `{"path":"/tmp/a.jar"}` {
		t.Fatalf("data %s", ok.Data)
	}
}

// TestRunRejectsOversizedBundle keeps a huge entry file from being read into
// memory.
func TestRunRejectsOversizedBundle(t *testing.T) {
	dir := writePlugin(t, map[string]string{"src/index.js": "globalThis.handle = () => ({ ok: true });"})
	if err := os.Truncate(filepath.Join(dir, "src", "index.js"), maxPluginBundleBytes+1); err != nil {
		t.Fatal(err)
	}
	_, err := Run(context.Background(), testDefinition(dir), Request{Protocol: Protocol}, &bytes.Buffer{})
	var failure *ResponseError
	if err == nil || !errors.As(err, &failure) || failure.Code != "PLUGIN_ERROR" {
		t.Fatalf("oversized bundle accepted: %v", err)
	}
	if !strings.Contains(failure.Message, "limit") {
		t.Fatalf("message = %q", failure.Message)
	}
}
