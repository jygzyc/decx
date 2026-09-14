package plugin

import (
	"crypto/md5"
	"crypto/sha1"
	"crypto/sha256"
	"crypto/sha512"
	"encoding/base64"
	"encoding/hex"
	"fmt"
	"hash"
	"strings"

	"github.com/buke/quickjs-go"
)

func (rt *runtime) cryptoModule() *quickjs.Value {
	module := rt.obj()
	// The binding hands any value a callback returns straight to the engine
	// without duplicating it, so a captured object must be returned through a
	// call to get a fresh reference (Node's update() returns the same object).
	identity := rt.evalValue("(function (value) { return value; })", "plugin.js")
	rt.set(module, "createHash", rt.fn(func(_ *quickjs.Context, _ *quickjs.Value, args []*quickjs.Value) *quickjs.Value {
		algorithm := strings.ToLower(strings.TrimSpace(rt.stringArg(args, 0, "algorithm")))
		digest, err := newHash(algorithm)
		if err != nil {
			panic(rt.errorObject("ERR_CRYPTO_HASH_UNKNOWN", err.Error()))
		}
		state := &hashState{hash: digest}
		object := rt.obj()
		rt.set(object, "update", rt.fn(func(_ *quickjs.Context, _ *quickjs.Value, args []*quickjs.Value) *quickjs.Value {
			_, _ = state.hash.Write(rt.bytesOf(argAt(args, 0)))
			return rt.call(identity, rt.undef(), object)
		}))
		rt.set(object, "digest", rt.fn(func(_ *quickjs.Context, _ *quickjs.Value, args []*quickjs.Value) *quickjs.Value {
			sum := state.hash.Sum(nil)
			encoding, ok := rt.optionalString(args, 0)
			if ok {
				switch strings.ToLower(encoding) {
				case "hex":
					return rt.str(hex.EncodeToString(sum))
				case "base64":
					return rt.str(base64.StdEncoding.EncodeToString(sum))
				case "utf8", "utf-8", "latin1", "binary":
					return rt.str(string(sum))
				}
			}
			return rt.bufferValue(sum)
		}))
		return rt.call(identity, rt.undef(), object)
	}))
	return module
}

type hashState struct {
	hash hash.Hash
}

func newHash(algorithm string) (hash.Hash, error) {
	switch algorithm {
	case "sha256":
		return sha256.New(), nil
	case "sha1":
		return sha1.New(), nil
	case "sha512":
		return sha512.New(), nil
	case "md5":
		return md5.New(), nil
	case "sha384":
		return sha512.New384(), nil
	case "sha224":
		return sha256.New224(), nil
	default:
		return nil, fmt.Errorf("digest method not supported: %s", algorithm)
	}
}
