package install

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"sync/atomic"
	"testing"

	"github.com/jygzyc/decx/decx/internal/registry"
)

func testEngine() registry.Engine {
	return registry.Engine{
		ID:     "jadx",
		Binary: registry.Binary{Kind: "java-jar", Path: "jadx-server.jar", Env: "TEST_JADX_SERVER"},
		Release: &registry.Install{
			Source:         "repo",
			Repository:     "owner/repo",
			Asset:          "jadx-server-{version}.tar.gz",
			AssetFallbacks: []string{"decx-server-{version}.tar.gz"},
			Checksums:      "SHA256SUMS",
		},
	}
}

// serverManifest is the decx.json a server archive carries. It has to describe
// the same server the catalog expects, or adopt refuses the archive.
func serverManifest(engine registry.Engine) string {
	return fmt.Sprintf(`{"manifest":1,"kind":"server","id":%q,"binary":{"kind":%q,"path":%q},"launch":{"command":["{binary}"]},"commands":[{"name":"classes","endpoint":"/classes"}]}`,
		engine.ID, engine.Binary.Kind, filepath.ToSlash(engine.Binary.Path))
}

// serverFiles is the file layout a server release archive carries: the
// decx.json manifest, the VERSION file and the launcher the installer probes.
func serverFiles(engine registry.Engine, version, payload string) map[string]string {
	return map[string]string{
		registry.ManifestName:                serverManifest(engine),
		registry.VersionName:                 version + "\n",
		filepath.ToSlash(engine.Binary.Path): payload,
	}
}

// serverArchive builds a tar.gz release archive, the format the test catalog's
// asset names imply.
func serverArchive(t *testing.T, engine registry.Engine, version, payload string) []byte {
	t.Helper()
	return tarGzBytes(t, serverFiles(engine, version, payload), nil)
}

