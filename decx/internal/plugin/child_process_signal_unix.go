//go:build !windows

package plugin

import (
	"os"
	"syscall"
)

// exitSignal extracts the conventional signal name when the process was killed
// by a signal. Windows has no equivalent exit state, hence the split.
func exitSignal(state *os.ProcessState) (string, bool) {
	if state == nil {
		return "", false
	}
	wait, ok := state.Sys().(syscall.WaitStatus)
	if !ok || !wait.Signaled() {
		return "", false
	}
	return signalName(wait.Signal()), true
}
