package install

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strings"

	"github.com/jygzyc/decx/decx/internal/registry"
)

// Repository is a repository reference parsed from a `--module` source:
// owner/repo, optionally with a ref, optionally with an explicit host.
type Repository struct {
	Repo   string // owner/repo
	Ref    string // branch, tag or commit ("" = the repository default branch)
	Host   string // host[:port] when the source named one
	Scheme string // http or https
}

// ParseRepository reports whether value names a repository rather than a local
// path. Accepted forms are owner/repo, owner/repo@ref, github.com/owner/repo
// and https://host/owner/repo (with an optional @ref).
func ParseRepository(value string) (Repository, bool) {
	raw := strings.TrimSpace(value)
	if raw == "" {
		return Repository{}, false
	}
	repository := Repository{Scheme: "https"}
	if at := strings.LastIndex(raw, "@"); at > 0 {
		repository.Ref = raw[at+1:]
		raw = raw[:at]
	}
	if scheme := strings.Index(raw, "://"); scheme > 0 {
		repository.Scheme = strings.ToLower(raw[:scheme])
		if repository.Scheme != "http" && repository.Scheme != "https" {
			return Repository{}, false
		}
		raw = raw[scheme+3:]
	}
	raw = strings.TrimSuffix(strings.TrimSuffix(raw, "/"), ".git")
	if raw == "" || strings.ContainsAny(raw, "\\ \t") {
		return Repository{}, false
	}
	parts := strings.Split(raw, "/")
	switch len(parts) {
	case 2:
		if !validRepoSegment(parts[0]) || !validRepoSegment(parts[1]) {
			return Repository{}, false
		}
		repository.Repo = parts[0] + "/" + parts[1]
		return repository, true
	case 3:
		if !validRepositoryHost(parts[0]) || !validRepoSegment(parts[1]) || !validRepoSegment(parts[2]) {
			return Repository{}, false
		}
		repository.Host = parts[0]
		repository.Repo = parts[1] + "/" + parts[2]
		return repository, true
	default:
		return Repository{}, false
	}
}

func validRepoSegment(segment string) bool {
	return segment != "" && segment != "." && segment != ".." && !strings.ContainsAny(segment, "/\\")
}

func validRepositoryHost(host string) bool {
	if host == "" || strings.HasPrefix(host, ".") || strings.HasSuffix(host, ".") || strings.Contains(host, "..") {
		return false
	}
	return strings.Contains(host, ".") || strings.Contains(host, ":")
}

// ImportPath imports a module from a directory or an archive file on this
// machine, recording the absolution path as its origin.
func ImportPath(home, value string, progress io.Writer) (Status, error) {
	path, err := filepath.Abs(value)
	if err != nil {
		return Status{}, err
	}
	info, err := os.Stat(path)
	if err != nil {
		return Status{}, err
	}
	source := registry.Source{Source: "path", Value: path}
	if info.IsDir() {
		return importDirectory(home, source, path, progress)
	}
	if info.Mode().IsRegular() {
		format := archiveFormat(path)
		if format == "" {
			return Status{}, fmt.Errorf("%s is not an archive (.zip or .tar.gz)", path)
		}
		return importArchive(home, source, path, format, progress)
	}
	return Status{}, fmt.Errorf("%s is neither a directory nor an archive", path)
}

// ImportRepository downloads a repository archive and imports the module it
// carries, recording the repository and the resolved ref as its origin.
func (d Downloader) ImportRepository(ctx context.Context, home, value string, progress io.Writer) (Status, error) {
	repository, ok := ParseRepository(value)
	if !ok {
		return Status{}, fmt.Errorf("%s is not a repository (use owner/repo or a repository URL)", value)
	}
	return d.importRepository(ctx, home, repository, value, progress)
}

// ReimportSource re-imports a module from a recorded install origin. A recorded
// ref pins repository imports to the revision that was installed.
func (d Downloader) ReimportSource(ctx context.Context, home string, source registry.Source, progress io.Writer) (Status, error) {
	switch source.Source {
	case "repo":
		repository, ok := ParseRepository(source.Value)
		if !ok {
			return Status{}, fmt.Errorf("recorded module source %s is not a repository", source.Value)
		}
		if source.Ref != "" {
			repository.Ref = source.Ref
		}
		return d.importRepository(ctx, home, repository, source.Value, progress)
	case "path":
		return ImportPath(home, source.Value, progress)
	}
	return Status{}, fmt.Errorf("unknown recorded module source %q", source.Source)
}

func (d Downloader) importRepository(ctx context.Context, home string, repository Repository, value string, progress io.Writer) (Status, error) {
	archive, ref, format, err := d.DownloadRepository(ctx, repository, progress)
	if err != nil {
		return Status{}, err
	}
	defer os.Remove(archive)
	return importArchive(home, registry.Source{Source: "repo", Value: value, Ref: ref}, archive, format, progress)
}

