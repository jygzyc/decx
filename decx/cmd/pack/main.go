// Command pack builds the DECX CLI release archive for a target platform.
//
// The CLI embeds the QuickJS plugin engine, which needs cgo, so an archive
// must be produced with a C toolchain built for the target: release-cli.yml
// runs this command once per native runner and the publish job merges the
// per-platform checksum files. A cross target is only accepted when CC points
// at a matching cross toolchain - plain cgo cannot cross-compile otherwise.
// Everything is produced here - the version-stamped binary, the archive and its
// SHA-256 - so no external zip, tar or sha256 tooling is required.
//
// Usage (from the decx module directory):
//
//	go run ./cmd/pack
//	go run ./cmd/pack --os linux --arch amd64
//	OUT_OS=linux OUT_ARCH=amd64 go run ./cmd/pack
//
// Output: $OUT_DIR/decx-cli-<version>-<os>-<arch>.tar.gz
//
//	($OUT_DIR/decx-cli-<version>-<os>-<arch>.zip on Windows)
//	plus one line per archive in $OUT_DIR/SHA256SUMS
//
// Archive layout:
//
//	decx        CLI binary (decx.exe on Windows)
//	README.md   CLI usage
//	LICENSE     repository license
//
// Environment:
//
//	OUT_DIR          output directory (default: <module>/dist)
//	OUT_OS/OUT_ARCH  Go platform tags (default: runtime.GOOS/runtime.GOARCH;
//	                 --os/--arch take precedence)
package main

import (
	"archive/tar"
	"archive/zip"
	"compress/gzip"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"time"
)

const (
	execMode = 0o755
	fileMode = 0o644
)

// entry is one regular file inside the release archive. name is the path stored
// in the archive, path the file on disk.
type entry struct {
	name string
	path string
	mode os.FileMode
}

func main() {
	if err := run(); err != nil {
		fmt.Fprintf(os.Stderr, "pack: error: %v\n", err)
		os.Exit(1)
	}
}

func run() error {
	target, err := parseTarget(os.Args[1:])
	if err != nil {
		return err
	}
	module, err := moduleDir()
	if err != nil {
		return err
	}
	version, err := readVersion(filepath.Join(module, "..", "version"))
	if err != nil {
		return err
	}
	goos, err := resolvePlatform("OUT_OS", target.OS, runtime.GOOS, "darwin", "linux", "windows")
	if err != nil {
		return err
	}
	goarch, err := resolvePlatform("OUT_ARCH", target.Arch, runtime.GOARCH, "amd64", "arm64")
	if err != nil {
		return err
	}
	// cgo cannot cross-compile: the plugin engine's C toolchain is bound to the
	// host. A different target therefore requires the user to point CC at a
	// matching compiler; otherwise the build must happen on a native runner
	// (which is what release-cli.yml does).
	if err := crossBuildCheck(goos, goarch, os.Getenv("CC")); err != nil {
		return err
	}
	outDir, err := outputDir(module)
	if err != nil {
		return err
	}

	stage := filepath.Join(module, ".build", "pack")
	if err := os.RemoveAll(stage); err != nil {
		return err
	}
	if err := os.MkdirAll(stage, 0o755); err != nil {
		return err
	}

	fmt.Fprintf(os.Stderr, "pack: building decx %s for %s-%s\n", version, goos, goarch)
	binary := "decx"
	if goos == "windows" {
		binary += ".exe"
	}
	if err := buildCLI(filepath.Join(stage, binary), version, module, goos, goarch); err != nil {
		return err
	}

	extras := []struct{ name, source string }{
		{"README.md", filepath.Join(module, "README.md")},
		{"LICENSE", filepath.Join(module, "..", "LICENSE")},
	}
	entries := []entry{{name: binary, path: filepath.Join(stage, binary), mode: execMode}}
	for _, extra := range extras {
		target := filepath.Join(stage, extra.name)
		if err := copyFile(target, extra.source); err != nil {
			return err
		}
		entries = append(entries, entry{name: extra.name, path: target, mode: fileMode})
	}

	if err := os.MkdirAll(outDir, 0o755); err != nil {
		return err
	}
	archive := filepath.Join(outDir, archiveName(version, goos, goarch))
	if err := os.Remove(archive); err != nil && !errors.Is(err, fs.ErrNotExist) {
		return err
	}
	if err := writeArchive(archive, entries); err != nil {
		return err
	}
	sums := filepath.Join(outDir, "SHA256SUMS")
	digest, err := appendChecksum(sums, archive)
	if err != nil {
		return err
	}
	fmt.Fprintf(os.Stderr, "pack: wrote %s\npack: sha256 %s\npack: checksums in %s\n", archive, digest, sums)
	return nil
}

