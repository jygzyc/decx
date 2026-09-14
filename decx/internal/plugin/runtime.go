package plugin

import (
	"context"
	_ "embed"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	goruntime "runtime"
	"strings"

	"github.com/buke/quickjs-go"
)

//go:embed prelude.js
var preludeSource string

// bootstrapSource defines the identity helper used by handOver. It runs before
// any other script so host objects can be handed to the engine while the
// runtime boots.
const bootstrapSource = `(function () {
  globalThis.__decxIdentity = function (value) { return value; };
})();
`

// bridgeSource installs the helpers that shield the Go host from engine
// exceptions: every call into plugin code goes through __decxInvoke, which
// turns a thrown value into a plain {ok, value|error} object, and
// __decxStringify/__decxWriteBytes cover the two places where the Go binding
// cannot express the Node behaviour directly.
const bridgeSource = `(function () {
  globalThis.__decxDescribeError = function (error) {
    const described = { name: "Error", message: "plugin failed", stack: "" };
    if (error === null || error === undefined) {
      described.message = String(error);
      return described;
    }
    if (typeof error !== "object") {
      described.message = String(error);
      return described;
    }
    if (error.name !== undefined) described.name = String(error.name);
    if (error.message !== undefined) described.message = String(error.message);
    if (error.code !== undefined && String(error.code).trim() !== "") described.code = String(error.code);
    if (error.stack !== undefined) described.stack = String(error.stack);
    if (error.details !== undefined) {
      try {
        described.details = JSON.stringify(error.details);
      } catch (ignored) {
        // details that cannot be stringified stay absent
      }
    }
    return described;
  };
  globalThis.__decxInvoke = function (fn, thisArg) {
    const args = Array.prototype.slice.call(arguments, 2);
    try {
      return { ok: true, value: fn.apply(thisArg, args) };
    } catch (error) {
      return { ok: false, error: globalThis.__decxDescribeError(error) };
    }
  };
  globalThis.__decxStringify = function (value) {
    try {
      const text = JSON.stringify(value);
      return { ok: true, value: text === undefined ? "" : text };
    } catch (error) {
      return { ok: false, error: globalThis.__decxDescribeError(error) };
    }
  };
  globalThis.__decxWriteBytes = function (target, offset, bytes) {
    if (target === null || target === undefined || !(target instanceof Uint8Array)) {
      throw new TypeError("the buffer argument must be a Buffer");
    }
    target.set(bytes, Number(offset) || 0);
    return true;
  };
})();
`

const (
	// pluginMemoryLimit caps one plugin invocation; extraction workloads
	// (framework process) run entirely inside the engine, so the limit is
	// generous but far below the Go process budget.
	pluginMemoryLimit = 1024 * 1024 * 1024
	// pluginMaxStack keeps runaway recursion inside the engine instead of the
	// Go stack.
	pluginMaxStack = 4 * 1024 * 1024
)

// runtime is one JavaScript engine instance with the Node-ish host modules
// installed. A runtime is used for exactly one plugin invocation, on the
// goroutine that created it (the binding rejects cross-goroutine use).
type runtime struct {
	ctx    context.Context
	vm     *quickjs.Runtime
	js     *quickjs.Context
	stderr io.Writer
	files  *fileTable
	// identityFn is the JavaScript identity helper used by handOver.
	identityFn *quickjs.Value
	// arena owns every value the host created or received. The engine frees
	// values by reference count, and the vendored QuickJS aborts if objects are
	// still referenced when the runtime is freed, so the arena releases them in
	// one pass before the context closes. Values borrowed from the engine
	// (callback arguments, this, globals) are never tracked.
	arena []*quickjs.Value
}

// keep records a value owned by the host so close() releases it.
func (rt *runtime) keep(value *quickjs.Value) *quickjs.Value {
	if value != nil {
		rt.arena = append(rt.arena, value)
	}
	return value
}

