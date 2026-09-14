package plugin

import (
	"syscall"
	"testing"
)

func TestIsBatchCommand(t *testing.T) {
	cases := map[string]bool{
		"foo.cmd":        true,
		"FOO.BAT":        true,
		"dir\\tool.cmd":  true,
		"C:\\bin\\x.Bat": true,
		"cmd.exe":        false,
		"foo.bat.exe":    false,
		"foo":            false,
		"":               false,
	}
	for command, want := range cases {
		if got := isBatchCommand(command); got != want {
			t.Errorf("isBatchCommand(%q) = %v, want %v", command, got, want)
		}
	}
}

func TestQuoteForCmd(t *testing.T) {
	cases := map[string]string{
		"adb":            "adb",
		"C:\\tools\\adb": "C:\\tools\\adb",
		"":               `""`,
		"a b":            `"a b"`,
		"a\tb":           "\"a\tb\"",
		`a"b`:            `"a\"b"`,
	}
	for arg, want := range cases {
		if got := quoteForCmd(arg); got != want {
			t.Errorf("quoteForCmd(%q) = %q, want %q", arg, got, want)
		}
	}
}

func TestBatchCommandLine(t *testing.T) {
	got := batchCommandLine("cmd.exe", `C:\Program Files\tool.cmd`, []string{"-s", "a b"})
	want := `cmd.exe /d /s /c ""C:\Program Files\tool.cmd" -s "a b""`
	if got != want {
		t.Fatalf("batchCommandLine = %q, want %q", got, want)
	}
}

func TestSignalName(t *testing.T) {
	if got := signalName(syscall.SIGTERM); got != "SIGTERM" {
		t.Errorf("signalName(SIGTERM) = %q", got)
	}
	if got := signalName(syscall.SIGKILL); got != "SIGKILL" {
		t.Errorf("signalName(SIGKILL) = %q", got)
	}
	// Unknown signals fall back to the conventional SIG<number> spelling.
	if got := signalName(syscall.Signal(64)); got != "SIG64" {
		t.Errorf("signalName(64) = %q, want SIG64", got)
	}
}