// writeServerTree writes an installed component (a local directory artifact)
// with the same files a release archive carries.
func writeServerTree(t *testing.T, root string, engine registry.Engine, version, payload string) {
	t.Helper()
	entry := filepath.Join(root, filepath.FromSlash(engine.Binary.Path))
	if err := os.MkdirAll(filepath.Dir(entry), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(entry, []byte(payload), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(root, registry.ManifestName), []byte(serverManifest(engine)), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(root, registry.VersionName), []byte(version+"\n"), 0o644); err != nil {
		t.Fatal(err)
	}
}

func releasesJSON(entries ...string) string {
	return "[" + strings.Join(entries, ",") + "]"
}

func releaseJSON(base, tag string, prerelease bool, assets ...string) string {
	items := make([]string, 0, len(assets))
	for _, asset := range assets {
		items = append(items, fmt.Sprintf(`{"name":%q,"browser_download_url":%q}`, asset, base+"/download/"+asset))
	}
	return fmt.Sprintf(`{"tag_name":%q,"draft":false,"prerelease":%t,"assets":[%s]}`, tag, prerelease, strings.Join(items, ","))
}

// sumsFile renders a SHA256SUMS body for the given assets.
func sumsFile(assets map[string][]byte) string {
	var body strings.Builder
	for name, data := range assets {
		sum := sha256.Sum256(data)
		fmt.Fprintf(&body, "%s  %s\n", hex.EncodeToString(sum[:]), name)
	}
	return body.String()
}

// fakeSums lists assets with a well-formed checksum; Resolve validates the
// format before the downloaded bytes are verified.
func fakeSums(names ...string) string {
	var body strings.Builder
	for _, name := range names {
		fmt.Fprintf(&body, "%s  %s\n", strings.Repeat("0", 64), name)
	}
	return body.String()
}

func TestTagVersion(t *testing.T) {
	cases := []struct {
		tag      string
		template string
		want     string
	}{
		{"v4.3.1", "", "4.3.1"},
		{"4.3.1", "", ""},
		{"other-4.3.1", "", ""},
		{"prerelease-4.4.0-177987", "prerelease-{version}", "4.4.0-177987"},
		{"prerelease-4.4.0-177987x", "prerelease-{version}", "4.4.0-177987x"},
	}
	for _, c := range cases {
		if version := registry.TagVersion(c.tag, c.template); version != c.want {
			t.Errorf("TagVersion(%q, %q) = %q, want %q", c.tag, c.template, version, c.want)
		}
	}
}

func TestResolvePrefersNewestStableReleaseWithAsset(t *testing.T) {
	body := releasesJSON(
		releaseJSON("https://example.com", "v4.4.0", false, "jadx-server-4.4.0.tar.gz.sig"),
		releaseJSON("https://example.com", "v4.3.2", true, "jadx-server-4.3.2.tar.gz"),
		releaseJSON("https://example.com", "v4.3.1", false, "decx-server-4.3.1.tar.gz"),
	)
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch {
		case r.URL.Path == "/repos/owner/repo/releases":
			_, _ = w.Write([]byte(body))
		case strings.Contains(r.URL.Path, "/releases/download/"):
			_, _ = w.Write([]byte(fakeSums("jadx-server-4.4.0.tar.gz", "jadx-server-4.3.2.tar.gz", "decx-server-4.3.1.tar.gz")))
		default:
			http.NotFound(w, r)
		}
	}))
	defer server.Close()
	downloader := Downloader{Client: server.Client(), GitHub: server.URL, GitHubAPI: server.URL}
	spec := EngineSpec(t.TempDir(), testEngine())
	artifact, err := downloader.Resolve(context.Background(), spec, "", false)
	if err != nil {
		t.Fatal(err)
	}
	// v4.4.0 has no matching asset and v4.3.2 is a prerelease, so the fallback
	// asset of v4.3.1 is the newest installable stable release.
	if artifact.Version != "4.3.1" || artifact.Name != "decx-server-4.3.1.tar.gz" {
		t.Fatalf("artifact = %+v", artifact)
	}
	if artifact.URL != "https://example.com/download/decx-server-4.3.1.tar.gz" {
		t.Fatalf("url = %q", artifact.URL)
	}
	artifact, err = downloader.Resolve(context.Background(), spec, "", true)
	if err != nil {
		t.Fatal(err)
	}
	if artifact.Version != "4.3.2" || artifact.Name != "jadx-server-4.3.2.tar.gz" {
		t.Fatalf("prerelease artifact = %+v", artifact)
	}
}

func TestResolveWithoutMatchOrSource(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write([]byte(releasesJSON(releaseJSON("https://example.com", "v4.3.1", false, "other-4.3.1.tar.gz"))))
	}))
	defer server.Close()
	downloader := Downloader{Client: server.Client(), GitHubAPI: server.URL}
	if _, err := downloader.Resolve(context.Background(), EngineSpec(t.TempDir(), testEngine()), "", false); err == nil || !strings.Contains(err.Error(), "is not available") {
		t.Fatalf("err = %v", err)
	}
	engine := testEngine()
	engine.Release = nil
	if _, err := downloader.Resolve(context.Background(), EngineSpec(t.TempDir(), engine), "", false); err == nil || !strings.Contains(err.Error(), "install source") {
		t.Fatalf("err = %v", err)
	}
}

// TestResolveRequiresChecksumsAsset checks that a repository release without a
// checksums asset is rejected instead of installed unverified.
func TestResolveRequiresChecksumsAsset(t *testing.T) {
	engine := testEngine()
	engine.Release.Checksums = ""
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write([]byte(releasesJSON(releaseJSON("https://example.com", "v4.3.1", false, "jadx-server-4.3.1.tar.gz"))))
	}))
	defer server.Close()
	downloader := Downloader{Client: server.Client(), GitHubAPI: server.URL}
	if _, err := downloader.Resolve(context.Background(), EngineSpec(t.TempDir(), engine), "", false); err == nil || !strings.Contains(err.Error(), "checksums asset") {
		t.Fatalf("err = %v", err)
	}
}

