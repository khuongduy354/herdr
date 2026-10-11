# Duy's Koala Herd

Koala-specific authentication, streamed status, local groups, sound, and terminal attachment for Duy's Herdr fork. The native client owns presentation and keyboard routing; this adapter owns Koala semantics. Task identity is normalized server URL plus full UUID, independent of tabs and panes.

See [setup and controls](../../docs/next/website/src/content/docs/koala-herd.mdx).

The Linux installer records the current Node executable so desktop launchers use the same Node 22+ runtime even when their PATH omits nvm. Reinstall after removing or moving that runtime.

```sh
npm ci --prefix adapters/koala --ignore-scripts
node --test adapters/koala/*.test.mjs
just test-one koala
just build
adapters/koala/install.sh
```

## Boundaries

`catalog.mjs` validates version 1 snapshots and consecutive revision changes atomically. Epoch and connection generation fence old data. `events.mjs` consumes bounded SSE events with heartbeat timeout. When the streaming endpoint is unavailable (404/405/501 or the HTML app shell), `worker.mjs` falls back to `polling.mjs`, fetching the existing active-task list every three seconds. Authentication and stream protocol failures do not trigger fallback. Requests are sequential, bounded, cancellable, and refresh authentication each time; failures retain stale rows and silence waiting tones. Restart the client to probe streaming again after a server upgrade. `worker.mjs` uses bounded newline-delimited JSON to communicate with the native client; network, filesystem, and player work stays off the render thread.

`groups.mjs` stores preferences by server and UUID, using atomic replacement and serialized read-modify-write. Missing tasks retain preferences. `auth.mjs` reads normal Koala profiles; `auth-bridge.mjs` exposes fresh headers only through a private temporary local socket restricted to that server. No credentials belong in shared layouts or group files.

`attach.mjs` uses the existing Koala binary WebSocket contract. Input is gated by replay completion and discarded on disconnect. `herdr.mjs` uses public local API calls to create a new tab or focus a metadata-matched pane. It never creates or resumes a Koala task.

`sound.mjs` adapts C-octave synthesis from [khuongduy354/koala-client](https://github.com/khuongduy354/koala-client). Only fresh selected waiting rows contribute voices; disconnect and worker shutdown stop playback.

The matching streaming server implementation is [feat/herd-status-stream](https://github.com/superme-ai/koala/tree/feat/herd-status-stream). Older servers work through the polling fallback without deployment changes. Polling only reports waiting when a running PTY has positive `needsInput` evidence; absent activity evidence remains unknown.

## Checkpoint verification

The implementation passes 34 adapter tests and 10 native Koala tests. An isolated native TUI check exercises rendered replay, raw keyboard input, resize, reconnect, attachment reuse, and exit cleanup against a simulated Koala server. Native formatting/clippy and maintenance checks pass.

The full Herdr suite still has ten endpoint/sidebar failures that reproduce on the unchanged fork baseline. Windows cross-check requires an SDK not installed on the validation machine. Production deployment and a same-server web latency comparison remain release gates; no latency parity claim is made.
