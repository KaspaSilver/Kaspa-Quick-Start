# Personal indexing mode for group chats

**Repo to change:** `KaspaSilver/KaChat-Indexer`, branch `main`
**Ask:** the same "only index what is mine" that 1:1 chats already have, but for groups.

Everything below was read out of the repository at `main`. Nothing here has been
built or run — treat the design as a proposal, and the file and line references
as the starting points to check first.

---

## Short version

Personal mode already applies to group messages. It just cannot do much with
them, and the reason is not an oversight — the indexer genuinely cannot tell
which group a message belongs to.

The fix is smaller than it sounds, because the client already computes exactly
the identifier that is needed, and already sends it to the indexer for push
notifications. Personal mode can reuse it.

---

## What happens today

`indexer-actors/src/block_processor.rs:460` gates all chat storage on one call:

```rust
let store_content = crate::personal_allows(sender.as_ref(), &receiver);
```

and `indexer-actors/src/lib.rs:72`:

```rust
pub fn personal_allows(sender: Option<&AddressPayload>, receiver: &AddressPayload) -> bool {
    // empty allowlist => store everything (public indexer default)
    // otherwise: store if receiver is mine, or sender is mine
}
```

That gate is computed **once per transaction, before the operation type is
known**, and it can only ever ask one question: is one of my addresses the
sender or the primary output of this transaction?

For a 1:1 message that question is exactly right — sender and receiver are the
two participants.

For a group message it is nearly useless. A member posting to a group produces a
transaction whose sender is them and whose output is their own change address.
Your address appears nowhere. So the only group traffic personal mode keeps is:

- messages **you** sent, because you are the sender, and
- group control envelopes addressed **to you**.

Which is exactly what the dashboard already admits: *"Group capture is partial
for now: what you send, and control messages addressed to you."*

## Why you cannot just look up membership

The obvious fix — keep a roster of which groups you are in, then match on group
id — does not work, because there is no group id to match on.

`protocol/src/operation.rs:87`:

```rust
pub struct SealedGroupMessageV1<'a> {
    pub blinded_group_id: &'a [u8],
    ...
}
```

`INDEXER_NOTIFICATIONS_REFERENCE.md:76` says what that is:

> `blinded_group_id` — hex; the **per-(group,member)** blinded id the message was addressed to

Two things follow. The indexer never sees a real group id, and it cannot tell
that two members' messages belong to the same group, because each member's
messages carry a different blinded id. `kasia-indexer/docs/GROUP_CHAT_API.md:20`
states this as a deliberate property:

> The stable blinded-ID metadata privacy limitation remains: the indexer can
> correlate repeated use of the same blinded ID. It cannot recover the real group
> ID, keys, roster, or plaintext.

That is a feature, and any design that breaks it is the wrong design. So the
indexer cannot derive your groups. Something that holds the group keys has to
tell it.

## The part that makes this easy

The client already does exactly that, for a different feature.

Push registration (`indexer/src/api/v1/push.rs:104`) accepts:

| field | meaning |
|---|---|
| `watched_group_ids` | *"hex blinded group ids you belong to"* |

So the client can already enumerate its own blinded group ids and hand them to
the indexer. Personal mode needs the same list, from the same source, for a
different purpose. **No new crypto, no protocol change, no roster tracking.**

---

## Proposed change

Mirror the mechanism personal addresses already use, which the admin dashboard
already drives end to end.

### 1. A second allowlist

`indexer/src/main.rs:67` loads addresses from a file the dashboard writes:

```rust
// KASIA_PERSONAL_FILE, default /app/data/personal_addresses.txt
fn load_personal_addresses() { ... }
```

Add the same for groups:

- `KASIA_PERSONAL_GROUPS_FILE`, default `/app/data/personal_group_ids.txt`
- one 32-byte hex blinded group id per line
- absent or empty means "no group filtering", so nothing changes for existing
  installs
- `set_personal_group_ids(...)` / `personal_group_count()` alongside the existing
  pair in `indexer-actors/src/lib.rs`

