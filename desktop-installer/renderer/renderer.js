'use strict';
const $ = (id) => document.getElementById(id);
const VIEWS = ['idle', 'confirm', 'running', 'ok', 'removed', 'fail'];
let panelUrl = null;
let logPath = null;
let requestedPort = 8420;
let mode = 'install';

window.kqs.onLogPath((p) => { logPath = p; });

function show(view) {
  for (const v of VIEWS) $(v).style.display = v === view ? 'block' : 'none';
}

function beginInstall() {
  mode = 'install';
  requestedPort = Number($('port').value) > 0 ? Number($('port').value) : 8420;
  $('step').textContent = 'Starting up';
  $('log').textContent = '';
  show('running');
  window.kqs.startInstall(requestedPort);
}

function beginUninstall(wipe) {
  mode = 'uninstall';
  $('step').textContent = 'Starting up';
  $('log').textContent = '';
  show('running');
  window.kqs.startUninstall(wipe);
}

$('install').addEventListener('click', beginInstall);
$('reinstall').addEventListener('click', beginInstall);
$('open').addEventListener('click', () => window.kqs.openPanel(panelUrl));
$('uninstall').addEventListener('click', () => show('confirm'));
$('cancel').addEventListener('click', () => show('idle'));
$('do-uninstall').addEventListener('click', () => beginUninstall($('wipe').checked));
$('retry').addEventListener('click', () => (mode === 'uninstall' ? show('confirm') : beginInstall()));

window.kqs.onLine((line) => {
  const step = line.match(/^==>\s*(.+)$/);
  if (step) $('step').textContent = step[1];
  const log = $('log');
  log.textContent += line + '\n';
  log.scrollTop = log.scrollHeight;
});

window.kqs.onDone((result) => {
  if (result && result.ok) {
    if (mode === 'uninstall') {
      $('removedmsg').textContent = 'Docker was left installed. You can install again any time.';
      show('removed');
    } else {
      // Prefer the real URL parsed from the install output (it reflects the port
      // the panel actually bound, even if it was auto-moved). Fall back to the
      // port the user chose -- never a hard-coded 8420, which would point at
      // whatever else is on 8420.
      panelUrl = result.url || `http://localhost:${requestedPort}`;
      $('url').textContent = panelUrl;
      show('ok');
    }
    return;
  }
  $('failtitle').textContent = mode === 'uninstall' ? 'Uninstall did not finish' : 'Install did not finish';
  $('failmsg').textContent =
    (result && (result.error || (result.cancelled ? 'Cancelled.' : `Exit code ${result.code}`))) ||
    'Something went wrong. Check the log and try again.';
  $('faillog').textContent = ($('log').textContent || '').split('\n').slice(-40).join('\n').trim() || '(no output was captured)';
  $('logpath').textContent = logPath ? `Full log: ${logPath}` : '';
  show('fail');
});
