package registry

import (
	"encoding/json"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"testing"
)

func validServerManifest() Manifest {
	return Manifest{
		Manifest: 1,
		Kind:     KindServer,
		ID:       "demo",
		Version:  "1.0.0",
		Binary:   &Binary{Kind: "program", Path: "bin/demo"},
		Launch:   &Launch{Command: []string{"{binary}", "--port", "{port}"}},
		Commands: []Command{{
			Name:     "classes",
			Endpoint: "get_classes",
			Args:     []Arg{{ID: "limit", Kind: "value", Long: "limit", Type: "u64"}},
			Request:  []Mapping{{Arg: "limit", Field: "filter.limit", Type: "u64", When: "set"}},
		}},
	}
}

func validPluginManifest() Manifest {
	return Manifest{
		Manifest: 1,
		Kind:     KindPlugin,
		ID:       "demo",
		Entry:    "dist/demo.js",
		Commands: []Command{{
			Name:        "device",
			Subcommands: []Command{{Name: "list"}},
		}},
	}
}

func TestManifestValidation(t *testing.T) {
	cases := map[string]struct {
		manifest func() Manifest
		mutate   func(*Manifest)
	}{
		"version":           {validServerManifest, func(m *Manifest) { m.Manifest = 2 }},
		"kind":              {validServerManifest, func(m *Manifest) { m.Kind = "daemon" }},
		"invalid id":        {validServerManifest, func(m *Manifest) { m.ID = "Bad_ID" }},
		"reserved id":       {validServerManifest, func(m *Manifest) { m.ID = "self" }},
		"no commands":       {validServerManifest, func(m *Manifest) { m.Commands = nil }},
		"server entry":      {validServerManifest, func(m *Manifest) { m.Entry = "dist/demo.js" }},
		"missing binary":    {validServerManifest, func(m *Manifest) { m.Binary = nil }},
		"binary kind":       {validServerManifest, func(m *Manifest) { m.Binary.Kind = "script" }},
		"binary escape":     {validServerManifest, func(m *Manifest) { m.Binary.Path = "../bin/evil" }},
		"missing launch":    {validServerManifest, func(m *Manifest) { m.Launch = nil }},
		"empty launch":      {validServerManifest, func(m *Manifest) { m.Launch.Command = nil }},
		"start placeholder": {validServerManifest, func(m *Manifest) { m.Launch.Command = []string{"{wat}"} }},
		"malformed placeholder": {validServerManifest, func(m *Manifest) {
			m.Launch.Command = []string{"{binary"}
		}},
		"stop placeholder": {validServerManifest, func(m *Manifest) {
			m.Launch.Stop = Stop{Command: []string{"kill", "{wat}"}}
		}},
		"routing escape":    {validServerManifest, func(m *Manifest) { m.Commands[0].Endpoint = "../health" }},
		"unmapped argument": {validServerManifest, func(m *Manifest) { m.Commands[0].Request[0].Arg = "absent" }},
		"wrong default":     {validServerManifest, func(m *Manifest) { m.Commands[0].Request[0].Default = json.RawMessage(`"x"`) }},
		"core argument collision": {validServerManifest, func(m *Manifest) {
			m.Commands[0].Args = append(m.Commands[0].Args, Arg{ID: "port", Kind: "value", Long: "port", Type: "string"})
		}},
		"duplicate command": {validServerManifest, func(m *Manifest) {
			m.Commands = append(m.Commands, m.Commands[0])
		}},
		"mapping prefix collision": {validServerManifest, func(m *Manifest) {
			m.Commands[0].Request = append(m.Commands[0].Request, Mapping{Arg: "limit", Field: "filter", Type: "u64", When: "set"})
		}},
		"install source": {validServerManifest, func(m *Manifest) {
			m.Release = &Install{Source: "ftp", Tag: "demo-v{version}", Asset: "demo-{version}.zip"}
		}},
		"install repository": {validServerManifest, func(m *Manifest) {
			m.Release = &Install{Source: "repo", Repository: "owner", Asset: "demo-{version}.zip"}
		}},
		"install asset version": {validServerManifest, func(m *Manifest) {
			m.Release = &Install{Source: "repo", Asset: "demo.zip"}
		}},
		"install asset path": {validServerManifest, func(m *Manifest) {
			m.Release = &Install{Source: "repo", Asset: "sub/demo-{version}.zip"}
		}},
		"install asset placeholder": {validServerManifest, func(m *Manifest) {
			m.Release = &Install{Source: "repo", Asset: "demo-{platform}-{version}.zip"}
		}},
		"install asset not archive": {validServerManifest, func(m *Manifest) {
			m.Release = &Install{Source: "repo", Asset: "demo-{version}.jar"}
		}},
		"install checksum path": {validServerManifest, func(m *Manifest) {
			m.Release = &Install{Source: "repo", Asset: "demo-{version}.zip", Checksums: "sub/SHA256SUMS"}
		}},
		"install checksums missing": {validServerManifest, func(m *Manifest) {
			m.Release = &Install{Source: "repo", Asset: "demo-{version}.zip"}
		}},
		"install format": {validServerManifest, func(m *Manifest) {
			m.Release = &Install{Source: "repo", Asset: "demo-{version}.zip", Format: "rar"}
		}},
		"install tag version": {validServerManifest, func(m *Manifest) {
			m.Release = &Install{Source: "repo", Tag: "demo-v1", Asset: "demo-{version}.zip"}
		}},
		"local path in manifest": {validServerManifest, func(m *Manifest) {
			m.Release = &Install{Source: "local", Path: "/tmp/demo.zip"}
		}},
		"plugin no commands":  {validPluginManifest, func(m *Manifest) { m.Commands = nil }},
		"plugin entry empty":  {validPluginManifest, func(m *Manifest) { m.Entry = "" }},
		"plugin entry escape": {validPluginManifest, func(m *Manifest) { m.Entry = "../demo.js" }},
		"plugin entry type":   {validPluginManifest, func(m *Manifest) { m.Entry = "dist/demo.ts" }},
		"plugin binary":       {validPluginManifest, func(m *Manifest) { m.Binary = &Binary{Kind: "program", Path: "bin/demo"} }},
		"plugin launch":       {validPluginManifest, func(m *Manifest) { m.Launch = &Launch{Command: []string{"{binary}"}} }},
		"plugin routing":      {validPluginManifest, func(m *Manifest) { m.Commands[0].Subcommands[0].Endpoint = "device" }},
		// Plugin release blocks are deliberately not covered here: Validate
		// returns from the plugin branch before validateRelease, so plugin
		// release metadata is currently never checked (reported as a bug).
	}
	for name, tc := range cases {
		t.Run(name, func(t *testing.T) {
			manifest := tc.manifest()
			tc.mutate(&manifest)
			if err := manifest.Validate(); err == nil {
				t.Fatalf("accepted invalid manifest: %+v", manifest)
			}
		})
	}
}

