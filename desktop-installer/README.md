# Kaspa Quick Start — desktop installer

A one-screen desktop app that runs the **same** install as the terminal one-liner
(`curl … | bash` / `irm … | iex`), with a progress view and a link to the panel
at the end. It reimplements nothing: it fetches and runs the canonical
`install.sh` / `install.ps1` from `main`, so it never goes stale and the
copy-paste commands keep working unchanged.

## What it does

1. **Install** button → runs the platform install script **elevated** (one
   password / UAC prompt) and **headless** (`KASPA_YES=1` / `-Yes`).
2. Streams the script's `==>` steps and full log into a progress view.
3. On success, shows **`http://localhost:<port>`** (parsed from the script output,
   so it reflects the auto-picked port) and an **Open the control panel** button.

Docker is installed automatically if missing — via the script's own logic
(winget / Docker Desktop dmg / apt). Docker's own installer dialogs still appear;
on Windows a first-time WSL2 setup may need a reboot.

## Develop

```bash
cd desktop-installer
npm install
npm start
```

## Release (all three OSes)

Tag and push. GitHub Actions (`.github/workflows/installer-release.yml`) builds
on Windows/macOS/Linux runners and publishes the artifacts to the Release for the
tag (electron-builder uses the same `v*` tag as the release tag):

```bash
git tag v1.0.0
git push origin v1.0.0
```

Artifacts: `Kaspa Quick Start Windows.exe`, `Kaspa Quick Start MacOS.dmg`,
`Kaspa Quick Start Linux.AppImage` + `Kaspa Quick Start Linux.deb` (the AppImage
runs on Mint, Ubuntu, Fedora, and most others with nothing to install). The names
carry no version, so download links stay stable across releases.

## Icon

The app icon is `build/icon.png` (1024x1024). electron-builder auto-generates the
Windows `.ico` and macOS `.icns` from it, so this one file is all that is needed.
The current file is a themed placeholder; drop the official Kaspa/KaChat logo at
`build/icon.png` (same size) to replace it.

## Signing (currently OFF -- builds are unsigned)

Unsigned apps **work**, but first launch shows a one-time OS warning:
- **Windows:** SmartScreen → *More info* → *Run anyway*.
- **macOS:** right-click the app → *Open* (or System Settings → Privacy & Security → *Open Anyway*).
- **Linux:** none — runs directly.

To remove the warnings, add signing secrets to the repo (no code change — the CI
already passes them through):
- **macOS** (needs an Apple Developer account, $99/yr): `CSC_LINK`,
  `CSC_KEY_PASSWORD`, `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD`, `APPLE_TEAM_ID`.
- **Windows** (needs an Authenticode cert): `WIN_CSC_LINK`, `WIN_CSC_KEY_PASSWORD`.

## Still needs on-device testing

The elevation path is the one part that must be verified on real machines:
- **Linux:** `pkexec` runs the script as root; the app sets `KASPA_STACK_DIR` to
  the user's home and `chown`s it back afterward.
- **macOS:** `osascript … with administrator privileges`. Note a *fresh* Docker
  install uses Homebrew, which dislikes running as root — verify on a box that
  doesn't yet have Docker Desktop.
- **Windows:** `Start-Process -Verb RunAs` (UAC) runs `install.ps1 -Yes`,
  redirecting output to a log the app tails.

Cancelling the password/UAC prompt is detected and shown as "cancelled".