func TestInstallDownloadsAndSkipsCurrentVersion(t *testing.T) {
	var downloads int32
	engine := testEngine()
	archive := serverArchive(t, engine, "4.3.1", "jadx 4.3.1\n")
	name := "jadx-server-4.3.1.tar.gz"
	var base string
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/repos/owner/repo/releases":
			_, _ = w.Write([]byte(releasesJSON(releaseJSON(base, "v4.3.1", false, name))))
		case "/download/" + name:
			atomic.AddInt32(&downloads, 1)
			_, _ = w.Write(archive)
		case "/owner/repo/releases/download/v4.3.1/SHA256SUMS":
			_, _ = w.Write([]byte(sumsFile(map[string][]byte{name: archive})))
		default:
			http.NotFound(w, r)
		}
	}))
	defer server.Close()
	base = server.URL
	downloader := Downloader{Client: server.Client(), GitHub: server.URL, GitHubAPI: server.URL}
	home := t.TempDir()
	spec := EngineSpec(home, engine)
	artifact, err := downloader.Resolve(context.Background(), spec, "", false)
	if err != nil {
		t.Fatal(err)
	}
	status, err := downloader.InstallSpec(context.Background(), spec, artifact, false, nil)
	if err != nil {
		t.Fatal(err)
	}
	entry := filepath.Join(home, "modules", "jadx", "jadx-server.jar")
	if !status.Installed || status.Version != "4.3.1" || status.Path != entry {
		t.Fatalf("status = %+v", status)
	}
	if data, err := os.ReadFile(entry); err != nil || string(data) != "jadx 4.3.1\n" {
		t.Fatalf("installed payload mismatch: %q %v", data, err)
	}
	// Re-installing the same version is a no-op.
	if _, err := downloader.InstallSpec(context.Background(), spec, artifact, false, nil); err != nil {
		t.Fatal(err)
	}
	if got := atomic.LoadInt32(&downloads); got != 1 {
		t.Fatalf("downloads = %d", got)
	}
	// An update to a new version replaces the artifact.
	next := serverArchive(t, engine, "4.4.0", "jadx 4.4.0\n")
	nextName := "jadx-server-4.4.0.tar.gz"
	server.Config.Handler = http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/repos/owner/repo/releases":
			_, _ = w.Write([]byte(releasesJSON(releaseJSON(base, "v4.4.0", false, nextName))))
		case "/download/" + nextName:
			atomic.AddInt32(&downloads, 1)
			_, _ = w.Write(next)
		case "/owner/repo/releases/download/v4.4.0/SHA256SUMS":
			_, _ = w.Write([]byte(sumsFile(map[string][]byte{nextName: next})))
		default:
			http.NotFound(w, r)
		}
	})
	artifact, err = downloader.Resolve(context.Background(), spec, "", false)
	if err != nil {
		t.Fatal(err)
	}
	status, err = downloader.InstallSpec(context.Background(), spec, artifact, false, nil)
	if err != nil {
		t.Fatal(err)
	}
	if status.Version != "4.4.0" {
		t.Fatalf("version after update = %q", status.Version)
	}
	if data, err := os.ReadFile(entry); err != nil || string(data) != "jadx 4.4.0\n" {
		t.Fatalf("updated payload mismatch: %q %v", data, err)
	}
	if got := atomic.LoadInt32(&downloads); got != 2 {
		t.Fatalf("downloads after update = %d", got)
	}
}

func TestInstallRejectsBrokenArtifacts(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write([]byte("not an archive"))
	}))
	defer server.Close()
	downloader := Downloader{Client: server.Client()}
	spec := EngineSpec(t.TempDir(), testEngine())
	artifact := Artifact{Version: "4.3.1", Name: "jadx-server-4.3.1.tar.gz", URL: server.URL + "/broken.tar.gz"}
	if _, err := downloader.InstallSpec(context.Background(), spec, artifact, false, nil); err == nil {
		t.Fatal("accepted a broken artifact")
	}
	if _, err := downloader.InstallSpec(context.Background(), spec, Artifact{Version: "4.3.1"}, false, nil); err == nil {
		t.Fatal("accepted an artifact without a URL")
	}
}

