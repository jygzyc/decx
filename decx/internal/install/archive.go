package install

import (
	"context"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"os"
	"path/filepath"
	"strings"

	"github.com/mholt/archives"
)

// Archive limits protect the install step from hostile or broken assets. The
// largest expected component (a Kuna build with compiled specs) stays far
// below these bounds.
const (
	maxArchiveBytes   = 2 << 30 // 2 GiB extracted
	maxArchiveEntries = 100_000
)

// createSymlink is replaceable for tests that exercise the Windows fallback.
var createSymlink = os.Symlink

// pendingLink is a symlink whose creation failed during extraction; it is
// resolved once the whole archive has been written, because the target may
// appear later in the stream.
type pendingLink struct {
	name string // entry name in the archive, for warnings
	path string // destination path of the link
	link string // raw link target from the archive
}

// extractArchive extracts a downloaded zip or tar.gz asset into destDir. The
// destination must be a fresh directory owned by the caller; every entry is
// validated so an archive can never write outside destDir. Only the two
// supported formats are accepted, never whatever the file claims to be.
// Problems with individual entries that cannot fail the install (an
// unrepresentable symlink) are reported on warn, which may be nil.
func extractArchive(format, archivePath, destDir string, warn io.Writer) error {
	var extractor archives.Extractor
	switch format {
	case "zip":
		extractor = archives.Zip{}
	case "tar.gz":
		// Compression is how the stream is unwrapped; Extraction is the
		// format the library must parse afterwards.
		extractor = archives.CompressedArchive{Extraction: archives.Tar{}, Compression: archives.Gz{}}
	default:
		return fmt.Errorf("unsupported archive format %q", format)
	}
	file, err := os.Open(archivePath)
	if err != nil {
		return err
	}
	defer file.Close()
	entries := 0
	var budget int64 = maxArchiveBytes
	var links []pendingLink
	handleFile := func(_ context.Context, info archives.FileInfo) error {
		entries++
		if entries > maxArchiveEntries {
			return fmt.Errorf("archive has too many entries (limit %d)", maxArchiveEntries)
		}
		// The library passes entry names through unsanitized, so every entry
		// is resolved against destDir before it touches the filesystem.
		target, err := archiveTarget(destDir, info.NameInArchive)
		if err != nil {
			return err
		}
		mode := info.Mode()
		switch {
		case info.IsDir():
			return os.MkdirAll(target, 0o755)
		case mode&fs.ModeSymlink != 0:
			// A symlink target is relative to the link's own directory, so
			// resolve it there and never create a link that escapes destDir.
			if _, err := linkTargetPath(destDir, target, info.LinkTarget); err != nil {
				warnSkipped(warn, info.NameInArchive, err)
				return nil
			}
			if err := os.MkdirAll(filepath.Dir(target), 0o755); err != nil {
				return err
			}
			// Creating symlinks fails on Windows without developer mode, so
			// remember failures instead of aborting the import.
			if err := createSymlink(info.LinkTarget, target); err != nil {
				links = append(links, pendingLink{name: info.NameInArchive, path: target, link: info.LinkTarget})
			}
			return nil
		case info.LinkTarget != "":
			// Hard links point at another entry and carry no payload of their own.
			return nil
		case mode.IsRegular():
			if err := os.MkdirAll(filepath.Dir(target), 0o755); err != nil {
				return err
			}
			source, err := info.Open()
			if err != nil {
				return err
			}
			err = writeArchiveFile(target, source, archiveMode(mode), &budget)
			if closeErr := source.Close(); err == nil {
				err = closeErr
			}
			return err
		default:
			// Devices, fifos and metadata entries carry nothing to install.
			return nil
		}
	}
	if err := extractor.Extract(context.Background(), file, handleFile); err != nil {
		return fmt.Errorf("failed to read %s archive: %w", format, err)
	}
	// Links that could not be created are resolved now that every entry is on
	// disk: the fallback copy needs targets that may appear later in the
	// archive, and a target that is missing or not a regular file is skipped
	// with a warning instead of failing the import.
	for _, link := range links {
		if err := copyLinkTarget(destDir, link, &budget); err != nil {
			warnSkipped(warn, link.name, err)
		}
	}
	return nil
}

// linkTargetPath resolves a symlink target relative to the link's directory
// and confines the result to destDir.
func linkTargetPath(destDir, linkPath, linkTarget string) (string, error) {
	resolved := filepath.Clean(filepath.Join(filepath.Dir(linkPath), filepath.FromSlash(linkTarget)))
	rel, err := filepath.Rel(destDir, resolved)
	if err != nil {
		return "", err
	}
	if rel == ".." || strings.HasPrefix(rel, ".."+string(filepath.Separator)) {
		return "", fmt.Errorf("symlink target %q escapes the install directory", linkTarget)
	}
	return resolved, nil
}

// copyLinkTarget replaces a symlink that could not be created (Windows
// without developer mode) with a copy of its target, provided that target is
// a regular file inside the extracted tree.
func copyLinkTarget(destDir string, link pendingLink, budget *int64) error {
	resolved, err := linkTargetPath(destDir, link.path, link.link)
	if err != nil {
		return err
	}
	info, err := os.Stat(resolved)
	if err != nil {
		return fmt.Errorf("symlink target %q is missing: %w", link.link, err)
	}
	if !info.Mode().IsRegular() {
		return fmt.Errorf("symlink target %q is not a regular file", link.link)
	}
	source, err := os.Open(resolved)
	if err != nil {
		return err
	}
	defer source.Close()
	return writeArchiveFile(link.path, source, archiveMode(info.Mode()), budget)
}

// warnSkipped reports an entry that was left out without failing the import:
// a single unrepresentable entry must not break a whole component.
func warnSkipped(warn io.Writer, name string, err error) {
	if warn == nil {
		return
	}
	fmt.Fprintf(warn, "warning: skipping symlink %s: %v\n", name, err)
}

// archiveTarget resolves one archive entry against destDir, rejecting absolute
// paths, parent traversal and empty names.
func archiveTarget(destDir, name string) (string, error) {
	cleaned := filepath.Clean(filepath.FromSlash(name))
	if cleaned == "." || cleaned == "" {
		return "", fmt.Errorf("archive contains an entry without a name")
	}
	if filepath.IsAbs(cleaned) || strings.HasPrefix(cleaned, ".."+string(filepath.Separator)) || cleaned == ".." {
		return "", fmt.Errorf("archive entry %q escapes the install directory", name)
	}
	return filepath.Join(destDir, cleaned), nil
}

func archiveMode(mode os.FileMode) os.FileMode {
	perm := mode.Perm()
	if perm == 0 {
		perm = 0o644
	}
	return perm
}

// writeArchiveFile copies one entry while enforcing the extraction budget.
func writeArchiveFile(target string, source io.Reader, mode os.FileMode, budget *int64) error {
	file, err := os.OpenFile(target, os.O_WRONLY|os.O_CREATE|os.O_TRUNC, mode)
	if err != nil {
		return err
	}
	written, err := io.Copy(file, io.LimitReader(source, *budget+1))
	closeErr := file.Close()
	if err == nil {
		err = closeErr
	}
	if err != nil {
		return err
	}
	if written > *budget {
		return errors.New("archive exceeds the extraction size limit")
	}
	*budget -= written
	return nil
}
