//go:build !windows

package session

import (
	"context"
	"os"
)

// terminate ends a single session process on POSIX systems. Kill sends
// SIGKILL; the caller's verified-death wait decides whether it worked.
func terminate(_ context.Context, p *os.Process) error {
	return p.Kill()
}