// TestFetchRejectsUnchecksummedArtifact is the install path's fail-closed
// guard: a repository artifact that somehow reached it without a SHA-256 is
// discarded instead of staged.
func TestFetchRejectsUnchecksummedArtifact(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write([]byte("payload"))
	}))
	defer server.Close()
	downloader := Downloader{Client: server.Client()}
	artifact := Artifact{Version: "1.0.0", Name: "sample.zip", URL: server.URL + "/sample.zip"}
	if _, err := downloader.fetch(context.Background(), EngineSpec(t.TempDir(), testEngine()), artifact, nil); err == nil || !strings.Contains(err.Error(), "no SHA-256 checksum") {
		t.Fatalf("err = %v", err)
	}
}

// TestInTempDirIgnoresSiblingPaths pins down that a binary at /tmpfoo/decx is
// not mistaken for a build output in /tmp.
func TestInTempDirIgnoresSiblingPaths(t *testing.T) {
	temp := filepath.Clean(os.TempDir())
	if !inTempDir(filepath.Join(temp, "decx")) {
		t.Fatalf("%s is inside %s", filepath.Join(temp, "decx"), temp)
	}
	if inTempDir(filepath.Join(temp+"-other", "decx")) {
		t.Fatalf("%s is not inside %s", filepath.Join(temp+"-other", "decx"), temp)
	}
	if inTempDir(temp + "decx") {
		t.Fatalf("%s is not inside %s", temp+"decx", temp)
	}
}

func TestInstallRejectsChecksumMismatch(t *testing.T) {
	engine := testEngine()
	archive := serverArchive(t, engine, "4.3.1", "payload\n")
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write(archive)
	}))
	defer server.Close()
	downloader := Downloader{Client: server.Client()}
	home := t.TempDir()
	artifact := Artifact{
		Version: "4.3.1",
		Name:    "jadx-server-4.3.1.tar.gz",
		URL:     server.URL + "/jadx.tar.gz",
		SHA256:  strings.Repeat("0", 64),
	}
	if _, err := downloader.InstallSpec(context.Background(), EngineSpec(home, engine), artifact, false, nil); err == nil || !strings.Contains(err.Error(), "checksum mismatch") {
		t.Fatalf("err = %v", err)
	}
	if _, err := os.Stat(filepath.Join(home, "modules", "jadx", "jadx-server.jar")); !os.IsNotExist(err) {
		t.Fatalf("a mismatching artifact was installed: %v", err)
	}
}

func TestInspectAndVersionFile(t *testing.T) {
	home := t.TempDir()
	engine := testEngine()
	status := Inspect(home, engine)
	if status.Installed || status.Version != "" {
		t.Fatalf("status = %+v", status)
	}
	root := filepath.Join(home, "modules", "jadx")
	writeServerTree(t, root, engine, "9.9.9", "managed\n")
	status = Inspect(home, engine)
	if !status.Installed || status.Version != "9.9.9" || status.Path != filepath.Join(root, "jadx-server.jar") {
		t.Fatalf("status = %+v", status)
	}
	path, version, ok := EngineSpec(home, engine).Probe()
	if !ok || version != "9.9.9" || path != filepath.Join(root, "jadx-server.jar") {
		t.Fatalf("probe = %q %q %t", path, version, ok)
	}
	// A component discovered in a source checkout reports the version from its
	// own VERSION file, not just that it is installed.
	checkout := t.TempDir()
	checkoutEngine := engine
	checkoutEngine.Root = checkout
	writeServerTree(t, checkout, checkoutEngine, "1.2.3", "checkout\n")
	status = Inspect(t.TempDir(), checkoutEngine)
	if !status.Installed || status.Version != "1.2.3" || status.Path != filepath.Join(checkout, "jadx-server.jar") {
		t.Fatalf("checkout status = %+v", status)
	}
	// The environment override wins over the installed component, and such a
	// server carries no managed version of its own; inspection must report the
	// same binary the launcher would use.
	override := filepath.Join(t.TempDir(), "jadx-server.jar")
	if err := os.WriteFile(override, []byte("env\n"), 0o755); err != nil {
		t.Fatal(err)
	}
	t.Setenv(engine.Binary.Env, override)
	status = Inspect(home, engine)
	if !status.Installed || status.Path != override || status.Version != "" {
		t.Fatalf("env status = %+v", status)
	}
	if path, version, ok := Probe(home, engine); !ok || path != override || version != "" {
		t.Fatalf("env probe = %q %q %t", path, version, ok)
	}
}

