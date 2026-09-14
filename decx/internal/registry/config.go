// Package registry loads the runtime command contract: the decx.json manifests
// of the components installed under DECX_HOME. There is no catalog — a server or
// plugin describes itself, including where its releases come from.
package registry

import (
	"encoding/json"
	"errors"
	"fmt"
	"path/filepath"
	"regexp"
	"slices"
	"strings"
)

// CoreArgs are the flags the CLI itself owns, accepted by every engine command;
// a command tree may map them.
var CoreArgs = []Arg{
	{ID: "session", Kind: "value", Long: "session", Help: "Select a named session; required when multiple are running"},
	{ID: "port", Kind: "value", Long: "port", Help: "Connect to a DECX HTTP server on this port"},
	{ID: "page", Kind: "value", Long: "page", Type: "u64", Help: "Result page number to fetch"},
}

// Config is the loaded registry: every module found as a decx.json manifest
// under DECX_HOME. Server and plugin modules are kept apart because they
// execute differently, but they share one user-facing surface: the CLI's own
// management words (session, self, install, module) and `decx -m <id>` for a
// module's command tree.
type Config struct {
	Engines []Engine
	Plugins []Plugin

	// Warnings collects components that were found but skipped (a manifest that
	// does not parse, an id that does not match its directory). The CLI reports
	// them on stderr so a broken artifact still leaves `decx install` usable.
	Warnings []string
}

// DefaultRepository is the release source components fall back to when neither
// their install block nor the release section names a repository.
const DefaultRepository = "jygzyc/decx"

type Command struct {
	Name        string    `json:"name"`
	About       string    `json:"about"`
	Endpoint    string    `json:"endpoint,omitempty"`
	Args        []Arg     `json:"args,omitempty"`
	Request     []Mapping `json:"request,omitempty"`
	Subcommands []Command `json:"subcommands,omitempty"`
}
type Arg struct {
	ID       string   `json:"id"`
	Kind     string   `json:"kind"`
	Long     string   `json:"long,omitempty"`
	Type     string   `json:"type,omitempty"`
	Help     string   `json:"help,omitempty"`
	Required bool     `json:"required,omitempty"`
	Values   []string `json:"values,omitempty"`
}
type Mapping struct {
	Arg     string          `json:"arg"`
	Field   string          `json:"field"`
	Type    string          `json:"type"`
	When    string          `json:"when"`
	Default json.RawMessage `json:"default,omitempty"`
	Invert  bool            `json:"invert,omitempty"`
}

// Engine is one server: its decx.json manifest declares how it runs and where
// its releases come from.
type Engine struct {
	ID          string
	Description string
	Binary      Binary
	Launch      Launch
	Release     *Install
	Commands    []Command

	Installed bool
	Version   string
	Root      string
	Default   bool
}

// Plugin is a workflow implemented by compiled JavaScript that the CLI runs
// in-process. Its decx.json declares the entry bundle, the command tree reached
// as `decx -m <id> <command>` and the release it is installed from.
type Plugin struct {
	ID          string
	Description string
	Release     *Install
	Entry       string
	Commands    []Command

	Installed bool
	Version   string
	Root      string
	Default   bool
}
type Binary struct {
	Kind string `json:"kind"`
	Path string `json:"path"`
	Env  string `json:"env,omitempty"`
}
type Launch struct {
	Command      []string `json:"command"`
	Stop         Stop     `json:"stop,omitempty"`
	Scripts      string   `json:"scripts,omitempty"`
	TrailingArgs bool     `json:"trailing_args,omitempty"`
}

// Stop declares how a server is stopped. The string form "terminate" (also the
// behavior when the field is absent) ends the server process; a command list
// runs first so a server can shut down gracefully, with termination as the
// fallback when the process survives it. A stop command may use {pid}, {port},
// {binary}, {home} and {target}.
type Stop struct {
	Command []string
}

func (s *Stop) UnmarshalJSON(data []byte) error {
	var mode string
	if err := json.Unmarshal(data, &mode); err == nil {
		if mode != "terminate" {
			return fmt.Errorf("unknown stop mode %q (use \"terminate\" or a command list)", mode)
		}
		s.Command = nil
		return nil
	}
	var command []string
	if err := json.Unmarshal(data, &command); err != nil {
		return errors.New("stop must be \"terminate\" or a command list")
	}
	if len(command) == 0 || command[0] == "" {
		return errors.New("stop command must not be empty")
	}
	s.Command = command
	return nil
}

