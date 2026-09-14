package plugin

import (
	"bytes"
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
)

func TestSpawnSyncWritesIntoOpenedFileDescriptor(t *testing.T) {
	dir := t.TempDir()
	target := filepath.Join(dir, "child.out")
	quoted, err := json.Marshal(target)
	if err != nil {
		t.Fatal(err)
	}
	script := `const { fs, child_process } = globalThis.decx;
globalThis.handle = function () {
    const target = ` + string(quoted) + `;
    const fd = fs.openSync(target, "w");
    const result = child_process.spawnSync("sh", ["-c", "printf abcdefghij"], { stdio: ["ignore", fd, "pipe"] });
    fs.closeSync(fd);
    if (result.error) return { ok: false, error: { code: "SPAWN_FAILED", message: String(result.error && result.error.message || result.error) } };
    return { ok: true, data: { status: result.status, bytes: fs.readFileSync(target).toString("hex"), size: fs.statSync(target).size } };
};`
	probe := writePlugin(t, map[string]string{"src/index.js": script})
	var stderr bytes.Buffer
	response, err := Run(context.Background(), testDefinition(probe), Request{Protocol: Protocol}, &stderr)
	if err != nil {
		t.Fatalf("%v (stderr: %s)", err, stderr.String())
	}
	var data struct {
		Status int    `json:"status"`
		Bytes  string `json:"bytes"`
		Size   int64  `json:"size"`
	}
	if err := json.Unmarshal(response.Data, &data); err != nil {
		t.Fatal(err)
	}
	if data.Status != 0 || data.Bytes != "6162636465666768696a" || data.Size != 10 {
		t.Fatalf("child output %+v (file %s)", data, mustRead(t, target))
	}
}

func mustRead(t *testing.T, path string) string {
	t.Helper()
	data, err := os.ReadFile(path)
	if err != nil {
		return err.Error()
	}
	return string(data)
}
