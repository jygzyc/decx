package registry

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"slices"
	"sort"
	"strings"
)

// Installed modules are self-describing: every server and every plugin owns one
// directory under DECX_HOME/modules/<id> that holds the decx.json manifest
// declaring how it runs, a VERSION file with the artifact's own version, and the
// executable files themselves. The same manifest also names the release it is
// installed and updated from, so unpacking a release archive into the right
// directory is enough to make a module available.
const (
	ManifestName = "decx.json"
	VersionName  = "VERSION"
	markerName   = ".decx-version"

	// KindServer is a component that serves analysis requests over HTTP.
	KindServer = "server"
	// KindPlugin is a component whose commands the CLI runs in-process.
	KindPlugin = "plugin"
)

// Manifest is the decx.json shipped inside a server or plugin directory.
type Manifest struct {
	Manifest    int       `json:"manifest"`
	Kind        string    `json:"kind"`
	ID          string    `json:"id"`
	Description string    `json:"description,omitempty"`
	Version     string    `json:"version,omitempty"`
	Release     *Install  `json:"release,omitempty"`
	Entry       string    `json:"entry,omitempty"`
	Binary      *Binary   `json:"binary,omitempty"`
	Launch      *Launch   `json:"launch,omitempty"`
	Commands    []Command `json:"commands,omitempty"`
}

// Found pairs a manifest with the directory it was read from.
type Found struct {
	Manifest *Manifest
	Root     string
}

// ModuleRoot is the directory one module owns under DECX_HOME. Servers and
// plugins share the same root; the manifest decides the kind.
func ModuleRoot(home, id string) string { return filepath.Join(home, "modules", id) }

// ReadManifest reads dir/decx.json; the boolean reports whether the file exists.
func ReadManifest(dir string) (*Manifest, bool, error) {
	data, err := os.ReadFile(filepath.Join(dir, ManifestName))
	if errors.Is(err, os.ErrNotExist) {
		return nil, false, nil
	}
	if err != nil {
		return nil, false, err
	}
	var m Manifest
	d := json.NewDecoder(bytes.NewReader(data))
	d.DisallowUnknownFields()
	if err := d.Decode(&m); err != nil {
		return nil, true, err
	}
	if err := d.Decode(new(any)); err != io.EOF {
		return nil, true, errors.New("expected one JSON object")
	}
	return &m, true, nil
}

// WriteManifest writes a manifest as the decx.json of one component directory.
func WriteManifest(dir string, m Manifest) error {
	data, err := json.MarshalIndent(m, "", "  ")
	if err != nil {
		return err
	}
	return os.WriteFile(filepath.Join(dir, ManifestName), append(data, '\n'), 0600)
}

// WriteVersion records the version of one component directory. The installer
// writes it after validating an archive, so an installed component always
// reports which release it came from.
func WriteVersion(dir, version string) error {
	return os.WriteFile(filepath.Join(dir, VersionName), []byte(strings.TrimSpace(version)+"\n"), 0o644)
}

// ReadVersion reads the VERSION file of an installed component, falling back to
// the release marker the installer writes.
func ReadVersion(dir string) string {
	for _, name := range []string{VersionName, markerName} {
		data, err := os.ReadFile(filepath.Join(dir, name))
		if err != nil {
			continue
		}
		if value := strings.TrimSpace(string(data)); value != "" {
			return value
		}
	}
	return ""
}

// InstalledVersion reports the version recorded for one module ("" when the
// module is not installed).
func InstalledVersion(home, id string) string {
	return ReadVersion(ModuleRoot(home, id))
}

// ModuleInstalled reports whether DECX_HOME holds a manifest for the id.
func ModuleInstalled(home, id string) bool {
	_, found, _ := ReadManifest(ModuleRoot(home, id))
	return found
}

// Validate checks one manifest, including the release source an installed
// component updates itself from.
func (m *Manifest) Validate() error {
	if m.Manifest != 1 {
		return fmt.Errorf("unsupported manifest version %d", m.Manifest)
	}
	if m.Kind != KindServer && m.Kind != KindPlugin {
		return fmt.Errorf("invalid kind %q (use %q or %q)", m.Kind, KindServer, KindPlugin)
	}
	if !namePattern.MatchString(m.ID) || reserved[m.ID] {
		return fmt.Errorf("invalid or reserved id %q", m.ID)
	}
	if len(m.Commands) == 0 {
		return errors.New("must declare at least one command")
	}
	if m.Kind == KindPlugin {
		if m.Binary != nil || m.Launch != nil {
			return errors.New("plugins cannot declare a binary or launch command")
		}
		if err := validateRelativePath(m.Entry); err != nil {
			return fmt.Errorf("invalid entry: %w", err)
		}
		if !strings.HasSuffix(m.Entry, ".js") {
			return errors.New("entry must be a compiled JavaScript file (.js)")
		}
		if err := validateRelease(m.ID, m.Release); err != nil {
			return err
		}
		return validateCommands(m.Commands, true)
	}
	if m.Entry != "" {
		return errors.New("servers cannot declare an entry")
	}
	if m.Binary == nil {
		return errors.New("missing binary")
	}
	if m.Binary.Path == "" || (m.Binary.Kind != "program" && m.Binary.Kind != "java-jar") {
		return errors.New("invalid binary")
	}
	if err := validateRelativePath(filepath.ToSlash(m.Binary.Path)); err != nil {
		return fmt.Errorf("invalid binary path: %w", err)
	}
	if m.Launch == nil || len(m.Launch.Command) == 0 || m.Launch.Command[0] == "" {
		return errors.New("missing launch command")
	}
	if m.Launch.Scripts != "" && m.Launch.Scripts != "positional" {
		return errors.New("invalid scripts mode")
	}
	if err := validateLaunch(m.ID, *m.Launch); err != nil {
		return err
	}
	if err := validateRelease(m.ID, m.Release); err != nil {
		return err
	}
	return validateCommands(m.Commands, false)
}

