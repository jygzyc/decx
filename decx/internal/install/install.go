// Package install fetches optional components (server modules and plugins) and
// reports their versions. A component is never unpacked blindly: its archive
// has to carry a decx.json manifest, the manifest is validated before it
// replaces an installed component, and every release asset is verified against
// the SHA-256 the release publishes in its checksum file.
package install

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/jygzyc/decx/decx/internal/registry"
)

// DefaultGitHub is the release host used when a Downloader does not override
// it. Tests point it at a local server.
const DefaultGitHub = "https://github.com"

// DefaultGitHubAPI is the release metadata host used when a Downloader does
// not override it.
const DefaultGitHubAPI = "https://api.github.com"

// Downloader fetches release metadata and artifacts.
type Downloader struct {
	Client    *http.Client
	GitHub    string
	GitHubAPI string
}

// Artifact is a resolved install source: a release download (URL plus the
// SHA-256 the release publishes) or a file or directory already on this
// machine (Path).
type Artifact struct {
	Version string
	Name    string
	URL     string
	SHA256  string
	Path    string
	Local   bool
	Dir     bool
}

// Status is the locally installed state of one component.
type Status struct {
	ID        string `json:"id"`
	Installed bool   `json:"installed"`
	Path      string `json:"path,omitempty"`
	Version   string `json:"version,omitempty"`
}

// Spec describes one installable component: the directory it owns under
// DECX_HOME, the entry file inside it, and where the artifact comes from. Build
// it with ModuleSpec or PluginSpec so installation, inspection and the session
// manager agree on the target.
type Spec struct {
	ID      string
	Kind    string
	Root    string
	Entry   string
	Release *registry.Install

	home string
}

// ModuleSpec describes a server module.
func ModuleSpec(home string, e registry.Module) Spec {
	return Spec{
		ID:      e.ID,
		Kind:    registry.KindServer,
		Root:    registry.ModuleRoot(home, e.ID),
		Entry:   filepath.FromSlash(e.Binary.Path),
		Release: e.Release,
		home:    home,
	}
}

// PluginSpec describes a plugin module.
func PluginSpec(home string, p registry.Plugin) Spec {
	return Spec{
		ID:      p.ID,
		Kind:    registry.KindPlugin,
		Root:    registry.ModuleRoot(home, p.ID),
		Entry:   filepath.FromSlash(p.Entry),
		Release: p.Release,
		home:    home,
	}
}

// Format is the archive format the component ships in: the declared format, or
// the format the asset name implies.
func (s Spec) Format() string {
	if s.Release == nil {
		return ""
	}
	if s.Release.Format != "" {
		return s.Release.Format
	}
	name := s.Release.Asset
	if name == "" {
		// A local artifact names its file through Path instead of Asset.
		name = s.Release.Path
	}
	switch {
	case strings.HasSuffix(name, ".zip"):
		return "zip"
	case strings.HasSuffix(name, ".tar.gz"), strings.HasSuffix(name, ".tgz"):
		return "tar.gz"
	}
	return ""
}

// Probe reports whether the component can be resolved locally, where its entry
// is and which version is recorded. The version comes from the VERSION file the
// release ships, so a component installed from a source checkout reports the
// version it was built from as well.
func (s Spec) Probe() (string, string, bool) {
	entry := filepath.Join(s.Root, s.Entry)
	if s.Entry == "" {
		entry = s.Root
	}
	if info, err := os.Stat(entry); err != nil || !info.Mode().IsRegular() {
		return "", "", false
	}
	return entry, registry.ReadVersion(s.Root), true
}

// Inspect reports the local state of the component. It never touches the
// network.
func (s Spec) Inspect() Status {
	path, version, ok := s.Probe()
	if !ok {
		return Status{ID: s.ID}
	}
	return Status{ID: s.ID, Installed: true, Path: path, Version: version}
}

// Installed reports whether the component can be resolved locally.
func (s Spec) Installed() bool {
	_, _, ok := s.Probe()
	return ok
}