// TestServerReleaseDefaultsRepository pins down the release metadata a server
// manifest gets when it does not name a repository.
func TestServerReleaseDefaultsRepository(t *testing.T) {
	m := validServerManifest()
	m.Release = &Install{Asset: "demo-{version}.zip", Checksums: "SHA256SUMS"}
	if err := m.Validate(); err != nil {
		t.Fatal(err)
	}
	if m.Release.Repository != DefaultRepository {
		t.Fatalf("repository = %q, want %q", m.Release.Repository, DefaultRepository)
	}
	if m.Release.Source != "" {
		t.Fatalf("source = %q, want the empty repository default", m.Release.Source)
	}
}

// TestArchiveInstallValidation checks the archive shapes a release block may
// declare, including the {os}/{arch} platform tokens and fallback assets.
func TestArchiveInstallValidation(t *testing.T) {
	m := validServerManifest()
	m.Release = &Install{
		Source:         "repo",
		Tag:            "kuna-server-v{version}",
		Asset:          "kuna-server-{version}-{os}-{arch}.zip",
		AssetFallbacks: []string{"kuna-server-{version}-{os}-{arch}.tar.gz", "kuna-server-{version}.tgz"},
		Checksums:      "SHA256SUMS",
		Format:         "tar.gz",
	}
	if err := m.Validate(); err != nil {
		t.Fatal(err)
	}
	m.Release.AssetFallbacks = []string{"kuna-server-{version}.{platform}"}
	if err := m.Validate(); err == nil {
		t.Fatal("accepted an unsupported fallback placeholder")
	}
}