func newRuntime(ctx context.Context, def Definition, stderr io.Writer) (*runtime, error) {
	// The engine requires a stable owner goroutine; the runtime is closed on
	// the same goroutine at the end of the invocation.
	goruntime.LockOSThread()
	vm := quickjs.NewRuntime(
		quickjs.WithMemoryLimit(pluginMemoryLimit),
		quickjs.WithMaxStackSize(pluginMaxStack),
	)
	if ctx != nil {
		vm.SetInterruptHandler(func() int {
			select {
			case <-ctx.Done():
				return 1
			default:
				return 0
			}
		})
	}
	js := vm.NewContext()
	rt := &runtime{
		ctx:    ctx,
		vm:     vm,
		js:     js,
		stderr: stderr,
		files:  newFileTable(),
	}
	host := rt.obj()
	if err := rt.eval(bootstrapSource, "decx-bootstrap.js"); err != nil {
		rt.close()
		return nil, fmt.Errorf("cannot initialize the embedded plugin runtime: %w", err)
	}
	rt.set(host, "stderrWrite", rt.fn(func(_ *quickjs.Context, _ *quickjs.Value, args []*quickjs.Value) *quickjs.Value {
		if stderr != nil {
			_, _ = io.WriteString(stderr, argAt(args, 0).ToString())
		}
		return rt.undef()
	}))
	rt.set(host, "stdoutWrite", rt.fn(func(_ *quickjs.Context, _ *quickjs.Value, _ []*quickjs.Value) *quickjs.Value {
		return rt.undef()
	}))
	globals := js.Globals()
	rt.set(globals, "__decxHost", host)
	rt.set(globals, "__decxEnvJson", rt.str(jsonString(environMap())))
	rt.set(globals, "__decxArgvJson", rt.str(jsonString([]string{"decx"})))
	rt.set(globals, "__decxPlatform", rt.str(nodePlatform()))
	rt.set(globals, "__decxArch", rt.str(nodeArch()))
	if cwd, err := os.Getwd(); err == nil {
		rt.set(globals, "__decxCwd", rt.str(cwd))
	}
	if err := rt.eval(preludeSource, "decx-prelude.js"); err != nil {
		rt.close()
		return nil, fmt.Errorf("cannot initialize the embedded plugin runtime: %w", err)
	}
	if err := rt.eval(bridgeSource, "decx-bridge.js"); err != nil {
		rt.close()
		return nil, fmt.Errorf("cannot initialize the embedded plugin runtime: %w", err)
	}
	// The compiled plugin is one self-contained file; it reaches the host
	// through this global instead of a CommonJS require().
	modules := rt.obj()
	rt.set(modules, "fs", rt.fsModule())
	rt.set(modules, "path", rt.pathModule())
	rt.set(modules, "os", rt.osModule())
	rt.set(modules, "child_process", rt.childProcessModule())
	rt.set(modules, "crypto", rt.cryptoModule())
	rt.set(modules, "protocol", rt.i64(int64(Protocol)))
	rt.set(modules, "pluginDir", rt.str(def.Dir))
	rt.set(globals, "decx", modules)
	return rt, nil
}

// close releases the engine. Values are freed in reverse creation order
// before the context goes away (see the arena comment on runtime).
func (rt *runtime) close() {
	for index := len(rt.arena) - 1; index >= 0; index-- {
		rt.arena[index].Free()
	}
	rt.arena = nil
	if rt.files != nil {
		rt.files.closeAll()
	}
	if rt.js != nil {
		rt.js.Close()
		rt.js = nil
	}
	if rt.vm != nil {
		rt.vm.Close()
		rt.vm = nil
	}
	goruntime.UnlockOSThread()
}

func jsonString(value any) string {
	data, err := json.Marshal(value)
	if err != nil {
		return "null"
	}
	return string(data)
}

func environMap() map[string]string {
	env := map[string]string{}
	for _, entry := range os.Environ() {
		if index := strings.IndexByte(entry, '='); index > 0 {
			env[entry[:index]] = entry[index+1:]
		}
	}
	return env
}

// ── Engine helpers ────────────────────────────────────────────────────────

// eval runs JavaScript source in the global scope.
func (rt *runtime) eval(source, filename string) error {
	result := rt.evalValue(source, filename)
	if result == nil {
		return errors.New("the engine did not return a value")
	}
	if result.IsException() || rt.js.HasException() {
		return rt.engineError()
	}
	return nil
}

// engineError drains the pending engine exception.
func (rt *runtime) engineError() error {
	if err := rt.js.Exception(); err != nil {
		return err
	}
	return errors.New("javascript exception")
}

// hostFunc is the shape of every Go function exposed to plugin code.
type hostFunc = func(ctx *quickjs.Context, this *quickjs.Value, args []*quickjs.Value) *quickjs.Value

// fn registers a Go callback as a JavaScript function. Host errors are raised
// by panicking (see hostError, *quickjs.Value, error); the wrapper converts
// them into engine exceptions and keeps a host bug from killing the process.
func (rt *runtime) fn(callback hostFunc) *quickjs.Value {
	return rt.keep(rt.js.NewFunction(func(c *quickjs.Context, this *quickjs.Value, args []*quickjs.Value) (out *quickjs.Value) {
		defer func() {
			if recovered := recover(); recovered != nil {
				out = rt.hostPanic(recovered)
			}
		}()
		return rt.handOver(callback(c, this, args))
	}))
}