// Probe reports whether a server module can be resolved locally, where it is
// and which version is installed. The environment override wins over every
// local copy, mirroring registry.ResolveBinary, so inspection and the launcher
// agree on which binary a session would run; such a server has no managed
// version of its own. Otherwise the installed component is probed, then a
// source checkout, which keeps its binary relative to its own root.
func Probe(home string, e registry.Module) (string, string, bool) {
	if e.Binary.Env != "" && os.Getenv(e.Binary.Env) != "" {
		path, err := registry.ResolveBinary(home, e)
		if err != nil {
			return "", "", false
		}
		return path, "", true
	}
	managed := ModuleSpec(home, e)
	if path, version, ok := managed.Probe(); ok {
		return path, version, true
	}
	if e.Root != "" {
		checkout := managed
		checkout.Root = e.Root
		if path, version, ok := checkout.Probe(); ok {
			return path, version, true
		}
	}
	return "", "", false
}

// Installed reports whether a server module can be resolved locally.
func Installed(home string, e registry.Module) bool {
	_, _, ok := Probe(home, e)
	return ok
}

// Inspect reports the local state of a server module, resolving it exactly
// like Probe so the reported path is the one a session would launch.
func Inspect(home string, e registry.Module) Status {
	path, version, ok := Probe(home, e)
	if !ok {
		return Status{ID: e.ID}
	}
	return Status{ID: e.ID, Installed: true, Path: path, Version: version}
}

func (d Downloader) client() *http.Client {
	if d.Client != nil {
		return d.Client
	}
	return http.DefaultClient
}

func (d Downloader) base() string {
	if d.GitHub != "" {
		return strings.TrimSuffix(d.GitHub, "/")
	}
	return DefaultGitHub
}

func (d Downloader) apiBase() string {
	if d.GitHubAPI != "" {
		return strings.TrimSuffix(d.GitHubAPI, "/")
	}
	return DefaultGitHubAPI
}

// release mirrors the subset of the GitHub releases API the CLI needs.
type release struct {
	TagName    string `json:"tag_name"`
	Draft      bool   `json:"draft"`
	Prerelease bool   `json:"prerelease"`
	Assets     []struct {
		Name string `json:"name"`
		URL  string `json:"browser_download_url"`
	} `json:"assets"`
}

func (r release) asset(name string) (string, bool) {
	for _, asset := range r.Assets {
		if asset.Name == name {
			return asset.URL, true
		}
	}
	return "", false
}

// releases fetches the newest releases of one repository.
func (d Downloader) releases(ctx context.Context, repository string) ([]release, error) {
	url := fmt.Sprintf("%s/repos/%s/releases?per_page=30", d.apiBase(), repository)
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		return nil, err
	}
	request.Header.Set("Accept", "application/vnd.github+json")
	response, err := d.client().Do(request)
	if err != nil {
		return nil, fmt.Errorf("failed to reach %s: %w", url, err)
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("failed to read %s: HTTP %d", url, response.StatusCode)
	}
	var releases []release
	if err := json.NewDecoder(io.LimitReader(response.Body, 4<<20)).Decode(&releases); err != nil {
		return nil, fmt.Errorf("failed to read %s: %w", url, err)
	}
	return releases, nil
}

