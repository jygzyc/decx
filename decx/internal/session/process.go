package session

import (
	"context"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"strconv"
	"strings"
	"time"

	"github.com/jygzyc/decx/decx/internal/registry"
	"github.com/shirou/gopsutil/v4/process"
)

// owned compares creation timestamps as well as PID, so a recycled PID is never killed.
// Inspection errors remain errors rather than being interpreted as proof of death.
func owned(s Record) (bool, error) {
	exists, err := process.PidExists(s.PID)
	if err != nil || !exists {
		return false, err
	}
	p, err := process.NewProcess(s.PID)
	if errors.Is(err, process.ErrorProcessNotRunning) {
		return false, nil
	}
	if err != nil {
		return inspectFailure(s.PID, err)
	}
	created, err := p.CreateTime()
	if errors.Is(err, process.ErrorProcessNotRunning) {
		return false, nil
	}
	if err != nil {
		return inspectFailure(s.PID, err)
	}
	if created != s.ProcessCreated {
		return false, nil
	}
	states, err := p.Status()
	if errors.Is(err, process.ErrorProcessNotRunning) {
		return false, nil
	}
	if err != nil {
		return inspectFailure(s.PID, err)
	}
	for _, state := range states {
		if state == process.Zombie {
			return false, nil
		}
	}
	return true, nil
}

// A process may exit between the existence check and an OS detail query (on
// macOS ps then returns exit status 1). Only a second absence probe clears it.
func inspectFailure(pid int32, inspectionErr error) (bool, error) {
	exists, err := process.PidExists(pid)
	if err == nil && !exists {
		return false, nil
	}
	return false, errors.Join(inspectionErr, err)
}

// stopGrace bounds how long the CLI waits for a server to exit: once after
// running a declared stop command, and once after terminating the process.
const stopGrace = 10 * time.Second

// stopProcess ends a server. A declared stop command runs first so the server
// can shut down gracefully; the process is terminated anyway when it survives
// (or when the command fails), so a broken stop command cannot leak a process.
func (m *Manager) stopProcess(ctx context.Context, s Record) error {
	alive, err := owned(s)
	if err != nil || !alive {
		return err
	}
	if module, ok := m.module(s.Module); ok && len(module.Launch.Stop.Command) > 0 {
		if err := m.runStopCommand(ctx, s, module); err != nil {
			fmt.Fprintf(m.progress(), "stop command failed: %v; terminating PID %d\n", err, s.PID)
		}
		if err := waitForExit(ctx, s, stopGrace); err == nil {
			return nil
		}
	}
	p, err := os.FindProcess(int(s.PID))
	if err != nil {
		return err
	}
	defer p.Release()
	if err := terminate(ctx, p); err != nil && !errors.Is(err, os.ErrProcessDone) {
		return fmt.Errorf("kill PID %d: %w", s.PID, err)
	}
	if err := waitForExit(ctx, s, stopGrace); err != nil {
		return fmt.Errorf("PID %d has not stopped; session retained: %w", s.PID, err)
	}
	return nil
}

// waitForExit reports nil as soon as the recorded process is gone.
func waitForExit(ctx context.Context, s Record, timeout time.Duration) error {
	deadline, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()
	for {
		alive, err := owned(s)
		if err != nil {
			return err
		}
		if !alive {
			return nil
		}
		select {
		case <-deadline.Done():
			return deadline.Err()
		case <-time.After(50 * time.Millisecond):
		}
	}
}

// runStopCommand expands the registry's stop command for one session and runs it.
func (m *Manager) runStopCommand(ctx context.Context, s Record, module registry.Module) error {
	executable := module.Binary.Path
	if resolved, err := resolveBinary(m.Home, module); err == nil {
		executable = resolved
	}
	replacer := strings.NewReplacer(
		"{pid}", strconv.Itoa(int(s.PID)),
		"{port}", strconv.Itoa(s.Port),
		"{binary}", executable,
		"{home}", m.Home,
		"{target}", s.Target,
	)
	argv := make([]string, len(module.Launch.Stop.Command))
	for i, part := range module.Launch.Stop.Command {
		argv[i] = replacer.Replace(part)
	}
	if argv[0] == "" {
		return errors.New("empty stop command")
	}
	stopCtx, cancel := context.WithTimeout(ctx, stopGrace)
	defer cancel()
	cmd := exec.CommandContext(stopCtx, argv[0], argv[1:]...)
	cmd.Stderr = m.progress()
	if err := cmd.Run(); err != nil {
		return fmt.Errorf("%s: %w", strings.Join(argv, " "), err)
	}
	return nil
}

// progress is the writer for stop diagnostics; a Manager may leave it unset.
func (m *Manager) progress() io.Writer {
	if m.Progress == nil {
		return io.Discard
	}
	return m.Progress
}
