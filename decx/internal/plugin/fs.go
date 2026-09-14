package plugin

import (
	"errors"
	"fmt"
	"io"
	"io/fs"
	"os"
	"path/filepath"
	goruntime "runtime"
	"strings"
	"sync"
	"time"

	"github.com/buke/quickjs-go"
)

// fileTable maps the numeric file descriptors plugins pass around to real
// files. Standard streams keep their conventional numbers.
type fileTable struct {
	mu    sync.Mutex
	next  int
	files map[int]*os.File
}

func newFileTable() *fileTable {
	return &fileTable{next: 3, files: map[int]*os.File{0: os.Stdin, 1: os.Stdout, 2: os.Stderr}}
}

func (t *fileTable) add(file *os.File) int {
	t.mu.Lock()
	defer t.mu.Unlock()
	fd := t.next
	t.next++
	t.files[fd] = file
	return fd
}

func (t *fileTable) get(fd int) (*os.File, error) {
	t.mu.Lock()
	defer t.mu.Unlock()
	file, ok := t.files[fd]
	if !ok {
		return nil, fmt.Errorf("EBADF: bad file descriptor, fd %d", fd)
	}
	return file, nil
}

func (t *fileTable) close(fd int) error {
	if fd < 3 {
		return nil
	}
	t.mu.Lock()
	file, ok := t.files[fd]
	delete(t.files, fd)
	t.mu.Unlock()
	if !ok {
		return fmt.Errorf("EBADF: bad file descriptor, fd %d", fd)
	}
	return file.Close()
}

func (t *fileTable) closeAll() {
	t.mu.Lock()
	defer t.mu.Unlock()
	for fd, file := range t.files {
		if fd >= 3 {
			_ = file.Close()
		}
	}
}

// ── Error helpers ─────────────────────────────────────────────────────────

var errorSymbols = map[string]string{
	"ENOENT":           "no such file or directory",
	"EEXIST":           "file already exists",
	"EACCES":           "permission denied",
	"EPERM":            "operation not permitted",
	"EISDIR":           "illegal operation on a directory",
	"ENOTDIR":          "not a directory",
	"ENOTEMPTY":        "directory not empty",
	"EINVAL":           "invalid argument",
	"EMFILE":           "too many open files",
	"ENOSPC":           "no space left on device",
	"EXDEV":            "cross-device link not permitted",
	"EBADF":            "bad file descriptor",
	"ENOBUFS":          "no buffer space available",
	"ETIMEDOUT":        "connection timed out",
	"MODULE_NOT_FOUND": "cannot find module",
	"PLUGIN_EXIT":      "plugin exited",
}

// errorCode maps a Go error to the Node-style code plugins expect.
func errorCode(err error) string {
	switch {
	case err == nil:
		return ""
	case errors.Is(err, fs.ErrNotExist):
		return "ENOENT"
	case errors.Is(err, fs.ErrExist):
		return "EEXIST"
	case errors.Is(err, fs.ErrPermission):
		return "EACCES"
	}
	text := strings.ToLower(err.Error())
	for _, probe := range []struct {
		code string
		text string
	}{
		{"EISDIR", "is a directory"},
		{"ENOTDIR", "not a directory"},
		{"ENOTEMPTY", "directory not empty"},
		{"EINVAL", "invalid argument"},
		{"EMFILE", "too many open files"},
		{"ENOSPC", "no space left"},
		{"EXDEV", "cross-device"},
		{"ENOENT", "no such file or directory"},
		{"EEXIST", "file exists"},
		{"EACCES", "permission denied"},
		{"EPERM", "operation not permitted"},
		{"EROFS", "read-only file system"},
		{"ENAMETOOLONG", "file name too long"},
		{"ENOTSUP", "not supported"},
		{"EINVAL", "pattern contains path separator"},
	} {
		if strings.Contains(text, probe.text) {
			return probe.code
		}
	}
	return "EIO"
}

// ── fs ────────────────────────────────────────────────────────────────────