func (s Stop) MarshalJSON() ([]byte, error) {
	if len(s.Command) == 0 {
		return []byte(`"terminate"`), nil
	}
	return json.Marshal(s.Command)
}

// Install describes where a component's release comes from. The CLI reads the
// newest release of Repository whose tag matches Tag and that publishes Asset
// (releases are scanned, so no version is pinned by default).
//
// Tag is the release tag pattern ("asc-server-v{version}"); the version is read
// back from the matching tag. Asset and Tag take {version} plus the optional
// {os}/{arch} tokens. Checksums names the checksum file published next to the
// assets ("SHA256SUMS", one `sha256sum`-style line per asset); its entries are
// verified before anything is unpacked. Format is "zip" or "tar.gz" (the
// artifact always has to carry a decx.json manifest).
type Install struct {
	Source         string   `json:"source"`
	Repository     string   `json:"repository,omitempty"`
	Tag            string   `json:"tag,omitempty"`
	Asset          string   `json:"asset,omitempty"`
	AssetFallbacks []string `json:"asset_fallbacks,omitempty"`
	Checksums      string   `json:"checksums,omitempty"`
	Path           string   `json:"path,omitempty"`
	Format         string   `json:"format,omitempty"`
}

// Load reads the components installed under DECX_HOME. extraDirs are additional
// root directories scanned the same way (an explicit --config path), so a
// checkout can be used without installing anything.
func Load(home string, extraDirs ...string) (*Config, error) {
	c := &Config{Engines: []Engine{}, Plugins: []Plugin{}}
	c.attach(home, extraDirs)
	c.applyKnown()
	return c, nil
}

// Engine returns the engine with this id.
func (c *Config) Engine(id string) (Engine, bool) {
	for _, e := range c.Engines {
		if e.ID == id {
			return e, true
		}
	}
	return Engine{}, false
}

// Plugin returns the plugin with this id.
func (c *Config) Plugin(id string) (Plugin, bool) {
	for _, p := range c.Plugins {
		if p.ID == id {
			return p, true
		}
	}
	return Plugin{}, false
}

// attach collects the manifests of every component found under home and the
// extra roots: an installed component wins over a checkout, and a manifest that
// fails to load is reported as a warning.
func (c *Config) attach(home string, extraDirs []string) {
	servers, warnings := ScanManifests(home, KindServer, extraDirs)
	c.Warnings = append(c.Warnings, warnings...)
	for _, id := range sortedKeys(servers) {
		engine := Engine{ID: id}
		engine.apply(servers[id])
		c.Engines = append(c.Engines, engine)
	}
	plugins, warnings := ScanManifests(home, KindPlugin, extraDirs)
	c.Warnings = append(c.Warnings, warnings...)
	for _, id := range sortedKeys(plugins) {
		plugin := Plugin{ID: id}
		plugin.apply(plugins[id])
		c.Plugins = append(c.Plugins, plugin)
	}
}

func (e *Engine) apply(found Found) {
	manifest := found.Manifest
	e.Description = manifest.Description
	e.Binary = *manifest.Binary
	e.Launch = *manifest.Launch
	e.Release = manifest.Release
	e.Commands = manifest.Commands
	e.Installed = true
	e.Root = found.Root
	e.Version = manifestVersion(manifest, found.Root)
}

func (p *Plugin) apply(found Found) {
	manifest := found.Manifest
	p.Description = manifest.Description
	p.Release = manifest.Release
	p.Entry = manifest.Entry
	p.Commands = manifest.Commands
	p.Installed = true
	p.Root = found.Root
	p.Version = manifestVersion(manifest, found.Root)
}

// reserved names are the CLI's own top-level words: they own their namespace
// and never resolve to an engine, and an engine may not be named after them.
var reserved = map[string]bool{"session": true, "engine": true, "plugin": true, "module": true, "self": true, "install": true, "settings": true, "help": true}

var namePattern = regexp.MustCompile(`^[a-z][a-z0-9-]*$`)
var endpointPattern = regexp.MustCompile(`^[a-zA-Z0-9_/-]+$`)
var fieldPattern = regexp.MustCompile(`^[a-zA-Z_][a-zA-Z0-9_]*(\.[a-zA-Z_][a-zA-Z0-9_]*)*$`)
var placeholderPattern = regexp.MustCompile(`\{[^{}]*\}`)

var repositoryPattern = regexp.MustCompile(`^[A-Za-z0-9._-]+/[A-Za-z0-9._-]+$`)

