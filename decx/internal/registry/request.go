package registry

import (
	"encoding/json"
	"fmt"
	"strconv"
	"strings"
)

// ParseArgs validates arguments without relying on a compiled-in command tree.
func ParseArgs(specs []Arg, input []string) (map[string][]string, error) {
	values := map[string][]string{}
	flags := map[string]Arg{}
	var positions []Arg
	for _, a := range specs {
		if a.Kind == "positional" {
			positions = append(positions, a)
		} else {
			flags[a.Long] = a
		}
	}
	literal, position := false, 0
	for i := 0; i < len(input); i++ {
		token := input[i]
		if token == "--" && !literal {
			literal = true
			continue
		}
		var a Arg
		value := token
		if strings.HasPrefix(token, "--") && !literal {
			key, inline, supplied := strings.Cut(token[2:], "=")
			var found bool
			a, found = flags[key]
			if !found {
				return nil, fmt.Errorf("unknown option --%s", key)
			}
			if a.Kind == "flag" {
				value = "true"
				if supplied {
					value = inline
				}
				if _, err := strconv.ParseBool(value); err != nil {
					return nil, fmt.Errorf("--%s requires a boolean", key)
				}
			} else if supplied {
				value = inline
			} else {
				i++
				if i >= len(input) || strings.HasPrefix(input[i], "--") {
					return nil, fmt.Errorf("missing value for --%s", key)
				}
				value = input[i]
			}
		} else {
			if !literal && strings.HasPrefix(token, "-") {
				return nil, fmt.Errorf("unknown option %s; use -- for literal values", token)
			}
			if position >= len(positions) {
				return nil, fmt.Errorf("unexpected argument %q", token)
			}
			a = positions[position]
			position++
		}
		if _, exists := values[a.ID]; exists && a.Kind != "multi" {
			return nil, fmt.Errorf("argument %s supplied more than once", a.ID)
		}
		if a.Type == "u64" {
			if _, err := strconv.ParseUint(value, 10, 64); err != nil {
				return nil, fmt.Errorf("%s requires an unsigned integer", a.ID)
			}
		}
		if len(a.Values) > 0 {
			valid := false
			for _, choice := range a.Values {
				if value == choice {
					valid = true
				}
			}
			if !valid {
				return nil, fmt.Errorf("%s must be one of %s", a.ID, strings.Join(a.Values, ", "))
			}
		}
		values[a.ID] = append(values[a.ID], value)
	}
	for _, a := range specs {
		if a.Required && len(values[a.ID]) == 0 {
			return nil, fmt.Errorf("missing required argument %s", a.ID)
		}
	}
	return values, nil
}

func defaultValue(m Mapping) (any, error) {
	var target any
	switch m.Type {
	case "string":
		target = new(string)
	case "string[]":
		target = new([]string)
	case "bool":
		target = new(bool)
	case "u64":
		target = new(uint64)
	default:
		return nil, fmt.Errorf("invalid mapping type %q", m.Type)
	}
	if len(m.Default) > 0 {
		if string(m.Default) == "null" {
			return nil, fmt.Errorf("field %s: null default is not allowed", m.Field)
		}
		if err := json.Unmarshal(m.Default, target); err != nil {
			return nil, fmt.Errorf("field %s: invalid default: %w", m.Field, err)
		}
	}
	switch t := target.(type) {
	case *string:
		return *t, nil
	case *[]string:
		if *t == nil {
			return []string{}, nil
		}
		return *t, nil
	case *bool:
		return *t, nil
	case *uint64:
		return *t, nil
	}
	panic("unreachable")
}

// BuildRequest converts CLI values into nested JSON fields declared by the tool.
func BuildRequest(mappings []Mapping, args map[string][]string) (map[string]any, error) {
	body := map[string]any{}
	for _, m := range mappings {
		values, set := args[m.Arg]
		if !set && m.When == "set" {
			continue
		}
		value, err := defaultValue(m)
		if err != nil {
			return nil, err
		}
		if set {
			if len(values) == 0 {
				return nil, fmt.Errorf("argument %s has no value", m.Arg)
			}
			switch m.Type {
			case "string":
				value = values[0]
			case "string[]":
				value = values
			case "u64":
				value, err = strconv.ParseUint(values[0], 10, 64)
			case "bool":
				value, err = strconv.ParseBool(values[0])
			}
			if err != nil {
				return nil, fmt.Errorf("argument %s: %w", m.Arg, err)
			}
		}
		if m.Invert {
			b, ok := value.(bool)
			if !ok {
				return nil, fmt.Errorf("field %s: invert requires a boolean", m.Field)
			}
			value = !b
		}
		parts := strings.Split(m.Field, ".")
		parent := body
		for _, part := range parts[:len(parts)-1] {
			if parent[part] == nil {
				parent[part] = map[string]any{}
			}
			child, ok := parent[part].(map[string]any)
			if !ok {
				return nil, fmt.Errorf("conflicting field %s", m.Field)
			}
			parent = child
		}
		key := parts[len(parts)-1]
		if _, exists := parent[key]; exists {
			return nil, fmt.Errorf("duplicate field %s", m.Field)
		}
		parent[key] = value
	}
	return body, nil
}
