package session

import (
	"context"
	"encoding/json"
	"fmt"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/jygzyc/decx/decx/internal/registry"
)

// TestServerProcess runs in a separate copy of the test executable. It exercises
// real process creation, TCP readiness, persistence and verified termination.
func TestServerProcess(t *testing.T) {
	index := -1
	for i, arg := range os.Args {
		if arg == "--session-test-server" {
			index = i
			break
		}
	}
	if index < 0 {
		return
	}
	port, mode := os.Args[index+1], os.Args[index+2]
	if mode == "exit" {
		os.Exit(23)
	}
	mux := http.NewServeMux()
	mux.HandleFunc("/health", func(w http.ResponseWriter, r *http.Request) {
		if mode == "unhealthy" {
			w.WriteHeader(503)
			return
		}
		fmt.Fprintln(w, `{"status":"running"}`)
	})
	mux.HandleFunc("/api/decx/get_classes", func(w http.ResponseWriter, r *http.Request) { fmt.Fprintln(w, `{"ok":true,"items":["TestClass"]}`) })
	listener, err := net.Listen("tcp", "127.0.0.1:"+port)
	if err != nil {
		os.Exit(24)
	}
	_ = http.Serve(listener, mux)
	os.Exit(0)
}

func setupManager(t *testing.T, mode string) (*Manager, OpenOptions) {
	t.Helper()
	home := t.TempDir()
	target := filepath.Join(home, "test target.bin")
	if err := os.WriteFile(target, []byte("test binary"), 0600); err != nil {
		t.Fatal(err)
	}
	exe, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	e := registry.Engine{ID: "test", Binary: registry.Binary{Kind: "program", Path: exe}, Launch: registry.Launch{Command: []string{"{binary}", "-test.run=^TestServerProcess$", "--", "--session-test-server", "{port}", mode}, Scripts: "positional", TrailingArgs: true}}
	m := &Manager{Home: home}
	t.Cleanup(func() {
		if err := m.Close(context.Background(), "", 0, true); err != nil {
			t.Error(err)
		}
	})
	return m, OpenOptions{Engine: e, Target: target, Timeout: 5 * time.Second}
}

func TestLifecycleReuseSelectionAndForce(t *testing.T) {
	m, o := setupManager(t, "healthy")
	ctx := context.Background()
	s, err := m.Open(ctx, o)
	if err != nil {
		t.Fatal(err)
	}
	if s.State != "healthy" || s.Port < 30000 || s.Port > 40000 {
		t.Fatalf("unexpected session: %+v", s)
	}
	// A new manager instance proves the record is independent of CLI memory.
	other := &Manager{Home: m.Home}
	reused, err := other.Open(ctx, o)
	if err != nil || reused.PID != s.PID {
		t.Fatalf("not reused: %+v %v", reused, err)
	}
	selected, err := other.Select(ctx, "", []string{"test"})
	if err != nil || selected.PID != s.PID {
		t.Fatalf("selection %v %v", selected, err)
	}
	if _, err := other.Select(ctx, "", []string{"wrong"}); err == nil {
		t.Fatal("selected incompatible engine")
	}
	o.Args = []string{"changed"}
	if _, err := m.Open(ctx, o); err == nil {
		t.Fatal("reused incompatible launch arguments")
	}
	o.Force = true
	replaced, err := m.Open(ctx, o)
	if err != nil {
		t.Fatal(err)
	}
	if replaced.PID == s.PID {
		t.Fatal("force did not replace process")
	}
	if alive, err := owned(s); err != nil || alive {
		t.Fatalf("old process survived: %v %v", alive, err)
	}
	if err := m.Close(ctx, "", replaced.Port, false); err != nil {
		t.Fatal(err)
	}
	if alive, err := owned(replaced); err != nil || alive {
		t.Fatalf("closed process survived: %v %v", alive, err)
	}
	list, err := m.List(ctx)
	if err != nil || len(list) != 0 {
		t.Fatalf("records after close: %v %v", list, err)
	}
}

func TestTimeoutRetainsLiveSession(t *testing.T) {
	m, o := setupManager(t, "unhealthy")
	o.Timeout = 350 * time.Millisecond
	s, err := m.Open(context.Background(), o)
	if err == nil || !strings.Contains(err.Error(), "still recorded") {
		t.Fatalf("expected timeout, got %v", err)
	}
	if alive, err := owned(s); err != nil || !alive {
		t.Fatalf("timeout killed process: %v %v", alive, err)
	}
	list, err := m.List(context.Background())
	if err != nil || len(list) != 1 || list[0].PID != s.PID {
		t.Fatalf("lost timed out session: %v %v", list, err)
	}
}

func TestConcurrentOpenDoesNotDuplicate(t *testing.T) {
	m, o := setupManager(t, "healthy")
	var wg sync.WaitGroup
	results := make(chan Record, 2)
	for i := 0; i < 2; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			s, err := m.Open(context.Background(), o)
			if err != nil {
				t.Error(err)
				return
			}
			results <- s
		}()
	}
	wg.Wait()
	close(results)
	var pid int32
	for s := range results {
		if pid != 0 && s.PID != pid {
			t.Fatal("duplicate servers")
		}
		pid = s.PID
	}
	list, err := m.List(context.Background())
	if err != nil || len(list) != 1 {
		t.Fatalf("lost/duplicate records: %v %v", list, err)
	}
}

