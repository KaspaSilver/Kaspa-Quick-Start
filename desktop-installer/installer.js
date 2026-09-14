'use strict';
// The engine behind the one button. It does NOT reimplement the install -- it
// runs the exact same install.sh / install.ps1 the terminal one-liner runs, only
// elevated and headless, and streams progress back to the window.
//
// Elevation + streaming, portably: a normal user can't install Docker, so the
// script has to run as root/admin. Rather than fight to stream stdout back out of
// an elevated process on three OSes, the elevated command redirects everything to
// a log file and writes its exit code to a "done" file; the app tails the log for
// progress and watches the done file for the result. Same shape everywhere.

const cp = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const RAW = 'https://raw.githubusercontent.com/KaspaSilver/Kaspa-Quick-Start/main';

const tmp = (name) => path.join(os.tmpdir(), name);
// Single-quote for POSIX shells.
const sh = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;
// Escape for an AppleScript string literal.
const osa = (s) => `"${String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;

function posixBootstrap(logFile, doneFile) {
  const dir = path.join(os.homedir(), '.kaspa-node');
  const uid = process.getuid ? process.getuid() : 0;
  const gid = process.getgid ? process.getgid() : 0;
  // KASPA_YES so confirm() never waits; KASPA_STACK_DIR so a root-run install
  // still lands in the real user's home; chown so the files stay theirs.
  return (
    `export KASPA_YES=1 KASPA_STACK_DIR=${sh(dir)}; ` +
    `{ curl -fsSL ${RAW}/install.sh | bash; } > ${sh(logFile)} 2>&1; code=$?; ` +
    `chown -R ${uid}:${gid} ${sh(dir)} 2>/dev/null || true; ` +
    `printf '%s' "$code" > ${sh(doneFile)}`
  );
}

function launchLinux(logFile, doneFile) {
  // pkexec shows the desktop's polkit password dialog and runs the script as root.
  return cp.spawn('pkexec', ['bash', '-c', posixBootstrap(logFile, doneFile)], {
    stdio: 'ignore',
  });
}

function launchMac(logFile, doneFile) {
  // "with administrator privileges" shows the native macOS password dialog.
  const script = `do shell script ${osa(posixBootstrap(logFile, doneFile))} with administrator privileges`;
  return cp.spawn('osascript', ['-e', script], { stdio: 'ignore' });
}

function launchWindows(logFile, doneFile) {
  const win = (p) => p.replace(/\\/g, '\\\\');
  // Run install.ps1 as a scriptblock so we can pass -Yes; redirect every stream to
  // the log; record the exit code. Start-Process -Verb RunAs raises the UAC prompt.
  const inner =
    `$ErrorActionPreference='Continue'; ` +
    `try { & ([scriptblock]::Create((irm ${RAW}/install.ps1))) -Yes *> '${win(logFile)}'; $c=$LASTEXITCODE } ` +
    `catch { $_ | Out-File -Append -Encoding utf8 '${win(logFile)}'; $c=1 }; ` +
    `if ($null -eq $c) { $c = 0 }; Set-Content -Encoding ascii -Path '${win(doneFile)}' -Value $c`;
  const b64 = Buffer.from(inner, 'utf16le').toString('base64');
  const outer = `Start-Process powershell -Verb RunAs -WindowStyle Hidden -ArgumentList '-NoProfile','-ExecutionPolicy','Bypass','-EncodedCommand','${b64}'`;
  return cp.spawn('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', outer], {
    stdio: 'ignore',
    windowsHide: true,
  });
}

/**
 * Run the install. `onLine(text)` fires per output line; `onDone({ok, code, url,
 * cancelled, error})` fires once at the end.
 */
function runInstall({ onLine = () => {}, onDone = () => {} } = {}) {
  const logFile = tmp('kaspa-quick-start-install.log');
  const doneFile = tmp('kaspa-quick-start-install.done');
  try { fs.writeFileSync(logFile, ''); } catch { /* best effort */ }
  try { fs.rmSync(doneFile, { force: true }); } catch { /* best effort */ }

  let child;
  try {
    if (process.platform === 'linux') child = launchLinux(logFile, doneFile);
    else if (process.platform === 'darwin') child = launchMac(logFile, doneFile);
    else if (process.platform === 'win32') child = launchWindows(logFile, doneFile);
    else return onDone({ ok: false, error: `Unsupported platform: ${process.platform}` });
  } catch (e) {
    return onDone({ ok: false, error: `Could not start the installer: ${e.message}` });
  }

  let offset = 0;
  let panelUrl = null;
  let settled = false;
  let childExited = false;

  const pump = () => {
    let buf;
    try { buf = fs.readFileSync(logFile); } catch { return; }
    if (buf.length <= offset) return;
    const chunk = buf.toString('utf8', offset);
    offset = buf.length;
    for (const line of chunk.split(/\r?\n/)) {
      if (!line) continue;
      const m = line.match(/https?:\/\/localhost:\d+/);
      if (m) panelUrl = m[0];
      onLine(line);
    }
  };

  const finish = (result) => {
    if (settled) return;
    settled = true;
    clearInterval(timer);
    pump(); // flush any tail
    onDone({ url: panelUrl, ...result });
  };

  child.on('exit', () => { childExited = true; });
  // If the elevation prompt is cancelled, the launcher exits and no done-file is
  // ever written -- give the real work a beat to start, then treat it as cancelled.
  child.on('error', (e) => finish({ ok: false, error: e.message }));

  let graceAfterExit = 0;
  const timer = setInterval(() => {
    pump();
    let code = null;
    try { code = fs.readFileSync(doneFile, 'utf8').trim(); } catch { /* not done yet */ }
    if (code !== null && code !== '') {
      finish({ ok: code === '0', code: Number(code) });
      return;
    }
    if (childExited) {
      // No done-file and the launcher is gone. Allow ~3s in case the elevated
      // child is still spawning, then call it a cancel/failure.
      if (++graceAfterExit >= 6) {
        finish({ ok: false, cancelled: true, error: 'The install was cancelled or the password prompt was dismissed.' });
      }
    }
  }, 500);

  return { logFile };
}

module.exports = { runInstall };
