package skills

import (
	"context"
	"os"
	"path/filepath"
	"sort"
	"testing"
	"time"

	git "github.com/go-git/go-git/v5"
	"github.com/go-git/go-git/v5/plumbing"
	"github.com/go-git/go-git/v5/plumbing/object"
)

// fixture builds a source directory that looks like a repository checkout's
// `skills` tree with two installable skills and one ignored directory.
func fixture(t *testing.T) string {
	t.Helper()
	source := t.TempDir()
	for _, name := range []string{"decx-cli", "decx-vulnhunt"} {
		directory := filepath.Join(source, name)
		if err := os.MkdirAll(filepath.Join(directory, "references"), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(filepath.Join(directory, "SKILL.md"), []byte("# "+name), 0o644); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(filepath.Join(directory, "references", "notes.md"), []byte(name), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	if err := os.MkdirAll(filepath.Join(source, "helper"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(filepath.Join(source, "decx-broken"), 0o755); err != nil {
		t.Fatal(err)
	}
	return source
}

func TestClients(t *testing.T) {
	for _, test := range []struct {
		values []string
		want   []string
	}{
		{nil, []string{"agents"}},
		{[]string{""}, []string{"agents"}},
		{[]string{"codex"}, []string{"codex"}},
		{[]string{"codex-cli,claude"}, []string{"codex", "claude-code"}},
		{[]string{"cursor", "cursor"}, []string{"cursor"}},
		{[]string{"windsurf"}, []string{"agents"}},
	} {
		got := Clients(test.values)
		if len(got) != len(test.want) {
			t.Fatalf("Clients(%v) = %v want %v", test.values, got, test.want)
		}
		for i := range test.want {
			if got[i] != test.want[i] {
				t.Fatalf("Clients(%v) = %v want %v", test.values, got, test.want)
			}
		}
	}
}

func TestInstallCopiesAndLinksSkills(t *testing.T) {
	decxHome := t.TempDir()
	userHome := t.TempDir()
	result, err := Install(context.Background(), decxHome, userHome, fixture(t), []string{"codex", "agents"})
	if err != nil {
		t.Fatal(err)
	}
	wantSkills := []string{"decx-cli", "decx-vulnhunt"}
	if len(result.Skills) != len(wantSkills) {
		t.Fatalf("skills = %v", result.Skills)
	}
	for i := range wantSkills {
		if result.Skills[i] != wantSkills[i] {
			t.Fatalf("skills = %v want %v", result.Skills, wantSkills)
		}
	}
	if !result.OK || result.Source != filepath.Join(decxHome, "skills") {
		t.Fatalf("result = %+v", result)
	}
	// The stored copy keeps the nested files.
	if _, err := os.Stat(filepath.Join(decxHome, "skills", "decx-cli", "references", "notes.md")); err != nil {
		t.Fatal(err)
	}
	// Both clients see every skill, and the link points at the stored copy.
	for _, client := range []string{"codex", "agents"} {
		directory := ClientDir(client, userHome)
		for _, skill := range wantSkills {
			path, err := os.Readlink(filepath.Join(directory, skill))
			if err != nil {
				t.Fatalf("%s/%s: %v", client, skill, err)
			}
			if path != filepath.Join(decxHome, "skills", skill) {
				t.Fatalf("%s/%s -> %s", client, skill, path)
			}
		}
	}
	// A previous install is replaced, not merged.
	stale := filepath.Join(decxHome, "skills", "decx-cli", "stale.md")
	if err := os.WriteFile(stale, []byte("old"), 0o644); err != nil {
		t.Fatal(err)
	}
	if _, err := Install(context.Background(), decxHome, userHome, fixture(t), []string{"agents"}); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(stale); !os.IsNotExist(err) {
		t.Fatalf("stale file survived: %v", err)
	}
}

// TestInstallClonesRepository exercises the real clone path against a local
// repository. go-git's file transport spawns `git-upload-pack`, so this test
// needs a git binary on PATH even though the production HTTPS clone is pure Go.
func TestInstallClonesRepository(t *testing.T) {
	origin := t.TempDir()
	repository, err := git.PlainInitWithOptions(origin, &git.PlainInitOptions{
		InitOptions: git.InitOptions{DefaultBranch: plumbing.Main},
	})
	if err != nil {
		t.Fatal(err)
	}
	worktree, err := repository.Worktree()
	if err != nil {
		t.Fatal(err)
	}
	skillDir := filepath.Join(origin, "skills", "decx-demo")
	if err := os.MkdirAll(skillDir, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(skillDir, "SKILL.md"), []byte("# decx-demo"), 0o644); err != nil {
		t.Fatal(err)
	}
	if _, err := worktree.Add("skills"); err != nil {
		t.Fatal(err)
	}
	if _, err := worktree.Commit("fixture", &git.CommitOptions{
		Author: &object.Signature{Name: "decx", Email: "decx@example.com", When: time.Now()},
	}); err != nil {
		t.Fatal(err)
	}

	previous := cloneURL
	cloneURL = origin
	t.Cleanup(func() { cloneURL = previous })

	decxHome := t.TempDir()
	userHome := t.TempDir()
	result, err := Install(context.Background(), decxHome, userHome, "", []string{"agents"})
	if err != nil {
		t.Fatal(err)
	}
	if len(result.Skills) != 1 || result.Skills[0] != "decx-demo" {
		t.Fatalf("skills = %v", result.Skills)
	}
	if _, err := os.Stat(filepath.Join(decxHome, "skills", "decx-demo", "SKILL.md")); err != nil {
		t.Fatal(err)
	}
	target, err := os.Readlink(filepath.Join(ClientDir("agents", userHome), "decx-demo"))
	if err != nil {
		t.Fatal(err)
	}
	if target != filepath.Join(decxHome, "skills", "decx-demo") {
		t.Fatalf("link -> %s", target)
	}
}

func TestInstallRejectsEmptySource(t *testing.T) {
	if _, err := Install(context.Background(), t.TempDir(), t.TempDir(), t.TempDir(), nil); err == nil {
		t.Fatal("accepted a source without skills")
	}
}

func TestDiscoverIgnoresNonSkills(t *testing.T) {
	names, err := discover(fixture(t))
	if err != nil {
		t.Fatal(err)
	}
	sort.Strings(names)
	if len(names) != 2 || names[0] != "decx-cli" || names[1] != "decx-vulnhunt" {
		t.Fatalf("names = %v", names)
	}
}
