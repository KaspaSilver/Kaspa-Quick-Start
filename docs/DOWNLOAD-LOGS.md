# Handoff: "Download logs" in Kaspa Quick Start (for the KQS session)

From the KaChat Desktop session, 2026-10-23. The owner wants to download logs from the KQS panel
and hand them to a Claude session that has no access to the machine (the KaChat server at
kachat.duckdns.org runs on a machine other sessions cannot reach). First use: finding why KaPosts
notifications don't arrive while the KaChat web app is closed.

Nothing here has been changed in Kaspa-Quick-Start or kachat-indexer; this is a request.

## 1. What the owner gets

On the **Logs** page, a **Download logs** button. It opens a small choice:

- **What**: a preset (below), or "Everything".
- **How far back**: Last 1 hour / 6 hours / 24 hours (default 6 hours).
- **Download**: one plain-text file, e.g. `kqs-logs-push-2026-10-23T0130Z.txt`.

The file is meant to be pasted into a chat or attached, so: plain text, UTF-8, colour codes
stripped, every line with its UTC timestamp, secrets redacted (section 4), and short enough to
paste (cap each source at about 5,000 lines, newest kept, with a note when cut).

## 2. Presets

| Preset | Sources (existing `dockerctl.LOG_SOURCES` keys) | Use |
|---|---|---|
| **Push & notifications** | `kachat-push` (the push filter on `kaspa-node-kachat`) plus the same container's lines matching `/kaposts\|push notify\|quiet/i` (the KaPosts processor's push sends) | chat, request and KaPosts notifications, Web Push |
| **KaChat indexer** | `kachat` (whole `kaspa-node-kachat` log) | messages missing, sync, KaPosts indexing |
| **KaChat database** | `kachat-db` | indexer errors that point at Postgres |
| **Node** | `kaspad` | node sync, peers |
| **Everything** | every installed source, each in its own section | "something is wrong, not sure what" |

Testnet variants only when testnet is installed (`*-testnet` keys), as the Logs page does.

## 3. The file

```
KaChat / Kaspa Quick Start log export
Generated: 2026-10-23T01:30:12Z   Window: last 6 hours   Preset: Push & notifications
KQS panel version: <version>   Network(s): mainnet
Containers: kaspa-node-kachat  image=<image@digest>  status=Up 3 hours  restarts=0
            ...

===== push service (kaspa-node-kachat, filtered /push/i) — 1,284 lines =====
2026-10-23T00:31:02.113Z [Push] register platform=web token=...a1b2 watched=12 ... kaposts_pubkey=true ...
...
===== KaPosts processor push lines (kaspa-node-kachat) — 37 lines =====
...
```

- One header with the panel version, the window, and for each container: image (tag or digest),
  status, uptime and restart count (`docker inspect`). Restart counts and uptimes are often the
  answer.
- One section per source, in the Logs page's order, with its line count.

## 4. Redaction (required — the file leaves the machine)

Replace values with `[redacted]`, keeping the key name, for:

- every `.env` value the panel knows is secret: `KACHAT_PUSH_SECRET` / `INTERNAL_PUSH_SECRET`,
  `KACHAT_WEBPUSH_VAPID_PRIVATE_KEY`, `CHANGENOW_API_KEY`, database passwords, DuckDNS token,
  panel password hashes, the KasSigner / bot keys — match by **value** (the literal secret
  strings from `.env` and the store), not only by name, so a secret echoed in any line is caught;
- `x-internal-secret:` and `Authorization:` header values, `Bearer …` tokens, JWT-looking strings;
- Web Push endpoint URLs (`https://web.push.apple.com/…`, `fcm.googleapis.com/…`,
  `updates.push.services.mozilla.com/…`): keep the host, drop the path (`https://web.push.apple.com/[redacted]`);
- 64-hex strings next to `key`, `secret`, `private` or `seed`, and any run of 12 or 24 BIP39-like
  words (defensive; the indexer should never log these).

Keep: Kaspa addresses, tx ids, post ids, pubkeys (public), device token *suffixes* as already logged
(`...a1b2`), timestamps, counts. These are what make the logs useful.

## 5. API sketch

`GET /api/logs/download?preset=push&since=6h` (behind the existing panel login), responding
`text/plain; charset=utf-8` with `Content-Disposition: attachment; filename="kqs-logs-push-<UTC>.txt"`.
Built on what is there: `dockerctl.logSource`, `filterFor`, `stripAnsi`, and
`docker logs --since <window> --timestamps <container>` (instead of `--tail`, so the window is
real time). The button can just navigate to that URL.

## 6. For the kachat-indexer session (small, related)

So the push preset actually shows why a KaPosts push was or wasn't sent:

1. `kachat-transaction-processor/src/push_notify.rs`: a failed POST to the push service is logged
   with `tracing::debug!("push notify to {} failed: {}", …)` — invisible at the default level.
   Make it `warn!`, and log each KaPosts push sent at `info!` (path, target pubkey suffix, tx id).
2. `kachat-transaction-processor/src/worker.rs`: when a transaction is processed "quiet" (older than
   `PUSH_MAX_AGE_MS` = 5 minutes, so no pushes), log it at `info!` with its age. If the processor
   runs more than 5 minutes behind, every KaPosts action is silently push-less — the owner sees
   KaPosts notifications only when the app opens, which is the reported bug. That line makes it
   provable from a log download; consider raising the limit or applying it only to reindex /
   recovered rows.
3. `kasia-indexer/indexer/src/push.rs` `ExtensionPushEvent::KaPosts`: log the delivery outcome per
   event at `info!` (matched devices, sent / failed / pruned), as the chat pushes already are.

## 7. Checking it

Download "Push & notifications" for the last hour after: registering the KaChat web app (expect a
`[Push] register platform=web … kaposts_pubkey=true` line), then having someone like one of your
posts while the app is closed (expect the processor's KaPosts push line and the push service's
delivery line, or a "quiet" line saying why not). Search the file for every secret in `.env`: none
may appear.
