//go:build windows

package session

import (
	"context"
	"os"
	"os/exec"
	"strconv"
)

// terminate ends a single session process on Windows. os.Process.Kill stops
// only that process, while a server may have spawned children, so prefer
// taskkill with /T to take down the whole tree. When taskkill is unavailable
// (or the call fails) fall back to Kill so termination still works on a
// minimal system.
func terminate(ctx context.Context, p *os.Process) error {
	if path, err := exec.LookPath("taskkill"); err == nil {
		// /T terminates the process tree and /F forces termination: the CLI
		// runs without a console to post WM_CLOSE/CTRL_CLOSE to.
		if err := exec.CommandContext(ctx, path, "/PID", strconv.Itoa(p.Pid), "/T", "/F").Run(); err == nil {
			return nil
		}
	}
	return p.Kill()
}
