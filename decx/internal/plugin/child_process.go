package plugin

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"strings"
	"syscall"
	"time"

	"github.com/buke/quickjs-go"
)

func (rt *runtime) childProcessModule() *quickjs.Value {
	module := rt.obj()
	rt.set(module, "spawnSync", rt.fn(rt.spawnSync))
	return module
}

type streamMode int

const (
	streamDefault streamMode = iota
	streamPipe
	streamIgnore
	streamInherit
	streamFile
)

type stdioEntry struct {
	mode streamMode
	fd   int
}

type spawnOptions struct {
	cwd       string
	timeout   time.Duration
	maxBuffer int64
	input     []byte
	encoding  string
	stdio     []*quickjs.Value
	env       []string
	hasEnv    bool
}

func (rt *runtime) spawnOptions(value *quickjs.Value) spawnOptions {
	options := spawnOptions{}
	if isUndefined(value) {
		return options
	}
	if cwd := rt.get(value, "cwd"); !isUndefined(cwd) && cwd.ToString() != "" {
		options.cwd = rt.resolvePath(cwd.ToString())
	}
	if timeout := rt.get(value, "timeout"); !isUndefined(timeout) && timeout.ToInt64() > 0 {
		options.timeout = time.Duration(timeout.ToInt64()) * time.Millisecond
	}
	if maxBuffer := rt.get(value, "maxBuffer"); !isUndefined(maxBuffer) && maxBuffer.ToInt64() > 0 {
		options.maxBuffer = maxBuffer.ToInt64()
	}
	if encoding := rt.get(value, "encoding"); !isUndefined(encoding) {
		options.encoding = encoding.ToString()
	}
	if input := rt.get(value, "input"); !isUndefined(input) {
		options.input = rt.bytesOf(input)
	}
	if env := rt.get(value, "env"); !isUndefined(env) {
		options.hasEnv = true
		options.env = rt.envList(env)
	}
	if stdio := rt.get(value, "stdio"); !isUndefined(stdio) && stdio.IsArray() {
		list := make([]*quickjs.Value, 0, stdio.Len())
		for index := int64(0); index < stdio.Len(); index++ {
			list = append(list, rt.keep(stdio.GetIdx(index)))
		}
		options.stdio = list
	}
	return options
}

// envList converts a JS object into "KEY=value" entries.
func (rt *runtime) envList(value *quickjs.Value) []string {
	entries := []string{}
	if !value.IsObject() || value.IsArray() {
		return entries
	}
	names, err := value.PropertyNames()
	if err != nil {
		return entries
	}
	for _, key := range names {
		item := rt.get(value, key)
		if isUndefined(item) {
			continue
		}
		entries = append(entries, key+"="+item.ToString())
	}
	return entries
}

// stringSlice converts a JS array of values into Go strings.
func (rt *runtime) stringSlice(value *quickjs.Value) []string {
	if isUndefined(value) || !value.IsArray() {
		return nil
	}
	result := make([]string, 0, value.Len())
	for index := int64(0); index < value.Len(); index++ {
		item := rt.keep(value.GetIdx(index))
		if isUndefined(item) {
			result = append(result, "")
			continue
		}
		result = append(result, item.ToString())
	}
	return result
}

func stdioMode(entries []*quickjs.Value, index int) stdioEntry {
	if index >= len(entries) {
		if index == 0 {
			return stdioEntry{mode: streamDefault}
		}
		return stdioEntry{mode: streamPipe}
	}
	value := entries[index]
	switch {
	case value.IsString():
		switch value.ToString() {
		case "pipe":
			return stdioEntry{mode: streamPipe}
		case "ignore":
			return stdioEntry{mode: streamIgnore}
		case "inherit":
			return stdioEntry{mode: streamInherit}
		default:
			return stdioEntry{mode: streamIgnore}
		}
	case value.IsNumber():
		return stdioEntry{mode: streamFile, fd: int(value.ToInt64())}
	}
	if index == 0 {
		return stdioEntry{mode: streamDefault}
	}
	return stdioEntry{mode: streamPipe}
}