// Resolve finds the release that ships the component: the newest matching
// release when version is empty, the release tagged with that version
// otherwise. Every candidate is checked for the asset name the component
// declares, and the SHA-256 of that asset is read from the checksum file the
// component declares, so a download can always be verified.
func (d Downloader) Resolve(ctx context.Context, spec Spec, version string, prerelease bool) (Artifact, error) {
	source := spec.Release
	if source == nil {
		return Artifact{}, fmt.Errorf("%s does not declare an install source; install it from a release archive", spec.ID)
	}
	if source.Source == "local" {
		return LocalArtifact(spec.home, spec, source)
	}
	releases, err := d.releases(ctx, source.Repository)
	if err != nil {
		return Artifact{}, err
	}
	var assets []string
	for _, entry := range releases {
		if entry.Draft || (entry.Prerelease && !prerelease) {
			continue
		}
		candidate := version
		if candidate == "" {
			if candidate = registry.TagVersion(entry.TagName, source.Tag); candidate == "" {
				continue
			}
		} else if entry.TagName != registry.RenderTag(source.Tag, candidate) {
			continue
		}
		names := registry.AssetCandidates(source, candidate)
		tag := entry.TagName
		for _, name := range names {
			if len(assets) == 0 {
				assets = names
			}
			download, ok := entry.asset(name)
			if !ok {
				continue
			}
			if download == "" {
				download, _ = d.releaseAsset(source, tag, name)
			}
			// Every repository artifact is verified against the checksums asset
			// its manifest declares, so a manifest without one is rejected here
			// rather than installed unverified.
			if source.Checksums == "" {
				return Artifact{}, fmt.Errorf("%s does not declare a checksums asset; %s cannot be verified", spec.ID, name)
			}
			sum, err := d.checksum(ctx, source, tag, name)
			if err != nil {
				return Artifact{}, err
			}
			return Artifact{Version: candidate, Name: name, URL: download, SHA256: sum}, nil
		}
	}
	if version != "" {
		return Artifact{}, fmt.Errorf("%s %s is not available: release %q does not publish %s",
			spec.ID, version, registry.RenderTag(source.Tag, version), strings.Join(registry.AssetCandidates(source, version), " or "))
	}
	if len(assets) == 0 {
		return Artifact{}, fmt.Errorf("%s is not available for %s/%s in %s", spec.ID, registry.AssetOS, registry.AssetArch, source.Repository)
	}
	return Artifact{}, fmt.Errorf("%s is not available: %s does not publish %s in a matching release",
		spec.ID, source.Repository, strings.Join(registry.AssetCandidates(source, "{version}"), " or "))
}

// LocalArtifact resolves a component installed from a path on this machine.
func LocalArtifact(home string, spec Spec, source *registry.Install) (Artifact, error) {
	path, err := LocalPath(home, source.Path)
	if err != nil {
		return Artifact{}, err
	}
	info, err := os.Stat(path)
	if err != nil {
		return Artifact{}, fmt.Errorf("local artifact %s: %w", path, err)
	}
	artifact := Artifact{Version: filepath.Base(path), Name: info.Name(), Path: path, Local: true}
	switch {
	case info.IsDir():
		artifact.Dir = true
		if version := registry.ReadVersion(path); version != "" {
			artifact.Version = version
		}
	case info.Mode().IsRegular():
		if sum, err := fileSHA256(path); err == nil {
			artifact.SHA256 = sum
		}
		if version := archiveVersion(spec.Format(), path); version != "" {
			artifact.Version = version
		}
	default:
		return Artifact{}, fmt.Errorf("local artifact %s is neither a file nor a directory", path)
	}
	return artifact, nil
}

// checksum reads the SHA-256 the release publishes for one asset.
func (d Downloader) checksum(ctx context.Context, source *registry.Install, tag, asset string) (string, error) {
	name := source.Checksums
	url, ok := d.releaseAsset(source, tag, name)
	if !ok {
		return "", fmt.Errorf("release %s does not publish %s; %s cannot be verified", tag, name, asset)
	}
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		return "", err
	}
	response, err := d.client().Do(request)
	if err != nil {
		return "", fmt.Errorf("failed to download %s: %w", url, err)
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		return "", fmt.Errorf("failed to download %s: HTTP %d", url, response.StatusCode)
	}
	body, err := io.ReadAll(io.LimitReader(response.Body, 4<<20))
	if err != nil {
		return "", fmt.Errorf("failed to read %s: %w", url, err)
	}
	for _, line := range strings.Split(string(body), "\n") {
		fields := strings.Fields(line)
		if len(fields) < 2 {
			continue
		}
		listed := strings.TrimPrefix(fields[len(fields)-1], "*")
		if listed != asset {
			continue
		}
		sum := strings.ToLower(fields[0])
		if len(sum) != sha256.Size*2 {
			return "", fmt.Errorf("%s lists an invalid checksum for %s", name, asset)
		}
		if _, err := hex.DecodeString(sum); err != nil {
			return "", fmt.Errorf("%s lists an invalid checksum for %s", name, asset)
		}
		return sum, nil
	}
	return "", fmt.Errorf("%s does not list a checksum for %s", name, asset)
}