// moduleDir resolves the decx module root from this source file, so the command
// works from any working directory.
func moduleDir() (string, error) {
	_, file, _, ok := runtime.Caller(0)
	if !ok {
		return "", errors.New("cannot locate the source directory")
	}
	return filepath.Dir(filepath.Dir(filepath.Dir(file))), nil
}

func readVersion(path string) (string, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return "", err
	}
	version := strings.TrimSpace(string(data))
	if version == "" {
		return "", fmt.Errorf("%s is empty", path)
	}
	return version, nil
}

// target is the platform selected on the command line.
type target struct {
	OS   string
	Arch string
}

// parseTarget reads --os and --arch (also in --flag=value form). The
// OUT_OS/OUT_ARCH environment fallbacks stay supported for callers that
// predate the flags.
func parseTarget(args []string) (target, error) {
	var parsed target
	set := func(flag, value string) error {
		value = strings.TrimSpace(value)
		if value == "" {
			return fmt.Errorf("%s needs a value", flag)
		}
		if flag == "--os" {
			parsed.OS = value
		} else {
			parsed.Arch = value
		}
		return nil
	}
	for i := 0; i < len(args); i++ {
		arg := args[i]
		switch {
		case arg == "--os", arg == "--arch":
			if i+1 >= len(args) {
				return target{}, fmt.Errorf("%s needs a value", arg)
			}
			i++
			if err := set(arg, args[i]); err != nil {
				return target{}, err
			}
		case strings.HasPrefix(arg, "--os="):
			if err := set("--os", strings.TrimPrefix(arg, "--os=")); err != nil {
				return target{}, err
			}
		case strings.HasPrefix(arg, "--arch="):
			if err := set("--arch", strings.TrimPrefix(arg, "--arch=")); err != nil {
				return target{}, err
			}
		default:
			return target{}, fmt.Errorf("unknown argument %q (want --os and/or --arch)", arg)
		}
	}
	return parsed, nil
}

// resolvePlatform resolves a Go platform tag from the flag, the environment or
// the host, and rejects tags the release matrix does not publish.
func resolvePlatform(variable, flagValue, fallback string, allowed ...string) (string, error) {
	value := strings.TrimSpace(flagValue)
	if value == "" {
		value = strings.TrimSpace(os.Getenv(variable))
	}
	if value == "" {
		value = fallback
	}
	for _, candidate := range allowed {
		if value == candidate {
			return value, nil
		}
	}
	return "", fmt.Errorf("%s must be one of %s (got %q)", variable, strings.Join(allowed, ", "), value)
}

// crossBuildCheck rejects a target other than the host unless a C compiler for
// it is configured: the cgo plugin engine cannot be cross-compiled by Go's
// built-in tooling alone.
func crossBuildCheck(goos, goarch, cc string) error {
	if goos == runtime.GOOS && goarch == runtime.GOARCH {
		return nil
	}
	if strings.TrimSpace(cc) != "" {
		return nil
	}
	return fmt.Errorf("cannot build %s-%s on the %s-%s host: cgo cannot cross-compile; build it on a native %s-%s runner or set CC for that target", goos, goarch, runtime.GOOS, runtime.GOARCH, goos, goarch)
}

func outputDir(module string) (string, error) {
	out := strings.TrimSpace(os.Getenv("OUT_DIR"))
	if out == "" {
		out = filepath.Join(module, "dist")
	}
	return filepath.Abs(out)
}

