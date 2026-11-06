# Kaspa Quick Start: desktop installer

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

Docker is installed automatically if missing, via the script's own logic
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

The build installs with `npm ci`, so it uses exactly the versions in the committed
`package-lock.json`. To move to newer Electron or electron-builder versions, change
`package.json`, run `npm install`, and commit the updated lockfile with it.

Artifacts: `Kaspa-Quick-Start-Windows.exe`, `Kaspa-Quick-Start-MacOS.dmg`, and
`Kaspa-Quick-Start-Linux.deb` (Debian/Ubuntu/Mint family). The names carry no
version, so download links stay stable across releases. AppImage was dropped: it
inherited the app's LD_LIBRARY_PATH into the elevated helper and failed where the
.deb did not. To also cover Fedora/openSUSE, add `"rpm"` to the linux target.

## Icon

The app icon is `build/icon.png` (1024x1024). electron-builder auto-generates the
Windows `.ico` and macOS `.icns` from it, so this one file is all that is needed.
The current file is a themed placeholder; drop the official Kaspa/KaChat logo at
`build/icon.png` (same size) to replace it.

## Signing (macOS signed and notarized; Windows and Linux unsigned)

- **macOS** is signed with a Developer ID certificate and notarized in CI. The
  workflow imports `CSC_LINK` / `CSC_KEY_PASSWORD` into a keychain of its own and
  points electron-builder at it with `CSC_KEYCHAIN`; `APPLE_ID`,
  `APPLE_APP_SPECIFIC_PASSWORD` and `APPLE_TEAM_ID` are for the notary service.
- **Windows** is unsigned, so first launch shows SmartScreen: *More info* → *Run
  anyway*. The workflow passes no Windows certificate today. To sign, add an
  Authenticode certificate as `WIN_CSC_LINK` / `WIN_CSC_KEY_PASSWORD` secrets
  **and** pass them in the *Build and publish* step's `env` for the Windows runner.
- **Linux:** the .deb is unsigned and needs nothing; it runs directly.

## Still needs on-device testing

The elevation path is the one part that must be verified on real machines:
- **Linux:** `pkexec` runs the script as root; the app sets `KASPA_STACK_DIR` to
  the user's home and `chown`s the folder back afterward (all but `conf/bot`,
  which belongs to the bot's own user on purpose).
- **macOS:** `osascript … with administrator privileges`. That shell, like any
  app opened from Finder, has no Docker CLI on its PATH, so the app and the
  scripts add Docker Desktop's and Homebrew's locations. Note a *fresh* Docker
  install uses Homebrew, which dislikes running as root; verify on a box that
  doesn't yet have Docker Desktop.
- **Windows:** `Start-Process -Verb RunAs` (UAC) runs `install.ps1 -Yes`,
  redirecting output to a log the app tails.

The scripts are downloaded to the run's private folder and checked before they
run, so an offline machine shows a failure instead of a false "installed".
Cancelling the password/UAC prompt is detected and shown as "cancelled".
