# Duy's Koala Herd

Koala-specific authentication, streamed status, local groups, sound, and terminal attachment for Duy's Herdr fork. The native client owns presentation and keyboard routing; this adapter owns Koala semantics. Task identity is normalized server URL plus full UUID, independent of tabs and panes.

See [setup and controls](../../docs/next/website/src/content/docs/koala-herd.mdx).

```sh
npm ci --prefix adapters/koala --ignore-scripts
node --test adapters/koala/*.test.mjs
just test-one koala
just build
adapters/koala/install.sh
```

## Boundaries

`catalog.mjs` validates version 1 snapshots and consecutive revision changes atomically. Epoch and connection generation fence old data. `events.mjs` consumes bounded SSE events with heartbeat timeout and no polling fallback. `worker.mjs` uses bounded newline-delimited JSON to communicate with the native client; network, filesystem, and player work stays off the render thread.

`groups.mjs` stores preferences by server and UUID, using atomic replacement and serialized read-modify-write. Missing tasks retain preferences. `auth.mjs` reads normal Koala profiles; `auth-bridge.mjs` exposes fresh headers only through a private temporary local socket restricted to that server. No credentials belong in shared layouts or group files.

`attach.mjs` uses the existing Koala binary WebSocket contract. Input is gated by replay completion and discarded on disconnect. `herdr.mjs` uses public local API calls to create a new tab or focus a metadata-matched pane. It never creates or resumes a Koala task.

`sound.mjs` adapts C-octave synthesis from [khuongduy354/koala-client](https://github.com/khuongduy354/koala-client). Only fresh selected waiting rows contribute voices; disconnect and worker shutdown stop playback.

The matching server implementation is [feat/herd-status-stream](https://github.com/superme-ai/koala/tree/feat/herd-status-stream). Deployment is required before a live client can subscribe.

## Checkpoint verification

The implementation passes 34 adapter tests and 10 native Koala tests. An isolated native TUI check exercises rendered replay, raw keyboard input, resize, reconnect, attachment reuse, and exit cleanup against a simulated Koala server. Native formatting/clippy and maintenance checks pass.

The full Herdr suite still has ten endpoint/sidebar failures that reproduce on the unchanged fork baseline. Windows cross-check requires an SDK not installed on the validation machine. Production deployment and a same-server web latency comparison remain release gates; no latency parity claim is made.
