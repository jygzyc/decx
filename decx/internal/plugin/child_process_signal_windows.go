//go:build windows

package plugin

import "os"

// exitSignal has no Windows equivalent: the platform reports only an exit
// code, so the caller falls back to the conventional SIGKILL name.
func exitSignal(*os.ProcessState) (string, bool) {
	return "", false
}