// assetURL is where a release asset is downloaded from.
func (d Downloader) releaseAsset(source *registry.Install, tag, name string) (string, bool) {
	return fmt.Sprintf("%s/%s/releases/download/%s/%s", d.base(), source.Repository, tag, name), true
}

// Install resolves and installs one component, returning the resulting status.
// It is a no-op when the installed version already matches, unless force is
// set. Progress lines, if any, go to progress.
func (d Downloader) Install(ctx context.Context, home string, e registry.Module, artifact Artifact, force bool, progress io.Writer) (Status, error) {
	return d.InstallSpec(ctx, ModuleSpec(home, e), artifact, force, progress)
}

// InstallSpec installs one component into the directory its spec describes. The
// artifact is staged next to that directory, its manifest is validated (kind,
// id, command tree) and only then replaces the installed component, so a broken
// or hostile archive leaves the previous install untouched.
func (d Downloader) InstallSpec(ctx context.Context, spec Spec, artifact Artifact, force bool, progress io.Writer) (Status, error) {
	status := spec.Inspect()
	if !force && status.Installed && artifact.Version != "" && status.Version == artifact.Version {
		return status, nil
	}
	if !artifact.Local && artifact.URL == "" {
		return Status{}, errors.New("artifact has no download URL")
	}
	if err := os.MkdirAll(filepath.Dir(spec.Root), 0o755); err != nil {
		return Status{}, err
	}
	staging, err := os.MkdirTemp(filepath.Dir(spec.Root), "."+spec.ID+".install-*")
	if err != nil {
		return Status{}, err
	}
	defer os.RemoveAll(staging)
	switch {
	case artifact.Dir:
		if progress != nil {
			fmt.Fprintf(progress, "Installing %s\n", artifact.Path)
		}
		if err := copyTree(artifact.Path, staging); err != nil {
			return Status{}, err
		}
	default:
		archive, err := d.fetch(ctx, spec, artifact, progress)
		if err != nil {
			return Status{}, err
		}
		defer os.Remove(archive)
		if err := extractArchive(spec.Format(), archive, staging, progress); err != nil {
			return Status{}, fmt.Errorf("downloaded but not a readable archive: %w", err)
		}
	}
	version, err := spec.adopt(staging, artifact.Version)
	if err != nil {
		return Status{}, err
	}
	if err := swapDir(staging, spec.Root); err != nil {
		return Status{}, err
	}
	status = spec.Inspect()
	if status.Version == "" {
		status = Status{ID: spec.ID, Installed: true, Path: filepath.Join(spec.Root, spec.Entry), Version: version}
	}
	if progress != nil {
		fmt.Fprintf(progress, "Installed %s %s at %s\n", spec.ID, status.Version, spec.Root)
	}
	return status, nil
}

// adopt validates the freshly extracted component and writes its decx.json and
// VERSION files. The manifest decides the version, the archive only provides
// it, so a release that forgot to bump its manifest is still visible.
func (s Spec) adopt(staging, fallback string) (string, error) {
	manifest, found, err := registry.ReadManifest(staging)
	if err != nil {
		return "", fmt.Errorf("%s: invalid %s: %w", s.ID, registry.ManifestName, err)
	}
	if !found {
		return "", fmt.Errorf("%s: the artifact does not contain a %s manifest", s.ID, registry.ManifestName)
	}
	if manifest.ID != s.ID {
		return "", fmt.Errorf("the artifact carries %s, expected %s", manifest.ID, s.ID)
	}
	if manifest.Kind != s.Kind {
		return "", fmt.Errorf("the artifact is a %s, expected a %s", manifest.Kind, s.Kind)
	}
	if err := manifest.Validate(); err != nil {
		return "", fmt.Errorf("%s: invalid manifest: %w", s.ID, err)
	}
	version := registry.ReadVersion(staging)
	if manifest.Version != "" {
		version = manifest.Version
	}
	if version == "" {
		version = fallback
	}
	if version == "" {
		return "", fmt.Errorf("%s: the artifact does not declare a version", s.ID)
	}
	if err := registry.WriteVersion(staging, version); err != nil {
		return "", err
	}
	if err := registry.WriteManifest(staging, *manifest); err != nil {
		return "", err
	}
	entry := manifest.Entry
	if manifest.Kind == registry.KindServer {
		entry = filepath.ToSlash(manifest.Binary.Path)
	}
	// The manifest the archive ships is the runtime definition, so an archive
	// whose launcher disagrees with the requested target is rejected instead of
	// silently installing something the CLI would not run.
	if s.Entry != "" && filepath.FromSlash(entry) != s.Entry {
		return "", fmt.Errorf("%s: the artifact launches %s, the component expects %s", s.ID, entry, filepath.ToSlash(s.Entry))
	}
	if err := os.Chmod(filepath.Join(staging, filepath.FromSlash(entry)), 0o755); err != nil {
		return "", err
	}
	return version, nil
}

