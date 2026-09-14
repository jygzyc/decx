//go:build !windows

package plugin

import (
	"context"
	"os/exec"
)

// spawnCommand keeps Go's normal argv handling on POSIX systems.
func spawnCommand(ctx context.Context, command string, args []string) *exec.Cmd {
	return exec.CommandContext(ctx, command, args...)
}
