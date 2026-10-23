package voiceprotocol

import (
	"encoding/json"
	"io/fs"
	"testing"
)

// What a consumer reads from Files must be there, so a release cannot ship an empty module.
func TestFiles(t *testing.T) {
	raw, err := Files.ReadFile("package.json")
	if err != nil {
		t.Fatal(err)
	}
	var meta struct{ Version string }
	if err := json.Unmarshal(raw, &meta); err != nil || meta.Version == "" {
		t.Fatalf("package.json has no version: %v", err)
	}
	if _, err := Files.ReadFile("asyncapi.yaml"); err != nil {
		t.Fatal(err)
	}
	for dir, min := range map[string]int{"schemas/frames": 1, "examples/valid": 1, "examples/invalid": 1} {
		entries, err := fs.ReadDir(Files, dir)
		if err != nil {
			t.Fatal(err)
		}
		if len(entries) < min {
			t.Fatalf("%s is empty", dir)
		}
	}
}
