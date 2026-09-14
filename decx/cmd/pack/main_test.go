package main

import (
	"archive/tar"
	"archive/zip"
	"bytes"
	"compress/gzip"
	"io"
	"os"
	"path/filepath"
	"runtime"
	"testing"
)

func TestArchiveName(t *testing.T) {
	cases := []struct{ version, goos, goarch, want string }{
		{"4.2.0", "linux", "amd64", "decx-cli-4.2.0-linux-amd64.tar.gz"},
		{"4.2.0", "darwin", "arm64", "decx-cli-4.2.0-darwin-arm64.tar.gz"},
		{"4.2.0", "windows", "amd64", "decx-cli-4.2.0-windows-amd64.zip"},
		{"4.2.0", "windows", "arm64", "decx-cli-4.2.0-windows-arm64.zip"},
	}
	for _, test := range cases {
		if got := archiveName(test.version, test.goos, test.goarch); got != test.want {
			t.Errorf("archiveName(%q, %q, %q) = %q, want %q", test.version, test.goos, test.goarch, got, test.want)
		}
	}
}

func TestReadVersion(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "version")
	if err := os.WriteFile(path, []byte("4.2.0\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	version, err := readVersion(path)
	if err != nil || version != "4.2.0" {
		t.Fatalf("readVersion = %q, %v; want 4.2.0", version, err)
	}
	if err := os.WriteFile(path, []byte("  \n"), 0o644); err != nil {
		t.Fatal(err)
	}
	if _, err := readVersion(path); err == nil {
		t.Fatal("empty version file accepted")
	}
	if _, err := readVersion(filepath.Join(dir, "absent")); err == nil {
		t.Fatal("missing version file accepted")
	}
}

func TestResolvePlatform(t *testing.T) {
	t.Setenv("OUT_OS", "plan9")
	if _, err := resolvePlatform("OUT_OS", "", "linux", "darwin", "linux", "windows"); err == nil {
		t.Fatal("unsupported OS accepted")
	}
	t.Setenv("OUT_OS", "windows")
	if got, err := resolvePlatform("OUT_OS", "", "linux", "darwin", "linux", "windows"); err != nil || got != "windows" {
		t.Fatalf("resolvePlatform = %q, %v; want windows", got, err)
	}
	// The --os flag wins over the environment and the host fallback.
	if got, err := resolvePlatform("OUT_OS", "darwin", "linux", "darwin", "linux", "windows"); err != nil || got != "darwin" {
		t.Fatalf("resolvePlatform flag = %q, %v; want darwin", got, err)
	}
	t.Setenv("OUT_ARCH", "")
	if got, err := resolvePlatform("OUT_ARCH", "", "arm64", "amd64", "arm64"); err != nil || got != "arm64" {
		t.Fatalf("resolvePlatform fallback = %q, %v; want arm64", got, err)
	}
	t.Setenv("OUT_OS", "")
	if _, err := resolvePlatform("OUT_OS", "plan9", "linux", "darwin", "linux", "windows"); err == nil {
		t.Fatal("unsupported --os accepted")
	}
}

func TestParseTarget(t *testing.T) {
	cases := []struct {
		args []string
		want target
	}{
		{nil, target{}},
		{[]string{"--os", "linux"}, target{OS: "linux"}},
		{[]string{"--arch", "arm64"}, target{Arch: "arm64"}},
		{[]string{"--os=windows", "--arch=amd64"}, target{OS: "windows", Arch: "amd64"}},
	}
	for _, test := range cases {
		got, err := parseTarget(test.args)
		if err != nil || got != test.want {
			t.Errorf("parseTarget(%v) = %+v, %v; want %+v", test.args, got, err, test.want)
		}
	}
	for _, args := range [][]string{{"--os"}, {"--arch="}, {"--os", ""}, {"--bogus"}} {
		if _, err := parseTarget(args); err == nil {
			t.Errorf("parseTarget(%v) accepted", args)
		}
	}
}

func TestCrossBuildCheck(t *testing.T) {
	if err := crossBuildCheck(runtime.GOOS, runtime.GOARCH, ""); err != nil {
		t.Fatalf("host target rejected: %v", err)
	}
	otherOS, otherArch := "windows", "arm64"
	if runtime.GOOS == "windows" {
		otherOS = "linux"
	}
	if runtime.GOARCH == "arm64" {
		otherArch = "amd64"
	}
	if err := crossBuildCheck(otherOS, otherArch, ""); err == nil {
		t.Fatal("cross target without CC accepted")
	}
	if err := crossBuildCheck(otherOS, otherArch, "aarch64-w64-mingw32-gcc"); err != nil {
		t.Fatalf("cross target with CC rejected: %v", err)
	}
}

func TestWriteArchiveTarGz(t *testing.T) {
	entries := fixtureEntries(t)
	archive := filepath.Join(t.TempDir(), "decx-cli-4.2.0-linux-amd64.tar.gz")
	if err := writeArchive(archive, entries); err != nil {
		t.Fatal(err)
	}
	first, err := os.ReadFile(archive)
	if err != nil {
		t.Fatal(err)
	}
	assertArchive(t, readTarGz(t, archive))
	// Re-packing the same files must produce identical bytes: the release job
	// verifies checksums across platforms, so nothing may depend on the clock.
	if err := writeArchive(archive, entries); err != nil {
		t.Fatal(err)
	}
	second, err := os.ReadFile(archive)
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(first, second) {
		t.Fatal("tar.gz bytes differ between runs")
	}
}

func TestWriteArchiveZip(t *testing.T) {
	entries := fixtureEntries(t)
	archive := filepath.Join(t.TempDir(), "decx-cli-4.2.0-windows-amd64.zip")
	if err := writeArchive(archive, entries); err != nil {
		t.Fatal(err)
	}
	first, err := os.ReadFile(archive)
	if err != nil {
		t.Fatal(err)
	}
	assertArchive(t, readZip(t, archive))
	if err := writeArchive(archive, entries); err != nil {
		t.Fatal(err)
	}
	second, err := os.ReadFile(archive)
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(first, second) {
		t.Fatal("zip bytes differ between runs")
	}
}

func TestAppendChecksum(t *testing.T) {
	dir := t.TempDir()
	archive := filepath.Join(dir, "decx-cli-4.2.0-linux-amd64.tar.gz")
	if err := os.WriteFile(archive, []byte("payload"), 0o644); err != nil {
		t.Fatal(err)
	}
	sums := filepath.Join(dir, "SHA256SUMS")
	digest, err := appendChecksum(sums, archive)
	if err != nil {
		t.Fatal(err)
	}
	if len(digest) != 64 {
		t.Fatalf("digest = %q, want 64 hex characters", digest)
	}
	if _, err := appendChecksum(sums, archive); err != nil {
		t.Fatal(err)
	}
	data, err := os.ReadFile(sums)
	if err != nil {
		t.Fatal(err)
	}
	want := digest + "  " + filepath.Base(archive) + "\n"
	if got := string(data); got != want+want {
		t.Fatalf("SHA256SUMS = %q, want two identical lines", got)
	}
}

type archiveFile struct {
	content string
	mode    os.FileMode
}

// fixtureEntries stages the four archive members with their release modes.
func fixtureEntries(t *testing.T) []entry {
	t.Helper()
	files := []struct {
		name    string
		content string
		mode    os.FileMode
	}{
		{"decx", "binary", execMode},
		{"README.md", "readme\n", fileMode},
		{"LICENSE", "license\n", fileMode},
	}
	dir := t.TempDir()
	entries := make([]entry, 0, len(files))
	for _, file := range files {
		path := filepath.Join(dir, file.name)
		if err := os.WriteFile(path, []byte(file.content), file.mode); err != nil {
			t.Fatal(err)
		}
		if err := os.Chmod(path, file.mode); err != nil {
			t.Fatal(err)
		}
		entries = append(entries, entry{name: file.name, path: path, mode: file.mode})
	}
	return entries
}

func assertArchive(t *testing.T, got map[string]archiveFile) {
	t.Helper()
	want := map[string]archiveFile{
		"decx":      {"binary", execMode},
		"README.md": {"readme\n", fileMode},
		"LICENSE":   {"license\n", fileMode},
	}
	if len(got) != len(want) {
		t.Fatalf("archive holds %d files, want %d: %v", len(got), len(want), got)
	}
	for name, expected := range want {
		file, ok := got[name]
		if !ok {
			t.Errorf("archive is missing %s", name)
			continue
		}
		if file.content != expected.content {
			t.Errorf("%s content = %q, want %q", name, file.content, expected.content)
		}
		if file.mode.Perm() != expected.mode {
			t.Errorf("%s mode = %v, want %v", name, file.mode.Perm(), expected.mode)
		}
	}
}

func readTarGz(t *testing.T, path string) map[string]archiveFile {
	t.Helper()
	file, err := os.Open(path)
	if err != nil {
		t.Fatal(err)
	}
	defer file.Close()
	gz, err := gzip.NewReader(file)
	if err != nil {
		t.Fatal(err)
	}
	defer gz.Close()
	reader := tar.NewReader(gz)
	files := make(map[string]archiveFile)
	for {
		header, err := reader.Next()
		if err == io.EOF {
			return files
		}
		if err != nil {
			t.Fatal(err)
		}
		data, err := io.ReadAll(reader)
		if err != nil {
			t.Fatal(err)
		}
		files[header.Name] = archiveFile{string(data), os.FileMode(header.Mode).Perm()}
	}
}

func readZip(t *testing.T, path string) map[string]archiveFile {
	t.Helper()
	reader, err := zip.OpenReader(path)
	if err != nil {
		t.Fatal(err)
	}
	defer reader.Close()
	files := make(map[string]archiveFile)
	for _, file := range reader.File {
		source, err := file.Open()
		if err != nil {
			t.Fatal(err)
		}
		data, err := io.ReadAll(source)
		source.Close()
		if err != nil {
			t.Fatal(err)
		}
		files[file.Name] = archiveFile{string(data), file.Mode().Perm()}
	}
	return files
}
