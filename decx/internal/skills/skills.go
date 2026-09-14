// Package skills installs the DECX agent skills and links them into the skill
// directories of the supported AI clients.
package skills

import (
	"context"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"sort"
	"strings"
	"time"

	git "github.com/go-git/go-git/v5"
	"github.com/go-git/go-git/v5/plumbing"
)

// Repository is the GitHub source of the DECX skills.
const Repository = "https://github.com/jygzyc/decx.git"

// clientDirectories maps a normalized client onto the directory (relative to
// the user's home) that client reads skills from.
var clientDirectories = map[string]string{
	"codex":       ".codex/skills",
	"claude-code": ".claude/skills",
	"cursor":      ".cursor/skills",
	"agents":      ".agents/skills",
}

// clientAliases maps --client values onto the supported clients. Clients
// without a dedicated directory share ~/.agents/skills.
var clientAliases = map[string]string{
	"codex":       "codex",
	"codex-cli":   "codex",
	"claude":      "claude-code",
	"claude-code": "claude-code",
	"cursor":      "cursor",
	"agents":      "agents",
}

// Clients normalizes --client values (comma separated and repeatable). Empty
// input selects the shared agents directory, matching the other DECX clients.
func Clients(values []string) []string {
	clients := make([]string, 0, len(values))
	seen := map[string]bool{}
	for _, value := range values {
		for _, part := range strings.Split(value, ",") {
			part = strings.ToLower(strings.TrimSpace(part))
			if part == "" {
				continue
			}
			client := clientAliases[part]
			if client == "" {
				client = "agents"
			}
			if !seen[client] {
				seen[client] = true
				clients = append(clients, client)
			}
		}
	}
	if len(clients) == 0 {
		return []string{"agents"}
	}
	return clients
}

// ClientDir is the absolute skills directory a client reads from.
func ClientDir(client, home string) string {
	directory, ok := clientDirectories[client]
	if !ok {
		directory = clientDirectories["agents"]
	}
	return filepath.Join(home, filepath.FromSlash(directory))
}

// Link records where a client's skills were linked.
type Link struct {
	Client string `json:"client"`
	Path   string `json:"path"`
}

// Result is the JSON shape `decx self skills install` prints.
type Result struct {
	OK      bool     `json:"ok"`
	Clients []Link   `json:"clients"`
	Source  string   `json:"sourcePath"`
	Skills  []string `json:"skills"`
	Message string   `json:"message"`
}

// Install copies the DECX skills into <decxHome>/skills and links them for
// every selected client. When sourceDir is set it must point at a checkout's
// `skills` directory and no download happens (tests, mirrors); otherwise the
// skills are cloned from Repository. userHome holds the client skill
// directories.
func Install(ctx context.Context, decxHome, userHome, sourceDir string, clients []string) (Result, error) {
	checkoutDir := sourceDir
	cleanup := func() {}
	if checkoutDir == "" {
		directory, remove, err := clone(ctx)
		if err != nil {
			return Result{}, err
		}
		checkoutDir, cleanup = directory, remove
	}
	defer cleanup()

	names, err := discover(checkoutDir)
	if err != nil {
		return Result{}, err
	}
	storageDir := filepath.Join(decxHome, "skills")
	if err := os.MkdirAll(storageDir, 0o755); err != nil {
		return Result{}, err
	}
	for _, name := range names {
		stored := filepath.Join(storageDir, name)
		if err := os.RemoveAll(stored); err != nil {
			return Result{}, err
		}
		if err := copyTree(filepath.Join(checkoutDir, name), stored); err != nil {
			return Result{}, err
		}
	}

	links := make([]Link, 0, len(clients))
	for _, client := range clients {
		directory := ClientDir(client, userHome)
		for _, name := range names {
			if err := linkDir(filepath.Join(storageDir, name), filepath.Join(directory, name)); err != nil {
				return Result{}, err
			}
		}
		links = append(links, Link{Client: client, Path: directory})
	}
	clientsText := make([]string, 0, len(links))
	for _, link := range links {
		clientsText = append(clientsText, link.Client)
	}
	return Result{
		OK:      true,
		Clients: links,
		Source:  storageDir,
		Skills:  names,
		Message: fmt.Sprintf("Downloaded %d DECX skills to %s and linked them for %s", len(names), storageDir, strings.Join(clientsText, ", ")),
	}, nil
}