// fetch stages a download or a local artifact as a file and verifies its
// SHA-256. Local files are hashed by the caller; downloads are hashed while
// they are written, so a truncated transfer can never be installed.
func (d Downloader) fetch(ctx context.Context, spec Spec, artifact Artifact, progress io.Writer) (string, error) {
	file, err := os.CreateTemp("", "decx-install-*")
	if err != nil {
		return "", err
	}
	path := file.Name()
	if artifact.Local {
		if _, err := copyFile(artifact.Path, file); err != nil {
			file.Close()
			os.Remove(path)
			return "", err
		}
	} else {
		if progress == nil {
			progress = io.Discard
		}
		if _, err := d.download(ctx, artifact.URL, file, progress); err != nil {
			file.Close()
			os.Remove(path)
			return "", err
		}
	}
	if err := file.Close(); err != nil {
		os.Remove(path)
		return "", err
	}
	if !artifact.Local && artifact.SHA256 == "" {
		os.Remove(path)
		return "", fmt.Errorf("%s has no SHA-256 checksum; the download was discarded", artifact.Name)
	}
	if artifact.SHA256 != "" {
		sum, err := fileSHA256(path)
		if err != nil {
			os.Remove(path)
			return "", err
		}
		if !strings.EqualFold(sum, artifact.SHA256) {
			os.Remove(path)
			return "", fmt.Errorf("checksum mismatch for %s: got %s, expected %s (the download was discarded)", artifact.Name, sum, artifact.SHA256)
		}
	}
	return path, nil
}

// download streams url into file, reporting a heartbeat roughly every 15s.
func (d Downloader) download(ctx context.Context, url string, file *os.File, progress io.Writer) (int64, error) {
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		return 0, err
	}
	response, err := d.client().Do(request)
	if err != nil {
		return 0, fmt.Errorf("failed to download %s: %w", url, err)
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		return 0, fmt.Errorf("failed to download %s: HTTP %d", url, response.StatusCode)
	}
	start := time.Now()
	var written int64
	buffer := make([]byte, 64*1024)
	for {
		read, readErr := response.Body.Read(buffer)
		if read > 0 {
			if _, writeErr := file.Write(buffer[:read]); writeErr != nil {
				return written, writeErr
			}
			written += int64(read)
		}
		if readErr != nil {
			if errors.Is(readErr, io.EOF) {
				return written, nil
			}
			return written, fmt.Errorf("failed to download %s: %w", url, readErr)
		}
		if progress != nil && time.Since(start) > 15*time.Second {
			fmt.Fprintf(progress, "  %s downloaded so far\n", humanBytes(written))
			start = time.Now()
		}
	}
}

// LocalPath resolves the path of a local install against DECX_HOME. Absolute
// paths and ~/ paths name files anywhere; a relative path is read next to
// DECX_HOME so a manifest stays independent of the working directory.
func LocalPath(home, value string) (string, error) {
	if strings.HasPrefix(value, "~/") {
		base, err := os.UserHomeDir()
		if err != nil {
			return "", err
		}
		return filepath.Join(base, filepath.FromSlash(strings.TrimPrefix(value, "~/"))), nil
	}
	if filepath.IsAbs(value) {
		return filepath.Clean(value), nil
	}
	joined := filepath.Join(home, filepath.FromSlash(value))
	if rel, err := filepath.Rel(home, joined); err != nil || rel == ".." || strings.HasPrefix(rel, ".."+string(filepath.Separator)) {
		return "", fmt.Errorf("local path %q escapes DECX_HOME", value)
	}
	return joined, nil
}