func buildCLI(target, version, dir, goos, goarch string) error {
	cmd := exec.Command("go", "build", "-trimpath",
		"-ldflags", "-s -w -X main.version="+version,
		"-o", target, "./cmd/decx")
	cmd.Dir = dir
	cmd.Stdout = os.Stdout
	cmd.Stderr = os.Stderr
	cmd.Env = os.Environ()
	// Set the target explicitly so the requested platform is built even when
	// the caller's environment carries a different GOOS/GOARCH (Go uses the
	// last duplicate key in Env).
	cmd.Env = append(cmd.Env, "GOOS="+goos, "GOARCH="+goarch)
	if !hasEnv(cmd.Env, "CGO_ENABLED") {
		// The plugin engine is linked through cgo; a toolchain is required.
		cmd.Env = append(cmd.Env, "CGO_ENABLED=1")
	}
	if err := cmd.Run(); err != nil {
		return fmt.Errorf("go build: %w", err)
	}
	return os.Chmod(target, execMode)
}

func hasEnv(environ []string, key string) bool {
	prefix := key + "="
	for _, item := range environ {
		if strings.HasPrefix(item, prefix) {
			return true
		}
	}
	return false
}

func archiveName(version, goos, goarch string) string {
	name := fmt.Sprintf("decx-cli-%s-%s-%s", version, goos, goarch)
	if goos == "windows" {
		return name + ".zip"
	}
	return name + ".tar.gz"
}

func copyFile(target, source string) error {
	data, err := os.ReadFile(source)
	if err != nil {
		return err
	}
	if err := os.MkdirAll(filepath.Dir(target), 0o755); err != nil {
		return err
	}
	return os.WriteFile(target, data, fileMode)
}

// writeArchive writes the entries to target, picking the format from the file
// extension. Timestamps are left unset so the archive bytes are reproducible.
func writeArchive(target string, entries []entry) error {
	file, err := os.Create(target)
	if err != nil {
		return err
	}
	var writeErr error
	if strings.HasSuffix(target, ".zip") {
		writeErr = writeZip(file, entries)
	} else {
		writeErr = writeTarGz(file, entries)
	}
	if err := file.Close(); writeErr == nil {
		writeErr = err
	}
	if writeErr != nil {
		return fmt.Errorf("write %s: %w", filepath.Base(target), writeErr)
	}
	return nil
}

func writeTarGz(w io.Writer, entries []entry) error {
	gz := gzip.NewWriter(w)
	tw := tar.NewWriter(gz)
	for _, item := range entries {
		info, err := os.Stat(item.path)
		if err != nil {
			return err
		}
		header := &tar.Header{
			Name:     item.name,
			Mode:     int64(item.mode),
			Size:     info.Size(),
			Typeflag: tar.TypeReg,
		}
		if err := tw.WriteHeader(header); err != nil {
			return err
		}
		if err := writeFile(tw, item.path); err != nil {
			return err
		}
	}
	if err := tw.Close(); err != nil {
		return err
	}
	return gz.Close()
}

func writeZip(w io.Writer, entries []entry) error {
	// ZIP cannot store timestamps before 1980; a fixed value keeps the bytes
	// identical across machines.
	stamp := time.Date(1980, 1, 1, 0, 0, 0, 0, time.UTC)
	zw := zip.NewWriter(w)
	for _, item := range entries {
		header := &zip.FileHeader{Name: item.name, Method: zip.Deflate, Modified: stamp}
		header.SetMode(item.mode)
		sink, err := zw.CreateHeader(header)
		if err != nil {
			return err
		}
		if err := writeFile(sink, item.path); err != nil {
			return err
		}
	}
	return zw.Close()
}

func writeFile(w io.Writer, path string) error {
	file, err := os.Open(path)
	if err != nil {
		return err
	}
	defer file.Close()
	_, err = io.Copy(w, file)
	return err
}

// appendChecksum writes the SHA-256 of archive into sums and returns the hex
// digest.
func appendChecksum(sums, archive string) (string, error) {
	digest, err := fileSHA256(archive)
	if err != nil {
		return "", err
	}
	file, err := os.OpenFile(sums, os.O_APPEND|os.O_CREATE|os.O_WRONLY, fileMode)
	if err != nil {
		return "", err
	}
	defer file.Close()
	if _, err := fmt.Fprintf(file, "%s  %s\n", digest, filepath.Base(archive)); err != nil {
		return "", err
	}
	return digest, nil
}

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
