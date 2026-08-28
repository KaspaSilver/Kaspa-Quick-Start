# Choosing which broadcast channels to index

**Repo to change:** `KaspaSilver/KaChat-Indexer`, branch `main`
**Ask:** turn individual channels on and off, and add new ones, without a rebuild.

Everything below was read out of the repository at `main`. Nothing here has been
built or run: treat the design as a proposal and the line references as the
places to look first.

---

## Why the panel cannot do this today

The tracked channels are a compile-time constant.
`kachat-transaction-processor/src/k_protocol.rs:32`:

```rust
/// Channels the broadcast indexer tracks. Only these normalized names are stored; everything else
/// on the canonical `kchat:1:bcast:` / legacy `ciph_msg:1:bcast:` protocol is dropped.
pub const BROADCAST_CHANNELS: [&str; 13] = [
    "kaspa", "kachat-bugs", "kaspa-indonesia", /* … */
];
```

and the check that uses it, at `k_protocol.rs:849`:

```rust
// Normalize + allowlist: only the tracked channels are indexed.
let channel = channel_raw.trim().to_lowercase();
if !BROADCAST_CHANNELS.contains(&channel.as_str()) {
    info!("Broadcast {} on non-tracked channel '{}', skipping", transaction_id, channel);
    return Ok(());
}
```

So a fourteenth channel cannot be indexed without recompiling, and the thirteen
that exist can only be turned on and off together, through `feature_broadcasts`.

The control panel currently says exactly that on its Broadcasts tab rather than
offering switches that would quietly do nothing.

## The pattern to copy already exists

The two feature switches are not compile-time. They are read from the database
every fifteen seconds by a task in `kachat-transaction-processor/src/main.rs:206`:

```rust
// Feature-flag refresher: honor the admin dashboard's indexing toggles. Reads the
// `feature_kaposts` / `feature_broadcasts` keys from k_vars every 15s and flips the runtime
// switches the processor consults per transaction. Absent key = default ON.
"SELECT key, value FROM k_vars WHERE key IN ('feature_kaposts', 'feature_broadcasts', 'kaposts_operator_addresses')"
```

The channel list wants to work the same way. That task already selects several
keys and already handles a multi-value one (`kaposts_operator_addresses` is
split on whitespace and commas), so this is a third case in a `match` that is
built for it.

---

## Proposed change

### 1. A runtime channel set

Replace the constant with something the refresher can write to. Alongside the
existing `FEATURE_*` atomics in `k_protocol.rs`:

```rust
/// The channels currently indexed. Empty means "not configured", which falls
/// back to DEFAULT_BROADCAST_CHANNELS so an existing install keeps its thirteen.
static BROADCAST_CHANNELS_RUNTIME: RwLock<Vec<String>> = RwLock::new(Vec::new());

pub const DEFAULT_BROADCAST_CHANNELS: [&str; 13] = [ /* the current list */ ];

pub fn set_broadcast_channels(list: Vec<String>) { /* … */ }
pub fn channel_is_tracked(channel: &str) -> bool { /* … */ }
```

Then `k_protocol.rs:851` becomes `if !channel_is_tracked(&channel)`.

**Normalize on the way in, not on the way out.** The check runs against a name
that has already been trimmed and lowercased, so whatever writes the list has to
apply the same treatment or a channel with a stray capital will never match and
will look like the feature is broken.

### 2. One more key in the refresher

Add `broadcast_channels` to the `IN (...)` list at `main.rs:213` and a match arm
beside the others:

```rust
"broadcast_channels" => k_protocol::set_broadcast_channels(
    value.split(['\n', '\r', ',', ' ', '\t'])
         .map(|s| s.trim().to_lowercase())
         .filter(|s| !s.is_empty())
         .collect(),
),
```

An absent key keeps the current behaviour, which matters: existing installs must
not silently stop indexing on upgrade.

Decide deliberately what an **empty but present** value means. "Index nothing"
and "index the defaults" are both defensible; whichever you pick, the panel has
to say it plainly, because an operator who unticks every channel will expect one
of them and be surprised by the other.

### 3. Admin API

`kachat-admin/src/main.rs` already stores this kind of thing with `kv_set` (see
`kaposts_operator_addresses` at `main.rs:1257`). Add:

- `SettingsResponse.broadcast_channels: String` and, for convenience,
  `available_broadcast_channels: Vec<String>` so a client can show the defaults
  as suggestions without hardcoding them again
- `SettingsUpdate.broadcast_channels: Option<String>`
- write it with `kv_set`, which needs no restart: the refresher picks it up
  within fifteen seconds, unlike the personal-mode files which do restart the
  chat indexer

### 4. What the panel does once that exists

Nothing in the indexer needs to know about this part; it is listed so the shape
of the API can be judged against it.

- a switch per channel on the Broadcasts tab, next to the existing per-channel
  counts, so what you are turning off and how much of it there is sit together
- an "add a channel" box that appends to the list and saves
- a new channel appears as a card immediately with a count of zero, and starts
  filling as matching broadcasts arrive

---

## Things worth deciding before building

**Turning a channel off does not delete anything.** It matches the feature
switches: new rows stop, existing ones stay until deleted. The panel already has
a per-channel purge, so the two together are enough, but the wording should not
imply that unticking cleans up.

**Adding a channel does not backfill.** The comment on the feature flags is
explicit that "historical gaps are filled by a re-index, not automatically", and
the same applies here. Anything published to a channel before it was added is
not picked up by adding it.

**Retention is by age, not by channel.** The pruner at `main.rs:258` drops
broadcasts older than the retention window regardless of channel. A channel
somebody adds specifically to archive will still be pruned on that schedule,
which may be a surprise worth surfacing, or an argument for per-channel
retention later.

**Push registration overlaps.** Devices register `watched_broadcast_channels`,
and `notify_broadcast` fires per channel. A channel that is watched but no longer
indexed will simply never notify. Worth checking whether that is silent or worth
a log line.

**There is no validation today.** Channel names arrive off-chain and are only
trimmed and lowercased. If the list becomes operator-editable it is worth
deciding a shape for them (length cap, allowed characters) so a pasted mistake
cannot become a permanent entry that matches nothing.

## Suggested order

1. Runtime set plus the default fallback, with the constant kept as the default.
   Self-contained, and `channel_is_tracked` can be unit tested against the
   normalization rules without a database.
2. The refresher key. One arm in an existing match.
3. Admin API fields.
4. Panel UI, which is our side and needs nothing from you beyond the shape of
   step 3.

Steps 1 to 3 are testable without any client: set `broadcast_channels` in
`k_vars` by hand, publish to a channel that is not in the default thirteen, and
confirm it is stored; remove it and confirm it is dropped again.
