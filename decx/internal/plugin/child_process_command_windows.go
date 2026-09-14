//go:build windows

package plugin

import (
	"context"
	"os/exec"
	"syscall"
)

// spawnCommand builds the process for one spawnSync call. Batch files
// (.cmd/.bat) cannot be started by CreateProcess, so they are handed to
// `cmd.exe /d /s /c`; everything else keeps Go's normal argument escaping.
func spawnCommand(ctx context.Context, command string, args []string) *exec.Cmd {
	cmd := exec.CommandContext(ctx, command, args...)
	// LookPath already resolved PATHEXT, so a bare name that names a batch
	// file arrives here with cmd.Path pointing at the .cmd/.bat file.
	if !isBatchCommand(command) && !isBatchCommand(cmd.Path) {
		return cmd
	}
	// cmd.exe has its own unquoting rules, so pass the complete line through
	// SysProcAttr.CmdLine and leave Args empty - Go documents this as the way
	// to run batch files.
	shell := exec.CommandContext(ctx, "cmd.exe")
	shell.SysProcAttr = &syscall.SysProcAttr{CmdLine: batchCommandLine(shell.Path, cmd.Path, args)}
	return shell
}