func (rt *runtime) fsModule() *quickjs.Value {
	module := rt.obj()

	rt.set(module, "constants", rt.fsConstants())

	rt.set(module, "readFileSync", rt.fn(func(_ *quickjs.Context, _ *quickjs.Value, args []*quickjs.Value) *quickjs.Value {
		encoding := rt.readEncodingOption(argAt(args, 1), "")
		if fd, err := rt.fdArgument(argAt(args, 0)); err == nil {
			file, err := rt.files.get(fd)
			if err != nil {
				panic(rt.fsError("read", fmt.Sprintf("fd %d", fd), err))
			}
			data, err := io.ReadAll(file)
			if err != nil {
				panic(rt.fsError("read", fmt.Sprintf("fd %d", fd), err))
			}
			return rt.dataResult(data, encoding)
		}
		path := rt.resolvePath(rt.stringArg(args, 0, "path"))
		data, err := os.ReadFile(path)
		if err != nil {
			panic(rt.fsError("open", path, err))
		}
		return rt.dataResult(data, encoding)
	}))

	rt.set(module, "writeFileSync", rt.fn(func(_ *quickjs.Context, _ *quickjs.Value, args []*quickjs.Value) *quickjs.Value {
		data := rt.bytesOf(argAt(args, 1))
		if fd, err := rt.fdArgument(argAt(args, 0)); err == nil {
			file, err := rt.files.get(fd)
			if err != nil {
				panic(rt.fsError("write", fmt.Sprintf("fd %d", fd), err))
			}
			if _, err := file.Write(data); err != nil {
				panic(rt.fsError("write", fmt.Sprintf("fd %d", fd), err))
			}
			return rt.undef()
		}
		path := rt.resolvePath(rt.stringArg(args, 0, "path"))
		if err := os.WriteFile(path, data, 0o644); err != nil {
			panic(rt.fsError("open", path, err))
		}
		return rt.undef()
	}))

	rt.set(module, "openSync", rt.fn(func(_ *quickjs.Context, _ *quickjs.Value, args []*quickjs.Value) *quickjs.Value {
		path := rt.resolvePath(rt.stringArg(args, 0, "path"))
		flags := "r"
		if value := argAt(args, 1); !isUndefined(value) {
			flags = value.ToString()
		}
		file, err := os.OpenFile(path, openFlags(flags), 0o644)
		if err != nil {
			panic(rt.fsError("open", path, err))
		}
		return rt.num(float64(rt.files.add(file)))
	}))

	rt.set(module, "closeSync", rt.fn(func(_ *quickjs.Context, _ *quickjs.Value, args []*quickjs.Value) *quickjs.Value {
		fd := rt.intArg(args, 0)
		if err := rt.files.close(fd); err != nil {
			panic(rt.fsError("close", fmt.Sprintf("fd %d", fd), err))
		}
		return rt.undef()
	}))

	rt.set(module, "readSync", rt.fn(func(_ *quickjs.Context, _ *quickjs.Value, args []*quickjs.Value) *quickjs.Value {
		fd := rt.intArg(args, 0)
		file, err := rt.files.get(fd)
		if err != nil {
			panic(rt.fsError("read", fmt.Sprintf("fd %d", fd), err))
		}
		buffer := argAt(args, 1)
		offset := rt.intArg(args, 2)
		length := rt.intArg(args, 3)
		if offset < 0 {
			offset = 0
		}
		capacity := rt.byteLength(buffer)
		if offset > capacity {
			offset = capacity
		}
		if length < 0 {
			panic(rt.typeError("length must not be negative"))
		}
		if available := capacity - offset; length > available {
			// The destination is the limit, so a plugin-supplied length can
			// never allocate more than the buffer can hold.
			length = available
		}
		chunk := make([]byte, length)
		position := argAt(args, 4)
		var read int
		if isUndefined(position) {
			read, err = file.Read(chunk)
		} else {
			read, err = file.ReadAt(chunk, position.ToInt64())
		}
		if err != nil && !errors.Is(err, io.EOF) {
			panic(rt.fsError("read", fmt.Sprintf("fd %d", fd), err))
		}
		rt.copyIntoBuffer(buffer, offset, chunk[:read])
		return rt.num(float64(read))
	}))

	rt.set(module, "writeSync", rt.fn(func(_ *quickjs.Context, _ *quickjs.Value, args []*quickjs.Value) *quickjs.Value {
		fd := rt.intArg(args, 0)
		file, err := rt.files.get(fd)
		if err != nil {
			panic(rt.fsError("write", fmt.Sprintf("fd %d", fd), err))
		}
		data := rt.bytesOf(argAt(args, 1))
		offset := rt.intArg(args, 2)
		length := rt.intArg(args, 3)
		if offset < 0 {
			offset = 0
		}
		if offset > len(data) {
			offset = len(data)
		}
		if length < 0 {
			panic(rt.typeError("length must not be negative"))
		}
		if available := len(data) - offset; length > available {
			// Node clamps a slice that runs past the buffer instead of failing.
			length = available
		}
		chunk := data[offset : offset+length]
		position := argAt(args, 4)
		var written int
		if isUndefined(position) {
			written, err = file.Write(chunk)
		} else {
			written, err = file.WriteAt(chunk, position.ToInt64())
		}
		if err != nil {
			panic(rt.fsError("write", fmt.Sprintf("fd %d", fd), err))
		}
		return rt.num(float64(written))
	}))

	rt.set(module, "readdirSync", rt.fn(func(_ *quickjs.Context, _ *quickjs.Value, args []*quickjs.Value) *quickjs.Value {
		path := rt.resolvePath(rt.stringArg(args, 0, "path"))
		entries, err := os.ReadDir(path)
		if err != nil {
			panic(rt.fsError("scandir", path, err))
		}
		withTypes := false
		if options := argAt(args, 1); !isUndefined(options) && !options.IsString() {
			if flag := rt.get(options, "withFileTypes"); !isUndefined(flag) {
				withTypes = flag.Bool()
			}
		}
		result := rt.array()
		for index, entry := range entries {
			if !withTypes {
				rt.setIdx(result, int64(index), rt.str(entry.Name()))
				continue
			}
			info, err := entry.Info()
			if err != nil {
				panic(rt.fsError("stat", filepath.Join(path, entry.Name()), err))
			}
			rt.setIdx(result, int64(index), rt.direntObject(entry.Name(), info))
		}
		return result
	}))

	stat := func(follow bool) hostFunc {
		return func(_ *quickjs.Context, _ *quickjs.Value, args []*quickjs.Value) *quickjs.Value {
			path := rt.resolvePath(rt.stringArg(args, 0, "path"))
			var (
				info os.FileInfo
				err  error
			)
			if follow {
				info, err = os.Stat(path)
			} else {
				info, err = os.Lstat(path)
			}
			if err != nil {
				panic(rt.fsError("stat", path, err))
			}
			return rt.statsObject(info)
		}
	}
	rt.set(module, "statSync", rt.fn(stat(true)))
	rt.set(module, "lstatSync", rt.fn(stat(false)))

	rt.set(module, "existsSync", rt.fn(func(_ *quickjs.Context, _ *quickjs.Value, args []*quickjs.Value) *quickjs.Value {
		path := rt.resolvePath(rt.stringArg(args, 0, "path"))
		_, err := os.Stat(path)
		return rt.boolean(err == nil)
	}))

	rt.set(module, "accessSync", rt.fn(func(_ *quickjs.Context, _ *quickjs.Value, args []*quickjs.Value) *quickjs.Value {
		path := rt.resolvePath(rt.stringArg(args, 0, "path"))
		mode := rt.intArg(args, 1)
		info, err := os.Stat(path)
		if err != nil {
			panic(rt.fsError("access", path, err))
		}
		if mode&2 != 0 && info.Mode().Perm()&0o222 == 0 {
			panic(rt.fsError("access", path, fs.ErrPermission))
		}
		if mode&1 != 0 && info.Mode().Perm()&0o111 == 0 {
			panic(rt.fsError("access", path, fs.ErrPermission))
		}
		return rt.undef()
	}))

	rt.set(module, "mkdirSync", rt.fn(func(_ *quickjs.Context, _ *quickjs.Value, args []*quickjs.Value) *quickjs.Value {
		path := rt.resolvePath(rt.stringArg(args, 0, "path"))
		recursive := false
		if options := argAt(args, 1); !isUndefined(options) {
			if options.IsNumber() {
				recursive = false
			} else if obj := options; obj != nil {
				if flag := rt.get(obj, "recursive"); !isUndefined(flag) {
					recursive = flag.Bool()
				}
			}
		}
		if recursive {
			if err := os.MkdirAll(path, 0o755); err != nil {
				panic(rt.fsError("mkdir", path, err))
			}
			return rt.undef()
		}
		if err := os.Mkdir(path, 0o755); err != nil {
			panic(rt.fsError("mkdir", path, err))
		}
		return rt.undef()
	}))

	rt.set(module, "mkdtempSync", rt.fn(func(_ *quickjs.Context, _ *quickjs.Value, args []*quickjs.Value) *quickjs.Value {
		prefix := rt.resolvePath(rt.stringArg(args, 0, "prefix"))
		dir, name := filepath.Dir(prefix), filepath.Base(prefix)
		if strings.HasSuffix(prefix, "/") || strings.HasSuffix(prefix, string(os.PathSeparator)) {
			dir, name = strings.TrimSuffix(prefix, string(os.PathSeparator)), "tmp"
		}
		if name == "." || name == ".." || name == "" {
			name = "tmp"
		}
		created, err := os.MkdirTemp(dir, name)
		if err != nil {
			panic(rt.fsError("mkdtemp", prefix, err))
		}
		return rt.str(created)
	}))

	rt.set(module, "rmSync", rt.fn(func(_ *quickjs.Context, _ *quickjs.Value, args []*quickjs.Value) *quickjs.Value {
		path := rt.resolvePath(rt.stringArg(args, 0, "path"))
		recursive, force := false, false
		if options := argAt(args, 1); !isUndefined(options) {
			if flag := rt.get(options, "recursive"); !isUndefined(flag) {
				recursive = flag.Bool()
			}
			if flag := rt.get(options, "force"); !isUndefined(flag) {
				force = flag.Bool()
			}
		}
		var err error
		if recursive {
			err = os.RemoveAll(path)
		} else {
			err = os.Remove(path)
		}
		if err != nil && !(force && errors.Is(err, fs.ErrNotExist)) {
			panic(rt.fsError("rm", path, err))
		}
		return rt.undef()
	}))

	rt.set(module, "unlinkSync", rt.fn(func(_ *quickjs.Context, _ *quickjs.Value, args []*quickjs.Value) *quickjs.Value {
		path := rt.resolvePath(rt.stringArg(args, 0, "path"))
		if err := os.Remove(path); err != nil {
			panic(rt.fsError("unlink", path, err))
		}
		return rt.undef()
	}))

	rt.set(module, "rmdirSync", rt.fn(func(_ *quickjs.Context, _ *quickjs.Value, args []*quickjs.Value) *quickjs.Value {
		path := rt.resolvePath(rt.stringArg(args, 0, "path"))
		recursive := false
		if options := argAt(args, 1); !isUndefined(options) && !options.IsString() {
			if flag := rt.get(options, "recursive"); !isUndefined(flag) {
				recursive = flag.Bool()
			}
		}
		var err error
		if recursive {
			err = os.RemoveAll(path)
		} else {
			err = os.Remove(path)
		}
		if err != nil {
			panic(rt.fsError("rmdir", path, err))
		}
		return rt.undef()
	}))

	rt.set(module, "copyFileSync", rt.fn(func(_ *quickjs.Context, _ *quickjs.Value, args []*quickjs.Value) *quickjs.Value {
		source := rt.resolvePath(rt.stringArg(args, 0, "src"))
		target := rt.resolvePath(rt.stringArg(args, 1, "dest"))
		data, err := os.ReadFile(source)
		if err != nil {
			panic(rt.fsError("copyfile", source, err))
		}
		if err := os.WriteFile(target, data, 0o644); err != nil {
			panic(rt.fsError("copyfile", target, err))
		}
		return rt.undef()
	}))

	rt.set(module, "renameSync", rt.fn(func(_ *quickjs.Context, _ *quickjs.Value, args []*quickjs.Value) *quickjs.Value {
		oldPath := rt.resolvePath(rt.stringArg(args, 0, "oldPath"))
		newPath := rt.resolvePath(rt.stringArg(args, 1, "newPath"))
		if err := os.Rename(oldPath, newPath); err != nil {
			panic(rt.fsError("rename", oldPath, err))
		}
		return rt.undef()
	}))

	return module
}

