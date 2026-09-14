package install

import (
	"archive/tar"
	"archive/zip"
	"bytes"
	"compress/gzip"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"

	"github.com/jygzyc/decx/decx/internal/registry"
)

// tarGzBytes builds a tar.gz with the given files. Entry names use slashes.
func tarGzBytes(t *testing.T, files map[string]string, mutate func(*tar.Writer) error) []byte {
	t.Helper()
	var buffer bytes.Buffer
	gz := gzip.NewWriter(&buffer)
	writer := tar.NewWriter(gz)
	if mutate != nil {
		if err := mutate(writer); err != nil {
			t.Fatal(err)
		}
	}
	names := make([]string, 0, len(files))
	for name := range files {
		names = append(names, name)
	}
	for _, name := range names {
		body := []byte(files[name])
		mode := int64(0o644)
		if strings.HasPrefix(name, "bin/") {
			mode = 0o755
		}
		header := &tar.Header{Name: name, Mode: mode, Size: int64(len(body)), Typeflag: tar.TypeReg}
		if err := writer.WriteHeader(header); err != nil {
			t.Fatal(err)
		}
		if _, err := writer.Write(body); err != nil {
			t.Fatal(err)
		}
	}
	if err := writer.Close(); err != nil {
		t.Fatal(err)
	}
	if err := gz.Close(); err != nil {
		t.Fatal(err)
	}
	return buffer.Bytes()
}

// zipBytes builds a zip with the given files. Entry names use slashes.
func zipBytes(t *testing.T, files map[string]string) []byte {
	t.Helper()
	var buffer bytes.Buffer
	writer := zip.NewWriter(&buffer)
	for name, body := range files {
		header := &zip.FileHeader{Name: name}
		if strings.HasPrefix(name, "bin/") {
			header.SetMode(0o755)
		} else {
			header.SetMode(0o644)
		}
		entry, err := writer.CreateHeader(header)
		if err != nil {
			t.Fatal(err)
		}
		if _, err := entry.Write([]byte(body)); err != nil {
			t.Fatal(err)
		}
	}
	if err := writer.Close(); err != nil {
		t.Fatal(err)
	}
	return buffer.Bytes()
}

func TestExtractArchiveFormats(t *testing.T) {
	files := map[string]string{"bin/kuna-server": "kuna binary\n", "specs/kuna.sla": "specs\n"}
	archives := map[string][]byte{
		"tar.gz": tarGzBytes(t, files, nil),
		"zip":    zipBytes(t, files),
	}
	for format, archive := range archives {
		archivePath := filepath.Join(t.TempDir(), "archive")
		if err := os.WriteFile(archivePath, archive, 0o644); err != nil {
			t.Fatal(err)
		}
		dest := t.TempDir()
		if err := extractArchive(format, archivePath, dest, nil); err != nil {
			t.Fatalf("%s: %v", format, err)
		}
		entry, err := os.Stat(filepath.Join(dest, "bin", "kuna-server"))
		if err != nil {
			t.Fatalf("%s: %v", format, err)
		}
		if entry.Mode().Perm()&0o111 == 0 {
			t.Fatalf("%s: entry is not executable: %v", format, entry.Mode())
		}
		if body, err := os.ReadFile(filepath.Join(dest, "specs", "kuna.sla")); err != nil || string(body) != "specs\n" {
			t.Fatalf("%s: payload mismatch: %q %v", format, body, err)
		}
	}
}

func TestExtractArchiveRejectsEscapes(t *testing.T) {
	zipPath := filepath.Join(t.TempDir(), "escape.zip")
	if err := os.WriteFile(zipPath, zipBytes(t, map[string]string{"../evil": "x"}), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := extractArchive("zip", zipPath, t.TempDir(), nil); err == nil || !strings.Contains(err.Error(), "escapes") {
		t.Fatalf("zip traversal err = %v", err)
	}
	// An escaping symlink is skipped with a warning instead of aborting the
	// import: the link is never created, so nothing escapes destDir.
	tarPath := filepath.Join(t.TempDir(), "escape.tar.gz")
	link := symlinkArchive(t, nil, "bin/link", "../../outside")
	if err := os.WriteFile(tarPath, link, 0o644); err != nil {
		t.Fatal(err)
	}
	dest := t.TempDir()
	var warnings bytes.Buffer
	if err := extractArchive("tar.gz", tarPath, dest, &warnings); err != nil {
		t.Fatalf("tar symlink err = %v", err)
	}
	if !strings.Contains(warnings.String(), "skipping symlink bin/link") || !strings.Contains(warnings.String(), "escapes") {
		t.Fatalf("tar symlink warning = %q", warnings.String())
	}
	if _, err := os.Lstat(filepath.Join(dest, "bin", "link")); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("escaping symlink was created: %v", err)
	}
}

