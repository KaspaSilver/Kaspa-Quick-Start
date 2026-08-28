# Fixing the KaChat-Indexer build

**Repo to change:** `KaspaSilver/KaChat-Indexer`, branch `main`
**File to change:** `kasia-indexer/Cargo.toml`
**Status:** the recommended fix below was tested and resolves cleanly.

---

## The problem

`docker build` of `kachat-app` fails at the Rust compile step:

```
docker/kachat/Dockerfile.kachat-app:22
  22 | >>> RUN cargo build --release

error: failed to select a version for the requirement `serde_nested_with = "^0.2.5"`
  version 0.2.5 is yanked
  version 0.2.6 is yanked
  location searched: crates.io index
  required by package `kaspa-rpc-core v1.1.0-rc.2`
      ... which satisfies dependency `kaspa-rpc-core = "^1.1.0-rc.2"` of package `indexer v0.1.0`
```

## Why it happens

Three facts combine:

1. **Every published version of `serde_nested_with` is yanked from crates.io.**
   Not just the two named in the error, all ten of them. `crates.io/api/v1/crates/serde_nested_with`
   reports `max_version: 0.0.0`, which is what crates.io returns when nothing is
   installable.

2. **`kaspa-rpc-core` at tag `v1.1.0-rc.2` depends on it.** The `[patch.crates-io]`
   block in `kasia-indexer/Cargo.toml` pins six kaspa crates to that tag, so the
   yanked crate arrives transitively through them.

3. **There is no `Cargo.lock` in the repo.** Cargo will happily *use* a yanked
   version that is already recorded in a lockfile, but it refuses to *select* one
   during a fresh resolve. With no lockfile, every build is a fresh resolve.

Nothing here is specific to any one machine. This build cannot succeed anywhere,
for anyone, until one of the three changes.

Note this was **not** caused by anything in the KaChat-Indexer source. The crate
was yanked upstream some time after `v1.1.0-rc.2` was published, and the build
broke retroactively.

---

## Recommended fix: patch the yanked crate to its git source

`[patch.crates-io]` accepts a git source, and a patched crate is not subject to
crates.io yanking at all. The upstream repository is still public and still has
the tags.

**Add one line** to the existing `[patch.crates-io]` block in
`kasia-indexer/Cargo.toml`:

```toml
[patch.crates-io]
serde_nested_with = { git = "https://github.com/murar8/serde_nested_with", tag = "0.2.6" }
kaspa-addresses = { git = "https://github.com/kaspanet/rusty-kaspa.git", tag = "v1.1.0-rc.2" }
kaspa-consensus-core = { git = "https://github.com/kaspanet/rusty-kaspa.git", tag = "v1.1.0-rc.2" }
kaspa-math = { git = "https://github.com/kaspanet/rusty-kaspa.git", tag = "v1.1.0-rc.2" }
kaspa-rpc-core = { git = "https://github.com/kaspanet/rusty-kaspa.git", tag = "v1.1.0-rc.2" }
kaspa-txscript = { git = "https://github.com/kaspanet/rusty-kaspa.git", tag = "v1.1.0-rc.2" }
kaspa-wrpc-client = { git = "https://github.com/kaspanet/rusty-kaspa.git", tag = "v1.1.0-rc.2" }
```

That is the whole change. No source edits, no API migration.

### This was tested

Applied to a clean clone of `main` and run in a `rust:1-slim` container:

```
Updating git repository `https://github.com/murar8/serde_nested_with`
Updating crates.io index
Locking 520 packages to latest Rust 1.98.0 compatible versions
```

The resulting lockfile pins it to the git source:

```
name = "serde_nested_with"
version = "0.2.5"
source = "git+https://github.com/murar8/serde_nested_with?tag=0.2.6#ee200a4978ae4cc7da5469af0212431b0f8919a1"
```

Resolution is the step that was failing, and it now completes. **A full
`cargo build --release` was not run**, so this verifies the dependency graph
resolves, not that the crate then compiles. Confirm with an actual build before
you rely on it.

### Also commit a `Cargo.lock`

Once resolution works, generate and commit a lockfile:

```bash
cd kasia-indexer && cargo generate-lockfile && git add -f Cargo.lock
```

Check `.gitignore` first, since a `Cargo.lock` entry there is probably why there
isn't one. For a binary that ships in a container this is the right call anyway:
it makes builds reproducible, and it means the next crate that gets yanked cannot
break the build the same way, because a locked version is always allowed.

---

## Alternative fix: move to rusty-kaspa v2.x

Worth knowing about, but **bigger, and not required to unblock the build.**

`serde_nested_with` was removed from rusty-kaspa in commit `4969c6c3`
("chore(deps): address cargo audit/deny advisories", #970, 2026-05-01), which
landed well after `v1.1.0-rc.2` (2026-01-20) and is in `v2.0.0` and later. So
moving off the `v1.1.0-rc.2` tag also makes the problem disappear, without any
patch entry.

Release timeline:

| tag | date | has the fix |
|---|---|---|
| `v1.1.0-rc.2` | 2026-01-20 | no (current pin) |
| `v1.1.0` | 2026-03-04 | no |
| `v2.0.0` | 2026-06-05 | yes |
| `v2.0.1` | 2026-06-15 | yes (current stable) |

The change would be all six tags in `[patch.crates-io]` plus the five version
strings in `[workspace.dependencies]`, moving `1.1.0-rc.2` to `2.0.1`.

**Expect real work.** This is a major version bump across the RPC surface, and
the indexer uses it heavily:

| crate | references in `kasia-indexer/**/*.rs` |
|---|---|
| `kaspa_rpc_core` | 23 |
| `kaspa_wrpc_client` | 8 |
| `kaspa_consensus_core` | 5 |
| `kaspa_addresses` | 4 |
| `kaspa_txscript` | 2 |

I have not surveyed what actually changed between 1.1 and 2.0 in those APIs, so
treat the size of this as unknown until someone tries to compile it.

### Why you might still want it

The node this indexer reads from is **rusty-kaspa v2.0.1**. Client and node
being two major versions apart is a real risk over time even while it works
today, particularly around Crescendo (10 blocks per second, activated at DAA
score 110,165,000). If the indexer misreads anything from a v2 node, this gap is
the first place to look.

Suggested sequencing: **take the one-line patch now** to get building again, then
do the v2 migration deliberately as its own piece of work.

---

## How to verify the fix

From the repo root:

```bash
docker build -f docker/kachat/Dockerfile.kachat-app -t kachat-test .
```

Expect the build to get past `cargo build --release`. It compiles a large Rust
dependency tree, so allow a long first run.

## Where this is consumed

The Quick-Start-Kaspa panel builds this image from
`KaspaSilver/KaChat-Indexer@main` whenever KaChat is switched on. The panel's
KaChat screens are already built and talk to the indexer's admin API on port
3081 through a proxy; they are waiting on nothing but a working image. Once the
build succeeds, switching KaChat on in the panel is all that is needed.