func (rt *runtime) fsConstants() *quickjs.Value {
	constants := rt.obj()
	rt.set(constants, "F_OK", rt.i64(0))
	rt.set(constants, "X_OK", rt.i64(1))
	rt.set(constants, "W_OK", rt.i64(2))
	rt.set(constants, "R_OK", rt.i64(4))
	rt.set(constants, "COPYFILE_EXCL", rt.i64(1))
	return constants
}

// fdArgument returns the numeric descriptor when the first argument is one.
func (rt *runtime) fdArgument(value *quickjs.Value) (int, error) {
	if isUndefined(value) {
		return 0, errors.New("missing")
	}
	if !value.IsNumber() {
		return 0, errors.New("not a descriptor")
	}
	return int(value.ToInt64()), nil
}

func openFlags(flags string) int {
	switch flags {
	case "r":
		return os.O_RDONLY
	case "r+":
		return os.O_RDWR
	case "w":
		return os.O_WRONLY | os.O_CREATE | os.O_TRUNC
	case "w+":
		return os.O_RDWR | os.O_CREATE | os.O_TRUNC
	case "wx":
		return os.O_WRONLY | os.O_CREATE | os.O_TRUNC | os.O_EXCL
	case "a":
		return os.O_WRONLY | os.O_CREATE | os.O_APPEND
	case "a+":
		return os.O_RDWR | os.O_CREATE | os.O_APPEND
	case "ax":
		return os.O_WRONLY | os.O_CREATE | os.O_APPEND | os.O_EXCL
	default:
		return os.O_RDONLY
	}
}

