package cli

import (
	"context"
	"errors"
	"fmt"
	"strconv"
	"time"

	"github.com/jygzyc/decx/decx/internal/registry"
	"github.com/jygzyc/decx/decx/internal/session"
)

func first(args map[string][]string, id string) string {
	if len(args[id]) > 0 {
		return args[id][0]
	}
	return ""
}

func (a *App) runSession(ctx context.Context, config *registry.Config, input []string) error {
	if len(input) == 0 || input[0] == "--help" || (len(input) == 2 && input[1] == "--help") {
		fmt.Fprintln(a.Out, "Usage:\n  decx session open <target> --module <id> [--name <name>] [--port <port>] [--timeout <seconds>] [--script <path>] [--force] [-- <server arguments>]\n  decx session list\n  decx session check [<name>]\n  decx session close [<name> | --port <port> | --all]\n\nOpen defaults to the module marked as default; use --module to select another.\nOpen waits up to 300 seconds. Timeout preserves the session for check/close.")
		return nil
	}
	manager := session.Manager{Home: a.Home, Modules: config.Modules, Progress: a.Err}
	switch input[0] {
	case "list", "check":
		max := 1
		if input[0] == "check" {
			max = 2
		}
		if len(input) > max {
			return errors.New("unexpected session arguments")
		}
		sessions, err := manager.List(ctx)
		if err != nil {
			return err
		}
		if len(input) == 2 {
			for _, s := range sessions {
				if s.Name == input[1] {
					return a.output(s)
				}
			}
			return errors.New("session not found")
		}
		return a.output(sessions)
	case "close":
		specs := []registry.Arg{{ID: "name", Kind: "positional"}, {ID: "port", Long: "port", Kind: "value", Type: "u64"}, {ID: "all", Long: "all", Kind: "flag"}}
		args, err := registry.ParseArgs(specs, input[1:])
		if err != nil {
			return err
		}
		name := first(args, "name")
		port := 0
		if value := first(args, "port"); value != "" {
			port, err = strconv.Atoi(value)
			if err != nil || port < 1 || port > 65535 {
				return errors.New("invalid port")
			}
		}
		all, _ := strconv.ParseBool(first(args, "all"))
		selectors := 0
		if name != "" {
			selectors++
		}
		if port != 0 {
			selectors++
		}
		if all {
			selectors++
		}
		if selectors != 1 {
			return errors.New("select exactly one of name, --port or --all")
		}
		if err := manager.Close(ctx, name, port, all); err != nil {
			return err
		}
		return a.output(map[string]bool{"ok": true})
	case "open":
		specs := []registry.Arg{
			{ID: "target", Kind: "positional", Required: true},
			{ID: "module", Long: "module", Kind: "value"},
			{ID: "name", Long: "name", Kind: "value"},
			{ID: "port", Long: "port", Kind: "value", Type: "u64"},
			{ID: "timeout", Long: "timeout", Kind: "value", Type: "u64"},
			{ID: "script", Long: "script", Kind: "multi"},
			{ID: "force", Long: "force", Kind: "flag"},
		}
		ownArgs := input[1:]
		var trailing []string
		for i, arg := range ownArgs {
			if arg == "--" {
				trailing = ownArgs[i+1:]
				ownArgs = ownArgs[:i]
				break
			}
		}
		args, err := registry.ParseArgs(specs, ownArgs)
		if err != nil {
			return err
		}
		options := session.OpenOptions{Target: first(args, "target"), Name: first(args, "name"), Scripts: args["script"], Args: trailing}
		options.Force, _ = strconv.ParseBool(first(args, "force"))
		if v := first(args, "port"); v != "" {
			options.Port, err = strconv.Atoi(v)
			if err != nil || options.Port < 1 || options.Port > 65535 {
				return errors.New("invalid port")
			}
		}
		if v := first(args, "timeout"); v != "" {
			seconds, e := strconv.ParseUint(v, 10, 32)
			if e != nil || seconds == 0 || seconds > 86400 {
				return errors.New("timeout must be between 1 and 86400 seconds")
			}
			options.Timeout = time.Duration(seconds) * time.Second
		}
		result, err := a.openTarget(ctx, config, first(args, "module"), options)
		if err != nil {
			return err
		}
		return a.output(result)
	default:
		return fmt.Errorf("unknown session command %q", input[0])
	}
}

// openTarget selects the requested module and opens an analysis session.
func (a *App) openTarget(ctx context.Context, config *registry.Config, moduleID string, options session.OpenOptions) (session.Record, error) {
	// Without an explicit flag the module marked as default is selected, so a
	// bare `session open` works even though the known table always registers
	// several modules.
	if moduleID == "" {
		for i := range config.Modules {
			if config.Modules[i].Default {
				moduleID = config.Modules[i].ID
				break
			}
		}
	}
	var module *registry.Module
	for i := range config.Modules {
		if config.Modules[i].ID == moduleID {
			module = &config.Modules[i]
			break
		}
	}
	if module == nil {
		return session.Record{}, errors.New("select a registered module with --module; see module list")
	}
	options.Module = *module
	manager := session.Manager{Home: a.Home, Modules: config.Modules, Progress: a.Err}
	return manager.Open(ctx, options)
}
