'use strict';
const $ = (id) => document.getElementById(id);
const VIEWS = ['idle', 'confirm', 'running', 'ok', 'removed', 'fail'];
let panelUrl = null;
let logPath = null;
let mode = 'install';

window.kqs.onLogPath((p) => { logPath = p; });

function show(view) {
  for (const v of VIEWS) $(v).style.display = v === view ? 'block' : 'none';
}

function beginInstall() {
  mode = 'install';
  $('step').textContent = 'Starting up';
  $('log').textContent = '';
  show('running');
  window.kqs.startInstall();
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
      // Fall back to the default port if the URL was not seen in the output, so
      // the Open button always has a valid target instead of doing nothing.
      panelUrl = result.url || 'http://localhost:8420';
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