func (rt *runtime) statsObject(info os.FileInfo) *quickjs.Value {
	obj := rt.obj()
	rt.set(obj, "size", rt.num(float64(info.Size())))
	rt.set(obj, "mode", rt.i64(int64(info.Mode().Perm())))
	rt.set(obj, "mtimeMs", rt.num(float64(info.ModTime().UnixNano())/1e6))
	rt.set(obj, "atimeMs", rt.num(float64(info.ModTime().UnixNano())/1e6))
	rt.set(obj, "ctimeMs", rt.num(float64(info.ModTime().UnixNano())/1e6))
	rt.set(obj, "birthtimeMs", rt.num(float64(info.ModTime().UnixNano())/1e6))
	rt.set(obj, "mtime", rt.date(float64(info.ModTime().UnixNano())/1e6))
	rt.set(obj, "isFile", rt.fn(func(*quickjs.Context, *quickjs.Value, []*quickjs.Value) *quickjs.Value {
		return rt.boolean(info.Mode().IsRegular())
	}))
	rt.set(obj, "isDirectory", rt.fn(func(*quickjs.Context, *quickjs.Value, []*quickjs.Value) *quickjs.Value {
		return rt.boolean(info.IsDir())
	}))
	rt.set(obj, "isSymbolicLink", rt.fn(func(*quickjs.Context, *quickjs.Value, []*quickjs.Value) *quickjs.Value {
		return rt.boolean(info.Mode()&os.ModeSymlink != 0)
	}))
	rt.set(obj, "isBlockDevice", rt.fn(func(*quickjs.Context, *quickjs.Value, []*quickjs.Value) *quickjs.Value {
		return rt.boolean(info.Mode()&os.ModeDevice != 0)
	}))
	rt.set(obj, "isCharacterDevice", rt.fn(func(*quickjs.Context, *quickjs.Value, []*quickjs.Value) *quickjs.Value {
		return rt.boolean(info.Mode()&os.ModeCharDevice != 0)
	}))
	rt.set(obj, "isFIFO", rt.fn(func(*quickjs.Context, *quickjs.Value, []*quickjs.Value) *quickjs.Value {
		return rt.boolean(info.Mode()&os.ModeNamedPipe != 0)
	}))
	rt.set(obj, "isSocket", rt.fn(func(*quickjs.Context, *quickjs.Value, []*quickjs.Value) *quickjs.Value {
		return rt.boolean(info.Mode()&os.ModeSocket != 0)
	}))
	return obj
}

