# Installed app and offline workspaces

The production build is an installable PWA. Serve it over HTTPS (or loopback for
local testing). Development Vite does not register a service worker. A local PWA
still needs a running Node backend for synchronization, authentication, generation,
webpage fetching and PDF extraction; installation does not embed Node or SQLite.

## What is saved on this device

Open a brane while connected to retain its workspace state in IndexedDB. The
brane list, configuration and previously opened history/details are cached per
account. Image/PDF originals and PDF page text are downloaded when a brane opens;
attachments that have not finished downloading require reconnection. A new browser
profile must connect and sign in once. Workspaces never opened on this device are
not available offline.

Offline work supports new branes, title saves, text creation/editing, placement
creation/removal, movement and resize. Removing a placement retains the underlying
artifact and history. Text entered before the autosave timer completes remains in
the existing recoverable draft store. Composer drafts remain scoped to the tab.
File import intents keep their existing durable retry flow; creating new extracted
PDF content, snapshots, Run/Spawn and webpage imports requires the server.

The interface distinguishes unsaved editor drafts from changes committed to local
storage but awaiting synchronization. Browser storage can fail or be cleared; an
unsuccessful local commit never dispatches its mutation. Device storage is not a
backup or an encrypted vault. A lost or cleared browser profile loses unsynchronized
work. Use the recovery export before resolving a difficult conflict, and keep
regular server database/assets backups.

## Synchronization and conflicts

Every mutation commits its projection and an immutable operation key in one local
transaction before transmission. IndexedDB serializes competing tab writes;
Web Locks serialize replay/conflict resolution and BroadcastChannel refreshes other
windows. The server atomically commits each operation and its receipt. Retrying a
lost response uses the same key and cannot duplicate creation or reapply a move.
Receipts store hashes, not copies of artifact text, and remain indefinitely so late
offline clients cannot accidentally redeliver an old operation as a new write.

Text and geometry writes carry expected versions; title writes carry the previous
title; removal carries the placement version. A conflicting operation stops the
account's queue. Review its local change and current server state, then explicitly
keep local changes or use server changes for that item. Later changes to the same
item are rebased or discarded together; unrelated local changes remain queued.
Capacity, validation and permission failures retain the operation for retry and
recovery export. Removed sources cannot be silently recreated by an overwrite.

Before replay, the client revalidates the account. Requests also bind the expected
actor to the server session, preventing replay under another account's cookies.
Authentication failure never falls back to cached data as if authorization had
succeeded. A network outage can reopen the last signed-in account's local replica.
Signing out requires synchronization and clears the offline-entry identity; saved
replicas remain partitioned by account for later sign-in.

Generation and other online operations must wait for the outbox to drain. No
service worker initiates paid work or retries generation in the background. The
foreground app attempts synchronization on reconnect and periodically while open.
This is explicit conflict resolution, not automatic collaborative text merging.

## Installation and updates

The generated service worker precaches the complete UI, including lazy Canvas
assets. It does not cache API responses. Authenticated data and attachments live in
the account-scoped IndexedDB stores. New shell versions wait until all old app
windows close. The UI announces the waiting update; no forced reload interrupts
editing. Close every mem-brane window and reopen to activate it.

For a local built-app rehearsal, use the same database override as the dev process,
stop the dev server first, and run:

```sh
npm run build
APP_ORIGIN=http://localhost:3001 DATABASE_PATH=data/mem-brane.sqlite npm start
```

Open `http://localhost:3001`, sign in, and open a brane. Installation uses that
origin; browser storage on port 5173 is separate from storage on port 3001.

Verification includes real Chromium offline reload, lazy Canvas loading, creation,
text/geometry persistence and reconnect conflict resolution; replica tests exercise
lost acknowledgements, concurrent tabs, account switching and storage failures.
Actual installation flows and storage eviction on Safari/iOS still need device
verification. The browser regression suite uses port 4193 for the PWA rehearsal.
