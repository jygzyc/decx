package registry

import (
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"time"
)

// SourceName is the file recording where an imported module came from. It sits
// next to the manifest inside an installed module directory and is deliberately
// not a manifest: discovery only looks at decx.json.
const SourceName = ".decx-source.json"

// Source records the origin of an imported module so `decx self update` can
// re-import it from the same place.
type Source struct {
	Source    string `json:"source"` // "repo" or "path"
	Value     string `json:"value"`  // repository or path as provided
	Ref       string `json:"ref,omitempty"`
	Installed string `json:"installed"` // RFC3339 timestamp of the import
}

// ReadSource reads the recorded install origin of an installed module. A module
// that was installed from a release (or never imported) returns nil.
func ReadSource(root string) (*Source, error) {
	data, err := os.ReadFile(filepath.Join(root, SourceName))
	if errors.Is(err, os.ErrNotExist) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	var s Source
	if err := json.Unmarshal(data, &s); err != nil {
		return nil, err
	}
	if s.Source == "" {
		return nil, nil
	}
	return &s, nil
}

// WriteSource records the install origin of a module. An empty source removes
// any stale record, which is what a release install does.
func WriteSource(root string, s Source) error {
	path := filepath.Join(root, SourceName)
	if s.Source == "" {
		if err := os.Remove(path); err != nil && !errors.Is(err, os.ErrNotExist) {
			return err
		}
		return nil
	}
	if s.Installed == "" {
		s.Installed = time.Now().UTC().Format(time.RFC3339)
	}
	data, err := json.MarshalIndent(s, "", "  ")
	if err != nil {
		return err
	}
	return os.WriteFile(path, append(data, '\n'), 0600)
}
