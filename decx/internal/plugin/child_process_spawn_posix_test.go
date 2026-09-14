//go:build !windows

package plugin

import (
	"bytes"
	"context"
	"encoding/json"
	"testing"
)

func TestSpawnSyncReportsExitStatus(t *testing.T) {
	var data struct {
		Status *int    `json:"status"`
		Signal *string `json:"signal"`
	}
	runSpawnScript(t, `const { child_process } = globalThis.decx;
globalThis.handle = function () {
    const result = child_process.spawnSync("sh", ["-c", "exit 7"]);
    return { ok: true, data: { status: result.status, signal: result.signal } };
};`, &data)
	if data.Status == nil || *data.Status != 7 {
		t.Fatalf("status = %v, want 7", data.Status)
	}
	if data.Signal != nil {
		t.Fatalf("signal = %q, want null", *data.Signal)
	}
}

func TestSpawnSyncReportsConventionalSignal(t *testing.T) {
	var data struct {
		Status *int    `json:"status"`
		Signal *string `json:"signal"`
	}
	runSpawnScript(t, `const { child_process } = globalThis.decx;
globalThis.handle = function () {
    const result = child_process.spawnSync("sh", ["-c", "kill -KILL $$"]);
    return { ok: true, data: { status: result.status, signal: result.signal } };
};`, &data)
	if data.Status != nil {
		t.Fatalf("status = %v, want null for a signal death", *data.Status)
	}
	if data.Signal == nil || *data.Signal != "SIGKILL" {
		t.Fatalf("signal = %v, want SIGKILL", data.Signal)
	}
}

func TestSpawnSyncTimeoutReportsETIMEDOUT(t *testing.T) {
	var data struct {
		Code   string  `json:"code"`
		Signal *string `json:"signal"`
	}
	runSpawnScript(t, `const { child_process } = globalThis.decx;
globalThis.handle = function () {
    const result = child_process.spawnSync("sh", ["-c", "sleep 5"], { timeout: 50 });
    return { ok: true, data: { code: result.error ? String(result.error.code || "") : "", signal: result.signal } };
};`, &data)
	if data.Code != "ETIMEDOUT" {
		t.Fatalf("error code = %q, want ETIMEDOUT", data.Code)
	}
	if data.Signal == nil || *data.Signal != "SIGTERM" {
		t.Fatalf("signal = %v, want SIGTERM", data.Signal)
	}
}

func TestSpawnSyncCapsOutputAtMaxBuffer(t *testing.T) {
	var data struct {
		Status int    `json:"status"`
		Stdout string `json:"stdout"`
	}
	runSpawnScript(t, `const { child_process } = globalThis.decx;
globalThis.handle = function () {
    const result = child_process.spawnSync("sh", ["-c", "printf abcdefghij"], { maxBuffer: 4, encoding: "utf8" });
    return { ok: true, data: { status: result.status, stdout: String(result.stdout) } };
};`, &data)
	if data.Status != 0 {
		t.Fatalf("status = %d, want 0", data.Status)
	}
	if data.Stdout != "abcd" {
		t.Fatalf("stdout = %q, want the first four bytes", data.Stdout)
	}
}

// runSpawnScript evaluates a one-off plugin whose handle() returns {ok,data}
// and decodes the data field into out.
func runSpawnScript(t *testing.T, script string, out any) {
	t.Helper()
	probe := writePlugin(t, map[string]string{"src/index.js": script})
	var stderr bytes.Buffer
	response, err := Run(context.Background(), testDefinition(probe), Request{Protocol: Protocol}, &stderr)
	if err != nil {
		t.Fatalf("%v (stderr: %s)", err, stderr.String())
	}
	if err := json.Unmarshal(response.Data, out); err != nil {
		t.Fatalf("decode response %s: %v", response.Data, err)
	}
}
