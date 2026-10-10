# Duy’s Koala Herd adapter

This module isolates Koala status semantics from Herdr pane and workspace identity. It is the first implementation checkpoint; it does not yet enable the sidebar or attach a terminal.

Run the contract tests with Node 22 or newer:

```sh
node --test adapters/koala/*.test.mjs
```

## Status protocol version 1

Each authenticated connection starts with a snapshot. A daemon epoch identifies one status history. Revisions are safe, nonnegative integers. Changes advance by exactly one revision; duplicates are ignored. A gap or invalid event makes the catalog stale and requires a new snapshot. Transport generations fence late callbacks from old connections.

```json
{"version":1,"type":"snapshot","epoch":"boot-id","revision":0,"tasks":[{"id":"12345678-1234-1234-1234-123456789abc","title":"agent","lifecycle":"active","activity":"waiting"}]}
{"version":1,"type":"change","epoch":"boot-id","revision":1,"upsert":[],"remove":["12345678-1234-1234-1234-123456789abc"]}
```

Lifecycle values are `active`, `shelved`, and `closed`. Activity values are `unknown`, `stopped`, `idle`, `working`, and `waiting`. Missing or newer activity values become `unknown`, never `working`. Each change is validated before any mutation. A task may occur only once in a batch, including removals.

The catalog returns active rows, including tasks without open panes. Disconnect retains rows with `stale: true` and suppresses the selected waiting count. A reconnect snapshot replaces the catalog. The UI owns persistent grouping and selection independently, keyed by normalized server URL plus full task UUID.

The protocol is a proposed client/server contract until the server capability ships. Existing Koala REST task lists must not be passed off as this stream. Terminal transport will use the existing Koala binary WebSocket protocol separately.

## Checkpoint validation

The initial contract has eight passing Node tests. Rust formatting passed. The full `just check` attempt stopped in Herdr's existing native build because Zig 0.16.0 was unavailable; it did not reach the Rust test suite. This checkpoint changes no Rust code or published Herdr codec.
