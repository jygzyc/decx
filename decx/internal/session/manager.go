package session

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/binary"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"time"

	"github.com/jygzyc/decx/decx/internal/registry"
	"github.com/shirou/gopsutil/v4/process"
)

type Manager struct {
	Home    string
	Modules []registry.Module

	Progress io.Writer
}

type OpenOptions struct {
	Module  registry.Module
	Target  string
	Name    string
	Port    int
	Scripts []string
	Args    []string
	Force   bool
	Timeout time.Duration
}

func fileHash(path string) (string, error) {
	f, err := os.Open(path)
	if err != nil {
		return "", err
	}
	defer f.Close()
	info, err := f.Stat()
	if err != nil {
		return "", err
	}
	if !info.Mode().IsRegular() {
		return "", fmt.Errorf("not a regular input file: %s", path)
	}
	h := sha256.New()
	if _, err := io.Copy(h, f); err != nil {
		return "", err
	}
	return hex.EncodeToString(h.Sum(nil)), nil
}

func resolveBinary(home string, e registry.Module) (string, error) {
	return registry.ResolveBinary(home, e)
}
func freePort(requested int) (int, error) {
	if requested < 0 || requested > 65535 {
		return 0, errors.New("port must be between 1 and 65535")
	}
	for i := 0; i < 100; i++ {
		port := requested
		if port == 0 {
			var random [4]byte
			if _, err := rand.Read(random[:]); err != nil {
				return 0, err
			}
			port = 30000 + int(binary.BigEndian.Uint32(random[:])%10001)
		}
		listener, err := net.Listen("tcp", net.JoinHostPort("127.0.0.1", strconv.Itoa(port)))
		if err == nil {
			listener.Close()
			return port, nil
		}
		if requested != 0 {
			return 0, fmt.Errorf("port %d unavailable: %w", port, err)
		}
	}
	return 0, errors.New("no available session port in 30000-40000")
}

var validName = regexp.MustCompile(`^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,99}$`)
var unsafeName = regexp.MustCompile(`[^a-zA-Z0-9_.-]+`)

