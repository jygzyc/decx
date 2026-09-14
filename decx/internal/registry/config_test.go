package registry

import (
	"encoding/json"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"testing"
)

// TestKnownComponents pins down the placeholders Load appends for the shipped
// components that were not discovered locally: they carry release metadata and
// the default marker, but no runtime state.
func TestKnownComponents(t *testing.T) {
	c := &Config{}
	c.applyKnown()
	if ids := moduleIDs(c.Modules); !slices.Equal(ids, []string{"asc", "jadx", "kuna"}) {
		t.Fatalf("known modules = %v", ids)
	}
	if ids := pluginIDs(c.Plugins); !slices.Equal(ids, []string{"ard-framework"}) {
		t.Fatalf("known plugins = %v", ids)
	}
	jadx, ok := c.Module("jadx")
	if !ok {
		t.Fatal("shipped defaults do not register the jadx module")
	}
	if !jadx.Default || jadx.Installed || jadx.Binary.Path != "" || jadx.Launch.Command != nil || len(jadx.Commands) != 0 {
		t.Fatalf("known module carries runtime state: %+v", jadx)
	}
	if jadx.Release == nil || jadx.Release.Source != "repo" || jadx.Release.Tag != "jadx-server-v{version}" ||
		jadx.Release.Asset != "jadx-server-{version}.zip" || jadx.Release.Format != "zip" || jadx.Release.Checksums != "SHA256SUMS" {
		t.Fatalf("jadx install block: %+v", jadx.Release)
	}
	kuna, ok := c.Module("kuna")
	if !ok {
		t.Fatal("shipped defaults do not register the kuna module")
	}
	if kuna.Release == nil || kuna.Release.Tag != "kuna-server-v{version}" ||
		kuna.Release.Asset != "kuna-server-{version}-{os}-{arch}.zip" {
		t.Fatalf("kuna install block: %+v", kuna.Release)
	}
	plugin, ok := c.Plugin("ard-framework")
	if !ok {
		t.Fatal("shipped defaults do not register the ard-framework plugin")
	}
	if !plugin.Default || plugin.Installed || plugin.Entry != "" || len(plugin.Commands) != 0 {
		t.Fatalf("ard-framework known plugin: %+v", plugin)
	}
	if plugin.Release == nil || plugin.Release.Tag != "ard-framework-v{version}" ||
		plugin.Release.Asset != "decx-ard-framework-plugin-{version}.zip" {
		t.Fatalf("ard-framework install block: %+v", plugin.Release)
	}

	// A discovered component keeps its own manifest but inherits the default
	// marker and, without one, the release metadata the CLI ships with; an
	// undiscovered component is only represented by its placeholder.
	own := &Install{Source: "repo", Repository: "owner/custom", Tag: "jadx-server-v{version}", Asset: "jadx-server-{version}.zip"}
	// The slices are pre-sized so applyKnown's appends do not invalidate the
	// pointers it takes into them (the reallocation is a production bug tracked
	// separately); this keeps the intended merge semantics under test.
	discovered := &Config{
		Modules: make([]Module, 0, 8),
		Plugins: make([]Plugin, 0, 8),
	}
	discovered.Modules = append(discovered.Modules,
		Module{ID: "jadx", Description: "checkout jadx", Release: own, Installed: true, Root: "/checkout/jadx"},
		Module{ID: "custom"},
		Module{ID: "kuna", Installed: true},
	)
	discovered.Plugins = append(discovered.Plugins, Plugin{ID: "ard-framework", Entry: "dist/ard-framework.js", Installed: true})
	discovered.applyKnown()
	if ids := moduleIDs(discovered.Modules); !slices.Equal(ids, []string{"asc", "custom", "jadx", "kuna"}) {
		t.Fatalf("modules after discovery = %v", ids)
	}
	checkoutJadx, _ := discovered.Module("jadx")
	if checkoutJadx.Description != "checkout jadx" || checkoutJadx.Release != own || !checkoutJadx.Default || !checkoutJadx.Installed || checkoutJadx.Root != "/checkout/jadx" {
		t.Fatalf("discovered jadx was overwritten: %+v", checkoutJadx)
	}
	discoveredKuna, _ := discovered.Module("kuna")
	if discoveredKuna.Default || !discoveredKuna.Installed || discoveredKuna.Release == nil {
		t.Fatalf("discovered kuna = %+v", discoveredKuna)
	}
	asc, _ := discovered.Module("asc")
	if asc.Installed || asc.Release == nil || asc.Default {
		t.Fatalf("asc placeholder = %+v", asc)
	}
	discoveredPlugin, _ := discovered.Plugin("ard-framework")
	if discoveredPlugin.Entry != "dist/ard-framework.js" || !discoveredPlugin.Default || !discoveredPlugin.Installed {
		t.Fatalf("discovered ard-framework = %+v", discoveredPlugin)
	}
}

