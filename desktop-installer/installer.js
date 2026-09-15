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

function posixBootstrap(scriptFile, args, logFile, doneFile, { toLog = false } = {}) {
  const dir = stackDir();
  const uid = process.getuid ? process.getuid() : 0;
  const gid = process.getgid ? process.getgid() : 0;
  const runline = args.length
    ? `curl -fsSL ${RAW}/${scriptFile} | bash -s -- ${args.map(sh).join(' ')}`
    : `curl -fsSL ${RAW}/${scriptFile} | bash`;
  // KASPA_YES so nothing waits on a prompt; KASPA_STACK_DIR so a root-run script
  // still targets the real user's home; chown so anything left behind stays theirs;
  // the exit code goes to the done file. The leading echo proves capture is live.
  const body =
    `export KASPA_YES=1 KASPA_STACK_DIR=${sh(dir)}; ` +
    `echo "[installer] starting, running as $(id -un)"; ` +
    `${runline}; code=$?; ` +
    `chown -R ${uid}:${gid} ${sh(dir)} 2>/dev/null || true; ` +
    `printf '%s' "$code" > ${sh(doneFile)}; ` +
    `echo "[installer] finished with code $code"`;
  // Two ways the app gets progress, one per elevation channel:
  //   - Linux (pkexec) streams the child's stdout/stderr live, so leave output on
  //     the pipe the app captures.
  //   - macOS (osascript "do shell script") BUFFERS all output and only returns it
  //     when the command finishes -- so a live pipe shows nothing until the very
  //     end (the "stuck on Starting up" bug). Redirect to the log file instead;
  //     the app tails it every 500ms. bash flushes each `==>` step line to the file
  //     as it runs, and install.sh drops its ANSI colors when stdout isn't a tty,
  //     so the panel gets clean, live step text. osascript's OWN stderr (a
  //     dismissed password prompt) still reaches the app, since only the inner
  //     command's output is redirected here.
  return toLog ? `{ ${body} ; } > ${sh(logFile)} 2>&1` : body;
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

// Bring Docker Desktop to the foreground FROM THE USER'S SESSION. On macOS and
// Windows the daemon lives inside Docker Desktop (a per-user GUI app) and stays
// down -- so the whole install stalls -- until the app is running and the user has
// accepted its licence / granted access on first launch. The elevated install
// script does try to open it, but it runs as root, and a root `open -a Docker`
// often can't reach the logged-in user's GUI session. This runs in the installer
// app, which IS the user, so the window actually appears. Best-effort and safe to
// call when Docker Desktop is already open (it just focuses it).
function openDockerDesktop() {
  try {
    if (process.platform === 'darwin') {
      cp.spawn('open', ['-a', 'Docker'], { detached: true, stdio: 'ignore' }).unref();
    } else if (process.platform === 'win32') {
      const candidates = [
        path.join(process.env.ProgramFiles || 'C:\\Program Files', 'Docker', 'Docker', 'Docker Desktop.exe'),
        path.join(process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)', 'Docker', 'Docker', 'Docker Desktop.exe'),
      ];
      const exe = candidates.find((p) => { try { return fs.existsSync(p); } catch { return false; } });
      if (exe) cp.spawn('cmd', ['/c', 'start', '', exe], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
    }
  } catch { /* best effort -- the script's own attempt and the on-screen note remain */ }
}

function launch(base, posixArgs, winArgs, logFile, doneFile) {
  if (process.platform === 'linux') {
    return cp.spawn('pkexec', ['bash', '-c', posixBootstrap(`${base}.sh`, posixArgs, logFile, doneFile)], CAP);
  }
  if (process.platform === 'darwin') {
    // toLog: osascript buffers the command's output to the very end, so stream via
    // the log file the app tails instead (see posixBootstrap).
    const inner = posixBootstrap(`${base}.sh`, posixArgs, logFile, doneFile, { toLog: true });
    const script = `do shell script ${osa(inner)} with administrator privileges`;
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
  let dockerOpened = false;
  const needsDockerDesktop = process.platform === 'darwin' || process.platform === 'win32';

  // One place that every output path feeds (the pkexec pipe on Linux, the tailed
  // log file on macOS/Windows), so the panel URL and the Docker cue are caught
  // whichever way a line arrives.
  const handleLine = (line) => {
    const m = line.match(/https?:\/\/localhost:\d+/);
    if (m) panelUrl = m[0];
    // The moment the script reaches Docker Desktop, open it ourselves from the
    // user's session so it actually appears and the daemon can come up.
    if (needsDockerDesktop && !dockerOpened && /Starting Docker Desktop|Waiting for the Docker daemon/i.test(line)) {
      dockerOpened = true;
      openDockerDesktop();
    }
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

const runInstall = ({ port, ...handlers } = {}) => {
  const p = Number(port) > 0 ? String(Number(port)) : null;
  return run('install', p ? ['--gui-port', p] : [], p ? ['-Yes', '-GuiPort', p] : ['-Yes'], handlers);
};
const runUninstall = ({ deleteData = false, ...handlers } = {}) =>
  run('uninstall', deleteData ? ['--delete-data'] : [], deleteData ? ['-Yes', '-DeleteData'] : ['-Yes'], handlers);

module.exports = { runInstall, runUninstall };
