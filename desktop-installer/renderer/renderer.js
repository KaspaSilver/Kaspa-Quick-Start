'use strict';
const $ = (id) => document.getElementById(id);
let panelUrl = null;

function show(view) {
  $('idle').style.display = view === 'idle' ? '' : 'none';
  $('running').style.display = view === 'running' ? '' : 'none';
  $('ok').style.display = view === 'ok' ? 'block' : 'none';
  $('fail').style.display = view === 'fail' ? 'block' : 'none';
}

function begin() {
  show('running');
  $('step').textContent = 'Starting…';
  $('log').textContent = '';
  window.kqs.startInstall();
}

$('install').addEventListener('click', begin);
$('retry').addEventListener('click', begin);
$('open').addEventListener('click', () => window.kqs.openPanel(panelUrl));

window.kqs.onLine((line) => {
  // The scripts prefix each stage with "==>" -- surface that as the current step.
  const step = line.match(/^==>\s*(.+)$/);
  if (step) $('step').textContent = step[1];
  const log = $('log');
  log.textContent += line + '\n';
  log.scrollTop = log.scrollHeight;
});

window.kqs.onDone((result) => {
  if (result && result.ok) {
    panelUrl = result.url;
    $('url').textContent = result.url || 'http://localhost:8420';
    show('ok');
  } else {
    $('failmsg').textContent =
      (result && (result.error || (result.cancelled ? 'Cancelled.' : `Exit code ${result.code}`))) ||
      'Something went wrong. Check the log and try again.';
    show('fail');
  }
});
