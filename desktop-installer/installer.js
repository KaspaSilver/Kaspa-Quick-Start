'use strict';
// The engine behind the buttons. It does NOT reimplement anything -- it runs the
// exact same install.sh / uninstall.sh (or .ps1) the terminal one-liners run,
// only elevated and headless, and streams progress back to the window.
//
// Elevation + streaming, portably: a normal user can't install Docker or remove a
// root-owned stack, so the script runs as root/admin. Rather than stream stdout
// out of an elevated process on three OSes, the elevated command redirects
// everything to a log file and writes its exit code to a "done" file; the app
// tails the log for progress and watches the done file for the result.

const cp = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const RAW = 'https://raw.githubusercontent.com/KaspaSilver/Kaspa-Quick-Start/main';

const tmp = (name) => path.join(os.tmpdir(), name);
const sh = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`; // single-quote for POSIX shells
const osa = (s) => `"${String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`; // AppleScript string

function stackDir() { return path.join(os.homedir(), '.kaspa-node'); }

function posixBootstrap(scriptFile, args, logFile, doneFile) {
  const dir = stackDir();
  const uid = process.getuid ? process.getuid() : 0;
  const gid = process.getgid ? process.getgid() : 0;
  const runline = args.length
    ? `curl -fsSL ${RAW}/${scriptFile} | bash -s -- ${args.map(sh).join(' ')}`
    : `curl -fsSL ${RAW}/${scriptFile} | bash`;
  // Output goes to stdout/stderr (NOT a log file) so it streams straight back
  // through the pkexec/osascript pipe the app captures -- a root-written temp file
  // was the fragile link that once produced an empty, unexplained log. The leading
  // echo proves capture is live. KASPA_YES so nothing waits on a prompt;
  // KASPA_STACK_DIR so a root-run script still targets the real user's home; chown
  // so anything left behind stays theirs; the exit code goes to the done file.
  return (
    `export KASPA_YES=1 KASPA_STACK_DIR=${sh(dir)}; ` +
    `echo "[installer] starting, running as $(id -un)"; ` +
    `${runline}; code=$?; ` +
    `chown -R ${uid}:${gid} ${sh(dir)} 2>/dev/null || true; ` +
    `printf '%s' "$code" > ${sh(doneFile)}; ` +
    `echo "[installer] finished with code $code"`
  );
}

function launchWindows(scriptFile, args, logFile, doneFile, cap) {
  const win = (p) => p.replace(/\\/g, '\\\\');
  const argline = args.join(' ');
  const inner =
    `$ErrorActionPreference='Continue'; ` +
    `try { & ([scriptblock]::Create((irm ${RAW}/${scriptFile}))) ${argline} *> '${win(logFile)}'; $c=$LASTEXITCODE } ` +
    `catch { $_ | Out-File -Append -Encoding utf8 '${win(logFile)}'; $c=1 }; ` +
    `if ($null -eq $c) { $c = 0 }; Set-Content -Encoding ascii -Path '${win(doneFile)}' -Value $c`;
  const b64 = Buffer.from(inner, 'utf16le').toString('base64');
  const outer = `Start-Process powershell -Verb RunAs -WindowStyle Hidden -ArgumentList '-NoProfile','-ExecutionPolicy','Bypass','-EncodedCommand','${b64}'`;
  return cp.spawn('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', outer], {
    ...(cap || {}),
    windowsHide: true,
  });
}

// A child environment safe for spawning SYSTEM binaries (pkexec/curl/bash). An
// AppImage prepends its own bundled libraries to LD_LIBRARY_PATH; a system binary
// launched with that inherited path tries to load the app's libs and dies before
// printing anything -- which is exactly why the AppImage failed with a silent
// "exit 1" while the .deb (no such pollution) worked. Stripping these lets the
// helpers load the system libraries they expect.
function cleanEnv() {
  const env = { ...process.env };
  delete env.LD_LIBRARY_PATH;
  delete env.LD_PRELOAD;
  // If AppRun stashed the pre-AppImage value, put it back.
  if (env.APPIMAGE_ORIGINAL_LD_LIBRARY_PATH) env.LD_LIBRARY_PATH = env.APPIMAGE_ORIGINAL_LD_LIBRARY_PATH;
  return env;
}