func (m *Manager) Open(ctx context.Context, o OpenOptions) (Record, error) {
	var result Record
	if err := ctx.Err(); err != nil {
		return result, err
	}
	if o.Timeout <= 0 {
		o.Timeout = 300 * time.Second
	}
	if len(o.Args) > 0 && !o.Module.Launch.TrailingArgs {
		return result, fmt.Errorf("module %s does not accept trailing arguments", o.Module.ID)
	}
	if len(o.Scripts) > 0 && o.Module.Launch.Scripts != "positional" {
		return result, fmt.Errorf("module %s does not accept scripts", o.Module.ID)
	}
	for _, arg := range o.Args {
		if arg == "--port" || arg == "-p" || strings.HasPrefix(arg, "--port=") || strings.HasPrefix(arg, "-p=") {
			return result, errors.New("use session open --port to choose the managed server port")
		}
	}
	target, err := filepath.Abs(o.Target)
	if err != nil {
		return result, err
	}
	hash, err := fileHash(target)
	if err != nil {
		return result, err
	}
	executable, err := resolveBinary(m.Home, o.Module)
	if err != nil {
		return result, err
	}
	scripts := make([]string, len(o.Scripts))
	scriptHashes := make([]string, len(o.Scripts))
	for i, path := range o.Scripts {
		scripts[i], err = filepath.Abs(path)
		if err != nil {
			return result, err
		}
		scriptHashes[i], err = fileHash(scripts[i])
		if err != nil {
			return result, err
		}
	}
	// Only identity-relevant data takes part: a rewritten manifest (an install
	// or self update may change the description, commands or release metadata)
	// must not invalidate the reuse lookup for an otherwise matching session.
	identityBytes, err := json.Marshal(struct {
		Hash                  string
		ModuleID              string
		Binary                string
		Scripts, Hashes, Args []string
	}{hash, o.Module.ID, executable, scripts, scriptHashes, o.Args})
	if err != nil {
		return result, err
	}
	digest := sha256.Sum256(identityBytes)
	identity := hex.EncodeToString(digest[:])
	name := o.Name
	if name == "" {
		stem := unsafeName.ReplaceAllString(strings.TrimSuffix(filepath.Base(target), filepath.Ext(target)), "-")
		stem = strings.Trim(stem, "-._")
		if stem == "" {
			stem = "target"
		}
		if len(stem) > 50 {
			stem = stem[:50]
		}
		name = stem + "-" + o.Module.ID
	}
	if !validName.MatchString(name) {
		return result, errors.New("session name must be 1-100 letters, digits, dots, underscores or hyphens, starting with a letter or digit")
	}
	err = m.locked(ctx, func(db *database) error {
		if err := ctx.Err(); err != nil {
			return err
		}
		// Check every conflict before terminating anything, so a validation failure
		// cannot partially replace a collection of sessions.
		conflicts := map[string]bool{}
		for _, s := range db.Sessions {
			if s.Name != name && !(s.Hash == hash && s.Module == o.Module.ID) {
				continue
			}
			alive, err := owned(s)
			if err != nil {
				return err
			}
			if alive && !o.Force {
				if s.Identity == identity && (o.Port == 0 || s.Port == o.Port) && (o.Name == "" || s.Name == name) {
					result = s
					return nil
				}
				return fmt.Errorf("session %s conflicts with this target or configuration; use --force to replace it", s.Name)
			}
			conflicts[s.Name] = true
		}
		for _, s := range db.Sessions {
			if conflicts[s.Name] {
				if err := m.stopProcess(ctx, s); err != nil {
					return err
				}
			}
		}
		kept := []Record{}
		for _, s := range db.Sessions {
			if !conflicts[s.Name] {
				kept = append(kept, s)
			}
		}
		db.Sessions = kept
		if err := m.save(db); err != nil {
			return err
		}
		port, err := freePort(o.Port)
		if err != nil {
			return err
		}
		replacer := strings.NewReplacer("{binary}", executable, "{target}", target, "{port}", strconv.Itoa(port), "{home}", m.Home)
		argv := make([]string, len(o.Module.Launch.Command))
		for i, part := range o.Module.Launch.Command {
			argv[i] = replacer.Replace(part)
		}
		if len(argv) == 0 {
			return errors.New("module has no launch command")
		}
		argv = append(argv, scripts...)
		argv = append(argv, o.Args...)
		logDir := filepath.Join(m.Home, "logs")
		if err := os.MkdirAll(logDir, 0700); err != nil {
			return err
		}
		log, err := os.CreateTemp(logDir, name+"-*.log")
		if err != nil {
			return err
		}
		defer log.Close()
		cmd := exec.Command(argv[0], argv[1:]...)
		cmd.Stdout, cmd.Stderr = log, log
		detach(cmd)
		if err := cmd.Start(); err != nil {
			return err
		}
		// Reap children while this CLI remains alive; servers survive CLI exit.
		go func() { _ = cmd.Wait() }()
		p, err := process.NewProcess(int32(cmd.Process.Pid))
		if err != nil {
			_ = cmd.Process.Kill()
			return fmt.Errorf("server exited at startup; inspect %s: %w", log.Name(), err)
		}
		created, err := p.CreateTime()
		if err != nil {
			_ = cmd.Process.Kill()
			return err
		}
		result = Record{Name: name, Module: o.Module.ID, Target: target, Hash: hash, Identity: identity, PID: int32(cmd.Process.Pid), ProcessCreated: created, Port: port, Log: log.Name(), Created: time.Now().UTC(), State: "starting"}
		db.Sessions = append(db.Sessions, result)
		if err := m.save(db); err != nil {
			cleanupCtx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
			defer cancel()
			return errors.Join(err, m.stopProcess(cleanupCtx, result))
		}
		return nil
	})
	if err != nil {
		return result, err
	}
	return m.wait(ctx, result, o.Timeout)
}

func healthy(ctx context.Context, port int) bool {
	client := &http.Client{Timeout: time.Second, CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, fmt.Sprintf("http://127.0.0.1:%d/health", port), nil)
	if err != nil {
		return false
	}
	res, err := client.Do(req)
	if err != nil {
		return false
	}
	defer res.Body.Close()
	var health struct {
		Status string `json:"status"`
	}
	return res.StatusCode == 200 && json.NewDecoder(io.LimitReader(res.Body, 1<<20)).Decode(&health) == nil && health.Status == "running"
}