// cloneURL is the repository `clone` fetches. Tests point it at a local
// fixture repository so the clone path runs without network access.
var cloneURL = Repository

// clone fetches the repository and returns its skills directory.
func clone(ctx context.Context) (string, func(), error) {
	tempDir, err := os.MkdirTemp("", "decx-skills-")
	if err != nil {
		return "", nil, err
	}
	cleanup := func() { os.RemoveAll(tempDir) }
	repositoryDir := filepath.Join(tempDir, "repo")
	cloneCtx, cancel := context.WithTimeout(ctx, 120*time.Second)
	defer cancel()
	// go-git clones in-process, so no git binary is needed; the checkout lands
	// in a fresh subdirectory that the temp-dir cleanup removes as a whole.
	if _, err := git.PlainCloneContext(cloneCtx, repositoryDir, false, &git.CloneOptions{
		URL:           cloneURL,
		ReferenceName: plumbing.NewBranchReferenceName("main"),
		SingleBranch:  true,
		Depth:         1,
		Tags:          git.NoTags,
	}); err != nil {
		cleanup()
		return "", nil, fmt.Errorf("failed to fetch the DECX skills: %w", err)
	}
	return filepath.Join(repositoryDir, "skills"), cleanup, nil
}

// discover lists the DECX skills (decx-* directories carrying a SKILL.md).
func discover(directory string) ([]string, error) {
	entries, err := os.ReadDir(directory)
	if err != nil {
		return nil, fmt.Errorf("failed to read DECX skills: %w", err)
	}
	names := []string{}
	for _, entry := range entries {
		if !entry.IsDir() || !strings.HasPrefix(entry.Name(), "decx-") {
			continue
		}
		if _, err := os.Stat(filepath.Join(directory, entry.Name(), "SKILL.md")); err != nil {
			continue
		}
		names = append(names, entry.Name())
	}
	sort.Strings(names)
	if len(names) == 0 {
		return nil, fmt.Errorf("no DECX skills found in %s", directory)
	}
	return names, nil
}

// linkDir exposes a stored skill to a client. Symlinks keep a single copy of
// the content; Windows without developer mode needs a junction, and if neither
// works the skill is copied so the client still sees it.
func linkDir(source, destination string) error {
	if err := os.RemoveAll(destination); err != nil {
		return err
	}
	if err := os.MkdirAll(filepath.Dir(destination), 0o755); err != nil {
		return err
	}
	if err := os.Symlink(source, destination); err == nil {
		return nil
	} else if runtime.GOOS != "windows" {
		return err
	}
	if err := exec.Command("cmd", "/c", "mklink", "/J", destination, source).Run(); err == nil {
		return nil
	}
	return copyTree(source, destination)
}

// copyTree copies a directory recursively, preserving file modes.
func copyTree(source, destination string) error {
	return filepath.Walk(source, func(path string, info os.FileInfo, err error) error {
		if err != nil {
			return err
		}
		relative, err := filepath.Rel(source, path)
		if err != nil {
			return err
		}
		target := filepath.Join(destination, relative)
		if info.IsDir() {
			return os.MkdirAll(target, info.Mode().Perm())
		}
		if !info.Mode().IsRegular() {
			return nil
		}
		return copyFile(path, target, info.Mode().Perm())
	})
}

func copyFile(source, destination string, mode os.FileMode) error {
	input, err := os.Open(source)
	if err != nil {
		return err
	}
	defer input.Close()
	if err := os.MkdirAll(filepath.Dir(destination), 0o755); err != nil {
		return err
	}
	output, err := os.OpenFile(destination, os.O_CREATE|os.O_TRUNC|os.O_WRONLY, mode)
	if err != nil {
		return err
	}
	defer output.Close()
	if _, err := io.Copy(output, input); err != nil {
		return err
	}
	return output.Close()
}