func moduleIDs(modules []Module) []string {
	ids := make([]string, 0, len(modules))
	for _, module := range modules {
		ids = append(ids, module.ID)
	}
	return ids
}

func pluginIDs(plugins []Plugin) []string {
	ids := make([]string, 0, len(plugins))
	for _, plugin := range plugins {
		ids = append(ids, plugin.ID)
	}
	return ids
}

// commandFor finds one command in a tree by name.
func commandFor(t *testing.T, commands []Command, name string) Command {
	t.Helper()
	for _, cmd := range commands {
		if cmd.Name == name {
			return cmd
		}
	}
	t.Fatalf("command %q missing", name)
	return Command{}
}

// TestConfigDirModuleRequestMapping builds a server manifest in an explicit
// --config root and checks that its command tree maps argv to the HTTP body.
func TestConfigDirModuleRequestMapping(t *testing.T) {
	checkout := t.TempDir()
	dir := filepath.Join(checkout, "bin", "jadx")
	if err := os.MkdirAll(dir, 0700); err != nil {
		t.Fatal(err)
	}
	manifest := Manifest{
		Manifest:    1,
		Kind:        KindServer,
		ID:          "jadx",
		Description: "config dir jadx server",
		Version:     "1.0.0",
		Release: &Install{
			Source:    "repo",
			Tag:       "jadx-server-v{version}",
			Asset:     "jadx-server-{version}.zip",
			Format:    "zip",
			Checksums: "SHA256SUMS",
		},
		Binary: &Binary{Kind: "java-jar", Path: "jadx-server.jar", Env: "DECX_JADX_SERVER"},
		Launch: &Launch{
			Command:      []string{"java", "-jar", "{binary}", "{target}", "--port", "{port}"},
			Scripts:      "positional",
			TrailingArgs: true,
		},
		Commands: []Command{{
			Name:     "classes",
			About:    "List decompiled classes with optional package filters",
			Endpoint: "get_classes",
			Args: []Arg{
				{ID: "limit", Kind: "value", Long: "limit", Type: "u64"},
				{ID: "include-package", Kind: "multi", Long: "include-package"},
				{ID: "exclude-package", Kind: "multi", Long: "exclude-package"},
				{ID: "no-regex", Kind: "flag", Long: "no-regex"},
			},
			Request: []Mapping{
				{Arg: "limit", Field: "filter.limit", Type: "u64", When: "set"},
				{Arg: "include-package", Field: "filter.includes", Type: "string[]", When: "always", Default: json.RawMessage(`[]`)},
				{Arg: "exclude-package", Field: "filter.excludes", Type: "string[]", When: "always", Default: json.RawMessage(`[]`)},
				{Arg: "no-regex", Field: "filter.regex", Type: "bool", When: "set", Invert: true},
				{Arg: "page", Field: "page", Type: "u64", When: "always", Default: json.RawMessage(`1`)},
			},
		}},
	}
	if err := WriteManifest(dir, manifest); err != nil {
		t.Fatal(err)
	}
	loaded, err := Load(t.TempDir(), checkout)
	if err != nil {
		t.Fatal(err)
	}
	module, ok := loaded.Module("jadx")
	if !ok || !module.Installed || module.Root != dir {
		t.Fatalf("config dir module not loaded: %+v", module)
	}
	if module.Binary.Env != "DECX_JADX_SERVER" {
		t.Fatalf("unexpected binary block: %+v", module.Binary)
	}
	if module.Release == nil || module.Release.Repository != DefaultRepository {
		t.Fatalf("release did not inherit the default repository: %+v", module.Release)
	}

	cmd := commandFor(t, module.Commands, "classes")
	args, err := ParseArgs(append(append([]Arg{}, CoreArgs...), cmd.Args...), []string{"--include-package", "com.example", "--include-package=org.example", "--limit", "18446744073709551615", "--no-regex"})
	if err != nil {
		t.Fatal(err)
	}
	body, err := BuildRequest(cmd.Request, args)
	if err != nil {
		t.Fatal(err)
	}
	data, _ := json.Marshal(body)
	want := `{"filter":{"excludes":[],"includes":["com.example","org.example"],"limit":18446744073709551615,"regex":false},"page":1}`
	if string(data) != want {
		t.Fatalf("got %s", data)
	}
}