func (m *Manager) wait(ctx context.Context, s Record, timeout time.Duration) (Record, error) {
	waitCtx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()
	start := time.Now()
	heartbeat := time.NewTicker(15 * time.Second)
	defer heartbeat.Stop()
	for {
		alive, err := owned(s)
		if err != nil {
			return s, err
		}
		if !alive {
			return s, fmt.Errorf("session %s exited before readiness; inspect %s", s.Name, s.Log)
		}
		if healthy(waitCtx, s.Port) {
			s.State = "healthy"
			err := m.locked(ctx, func(db *database) error {
				for i, saved := range db.Sessions {
					if saved.Name == s.Name && saved.PID == s.PID && saved.ProcessCreated == s.ProcessCreated {
						db.Sessions[i].State = s.State
						return m.save(db)
					}
				}
				return errors.New("session was replaced while waiting for readiness")
			})
			return s, err
		}
		select {
		case <-waitCtx.Done():
			return s, fmt.Errorf("session %s (PID %d, port %d) is still recorded; use session check %s or session close %s; log %s: %w", s.Name, s.PID, s.Port, s.Name, s.Name, s.Log, waitCtx.Err())
		case <-heartbeat.C:
			if m.Progress != nil {
				fmt.Fprintf(m.Progress, "Waiting for %s (%ds); log: %s\n", s.Name, int(time.Since(start).Seconds()), s.Log)
			}
		case <-time.After(200 * time.Millisecond):
		}
	}
}

func (m *Manager) List(ctx context.Context) ([]Record, error) {
	sessions := []Record{}
	err := m.locked(ctx, func(db *database) error { sessions = append(sessions, db.Sessions...); return nil })
	if err != nil {
		return nil, err
	}
	for i, s := range sessions {
		alive, err := owned(s)
		if err != nil {
			return nil, err
		}
		sessions[i].State = "stopped"
		if alive {
			sessions[i].State = "unreachable"
			if healthy(ctx, s.Port) {
				sessions[i].State = "healthy"
			} else if s.State == "starting" {
				sessions[i].State = "starting"
			}
		}
	}
	return sessions, nil
}

func (m *Manager) Select(ctx context.Context, name string, modules []string) (Record, error) {
	sessions, err := m.List(ctx)
	if err != nil {
		return Record{}, err
	}
	var matches []Record
	for _, s := range sessions {
		if name != "" && s.Name != name {
			continue
		}
		compatible := false
		for _, module := range modules {
			if s.Module == module {
				compatible = true
			}
		}
		if compatible && s.State == "healthy" {
			matches = append(matches, s)
		}
	}
	if len(matches) == 0 {
		return Record{}, errors.New("no healthy compatible session; use session open or session check")
	}
	if len(matches) > 1 {
		return Record{}, errors.New("multiple compatible sessions; select one with --session")
	}
	return matches[0], nil
}

// module returns the launch and stop declarations of a registered module.
// Sessions opened by a different registry may name a module that is gone, so
// callers must tolerate a miss and fall back to plain termination.
func (m *Manager) module(id string) (registry.Module, bool) {
	for _, e := range m.Modules {
		if e.ID == id {
			return e, true
		}
	}
	return registry.Module{}, false
}

func (m *Manager) Close(ctx context.Context, name string, port int, all bool) error {
	return m.locked(ctx, func(db *database) error {
		found := false
		kept := []Record{}
		var failures []error
		for _, s := range db.Sessions {
			if !all && !(name != "" && s.Name == name) && !(port != 0 && s.Port == port) {
				kept = append(kept, s)
				continue
			}
			found = true
			if err := m.stopProcess(ctx, s); err != nil {
				kept = append(kept, s)
				failures = append(failures, err)
			}
		}
		if !found && !all {
			return errors.New("session not found")
		}
		db.Sessions = kept
		return errors.Join(append(failures, m.save(db))...)
	})
}