func TestAssetCandidatesSubstitutePlatform(t *testing.T) {
	originalOS, originalArch := registry.AssetOS, registry.AssetArch
	registry.AssetOS, registry.AssetArch = "linux", "arm64"
	defer func() { registry.AssetOS, registry.AssetArch = originalOS, originalArch }()

	install := &registry.Install{
		Asset:          "kuna-server-{version}-{os}-{arch}.tar.gz",
		AssetFallbacks: []string{"kuna-server-{version}.tar.gz"},
	}
	got := registry.AssetCandidates(install, "4.3.0")
	want := []string{"kuna-server-4.3.0-linux-arm64.tar.gz", "kuna-server-4.3.0.tar.gz"}
	if len(got) != len(want) {
		t.Fatalf("got %v", got)
	}
	for i := range want {
		if got[i] != want[i] {
			t.Fatalf("got %v want %v", got, want)
		}
	}
}

func TestLocalInstallCopiesAndPicksUpReplacements(t *testing.T) {
	home := t.TempDir()
	source := t.TempDir()
	engine := testEngine()
	writeServerTree(t, source, engine, "9.9.9", "local 9.9.9\n")
	engine.Release = &registry.Install{Source: "local", Path: source}
	spec := EngineSpec(home, engine)
	downloader := Downloader{}
	artifact, err := downloader.Resolve(context.Background(), spec, "", false)
	if err != nil {
		t.Fatal(err)
	}
	if !artifact.Local || !artifact.Dir || artifact.Version != "9.9.9" || artifact.Path != source {
		t.Fatalf("artifact = %+v", artifact)
	}
	status, err := downloader.InstallSpec(context.Background(), spec, artifact, false, nil)
	if err != nil {
		t.Fatal(err)
	}
	if !status.Installed || status.Version != "9.9.9" {
		t.Fatalf("status = %+v", status)
	}
	entry := filepath.Join(home, "modules", "jadx", "jadx-server.jar")
	if data, err := os.ReadFile(entry); err != nil || string(data) != "local 9.9.9\n" {
		t.Fatalf("installed payload mismatch: %q %v", data, err)
	}
	// Replacing the files behind the same path changes the recorded version,
	// so an unforced install picks the new build up.
	writeServerTree(t, source, engine, "9.9.10", "local 9.9.10\n")
	artifact, err = downloader.Resolve(context.Background(), spec, "", false)
	if err != nil {
		t.Fatal(err)
	}
	if artifact.Version != "9.9.10" {
		t.Fatalf("artifact = %+v", artifact)
	}
	status, err = downloader.InstallSpec(context.Background(), spec, artifact, false, nil)
	if err != nil || status.Version != "9.9.10" {
		t.Fatalf("status = %+v err = %v", status, err)
	}
	if data, err := os.ReadFile(entry); err != nil || string(data) != "local 9.9.10\n" {
		t.Fatalf("updated payload mismatch: %q %v", data, err)
	}
}