// hostPanic turns a recovered host panic into a JavaScript exception.
func (rt *runtime) hostPanic(recovered any) *quickjs.Value {
	switch value := recovered.(type) {
	case *hostError:
		return rt.throwError(value.name, value.code, value.message)
	case *quickjs.Value:
		return rt.js.Throw(rt.handOver(value))
	case error:
		return rt.throwError("Error", "PLUGIN_ERROR", value.Error())
	default:
		return rt.throwError("Error", "PLUGIN_ERROR", fmt.Sprint(recovered))
	}
}

// hostError is a host-side failure raised with panic() and delivered to plugin
// code as an Error value.
type hostError struct {
	name    string
	code    string
	message string
}

func (e *hostError) Error() string { return e.message }

// typeError mirrors the TypeError the Node host raises for bad arguments.
func (rt *runtime) typeError(format string, args ...any) *hostError {
	return &hostError{name: "TypeError", code: "PLUGIN_ERROR", message: fmt.Sprintf(format, args...)}
}

// errorObject builds the Error value thrown into plugin code.
func (rt *runtime) errorObject(code, message string) *quickjs.Value {
	return rt.namedError("Error", code, message)
}

func (rt *runtime) namedError(name, code, message string) *quickjs.Value {
	err := rt.obj()
	rt.set(err, "name", rt.str(name))
	rt.set(err, "message", rt.str(message))
	rt.set(err, "code", rt.str(code))
	return err
}

// throwError raises a JS error carrying the DECX code. The thrown object is a
// copy: JS_Throw consumes its reference, while the arena keeps the original.
func (rt *runtime) throwError(name, code, message string) *quickjs.Value {
	return rt.js.Throw(rt.handOver(rt.namedError(name, code, message)))
}

// fsError builds the Error plugins see for filesystem failures.
func (rt *runtime) fsError(op, target string, err error) *quickjs.Value {
	code := errorCode(err)
	symbol := errorSymbols[code]
	if symbol == "" {
		symbol = "i/o error"
	}
	message := fmt.Sprintf("%s: %s, %s '%s'", code, symbol, op, target)
	obj := rt.errorObject(code, message)
	rt.set(obj, "syscall", rt.str(op))
	rt.set(obj, "path", rt.str(target))
	rt.set(obj, "errno", rt.num(-1))
	return obj
}

// ── Value helpers ─────────────────────────────────────────────────────────

func (rt *runtime) str(value string) *quickjs.Value  { return rt.keep(rt.js.NewString(value)) }
func (rt *runtime) num(value float64) *quickjs.Value { return rt.keep(rt.js.NewFloat64(value)) }
func (rt *runtime) i64(value int64) *quickjs.Value   { return rt.keep(rt.js.NewInt64(value)) }
func (rt *runtime) boolean(value bool) *quickjs.Value {
	return rt.keep(rt.js.NewBool(value))
}
func (rt *runtime) undef() *quickjs.Value { return rt.keep(rt.js.NewUndefined()) }
func (rt *runtime) null() *quickjs.Value  { return rt.keep(rt.js.NewNull()) }
func (rt *runtime) obj() *quickjs.Value   { return rt.keep(rt.js.NewObject()) }

// bytesValue wraps a Go byte slice in a fresh Uint8Array view copy.
func (rt *runtime) bytesValue(data []byte) *quickjs.Value {
	return rt.keep(rt.js.NewUint8Array(data))
}

// get reads an object property; the result is owned by the host.
func (rt *runtime) get(obj *quickjs.Value, name string) *quickjs.Value {
	if obj == nil {
		return nil
	}
	return rt.keep(obj.Get(name))
}

// call invokes a JavaScript function; the result is owned by the host.
func (rt *runtime) call(fn *quickjs.Value, this *quickjs.Value, args ...*quickjs.Value) *quickjs.Value {
	if fn == nil {
		return nil
	}
	return rt.keep(fn.Execute(this, args...))
}

// evalValue runs source and keeps its completion value.
func (rt *runtime) evalValue(source, filename string) *quickjs.Value {
	return rt.keep(rt.js.Eval(source, quickjs.EvalFileName(filename)))
}