func TestStopUnmarshalJSON(t *testing.T) {
	var stop Stop
	if err := json.Unmarshal([]byte(`"terminate"`), &stop); err != nil {
		t.Fatal(err)
	}
	if len(stop.Command) != 0 {
		t.Fatalf("terminate produced a command: %v", stop.Command)
	}
	if err := json.Unmarshal([]byte(`["kill", "{pid}"]`), &stop); err != nil {
		t.Fatal(err)
	}
	if !slices.Equal(stop.Command, []string{"kill", "{pid}"}) {
		t.Fatalf("command = %v", stop.Command)
	}
	encoded, err := json.Marshal(stop)
	if err != nil {
		t.Fatal(err)
	}
	if string(encoded) != `["kill","{pid}"]` {
		t.Fatalf("marshalled stop = %s", encoded)
	}
	for _, invalid := range []string{`"restart"`, `[]`, `[""]`, `{"command":["kill"]}`, `42`} {
		var s Stop
		if err := json.Unmarshal([]byte(invalid), &s); err == nil {
			t.Fatalf("accepted stop %s", invalid)
		}
	}
}

func TestReadManifestRejectsUnknownFields(t *testing.T) {
	valid := validServerManifest()
	data, err := json.Marshal(valid)
	if err != nil {
		t.Fatal(err)
	}
	dir := t.TempDir()
	path := filepath.Join(dir, ManifestName)

	if err := os.WriteFile(path, data, 0600); err != nil {
		t.Fatal(err)
	}
	if _, found, err := ReadManifest(dir); err != nil || !found {
		t.Fatalf("valid manifest: found=%v err=%v", found, err)
	}

	var withExtra map[string]any
	if err := json.Unmarshal(data, &withExtra); err != nil {
		t.Fatal(err)
	}
	withExtra["unexpected"] = true
	unknown, err := json.Marshal(withExtra)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, unknown, 0600); err != nil {
		t.Fatal(err)
	}
	if _, _, err := ReadManifest(dir); err == nil || !strings.Contains(err.Error(), "unexpected") {
		t.Fatalf("unknown field: err = %v", err)
	}

	if err := os.WriteFile(path, append(data, []byte("\n{}")...), 0600); err != nil {
		t.Fatal(err)
	}
	if _, _, err := ReadManifest(dir); err == nil {
		t.Fatal("accepted trailing JSON data")
	}
}

func TestPluginCommandTree(t *testing.T) {
	m := validPluginManifest()
	if len(m.Commands) == 0 {
		t.Fatal("the plugin manifest declares no commands")
	}
	if err := m.Validate(); err != nil {
		t.Fatal(err)
	}
	m.Commands[0].Subcommands[0].Endpoint = "device"
	if err := m.Validate(); err == nil {
		t.Fatal("plugin command accepted remote routing")
	}
}