// isBatchCommand reports whether command names a Windows batch file. Batch
// files are not executables - CreateProcess cannot start them - so
// spawnCommand routes them through cmd.exe. The check lives here instead of in
// the Windows-only file so it can be unit-tested on every platform.
func isBatchCommand(command string) bool {
	lower := strings.ToLower(command)
	return strings.HasSuffix(lower, ".cmd") || strings.HasSuffix(lower, ".bat")
}

// quoteForCmd quotes one token for a cmd.exe command line. cmd.exe parses
// quotes itself and does not follow the CommandLineToArgvW backslash rules
// that Go's argument escaping targets, so a literal double quote is escaped as
// \" (the form cmd.exe forwards) and quoting is added only when cmd would
// otherwise split the token.
func quoteForCmd(arg string) string {
	if arg != "" && !strings.ContainsAny(arg, " \t\"") {
		return arg
	}
	var quoted strings.Builder
	quoted.Grow(len(arg) + 2)
	quoted.WriteByte('"')
	for i := 0; i < len(arg); i++ {
		if arg[i] == '"' {
			quoted.WriteByte('\\')
		}
		quoted.WriteByte(arg[i])
	}
	quoted.WriteByte('"')
	return quoted.String()
}

// batchCommandLine builds the full command line for `cmd.exe /d /s /c`. /d
// skips AutoRun, /s makes cmd strip the surrounding quotes and use the rest
// verbatim (the documented way to hand a fully quoted line to the
// interpreter), /c runs the command and exits. interpreter is the resolved
// cmd.exe path.
func batchCommandLine(interpreter, command string, args []string) string {
	tokens := make([]string, 0, len(args)+1)
	tokens = append(tokens, quoteForCmd(command))
	for _, arg := range args {
		tokens = append(tokens, quoteForCmd(arg))
	}
	return quoteForCmd(interpreter) + ` /d /s /c "` + strings.Join(tokens, " ") + `"`
}

// signalName maps a POSIX signal to the conventional name Node reports in
// spawnSync results. The switch only mentions constants the Windows syscall
// package also defines, so this compiles for every target.
func signalName(sig syscall.Signal) string {
	switch sig {
	case syscall.SIGHUP:
		return "SIGHUP"
	case syscall.SIGINT:
		return "SIGINT"
	case syscall.SIGQUIT:
		return "SIGQUIT"
	case syscall.SIGILL:
		return "SIGILL"
	case syscall.SIGTRAP:
		return "SIGTRAP"
	case syscall.SIGABRT:
		return "SIGABRT"
	case syscall.SIGBUS:
		return "SIGBUS"
	case syscall.SIGFPE:
		return "SIGFPE"
	case syscall.SIGKILL:
		return "SIGKILL"
	case syscall.SIGSEGV:
		return "SIGSEGV"
	case syscall.SIGPIPE:
		return "SIGPIPE"
	case syscall.SIGALRM:
		return "SIGALRM"
	case syscall.SIGTERM:
		return "SIGTERM"
	}
	return fmt.Sprintf("SIG%d", int(sig))
}