// TestKunaModuleRequestMapping reads the shipped kuna manifest and checks that
// its command tree maps argv to the requests the kuna server expects.
func TestKunaModuleRequestMapping(t *testing.T) {
	raw, err := os.ReadFile(filepath.Join("..", "..", "..", "modules", "decx-kuna", "decx.json"))
	if err != nil {
		t.Fatalf("read shipped kuna manifest: %v", err)
	}
	var manifest Manifest
	if err := json.Unmarshal(raw, &manifest); err != nil {
		t.Fatal(err)
	}
	home := t.TempDir()
	dir := ModuleRoot(home, "kuna")
	if err := os.MkdirAll(dir, 0700); err != nil {
		t.Fatal(err)
	}
	if err := WriteManifest(dir, manifest); err != nil {
		t.Fatal(err)
	}
	cfg, err := Load(home)
	if err != nil {
		t.Fatal(err)
	}
	kuna, ok := cfg.Module("kuna")
	if !ok || !kuna.Installed || kuna.Root != dir {
		t.Fatalf("installed kuna module not loaded: %+v", kuna)
	}
	if kuna.Binary.Path != "bin/kuna-server" || kuna.Binary.Env != "DECX_KUNA_SERVER" {
		t.Fatalf("unexpected kuna binary block: %+v", kuna.Binary)
	}
	wantLaunch := []string{"{binary}", "{target}", "--port", "{port}"}
	if !kuna.Launch.TrailingArgs || !slices.Equal(kuna.Launch.Command, wantLaunch) {
		t.Fatalf("unexpected kuna launch block: %+v", kuna.Launch)
	}
	if kuna.Release == nil || kuna.Release.Asset != "kuna-server-{version}-{os}-{arch}.zip" ||
		kuna.Release.Tag != "kuna-server-v{version}" || kuna.Release.Format != "zip" || kuna.Release.Checksums != "SHA256SUMS" {
		t.Fatalf("unexpected kuna release block: %+v", kuna.Release)
	}

	build := func(cmd Command, argv []string) string {
		args, err := ParseArgs(append(append([]Arg{}, CoreArgs...), cmd.Args...), argv)
		if err != nil {
			t.Fatal(err)
		}
		body, err := BuildRequest(cmd.Request, args)
		if err != nil {
			t.Fatal(err)
		}
		data, _ := json.Marshal(body)
		return string(data)
	}

	cases := []struct {
		command string
		argv    []string
		want    string
	}{
		{"functions", []string{"--contains", "main", "--include", "^sub_", "--regex", "--limit", "3"}, `{"case_sensitive":false,"includes":["^sub_"],"limit":3,"name_contains":"main","page":1,"regex":true}`},
		{"source", []string{"--address", "0x401000", "--limit", "7"}, `{"address":"0x401000","limit":7,"page":1}`},
		{"xref", []string{"--name", "main", "--direction", "callees", "--kind", "call", "--kind", "data"}, `{"direction":"callees","kinds":["call","data"],"name":"main","page":1}`},
	}
	for _, tc := range cases {
		if got := build(commandFor(t, kuna.Commands, tc.command), tc.argv); got != tc.want {
			t.Errorf("kuna %s request = %s, want %s", tc.command, got, tc.want)
		}
	}
}