func TestScanManifests(t *testing.T) {
	t.Chdir(t.TempDir())
	home := t.TempDir()
	installServer := func(id string) string {
		dir := ModuleRoot(home, id)
		if err := os.MkdirAll(dir, 0700); err != nil {
			t.Fatal(err)
		}
		m := validServerManifest()
		m.ID = id
		if err := WriteManifest(dir, m); err != nil {
			t.Fatal(err)
		}
		return dir
	}

	dir := installServer("demo")
	if err := WriteVersion(dir, "2.1.0"); err != nil {
		t.Fatal(err)
	}
	found, warnings := ScanManifests(home, KindServer, nil)
	if len(warnings) != 0 {
		t.Fatalf("warnings: %v", warnings)
	}
	entry, ok := found["demo"]
	if !ok || entry.Root != dir {
		t.Fatalf("demo manifest not found: %+v", found)
	}
	if got := manifestVersion(entry.Manifest, entry.Root); got != "2.1.0" {
		t.Fatalf("version = %q", got)
	}

	// Broken artifacts and mislabelled directories become warnings so a broken
	// component never stops `decx install --force` from repairing it.
	broken := ModuleRoot(home, "broken")
	if err := os.MkdirAll(broken, 0700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(broken, ManifestName), []byte("{"), 0600); err != nil {
		t.Fatal(err)
	}
	mismatch := ModuleRoot(home, "alpha")
	if err := os.MkdirAll(mismatch, 0700); err != nil {
		t.Fatal(err)
	}
	wrong := validServerManifest()
	wrong.ID = "beta"
	if err := WriteManifest(mismatch, wrong); err != nil {
		t.Fatal(err)
	}
	found, warnings = ScanManifests(home, KindServer, nil)
	if _, ok := found["broken"]; ok {
		t.Fatal("broken manifest scanned")
	}
	if _, ok := found["alpha"]; ok {
		t.Fatal("id mismatch scanned")
	}
	if len(warnings) != 2 {
		t.Fatalf("warnings = %v", warnings)
	}

	// A root that cannot be read is reported like a broken manifest instead of
	// being skipped silently; a missing root stays silent because a fresh
	// DECX_HOME has no bin/ yet.
	notADir := filepath.Join(t.TempDir(), "not-a-directory")
	if err := os.WriteFile(notADir, []byte("x"), 0600); err != nil {
		t.Fatal(err)
	}
	found, warnings = ScanManifests(t.TempDir(), KindServer, []string{notADir})
	if len(warnings) != 1 || !strings.Contains(warnings[0], notADir) {
		t.Fatalf("unreadable root warnings = %v", warnings)
	}
	if len(found) != 0 {
		t.Fatalf("unreadable root produced components: %+v", found)
	}
}

func TestScanManifestsInstalledPluginWins(t *testing.T) {
	home := t.TempDir()
	checkout := t.TempDir()
	writePlugin := func(root, id, version string) string {
		dir := filepath.Join(root, id)
		if err := os.MkdirAll(dir, 0700); err != nil {
			t.Fatal(err)
		}
		m := validPluginManifest()
		m.ID = id
		m.Version = version
		if err := WriteManifest(dir, m); err != nil {
			t.Fatal(err)
		}
		return dir
	}
	writePlugin(filepath.Join(checkout, "plugins"), "demo", "0.0.0")
	installedDir := writePlugin(filepath.Join(home, "modules"), "demo", "installed")

	found, warnings := ScanManifests(home, KindPlugin, []string{checkout})
	for _, warning := range warnings {
		if strings.Contains(warning, "demo") {
			t.Fatalf("unexpected warning: %v", warning)
		}
	}
	entry, ok := found["demo"]
	if !ok || entry.Root != installedDir {
		t.Fatalf("checkout won over the installed plugin: %+v", entry)
	}
	if got := manifestVersion(entry.Manifest, entry.Root); got != "installed" {
		t.Fatalf("version = %q", got)
	}

	// Without an installed copy the same checkout is still discovered.
	checkoutFound, _ := ScanManifests(t.TempDir(), KindPlugin, []string{checkout})
	if entry, ok := checkoutFound["demo"]; !ok || entry.Root != filepath.Join(checkout, "plugins", "demo") {
		t.Fatalf("checkout plugin not discovered: %+v", entry)
	}
}
