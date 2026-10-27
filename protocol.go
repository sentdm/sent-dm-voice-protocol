// Package voiceprotocol is the Sent Voice Agents protocol as a Go module, so the Sent Voice Gateway and
// the Go SDK pin a release of this repository in go.mod instead of carrying a git submodule.
//
// It holds no Go code of its own. Files embeds the spec exactly as the release tag carries it, and a
// consumer reads what it needs from there: package.json for the version, asyncapi.yaml for the channel,
// the subprotocol and the x-sent rules, schemas/ for the frame schemas, and examples/valid and examples/invalid
// for the frames the repository's own tests check the schemas with. The sample agents in examples/ are not
// embedded.
package voiceprotocol

import "embed"

// Files is the spec of this release: package.json, asyncapi.yaml, schemas/ and the frame examples, with paths
// relative to the repository root.
//
//go:embed package.json asyncapi.yaml schemas examples/valid examples/invalid
var Files embed.FS
