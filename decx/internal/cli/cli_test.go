package cli

import (
	"archive/tar"
	"archive/zip"
	"bytes"
	"compress/gzip"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"

	"github.com/jygzyc/decx/decx/internal/registry"
)

// installManifest writes one component manifest under its DECX_HOME root.
func installManifest(t *testing.T, dir string, manifest registry.Manifest) {
	t.Helper()
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := registry.WriteManifest(dir, manifest); err != nil {
		t.Fatal(err)
	}
}

// queryModule is a server manifest with one command the tests can exercise.
func queryModule(id string) registry.Manifest {
	return registry.Manifest{
		Manifest:    1,
		Kind:        registry.KindServer,
		ID:          id,
		Description: id + " server",
		Binary:      &registry.Binary{Kind: "program", Path: id + "-server"},
		Launch:      &registry.Launch{Command: []string{"{binary}", "{target}", "--port", "{port}"}},
		Commands: []registry.Command{{
			Name:     "query",
			About:    "query the test module",
			Endpoint: "query",
			Args:     []registry.Arg{{ID: "text", Kind: "positional", Required: true}},
			Request:  []registry.Mapping{{Arg: "text", Field: "query", Type: "string", When: "always"}},
		}},
	}
}

func TestRuntimeToolInvocation(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/api/decx/query" || r.Method != "POST" {
			t.Errorf("wrong route %s %s", r.Method, r.URL.Path)
		}
		var data map[string]any
		if err := json.NewDecoder(r.Body).Decode(&data); err != nil {
			t.Error(err)
		}
		if data["query"] != "hello" {
			t.Errorf("body %v", data)
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"ok":true,"items":["custom response"]}`))
	}))
	defer server.Close()
	_, port, _ := net.SplitHostPort(strings.TrimPrefix(server.URL, "http://"))
	home := t.TempDir()
	installManifest(t, registry.ModuleRoot(home, "custom"), queryModule("custom"))
	var output bytes.Buffer
	a := App{Home: home, Out: &output, HTTP: server.Client()}
	if err := a.Run(context.Background(), []string{"-m", "custom", "query", "hello", "--port", port}); err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(output.String(), "custom response") {
		t.Fatal(output.String())
	}
}

func TestShippedKunaModuleInvocation(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/api/decx/get_functions" || r.Method != "POST" {
			t.Errorf("wrong route %s %s", r.Method, r.URL.Path)
		}
		var data map[string]any
		if err := json.NewDecoder(r.Body).Decode(&data); err != nil {
			t.Error(err)
		}
		if data["name_contains"] != "main" || data["case_sensitive"] != false {
			t.Errorf("body %v", data)
		}
		if page, ok := data["page"].(float64); !ok || page != 1 {
			t.Errorf("page %v", data["page"])
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"ok":true,"items":["kuna response"]}`))
	}))
	defer server.Close()
	_, port, _ := net.SplitHostPort(strings.TrimPrefix(server.URL, "http://"))
	// The shipped decx.json manifest supplies the runtime definition, so install
	// it under DECX_HOME to run the module without a built server.
	manifest, err := os.ReadFile(filepath.Join("..", "..", "..", "modules", "decx-kuna", "decx.json"))
	if err != nil {
		t.Fatal(err)
	}
	home := t.TempDir()
	kunaDir := registry.ModuleRoot(home, "kuna")
	if err := os.MkdirAll(kunaDir, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(kunaDir, "decx.json"), manifest, 0o644); err != nil {
		t.Fatal(err)
	}
	var output bytes.Buffer
	a := App{Home: home, Out: &output, HTTP: server.Client()}
	if err := a.Run(context.Background(), []string{"-m", "kuna", "functions", "--contains", "main", "--port", port}); err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(output.String(), "kuna response") {
		t.Fatal(output.String())
	}
}

