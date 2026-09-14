package registry

import (
	"os"
	"path/filepath"
	"testing"
)

// TestResolveBinaryManagedFallbackAndEnvOverride pins down the shared resolver
// contract: an environment override wins over every local copy, an installed
// component is found even when the engine manifest came from a checkout, and
// the checkout binary remains the fallback when nothing is installed.
func TestResolveBinaryManagedFallbackAndEnvOverride(t *testing.T) {
	home := t.TempDir()
	checkout := t.TempDir()
	engine := Engine{ID: "jadx", Binary: Binary{Kind: "java-jar", Path: "jadx-server.jar"}, Root: checkout}
	if _, err := ResolveBinary(home, engine); err == nil {
		t.Fatal("resolved a binary that exists nowhere")
	}

	checkoutBinary := filepath.Join(checkout, "jadx-server.jar")
	if err := os.WriteFile(checkoutBinary, []byte("checkout"), 0o755); err != nil {
		t.Fatal(err)
	}
	managed := filepath.Join(home, "modules", "jadx", "jadx-server.jar")
	if err := os.MkdirAll(filepath.Dir(managed), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(managed, []byte("managed"), 0o755); err != nil {
		t.Fatal(err)
	}
	// The installed copy wins, matching install.Probe.
	if path, err := ResolveBinary(home, engine); err != nil || path != managed {
		t.Fatalf("path = %q err = %v, want %q", path, err, managed)
	}
	if err := os.Remove(managed); err != nil {
		t.Fatal(err)
	}
	if path, err := ResolveBinary(home, engine); err != nil || path != checkoutBinary {
		t.Fatalf("path = %q err = %v, want %q", path, err, checkoutBinary)
	}

	// The environment override wins over both, mirroring install.Probe.
	override := filepath.Join(t.TempDir(), "env.jar")
	if err := os.WriteFile(override, []byte("env"), 0o755); err != nil {
		t.Fatal(err)
	}
	engine.Binary.Env = "TEST_DECX_RESOLVE_BINARY"
	t.Setenv(engine.Binary.Env, override)
	if path, err := ResolveBinary(home, engine); err != nil || path != override {
		t.Fatalf("path = %q err = %v, want %q", path, err, override)
	}
}
