// Package cli builds the public command surface from the runtime registry.
package cli

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/jygzyc/decx/decx/internal/install"
	"github.com/jygzyc/decx/decx/internal/registry"
	"github.com/jygzyc/decx/decx/internal/session"
)

type App struct {
	Home string
	Out  io.Writer
	Err  io.Writer
	HTTP *http.Client
	// GitHub overrides the release host used by `self install`/`self update`.
	GitHub string
	// GitHubAPI overrides the release metadata host.
	GitHubAPI string
	// SkillsSource overrides the skills checkout used by `self skills install`.
	SkillsSource string
	// UserHome overrides the home directory that client skill directories are
	// linked into (tests); it defaults to the current user's home.
	UserHome string
	// Version is the running CLI version, used by `self update --cli`.
	Version string
	// CLIExecutable overrides the binary `self update --cli` replaces (tests);
	// it defaults to the running executable.
	CLIExecutable string
}

func (a *App) Run(ctx context.Context, input []string) error {
	home, err := filepath.Abs(a.Home)
	if err != nil {
		return err
	}
	a.Home = home
	if a.Out == nil {
		a.Out = os.Stdout
	}
	if a.Err == nil {
		a.Err = os.Stderr
	}
	if a.HTTP == nil {
		// Release downloads redirect to a content host, so redirects must be followed.
		a.HTTP = &http.Client{Timeout: 5 * time.Minute}
	}
	explicit, moduleID := "", ""
parseFlags:
	for len(input) > 0 {
		switch input[0] {
		case "--config":
			if len(input) < 2 {
				return errors.New("--config requires a path")
			}
			explicit, input = input[1], input[2:]
		case "-m", "--module":
			if len(input) < 2 {
				return errors.New("--module requires an id")
			}
			moduleID, input = input[1], input[2:]
		default:
			break parseFlags
		}
	}
	if explicit != "" {
		// --config names a directory of components. A file is accepted for
		// compatibility: it points at the directory holding the components. A
		// path that does not exist is reported instead of being ignored.
		info, statErr := os.Stat(explicit)
		if statErr != nil {
			fmt.Fprintf(a.Err, "decx: --config %s does not exist\n", explicit)
		} else if !info.IsDir() {
			explicit = filepath.Dir(explicit)
		}
	}
	c, err := registry.Load(a.Home, explicit)
	if err != nil {
		return err
	}
	for _, warning := range c.Warnings {
		fmt.Fprintf(a.Err, "decx: %s\n", warning)
	}
	if moduleID != "" {
		if module, ok := c.Module(moduleID); ok {
			if !module.Installed {
				return fmt.Errorf("module %s is not installed; run `decx install --module %s`", module.ID, module.ID)
			}
			return a.runTool(ctx, c, module.Commands, input, "-m "+module.ID, []string{module.ID}, nil, nil)
		}
		if plugin, ok := c.Plugin(moduleID); ok {
			if !plugin.Installed {
				return fmt.Errorf("module %s is not installed; run `decx install --module %s`", plugin.ID, plugin.ID)
			}
			return a.runTool(ctx, c, plugin.Commands, input, "-m "+plugin.ID, nil, &plugin, nil)
		}
		return fmt.Errorf("unknown module %q; see module list", moduleID)
	}
	if len(input) == 0 || input[0] == "--help" || input[0] == "-h" || input[0] == "help" {
		fmt.Fprintln(a.Out, "Usage: decx [--config dir] [--module id] <command> [arguments]\n\nCLI commands:\n  session          Open, inspect and close managed server sessions\n  install          Download modules into DECX_HOME\n  self update      Update installed modules and the decx executable\n  self skills      Install the DECX agent skills for AI clients\n  module list      List discovered modules and their install state\n\nEvery server and plugin is a module described by its own decx.json manifest.\nRun a module command with `decx -m <module> <command>`.\n\nModules (decx -m <module> <command>):")
		for _, module := range c.Modules {
			fmt.Fprintf(a.Out, "  %-16s %-8s %s\n", module.ID, registry.KindServer, module.Description)
		}
		for _, plugin := range c.Plugins {
			fmt.Fprintf(a.Out, "  %-16s %-8s %s\n", plugin.ID, registry.KindPlugin, plugin.Description)
		}
		return nil
	}
	if input[0] == "session" {
		return a.runSession(ctx, c, input[1:])
	}
	if input[0] == "self" {
		return a.runSelf(ctx, c, input[1:])
	}
	if input[0] == "install" {
		return a.runInstall(ctx, c, input[1:])
	}
	if input[0] == "module" {
		if len(input) == 2 && input[1] == "list" {
			return a.output(a.moduleList(c))
		}
		return unknownSubcommand("module", input[1:])
	}
	return fmt.Errorf("unknown command %q; run `decx help`", input[0])
}