// installPlaceholders are the tokens an install asset or tag may use. {version}
// is mandatory (assets are looked up per release) and {os}/{arch} let one
// component publish platform-specific archives.
var installPlaceholders = []string{"{version}", "{os}", "{arch}"}

// startPlaceholders are the tokens a launch command may use.
var startPlaceholders = []string{"{binary}", "{target}", "{port}", "{home}"}

// stopPlaceholders are the tokens a stop command may use.
var stopPlaceholders = []string{"{pid}", "{port}", "{binary}", "{home}", "{target}"}

// validateLaunch checks the command templates of one engine.
func validateLaunch(id string, launch Launch) error {
	if err := validateTemplate(id, "launch", launch.Command, startPlaceholders); err != nil {
		return err
	}
	return validateTemplate(id, "stop", launch.Stop.Command, stopPlaceholders)
}

func validateTemplate(id, field string, command, allowed []string) error {
	for _, part := range command {
		for _, placeholder := range placeholderPattern.FindAllString(part, -1) {
			if !slices.Contains(allowed, placeholder) {
				return fmt.Errorf("engine %s: unknown %s placeholder %s", id, field, placeholder)
			}
		}
		if strings.ContainsAny(placeholderPattern.ReplaceAllString(part, ""), "{}") {
			return fmt.Errorf("engine %s: malformed %s placeholder", id, field)
		}
	}
	return nil
}

// validateRelease keeps a manifest's release block honest: it has to name a
// GitHub repository and an archive asset that carries a decx.json manifest, so
// the CLI can derive what to download and how to unpack it. A component without
// a release block can still be installed by naming its id, in which case the
// archive is discovered by its asset name.
func validateRelease(id string, release *Install) error {
	if release == nil {
		return nil
	}
	if release.Source != "" && release.Source != "repo" {
		return fmt.Errorf("%s: a release block installs from a repository", id)
	}
	if release.Path != "" {
		return fmt.Errorf("%s: a release block cannot declare a local path", id)
	}
	// Repository releases publish the SHA-256 of their archive, and a download
	// without that checksum file could not be verified. Local sources are
	// rejected above, so every surviving release is a repository release.
	if release.Checksums == "" {
		return fmt.Errorf("%s: a repository release needs a checksums asset", id)
	}
	if release.Repository == "" {
		release.Repository = DefaultRepository
	}
	if !repositoryPattern.MatchString(release.Repository) {
		return fmt.Errorf("%s: invalid release repository %q", id, release.Repository)
	}
	switch release.Format {
	case "", "zip", "tar.gz":
	default:
		return fmt.Errorf("%s: unsupported release format %q", id, release.Format)
	}
	if release.Asset == "" {
		return fmt.Errorf("%s: a release block needs an asset", id)
	}
	if release.Tag != "" && !strings.Contains(release.Tag, "{version}") {
		return fmt.Errorf("%s: release tag must contain {version}", id)
	}
	for _, asset := range append([]string{release.Asset}, release.AssetFallbacks...) {
		if !strings.Contains(asset, "{version}") {
			return fmt.Errorf("%s: release asset %q must contain {version}", id, asset)
		}
		stripped := asset
		for _, token := range installPlaceholders {
			stripped = strings.ReplaceAll(stripped, token, "")
		}
		if strings.ContainsAny(stripped, "{}") {
			return fmt.Errorf("%s: release asset %q uses an unsupported placeholder (supported: {version}, {os}, {arch})", id, asset)
		}
		if strings.ContainsAny(stripped, "/\\") {
			return fmt.Errorf("%s: release asset %q must be a file name", id, asset)
		}
		if !isArchiveName(asset) {
			return fmt.Errorf("%s: release artifacts are archives (.zip or .tar.gz)", id)
		}
	}
	if release.Checksums != "" && strings.ContainsAny(release.Checksums, "/\\") {
		return fmt.Errorf("%s: the checksum asset must be a file name", id)
	}
	return nil
}

// isArchiveName reports whether an asset name is an archive the installer can
// unpack (every component ships a decx.json, so a bare executable cannot be
// installed).
func isArchiveName(name string) bool {
	return strings.HasSuffix(name, ".zip") || strings.HasSuffix(name, ".tar.gz") || strings.HasSuffix(name, ".tgz")
}