func TestProcessIdentityProtectsRecycledPID(t *testing.T) {
	m, o := setupManager(t, "healthy")
	s, err := m.Open(context.Background(), o)
	if err != nil {
		t.Fatal(err)
	}
	defer m.stopProcess(context.Background(), s)
	if err := m.locked(context.Background(), func(db *database) error { db.Sessions[0].ProcessCreated++; return m.save(db) }); err != nil {
		t.Fatal(err)
	}
	if err := m.Close(context.Background(), s.Name, 0, false); err != nil {
		t.Fatal(err)
	}
	if alive, err := owned(s); err != nil || !alive {
		t.Fatalf("killed mismatched process: %v %v", alive, err)
	}
}

func TestMalformedStoreFailsClosed(t *testing.T) {
	m, _ := setupManager(t, "healthy")
	path := filepath.Join(m.Home, "sessions-v1.json")
	if err := os.WriteFile(path, []byte(`{"version":1,"sessions":[{"name":"invalid","pid":1}]}`), 0600); err != nil {
		t.Fatal(err)
	}
	if _, err := m.List(context.Background()); err == nil {
		t.Fatal("accepted unsafe record")
	}
	if err := os.Remove(path); err != nil {
		t.Fatal(err)
	}
}

func TestScriptContentChangesRequireReplacement(t *testing.T) {
	m, o := setupManager(t, "healthy")
	script := filepath.Join(m.Home, "test.jadx.kts")
	if err := os.WriteFile(script, []byte("original"), 0600); err != nil {
		t.Fatal(err)
	}
	o.Scripts = []string{script}
	if _, err := m.Open(context.Background(), o); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(script, []byte("changed"), 0600); err != nil {
		t.Fatal(err)
	}
	if _, err := m.Open(context.Background(), o); err == nil {
		t.Fatal("changed script silently reused")
	}
}

// TestManifestMetadataDoesNotChangeIdentity pins down that rewriting a
// manifest's descriptive fields (as install and self update do) keeps an
// otherwise identical session reusable.
func TestManifestMetadataDoesNotChangeIdentity(t *testing.T) {
	m, o := setupManager(t, "healthy")
	s, err := m.Open(context.Background(), o)
	if err != nil {
		t.Fatal(err)
	}
	o.Engine.Description = "rewritten description"
	o.Engine.Version = "9.9.9"
	o.Engine.Commands = nil
	o.Engine.Release = &registry.Install{Source: "repo", Repository: "owner/other", Asset: "test-{version}.zip", Checksums: "SHA256SUMS"}
	reused, err := m.Open(context.Background(), o)
	if err != nil || reused.PID != s.PID {
		t.Fatalf("metadata rewrite forced replacement: %+v %v", reused, err)
	}
}

func TestStoreContainsProcessIdentity(t *testing.T) {
	m, o := setupManager(t, "healthy")
	s, err := m.Open(context.Background(), o)
	if err != nil {
		t.Fatal(err)
	}
	data, err := os.ReadFile(filepath.Join(m.Home, "sessions-v1.json"))
	if err != nil {
		t.Fatal(err)
	}
	var db database
	if err := json.Unmarshal(data, &db); err != nil {
		t.Fatal(err)
	}
	if db.Sessions[0].ProcessCreated != s.ProcessCreated || s.ProcessCreated == 0 {
		t.Fatal("missing process creation identity")
	}
}

func TestStopCommandRunsBeforeTermination(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("the stop fixture uses /bin/sh")
	}
	m, o := setupManager(t, "healthy")
	o.Engine.Launch.Stop = registry.Stop{Command: []string{"/bin/sh", "-c", "kill {pid}"}}
	m.Engines = []registry.Engine{o.Engine}
	s, err := m.Open(context.Background(), o)
	if err != nil {
		t.Fatal(err)
	}
	if err := m.Close(context.Background(), s.Name, 0, false); err != nil {
		t.Fatal(err)
	}
	if alive, err := owned(s); err != nil || alive {
		t.Fatalf("stop command did not stop the server: %v %v", alive, err)
	}
	list, err := m.List(context.Background())
	if err != nil || len(list) != 0 {
		t.Fatalf("record retained: %v %v", list, err)
	}
}

func TestFailedStopCommandStillTerminates(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("the stop fixture uses /bin/sh")
	}
	m, o := setupManager(t, "healthy")
	o.Engine.Launch.Stop = registry.Stop{Command: []string{"/bin/sh", "-c", "exit 7"}}
	m.Engines = []registry.Engine{o.Engine}
	s, err := m.Open(context.Background(), o)
	if err != nil {
		t.Fatal(err)
	}
	if err := m.Close(context.Background(), s.Name, 0, false); err != nil {
		t.Fatal(err)
	}
	if alive, err := owned(s); err != nil || alive {
		t.Fatalf("server survived a failed stop command: %v %v", alive, err)
	}
}
