# Handoff: NFC Card page in Kaspa Quick Start (for the KQS session)

From the KaChat iPhone session, 2026-11-02. The owner wants people to back up a seed phrase they
already have to a Java Card and restore it by tapping the card on their phone. The card first needs
open source software loaded onto it, and that's the part Quick Start should make easy.

**The owner will tell you when to build this.** Nothing else in Kaspa-Quick-Start has been changed;
this file is a request. The card software and the helper live in a new public repo,
[KaspaSilver/KaChat-NFC](https://github.com/KaspaSilver/KaChat-NFC). Please don't copy that code here.

## Status of KaChat-NFC

- [v0.1.1](https://github.com/KaspaSilver/KaChat-NFC/releases/tag/v0.1.1) is published, so the
  installer URLs below work. It builds for macOS, Windows and Linux in GitHub Actions.
- **No card has been loaded with it yet.** The owner wants the first real load to go through this
  page, so this page is also how the helper and applet get their first real test. Use a test card
  with no real seed.
- **This session now handles KaChat-NFC fixes.** The owner decided this on 2026-11-03, replacing the
  earlier note that sent them to the iPhone session. The local checkout is at
  `/Users/restosaved/Everything KaChat iPhone/KaChat-NFC`. Fix problems in that repo rather than
  patching around them here. The iPhone session keeps KaChat's own NFC screens.
- `docs/HELPER-API.md` is the contract. If it and this file disagree, it wins.

## To do now: move to v0.1.1

`manager/lib/kachat-nfc.js` on the `nfc-card` branch still pins `TAG = 'v0.1.0'`. **Change it to
`v0.1.1`.** On Linux, v0.1.0 can't see any reader, so this page can't work there until this changes.

The image name includes the tag, so the new image builds by itself. The old
`kaspa-quick-start/kachat-nfc:v0.1.0` image stays behind and nothing removes it, because the Remove
action only knows the current tag. Please clean it up as part of this change.

**What went wrong.** The owner tried this on Linux Mint with a reader plugged in, and nothing was
detected. The PC listed the reader (`072f:b100`, ACR39U) and the container had its device node, but
the v0.1.0 Dockerfile ran `pcscd --disable-polkit`. Debian 12's pcscd 1.9.9 has no such option, so
it exited at once. v0.1.1 only removes that option.

**Not verified yet.**
- The v0.1.1 image hasn't been built or run. Its CI doesn't build the Docker image.
- It isn't known yet whether pcscd finds the reader once it stays up. The owner was given a manual
  test for that, and the result hasn't been reported.

## Known gaps in KaChat-NFC

Yours to fix or leave, now that this session handles the repo. None of them need doing before the
version change above.

- **A dead pcscd looks like an empty reader.** The Dockerfile backgrounds pcscd, so if it exits, the
  helper keeps running and reports no readers. That's what hid this bug, and the page gave the owner
  no sign of it.
- **CI never builds or runs `docker/Dockerfile`.** A check that pcscd is still up in the built image
  would have caught this.
- **The CAP file isn't reproducible.** Two builds of the same source gave different hashes
  (`f57f33a0...` and `fec7a913...`). Fix that before claiming anyone can verify the card software
  independently.

## 1. What the owner gets

A new **NFC Card** item in the panel's **KaChat** section. It should feel automatic:

1. **Plug in.** The page sees the reader and card by itself, with no "Look for it" button.
2. **Check.** It says what's in the reader in plain words.
3. **Load.** One button writes the software and confirms it's there.
4. **Secure.** It replaces the card's public admin keys and shows the new key once to save.
5. **Done.** It tells the user to open KaChat and back up by tapping the card.

Follow [KasSigner](../manager/lib/kassigner.js) for the shape: a tool, not a service, with step cards
and buy links. Unlike KasSigner, it has no firmware download, because the helper already contains
the card software.

Ship it on an Experimental branch first, as the README describes for new apps.

## 2. The helper, and why it exists

KasSigner reaches USB through Docker with `--device`. That only works on a Linux host, because
Docker Desktop has no direct USB access on macOS or Windows. So the card work runs in `kachat-nfc`,
a small program outside Docker, which the page calls from the browser.

| Host | How the page reaches the reader |
|---|---|
| macOS, Windows | The browser calls the helper at `http://127.0.0.1:18421`. The reader plugs into the computer the browser is on |
| Linux with native Docker | The manager runs the helper in a container and proxies to it (section 5). The reader plugs into the machine running Quick Start |

**Choosing a path.** In the browser, try `GET http://127.0.0.1:18421/v1/status` first, with a short
timeout. If it answers, use it. If not, ask the backend: `host.js` already reads Docker's
`OperatingSystem`, which tells Docker Desktop from native Linux. On native Linux, use section 5.
Otherwise, show the setup step below.

**Setup step.** This is the one extra thing a Mac or Windows user does, so keep it short. Choose the
command from the browser's OS, with a copy button, and keep polling so the page moves on by itself
as soon as the helper answers:

```bash
curl -fsSL https://github.com/KaspaSilver/KaChat-NFC/releases/latest/download/install-helper.sh | sh
```

```powershell
irm https://github.com/KaspaSilver/KaChat-NFC/releases/latest/download/install-helper.ps1 | iex
```

It installs for the current user only, with no password or admin prompt, and starts at login.
The matching `uninstall-helper.sh` and `uninstall-helper.ps1` remove it. Show those on an Uninstall
sub-tab, and say removing the helper doesn't change any card.

**A panel not on localhost.** The helper only answers loopback origins by default. When the panel's
own origin isn't loopback, put it in the command:

```bash
curl -fsSL https://github.com/KaspaSilver/KaChat-NFC/releases/latest/download/install-helper.sh | KACHAT_NFC_ORIGIN="https://panel.example.com" sh
```

```powershell
$env:KACHAT_NFC_ORIGIN = "https://panel.example.com"; irm https://github.com/KaspaSilver/KaChat-NFC/releases/latest/download/install-helper.ps1 | iex
```

Safari may block an HTTPS page from calling the local helper over HTTP. If you can't make that work,
say so on the page and suggest opening the panel at `http://localhost` or using another browser.

## 3. What the page shows

Poll `GET /v1/status` about every 2 seconds while the page is open, and stop when it isn't.

| Situation | How to tell | Show |
|---|---|---|
| Helper not found | The request fails | The setup step |
| No reader | `readers` is empty | "Plug in your card reader." Add the buy links |
| Empty reader | `card` is `null` | "Insert your card, chip side up and chip first." |
| Unreadable card | `state` is `unreadable` | "This card can't be read. Check it's inserted the right way." |
| Untested card | `supported` is false | "KaChat-NFC has only been tested on J3R180 cards, so this one can't be loaded." |
| Blank, supported | `state` is `blank` | **Load** button. Show the chip name and free memory |
| Loaded, public keys | `state` is `loaded`, `adminKeysChanged` is false | **Secure this card** as the next step, and the applet version |
| Loaded, secured | `state` is `loaded`, `adminKeysChanged` is true | "Ready. Open KaChat and back up by tapping this card." |
| PIN blocked | `applet.pinBlocked` is true | "This card's PIN is blocked after too many wrong tries. Any backup on it can no longer be read." Reloading is the only way to reuse it |

If several readers are listed with cards in, let the user pick one and send its name as `reader`.

## 4. The two buttons

**Load** calls `POST /v1/card/load`. It takes about 20 seconds, so show progress and tell the user
not to remove the card.

- On `would_erase`, show the helper's `message` in a confirmation dialog, then repeat with
  `confirmErase: true`. Never send `confirmErase: true` without that dialog.
- On `wrong_admin_key`, ask for the saved admin key and send it as `adminKey`.
- On `card_removed`, tell the user to put the card back and load again.

**Secure this card** calls `POST /v1/card/secure`. Explain before pressing: this replaces public
keys that anyone could use to replace the card's software.

- Show the returned `adminKey` once, with a copy button and an "I saved it" checkbox that has to be
  ticked before moving on. Say that without it the card keeps working, but its software can never be
  updated or replaced.
- On `secure_uncertain`, `error.adminKey` holds the new key. Show it exactly the same way, along with
  the message.
- Allow skipping, but keep showing that the card is on public keys.

## 5. Linux path

KaChat-NFC's `docker/Dockerfile` builds the helper with `pcscd` and the CCID driver. On a native
Linux host, the manager should:

- Build it on first use, like `ensureEsptool` in `kassigner.js`, pinned to a release tag.
- Run it only while the page is open, then stop it, with `--device /dev/bus/usb`, on the stack's
  private network, and with **no published port**.
- Proxy only `GET /v1/status`, `POST /v1/card/load` and `POST /v1/card/secure` under the panel's own
  auth, for example at `/api/kachat-nfc/...`.

**This path is untested.** `--device` may not see a reader plugged in after the container starts, so
you may need to restart it when no reader appears, or use a different device setup. A `pcscd` running
on the host can also hold the reader. Test on real Linux hardware, and mark the path experimental if
it can't be made reliable.

## 6. Rules to keep

These protect a card that can hold someone's backup.

- **Never start a load or secure by yourself.** Only a user's click. Never retry either one
  automatically: some cards count failed logins and lock their management for good.
- **Never store or log `adminKey`.** It's not for the manager's state, job logs, Download logs or
  backups. Don't send it through the backend on Mac or Windows at all.
- **Don't ask for a PIN, password or seed anywhere in the panel.** Those stay in KaChat. The helper
  has no endpoint for them.
- **Don't supply or download card software.** The helper can only write the applet built into it.
- **Say it isn't cold storage.** Suggested intro: "Back up a seed phrase you already have to an NFC
  card, encrypted and protected by a PIN. The card never creates keys. This isn't cold storage, so
  keep your seed phrase on paper too."
- The panel's em dash check applies to this page's text.

## 7. Buy links

| Item | Link |
|---|---|
| Card: J3R180 JCOP4 (must be this chip) | https://www.amazon.com/dp/B0CFFCJ9W1 |
| Reader: ACS ACR39U-UF (USB-C) | https://www.amazon.com/dp/B075TBYBR8 |

Those are the exact items the owner tested with. Any PC/SC contact reader should work, but only this
one has been tested.

## 8. Updates

Compare `helperVersion` with the latest KaChat-NFC release, as the KasSigner page does, and offer
**Update helper** by showing the same install command.

A newer applet is different: reloading erases the card's PIN and backup, so never present it as a
routine update. Mention it only as "A newer version of the card software is available. Loading it
erases this card's backup, so have your seed phrase ready first."

## 9. Done means

- A fresh Mac with the reader and a blank J3R180 gets from opening the page to a loaded, secured card
  without using anything outside the panel except the one setup command.
- Each row in section 3 appears by itself as the reader and card are plugged in or removed.
- Windows has been run for real, or the page says it hasn't been tested.
- Tell the owner the page is on its Experimental branch, and nothing goes to `main` until they've
  tried it.