// DownloadRepository resolves the repository archive for the requested ref,
// defaulting to the repository default branch. GitHub archives come from
// codeload; any other host is asked for its own head archive first and its
// generic ref archive second. It returns the downloaded archive, the ref that
// was actually used and the archive format.
func (d Downloader) DownloadRepository(ctx context.Context, repository Repository, progress io.Writer) (string, string, string, error) {
	ref := repository.Ref
	if ref == "" {
		branch, err := d.defaultBranch(ctx, repository.Repo)
		if err != nil {
			return "", "", "", err
		}
		ref = branch
	}
	base := d.base()
	if repository.Host != "" {
		scheme := repository.Scheme
		if scheme == "" {
			scheme = "https"
		}
		base = scheme + "://" + repository.Host
	}
	var candidates []string
	if isGitHub(base) {
		candidates = append(candidates, fmt.Sprintf("https://codeload.github.com/%s/zip/%s", repository.Repo, ref))
	} else {
		candidates = append(candidates,
			fmt.Sprintf("%s/%s/archive/refs/heads/%s.zip", base, repository.Repo, ref),
			fmt.Sprintf("%s/%s/archive/%s.tar.gz", base, repository.Repo, ref),
		)
	}
	archive, address, err := d.fetchFirst(ctx, candidates, progress)
	if err != nil {
		return "", "", "", err
	}
	format := "tar.gz"
	if strings.HasSuffix(address, ".zip") {
		format = "zip"
	}
	return archive, ref, format, nil
}

func isGitHub(base string) bool {
	parsed, err := url.Parse(base)
	return err == nil && strings.EqualFold(parsed.Hostname(), "github.com")
}

// defaultBranch asks the release host which branch a repository uses.
func (d Downloader) defaultBranch(ctx context.Context, repository string) (string, error) {
	address := fmt.Sprintf("%s/repos/%s", d.apiBase(), repository)
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, address, nil)
	if err != nil {
		return "", err
	}
	request.Header.Set("Accept", "application/vnd.github+json")
	response, err := d.client().Do(request)
	if err != nil {
		return "", fmt.Errorf("failed to reach %s: %w", address, err)
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		return "", fmt.Errorf("failed to read %s: HTTP %d", address, response.StatusCode)
	}
	var payload struct {
		DefaultBranch string `json:"default_branch"`
	}
	if err := json.NewDecoder(io.LimitReader(response.Body, 4<<20)).Decode(&payload); err != nil {
		return "", fmt.Errorf("failed to read %s: %w", address, err)
	}
	if payload.DefaultBranch == "" {
		return "", fmt.Errorf("%s does not report a default branch", repository)
	}
	return payload.DefaultBranch, nil
}

// errNotFound marks the archive candidate a host does not publish, so the next
// candidate can be tried.
var errNotFound = errors.New("archive not found")

// fetchFirst downloads the first candidate URL that answers with a body and
// reports the address that served it.
func (d Downloader) fetchFirst(ctx context.Context, candidates []string, progress io.Writer) (string, string, error) {
	var last error
	for _, address := range candidates {
		file, err := os.CreateTemp("", "decx-import-*")
		if err != nil {
			return "", "", err
		}
		path := file.Name()
		if progress != nil {
			fmt.Fprintf(progress, "Downloading %s\n", address)
		}
		err = d.fetchArchive(ctx, address, file)
		if closeErr := file.Close(); err == nil {
			err = closeErr
		}
		if err == nil {
			return path, address, nil
		}
		os.Remove(path)
		if errors.Is(err, errNotFound) {
			last = err
			continue
		}
		return "", "", err
	}
	if last == nil {
		last = errors.New("no repository archive candidate")
	}
	return "", "", fmt.Errorf("failed to download %s: %w", candidates[len(candidates)-1], last)
}

// fetchArchive streams one repository archive into file, distinguishing a
// missing candidate (404) from a real failure.
func (d Downloader) fetchArchive(ctx context.Context, address string, file *os.File) error {
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, address, nil)
	if err != nil {
		return err
	}
	response, err := d.client().Do(request)
	if err != nil {
		return fmt.Errorf("failed to download %s: %w", address, err)
	}
	defer response.Body.Close()
	if response.StatusCode == http.StatusNotFound {
		return errNotFound
	}
	if response.StatusCode != http.StatusOK {
		return fmt.Errorf("failed to download %s: HTTP %d", address, response.StatusCode)
	}
	if _, err := io.Copy(file, response.Body); err != nil {
		return fmt.Errorf("failed to download %s: %w", address, err)
	}
	return nil
}