// arr marshals a Go slice into a JavaScript array.
func (rt *runtime) arr(value any) *quickjs.Value {
	result, err := rt.marshal(value)
	if err != nil {
		panic(rt.typeError("cannot build a JavaScript array: %s", err.Error()))
	}
	return result
}

// array returns a fresh JavaScript array owned by the host.
func (rt *runtime) array() *quickjs.Value {
	constructor := rt.get(rt.js.Globals(), "Array")
	if constructor == nil || !constructor.IsFunction() {
		panic(rt.typeError("Array is unavailable"))
	}
	return rt.keep(constructor.New())
}

// date wraps a millisecond timestamp in a JavaScript Date.
func (rt *runtime) date(epochMS float64) *quickjs.Value {
	return rt.keep(rt.js.NewDate(epochMS))
}

// marshal converts a Go value into engine data owned by the host.
func (rt *runtime) marshal(value any) (*quickjs.Value, error) {
	result, err := rt.js.Marshal(value)
	if err != nil {
		return nil, err
	}
	return rt.keep(result), nil
}

// handOver returns a fresh reference the engine may consume. The binding
// consumes the raw reference passed to Value.Set/Value.SetIdx and to the
// return value of a host callback, so a value the host still owns must be
// copied through JavaScript first. The copy is never tracked: its ownership
// moves to the engine with the call.
func (rt *runtime) handOver(value *quickjs.Value) *quickjs.Value {
	if value == nil {
		return nil
	}
	identity := rt.identity()
	if identity == nil || !identity.IsFunction() {
		panic(rt.typeError("the embedded runtime is not initialized"))
	}
	return identity.Execute(rt.undef(), value)
}

// identity returns the JavaScript identity helper (see handOver).
func (rt *runtime) identity() *quickjs.Value {
	if rt.identityFn == nil {
		rt.identityFn = rt.get(rt.js.Globals(), "__decxIdentity")
	}
	return rt.identityFn
}

// set assigns a property; the engine consumes the value.
func (rt *runtime) set(obj *quickjs.Value, name string, value *quickjs.Value) {
	obj.Set(name, rt.handOver(value))
}

// setIdx assigns an indexed property; the engine consumes the value.
func (rt *runtime) setIdx(obj *quickjs.Value, index int64, value *quickjs.Value) {
	obj.SetIdx(index, rt.handOver(value))
}

// argAt returns the n-th argument of a host callback, or nil when absent.
func argAt(args []*quickjs.Value, index int) *quickjs.Value {
	if index < 0 || index >= len(args) {
		return nil
	}
	return args[index]
}

func isUndefined(value *quickjs.Value) bool {
	return value == nil || value.IsUndefined() || value.IsNull()
}

func (rt *runtime) stringArg(args []*quickjs.Value, index int, name string) string {
	value := argAt(args, index)
	if isUndefined(value) {
		panic(rt.typeError("The \"%s\" argument must be of type string. Received undefined", name))
	}
	return value.ToString()
}

func (rt *runtime) optionalString(args []*quickjs.Value, index int) (string, bool) {
	value := argAt(args, index)
	if isUndefined(value) {
		return "", false
	}
	return value.ToString(), true
}

func (rt *runtime) intArg(args []*quickjs.Value, index int) int {
	value := argAt(args, index)
	if isUndefined(value) {
		return 0
	}
	return int(value.ToInt32())
}

// byteLength returns how many bytes a buffer argument can hold: the byteLength
// of a typed array or DataView, or 0 for anything else.
func (rt *runtime) byteLength(value *quickjs.Value) int {
	if value == nil || isUndefined(value) || value.IsNull() {
		return 0
	}
	length := rt.get(value, "byteLength")
	if length == nil || isUndefined(length) {
		return 0
	}
	return int(length.ToInt32())
}

// bytesOf converts a JS string or typed array into raw bytes.
func (rt *runtime) bytesOf(value *quickjs.Value) []byte {
	if isUndefined(value) {
		return nil
	}
	if value.IsString() {
		return []byte(value.ToString())
	}
	if value.IsTypedArray() || value.IsDataView() {
		if data, err := value.ToUint8Array(); err == nil {
			return data
		}
	}
	if value.IsByteArray() {
		length := int(value.ByteLen())
		if data, err := value.ToByteArray(uint(length)); err == nil {
			return data
		}
	}
	panic(rt.typeError("value must be a string or Buffer"))
}