func (a *App) output(value any) error { return json.NewEncoder(a.Out).Encode(value) }

// unknownSubcommand reports a bad argument list under a reserved command word.
func unknownSubcommand(command string, rest []string) error {
	if len(rest) == 0 {
		return fmt.Errorf("%s requires a subcommand (list)", command)
	}
	return fmt.Errorf("unknown %s subcommand %q", command, rest[0])
}

// moduleView is the `module list` row: one entry per discovered module,
// server or plugin, with manifest metadata and local install state.
type moduleView struct {
	ID          string `json:"id"`
	Kind        string `json:"kind"`
	Description string `json:"description,omitempty"`
	Default     bool   `json:"default,omitempty"`
	Installed   bool   `json:"installed"`
	Path        string `json:"path,omitempty"`
	Version     string `json:"version,omitempty"`
	Installable bool   `json:"installable"`
	Source      string `json:"source,omitempty"`
}

func (a *App) moduleList(config *registry.Config) []moduleView {
	views := make([]moduleView, 0, len(config.Modules)+len(config.Plugins))
	for _, module := range config.Modules {
		status := install.Inspect(a.Home, module)
		source := recordedSource(a.Home, module.ID)
		views = append(views, moduleView{
			ID:          module.ID,
			Kind:        registry.KindServer,
			Description: module.Description,
			Default:     module.Default,
			Installed:   status.Installed,
			Path:        status.Path,
			Version:     status.Version,
			Installable: module.Release != nil || source != nil,
			Source:      sourceLabel(source),
		})
	}
	for _, plugin := range config.Plugins {
		source := recordedSource(a.Home, plugin.ID)
		views = append(views, moduleView{
			ID:          plugin.ID,
			Kind:        registry.KindPlugin,
			Description: plugin.Description,
			Default:     plugin.Default,
			Installed:   plugin.Installed,
			Path:        plugin.Root,
			Version:     plugin.Version,
			Installable: plugin.Release != nil || source != nil,
			Source:      sourceLabel(source),
		})
	}
	sort.Slice(views, func(i, j int) bool { return views[i].ID < views[j].ID })
	return views
}

// recordedSource reports where a module was imported from, if anywhere.
func recordedSource(home, id string) *registry.Source {
	source, err := registry.ReadSource(registry.ModuleRoot(home, id))
	if err != nil {
		return nil
	}
	return source
}

// sourceLabel renders a recorded origin for display.
func sourceLabel(source *registry.Source) string {
	if source == nil {
		return ""
	}
	if source.Ref != "" && !strings.HasSuffix(source.Value, "@"+source.Ref) {
		return source.Value + "@" + source.Ref
	}
	return source.Value
}

