package registry

import (
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
)

// ResolveBinary finds the server executable for a module. The environment
// override wins over every local copy, matching install.Probe, so `module
// list`, `session check` and the session launcher always name the same binary;
// then come the installed module directory (DECX_HOME/modules/<id>), an
// absolute path, the directory next to the running CLI, and finally PATH for
// program modules.
func ResolveBinary(home string, e Module) (string, error) {
	b := e.Binary
	path := b.Path
	if override := os.Getenv(b.Env); b.Env != "" && override != "" {
		path = override
		if info, err := os.Stat(path); err == nil && info.IsDir() {
			path = filepath.Join(path, b.Path)
		}
		full, err := filepath.Abs(path)
		if err != nil {
			return "", err
		}
		if info, err := os.Stat(full); err != nil || !info.Mode().IsRegular() {
			return "", fmt.Errorf("invalid %s binary path %s", b.Env, full)
		}
		return full, nil
	}
	candidates := []string{}
	switch {
	case filepath.IsAbs(path):
		candidates = append(candidates, path)
	case e.Root != "":
		// A checkout component may also be installed under DECX_HOME; Probe
		// checks that copy first, so try it first here and fall back to the
		// checkout, which keeps inspection and launch in agreement.
		candidates = append(candidates,
			filepath.Join(ModuleRoot(home, e.ID), filepath.FromSlash(path)),
			filepath.Join(e.Root, filepath.FromSlash(path)))
	default:
		candidates = append(candidates, filepath.Join(ModuleRoot(home, e.ID), filepath.FromSlash(path)))
	}
	if exe, err := os.Executable(); err == nil {
		candidates = append(candidates, filepath.Join(filepath.Dir(exe), path))
	}
	if runtime.GOOS == "windows" && b.Kind == "program" && filepath.Ext(path) == "" {
		for _, candidate := range append([]string{}, candidates...) {
			candidates = append(candidates, candidate+".exe")
		}
	}
	for _, candidate := range candidates {
		if info, err := os.Stat(candidate); err == nil && info.Mode().IsRegular() {
			return filepath.Abs(candidate)
		}
	}
	if b.Kind == "program" {
		if executable, err := exec.LookPath(path); err == nil {
			return filepath.Abs(executable)
		}
	}
	hint := fmt.Sprintf("install it with `decx install --module %s`", e.ID)
	if e.Release == nil {
		hint = fmt.Sprintf("configure %s or install it in %s", b.Env, ModuleRoot(home, e.ID))
	}
	return "", fmt.Errorf("server binary %s of module %s is not installed; %s", b.Path, e.ID, hint)
}