// readEncodingOption understands both the string form ("utf-8") and the object
// form ({encoding: "utf-8"}) of Node's options arguments.
func (rt *runtime) readEncodingOption(value *quickjs.Value, def string) string {
	if isUndefined(value) {
		return def
	}
	if value.IsString() {
		return value.ToString()
	}
	if !value.IsObject() {
		return def
	}
	if encoding := rt.get(value, "encoding"); !isUndefined(encoding) {
		return encoding.ToString()
	}
	return def
}

// bufferValue creates a Buffer the plugin can use like any Node Buffer.
func (rt *runtime) bufferValue(data []byte) *quickjs.Value {
	constructor := rt.get(rt.js.Globals(), "Buffer")
	if isUndefined(constructor) {
		panic(rt.typeError("Buffer is unavailable"))
	}
	from := rt.get(constructor, "from")
	if from == nil || !from.IsFunction() {
		panic(rt.typeError("Buffer.from is unavailable"))
	}
	value := rt.call(from, rt.undef(), rt.bytesValue(data))
	if value == nil || value.IsException() || rt.js.HasException() {
		_ = rt.engineError()
		panic(rt.typeError("cannot build a Buffer"))
	}
	return value
}

// dataResult returns a string when an encoding was requested, a Buffer otherwise.
func (rt *runtime) dataResult(data []byte, encoding string) *quickjs.Value {
	if encoding == "" {
		return rt.bufferValue(data)
	}
	switch strings.ToLower(encoding) {
	case "utf8", "utf-8":
		return rt.str(string(data))
	case "latin1", "binary", "ascii":
		runes := make([]rune, len(data))
		for i, b := range data {
			runes[i] = rune(b)
		}
		return rt.str(string(runes))
	case "hex":
		sb := strings.Builder{}
		for _, b := range data {
			sb.WriteString(fmt.Sprintf("%02x", b))
		}
		return rt.str(sb.String())
	default:
		return rt.str(string(data))
	}
}

// copyIntoBuffer writes bytes into a JS typed array, honouring its view offset.
func (rt *runtime) copyIntoBuffer(buffer *quickjs.Value, offset int, data []byte) {
	if isUndefined(buffer) {
		panic(rt.typeError("the buffer argument must be a Buffer"))
	}
	write := rt.get(rt.js.Globals(), "__decxWriteBytes")
	if write == nil || !write.IsFunction() {
		panic(rt.typeError("the buffer argument must be a Buffer"))
	}
	written := rt.call(write, rt.undef(), buffer, rt.num(float64(offset)), rt.bytesValue(data))
	if written == nil || written.IsException() || rt.js.HasException() {
		_ = rt.engineError()
		panic(rt.typeError("the buffer argument must be a Buffer"))
	}
}

// copyAt writes into a Go byte slice, dropping anything outside its bounds.
func copyAt(target []byte, offset int, data []byte) {
	for i, b := range data {
		index := offset + i
		if index >= 0 && index < len(target) {
			target[index] = b
		}
	}
}

// ── Plugin invocation ─────────────────────────────────────────────────────

// maxPluginBundleBytes bounds the compiled plugin bundle the CLI evaluates, so
// a truncated, huge or hostile entry file cannot exhaust memory.
const maxPluginBundleBytes = 16 << 20

// invoke evaluates the compiled plugin file and calls its global handle().
func (rt *runtime) invoke(entry string, request Request) (*Response, error) {
	name := filepath.Base(entry)
	info, err := os.Stat(entry)
	if err != nil {
		return nil, &ResponseError{Code: errorCode(err), Message: fmt.Sprintf("cannot read plugin %s: %v", name, err)}
	}
	if info.Size() > maxPluginBundleBytes {
		return nil, &ResponseError{Code: "PLUGIN_ERROR", Message: fmt.Sprintf("plugin %s is %d bytes, over the %d byte limit", name, info.Size(), maxPluginBundleBytes)}
	}
	source, err := os.ReadFile(entry)
	if err != nil {
		return nil, &ResponseError{Code: errorCode(err), Message: fmt.Sprintf("cannot read plugin %s: %v", name, err)}
	}
	if err := rt.eval(string(source), name); err != nil {
		return nil, err
	}
	handle := rt.get(rt.js.Globals(), "handle")
	if handle == nil || !handle.IsFunction() {
		return nil, &ResponseError{
			Code:    "PLUGIN_ERROR",
			Message: fmt.Sprintf("plugin %s does not define a global handle() function", name),
		}
	}
	payload, err := rt.marshal(request)
	if err != nil {
		return nil, &ResponseError{Code: "PLUGIN_ERROR", Message: fmt.Sprintf("cannot marshal the plugin request: %v", err)}
	}
	result, err := rt.unwrapResult(rt.callJS(handle, rt.undef(), payload))
	if err != nil {
		return nil, err
	}
	if isUndefined(result) {
		return nil, &ResponseError{Code: "PLUGIN_ERROR", Message: "plugin handle() returned no response"}
	}
	text, err := rt.stringify(result)
	if err != nil {
		return nil, err
	}
	var response Response
	if err := json.Unmarshal([]byte(text), &response); err != nil {
		return nil, &ResponseError{
			Code:    "PLUGIN_ERROR",
			Message: fmt.Sprintf("plugin returned an invalid response: %v", err),
		}
	}
	if !response.OK && response.Error == nil {
		return nil, &ResponseError{Code: "PLUGIN_ERROR", Message: "plugin returned a failure without an error"}
	}
	return &response, nil
}