// symlinkArchive builds a tar.gz holding the given regular files plus one
// symlink entry written first, so the link target only appears later in the
// stream (the order the deferred fallback has to cope with).
func symlinkArchive(t *testing.T, files map[string]string, name, target string) []byte {
	t.Helper()
	return tarGzBytes(t, files, func(writer *tar.Writer) error {
		return writer.WriteHeader(&tar.Header{Name: name, Linkname: target, Typeflag: tar.TypeSymlink, Mode: 0o777})
	})
}

// denySymlinks simulates Windows without developer mode: every symlink
// creation fails. The creator is restored after the test.
func denySymlinks(t *testing.T, err error) {
	t.Helper()
	restore := createSymlink
	createSymlink = func(string, string) error { return err }
	t.Cleanup(func() { createSymlink = restore })
}

func TestExtractArchiveFallsBackToCopyForSymlinks(t *testing.T) {
	denySymlinks(t, errors.New("a required privilege is not held by the client"))
	archive := symlinkArchive(t, map[string]string{"real.txt": "payload\n"}, "link.txt", "real.txt")
	path := filepath.Join(t.TempDir(), "link.tar.gz")
	if err := os.WriteFile(path, archive, 0o644); err != nil {
		t.Fatal(err)
	}
	dest := t.TempDir()
	var warnings bytes.Buffer
	if err := extractArchive("tar.gz", path, dest, &warnings); err != nil {
		t.Fatalf("extractArchive = %v", err)
	}
	body, err := os.ReadFile(filepath.Join(dest, "link.txt"))
	if err != nil || string(body) != "payload\n" {
		t.Fatalf("fallback copy = %q %v", body, err)
	}
	if warnings.Len() != 0 {
		t.Fatalf("unexpected warnings: %s", warnings.String())
	}
}

func TestExtractArchiveSkipsUnresolvableSymlinks(t *testing.T) {
	denySymlinks(t, errors.New("a required privilege is not held by the client"))
	archive := symlinkArchive(t, nil, "bin/link", "missing.txt")
	path := filepath.Join(t.TempDir(), "link.tar.gz")
	if err := os.WriteFile(path, archive, 0o644); err != nil {
		t.Fatal(err)
	}
	dest := t.TempDir()
	var warnings bytes.Buffer
	if err := extractArchive("tar.gz", path, dest, &warnings); err != nil {
		t.Fatalf("extractArchive = %v", err)
	}
	if _, err := os.Lstat(filepath.Join(dest, "bin", "link")); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("unresolvable symlink was created: %v", err)
	}
	if !strings.Contains(warnings.String(), "skipping symlink bin/link") {
		t.Fatalf("warning = %q, want the skipped entry named", warnings.String())
	}
}

func archiveInstall() *registry.Install {
	return &registry.Install{
		Source:     "repo",
		Repository: "Noelo-Lab/kuna",
		Asset:      "kuna-{version}.tar.gz",
		Format:     "tar.gz",
	}
}

func archiveEngine(install *registry.Install) registry.Engine {
	return registry.Engine{
		ID:      "kuna",
		Binary:  registry.Binary{Kind: "program", Path: "bin/kuna-server"},
		Release: install,
	}
}

func archiveSpec(home string) Spec { return EngineSpec(home, archiveEngine(archiveInstall())) }

// artifactSHA is the hex SHA-256 of a test archive, matching the value the
// downloader verifies against the release checksums.
func artifactSHA(content []byte) string {
	sum := sha256.Sum256(content)
	return hex.EncodeToString(sum[:])
}

// kunaArchive builds the release archive layout: decx.json + VERSION + payload.
func kunaArchive(t *testing.T, engine registry.Engine, version, binary, specs string) []byte {
	t.Helper()
	return tarGzBytes(t, map[string]string{
		registry.ManifestName: serverManifest(engine),
		registry.VersionName:  version + "\n",
		"bin/kuna-server":     binary,
		"specs/kuna.sla":      specs,
	}, nil)
}

