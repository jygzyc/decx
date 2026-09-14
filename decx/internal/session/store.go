// Package session owns persistent server processes independently of tool domains.
package session

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"time"

	"github.com/gofrs/flock"
)

type Record struct {
	Name           string    `json:"name"`
	Module         string    `json:"module"`
	Target         string    `json:"target"`
	Hash           string    `json:"hash"`
	Identity       string    `json:"identity"`
	PID            int32     `json:"pid"`
	ProcessCreated int64     `json:"process_created"`
	Port           int       `json:"port"`
	Log            string    `json:"log"`
	Created        time.Time `json:"created"`
	State          string    `json:"state"`
}

type database struct {
	Version  int      `json:"version"`
	Sessions []Record `json:"sessions"`
}

func (m *Manager) locked(ctx context.Context, action func(*database) error) error {
	if err := os.MkdirAll(m.Home, 0700); err != nil {
		return err
	}
	lock := flock.New(filepath.Join(m.Home, "sessions-v2.lock"))
	lockCtx, cancel := context.WithTimeout(ctx, 30*time.Second)
	defer cancel()
	ok, err := lock.TryLockContext(lockCtx, 50*time.Millisecond)
	if err != nil {
		return err
	}
	if !ok {
		return fmt.Errorf("session store is busy: %w", lockCtx.Err())
	}
	defer lock.Close()
	db := database{Version: 2, Sessions: []Record{}}
	data, err := os.ReadFile(filepath.Join(m.Home, "sessions-v2.json"))
	if err != nil && !errors.Is(err, os.ErrNotExist) {
		return err
	}
	if err == nil {
		if err := json.Unmarshal(data, &db); err != nil {
			return fmt.Errorf("invalid session store: %w", err)
		}
		if db.Version != 2 {
			return fmt.Errorf("unsupported session store version %d", db.Version)
		}
		seen := map[string]bool{}
		for _, s := range db.Sessions {
			if s.Name == "" || seen[s.Name] || s.PID <= 0 || s.ProcessCreated <= 0 || s.Port < 1 || s.Port > 65535 {
				return errors.New("invalid session record; refusing to alter process state")
			}
			seen[s.Name] = true
		}
	}
	return action(&db)
}

func (m *Manager) save(db *database) error {
	data, err := json.MarshalIndent(db, "", "  ")
	if err != nil {
		return err
	}
	f, err := os.CreateTemp(m.Home, ".sessions-*.json")
	if err != nil {
		return err
	}
	defer os.Remove(f.Name())
	_, writeErr := f.Write(append(data, '\n'))
	syncErr := f.Sync()
	if err := errors.Join(writeErr, syncErr, f.Close()); err != nil {
		return err
	}
	return replaceStore(os.Rename, f.Name(), filepath.Join(m.Home, "sessions-v2.json"))
}

// storeRenameAttempts/storeRenameBackoff bound the replace retry window at a
// few attempts over roughly a second.
const storeRenameAttempts = 5

// storeRenameBackoff is a variable so tests can shrink the retry window.
var storeRenameBackoff = 100 * time.Millisecond

// replaceStore atomically replaces target with source. On Windows a rename
// over an existing file fails transiently with a sharing violation while
// another process (or an indexer/antivirus) holds the destination open, so
// retry briefly with backoff before surfacing the error. rename is passed in
// so tests can inject failures.
func replaceStore(rename func(string, string) error, source, target string) error {
	var err error
	delay := storeRenameBackoff
	for attempt := 1; attempt <= storeRenameAttempts; attempt++ {
		if err = rename(source, target); err == nil {
			return nil
		}
		if attempt == storeRenameAttempts {
			break
		}
		time.Sleep(delay)
		delay *= 2
	}
	return fmt.Errorf("replace session store: %w", err)
}