func (rt *runtime) spawnSync(_ *quickjs.Context, _ *quickjs.Value, args []*quickjs.Value) *quickjs.Value {
	command := rt.stringArg(args, 0, "command")
	commandArgs := rt.stringSlice(argAt(args, 1))
	options := rt.spawnOptions(argAt(args, 2))

	stdinEntry := stdioMode(options.stdio, 0)
	stdoutEntry := stdioMode(options.stdio, 1)
	stderrEntry := stdioMode(options.stdio, 2)

	ctx := rt.ctx
	if options.timeout > 0 {
		var cancel context.CancelFunc
		ctx, cancel = context.WithTimeout(ctx, options.timeout)
		defer cancel()
	}

	cmd := spawnCommand(ctx, command, commandArgs)
	if options.cwd != "" {
		cmd.Dir = options.cwd
	}
	if options.hasEnv {
		cmd.Env = options.env
	}

	var stdoutBuffer, stderrBuffer bytes.Buffer
	captureStdout := stdoutEntry.mode == streamPipe
	captureStderr := stderrEntry.mode == streamPipe

	if options.input != nil && (stdinEntry.mode == streamDefault || stdinEntry.mode == streamPipe) {
		cmd.Stdin = bytes.NewReader(options.input)
	}
	switch stdoutEntry.mode {
	case streamPipe:
		cmd.Stdout = &stdoutBuffer
	case streamInherit:
		cmd.Stdout = os.Stdout
	case streamFile:
		file, err := rt.files.get(stdoutEntry.fd)
		if err != nil {
			panic(rt.fsError("write", fmt.Sprintf("fd %d", stdoutEntry.fd), err))
		}
		cmd.Stdout = file
	}
	switch stderrEntry.mode {
	case streamPipe:
		cmd.Stderr = &stderrBuffer
	case streamInherit:
		cmd.Stderr = os.Stderr
	case streamFile:
		file, err := rt.files.get(stderrEntry.fd)
		if err != nil {
			panic(rt.fsError("write", fmt.Sprintf("fd %d", stderrEntry.fd), err))
		}
		cmd.Stderr = file
	}

	runErr := cmd.Run()
	timedOut := ctx.Err() == context.DeadlineExceeded

	result := rt.obj()
	rt.set(result, "pid", rt.num(0))
	rt.set(result, "status", rt.null())
	rt.set(result, "signal", rt.null())
	rt.set(result, "stdout", rt.null())
	rt.set(result, "stderr", rt.null())

	if captureStdout {
		rt.set(result, "stdout", rt.dataResult(truncateOutput(&stdoutBuffer, options.maxBuffer), options.encoding))
	}
	if captureStderr {
		rt.set(result, "stderr", rt.dataResult(truncateOutput(&stderrBuffer, options.maxBuffer), options.encoding))
	}

	switch {
	case timedOut:
		errorValue := rt.errorObject("ETIMEDOUT", fmt.Sprintf("spawnSync %s ETIMEDOUT", command))
		rt.set(errorValue, "code", rt.str("ETIMEDOUT"))
		rt.set(errorValue, "signal", rt.str("SIGTERM"))
		rt.set(result, "error", errorValue)
		rt.set(result, "signal", rt.str("SIGTERM"))
	case runErr == nil:
		if state := cmd.ProcessState; state != nil {
			rt.set(result, "pid", rt.num(float64(state.Pid())))
			rt.set(result, "status", rt.num(float64(state.ExitCode())))
		}
	default:
		var exitError *exec.ExitError
		if errors.As(runErr, &exitError) {
			if state := cmd.ProcessState; state != nil {
				rt.set(result, "pid", rt.num(float64(state.Pid())))
			}
			if code := exitError.ExitCode(); code >= 0 {
				rt.set(result, "status", rt.num(float64(code)))
			} else if name, ok := exitSignal(cmd.ProcessState); ok {
				// A real POSIX signal (e.g. SIGTERM) is reported under its
				// conventional name.
				rt.set(result, "signal", rt.str(name))
			} else {
				// No exit status and no platform signal (Windows, or a Go-side
				// kill): report the conventional forced-termination name instead
				// of leaving the field empty or numeric.
				rt.set(result, "signal", rt.str("SIGKILL"))
			}
		} else {
			errorValue := rt.errorObject(errorCode(runErr), fmt.Sprintf("spawnSync %s %s", command, errorCode(runErr)))
			rt.set(errorValue, "code", rt.str(errorCode(runErr)))
			rt.set(result, "error", errorValue)
		}
	}
	return result
}

// truncateOutput applies Node's maxBuffer semantics to captured output.
func truncateOutput(buffer *bytes.Buffer, maxBuffer int64) []byte {
	data := buffer.Bytes()
	if maxBuffer > 0 && int64(len(data)) > maxBuffer {
		return data[:maxBuffer]
	}
	return data
}