// TestLoadDiscoversManifests covers the description a Config is built from:
// installed manifests win, a manifest without a release block is discovered but
// not installable, broken artifacts become warnings instead of errors, and an
// explicit --config root contributes checkout components.
func TestLoadDiscoversManifests(t *testing.T) {
	home := t.TempDir()
	if _, err := Load(home); err != nil {
		t.Fatal(err)
	}

	writeServer := func(id, version string, release *Install) string {
		dir := ModuleRoot(home, id)
		if err := os.MkdirAll(dir, 0700); err != nil {
			t.Fatal(err)
		}
		manifest := Manifest{
			Manifest: 1,
			Kind:     KindServer,
			ID:       id,
			Version:  "0.1.0",
			Release:  release,
			Binary:   &Binary{Kind: "program", Path: id + "-server"},
			Launch:   &Launch{Command: []string{"{binary}", "--port", "{port}"}},
			Commands: []Command{{Name: "ping", About: "check readiness", Endpoint: "health"}},
		}
		if err := WriteManifest(dir, manifest); err != nil {
			t.Fatal(err)
		}
		if version != "" {
			if err := WriteVersion(dir, version); err != nil {
				t.Fatal(err)
			}
		}
		return dir
	}

	// An installed server manifest becomes a runnable module carrying its
	// recorded version.
	dir := writeServer("custom", "1.4.2", nil)
	c, err := Load(home)
	if err != nil {
		t.Fatal(err)
	}
	custom, ok := c.Module("custom")
	if !ok || !custom.Installed || custom.Version != "1.4.2" || custom.Root != dir || len(custom.Commands) == 0 {
		t.Fatalf("installed manifest not loaded: %+v", custom)
	}
	if custom.Release != nil {
		t.Fatalf("manifest without a release block is installable: %+v", custom.Release)
	}
	if custom.Binary.Path == "" || custom.Launch.Command == nil {
		t.Fatalf("installed module has no runtime state: %+v", custom)
	}

	// A manifest that declares no release is still discovered.
	extra := writeServer("extra", "", nil)
	c, err = Load(home)
	if err != nil {
		t.Fatal(err)
	}
	if e, ok := c.Module("extra"); !ok || !e.Installed || e.Root != extra {
		t.Fatalf("manifest-only module missing: %+v", e)
	}

	// A broken manifest becomes a warning and never an error.
	broken := ModuleRoot(home, "broken")
	if err := os.MkdirAll(broken, 0700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(broken, ManifestName), []byte("{"), 0600); err != nil {
		t.Fatal(err)
	}
	c, err = Load(home)
	if err != nil {
		t.Fatal(err)
	}
	if _, ok := c.Module("broken"); ok {
		t.Fatal("broken manifest became a module")
	}
	warned := false
	for _, warning := range c.Warnings {
		if strings.Contains(warning, broken) {
			warned = true
		}
	}
	if !warned {
		t.Fatalf("broken manifest not reported: %v", c.Warnings)
	}

	// An explicit missing extra root is not an error.
	if _, err := Load(home, filepath.Join(home, "missing")); err != nil {
		t.Fatal(err)
	}

	// A checkout reached through an explicit --config root is discovered too.
	checkout := t.TempDir()
	checkoutDir := filepath.Join(checkout, "plugins", "sample")
	if err := os.MkdirAll(checkoutDir, 0700); err != nil {
		t.Fatal(err)
	}
	plugin := Manifest{
		Manifest: 1,
		Kind:     KindPlugin,
		ID:       "sample",
		Entry:    "dist/sample.js",
		Commands: []Command{{Name: "run"}},
	}
	if err := WriteManifest(checkoutDir, plugin); err != nil {
		t.Fatal(err)
	}
	c, err = Load(home, checkout)
	if err != nil {
		t.Fatal(err)
	}
	if p, ok := c.Plugin("sample"); !ok || !p.Installed || p.Root != checkoutDir {
		t.Fatalf("checkout plugin not loaded: %+v", p)
	}
}

func TestArgumentErrorsAndLiteral(t *testing.T) {
	spec := []Arg{{ID: "query", Kind: "positional", Required: true}, {ID: "limit", Long: "limit", Kind: "value", Type: "u64"}}
	for _, input := range [][]string{{}, {"q", "--wat"}, {"q", "--limit"}, {"q", "--limit=-1"}, {"q", "--limit=18446744073709551616"}, {"q", "--limit=1", "--limit=2"}, {"q", "extra"}} {
		if _, err := ParseArgs(spec, input); err == nil {
			t.Fatalf("accepted %v", input)
		}
	}
	args, err := ParseArgs(spec, []string{"--", "--literal"})
	if err != nil || args["query"][0] != "--literal" {
		t.Fatalf("literal parse: %v %v", args, err)
	}
}