// ── Call bridge ───────────────────────────────────────────────────────────

// callJS runs a JavaScript function through __decxInvoke so a thrown value
// never reaches the Go binding as a pending exception.
func (rt *runtime) callJS(fn *quickjs.Value, this *quickjs.Value, args ...*quickjs.Value) *quickjs.Value {
	invoke := rt.get(rt.js.Globals(), "__decxInvoke")
	if invoke == nil || !invoke.IsFunction() {
		return nil
	}
	callArgs := append([]*quickjs.Value{fn, this}, args...)
	return rt.call(invoke, rt.undef(), callArgs...)
}

// unwrapResult reads the {ok, value|error} object produced by __decxInvoke.
func (rt *runtime) unwrapResult(result *quickjs.Value) (*quickjs.Value, error) {
	if result == nil || isUndefined(result) {
		return nil, &ResponseError{Code: "PLUGIN_ERROR", Message: "the plugin call returned no result"}
	}
	if result.IsException() || rt.js.HasException() {
		return nil, &ResponseError{Code: "PLUGIN_ERROR", Message: rt.engineError().Error()}
	}
	if ok := rt.get(result, "ok"); !isUndefined(ok) && ok.Bool() {
		return rt.get(result, "value"), nil
	}
	return nil, rt.describedError(rt.get(result, "error"))
}

// pendingException describes the current engine exception as a plugin error.
func (rt *runtime) pendingException() *quickjs.Value {
	describe := rt.get(rt.js.Globals(), "__decxDescribeError")
	if describe == nil || !describe.IsFunction() {
		return nil
	}
	return rt.call(describe, rt.undef())
}

// describedError converts a described exception into the CLI's structured error.
func (rt *runtime) describedError(value *quickjs.Value) error {
	failure := &ResponseError{Code: "PLUGIN_ERROR", Message: "plugin failed"}
	if isUndefined(value) || value == nil {
		return failure
	}
	if code := rt.get(value, "code"); !isUndefined(code) {
		if text := strings.TrimSpace(code.ToString()); text != "" {
			failure.Code = text
		}
	}
	if message := rt.get(value, "message"); !isUndefined(message) {
		failure.Message = message.ToString()
	}
	if stack := rt.get(value, "stack"); !isUndefined(stack) && failure.Code == "PLUGIN_ERROR" {
		if text := stack.ToString(); text != "" && !strings.Contains(failure.Message, text) {
			failure.Message = failure.Message + "\n" + text
		}
	}
	if details := rt.get(value, "details"); !isUndefined(details) {
		if text := details.ToString(); text != "" && text != "null" {
			failure.Details = json.RawMessage(text)
		}
	}
	return failure
}

// stringify runs JSON.stringify inside the engine so plugin values keep their
// own semantics (BigInt, toJSON, cycles are reported as engine errors).
func (rt *runtime) stringify(value *quickjs.Value) (string, error) {
	stringify := rt.get(rt.js.Globals(), "__decxStringify")
	if stringify == nil || !stringify.IsFunction() {
		return "", errors.New("JSON.stringify is unavailable")
	}
	out := rt.call(stringify, rt.undef(), value)
	if out == nil || isUndefined(out) || out.IsException() || rt.js.HasException() {
		return "", &ResponseError{Code: "PLUGIN_ERROR", Message: rt.engineError().Error()}
	}
	ok := rt.get(out, "ok")
	if isUndefined(ok) || !ok.Bool() {
		return "", rt.describedError(rt.get(out, "error"))
	}
	text := rt.get(out, "value")
	if isUndefined(text) {
		return "", nil
	}
	return text.ToString(), nil
}
