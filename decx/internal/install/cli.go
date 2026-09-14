package install

import (
	"context"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"runtime"
	"strings"

	"github.com/jygzyc/decx/decx/internal/registry"
	"github.com/minio/selfupdate"
)

// DefaultRepository publishes the DECX release assets: the CLI archives, the
// engine servers and the optional plugins.
const DefaultRepository = "jygzyc/decx"

// CLIStatus reports the outcome of replacing the decx executable.
type CLIStatus struct {
	ID      string `json:"id"`
	Updated bool   `json:"updated"`
	Version string `json:"version,omitempty"`
	Path    string `json:"path,omitempty"`
	Message string `json:"message,omitempty"`
}

// CLIUpdate describes one self-replacement attempt. Executable overrides the
// running binary; an empty value resolves it through os.Executable.
type CLIUpdate struct {
	CurrentVersion string
	Executable     string
	Force          bool
	Prerelease     bool
}

// cliSource describes the CLI release archive as a regular install source so
// release resolution, asset templates and fallbacks stay in one place.
func cliSource() *registry.Install {
	extension := ".tar.gz"
	if registry.AssetOS == "windows" {
		extension = ".zip"
	}
	return &registry.Install{
		Source:     "repo",
		Repository: DefaultRepository,
		Tag:        "v{version}",
		Asset:      "decx-cli-{version}-{os}-{arch}" + extension,
		Checksums:  "SHA256SUMS",
	}
}

// cliSpec describes the CLI archive as a regular install spec so release
// resolution, asset templates and checksums stay in one place.
func cliSpec(source *registry.Install) Spec {
	return Spec{ID: "decx-cli", Kind: "program", Release: source}
}

// CLIArtifact resolves the newest published CLI archive for this platform.
func (d Downloader) CLIArtifact(ctx context.Context, prerelease bool) (Artifact, error) {
	return d.Resolve(ctx, cliSpec(cliSource()), "", prerelease)
}

// UpdateCLI replaces the decx executable with the newest release archive. The
// replacement is skipped when the running version already matches, unless
// update.Force is set. Archives are verified by extracting the executable and
// swapping it into place only after the download succeeded, so a failed update
// leaves the previous binary untouched.
func (d Downloader) UpdateCLI(ctx context.Context, update CLIUpdate, progress io.Writer) (CLIStatus, error) {
	source := cliSource()
	artifact, err := d.Resolve(ctx, cliSpec(source), "", update.Prerelease)
	if err != nil {
		return CLIStatus{}, err
	}
	if !update.Force && update.CurrentVersion != "" && update.CurrentVersion == artifact.Version {
		return CLIStatus{ID: "decx-cli", Version: artifact.Version, Message: "already up to date"}, nil
	}
	target, err := executable(update.Executable)
	if err != nil {
		return CLIStatus{}, err
	}
	dir := filepath.Dir(target)
	archive, err := d.fetch(ctx, cliSpec(source), artifact, progress)
	if err != nil {
		return CLIStatus{}, err
	}
	defer os.Remove(archive)
	format := "tar.gz"
	if strings.HasSuffix(artifact.Name, ".zip") {
		format = "zip"
	}
	staging, err := os.MkdirTemp(dir, ".decx-cli-update-*")
	if err != nil {
		return CLIStatus{}, err
	}
	defer os.RemoveAll(staging)
	if err := extractArchive(format, archive, staging, progress); err != nil {
		return CLIStatus{}, fmt.Errorf("%s is not a usable release archive: %w", artifact.Name, err)
	}
	binary := filepath.Join(staging, "decx")
	if runtime.GOOS == "windows" {
		binary += ".exe"
	}
	if info, err := os.Stat(binary); err != nil || !info.Mode().IsRegular() {
		return CLIStatus{}, fmt.Errorf("%s does not contain the decx executable", artifact.Name)
	}
	next, err := os.Open(binary)
	if err != nil {
		return CLIStatus{}, err
	}
	defer next.Close()
	// selfupdate writes the replacement next to the target and keeps the
	// previous binary until the swap succeeds, restoring it on failure.
	if err := selfupdate.Apply(next, selfupdate.Options{TargetPath: target, TargetMode: 0o755}); err != nil {
		return CLIStatus{}, fmt.Errorf("cannot replace %s: %w", target, err)
	}
	if progress != nil {
		fmt.Fprintf(progress, "Installed decx %s at %s\n", artifact.Version, target)
	}
	return CLIStatus{ID: "decx-cli", Updated: true, Version: artifact.Version, Path: target}, nil
}

// inTempDir reports whether path lies inside the temporary directory. The path
// is compared against the cleanup prefix including the separator, so a binary
// at /tmpfoo/decx is not mistaken for a build output in /tmp.
func inTempDir(path string) bool {
	temp := filepath.Clean(os.TempDir())
	return path == temp || strings.HasPrefix(path, temp+string(filepath.Separator))
}

// executable resolves the running binary and refuses obviously temporary
// build outputs, unless the caller passed an explicit path.
func executable(explicit string) (string, error) {
	if explicit == "" {
		path, err := os.Executable()
		if err != nil {
			return "", err
		}
		path, err = filepath.EvalSymlinks(path)
		if err != nil {
			return "", err
		}
		if inTempDir(path) {
			return "", fmt.Errorf("decx runs from the temporary directory %s; install it from a release archive before updating", path)
		}
		return path, nil
	}
	path, err := filepath.Abs(explicit)
	if err != nil {
		return "", err
	}
	return path, nil
}
