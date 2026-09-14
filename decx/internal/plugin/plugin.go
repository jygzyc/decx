// Package plugin runs the runtime plugins declared in the registry. A plugin is
// one compiled, self-contained JavaScript file that the CLI executes in-process
// with an embedded QuickJS engine; the file reaches the host through the `decx`
// global and publishes `globalThis.handle`, which the CLI calls with the command
// request. See plugins/README.md for the contract.
package plugin

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"

	"github.com/jygzyc/decx/decx/internal/registry"
)

// Protocol is the request/response contract version understood by this CLI.
const Protocol = 1

// Definition is a resolved runtime plugin: the compiled entry file and the
// directory it ships in.
type Definition struct {
	ID    string
	Entry string
	Dir   string
}

// Request is one plugin invocation.
type Request struct {
	Protocol    int            `json:"protocol"`
	Command     []string       `json:"command"`
	Args        map[string]any `json:"args"`
	Positionals []string       `json:"positionals"`
	Context     Context        `json:"context"`
}

// Context tells the plugin where it runs and where DECX state lives.
type Context struct {
	Home      string `json:"home"`
	Cwd       string `json:"cwd"`
	PluginDir string `json:"pluginDir"`
}

// Response is the plugin's JSON envelope.
type Response struct {
	OK    bool            `json:"ok"`
	Data  json.RawMessage `json:"data,omitempty"`
	Error *ResponseError  `json:"error,omitempty"`
}

// ResponseError is a structured plugin failure.
type ResponseError struct {
	Code    string          `json:"code"`
	Message string          `json:"message"`
	Details json.RawMessage `json:"details,omitempty"`
}

func (e *ResponseError) Error() string {
	if len(e.Details) == 0 || string(e.Details) == "null" {
		return fmt.Sprintf("%s: %s", e.Code, e.Message)
	}
	return fmt.Sprintf("%s: %s (%s)", e.Code, e.Message, e.Details)
}

// Err converts the envelope into a CLI error.
func (r *Response) Err() error {
	if r.OK {
		return nil
	}
	if r.Error == nil {
		return errors.New("plugin reported a failure without an error")
	}
	return r.Error
}

// NewRequest builds an invocation from the parsed command line. Single-value
// arguments become JSON strings, repeated arguments become arrays, and
// positionals keep their declaration order.
func NewRequest(command []string, specs []registry.Arg, args map[string][]string, home, pluginDir string) (Request, error) {
	cwd, err := os.Getwd()
	if err != nil {
		return Request{}, err
	}
	request := Request{
		Protocol: Protocol,
		Command:  command,
		Args:     map[string]any{},
		Context:  Context{Home: home, Cwd: cwd, PluginDir: pluginDir},
	}
	for id, values := range args {
		switch len(values) {
		case 0:
		case 1:
			request.Args[id] = values[0]
		default:
			request.Args[id] = append([]string{}, values...)
		}
	}
	for _, spec := range specs {
		if spec.Kind != "positional" {
			continue
		}
		for _, value := range args[spec.ID] {
			request.Positionals = append(request.Positionals, value)
		}
	}
	return request, nil
}

// normalizeContext guarantees the paths a plugin resolves against: callers
// that build a request without a resolved context (tests, embedders) still get
// the directory of the plugin being invoked instead of the process directory.
func normalizeContext(context Context, def Definition) Context {
	if context.PluginDir == "" {
		context.PluginDir = def.Dir
	}
	if context.Cwd == "" {
		if cwd, err := os.Getwd(); err == nil {
			context.Cwd = cwd
		}
	}
	return context
}

// Run executes one plugin invocation inside the embedded JavaScript runtime.
func Run(ctx context.Context, def Definition, request Request, stderr io.Writer) (*Response, error) {
	request.Context = normalizeContext(request.Context, def)
	rt, err := newRuntime(ctx, def, stderr)
	if err != nil {
		return nil, fmt.Errorf("plugin %s: %w", def.ID, err)
	}
	defer rt.close()
	entry := filepath.Join(def.Dir, filepath.FromSlash(def.Entry))
	response, err := rt.invoke(entry, request)
	if err != nil {
		var failure *ResponseError
		if errors.As(err, &failure) {
			return nil, failure
		}
		return nil, fmt.Errorf("plugin %s: %w", def.ID, err)
	}
	return response, nil
}

// DecodeResponse parses a plugin JSON envelope. Kept for callers that inspect
// responses produced elsewhere (tests, transcripts).
func DecodeResponse(stdout []byte) (*Response, error) {
	trimmed := bytes.TrimSpace(stdout)
	if len(trimmed) == 0 {
		return nil, errors.New("returned no response")
	}
	var response Response
	decoder := json.NewDecoder(bytes.NewReader(trimmed))
	if err := decoder.Decode(&response); err != nil {
		return nil, fmt.Errorf("invalid JSON response: %w", err)
	}
	if _, err := decoder.Token(); err != io.EOF {
		return nil, errors.New("invalid JSON response: trailing data")
	}
	if !response.OK && response.Error == nil {
		return nil, errors.New("returned an empty error")
	}
	return &response, nil
}
