# Make settings apply instantly instead of within 15 seconds

**Repo to change:** `KaspaSilver/KaChat-Indexer`, branch `main` (at `9add27f`)
**Ask:** a channel toggle should take effect immediately, not up to fifteen seconds later.

Read out of the repository at `origin/main`. Nothing here has been built or run.

---

## Where the delay is

Not in the write. `kv_set` commits immediately, and the admin API returns as
soon as it does.

The delay is the reader. `kachat-transaction-processor/src/main.rs:209` polls:

```rust
let _flags_handle = tokio::spawn(async move {
    loop {
        if let Ok(rows) = sqlx::query(
            "SELECT key, value FROM k_vars WHERE key IN ('feature_kaposts', 'feature_broadcasts', 'kaposts_operator_addresses', 'broadcast_channels')",
        )
        // ... apply to the runtime switches ...
        tokio::time::sleep(std::time::Duration::from_secs(15)).await;
    }
});
```

So a change lands somewhere in a 0–15 second window depending on where the loop
is when the write happens. Average five to eight seconds, worst case fifteen.

## The fix

The store is Postgres (`sqlx` with the `postgres` feature), so this needs no new
dependency and no new table: `LISTEN`/`NOTIFY` is built in, and `sqlx` ships
`PgListener` for exactly this.

### 1. Notify on write

Wherever `kv_set` is called for one of the polled keys (the broadcast channel
handler is at `kachat-admin/src/main.rs:1309`), follow it with:

```rust
sqlx::query("SELECT pg_notify('kvars_changed', $1)")
    .bind(key)
    .execute(&state.pool)
    .await;
```

Sending the key as the payload lets the reader skip work it does not need,
though re-reading all four is cheap enough that it can also be ignored.

Better still, do it in `kv_set` itself so no future caller has to remember.

### 2. Listen instead of sleeping

```rust
let mut listener = sqlx::postgres::PgListener::connect_with(&flags_pool).await?;
listener.listen("kvars_changed").await?;

loop {
    refresh(&flags_pool).await;   // the existing SELECT and match, lifted out

    // Wake on a change, or on the backstop, whichever comes first.
    tokio::select! {
        _ = listener.recv() => {}
        _ = tokio::time::sleep(std::time::Duration::from_secs(60)) => {}
    }
}
```

**Keep the timer.** A `NOTIFY` is fire-and-forget: it is delivered to sessions
listening *at that moment*. If the listener connection drops and reconnects, any
notification in that gap is gone for good, and without the timer the processor
would sit on stale flags indefinitely. Sixty seconds is a backstop, not the
mechanism. The point is that it stops being the thing anyone waits for.

`PgListener::recv()` reconnects on its own, which is what makes it safe to use
this way, but it cannot replay what it missed while disconnected.

### 3. What this does not change

`personal_addresses` and `personal_group_ids` are files plus
`supervisorctl restart chat`, not `k_vars`. They are already effectively
immediate and are unaffected.

## Cheaper alternative

Dropping the sleep to one second is a one-character change and makes the delay
imperceptible. It is one trivial indexed query per second per processor, which is
real but small. If `LISTEN`/`NOTIFY` looks like more surface than it is worth, this is
a defensible place to stop.

The reason to prefer the listener is that it is not a tradeoff: it is both
faster *and* less work for the database than either polling interval.

## How to check it

No client needed. Toggle a channel in the panel and watch the processor log; the
runtime set should change before the request returns rather than after. Then
kill the listener connection server-side with `pg_terminate_backend` and confirm
the sixty-second backstop still applies the change.
