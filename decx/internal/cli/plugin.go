package cli

import (
	"context"
	"encoding/json"
	"fmt"

	"github.com/jygzyc/decx/decx/internal/plugin"
	"github.com/jygzyc/decx/decx/internal/registry"
)

// runPlugin executes a command that a runtime plugin implements and prints its
// data. Plugins only ever return data: a workflow that produces a file (for
// example a packed framework jar) reports its path and the user decides what to
// do with it, so session ownership stays in the CLI.
func (a *App) runPlugin(ctx context.Context, command []string, definition registry.Plugin, specs []registry.Arg, args map[string][]string) error {
	if !definition.Installed {
		return fmt.Errorf("module %s is not installed; run `decx install --module %s`", definition.ID, definition.ID)
	}
	resolved := plugin.Definition{ID: definition.ID, Entry: definition.Entry, Dir: definition.Root}
	request, err := plugin.NewRequest(command, specs, args, a.Home, resolved.Dir)
	if err != nil {
		return err
	}
	response, err := plugin.Run(ctx, resolved, request, a.Err)
	if err != nil {
		return err
	}
	if err := response.Err(); err != nil {
		return err
	}
	var result any = map[string]any{}
	if len(response.Data) > 0 {
		if err := json.Unmarshal(response.Data, &result); err != nil {
			return fmt.Errorf("plugin %s: invalid data: %w", definition.ID, err)
		}
	}
	return a.output(result)
}