func TestPluginInvocation(t *testing.T) {
	home := t.TempDir()
	dir := registry.ModuleRoot(home, "ard-framework")
	script := `const { fs } = globalThis.decx;
globalThis.handle = function (request) {
    fs.writeFileSync(request.context.pluginDir + "/request.json", JSON.stringify(request));
    if (JSON.stringify(request).includes("FAILME")) {
      return { ok: false, error: { code: "ADB_DEVICE_AMBIGUOUS", message: "several devices" } };
    }
    return { ok: true, data: { jarPath: "/tmp/framework.jar" } };
};
`
	manifest := registry.Manifest{
		Manifest:    1,
		Kind:        registry.KindPlugin,
		ID:          "ard-framework",
		Description: "test plugin",
		Entry:       "main.js",
		Release: &registry.Install{
			Source:     "repo",
			Repository: "owner/plugins",
			Tag:        "ard-framework-v{version}",
			Asset:      "decx-ard-framework-plugin-{version}.zip",
			Checksums:  "SHA256SUMS",
		},
		Commands: []registry.Command{{
			Name:  "collect",
			About: "collect",
			Args:  []registry.Arg{{ID: "serial", Kind: "value", Long: "serial"}},
		}},
	}
	installManifest(t, dir, manifest)
	if err := os.WriteFile(filepath.Join(dir, "main.js"), []byte(script), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := registry.WriteVersion(dir, "1.0.0"); err != nil {
		t.Fatal(err)
	}
	var output bytes.Buffer
	a := App{Home: home, Out: &output}
	if err := a.Run(context.Background(), []string{"-m", "ard-framework", "collect", "--serial", "S1"}); err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(output.String(), "/tmp/framework.jar") {
		t.Fatal(output.String())
	}
	raw, err := os.ReadFile(filepath.Join(dir, "request.json"))
	if err != nil {
		t.Fatal(err)
	}
	var request struct {
		Command []string          `json:"command"`
		Args    map[string]string `json:"args"`
		Context struct {
			PluginDir string `json:"pluginDir"`
		} `json:"context"`
	}
	if err := json.Unmarshal(raw, &request); err != nil {
		t.Fatal(err)
	}
	if strings.Join(request.Command, " ") != "collect" || request.Args["serial"] != "S1" {
		t.Fatalf("request %+v", request)
	}
	if request.Context.PluginDir != dir {
		t.Fatalf("plugin dir %s", request.Context.PluginDir)
	}
	err = a.Run(context.Background(), []string{"-m", "ard-framework", "collect", "--serial", "FAILME"})
	if err == nil || !strings.Contains(err.Error(), "ADB_DEVICE_AMBIGUOUS") {
		t.Fatalf("error %v", err)
	}
	output.Reset()
	if err := a.Run(context.Background(), []string{"module", "list"}); err != nil {
		t.Fatal(err)
	}
	listed := output.String()
	for _, want := range []string{`"id":"ard-framework"`, `"kind":"plugin"`, `"installed":true`, `"installable":true`, `"version":"1.0.0"`, `"path":"` + dir + `"`} {
		if !strings.Contains(listed, want) {
			t.Fatalf("module list missing %s: %s", want, listed)
		}
	}
	// A plugin whose manifest declares no release block is still discovered and
	// runnable, but cannot be updated from a release.
	manualDir := registry.ModuleRoot(home, "manual")
	installManifest(t, manualDir, registry.Manifest{
		Manifest: 1,
		Kind:     registry.KindPlugin,
		ID:       "manual",
		Entry:    "manual.js",
		Commands: []registry.Command{{Name: "collect", About: "collect"}},
	})
	if err := os.WriteFile(filepath.Join(manualDir, "manual.js"), []byte("globalThis.handle = () => ({ ok: true, data: {} });"), 0o644); err != nil {
		t.Fatal(err)
	}
	output.Reset()
	if err := a.Run(context.Background(), []string{"module", "list"}); err != nil {
		t.Fatal(err)
	}
	var rows []moduleView
	if err := json.Unmarshal(output.Bytes(), &rows); err != nil {
		t.Fatal(err)
	}
	for _, row := range rows {
		if row.ID != "manual" {
			continue
		}
		if !row.Installed || row.Installable {
			t.Fatalf("manual plugin row = %+v", row)
		}
		return
	}
	t.Fatalf("manual plugin missing from %s", output.String())
}

// TestPluginBundleInstall installs a plugin from a release archive: the bundle
// lands in DECX_HOME/modules/<id> and the CLI loads it from there, which is how
// a released CLI (whose archives carry no plugin files) runs plugins.
func TestPluginBundleInstall(t *testing.T) {
	t.Chdir(t.TempDir())
	bundle := zipArchive(t, map[string]string{
		"decx.json": `{"manifest":1,"kind":"plugin","id":"ard-framework","description":"test plugin","version":"1.2.3",` +
			`"entry":"dist/main.js",` +
			`"release":{"source":"repo","repository":"owner/bundles","tag":"ard-framework-v{version}","asset":"decx-ard-framework-plugin-{version}.zip","checksums":"SHA256SUMS"},` +
			`"commands":[{"name":"collect","about":"collect"}]}`,
		"VERSION": "1.2.3\n",
		"dist/main.js": `const { fs } = globalThis.decx;
globalThis.handle = function (request) {
    fs.writeFileSync(request.context.pluginDir + "/request.json", JSON.stringify(request));
    return { ok: true, data: { jarPath: "/tmp/bundle.jar" } };
};
`,
	})
	var base string
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/repos/owner/bundles/releases":
			_, _ = w.Write([]byte(`[{"tag_name":"ard-framework-v1.2.3","draft":false,"prerelease":false,"assets":[` +
				`{"name":"decx-ard-framework-plugin-1.2.3.zip","browser_download_url":"` + base + `/download/plugin.zip"}]}]`))
		case "/download/plugin.zip":
			_, _ = w.Write(bundle)
		case "/owner/bundles/releases/download/ard-framework-v1.2.3/SHA256SUMS":
			_, _ = fmt.Fprint(w, sumsBody("decx-ard-framework-plugin-1.2.3.zip", bundle))
		default:
			http.NotFound(w, r)
		}
	}))
	defer server.Close()
	base = server.URL

	home := t.TempDir()
	pluginDir := registry.ModuleRoot(home, "ard-framework")
	installManifest(t, pluginDir, registry.Manifest{
		Manifest:    1,
		Kind:        registry.KindPlugin,
		ID:          "ard-framework",
		Description: "test plugin",
		Entry:       "dist/main.js",
		Release: &registry.Install{
			Source:     "repo",
			Repository: "owner/bundles",
			Tag:        "ard-framework-v{version}",
			Asset:      "decx-ard-framework-plugin-{version}.zip",
			Checksums:  "SHA256SUMS",
		},
		Commands: []registry.Command{{Name: "collect", About: "collect"}},
	})
	var output bytes.Buffer
	a := App{Home: home, Out: &output, HTTP: server.Client(), GitHub: server.URL, GitHubAPI: server.URL}
	if err := a.Run(context.Background(), []string{"install", "--module", "ard-framework"}); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(filepath.Join(pluginDir, "dist", "main.js")); err != nil {
		t.Fatalf("bundle not installed: %v", err)
	}
	output.Reset()
	if err := a.Run(context.Background(), []string{"module", "list"}); err != nil {
		t.Fatal(err)
	}
	listed := output.String()
	for _, want := range []string{`"id":"ard-framework"`, `"installed":true`, `"installable":true`, `"version":"1.2.3"`, `"path":"` + pluginDir + `"`} {
		if !strings.Contains(listed, want) {
			t.Fatalf("module list missing %s: %s", want, listed)
		}
	}
	output.Reset()
	if err := a.Run(context.Background(), []string{"-m", "ard-framework", "collect"}); err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(output.String(), "/tmp/bundle.jar") {
		t.Fatalf("plugin did not run from DECX_HOME: %s", output.String())
	}
}

func TestServerFailureIsNotSuccess(t *testing.T) {
	for _, status := range []int{200, 500} {
		s := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			w.WriteHeader(status)
			_, _ = w.Write([]byte(`{"ok":false,"error":{"message":"failed"}}`))
		}))
		var out bytes.Buffer
		a := App{Out: &out, HTTP: s.Client()}
		if err := a.request(context.Background(), s.URL, map[string]any{}); err == nil {
			t.Fatal("failure reported as success")
		}
		if !strings.Contains(out.String(), "failed") {
			t.Fatal("error envelope lost")
		}
		s.Close()
	}
}

// zipArchive packs one release artifact. Every component artifact carries its
// decx.json manifest, which the installer validates before unpacking it.
func zipArchive(t *testing.T, files map[string]string) []byte {
	t.Helper()
	var buffer bytes.Buffer
	writer := zip.NewWriter(&buffer)
	for name, content := range files {
		entry, err := writer.Create(name)
		if err != nil {
			t.Fatal(err)
		}
		if _, err := entry.Write([]byte(content)); err != nil {
			t.Fatal(err)
		}
	}
	if err := writer.Close(); err != nil {
		t.Fatal(err)
	}
	return buffer.Bytes()
}

// sumsBody renders a SHA256SUMS body for one archive.
func sumsBody(name string, data []byte) string {
	sum := sha256.Sum256(data)
	return fmt.Sprintf("%s  %s\n", hex.EncodeToString(sum[:]), name)
}

// fakeSums lists asset names with a well-formed checksum; a skipped install
// never downloads the bytes, so they do not have to match.
func fakeSums(names ...string) string {
	var body strings.Builder
	for _, name := range names {
		fmt.Fprintf(&body, "%s  %s\n", strings.Repeat("0", 64), name)
	}
	return body.String()
}