// stdio: capture stdout/stderr of the ELEVATION wrapper (pkexec/osascript/the
// powershell launcher), so its own errors ("pkexec: not authorized", an auth
// failure, "cannot run bash") surface instead of vanishing.
const CAP = { stdio: ['ignore', 'pipe', 'pipe'], env: cleanEnv() };

function launch(base, posixArgs, winArgs, logFile, doneFile) {
  if (process.platform === 'linux') {
    return cp.spawn('pkexec', ['bash', '-c', posixBootstrap(`${base}.sh`, posixArgs, logFile, doneFile)], CAP);
  }
  if (process.platform === 'darwin') {
    const script = `do shell script ${osa(posixBootstrap(`${base}.sh`, posixArgs, logFile, doneFile))} with administrator privileges`;
    return cp.spawn('osascript', ['-e', script], CAP);
  }
  if (process.platform === 'win32') {
    return launchWindows(`${base}.ps1`, winArgs, logFile, doneFile, CAP);
  }
  return null;
}

function run(base, posixArgs, winArgs, { onLine = () => {}, onDone = () => {} } = {}) {
  const logFile = tmp(`kaspa-quick-start-${base}.log`);
  const doneFile = tmp(`kaspa-quick-start-${base}.done`);
  try { fs.writeFileSync(logFile, ''); } catch { /* best effort */ }
  try { fs.rmSync(doneFile, { force: true }); } catch { /* best effort */ }

  let child;
  try {
    child = launch(base, posixArgs, winArgs, logFile, doneFile);
    if (!child) return onDone({ ok: false, error: `Unsupported platform: ${process.platform}` });
  } catch (e) {
    return onDone({ ok: false, error: `Could not start: ${e.message}` });
  }

  let offset = 0;
  let panelUrl = null;
  let settled = false;
  let childExited = false;
  let graceAfterExit = 0;

  // One place that both the pipe (Linux/macOS) and the log-file tail (Windows)
  // feed, so the panel URL is caught whichever path the output arrives on.
  const handleLine = (line) => {
    const m = line.match(/https?:\/\/localhost:\d+/);
    if (m) panelUrl = m[0];
    onLine(line);
  };

  const pump = () => {
    let buf;
    try { buf = fs.readFileSync(logFile); } catch { return; }
    if (buf.length <= offset) return;
    const chunk = buf.toString('utf8', offset);
    offset = buf.length;
    for (const line of chunk.split(/\r?\n/)) {
      if (line) handleLine(line);
    }
  };

  const finish = (result) => {
    if (settled) return;
    settled = true;
    clearInterval(timer);
    pump();
    onDone({ url: panelUrl, ...result });
  };

  // Surface the elevation wrapper's own stdout/stderr (auth/exec errors) that the
  // log-file redirect never sees, so a failure before the script runs is explained.
  const forward = (b) => {
    for (const line of b.toString('utf8').split(/\r?\n/)) if (line.trim()) handleLine(line);
  };
  if (child.stdout) child.stdout.on('data', forward);
  if (child.stderr) child.stderr.on('data', forward);

  child.on('error', (e) => finish({ ok: false, error: e.message }));
  child.on('exit', () => { childExited = true; });

  const timer = setInterval(() => {
    pump();
    let code = null;
    try { code = fs.readFileSync(doneFile, 'utf8').trim(); } catch { /* not done yet */ }
    if (code !== null && code !== '') { finish({ ok: code === '0', code: Number(code) }); return; }
    if (childExited && ++graceAfterExit >= 6) {
      finish({ ok: false, cancelled: true, error: 'It was cancelled, or the password prompt was dismissed.' });
    }
  }, 500);

  return { logFile };
}

const runInstall = (handlers) => run('install', [], ['-Yes'], handlers);
const runUninstall = ({ deleteData = false, ...handlers } = {}) =>
  run('uninstall', deleteData ? ['--delete-data'] : [], deleteData ? ['-Yes', '-DeleteData'] : ['-Yes'], handlers);

module.exports = { runInstall, runUninstall };
