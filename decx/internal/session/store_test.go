package session

import (
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// fastRetries shrinks the retry window so the tests below stay quick; the
// production backoff is restored afterwards.
func fastRetries(t *testing.T) {
	t.Helper()
	old := storeRenameBackoff
	storeRenameBackoff = time.Millisecond
	t.Cleanup(func() { storeRenameBackoff = old })
}

func TestReplaceStoreRetriesTransientFailure(t *testing.T) {
	fastRetries(t)
	dir := t.TempDir()
	source := filepath.Join(dir, "new")
	target := filepath.Join(dir, "sessions-v1.json")
	if err := os.WriteFile(source, []byte("new"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(target, []byte("old"), 0o600); err != nil {
		t.Fatal(err)
	}
	attempts := 0
	rename := func(from, to string) error {
		attempts++
		if attempts < 3 {
			// Windows reports the held-open destination as a sharing violation;
			// any transient rename error is retried the same way.
			return errors.New("sharing violation")
		}
		return os.Rename(from, to)
	}
	if err := replaceStore(rename, source, target); err != nil {
		t.Fatalf("replaceStore = %v, want success after retries", err)
	}
	if attempts != 3 {
		t.Fatalf("rename attempts = %d, want 3", attempts)
	}
	data, err := os.ReadFile(target)
	if err != nil {
		t.Fatal(err)
	}
	if string(data) != "new" {
		t.Fatalf("target holds %q, want the replaced content", data)
	}
}

func TestReplaceStoreSurfacesPersistentFailure(t *testing.T) {
	fastRetries(t)
	attempts := 0
	rename := func(string, string) error {
		attempts++
		return errors.New("sharing violation")
	}
	err := replaceStore(rename, "source", "target")
	if err == nil {
		t.Fatal("persistent rename failure accepted")
	}
	if attempts != storeRenameAttempts {
		t.Fatalf("rename attempts = %d, want the bounded %d", attempts, storeRenameAttempts)
	}
	if !strings.Contains(err.Error(), "replace session store") || !strings.Contains(err.Error(), "sharing violation") {
		t.Fatalf("error = %v, want the replace context and the underlying cause", err)
	}
}