// TestSelfInstallDownloadsModules installs a server and a plugin from their
// releases, keeps plugins opt-in, and makes `self update` a no-op for the
// versions that are already installed.
func TestSelfInstallDownloadsModules(t *testing.T) {
	t.Chdir(t.TempDir())
	moduleArchive := zipArchive(t, map[string]string{
		"decx.json": `{"manifest":1,"kind":"server","id":"jadx","description":"JADX server","version":"4.3.1",` +
			`"release":{"source":"repo","repository":"owner/modules","tag":"jadx-server-v{version}","asset":"jadx-server-{version}.zip","checksums":"SHA256SUMS"},` +
			`"binary":{"kind":"java-jar","path":"jadx-server.jar"},` +
			`"launch":{"command":["{binary}","{target}","--port","{port}"]},` +
			`"commands":[{"name":"classes","endpoint":"get_classes"}]}`,
		"jadx-server.jar": "server",
	})
	pluginArchive := zipArchive(t, map[string]string{
		"decx.json": `{"manifest":1,"kind":"plugin","id":"jadx-gui","description":"JADX GUI plugin","version":"4.3.1",` +
			`"entry":"index.js",` +
			`"release":{"source":"repo","repository":"owner/gui","tag":"jadx-gui-v{version}","asset":"jadx-gui-{version}.zip","checksums":"SHA256SUMS"},` +
			`"commands":[{"name":"collect","about":"collect"}]}`,
		"VERSION":  "4.3.1\n",
		"index.js": "globalThis.handle = () => ({ ok: true, data: {} });",
	})
	frameworkArchive := zipArchive(t, map[string]string{
		"decx.json": `{"manifest":1,"kind":"plugin","id":"ard-framework","description":"framework plugin","version":"4.3.1",` +
			`"entry":"index.js",` +
			`"release":{"source":"repo","repository":"owner/framework","tag":"ard-framework-v{version}","asset":"decx-ard-framework-plugin-{version}.zip","checksums":"SHA256SUMS"},` +
			`"commands":[{"name":"collect","about":"collect"}]}`,
		"VERSION":  "4.3.1\n",
		"index.js": "globalThis.handle = () => ({ ok: true, data: {} });",
	})
	ascArchive := zipArchive(t, map[string]string{
		"decx.json": `{"manifest":1,"kind":"server","id":"asc","description":"ASC server","version":"9.9.9",` +
			`"release":{"source":"repo","repository":"jygzyc/decx","tag":"asc-server-v{version}","asset":"asc-server-{version}.zip","checksums":"SHA256SUMS"},` +
			`"binary":{"kind":"program","path":"bin/asc-server"},` +
			`"launch":{"command":["{binary}","{target}","--port","{port}"]},` +
			`"commands":[{"name":"find-refs","endpoint":"find_refs"}]}`,
		"bin/asc-server": "#!/bin/sh\n",
	})
	kunaAsset := fmt.Sprintf("kuna-server-9.9.9-%s-%s.zip", runtime.GOOS, runtime.GOARCH)
	kunaArchive := zipArchive(t, map[string]string{
		"decx.json": `{"manifest":1,"kind":"server","id":"kuna","description":"Kuna server","version":"9.9.9",` +
			`"release":{"source":"repo","repository":"jygzyc/decx","tag":"kuna-server-v{version}","asset":"kuna-server-{version}-{os}-{arch}.zip","checksums":"SHA256SUMS"},` +
			`"binary":{"kind":"program","path":"bin/kuna-server"},` +
			`"launch":{"command":["{binary}","{target}","--port","{port}"]},` +
			`"commands":[{"name":"functions","endpoint":"get_functions"}]}`,
		"bin/kuna-server": "binary",
	})
	downloads := 0
	var base string
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/repos/owner/modules/releases":
			_, _ = w.Write([]byte(`[{"tag_name":"jadx-server-v4.3.1","draft":false,"prerelease":false,"assets":[` +
				`{"name":"jadx-server-4.3.1.zip","browser_download_url":"` + base + `/download/jadx-server-4.3.1.zip"}]}]`))
		case "/repos/owner/gui/releases":
			_, _ = w.Write([]byte(`[{"tag_name":"jadx-gui-v4.3.1","draft":false,"prerelease":false,"assets":[` +
				`{"name":"jadx-gui-4.3.1.zip","browser_download_url":"` + base + `/download/jadx-gui-4.3.1.zip"}]}]`))
		case "/repos/owner/framework/releases":
			_, _ = w.Write([]byte(`[{"tag_name":"ard-framework-v4.3.1","draft":false,"prerelease":false,"assets":[` +
				`{"name":"decx-ard-framework-plugin-4.3.1.zip","browser_download_url":"` + base + `/download/framework.zip"}]}]`))
		case "/repos/jygzyc/decx/releases":
			// The compiled-in table resolves the modules that are not present locally,
			// so a bare `decx install` also pulls asc and kuna from the default repo.
			_, _ = w.Write([]byte(`[{"tag_name":"asc-server-v9.9.9","draft":false,"prerelease":false,"assets":[` +
				`{"name":"asc-server-9.9.9.zip","browser_download_url":"` + base + `/download/asc.zip"}]},` +
				`{"tag_name":"kuna-server-v9.9.9","draft":false,"prerelease":false,"assets":[` +
				`{"name":"` + kunaAsset + `","browser_download_url":"` + base + `/download/kuna.zip"}]}]`))
		case "/download/jadx-server-4.3.1.zip":
			downloads++
			_, _ = w.Write(moduleArchive)
		case "/download/jadx-gui-4.3.1.zip":
			downloads++
			_, _ = w.Write(pluginArchive)
		case "/download/framework.zip":
			downloads++
			_, _ = w.Write(frameworkArchive)
		case "/download/asc.zip":
			downloads++
			_, _ = w.Write(ascArchive)
		case "/download/kuna.zip":
			downloads++
			_, _ = w.Write(kunaArchive)
		case "/owner/modules/releases/download/jadx-server-v4.3.1/SHA256SUMS":
			_, _ = fmt.Fprint(w, sumsBody("jadx-server-4.3.1.zip", moduleArchive))
		case "/owner/gui/releases/download/jadx-gui-v4.3.1/SHA256SUMS":
			_, _ = fmt.Fprint(w, sumsBody("jadx-gui-4.3.1.zip", pluginArchive))
		case "/owner/framework/releases/download/ard-framework-v4.3.1/SHA256SUMS":
			_, _ = fmt.Fprint(w, sumsBody("decx-ard-framework-plugin-4.3.1.zip", frameworkArchive))
		case "/jygzyc/decx/releases/download/asc-server-v9.9.9/SHA256SUMS":
			_, _ = fmt.Fprint(w, sumsBody("asc-server-9.9.9.zip", ascArchive))
		case "/jygzyc/decx/releases/download/kuna-server-v9.9.9/SHA256SUMS":
			_, _ = fmt.Fprint(w, sumsBody(kunaAsset, kunaArchive))
		default:
			http.NotFound(w, r)
		}
	}))
	defer server.Close()
	base = server.URL

	home := t.TempDir()
	installManifest(t, registry.ModuleRoot(home, "jadx"), registry.Manifest{
		Manifest:    1,
		Kind:        registry.KindServer,
		ID:          "jadx",
		Description: "JADX server",
		Binary:      &registry.Binary{Kind: "java-jar", Path: "jadx-server.jar"},
		Launch:      &registry.Launch{Command: []string{"{binary}", "{target}", "--port", "{port}"}},
		Release: &registry.Install{
			Source:     "repo",
			Repository: "owner/modules",
			Tag:        "jadx-server-v{version}",
			Asset:      "jadx-server-{version}.zip",
			Checksums:  "SHA256SUMS",
		},
		Commands: []registry.Command{{Name: "classes", Endpoint: "get_classes"}},
	})
	installManifest(t, registry.ModuleRoot(home, "jadx-gui"), registry.Manifest{
		Manifest:    1,
		Kind:        registry.KindPlugin,
		ID:          "jadx-gui",
		Description: "JADX GUI plugin",
		Entry:       "index.js",
		Release: &registry.Install{
			Source:     "repo",
			Repository: "owner/gui",
			Tag:        "jadx-gui-v{version}",
			Asset:      "jadx-gui-{version}.zip",
			Checksums:  "SHA256SUMS",
		},
		Commands: []registry.Command{{Name: "collect", About: "collect"}},
	})
	installManifest(t, registry.ModuleRoot(home, "ard-framework"), registry.Manifest{
		Manifest:    1,
		Kind:        registry.KindPlugin,
		ID:          "ard-framework",
		Description: "framework plugin",
		Entry:       "index.js",
		Release: &registry.Install{
			Source:     "repo",
			Repository: "owner/framework",
			Tag:        "ard-framework-v{version}",
			Asset:      "decx-ard-framework-plugin-{version}.zip",
			Checksums:  "SHA256SUMS",
		},
		Commands: []registry.Command{{Name: "collect", About: "collect"}},
	})
	var out bytes.Buffer
	a := App{Home: home, Out: &out, HTTP: server.Client(), GitHub: server.URL, GitHubAPI: server.URL}
	if err := a.Run(context.Background(), []string{"install"}); err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(out.String(), `"installed":true`) {
		t.Fatal(out.String())
	}
	if _, err := os.Stat(filepath.Join(home, "modules", "jadx", "jadx-server.jar")); err != nil {
		t.Fatal(err)
	}
	// The single module root replaces the old bin/ and plugins/ roots.
	for _, legacy := range []string{"bin", "plugins"} {
		if _, err := os.Stat(filepath.Join(home, legacy)); !os.IsNotExist(err) {
			t.Fatalf("legacy %s root exists: %v", legacy, err)
		}
	}
	// A bare install takes every module that can be fetched: the three local
	// ones and the asc/kuna entries of the compiled-in table.
	for _, want := range []struct{ id, artifact string }{
		{"jadx", "jadx-server.jar"},
		{"jadx-gui", "index.js"},
		{"ard-framework", "index.js"},
		{"asc", filepath.Join("bin", "asc-server")},
		{"kuna", filepath.Join("bin", "kuna-server")},
	} {
		if _, err := os.Stat(filepath.Join(home, "modules", want.id, want.artifact)); err != nil {
			t.Fatalf("%s: %v", want.id, err)
		}
	}
	if downloads != 5 {
		t.Fatalf("downloads = %d", downloads)
	}
	// A named install refreshes one module on demand.
	out.Reset()
	if err := a.Run(context.Background(), []string{"install", "--module", "jadx-gui", "--force"}); err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(out.String(), `"modules":[{"id":"jadx-gui","installed":true`) {
		t.Fatal(out.String())
	}
	if downloads != 6 {
		t.Fatalf("downloads = %d", downloads)
	}
	// `self update` keeps the current artifacts and does not download again.
	out.Reset()
	if err := a.Run(context.Background(), []string{"self", "update"}); err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(out.String(), `"version":"4.3.1"`) {
		t.Fatal(out.String())
	}
	if downloads != 6 {
		t.Fatalf("downloads = %d", downloads)
	}
	// `module list` reports servers and plugins in one listing.
	out.Reset()
	if err := a.Run(context.Background(), []string{"module", "list"}); err != nil {
		t.Fatal(err)
	}
	listed := out.String()
	for _, want := range []string{`"id":"jadx"`, `"id":"jadx-gui"`, `"id":"ard-framework"`, `"id":"asc"`, `"id":"kuna"`, `"kind":"server"`, `"kind":"plugin"`, `"version":"4.3.1"`, `"version":"9.9.9"`, `"installable":true`} {
		if !strings.Contains(listed, want) {
			t.Fatalf("module list missing %s: %s", want, listed)
		}
	}
}