func TestInstallArchiveExtractsSkipsAndUpdates(t *testing.T) {
	var downloads int32
	engine := archiveEngine(archiveInstall())
	archive := kunaArchive(t, engine, "4.4.0", "kuna 4.4.0\n", "specs\n")
	name := "kuna-4.4.0.tar.gz"
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/download/"+name {
			http.NotFound(w, r)
			return
		}
		atomic.AddInt32(&downloads, 1)
		_, _ = w.Write(archive)
	}))
	defer server.Close()
	downloader := Downloader{Client: server.Client()}
	home := t.TempDir()
	spec := archiveSpec(home)
	artifact := Artifact{Version: "4.4.0", Name: name, URL: server.URL + "/download/" + name, SHA256: artifactSHA(archive)}

	status, err := downloader.InstallSpec(context.Background(), spec, artifact, false, nil)
	if err != nil {
		t.Fatal(err)
	}
	entry := filepath.Join(home, "modules", "kuna", "bin", "kuna-server")
	if !status.Installed || status.Version != "4.4.0" || status.Path != entry {
		t.Fatalf("status = %+v", status)
	}
	if info, err := os.Stat(entry); err != nil || info.Mode().Perm()&0o111 == 0 {
		t.Fatalf("entry = %v %v", info, err)
	}
	if got := registry.ReadVersion(filepath.Join(home, "modules", "kuna")); got != "4.4.0" {
		t.Fatalf("installed version = %q", got)
	}
	// The same release does not download twice.
	if _, err := downloader.InstallSpec(context.Background(), spec, artifact, false, nil); err != nil {
		t.Fatal(err)
	}
	if got := atomic.LoadInt32(&downloads); got != 1 {
		t.Fatalf("downloads = %d", got)
	}
	// An update replaces the extracted tree with the new release.
	next := kunaArchive(t, engine, "4.5.0", "kuna 4.5.0\n", "specs 4.5\n")
	nextName := "kuna-4.5.0.tar.gz"
	server.Config.Handler = http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/download/"+nextName {
			http.NotFound(w, r)
			return
		}
		atomic.AddInt32(&downloads, 1)
		_, _ = w.Write(next)
	})
	artifact = Artifact{Version: "4.5.0", Name: nextName, URL: server.URL + "/download/" + nextName, SHA256: artifactSHA(next)}
	status, err = downloader.InstallSpec(context.Background(), spec, artifact, false, nil)
	if err != nil {
		t.Fatal(err)
	}
	if status.Version != "4.5.0" {
		t.Fatalf("version after update = %q", status.Version)
	}
	if body, err := os.ReadFile(entry); err != nil || string(body) != "kuna 4.5.0\n" {
		t.Fatalf("entry after update = %q %v", body, err)
	}
	// Nothing staged or renamed aside survives a successful swap.
	entries, err := os.ReadDir(filepath.Join(home, "modules"))
	if err != nil {
		t.Fatal(err)
	}
	for _, found := range entries {
		if strings.Contains(found.Name(), ".old-") || strings.Contains(found.Name(), ".install-") {
			t.Fatalf("leftover staging entry %q", found.Name())
		}
	}
}

func TestInstallArchiveKeepsPreviousInstallOnFailure(t *testing.T) {
	engine := archiveEngine(archiveInstall())
	good := kunaArchive(t, engine, "4.4.0", "good\n", "specs\n")
	bad := tarGzBytes(t, map[string]string{"specs/kuna.sla": "missing the launcher\n"}, nil)
	serve := func(body []byte) *httptest.Server {
		return httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			_, _ = w.Write(body)
		}))
	}
	home := t.TempDir()
	spec := archiveSpec(home)
	downloader := Downloader{}
	first := serve(good)
	status, err := downloader.InstallSpec(context.Background(), spec, Artifact{Version: "4.4.0", URL: first.URL + "/kuna.tar.gz", SHA256: artifactSHA(good)}, false, nil)
	first.Close()
	if err != nil || !status.Installed {
		t.Fatalf("first install: %+v %v", status, err)
	}
	second := serve(bad)
	_, err = downloader.InstallSpec(context.Background(), spec, Artifact{Version: "4.5.0", URL: second.URL + "/kuna.tar.gz", SHA256: artifactSHA(bad)}, true, nil)
	second.Close()
	if err == nil || !strings.Contains(err.Error(), "does not contain") {
		t.Fatalf("broken archive err = %v", err)
	}
	if body, err := os.ReadFile(filepath.Join(home, "modules", "kuna", "bin", "kuna-server")); err != nil || string(body) != "good\n" {
		t.Fatalf("previous install lost: %q %v", body, err)
	}
	if version := archiveSpec(home).Inspect().Version; version != "4.4.0" {
		t.Fatalf("version after failure = %q", version)
	}
}

func TestInspectArchiveEngine(t *testing.T) {
	home := t.TempDir()
	engine := archiveEngine(archiveInstall())
	if status := Inspect(home, engine); status.Installed {
		t.Fatalf("status before install = %+v", status)
	}
	root := filepath.Join(home, "modules", "kuna")
	writeServerTree(t, root, engine, "4.4.0", "bin\n")
	status := Inspect(home, engine)
	if !status.Installed || status.Version != "4.4.0" {
		t.Fatalf("status = %+v", status)
	}
	path, version, ok := EngineSpec(home, engine).Probe()
	if !ok || version != "4.4.0" || path != filepath.Join(root, "bin", "kuna-server") {
		t.Fatalf("probe = %q %q %t", path, version, ok)
	}
	if status := archiveSpec(home).Inspect(); !status.Installed || status.Version != "4.4.0" {
		t.Fatalf("spec inspect = %+v", status)
	}
}