// ScanManifests reads every <root>/<id>/decx.json of one module kind. Both
// servers and plugins live in DECX_HOME/modules; manifests of the other kind
// found there are ignored. Every extra root (the directory of an explicit
// --config path, the executable directory or the working directory) is scanned
// as well — the root itself plus its modules/ or plugins/ — and the closest
// modules/ or plugins/ directory above it is used for a source checkout, so a
// checkout works without installing anything; installed modules win over
// checkouts. Directories without a manifest and non-directories are skipped,
// while a manifest that does not load is reported as a warning so a broken
// artifact never stops `decx install --force` from repairing it.
func ScanManifests(home, kind string, extraRoots []string) (map[string]Found, []string) {
	roots := scanRoots(home, kind, extraRoots)
	found := map[string]Found{}
	var warnings []string
	for _, root := range roots {
		entries, err := os.ReadDir(root)
		if err != nil {
			// A root that simply does not exist is normal (a fresh DECX_HOME
			// has no modules/ yet); one that cannot be read is reported.
			if !errors.Is(err, os.ErrNotExist) {
				warnings = append(warnings, fmt.Sprintf("%s: %v", root, err))
			}
			continue
		}
		names := make([]string, 0, len(entries))
		for _, entry := range entries {
			if entry.IsDir() {
				names = append(names, entry.Name())
			}
		}
		sort.Strings(names)
		for _, id := range names {
			dir := filepath.Join(root, id)
			where := filepath.Join(dir, ManifestName)
			manifest, exists, err := ReadManifest(dir)
			if err != nil {
				warnings = append(warnings, fmt.Sprintf("%s: %v", where, err))
				continue
			}
			if !exists {
				continue
			}
			if manifest.Kind != kind {
				// DECX_HOME/modules carries both kinds; the other kind is
				// picked up by its own scan.
				continue
			}
			if manifest.ID != id && manifest.ID != strings.TrimPrefix(id, "decx-") {
				warnings = append(warnings, fmt.Sprintf("%s: id %q does not match the directory name", where, manifest.ID))
				continue
			}
			if err := manifest.Validate(); err != nil {
				warnings = append(warnings, fmt.Sprintf("%s: %v", where, err))
				continue
			}
			// Earlier roots win, so an installed component beats a checkout.
			if _, exists := found[manifest.ID]; exists {
				continue
			}
			found[manifest.ID] = Found{Manifest: manifest, Root: dir}
		}
	}
	return found, warnings
}

// scanRoots lists the directories one component kind is discovered in, in
// precedence order.
func scanRoots(home, kind string, extraRoots []string) []string {
	roots := []string{ModuleRoot(home, "")}
	// An explicit --config root carries modules the same way DECX_HOME does;
	// bin/ and plugins/ keep the pre-module config layouts working.
	legacy := "bin"
	if kind == KindPlugin {
		legacy = "plugins"
	}
	for _, dir := range extraRoots {
		if dir == "" {
			continue
		}
		for _, candidate := range []string{dir, filepath.Join(dir, "modules"), filepath.Join(dir, legacy)} {
			if _, err := os.Stat(candidate); err == nil && !slices.Contains(roots, candidate) {
				roots = append(roots, candidate)
			}
		}
	}
	for _, dir := range append([]string{executableDir(), workingDir()}, extraRoots...) {
		if dir == "" {
			continue
		}
		root := nearestComponentDir(dir, kind)
		if root == "" || slices.Contains(roots, root) {
			continue
		}
		roots = append(roots, root)
	}
	return roots
}

// nearestComponentDir reports the directory a source checkout keeps its
// components in — plugins/ for plugins and modules/ for servers — searching
// upwards from dir, so running the CLI inside the repository works without
// installing anything.
func nearestComponentDir(dir, kind string) string {
	sub := "modules"
	if kind == KindPlugin {
		sub = "plugins"
	}
	for {
		candidate := filepath.Join(dir, sub)
		if entries, err := os.ReadDir(candidate); err == nil {
			for _, entry := range entries {
				if entry.IsDir() {
					if _, err := os.Stat(filepath.Join(candidate, entry.Name(), ManifestName)); err == nil {
						return candidate
					}
				}
			}
		}
		parent := filepath.Dir(dir)
		if parent == dir {
			return ""
		}
		dir = parent
	}
}

func executableDir() string {
	executable, err := os.Executable()
	if err != nil {
		return ""
	}
	return filepath.Dir(executable)
}

func workingDir() string {
	dir, err := os.Getwd()
	if err != nil {
		return ""
	}
	return dir
}

// manifestVersion prefers the installed artifact's own VERSION file over the
// version the manifest declares.
func manifestVersion(manifest *Manifest, root string) string {
	if version := ReadVersion(root); version != "" {
		return version
	}
	return strings.TrimSpace(manifest.Version)
}

// sortedKeys returns the map keys in a stable order.
func sortedKeys[T any](values map[string]T) []string {
	keys := make([]string, 0, len(values))
	for key := range values {
		keys = append(keys, key)
	}
	sort.Strings(keys)
	return keys
}