// TestSelectComponents covers the install selection rules directly: a plain
// install takes the default markers, --all every installable component, names
// resolve explicitly, and self update only refreshes what is present and
// refreshable.
func TestSelectComponents(t *testing.T) {
	release := &registry.Install{Source: "repo", Repository: "owner/repo", Tag: "demo-v{version}", Asset: "demo-{version}.zip"}
	home := t.TempDir()
	running := registry.ModuleRoot(home, "running")
	if err := os.MkdirAll(running, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(running, "running-server"), []byte("#!/bin/sh\n"), 0o755); err != nil {
		t.Fatal(err)
	}
	installed := registry.ModuleRoot(home, "installed")
	if err := os.MkdirAll(installed, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(installed, "installed-server"), []byte("#!/bin/sh\n"), 0o755); err != nil {
		t.Fatal(err)
	}
	config := &registry.Config{
		Modules: []registry.Module{
			{ID: "defaulted", Default: true, Release: release},
			{ID: "optional", Release: release},
			{ID: "manual"},
			{ID: "running", Release: release, Root: running, Binary: registry.Binary{Kind: "program", Path: "running-server"}},
			{ID: "installed", Root: installed, Binary: registry.Binary{Kind: "program", Path: "installed-server"}},
		},
		Plugins: []registry.Plugin{
			{ID: "default-plugin", Default: true, Release: release},
			{ID: "installed-plugin", Release: release, Installed: true},
			{ID: "manual-plugin"},
		},
	}
	parse := func(input ...string) map[string][]string {
		t.Helper()
		args, err := registry.ParseArgs(moduleArgs, input)
		if err != nil {
			t.Fatal(err)
		}
		return args
	}
	ids := func(plans []modulePlan) []string {
		out := make([]string, 0, len(plans))
		for _, plan := range plans {
			out = append(out, plan.id)
		}
		return out
	}

	plans, err := selectModules(home, config, parse(), false)
	if err != nil {
		t.Fatal(err)
	}
	if got := strings.Join(ids(plans), ","); got != "defaulted,optional,running,default-plugin,installed-plugin" {
		t.Fatalf("bare install modules = %v", got)
	}
	if got := ids(mustSelectModules(t, home, config, parse("--all"), false)); len(got) != 5 {
		t.Fatalf("--all modules = %v", got)
	}
	if got := ids(mustSelectModules(t, home, config, parse("--module", "optional"), false)); len(got) != 1 || got[0] != "optional" {
		t.Fatalf("named module = %v", got)
	}
	if _, err := selectModules(home, config, parse("--module", "absent"), false); err == nil || !strings.Contains(err.Error(), "unknown module") {
		t.Fatalf("unknown module err = %v", err)
	}
	if _, err := selectModules(home, config, parse("--module", "manual"), false); err == nil || !strings.Contains(err.Error(), "install source") {
		t.Fatalf("manual module err = %v", err)
	}
	if _, err := selectModules(home, config, parse("--module", "manual-plugin"), false); err == nil || !strings.Contains(err.Error(), "install source") {
		t.Fatalf("manual plugin err = %v", err)
	}

	// An update refreshes what is present and refreshable: resolvable servers
	// with a release source and attached plugins with one; the installed server
	// without a release block stays out.
	if got := ids(mustSelectModules(t, home, config, parse(), true)); len(got) != 2 || got[0] != "running" || got[1] != "installed-plugin" {
		t.Fatalf("update modules = %v", got)
	}
	empty, err := selectModules(t.TempDir(), &registry.Config{}, parse(), true)
	if err != nil {
		t.Fatal(err)
	}
	if len(empty) != 0 {
		t.Fatalf("empty update modules = %v", empty)
	}
}

func mustSelectModules(t *testing.T, home string, config *registry.Config, args map[string][]string, update bool) []modulePlan {
	t.Helper()
	plans, err := selectModules(home, config, args, update)
	if err != nil {
		t.Fatal(err)
	}
	return plans
}

// TestInstallModuleClassification pins down how a --module source is classified:
// known or installed ids install from their release block, owner/repo sources
// are imports, and existing paths are local imports.
func TestInstallModuleClassification(t *testing.T) {
	release := &registry.Install{Source: "repo", Repository: "owner/repo", Tag: "demo-v{version}", Asset: "demo-{version}.zip"}
	config := &registry.Config{
		Modules: []registry.Module{
			{ID: "jadx", Default: true, Release: release},
			{ID: "manual"},
		},
		Plugins: []registry.Plugin{{ID: "ard-framework", Default: true, Release: release}},
	}
	parse := func(input ...string) map[string][]string {
		t.Helper()
		args, err := registry.ParseArgs(moduleArgs, input)
		if err != nil {
			t.Fatal(err)
		}
		return args
	}
	plans, err := selectModules(t.TempDir(), config, parse("--module", "jadx"), false)
	if err != nil {
		t.Fatal(err)
	}
	if len(plans) != 1 || plans[0].spec == nil || plans[0].id != "jadx" {
		t.Fatalf("id plan = %+v", plans)
	}
	for _, source := range []string{"owner/repo", "owner/repo@dev", "github.com/owner/repo", "https://example.com/owner/repo"} {
		plans, err := selectModules(t.TempDir(), config, parse("--module", source), false)
		if err != nil {
			t.Fatalf("%s: %v", source, err)
		}
		if len(plans) != 1 || plans[0].spec != nil || plans[0].path || plans[0].value != source {
			t.Fatalf("%s plan = %+v", source, plans)
		}
	}
	dir := t.TempDir()
	archive := filepath.Join(t.TempDir(), "module.zip")
	if err := os.WriteFile(archive, zipArchive(t, map[string]string{"decx.json": "{}"}), 0o644); err != nil {
		t.Fatal(err)
	}
	for _, source := range []string{dir, archive} {
		plans, err := selectModules(t.TempDir(), config, parse("--module", source), false)
		if err != nil {
			t.Fatalf("%s: %v", source, err)
		}
		if len(plans) != 1 || !plans[0].path || plans[0].value != source {
			t.Fatalf("%s plan = %+v", source, plans)
		}
	}
	if _, err := selectModules(t.TempDir(), config, parse("--module", "absent"), false); err == nil || !strings.Contains(err.Error(), "unknown module") {
		t.Fatalf("unknown module err = %v", err)
	}
	if _, err := selectModules(t.TempDir(), config, parse("--module", "manual"), false); err == nil || !strings.Contains(err.Error(), "install source") {
		t.Fatalf("manual module err = %v", err)
	}
}