// validateRelativePath accepts a slash-separated path of plain segments, so an
// install can never write outside DECX_HOME.
func validateRelativePath(path string) error {
	if path == "" {
		return nil
	}
	if strings.HasPrefix(path, "/") || filepath.IsAbs(path) {
		return errors.New("must be relative")
	}
	for _, segment := range strings.Split(path, "/") {
		if segment == "" || segment == "." || segment == ".." {
			return fmt.Errorf("invalid segment %q", segment)
		}
		if strings.ContainsAny(segment, "\\") {
			return fmt.Errorf("invalid segment %q", segment)
		}
	}
	return nil
}

func validateArgs(args []Arg) (map[string]Arg, error) {
	ids, longs := map[string]Arg{}, map[string]bool{}
	for _, a := range args {
		if _, exists := ids[a.ID]; exists || !namePattern.MatchString(a.ID) {
			return nil, fmt.Errorf("invalid or duplicate argument %q", a.ID)
		}
		if a.Kind != "flag" && a.Kind != "value" && a.Kind != "multi" && a.Kind != "positional" {
			return nil, fmt.Errorf("argument %s: invalid kind", a.ID)
		}
		if a.Kind == "positional" {
			if a.Long != "" {
				return nil, fmt.Errorf("positional %s has a flag", a.ID)
			}
		} else {
			if !namePattern.MatchString(a.Long) || a.Long == "help" || longs[a.Long] {
				return nil, fmt.Errorf("invalid or duplicate flag %q", a.Long)
			}
			longs[a.Long] = true
		}
		if a.Type != "" && a.Type != "string" && a.Type != "u64" && a.Type != "bool" {
			return nil, fmt.Errorf("argument %s: invalid type", a.ID)
		}
		ids[a.ID] = a
	}
	return ids, nil
}

// validateCommands checks one command tree. allowLocal is true for plugin
// command trees: their leaves are executed in-process by that plugin and may
// not declare remote routing, while every server leaf must route to that
// server's HTTP endpoint.
func validateCommands(commands []Command, allowLocal bool) error {
	names := map[string]bool{}
	for _, cmd := range commands {
		if !namePattern.MatchString(cmd.Name) || names[cmd.Name] {
			return fmt.Errorf("invalid or duplicate command %q", cmd.Name)
		}
		names[cmd.Name] = true
		if len(cmd.Subcommands) > 0 {
			if cmd.Endpoint != "" || len(cmd.Request) > 0 || len(cmd.Args) > 0 {
				return fmt.Errorf("command %s cannot have a route or arguments", cmd.Name)
			}
			if err := validateCommands(cmd.Subcommands, allowLocal); err != nil {
				return err
			}
			continue
		}
		if allowLocal {
			if cmd.Endpoint != "" || len(cmd.Request) > 0 {
				return fmt.Errorf("command %s cannot declare remote routing", cmd.Name)
			}
			if _, err := validateArgs(cmd.Args); err != nil {
				return err
			}
			continue
		}
		if !endpointPattern.MatchString(cmd.Endpoint) || strings.Contains(cmd.Endpoint, "//") {
			return fmt.Errorf("command %s: invalid endpoint", cmd.Name)
		}
		args, err := validateArgs(append(append([]Arg{}, CoreArgs...), cmd.Args...))
		if err != nil {
			return fmt.Errorf("command %s: %w", cmd.Name, err)
		}
		fields := []string{}
		for _, m := range cmd.Request {
			a, exists := args[m.Arg]
			if !exists {
				return fmt.Errorf("command %s: unmapped argument %s", cmd.Name, m.Arg)
			}
			if !fieldPattern.MatchString(m.Field) {
				return fmt.Errorf("invalid request field %q", m.Field)
			}
			for _, f := range fields {
				if f == m.Field || strings.HasPrefix(f, m.Field+".") || strings.HasPrefix(m.Field, f+".") {
					return fmt.Errorf("conflicting request fields %s and %s", f, m.Field)
				}
			}
			fields = append(fields, m.Field)
			if m.When != "set" && m.When != "always" {
				return fmt.Errorf("invalid mapping condition %q", m.When)
			}
			if m.Type != "string" && m.Type != "string[]" && m.Type != "bool" && m.Type != "u64" {
				return fmt.Errorf("invalid mapping type %q", m.Type)
			}
			if m.Invert && m.Type != "bool" {
				return fmt.Errorf("invert requires boolean mapping")
			}
			if (a.Kind == "flag" && m.Type != "bool") || (a.Kind == "multi" && m.Type != "string[]") {
				return fmt.Errorf("argument %s: incompatible mapping type", a.ID)
			}
			if len(m.Default) > 0 {
				if _, err := defaultValue(m); err != nil {
					return err
				}
			}
		}
	}
	return nil
}