// runTool walks a command tree. path is the human-readable prefix for usage and
// errors, modules selects the server sessions the command may attach to, and
// pluginDef/requestPath carry the runtime plugin plus the command path inside it
// when the tree belongs to a plugin (both nil for module trees).
func (a *App) runTool(ctx context.Context, config *registry.Config, commands []registry.Command, input []string, path string, modules []string, pluginDef *registry.Plugin, requestPath []string) error {
	if len(input) == 0 || input[0] == "--help" || input[0] == "-h" || input[0] == "help" {
		fmt.Fprintf(a.Out, "Usage: decx %s <command>\n\n", path)
		for _, c := range commands {
			fmt.Fprintf(a.Out, "  %-24s %s\n", c.Name, c.About)
		}
		return nil
	}
	for _, cmd := range commands {
		if cmd.Name != input[0] {
			continue
		}
		if len(cmd.Subcommands) > 0 {
			next := append(append([]string{}, requestPath...), cmd.Name)
			return a.runTool(ctx, config, cmd.Subcommands, input[1:], path+" "+cmd.Name, modules, pluginDef, next)
		}
		specs := append(append([]registry.Arg{}, registry.CoreArgs...), cmd.Args...)
		if pluginDef != nil {
			specs = cmd.Args
		}
		if len(input) == 2 && input[1] == "--help" {
			fmt.Fprintf(a.Out, "Usage: decx %s %s [arguments]\n\n%s\n\n", path, cmd.Name, cmd.About)
			for _, arg := range specs {
				name := "--" + arg.Long
				if arg.Kind == "positional" {
					name = "<" + arg.ID + ">"
				}
				if arg.Required {
					name += " (required)"
				}
				fmt.Fprintf(a.Out, "  %-24s %s\n", name, arg.Help)
			}
			return nil
		}
		args, err := registry.ParseArgs(specs, input[1:])
		if err != nil {
			return err
		}
		if pluginDef != nil {
			return a.runPlugin(ctx, append(append([]string{}, requestPath...), cmd.Name), *pluginDef, specs, args)
		}
		ports := args["port"]
		var port uint64
		if len(ports) > 0 {
			if len(args["session"]) > 0 {
				return errors.New("choose either --port or --session")
			}
			port, err = strconv.ParseUint(ports[0], 10, 16)
			if err != nil || port == 0 {
				return errors.New("--port must be between 1 and 65535")
			}
		} else {
			manager := session.Manager{Home: a.Home, Modules: config.Modules, Progress: a.Err}
			selected, err := manager.Select(ctx, first(args, "session"), modules)
			if err != nil {
				return err
			}
			port = uint64(selected.Port)
		}
		body, err := registry.BuildRequest(cmd.Request, args)
		if err != nil {
			return err
		}
		endpoint := cmd.Endpoint
		if !strings.HasPrefix(endpoint, "/") {
			endpoint = "/api/decx/" + endpoint
		}
		return a.request(ctx, fmt.Sprintf("http://127.0.0.1:%d%s", port, endpoint), body)
	}
	return fmt.Errorf("unknown command %s %s", path, input[0])
}

func (a *App) request(ctx context.Context, url string, body map[string]any) error {
	data, err := json.Marshal(body)
	if err != nil {
		return err
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, url, bytes.NewReader(data))
	if err != nil {
		return err
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Accept", "application/json")
	res, err := a.HTTP.Do(req)
	if err != nil {
		return err
	}
	defer res.Body.Close()
	const maxResponse = 64 << 20
	data, err = io.ReadAll(io.LimitReader(res.Body, maxResponse+1))
	if err != nil {
		return err
	}
	if len(data) > maxResponse {
		return errors.New("server response exceeds 64 MiB")
	}
	if !json.Valid(data) {
		return fmt.Errorf("server returned invalid JSON (HTTP %d)", res.StatusCode)
	}
	if _, err := fmt.Fprintln(a.Out, string(data)); err != nil {
		return err
	}
	var result struct {
		OK *bool `json:"ok"`
	}
	_ = json.Unmarshal(data, &result)
	if res.StatusCode < 200 || res.StatusCode >= 300 || (result.OK != nil && !*result.OK) {
		return fmt.Errorf("server request failed (HTTP %d)", res.StatusCode)
	}
	return nil
}