func TestLocalArchiveInstallExtractsEntry(t *testing.T) {
	home := t.TempDir()
	engine := registry.Engine{
		ID:      "kuna",
		Binary:  registry.Binary{Kind: "program", Path: "bin/kuna-server"},
		Release: &registry.Install{Source: "local", Format: "zip"},
	}
	source := filepath.Join(t.TempDir(), "kuna-server.zip")
	if err := os.WriteFile(source, zipBytes(t, serverFiles(engine, "4.4.0", "#!/bin/sh\n")), 0o644); err != nil {
		t.Fatal(err)
	}
	engine.Release.Path = source
	spec := EngineSpec(home, engine)
	downloader := Downloader{}
	artifact, err := downloader.Resolve(context.Background(), spec, "", false)
	if err != nil {
		t.Fatal(err)
	}
	if !artifact.Local || artifact.Dir || artifact.Version != "4.4.0" {
		t.Fatalf("artifact = %+v", artifact)
	}
	if _, err := downloader.InstallSpec(context.Background(), spec, artifact, false, nil); err != nil {
		t.Fatal(err)
	}
	info, err := os.Stat(filepath.Join(home, "modules", "kuna", "bin", "kuna-server"))
	if err != nil {
		t.Fatal(err)
	}
	if info.Mode().Perm() != 0o755 {
		t.Fatalf("entry mode = %v", info.Mode().Perm())
	}
	if got := registry.ReadVersion(filepath.Join(home, "modules", "kuna")); got != "4.4.0" {
		t.Fatalf("installed version = %q", got)
	}
}

func TestLocalArtifactMustExist(t *testing.T) {
	home := t.TempDir()
	engine := testEngine()
	for _, path := range []string{"missing/jadx-server.jar", "../escape.jar"} {
		engine.Release = &registry.Install{Source: "local", Path: path}
		spec := EngineSpec(home, engine)
		if _, err := (Downloader{}).Resolve(context.Background(), spec, "", false); err == nil {
			t.Fatalf("accepted local path %q", path)
		}
	}
	// A directory is a valid local artifact; the decx.json inside it decides
	// whether the install succeeds.
	engine.Release = &registry.Install{Source: "local", Path: t.TempDir()}
	artifact, err := (Downloader{}).Resolve(context.Background(), EngineSpec(home, engine), "", false)
	if err != nil || !artifact.Dir {
		t.Fatalf("artifact = %+v err = %v", artifact, err)
	}
}

// TestCLIArtifactAndUpdateCLI covers resolving and installing the CLI release
// archive, including the SHA256SUMS lookup the compiler publishes next to it.
func TestCLIArtifactAndUpdateCLI(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("the replacement binary is a regular file; covered on Unix")
	}
	const version = "9.9.9"
	name := fmt.Sprintf("decx-cli-%s-%s-%s.tar.gz", version, registry.AssetOS, registry.AssetArch)
	archive := tarGzBytes(t, map[string]string{"decx": "new-binary"}, nil)
	var base string
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/repos/jygzyc/decx/releases":
			_, _ = w.Write([]byte(releasesJSON(releaseJSON(base, "v"+version, false, name))))
		case "/download/" + name:
			_, _ = w.Write(archive)
		case "/jygzyc/decx/releases/download/v" + version + "/SHA256SUMS":
			_, _ = w.Write([]byte(sumsFile(map[string][]byte{name: archive})))
		default:
			http.NotFound(w, r)
		}
	}))
	defer server.Close()
	base = server.URL
	downloader := Downloader{Client: server.Client(), GitHub: server.URL, GitHubAPI: server.URL}
	artifact, err := downloader.CLIArtifact(context.Background(), false)
	if err != nil {
		t.Fatal(err)
	}
	if artifact.Version != version || artifact.Name != name || artifact.SHA256 == "" {
		t.Fatalf("artifact = %+v", artifact)
	}
	target := filepath.Join(t.TempDir(), "decx")
	if err := os.WriteFile(target, []byte("old-binary"), 0o755); err != nil {
		t.Fatal(err)
	}
	status, err := downloader.UpdateCLI(context.Background(), CLIUpdate{CurrentVersion: "1.0.0", Executable: target}, nil)
	if err != nil {
		t.Fatal(err)
	}
	if !status.Updated || status.Version != version || status.Path != target {
		t.Fatalf("status = %+v", status)
	}
	if body, err := os.ReadFile(target); err != nil || string(body) != "new-binary" {
		t.Fatalf("executable = %q %v", body, err)
	}
	// A second run at the newest version is a no-op.
	status, err = downloader.UpdateCLI(context.Background(), CLIUpdate{CurrentVersion: version, Executable: target}, nil)
	if err != nil || status.Updated || status.Message != "already up to date" {
		t.Fatalf("status = %+v err = %v", status, err)
	}
}