func (rt *runtime) direntObject(name string, info os.FileInfo) *quickjs.Value {
	obj := rt.obj()
	rt.set(obj, "name", rt.str(name))
	rt.set(obj, "isFile", rt.fn(func(*quickjs.Context, *quickjs.Value, []*quickjs.Value) *quickjs.Value {
		return rt.boolean(info.Mode().IsRegular())
	}))
	rt.set(obj, "isDirectory", rt.fn(func(*quickjs.Context, *quickjs.Value, []*quickjs.Value) *quickjs.Value {
		return rt.boolean(info.IsDir())
	}))
	rt.set(obj, "isSymbolicLink", rt.fn(func(*quickjs.Context, *quickjs.Value, []*quickjs.Value) *quickjs.Value {
		return rt.boolean(info.Mode()&os.ModeSymlink != 0)
	}))
	return obj
}

// ── path ──────────────────────────────────────────────────────────────────

func (rt *runtime) pathModule() *quickjs.Value {
	module := rt.obj()
	rt.set(module, "sep", rt.str(string(filepath.Separator)))
	rt.set(module, "delimiter", rt.str(string(filepath.ListSeparator)))

	rt.set(module, "join", rt.fn(func(_ *quickjs.Context, _ *quickjs.Value, args []*quickjs.Value) *quickjs.Value {
		parts := make([]string, 0, len(args))
		for _, arg := range args {
			if isUndefined(arg) || arg.ToString() == "" {
				continue
			}
			parts = append(parts, arg.ToString())
		}
		if len(parts) == 0 {
			return rt.str(".")
		}
		return rt.str(filepath.Join(parts...))
	}))

	rt.set(module, "resolve", rt.fn(func(_ *quickjs.Context, _ *quickjs.Value, args []*quickjs.Value) *quickjs.Value {
		segments := make([]string, 0, len(args))
		for _, arg := range args {
			if isUndefined(arg) {
				continue
			}
			segments = append(segments, arg.ToString())
		}
		result := ""
		for i := len(segments) - 1; i >= 0; i-- {
			if segments[i] == "" {
				continue
			}
			result = filepath.Join(segments[i], result)
			if filepath.IsAbs(segments[i]) {
				break
			}
		}
		if result == "" {
			result = "."
		}
		if !filepath.IsAbs(result) {
			if cwd, err := os.Getwd(); err == nil {
				result = filepath.Join(cwd, result)
			}
		}
		return rt.str(filepath.Clean(result))
	}))

	rt.set(module, "relative", rt.fn(func(_ *quickjs.Context, _ *quickjs.Value, args []*quickjs.Value) *quickjs.Value {
		from := rt.resolvePath(rt.stringArg(args, 0, "from"))
		to := rt.resolvePath(rt.stringArg(args, 1, "to"))
		rel, err := filepath.Rel(from, to)
		if err != nil {
			return rt.str("")
		}
		return rt.str(rel)
	}))

	rt.set(module, "normalize", rt.fn(func(_ *quickjs.Context, _ *quickjs.Value, args []*quickjs.Value) *quickjs.Value {
		return rt.str(filepath.Clean(rt.stringArg(args, 0, "path")))
	}))

	rt.set(module, "dirname", rt.fn(func(_ *quickjs.Context, _ *quickjs.Value, args []*quickjs.Value) *quickjs.Value {
		return rt.str(filepath.Dir(rt.stringArg(args, 0, "path")))
	}))

	rt.set(module, "basename", rt.fn(func(_ *quickjs.Context, _ *quickjs.Value, args []*quickjs.Value) *quickjs.Value {
		base := filepath.Base(rt.stringArg(args, 0, "path"))
		if suffix, ok := rt.optionalString(args, 1); ok && suffix != "" && strings.HasSuffix(base, suffix) && len(base) > len(suffix) {
			base = base[:len(base)-len(suffix)]
		}
		return rt.str(base)
	}))

	rt.set(module, "extname", rt.fn(func(_ *quickjs.Context, _ *quickjs.Value, args []*quickjs.Value) *quickjs.Value {
		return rt.str(filepath.Ext(rt.stringArg(args, 0, "path")))
	}))

	rt.set(module, "isAbsolute", rt.fn(func(_ *quickjs.Context, _ *quickjs.Value, args []*quickjs.Value) *quickjs.Value {
		return rt.boolean(filepath.IsAbs(rt.stringArg(args, 0, "path")))
	}))

	rt.set(module, "parse", rt.fn(func(_ *quickjs.Context, _ *quickjs.Value, args []*quickjs.Value) *quickjs.Value {
		path := rt.stringArg(args, 0, "path")
		obj := rt.obj()
		rt.set(obj, "root", rt.str(filepath.VolumeName(path)+string(filepath.Separator)))
		rt.set(obj, "dir", rt.str(filepath.Dir(path)))
		rt.set(obj, "base", rt.str(filepath.Base(path)))
		extension := filepath.Ext(path)
		rt.set(obj, "ext", rt.str(extension))
		rt.set(obj, "name", rt.str(strings.TrimSuffix(filepath.Base(path), extension)))
		return obj
	}))

	rt.set(module, "format", rt.fn(func(_ *quickjs.Context, _ *quickjs.Value, args []*quickjs.Value) *quickjs.Value {
		value := argAt(args, 0)
		if isUndefined(value) {
			panic(rt.typeError("The \"pathObject\" argument must be of type object"))
		}
		obj := value
		if dir := rt.get(obj, "dir"); !isUndefined(dir) && dir.ToString() != "" {
			return rt.str(filepath.Join(dir.ToString(), rt.get(obj, "base").ToString()))
		}
		root := ""
		if value := rt.get(obj, "root"); !isUndefined(value) {
			root = value.ToString()
		}
		name := ""
		if value := rt.get(obj, "name"); !isUndefined(value) {
			name = value.ToString()
		}
		ext := ""
		if value := rt.get(obj, "ext"); !isUndefined(value) {
			ext = value.ToString()
		}
		base := ""
		if value := rt.get(obj, "base"); !isUndefined(value) {
			base = value.ToString()
		}
		if base == "" {
			base = name + ext
		}
		return rt.str(root + base)
	}))

	return module
}