// TestModuleListMergesKinds checks the single `module list` listing: one row per
// module with its kind, install state, version and recorded source.
func TestModuleListMergesKinds(t *testing.T) {
	t.Chdir(t.TempDir())
	home := t.TempDir()
	serverDir := registry.ModuleRoot(home, "analysis")
	installManifest(t, serverDir, queryModule("analysis"))
	if err := os.WriteFile(filepath.Join(serverDir, "analysis-server"), []byte("server"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := registry.WriteVersion(serverDir, "1.2.3"); err != nil {
		t.Fatal(err)
	}
	pluginDir := registry.ModuleRoot(home, "workflow")
	installManifest(t, pluginDir, registry.Manifest{
		Manifest:    1,
		Kind:        registry.KindPlugin,
		ID:          "workflow",
		Description: "workflow plugin",
		Version:     "9.9.9",
		Entry:       "main.js",
		Commands:    []registry.Command{{Name: "run", About: "run"}},
	})
	if err := os.WriteFile(filepath.Join(pluginDir, "main.js"), []byte("globalThis.handle = () => ({ ok: true, data: {} });"), 0o644); err != nil {
		t.Fatal(err)
	}
	out := &bytes.Buffer{}
	a := App{Home: home, Out: out, Err: &bytes.Buffer{}, HTTP: http.DefaultClient}
	if err := a.Run(context.Background(), []string{"module", "list"}); err != nil {
		t.Fatal(err)
	}
	var rows []moduleView
	if err := json.Unmarshal(out.Bytes(), &rows); err != nil {
		t.Fatal(err)
	}
	byID := map[string]moduleView{}
	for _, row := range rows {
		byID[row.ID] = row
	}
	if row := byID["analysis"]; row.Kind != registry.KindServer || !row.Installed || row.Path != filepath.Join(serverDir, "analysis-server") || row.Version != "1.2.3" || row.Installable {
		t.Fatalf("analysis row = %+v", row)
	}
	if row := byID["workflow"]; row.Kind != registry.KindPlugin || !row.Installed || row.Path != pluginDir || row.Version != "9.9.9" || row.Installable {
		t.Fatalf("workflow row = %+v", row)
	}
	// The compiled-in known table fills in the defaults that are not installed.
	if row := byID["jadx"]; row.Kind != registry.KindServer || row.Installed || !row.Default || !row.Installable {
		t.Fatalf("jadx row = %+v", row)
	}
	for i := 1; i < len(rows); i++ {
		if rows[i-1].ID > rows[i].ID {
			t.Fatalf("rows are not sorted: %s before %s", rows[i-1].ID, rows[i].ID)
		}
	}
}

// TestModuleFlagRoutesServerAndPlugin checks the `decx -m <module>` selector:
// both kinds route to their execution path, a bare selector prints the module's
// command list, and unknown or not-installed modules are reported.
func TestModuleFlagRoutesServerAndPlugin(t *testing.T) {
	t.Chdir(t.TempDir())
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/api/decx/query" {
			t.Errorf("wrong route %s", r.URL.Path)
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"ok":true,"items":["routed server response"]}`))
	}))
	defer server.Close()
	_, port, _ := net.SplitHostPort(strings.TrimPrefix(server.URL, "http://"))
	home := t.TempDir()
	installManifest(t, registry.ModuleRoot(home, "analysis"), queryModule("analysis"))
	toolDir := registry.ModuleRoot(home, "tool")
	installManifest(t, toolDir, registry.Manifest{
		Manifest:    1,
		Kind:        registry.KindPlugin,
		ID:          "tool",
		Description: "tool plugin",
		Entry:       "main.js",
		Commands:    []registry.Command{{Name: "collect", About: "collect"}},
	})
	if err := os.WriteFile(filepath.Join(toolDir, "main.js"),
		[]byte("globalThis.handle = () => ({ ok: true, data: { marker: \"tool-response\" } });"), 0o644); err != nil {
		t.Fatal(err)
	}
	out := &bytes.Buffer{}
	a := App{Home: home, Out: out, Err: &bytes.Buffer{}, HTTP: server.Client()}
	if err := a.Run(context.Background(), []string{"-m", "analysis", "query", "hi", "--port", port}); err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(out.String(), "routed server response") {
		t.Fatalf("server routing = %s", out.String())
	}
	out.Reset()
	if err := a.Run(context.Background(), []string{"--module", "tool", "collect"}); err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(out.String(), "tool-response") {
		t.Fatalf("plugin routing = %s", out.String())
	}
	// A bare selector prints the module command list.
	out.Reset()
	if err := a.Run(context.Background(), []string{"-m", "analysis"}); err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(out.String(), "Usage: decx -m analysis <command>") || !strings.Contains(out.String(), "query") {
		t.Fatalf("module help = %s", out.String())
	}
	out.Reset()
	if err := a.Run(context.Background(), []string{"-m", "tool"}); err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(out.String(), "Usage: decx -m tool <command>") || !strings.Contains(out.String(), "collect") {
		t.Fatalf("module help = %s", out.String())
	}
	out.Reset()
	if err := a.Run(context.Background(), []string{"-m", "tool", "collect", "--help"}); err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(out.String(), "Usage: decx -m tool collect [arguments]") {
		t.Fatalf("command help = %s", out.String())
	}
	if err := a.Run(context.Background(), []string{"-m", "absent"}); err == nil || !strings.Contains(err.Error(), `unknown module "absent"`) {
		t.Fatalf("unknown module err = %v", err)
	}
	// The known table registers jadx even when it is not installed.
	if err := a.Run(context.Background(), []string{"-m", "jadx"}); err == nil || !strings.Contains(err.Error(), "module jadx is not installed; run `decx install --module jadx`") {
		t.Fatalf("not-installed err = %v", err)
	}
}

// TestRepositoryImportFromFakeHost imports modules from repository archives:
// the default branch is resolved through the GitHub client, the archive is
// downloaded from the host, the origin is recorded, and self update re-imports
// from it without resolving the branch again.
func TestRepositoryImportFromFakeHost(t *testing.T) {
	t.Chdir(t.TempDir())
	zipArchiveBody := zipArchive(t, map[string]string{
		"decx.json": `{"manifest":1,"kind":"plugin","id":"repo-tool","version":"1.0.0","entry":"main.js",` +
			`"commands":[{"name":"run","about":"run"}]}`,
		"VERSION": "1.0.0\n",
		"main.js": "globalThis.handle = () => ({ ok: true, data: { marker: \"repo-import\" } });",
	})
	tarred := tarGzFiles(t, map[string]string{
		"decx.json": `{"manifest":1,"kind":"plugin","id":"repo-tarred","version":"2.0.0","entry":"main.js",` +
			`"commands":[{"name":"run","about":"run"}]}`,
		"main.js": "globalThis.handle = () => ({ ok: true, data: {} });",
	})
	branches, archives := 0, 0
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/repos/owner/tool":
			branches++
			_, _ = w.Write([]byte(`{"default_branch":"main"}`))
		case "/repos/owner/tarred":
			branches++
			_, _ = w.Write([]byte(`{"default_branch":"trunk"}`))
		case "/owner/tool/archive/refs/heads/main.zip":
			archives++
			_, _ = w.Write(zipArchiveBody)
		case "/owner/tarred/archive/refs/heads/trunk.zip":
			http.NotFound(w, r)
		case "/owner/tarred/archive/trunk.tar.gz":
			archives++
			_, _ = w.Write(tarred)
		default:
			http.NotFound(w, r)
		}
	}))
	defer server.Close()

	home := t.TempDir()
	out := &bytes.Buffer{}
	a := App{Home: home, Out: out, Err: &bytes.Buffer{}, HTTP: server.Client(), GitHub: server.URL, GitHubAPI: server.URL}
	if err := a.Run(context.Background(), []string{"install", "--module", "owner/tool"}); err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(out.String(), `"id":"repo-tool"`) {
		t.Fatalf("import output = %s", out.String())
	}
	root := registry.ModuleRoot(home, "repo-tool")
	if _, err := os.Stat(filepath.Join(root, "main.js")); err != nil {
		t.Fatal(err)
	}
	source, err := registry.ReadSource(root)
	if err != nil || source == nil {
		t.Fatalf("source = %v err = %v", source, err)
	}
	if source.Source != "repo" || source.Value != "owner/tool" || source.Ref != "main" || source.Installed == "" {
		t.Fatalf("source = %+v", source)
	}
	// The imported module runs and its origin shows up in the listing.
	out.Reset()
	if err := a.Run(context.Background(), []string{"-m", "repo-tool", "run"}); err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(out.String(), "repo-import") {
		t.Fatalf("import run = %s", out.String())
	}
	out.Reset()
	if err := a.Run(context.Background(), []string{"module", "list"}); err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(out.String(), `"id":"repo-tool"`) || !strings.Contains(out.String(), `"source":"owner/tool@main"`) {
		t.Fatalf("module list = %s", out.String())
	}
	// self update re-imports from the recorded origin, pinned to the recorded ref.
	if err := a.Run(context.Background(), []string{"self", "update", "--module", "repo-tool"}); err != nil {
		t.Fatal(err)
	}
	if archives != 2 {
		t.Fatalf("archives = %d", archives)
	}
	if branches != 1 {
		t.Fatalf("default branch was resolved again: %d", branches)
	}
	// A host that only publishes the generic tar.gz fallback is still importable.
	if err := a.Run(context.Background(), []string{"install", "--module", "owner/tarred"}); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(filepath.Join(registry.ModuleRoot(home, "repo-tarred"), "main.js")); err != nil {
		t.Fatal(err)
	}
	if archives != 3 {
		t.Fatalf("archives = %d", archives)
	}
}

// TestDirectoryAndArchiveImport imports modules from a local directory and from
// an archive: the skip list keeps build junk out, the VERSION file wins over
// the manifest, and self update re-imports from the recorded path.
func TestDirectoryAndArchiveImport(t *testing.T) {
	t.Chdir(t.TempDir())
	home := t.TempDir()
	source := t.TempDir()
	writeFile := func(name, content string) {
		t.Helper()
		path := filepath.Join(source, filepath.FromSlash(name))
		if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(path, []byte(content), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	writeFile("decx.json", `{"manifest":1,"kind":"plugin","id":"imported-dir","version":"1.0.0","entry":"main.js",`+
		`"commands":[{"name":"run","about":"run"}]}`)
	writeFile("main.js", "globalThis.handle = () => ({ ok: true, data: {} });")
	writeFile("VERSION", "2.0.0\n")
	for _, skipped := range []string{".git/config", "node_modules/pkg/index.js", "__pycache__/x.pyc", ".build/obj", ".DS_Store"} {
		writeFile(skipped, "junk")
	}
	out := &bytes.Buffer{}
	a := App{Home: home, Out: out, Err: &bytes.Buffer{}, HTTP: http.DefaultClient}
	if err := a.Run(context.Background(), []string{"install", "--module", source}); err != nil {
		t.Fatal(err)
	}
	root := registry.ModuleRoot(home, "imported-dir")
	if _, err := os.Stat(filepath.Join(root, "decx.json")); err != nil {
		t.Fatal(err)
	}
	if got := registry.ReadVersion(root); got != "2.0.0" {
		t.Fatalf("version = %q", got)
	}
	for _, skipped := range []string{".git", "node_modules", "__pycache__", ".build", ".DS_Store"} {
		if _, err := os.Stat(filepath.Join(root, skipped)); !os.IsNotExist(err) {
			t.Fatalf("skip list kept %s: %v", skipped, err)
		}
	}
	sourceRecord, err := registry.ReadSource(root)
	if err != nil || sourceRecord == nil {
		t.Fatalf("source = %v err = %v", sourceRecord, err)
	}
	if sourceRecord.Source != "path" || sourceRecord.Value != source {
		t.Fatalf("source = %+v", sourceRecord)
	}
	// self update re-imports from the recorded path.
	writeFile("VERSION", "2.1.0\n")
	writeFile("extra.txt", "added later")
	if err := a.Run(context.Background(), []string{"self", "update", "--module", "imported-dir"}); err != nil {
		t.Fatal(err)
	}
	if got := registry.ReadVersion(root); got != "2.1.0" {
		t.Fatalf("updated version = %q", got)
	}
	if _, err := os.Stat(filepath.Join(root, "extra.txt")); err != nil {
		t.Fatal(err)
	}

	// An archive with a single top-level directory imports that directory; the
	// manifest version is the fallback when the archive carries no VERSION.
	archiveBody := zipArchive(t, map[string]string{
		"imported-zip-1.0.0/decx.json": `{"manifest":1,"kind":"plugin","id":"imported-zip","version":"3.0.0","entry":"main.js",` +
			`"commands":[{"name":"run","about":"run"}]}`,
		"imported-zip-1.0.0/main.js": "globalThis.handle = () => ({ ok: true, data: {} });",
	})
	archivePath := filepath.Join(t.TempDir(), "imported-zip.zip")
	if err := os.WriteFile(archivePath, archiveBody, 0o644); err != nil {
		t.Fatal(err)
	}
	if err := a.Run(context.Background(), []string{"install", "--module", archivePath}); err != nil {
		t.Fatal(err)
	}
	zipRoot := registry.ModuleRoot(home, "imported-zip")
	if _, err := os.Stat(filepath.Join(zipRoot, "main.js")); err != nil {
		t.Fatal(err)
	}
	if got := registry.ReadVersion(zipRoot); got != "3.0.0" {
		t.Fatalf("archive version = %q", got)
	}
	archiveRecord, err := registry.ReadSource(zipRoot)
	if err != nil || archiveRecord == nil {
		t.Fatalf("archive source = %v err = %v", archiveRecord, err)
	}
	if archiveRecord.Source != "path" || archiveRecord.Value != archivePath {
		t.Fatalf("archive source = %+v", archiveRecord)
	}
}

func TestSelfInstallSelectionErrors(t *testing.T) {
	t.Chdir(t.TempDir())
	home := t.TempDir()
	// A manually managed module carries no release block, so it cannot be
	// downloaded and only shows up as not installable.
	installManifest(t, registry.ModuleRoot(home, "manual"), registry.Manifest{
		Manifest:    1,
		Kind:        registry.KindServer,
		ID:          "manual",
		Description: "manually managed server",
		Binary:      &registry.Binary{Kind: "java-jar", Path: "manual-server.jar"},
		Launch:      &registry.Launch{Command: []string{"{binary}", "{target}", "--port", "{port}"}},
		Commands:    []registry.Command{{Name: "classes", Endpoint: "get_classes"}},
	})
	a := App{Home: home, Out: &bytes.Buffer{}, Err: &bytes.Buffer{}, HTTP: http.DefaultClient}
	// The empty-selection guard cannot be reached through `decx install` any
	// more (the shipped table always marks jadx as a default), so it is
	// exercised directly against an empty registry.
	if err := a.installComponents(context.Background(), &registry.Config{}, nil, false); err == nil || !strings.Contains(err.Error(), "nothing to install") {
		t.Fatalf("err = %v", err)
	}
	// A discovered module without a release block cannot be downloaded (the
	// shipped components always carry one through their known placeholder).
	if err := a.Run(context.Background(), []string{"install", "--module", "manual"}); err == nil || !strings.Contains(err.Error(), "does not declare an install source") {
		t.Fatalf("err = %v", err)
	}
	if err := a.Run(context.Background(), []string{"install", "--module", "absent"}); err == nil || !strings.Contains(err.Error(), "unknown module") {
		t.Fatalf("err = %v", err)
	}
	// Explicit selection errors survive --cli: a typo must not be hidden by the
	// CLI update path.
	if err := a.Run(context.Background(), []string{"self", "update", "--cli", "--module", "absent"}); err == nil || !strings.Contains(err.Error(), "unknown module") {
		t.Fatalf("err = %v", err)
	}
	// The isolated home holds no refreshable modules, so self update has nothing
	// to do.
	if err := a.Run(context.Background(), []string{"self", "update"}); err == nil || !strings.Contains(err.Error(), "nothing to update") {
		t.Fatalf("err = %v", err)
	}
}

// TestPluginInstallsWithoutDefaultModule installs one named plugin without
// touching the old module root, so a plugin-only setup does not need a module.
// `self update --module` is the module-less path.
func TestPluginInstallsWithoutDefaultModule(t *testing.T) {
	t.Chdir(t.TempDir())
	bundle := zipArchive(t, map[string]string{
		"decx.json": `{"manifest":1,"kind":"plugin","id":"sample-plugin","description":"Framework workflows","version":"4.3.1",` +
			`"entry":"index.js",` +
			`"release":{"source":"repo","repository":"owner/plugins","tag":"sample-plugin-v{version}","asset":"sample-plugin-{version}.zip","checksums":"SHA256SUMS"},` +
			`"commands":[{"name":"collect","about":"collect"}]}`,
		"VERSION":  "4.3.1\n",
		"index.js": "globalThis.handle = () => ({ ok: true, data: {} });",
	})
	var base string
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/repos/owner/plugins/releases":
			_, _ = w.Write([]byte(`[{"tag_name":"sample-plugin-v4.3.1","draft":false,"prerelease":false,"assets":[` +
				`{"name":"sample-plugin-4.3.1.zip","browser_download_url":"` + base + `/download/sample-plugin-4.3.1.zip"}]}]`))
		case "/download/sample-plugin-4.3.1.zip":
			_, _ = w.Write(bundle)
		case "/owner/plugins/releases/download/sample-plugin-v4.3.1/SHA256SUMS":
			_, _ = fmt.Fprint(w, sumsBody("sample-plugin-4.3.1.zip", bundle))
		default:
			http.NotFound(w, r)
		}
	}))
	defer server.Close()
	base = server.URL

	home := t.TempDir()
	pluginDir := registry.ModuleRoot(home, "sample-plugin")
	installManifest(t, pluginDir, registry.Manifest{
		Manifest:    1,
		Kind:        registry.KindPlugin,
		ID:          "sample-plugin",
		Description: "Framework workflows",
		Entry:       "index.js",
		Release: &registry.Install{
			Source:     "repo",
			Repository: "owner/plugins",
			Tag:        "sample-plugin-v{version}",
			Asset:      "sample-plugin-{version}.zip",
			Checksums:  "SHA256SUMS",
		},
		Commands: []registry.Command{{Name: "collect", About: "collect"}},
	})
	var out bytes.Buffer
	a := App{Home: home, Out: &out, HTTP: server.Client(), GitHub: server.URL, GitHubAPI: server.URL}
	if err := a.Run(context.Background(), []string{"self", "update", "--module", "sample-plugin"}); err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(out.String(), `"modules":[{"id":"sample-plugin","installed":true`) {
		t.Fatal(out.String())
	}
	if _, err := os.Stat(filepath.Join(pluginDir, "index.js")); err != nil {
		t.Fatalf("plugin not installed: %v", err)
	}
	for _, legacy := range []string{"bin", "plugins"} {
		if _, err := os.Stat(filepath.Join(home, legacy)); !os.IsNotExist(err) {
			t.Fatalf("plugin-only install touched the %s root: %v", legacy, err)
		}
	}
}

func TestListCommandsAndUnknownSubcommands(t *testing.T) {
	home := t.TempDir()
	installManifest(t, registry.ModuleRoot(home, "jadx"), registry.Manifest{
		Manifest:    1,
		Kind:        registry.KindServer,
		ID:          "jadx",
		Description: "JADX server",
		Binary:      &registry.Binary{Kind: "java-jar", Path: "jadx-server.jar"},
		Launch:      &registry.Launch{Command: []string{"{binary}", "{target}", "--port", "{port}"}},
		Commands:    []registry.Command{{Name: "classes", Endpoint: "get_classes"}},
	})
	installManifest(t, registry.ModuleRoot(home, "jadx-gui"), registry.Manifest{
		Manifest:    1,
		Kind:        registry.KindPlugin,
		ID:          "jadx-gui",
		Description: "JADX GUI plugin",
		Entry:       "index.js",
		Commands:    []registry.Command{{Name: "collect", About: "collect"}},
	})
	out := &bytes.Buffer{}
	a := App{Home: home, Out: out, Err: &bytes.Buffer{}, HTTP: http.DefaultClient}
	for _, list := range []struct {
		args []string
		want string
	}{
		{[]string{"module", "list"}, `"id":"jadx"`},
		{[]string{"install", "help"}, "Usage: decx install"},
		{[]string{"self", "update", "--help"}, "Usage: decx self update"},
		{[]string{"help"}, "Usage: decx"},
		{[]string{"-h"}, "Usage: decx"},
		{[]string{"-m", "jadx", "help"}, "Usage: decx -m jadx <command>"},
		{[]string{"self", "help"}, "Usage: decx self <command>"},
	} {
		out.Reset()
		if err := a.Run(context.Background(), list.args); err != nil {
			t.Fatal(err)
		}
		if !strings.Contains(out.String(), list.want) {
			t.Fatalf("%v = %s", list.args, out.String())
		}
	}
	// `self update --help` prints the update usage, including its --cli flag.
	out.Reset()
	if err := a.Run(context.Background(), []string{"self", "update", "-h"}); err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(out.String(), "--cli") {
		t.Fatalf("self update help = %s", out.String())
	}
	for _, bad := range []struct {
		args []string
		want string
	}{
		{[]string{"module"}, "module requires a subcommand"},
		{[]string{"module", "run"}, `unknown module subcommand "run"`},
		{[]string{"plugin", "list"}, `unknown command "plugin"`},
		{[]string{"--plugin", "jadx-gui", "collect"}, `unknown command "--plugin"`},
		{[]string{"absent"}, `unknown command "absent"`},
	} {
		err := a.Run(context.Background(), bad.args)
		if err == nil || !strings.Contains(err.Error(), bad.want) {
			t.Fatalf("%v err = %v", bad.args, err)
		}
	}
	if err := a.Run(context.Background(), []string{"install", "--module", "absent"}); err == nil || !strings.Contains(err.Error(), "unknown module") {
		t.Fatalf("err = %v", err)
	}
}

func TestSelfSkillsInstall(t *testing.T) {
	home := t.TempDir()
	userHome := t.TempDir()
	source := t.TempDir()
	skill := filepath.Join(source, "decx-cli")
	if err := os.MkdirAll(skill, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(skill, "SKILL.md"), []byte("# decx-cli"), 0o644); err != nil {
		t.Fatal(err)
	}
	out := &bytes.Buffer{}
	a := App{Home: home, UserHome: userHome, SkillsSource: source, Out: out, HTTP: http.DefaultClient}
	if err := a.Run(context.Background(), []string{"self", "skills", "install", "--client", "codex"}); err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(out.String(), `"sourcePath"`) || !strings.Contains(out.String(), "decx-cli") {
		t.Fatalf("out = %s", out.String())
	}
	if _, err := os.Readlink(filepath.Join(userHome, ".codex", "skills", "decx-cli")); err != nil {
		t.Fatal(err)
	}
	if err := a.Run(context.Background(), []string{"self", "skills", "absent"}); err == nil || !strings.Contains(err.Error(), "unknown command self skills") {
		t.Fatalf("err = %v", err)
	}
}

func TestSelfUpdateCLIReplacesExecutable(t *testing.T) {
	const version = "9.9.9"
	if runtime.GOOS == "windows" {
		t.Skip("the stand-in executable is replaced with the archive contents; covered by the Unix path")
	}
	name := fmt.Sprintf("decx-cli-%s-%s-%s.tar.gz", version, runtime.GOOS, runtime.GOARCH)
	archive := tarGz(t, "decx", []byte("new-binary"))
	sum := sha256.Sum256(archive)
	sumsPath := "/jygzyc/decx/releases/download/v" + version + "/SHA256SUMS"
	var base string
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/repos/jygzyc/decx/releases":
			_, _ = w.Write([]byte(`[{"tag_name":"v` + version + `","draft":false,"prerelease":false,"assets":[` +
				`{"name":"` + name + `","browser_download_url":"` + base + `/download/cli"}]}]`))
		case "/download/cli":
			_, _ = w.Write(archive)
		case sumsPath:
			_, _ = fmt.Fprintf(w, "%s  %s\n", hex.EncodeToString(sum[:]), name)
		default:
			http.NotFound(w, r)
		}
	}))
	defer server.Close()
	base = server.URL
	// The update selection only considers components that are actually
	// installed, so stay outside the source checkout.
	t.Chdir(t.TempDir())
	home := t.TempDir()
	target := filepath.Join(t.TempDir(), "decx")
	if err := os.WriteFile(target, []byte("old-binary"), 0o755); err != nil {
		t.Fatal(err)
	}
	out := &bytes.Buffer{}
	a := App{Home: home, Out: out, HTTP: server.Client(), GitHub: server.URL, GitHubAPI: server.URL,
		Version: "1.0.0", CLIExecutable: target}
	if err := a.Run(context.Background(), []string{"self", "update", "--cli"}); err != nil {
		t.Fatal(err)
	}
	body, err := os.ReadFile(target)
	if err != nil {
		t.Fatal(err)
	}
	if string(body) != "new-binary" {
		t.Fatalf("executable = %q", body)
	}
	if !strings.Contains(out.String(), `"cli":{"id":"decx-cli","updated":true,"version":"9.9.9"`) {
		t.Fatalf("out = %s", out.String())
	}
	// `install --cli` replaces the executable through the same path.
	out.Reset()
	if err := a.Run(context.Background(), []string{"install", "--cli"}); err != nil {
		t.Fatal(err)
	}
	if body, err := os.ReadFile(target); err != nil || string(body) != "new-binary" {
		t.Fatalf("executable = %q (err %v)", body, err)
	}
	if !strings.Contains(out.String(), `"cli":{"id":"decx-cli","updated":true,"version":"9.9.9"`) {
		t.Fatalf("out = %s", out.String())
	}
	// A second run at the newest version is a no-op and downloads nothing.
	out.Reset()
	a.Version = version
	if err := a.Run(context.Background(), []string{"self", "update", "--cli"}); err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(out.String(), `"cli":{"id":"decx-cli","updated":false,"version":"9.9.9"`) {
		t.Fatalf("out = %s", out.String())
	}
}

// TestSessionOpenDefaultsToDefaultModule pins down that a bare `session open`
// selects the module marked as the default even though the known table always
// registers several modules; the missing server must be reported for jadx, not
// with the module-selection error.
func TestSessionOpenDefaultsToDefaultModule(t *testing.T) {
	t.Chdir(t.TempDir())
	home := t.TempDir()
	installManifest(t, registry.ModuleRoot(home, "jadx"), registry.Manifest{
		Manifest: 1,
		Kind:     registry.KindServer,
		ID:       "jadx",
		Binary:   &registry.Binary{Kind: "java-jar", Path: "jadx-server.jar"},
		Launch:   &registry.Launch{Command: []string{"{binary}", "{target}", "--port", "{port}"}},
		Commands: []registry.Command{{Name: "classes", Endpoint: "get_classes"}},
	})
	target := filepath.Join(t.TempDir(), "app.apk")
	if err := os.WriteFile(target, []byte("apk"), 0o644); err != nil {
		t.Fatal(err)
	}
	a := App{Home: home, Out: &bytes.Buffer{}, Err: &bytes.Buffer{}}
	err := a.Run(context.Background(), []string{"session", "open", target})
	if err == nil || strings.Contains(err.Error(), "select a registered module") {
		t.Fatalf("err = %v", err)
	}
	if !strings.Contains(err.Error(), "jadx") {
		t.Fatalf("err = %v", err)
	}
}

// TestConfigPathWarning reports a --config path that does not exist instead of
// silently ignoring it.
func TestConfigPathWarning(t *testing.T) {
	t.Chdir(t.TempDir())
	missing := filepath.Join(t.TempDir(), "missing")
	var stderr bytes.Buffer
	a := App{Home: t.TempDir(), Out: &bytes.Buffer{}, Err: &stderr}
	if err := a.Run(context.Background(), []string{"--config", missing, "help"}); err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(stderr.String(), "--config") || !strings.Contains(stderr.String(), "does not exist") {
		t.Fatalf("stderr = %s", stderr.String())
	}
}

func tarGz(t *testing.T, name string, content []byte) []byte {
	t.Helper()
	return tarGzFiles(t, map[string]string{name: string(content)})
}

// tarGzFiles packs a tar.gz archive from the given files.
func tarGzFiles(t *testing.T, files map[string]string) []byte {
	t.Helper()
	var buffer bytes.Buffer
	gz := gzip.NewWriter(&buffer)
	writer := tar.NewWriter(gz)
	for name, content := range files {
		if err := writer.WriteHeader(&tar.Header{Name: name, Mode: 0o755, Size: int64(len(content))}); err != nil {
			t.Fatal(err)
		}
		if _, err := writer.Write([]byte(content)); err != nil {
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