Store them as a `HashSet<[u8; BLINDED_GROUP_ID_LEN]>`: the check runs on every
group message and wants to be a hash lookup, not a scan.

### 2. Make the gate operation-aware

This is the only structurally awkward part. `store_content` is computed at
`block_processor.rs:460`, **before** the `match op` that would tell you whether
this is a group message. So it cannot currently ask a group-specific question.

Two ways round it:

- **Pass the operation in.** Change `personal_allows` to take `&SealedOperation`
  and decide per type. Fewest call sites, one signature change.
- **Move the check inside the match.** Leave the address gate where it is for
  the 1:1 arms, and give the two group arms their own check. More lines, less
  coupling between the filter and the protocol enum.

Either way the rule becomes:

```
GroupMessageV1  -> store if blinded_group_id is in the group allowlist
                   OR the sender is one of my addresses (keeps today's behaviour)
GroupControlV1  -> store if addressed to one of my addresses (unchanged)
everything else -> unchanged
```

Note the `OR`: without it, turning group personal mode on would *stop* storing
your own sent messages if you had not yet registered that group's id, which
would look like data loss.

### 3. Admin API and dashboard

`kachat-admin/src/main.rs:1204` handles the address list today: writes the file,
then `supervisorctl restart chat` so the indexer reloads it (`main.rs:1215`).

Add the group list the same way:

- extend `SettingsUpdate` with `personal_group_ids: Option<String>`
- extend `SettingsResponse` with `personal_group_ids` and a derived
  `group_personal_mode: bool` (true when the list is non-empty), matching how
  `personal_mode` is derived from `personal_addresses` at `main.rs:1163`
- write the file and restart the chat indexer on change

Once that exists, the control panel picks it up with no further work: its KaChat
Chats screen already reads and writes these settings through the admin API, so a
new field is a new box on the same card.

### 4. Where the operator gets the ids

This is the one genuine rough edge, and it is worth being straight about it. A
blinded group id is not something a person can read off a screen today — it is
derived from group key material the KaChat client holds.

Options, roughly in order of effort:

1. **Export from the client.** Add a "copy my group ids" action to KaChat, since
   it already computes them for `watched_group_ids`. Paste into the dashboard.
2. **Reuse a push registration.** If the operator's own device is registered for
   push, the indexer already stores its `watched_group_ids`. The dashboard could
   offer "use the groups from device X" and skip the copy-paste entirely.
3. **Learn them.** Every group message you send carries your own blinded id, so
   the indexer could offer any id it has already seen bound to one of your
   addresses. Only covers groups you have posted in.

Option 2 is the nicest and needs no client change at all, but it does mean
personal mode depends on push being set up. Option 1 is the honest default.

---

## What this does not fix

Worth stating plainly, because it limits what the feature can promise.

**Correction to an earlier draft of this document.** It claimed other members'
blinded ids could not be enumerated, and that the feature could therefore only
ever capture your own group traffic. That is wrong.

A blinded id is per-(group, member), and `kasia-indexer/docs/GROUP_CHAT_API.md`
is explicit about the consequence: *"KaChat must query once per known member
because the blinded ID is sender-specific."* A client reading a group already
holds every member's id for it, because that is the only way to read the group
at all.

So listing every member's id for a group keeps the whole conversation, and
listing only your own keeps only what you sent. The feature is capable of full
group history; what limits it is whether the operator pastes one id or all of
them.

What genuinely remains out of reach is the indexer working any of this out for
itself. The ids come from group key material it never sees, so they always have
to arrive from a client.

## Suggested order

1. Allowlist plus loader — self-contained, nothing else depends on it.
2. Operation-aware gate — the only change that touches hot-path code, so land it
   on its own where it is easy to review and revert.
3. Admin API fields and file write.
4. Client-side id export, or the push-registry shortcut.

Steps 1 to 3 are testable without any client change: put a known blinded id in
the file by hand, send a group message, confirm it is stored, then remove the id
and confirm it is not.