// resolvePath turns plugin-provided paths into absolute ones relative to the
// CLI working directory, mirroring Node's behaviour.
func (rt *runtime) resolvePath(path string) string {
	if path == "" || filepath.IsAbs(path) {
		return path
	}
	if strings.HasPrefix(path, "~"+string(filepath.Separator)) {
		if home, err := os.UserHomeDir(); err == nil {
			return filepath.Join(home, path[2:])
		}
	}
	cwd, err := os.Getwd()
	if err != nil {
		return path
	}
	return filepath.Join(cwd, path)
}

// ── os ────────────────────────────────────────────────────────────────────

func (rt *runtime) osModule() *quickjs.Value {
	module := rt.obj()
	rt.set(module, "tmpdir", rt.fn(func(*quickjs.Context, *quickjs.Value, []*quickjs.Value) *quickjs.Value {
		return rt.str(os.TempDir())
	}))
	rt.set(module, "platform", rt.fn(func(*quickjs.Context, *quickjs.Value, []*quickjs.Value) *quickjs.Value {
		return rt.str(nodePlatform())
	}))
	rt.set(module, "arch", rt.fn(func(*quickjs.Context, *quickjs.Value, []*quickjs.Value) *quickjs.Value {
		return rt.str(nodeArch())
	}))
	rt.set(module, "homedir", rt.fn(func(*quickjs.Context, *quickjs.Value, []*quickjs.Value) *quickjs.Value {
		home, err := os.UserHomeDir()
		if err != nil {
			return rt.str("")
		}
		return rt.str(home)
	}))
	rt.set(module, "type", rt.fn(func(*quickjs.Context, *quickjs.Value, []*quickjs.Value) *quickjs.Value {
		return rt.str(goruntime.GOOS)
	}))
	rt.set(module, "EOL", rt.str(eol()))
	return module
}

func nodePlatform() string {
	if goruntime.GOOS == "windows" {
		return "win32"
	}
	return goruntime.GOOS
}

func nodeArch() string {
	switch goruntime.GOARCH {
	case "amd64":
		return "x64"
	case "386":
		return "ia32"
	case "arm64":
		return "arm64"
	case "arm":
		return "arm"
	default:
		return goruntime.GOARCH
	}
}

func eol() string {
	if goruntime.GOOS == "windows" {
		return "\r\n"
	}
	return "\n"
}

var _ = time.Now
