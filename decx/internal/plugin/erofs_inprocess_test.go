package plugin

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
)

// The embedded runtime must run the shipped framework plugin's binary readers
// byte-exactly. The EROFS fixture is decoded in-process and compared with the
// reference hashes produced by fsck.erofs (the same expectations the node test
// encodes), which catches Buffer shim regressions in the Go runtime. The reader
// is taken from the compiled TypeScript output (dist/src), so the test is
// skipped until the plugin has been built.
func TestEmbeddedRuntimeDecodesErofsFixture(t *testing.T) {
	pluginRoot := filepath.Join("..", "..", "..", "plugins", "ard-framework")
	reader := filepath.Join(pluginRoot, "dist", "src", "erofs-reader.js")
	fixture := filepath.Join(pluginRoot, "tests", "fixtures", "apex_payload_erofs.img")
	readerSource, err := os.ReadFile(reader)
	if err != nil {
		t.Skipf("framework plugin build unavailable (run 'npm run build' in plugins/ard-framework): %v", err)
	}
	quoted := func(value string) string {
		data, err := json.Marshal(value)
		if err != nil {
			t.Fatal(err)
		}
		return string(data)
	}
	outDir := t.TempDir()
	// The compiled reader is CommonJS; the test wraps it with a minimal module
	// shim so the byte-exact EROFS decode still runs against the embedded
	// QuickJS runtime without the removed require() loader.
	script := `(function () {
  var module = { exports: {} };
  var exports = module.exports;
  var require = function (id) { return globalThis.decx[String(id).replace(/^node:/, "")]; };
` + string(readerSource) + `
  globalThis.__decxErofs = module.exports;
})();
const { fs } = globalThis.decx;
globalThis.handle = function () {
    const { ErofsImage } = globalThis.__decxErofs;
    const image = ErofsImage.open(` + quoted(fixture) + `);
    image.extractTo(` + quoted(outDir) + `, (relative) => relative.endsWith(".jar") || relative.endsWith(".bin") || relative.endsWith(".txt"));
    image.close();
    return { ok: true, data: { files: fs.readdirSync(` + quoted(outDir) + `) } };
};`
	probe := writePlugin(t, map[string]string{"src/index.js": script})
	var stderr bytes.Buffer
	response, err := Run(context.Background(), testDefinition(probe), Request{Protocol: Protocol}, &stderr)
	if err != nil {
		t.Fatalf("%v (stderr: %s)", err, stderr.String())
	}
	if !response.OK {
		t.Fatalf("response %s (stderr: %s)", response.Data, stderr.String())
	}
	for _, expected := range []struct{ path, digest string }{
		{"javalib/module.jar", "f9c17e3650515da79c0ff0b6952b04d51f12af68e2363d30d7c66628a0be604b"},
		{"javalib/random.bin", "51662ebf5aa6a85f942b0bd13660119ecbc348f3ab44fe699068b2df5bcb1492"},
		{"priv-app/shim/dup1.bin", "c81ca5eda5947c7826ad046fdbdc2a25a846b835a6c34c237cc8b3afbe9ec6cc"},
		{"priv-app/shim/dup2.bin", "c81ca5eda5947c7826ad046fdbdc2a25a846b835a6c34c237cc8b3afbe9ec6cc"},
		{"priv-app/shim/tiny.txt", "8950abfda7b727630760dd35bcf5c3daa7631aff223a90f7728c0d2521dde10c"},
	} {
		data, err := os.ReadFile(filepath.Join(outDir, filepath.FromSlash(expected.path)))
		if err != nil {
			t.Fatalf("%s: %v", expected.path, err)
		}
		digest := sha256.Sum256(data)
		if got := hex.EncodeToString(digest[:]); got != expected.digest {
			t.Fatalf("%s: sha256 %s (%d bytes) want %s", expected.path, got, len(data), expected.digest)
		}
	}
}