// importArchive extracts an archive and installs the module tree it carries.
func importArchive(home string, source registry.Source, archive, format string, progress io.Writer) (Status, error) {
	work, err := stagingWork(home)
	if err != nil {
		return Status{}, err
	}
	defer os.RemoveAll(work)
	if progress != nil {
		fmt.Fprintf(progress, "Importing %s\n", source.Value)
	}
	if err := extractArchive(format, archive, work, progress); err != nil {
		return Status{}, fmt.Errorf("%s is not a readable archive: %w", archive, err)
	}
	tree := componentTree(work)
	if tree == "" {
		return Status{}, fmt.Errorf("%s does not contain a %s manifest at its root or in a single top-level directory",
			archive, registry.ManifestName)
	}
	return finalizeImport(home, source, tree, progress)
}

// importDirectory copies a component directory into the module root, skipping
// version-control metadata, dependency caches and build leftovers.
func importDirectory(home string, source registry.Source, dir string, progress io.Writer) (Status, error) {
	tree := componentTree(dir)
	if tree == "" {
		return Status{}, fmt.Errorf("%s does not contain a %s manifest at its root or in a single top-level directory",
			dir, registry.ManifestName)
	}
	work, err := stagingWork(home)
	if err != nil {
		return Status{}, err
	}
	defer os.RemoveAll(work)
	if progress != nil {
		fmt.Fprintf(progress, "Importing %s\n", source.Value)
	}
	if err := copyTreeFiltered(tree, work, skipImportEntry); err != nil {
		return Status{}, err
	}
	return finalizeImport(home, source, work, progress)
}

// stagingWork creates a disposable directory next to the module root so the
// final module directory can be renamed into place atomically.
func stagingWork(home string) (string, error) {
	root := registry.ModuleRoot(home, "")
	if err := os.MkdirAll(root, 0o755); err != nil {
		return "", err
	}
	return os.MkdirTemp(root, ".decx-import-*")
}

// componentTree reports the directory that carries the manifest: the tree root
// itself or its single top-level directory.
func componentTree(root string) string {
	if _, found, err := registry.ReadManifest(root); err == nil && found {
		return root
	}
	entries, err := os.ReadDir(root)
	if err != nil {
		return ""
	}
	var dirs []string
	for _, entry := range entries {
		if entry.IsDir() {
			dirs = append(dirs, entry.Name())
		}
	}
	if len(dirs) != 1 {
		return ""
	}
	inner := filepath.Join(root, dirs[0])
	if _, found, err := registry.ReadManifest(inner); err == nil && found {
		return inner
	}
	return ""
}

// finalizeImport validates the staged tree, records its version and origin and
// atomically replaces the installed module.
func finalizeImport(home string, source registry.Source, tree string, progress io.Writer) (Status, error) {
	manifest, found, err := registry.ReadManifest(tree)
	if err != nil {
		return Status{}, fmt.Errorf("invalid %s: %w", registry.ManifestName, err)
	}
	if !found {
		return Status{}, fmt.Errorf("the import does not contain a %s manifest", registry.ManifestName)
	}
	if err := manifest.Validate(); err != nil {
		return Status{}, fmt.Errorf("%s: invalid manifest: %w", manifest.ID, err)
	}
	entry := manifest.Entry
	if manifest.Kind == registry.KindServer {
		entry = filepath.ToSlash(manifest.Binary.Path)
	}
	entryPath := filepath.Join(tree, filepath.FromSlash(entry))
	if info, err := os.Stat(entryPath); err != nil || !info.Mode().IsRegular() {
		return Status{}, fmt.Errorf("%s: the entry %s is missing from the import", manifest.ID, entry)
	}
	if err := os.Chmod(entryPath, 0o755); err != nil {
		return Status{}, err
	}
	// The artifact's VERSION file wins; the manifest is only a fallback.
	version := registry.ReadVersion(tree)
	if version == "" {
		version = strings.TrimSpace(manifest.Version)
	}
	if version != "" {
		if err := registry.WriteVersion(tree, version); err != nil {
			return Status{}, err
		}
	}
	if err := registry.WriteSource(tree, source); err != nil {
		return Status{}, err
	}
	root := registry.ModuleRoot(home, manifest.ID)
	if err := swapDir(tree, root); err != nil {
		return Status{}, err
	}
	if progress != nil {
		fmt.Fprintf(progress, "Installed %s %s at %s\n", manifest.ID, version, root)
	}
	return Status{ID: manifest.ID, Installed: true, Path: filepath.Join(root, filepath.FromSlash(entry)), Version: version}, nil
}

// skipImportEntry is the directory import skip list.
func skipImportEntry(name string) bool {
	switch name {
	case ".git", "node_modules", "__pycache__", ".build", ".DS_Store":
		return true
	}
	return false
}

// archiveFormat names the archive format of a file, or "" when it is none.
func archiveFormat(path string) string {
	switch {
	case strings.HasSuffix(path, ".zip"):
		return "zip"
	case strings.HasSuffix(path, ".tar.gz"), strings.HasSuffix(path, ".tgz"):
		return "tar.gz"
	}
	return ""
}