// swapDir replaces the component directory with a staged one, keeping the
// previous install until the new one is in place.
func swapDir(staging, root string) error {
	old := ""
	if _, err := os.Lstat(root); err == nil {
		old = fmt.Sprintf("%s.old-%d", root, time.Now().UnixNano())
		if err := os.Rename(root, old); err != nil {
			return err
		}
	}
	if err := os.Rename(staging, root); err != nil {
		if old != "" {
			_ = os.Rename(old, root)
		}
		return err
	}
	if old != "" {
		_ = os.RemoveAll(old)
	}
	return nil
}

// copyTree copies a directory (a component built in the working tree) into the
// staging directory.
func copyTree(from, to string) error { return copyTreeFiltered(from, to, nil) }

// copyTreeFiltered copies a directory, optionally skipping entries by name
// (imports skip VCS metadata, dependency caches and build leftovers).
func copyTreeFiltered(from, to string, skip func(name string) bool) error {
	return filepath.WalkDir(from, func(path string, entry os.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if path != from && skip != nil && skip(entry.Name()) {
			if entry.IsDir() {
				return filepath.SkipDir
			}
			return nil
		}
		rel, err := filepath.Rel(from, path)
		if err != nil {
			return err
		}
		if rel == "." {
			return nil
		}
		target := filepath.Join(to, rel)
		if entry.IsDir() {
			return os.MkdirAll(target, 0o755)
		}
		if entry.Type()&os.ModeSymlink != 0 {
			link, err := os.Readlink(path)
			if err != nil {
				return err
			}
			return os.Symlink(link, target)
		}
		info, err := entry.Info()
		if err != nil {
			return err
		}
		source, err := os.Open(path)
		if err != nil {
			return err
		}
		defer source.Close()
		if err := os.MkdirAll(filepath.Dir(target), 0o755); err != nil {
			return err
		}
		file, err := os.OpenFile(target, os.O_WRONLY|os.O_CREATE|os.O_TRUNC, info.Mode().Perm())
		if err != nil {
			return err
		}
		_, copyErr := io.Copy(file, source)
		return errors.Join(copyErr, file.Close())
	})
}

// copyFile stages a local artifact next to its destination.
func copyFile(from string, to *os.File) (int64, error) {
	source, err := os.Open(from)
	if err != nil {
		return 0, err
	}
	defer source.Close()
	return io.Copy(to, source)
}

// fileSHA256 hashes a file on disk.
func fileSHA256(path string) (string, error) {
	file, err := os.Open(path)
	if err != nil {
		return "", err
	}
	defer file.Close()
	hash := sha256.New()
	if _, err := io.Copy(hash, file); err != nil {
		return "", err
	}
	return hex.EncodeToString(hash.Sum(nil)), nil
}

// archiveVersion reads the VERSION file stored inside a local archive, so
// reinstalling the same build is skipped just like a release download.
func archiveVersion(format, path string) string {
	if !isArchiveFormat(format) {
		return ""
	}
	staging, err := os.MkdirTemp("", "decx-version-*")
	if err != nil {
		return ""
	}
	defer os.RemoveAll(staging)
	if err := extractArchive(format, path, staging, nil); err != nil {
		return ""
	}
	return registry.ReadVersion(staging)
}

func isArchiveFormat(format string) bool { return format == "zip" || format == "tar.gz" }

func humanBytes(size int64) string {
	switch {
	case size >= 1<<30:
		return fmt.Sprintf("%.1f GiB", float64(size)/(1<<30))
	case size >= 1<<20:
		return fmt.Sprintf("%.1f MiB", float64(size)/(1<<20))
	case size >= 1<<10:
		return fmt.Sprintf("%.1f KiB", float64(size)/(1<<10))
	default:
		return fmt.Sprintf("%d B", size)
	}
}
