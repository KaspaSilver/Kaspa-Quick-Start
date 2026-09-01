import { qrSvg } from './qr.js';

const $ = (id) => document.getElementById(id);
const el = (sel, root = document) => root.querySelector(sel);

// The QR is generated from the address already in the markup rather than from a
// second copy of it here. There is then no way for the code and the text under
// it to disagree, which for an address is the failure that matters.
{
    const shown = el('#donate-card .addr');
    if (shown) $('donate-qr').innerHTML = qrSvg(shown.textContent.trim(), { title: 'Kaspa donation address' });
}

// ------------------------------------------------------------------- api ---

async function api(path, { method = 'GET', body } = {}) {
    const res = await fetch(path, {
        method,
        headers: body ? { 'Content-Type': 'application/json' } : {},
        body: body ? JSON.stringify(body) : undefined,
    });
    let data = {};
    try {
        data = await res.json();
    } catch {
        /* empty body */
    }
    if (res.status === 401) {
        showLogin();
        throw new Error('Not signed in.');
    }
    if (!res.ok) {
        const detail = Array.isArray(data.details) ? `\n• ${data.details.join('\n• ')}` : '';
        throw new Error(`${data.error || res.statusText}${detail}`);
    }
    return data;
}

let toastTimer;
function toast(message, kind = '') {
    const node = $('toast');
    node.textContent = message;
    node.className = `toast ${kind}`;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => node.classList.add('hidden'), kind === 'bad' ? 8000 : 3500);
}

function debounce(fn, ms) {
    let timer;
    return (...args) => {
        clearTimeout(timer);
        timer = setTimeout(() => fn(...args), ms);
    };
}

const fmtNum = (n) => (n === null || n === undefined || n === '' ? '–' : Number(n).toLocaleString());

// Worker names, wallets and block hashes come from whatever a miner sent, so
// they are untrusted input on their way into innerHTML.
const escapeHtml = (value) =>
    String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

function fmtBytes(text) {
    if (!text) return '–';
    return text; // docker already reports a human-readable size
}

function fmtDuration(iso) {
    if (!iso || iso.startsWith('0001')) return '–';
    const secs = Math.max(0, Math.floor((Date.now() - new Date(iso).getTime()) / 1000));
    const d = Math.floor(secs / 86400);
    const h = Math.floor((secs % 86400) / 3600);
    const m = Math.floor((secs % 3600) / 60);
    if (d) return `${d}d ${h}h`;
    if (h) return `${h}h ${m}m`;
    return `${m}m`;
}

// ------------------------------------------------------------------ auth ---

function showLogin() {
    $('login').classList.remove('hidden');
    $('app').classList.add('hidden');
    stopPolling();
}

function showApp() {
    $('login').classList.add('hidden');
    $('app').classList.remove('hidden');
    // The heading is static markup until something navigates; seed it from
    // whichever entry starts active so it is not stale on first paint.
    $('page-title').textContent = document.querySelector('.nav-item.active .label').textContent;
    startPolling();
    loadSettings();
    loadProxies();
    loadMining();
    loadApps();
    loadKassigner();
    loadDuckDns();
    connectJobs();
    connectLogs();
}

$('login-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    const err = $('login-error');
    err.hidden = true;
    try {
        await api('/api/login', { method: 'POST', body: { password: $('login-password').value } });
        $('login-password').value = '';
        showApp();
    } catch (e) {
        err.textContent = e.message;
        err.hidden = false;
    }
});

$('logout').addEventListener('click', async () => {
    await fetch('/api/logout', { method: 'POST' });
    showLogin();
});

// --------------------------------------------------------- navigation ---

const SIDEBAR_KEY = 'kaspa-node-sidebar';
const MOBILE = () => window.matchMedia('(max-width: 860px)').matches;

// Why the node-dependent sections are locked, or null when they are open.
let lockReason = 'Waiting for the node…';

function selectTab(name) {
    let title = name;
    for (const item of document.querySelectorAll('.nav-item')) {
        const active = item.dataset.tab === name;
        item.classList.toggle('active', active);
        // The row carries the highlight so it wraps the switch too.
        item.closest('.nav-row')?.classList.toggle('active', active);
        if (active) title = el('.label', item).textContent;
    }
    for (const tab of document.querySelectorAll('.tab')) {
        tab.classList.toggle('active', tab.id === `tab-${name}`);
    }
    $('page-title').textContent = title;
    // Mining stats are only polled while that tab is on screen.
    setMiningPolling(name === 'mining');
    // The KaChat panels do the same, and each one loads only itself.
    setKachatPolling(name === 'kachat');
    // Same for the kaspad log: no point streaming it from another section.
    if (name !== 'kaspad') setKaspadLog(false);
    else setKaspadLog(activeSubtab('kaspad') === 'kaspadlog');
    // Read on arrival rather than polled: nothing on it changes by itself.
    if (name === 'global') loadGlobal().catch(() => {});
    if (name === 'gift') loadGift().catch(() => {});
    // On the drawer layout, picking a destination should get out of the way.
    if (MOBILE()) closeDrawer();
}

for (const item of document.querySelectorAll('.nav-item')) {
    item.addEventListener('click', () => selectTab(item.dataset.tab));
}

// --- kaspad log ---

/**
 * Streams kaspad's log into the Log sub-tab, and only while that tab is open.
 *
 * Browsers allow roughly six concurrent connections to one origin, and the
 * status poll, the all-logs stream and the job console already want several of
 * them, so this one is opened on demand and closed the moment you navigate
 * away.
 */
let kaspadLogStream = null;
const KASPAD_LOG_LINES = 2000;

function setKaspadLog(active) {
    if (!active) {
        kaspadLogStream?.close();
        kaspadLogStream = null;
        return;
    }
    if (kaspadLogStream) return;

    const view = $('kaspadlog-view');
    view.textContent = '';
    kaspadLogStream = new EventSource('/api/logs/stream?container=kaspad');

    kaspadLogStream.addEventListener('line', (event) => {
        const { line } = JSON.parse(event.data);
        // Only chase the bottom when the reader is already there, so scrolling
        // back through history is not yanked away on the next line.
        const follow = $('kaspadlog-follow').checked;
        const atBottom = view.scrollHeight - view.scrollTop - view.clientHeight < 40;

        view.textContent += `${line}\n`;
        // Trim from the front so a long-running node does not grow the DOM node
        // without limit.
        if (view.textContent.length > KASPAD_LOG_LINES * 200) {
            view.textContent = view.textContent.split('\n').slice(-KASPAD_LOG_LINES).join('\n');
        }
        if (follow && atBottom) view.scrollTop = view.scrollHeight;
    });

    kaspadLogStream.addEventListener('error', () => {
        view.textContent += '\n[the log stream dropped; reopen this tab to reconnect]\n';
    });
}

// --- sub-tabs (panels inside one destination) ---

function selectSubtab(section, name) {
    for (const button of section.querySelectorAll('.subtab-btn')) {
        button.classList.toggle('active', button.dataset.subtab === name);
    }
    for (const panel of section.querySelectorAll(':scope > .subtab')) {
        panel.classList.toggle('active', panel.id === `sub-${name}`);
    }
    // The kaspad log only streams while it is on screen.
    setKaspadLog(name === 'kaspadlog');
    // A KaChat panel loads when it is opened rather than all of them upfront.
    if (name.startsWith('kachat-')) refreshKachatPanel();
    // Same for the release list: it costs a GitHub call, so it is fetched when
    // the tab that shows it is opened rather than on every page load.
    if (name === 'updates') loadReleasePicker().catch(() => {});
    if (name === 'kassigner-updates') loadKassignerReleases().catch(() => {});
}

for (const button of document.querySelectorAll('.subtab-btn')) {
    button.addEventListener('click', () => selectSubtab(button.closest('section'), button.dataset.subtab));
}

/** The sub-tab currently showing in a section, or null if it has none. */
const activeSubtab = (tab) =>
    document.querySelector(`#tab-${tab} .subtab-btn.active`)?.dataset.subtab ?? null;

// --- service switches in the sidebar ---

const navSwitch = (service) => document.querySelector(`[data-service="${service}"]`);

/**
 * Reflects a service's real state onto its sidebar switch. Never called from a
 * click: the switches show what the containers are doing, so a failed start
 * cannot leave one sitting in the wrong position.
 */
/**
 * The health dot beside a destination.
 *
 * Three states carry meaning and a fourth deliberately does not: a service you
 * switched off is not broken, so it gets a hollow dot rather than a red one.
 * Red is reserved for "you asked for this and it is not there", which is the
 * only case worth walking over to look at.
 */
/** Where a tab's name and its lifecycle key are different words. */
const HEALTH_KEYS = { kaspad: 'node' };

/**
 * The dot beside a service.
 *
 * Red means installed and not running, which is a thing to look into. Something
 * that was never installed is not unhealthy, and saying so in red sends people
 * looking for a fault in a service they have not asked for yet.
 *
 * Every caller works this out from its own tab's data -- the node from its RPC,
 * the apps from their config -- and each of them would have to remember to ask
 * whether the thing exists first. Asking here instead means none of them can
 * forget, including the ones written later.
 */
function setNavHealth(tab, state) {
    const dot = document.querySelector(`.nav-dot[data-health="${tab}"]`);
    if (!dot) return;

    const known = serviceState[HEALTH_KEYS[tab] ?? tab];
    if (known && known.installed === false && state !== 'none') state = 'absent';

    dot.className = `nav-dot ${state === 'absent' ? '' : (state ?? '')}`.trim();
    dot.title = {
        ok: 'Running normally',
        warn: 'Running, but not fully ready',
        bad: 'Installed, but not running',
        off: 'Switched off',
        absent: 'Not installed',
        none: '',
    }[state] ?? '';
}

function setNavSwitch(service, on, { disabled = false, reason = '' } = {}) {
    const input = navSwitch(service);
    if (!input || input.dataset.busy === '1') return;
    input.checked = Boolean(on);
    input.disabled = disabled;
    const label = input.closest('.switch');
    if (label) label.title = disabled && reason ? reason : label.getAttribute('aria-title') || label.title;
}

// Each service is switched on in whatever way its own API expects.
/**
 * What a switch does now: start or stop, and nothing else.
 *
 * It used to enable and disable, which for every container service meant
 * building on the way up and removing the container on the way down -- so
 * "off" and "never installed" were the same state, and an hour of building was
 * one careless click from gone. Installing and removing are their own actions
 * now, with their own buttons.
 */
const start = (key) => (on) => api(`/api/services/${key}/${on ? 'start' : 'stop'}`, { method: 'POST' });

const SERVICE_ACTIONS = {
    node: (on) => api(`/api/node/${on ? 'start' : 'stop'}`, { method: 'POST' }),
    // Not a container: it fetches and verifies firmware, so there is nothing to
    // install or leave running.
    kassigner: (on) => api('/api/kassigner', { method: 'PUT', body: { enabled: on } }),
    mining: start('mining'),
    kachat: start('kachat'),
    desktop: start('desktop'),
    nextcloud: start('nextcloud'),
    gift: start('gift'),
    proxy: start('proxy'),
};

const SERVICE_NAMES = {
    node: 'the node',
    mining: 'mining',
    kachat: 'KaChat-Indexer',
    desktop: 'KaChat-Desktop',
    kassigner: 'KasSigner',
    nextcloud: 'Nextcloud',
    proxy: 'the reverse proxy',
};

for (const input of document.querySelectorAll('[data-service]')) {
    input.addEventListener('change', async () => {
        const service = input.dataset.service;
        const wanted = input.checked;
        input.dataset.busy = '1';
        input.disabled = true;
        try {
            await SERVICE_ACTIONS[service](wanted);
            openConsole(`${wanted ? 'Starting' : 'Stopping'} ${SERVICE_NAMES[service]}`);
        } catch (e) {
            input.checked = !wanted;
            toast(e.message, 'bad');
        } finally {
            // Hold the switch until the next poll can report what really happened.
            setTimeout(() => {
                input.dataset.busy = '0';
                input.disabled = false;
                refreshStatus();
                loadMining();
                loadApps();
                loadKassigner();
                loadProxies();
            }, 2500);
        }
    });
}

// --- collapse (wide screens) ---

function setCollapsed(collapsed) {
    const sidebar = $('sidebar');
    sidebar.classList.toggle('collapsed', collapsed);
    const toggle = $('sidebar-toggle');
    toggle.setAttribute('aria-expanded', String(!collapsed));
    toggle.setAttribute('aria-label', collapsed ? 'Expand sidebar' : 'Collapse sidebar');
    toggle.title = collapsed ? 'Expand sidebar' : 'Collapse sidebar';
    try {
        localStorage.setItem(SIDEBAR_KEY, collapsed ? 'collapsed' : 'expanded');
    } catch {
        /* private browsing; the preference just will not persist */
    }
}

$('sidebar-toggle').addEventListener('click', () => setCollapsed(!$('sidebar').classList.contains('collapsed')));

try {
    if (localStorage.getItem(SIDEBAR_KEY) === 'collapsed') setCollapsed(true);
} catch {
    /* no stored preference */
}

// --- drawer (narrow screens) ---

function openDrawer() {
    $('sidebar').classList.add('open');
    $('sidebar-scrim').hidden = false;
}
function closeDrawer() {
    $('sidebar').classList.remove('open');
    $('sidebar-scrim').hidden = true;
}

$('sidebar-open').addEventListener('click', openDrawer);
$('sidebar-scrim').addEventListener('click', closeDrawer);
document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') closeDrawer();
});
// Leaving the drawer width with the drawer "open" would strand the scrim.
window.addEventListener('resize', () => {
    if (!MOBILE()) closeDrawer();
});

// -------------------------------------------------------------- dashboard ---

let pollTimer = null;
const startPolling = () => {
    refreshStatus();
    if (!pollTimer) pollTimer = setInterval(refreshStatus, 4000);
};
const stopPolling = () => {
    clearInterval(pollTimer);
    pollTimer = null;
    setMiningPolling(false);
};

let lastStatus = null;
// The manager's process id for this run. A change means it restarted with
// different code underneath this tab.
let bootId = null;

/**
 * Reloads the page when the manager comes back as a different process, which is
 * what makes an edit under `dev.sh watch` appear without touching the browser,
 * and what stops a tab surviving a panel update from talking to an API it no
 * longer matches.
 *
 * It waits for a quiet moment first. Reloading out from under a half-typed form
 * or an open dialog would cost more than the staleness does, and the next poll
 * is four seconds away.
 */
function reloadIfManagerRestarted(id) {
    if (!id) return false;
    if (bootId === null) {
        bootId = id;
        return false;
    }
    if (id === bootId) return false;

    const typing = document.activeElement;
    const busy =
        document.querySelector('dialog[open]') ||
        (typing && ['INPUT', 'TEXTAREA', 'SELECT'].includes(typing.tagName));
    if (busy) return false;

    location.reload();
    return true;
}

async function refreshStatus() {
    let s;
    try {
        s = await api('/api/status');
    } catch {
        return;
    }
    if (reloadIfManagerRestarted(s.bootId)) return;
    lastStatus = s;

    const running = s.container.running;
    const synced = s.rpc.synced === true;

    // Progress comes from the server, which reconstructs it from kaspad's own
    // log. A blocks/headers ratio would read 0.0% for the entire header and
    // UTXO-set download and then jump, which is why it is not used here.
    const sync = s.sync;
    const pct = synced ? 100 : (sync?.percent ?? 0);

    $('sync-pct').textContent = running ? `${pct.toFixed(pct >= 100 ? 0 : 1)}%` : '–';
    $('sync-state').textContent = !running
        ? 'node stopped'
        : !s.rpc.reachable && !sync
          ? 'starting up, no answer from the node yet'
          : (sync?.label ?? 'starting up') + (sync?.estimated ? ' (estimated)' : '');
    $('sync-bar').style.width = `${pct}%`;
    $('sync-bar').classList.toggle('estimated', Boolean(sync?.estimated) && !synced);

    const detail = $('sync-detail');
    if (running && sync?.detail) {
        detail.hidden = false;
        detail.textContent = sync.detail;
    } else if (running && sync?.lastLine && !synced) {
        detail.hidden = false;
        detail.textContent = sync.lastLine;
    } else {
        detail.hidden = true;
    }

    renderSyncSteps(sync, synced, running);

    $('stat-blocks').textContent = fmtNum(s.rpc.dag?.blockCount);
    $('stat-headers').textContent = fmtNum(s.rpc.dag?.headerCount);
    $('stat-daa').textContent = fmtNum(s.rpc.dag?.virtualDaaScore);
    $('stat-diff').textContent = s.rpc.dag?.difficulty ? Number(s.rpc.dag.difficulty).toExponential(3) : '–';
    $('stat-mempool').textContent = fmtNum(s.rpc.info?.mempoolSize);

    const containerTag = $('stat-container');
    containerTag.textContent = s.container.status || 'absent';
    containerTag.className = `tag ${running ? 'ok' : 'off'}`;
    setNavSwitch('node', running);
    setNavHealth('kaspad', !running ? 'bad' : synced ? 'ok' : 'warn');
    $('stat-network').textContent = s.rpc.dag?.networkName || s.network;
    $('stat-version').textContent = s.version?.version || '–';
    $('stat-uptime').textContent = running ? fmtDuration(s.container.startedAt) : '–';
    $('stat-disk').textContent = fmtBytes(s.disk?.size);

    // Two facts share this one field, and neither can stand in for the other.
    // The size cannot say "switched off": absent bytes is also what a cold
    // start looks like while the disk walk is still filling its cache, so the
    // node's own answer decides first and the size only fills in the detail.
    // It matters now that the index is a setting rather than something the
    // entrypoint forced on -- a node running without one should say so.
    const utxo = $('stat-utxo');
    const utxoBytes = s.dataSplit?.utxoindexBytes;
    const indexed = s.rpc.info ? Boolean(s.rpc.info.isUtxoIndexed) : null;
    utxo.textContent =
        indexed === false
            ? 'disabled'
            : Number.isFinite(utxoBytes)
              ? fmtBytes(utxoBytes)
              : indexed
                ? 'enabled'
                : '–';
    utxo.classList.toggle('warn', indexed === false);
    renderPruning(s.pruning, running);

    $('stat-peers').textContent = fmtNum(s.peers.total);
    $('stat-peers-in').textContent = fmtNum(s.peers.inbound);
    $('stat-peers-out').textContent = fmtNum(s.peers.outbound);

    const verdict = $('p2p-verdict');
    if (s.p2pReachable === true) {
        verdict.className = 'verdict ok';
        verdict.textContent = `Your port is open. ${s.peers.inbound} peer${s.peers.inbound === 1 ? '' : 's'} connected in from outside.`;
    } else if (s.p2pReachable === false) {
        verdict.className = 'verdict bad';
        verdict.textContent = 'Nobody has connected in yet. Forward the P2P port on your router to go public. It can take a while after a restart, so give it time.';
    } else {
        verdict.className = 'verdict';
        verdict.textContent = 'Waiting for peer information…';
    }

    renderPorts(s);
    const bind = $('bind-address');
    if (document.activeElement !== bind && !bind.disabled) {
        const address = s.bindAddress || '0.0.0.0';
        // An address set by hand earlier is kept as an option rather than
        // silently switched to one of the two on the list.
        if (![...bind.options].some((o) => o.value === address)) {
            bind.add(new Option(`${address} (set manually)`, address));
        }
        bind.value = address;
    }
    applyNodeGating(s);
}

/**
 * Mining and KaChat only make sense against a node that is up and caught up:
 * a stratum server on a syncing node hands miners stale work, and the indexer
 * would index a chain that is not there. The server refuses to enable them too
 * -- this just stops the UI offering something it will reject.
 */
/**
 * Mining and the KaChat indexer both read the chain, so neither does anything
 * useful until the node is running and caught up.
 *
 * That used to be enforced by locking the sections: the nav item refused to
 * open, and opening one while the node fell behind threw you back to Kaspad
 * with a toast. Which meant somebody could not read what mining offered, or set
 * a difficulty, or point the indexer at a network, until after an overnight
 * sync -- decisions they might reasonably want to make while waiting for it.
 *
 * So the door is open and the room is labelled. A banner at the top of each
 * says what is missing and what that costs, settings can be read and changed,
 * and the one thing still held back is starting the service, which genuinely
 * cannot work yet.
 */
function applyNodeGating(status) {
    const ready = Boolean(status?.ready);
    lockReason = ready
        ? null
        : !status?.container?.exists
          ? 'The Kaspa node is not installed yet. Install it on the Kaspad page.'
          : !status?.container?.running
            ? 'The Kaspa node is not running yet. Start it on the Kaspad page.'
            : !status?.rpc?.reachable
              ? 'The Kaspa node is still starting up.'
              : 'The Kaspa node is still syncing. This service reads the chain, so it stays quiet until that finishes.';

    for (const service of ['mining', 'kachat']) {
        const input = navSwitch(service);
        if (input && input.dataset.busy !== '1') {
            input.disabled = !ready;
            const label = input.closest('.switch');
            if (label) label.title = ready ? `Start or stop ${SERVICE_NAMES[service]}` : lockReason;
        }
    }

    // Nothing is locked any more; the tabs say why instead.
    for (const item of document.querySelectorAll('.nav-item[data-requires-node]')) {
        item.classList.remove('locked');
        item.removeAttribute('aria-disabled');
        item.title = item.querySelector('.label').textContent;
    }

    for (const tab of ['mining', 'kachat']) renderNodeBanner(tab, ready);
}

/**
 * The banner. Sits above everything in the tab, including the sub-nav, so it is
 * read before anything it applies to.
 */
function renderNodeBanner(tab, ready) {
    const section = document.getElementById(`tab-${tab}`);
    if (!section) return;

    let banner = section.querySelector(':scope > .node-banner');
    if (ready) return banner?.remove();

    if (!banner) {
        banner = document.createElement('div');
        banner.className = 'notice node-banner';
        section.prepend(banner);
    }
    banner.innerHTML = `
      <p><strong>${escapeHtml(lockReason)}</strong></p>
      <p class="muted">
        Everything here can be read and changed while you wait. Nothing will run
        against the chain until the node is up and caught up.
      </p>`;
}

/**
 * Every port gets a switch, and on a fresh install nearly all of them are off:
 * the node starts with P2P and the panel's own wRPC-JSON channel bound, and
 * nothing published. Every port is listed whether it is on or off -- showing
 * only the enabled ones would remove a port's own row when you switched it off,
 * leaving no way to switch it back on.
 */
// The whole IBD sequence, so it is obvious what has finished, what is running
// now, and what is still to come -- rather than one number with no context.
const SYNC_STEPS = [
    ['connecting', 'Connecting to peers'],
    ['proof', 'Pruning point proof'],
    ['trusted', 'Trusted blocks'],
    ['smt', 'Commitment state'],
    ['headers', 'Block headers'],
    ['utxoset', 'UTXO set'],
    ['blocks', 'Blocks'],
];

function renderSyncSteps(sync, synced, running) {
    const list = $('sync-steps');
    if (!running) {
        list.innerHTML = '';
        return;
    }
    const currentIndex = synced ? SYNC_STEPS.length : SYNC_STEPS.findIndex(([key]) => key === sync?.phase);
    list.innerHTML = SYNC_STEPS.map(([key, label], i) => {
        const cls = synced || i < currentIndex ? 'done' : i === currentIndex ? 'current' : 'todo';
        const mark = cls === 'done' ? '✓' : cls === 'current' ? '•' : '';
        const pctHere = cls === 'current' && sync?.phasePercent != null ? ` ${sync.phasePercent}%` : '';
        return `<li class="${cls}"><span class="mark">${mark}</span>${escapeHtml(label)}${pctHere}</li>`;
    }).join('');
}

/**
 * Kaspad keeps about thirty hours of block data and throws the rest away in
 * twelve-hour steps, so "when is the next one" has an exact answer and this
 * shows it as a countdown. How much space it gives back does not have an exact
 * answer, so the manager measures it instead, and the wording says which of the
 * two you are looking at.
 */
function renderPruning(p, running) {
    const el = $('stat-pruning');
    if (!el) return;

    if (!running || !p?.known) {
        el.textContent = '–';
        el.title = running ? 'Waiting for the node to report its pruning point.' : '';
        return;
    }

    // How the size was arrived at decides how it is worded. Measured across a
    // real prune is a fact; the other two are estimates and are not dressed up
    // as anything more than that.
    const phrasing = {
        measured: (v) => `the last one freed ${v}`,
        growth: (v) => `frees about ${v}`,
        window: (v) => `frees roughly ${v}`,
    };
    const note = p.freed
        ? phrasing[p.freed.source](fmtByteCount(p.freed.bytes))
        : `drops ${fmtNum(p.blocksPerStep)} blocks (${p.stepHours} hours of history)`;

    el.innerHTML =
        `${escapeHtml(fmtCountdown(p.secondsUntil))} <span class="muted">· ${escapeHtml(note)}</span>`;

    const lines = [
        `Kaspad keeps roughly ${p.retentionHours} hours of full block data and drops the oldest ${p.stepHours} hours at a time.`,
        `Next step when the chain reaches blue score ${Math.round(p.firesAtBlueScore).toLocaleString()}, which is ${Math.round(p.blueScoreRemaining).toLocaleString()} away.`,
    ];
    lines.push(`It drops ${fmtNum(p.blocksPerStep)} blocks, one ${p.stepHours} hour step of history.`);
    if (p.freed?.source === 'window' && p.estimated) {
        lines.push(
            `Size estimated from the ${fmtByteCount(p.consensusBytes)} of block data currently held: ` +
                `${fmtNum(p.estimated.retainedBlocks)} blocks at about ${fmtByteCount(p.estimated.perBlock)} each. ` +
                `This reads a little high, because the window also holds things a prune does not remove.`,
        );
    }
    if (p.freed?.source === 'growth' && p.projected) {
        lines.push(
            `Size measured from ${fmtByteCount(p.projected.observedBytes)} of growth over the last ` +
                `${fmtCountdown(p.projected.observedSeconds).replace(/^in /, '')}, scaled to a full cycle. ` +
                `A settled node sheds each cycle what it took on, so the two match.`,
        );
    }
    if (p.measured) {
        lines.push(
            p.measured.freedBytes >= 0
                ? `Last prune took ${fmtByteCount(p.measured.freedBytes)} off the volume.`
                : `The volume read ${fmtByteCount(-p.measured.freedBytes)} larger just after the last prune, which happens when the database has not compacted the deleted blocks away yet.`,
        );
    }
    el.title = lines.join('\n');
}

function fmtByteCount(bytes) {
    const n = Math.abs(Number(bytes) || 0);
    if (n >= 1e9) return `${(n / 1e9).toFixed(n / 1e9 >= 10 ? 0 : 1)} GB`;
    if (n >= 1e6) return `${Math.round(n / 1e6)} MB`;
    if (n >= 1e3) return `${Math.round(n / 1e3)} KB`;
    return `${Math.round(n)} B`;
}

/**
 * Hours out, this is rounded to five minutes. The estimate is never that
 * precise, and a to-the-minute figure that shifts on every refresh reads like
 * something is wrong when nothing is.
 */
function fmtCountdown(seconds) {
    const s = Math.max(0, Math.round(Number(seconds) || 0));
    if (s < 60) return 'any moment now';
    if (s >= 86_400) {
        const days = Math.round(s / 86_400);
        return `in ${days} day${days === 1 ? '' : 's'}`;
    }
    // Inside the last hour the minutes matter, so they are not rounded away.
    if (s < 3600) {
        const mins = Math.round(s / 60);
        return mins >= 60 ? 'in 1h' : `in ${mins}m`;
    }
    let h = Math.floor(s / 3600);
    let m = Math.round((s % 3600) / 300) * 5;
    if (m === 60) {
        h += 1;
        m = 0;
    }
    return m ? `in ${h}h ${m}m` : `in ${h}h`;
}

function renderPorts(s) {
    const publishedSet = new Set(s.published.map((p) => (p.container || '').split('/')[0]));

    const sw = (p, axis, on, enabled, title) =>
        `<label class="switch" title="${escapeHtml(title)}">
           <input type="checkbox" data-port="${p.key}" data-axis="${axis}" ${on ? 'checked' : ''} ${enabled ? '' : 'disabled'}>
           <span class="track"></span>
         </label>`;

    $('ports-body').innerHTML = (s.portMatrix || [])
        .map((p) => {
            const live = publishedSet.has(String(p.port));
            const state = !p.listening
                ? { cls: 'off', text: 'not listening' }
                : !p.published
                  ? { cls: 'warn', text: 'listening, but only reachable from inside this machine' }
                  : live
                    ? { cls: 'ok', text: 'listening and reachable from outside' }
                    : { cls: '', text: 'applying…' };
            const listening = p.canToggleListening
                ? sw(p, 'listening', p.listening, true, p.listeningNote)
                : `<span class="locked" title="${escapeHtml(p.listeningNote)}">always</span>`;
            const title = `${p.name}: ${state.text}${p.required ? '. This is the one to forward on your router to be a public node.' : ''}`;
            return `<tr title="${escapeHtml(title)}">
      <td class="port"><span class="dot ${state.cls}"></span>${p.port}</td>
      <td>${escapeHtml(p.name)}${p.required ? ' <span class="tag">required</span>' : ''}</td>
      <td class="toggle">${listening}</td>
      <td class="toggle">${sw(p, 'published', p.published, true, p.note)}</td>
      <td><button class="ghost" data-portcheck="${p.port}" ${p.published ? '' : 'disabled'}>Test</button></td>
    </tr>`;
        })
        .join('');
}

// Flipping either switch restarts the node with that change applied.
$('ports-body').addEventListener('change', async (event) => {
    const { port: key, axis } = event.target.dataset ?? {};
    if (!key || !axis) return;
    const value = event.target.checked;
    event.target.disabled = true;
    try {
        const r = await api(`/api/ports/${key}`, { method: 'POST', body: { [axis]: value } });
        if (!r.unchanged) openConsole(`${key}: ${axis} ${value ? 'on' : 'off'}`);
    } catch (e) {
        // Put the switch back; the node was not changed.
        event.target.checked = !value;
        toast(e.message, 'bad');
    } finally {
        event.target.disabled = false;
    }
});

// Applies on selection, like the port switches beside it, rather than pairing
// a two-option list with an Apply button.
$('bind-address').addEventListener('change', async (event) => {
    const address = event.target.value;
    event.target.disabled = true;
    try {
        const r = await api('/api/ports/bind', { method: 'POST', body: { address } });
        if (!r.unchanged) openConsole(`Publishing ports on ${address}`);
    } catch (e) {
        toast(e.message, 'bad');
        refreshStatus();
    } finally {
        setTimeout(() => {
            event.target.disabled = false;
        }, 2500);
    }
});

document.addEventListener('click', async (event) => {
    const port = event.target.dataset?.portcheck;
    if (!port) return;
    event.target.disabled = true;
    event.target.textContent = 'Testing…';
    try {
        const r = await api(`/api/portcheck?port=${port}`);
        toast(`${r.ip}:${r.port} is ${r.open ? 'open' : 'closed'}. ${r.note}`, r.open ? 'good' : 'bad');
    } catch (e) {
        toast(e.message, 'bad');
    } finally {
        event.target.disabled = false;
        event.target.textContent = 'Test';
    }
});

for (const button of document.querySelectorAll('[data-node]')) {
    button.addEventListener('click', async () => {
        try {
            await api(`/api/node/${button.dataset.node}`, { method: 'POST' });
            openConsole(`Restarting the node`);
        } catch (e) {
            toast(e.message, 'bad');
        }
    });
}


// ---------------------------------------------------------------- updates ---

let latestRelease = null;

$('check-update').addEventListener('click', async () => {
    const status = $('update-status');
    status.className = 'update-status';
    status.textContent = 'Checking GitHub…';
    try {
        const r = await api('/api/update/check');
        latestRelease = r;
        $('upstream-repo').textContent = r.repo;
        $('apply-update').disabled = !r.updateAvailable || !r.hasLinuxAsset;

        if (r.updateAvailable) {
            status.className = 'update-status available';
            status.textContent = `${r.latest} is available (you run ${r.current || 'an unknown version'}).`;
            if (!r.hasLinuxAsset) {
                status.textContent += ' That release has no linux build attached, so it cannot be installed automatically.';
            }
        } else {
            status.className = 'update-status current';
            status.textContent = `You are up to date. Running ${r.current || '?'}, and that is the newest release.`;
        }
        if (r.notes) {
            $('release-notes').hidden = false;
            $('release-notes-body').textContent = r.notes;
        }
    } catch (e) {
        status.className = 'update-status';
        status.textContent = e.message;
    }
});

$('apply-update').addEventListener('click', async () => {
    if (!latestRelease) return;
    const ok = confirm(
        `Update kaspad to ${latestRelease.latest}?\n\n` +
            'The node will stop for a moment while the new version is installed. ' +
            'Your chain data is kept, so there is no resync.',
    );
    if (!ok) return;
    try {
        const r = await api('/api/update/apply', { method: 'POST', body: { version: latestRelease.latest } });
        if (r.alreadyCurrent) return toast('Already on the newest version.', 'good');
        openConsole(`Updating to ${latestRelease.latest}`);
        $('apply-update').disabled = true;
    } catch (e) {
        toast(e.message, 'bad');
    }
});

// --- release picker ---

/**
 * Which releases exist upstream, so a specific one can be installed rather than
 * only the newest. The node is built from a release archive, so this is the
 * equivalent of choosing a branch, and it is also how you go back to an older
 * version after a bad one.
 */
async function loadReleasePicker({ force = false } = {}) {
    const select = $('release-pick');
    try {
        const { releases } = await api(`/api/update/releases${force ? '?force=1' : ''}`);
        const stable = releases.filter((r) => !r.prerelease);
        const pre = releases.filter((r) => r.prerelease);
        const opts = (list) => list.map((r) => `<option value="${escapeHtml(r.tag)}">${escapeHtml(r.tag)}</option>`).join('');
        select.innerHTML =
            '<option value="">newest release</option>' +
            (stable.length ? `<optgroup label="Releases">${opts(stable)}</optgroup>` : '') +
            // Prereleases are separated rather than hidden: running one is a
            // deliberate act, not something to stumble into from a flat list.
            (pre.length ? `<optgroup label="Prereleases">${opts(pre)}</optgroup>` : '');
        return releases.length;
    } catch (e) {
        select.innerHTML = '<option value="">newest release</option>';
        throw e;
    }
}

$('release-pick').addEventListener('change', () => {
    $('install-release').disabled = !$('release-pick').value;
});

$('releases-scan').addEventListener('click', async () => {
    const button = $('releases-scan');
    button.disabled = true;
    try {
        const count = await loadReleasePicker({ force: true });
        toast(`${count} releases upstream.`);
    } catch (e) {
        toast(e.message, 'bad');
    } finally {
        button.disabled = false;
    }
});

$('install-release').addEventListener('click', async () => {
    const version = $('release-pick').value;
    if (!version) return;
    const running = latestRelease?.current;
    if (
        !confirm(
            `Install kaspad ${version}?\n\n` +
                (running ? `You are running ${running}. ` : '') +
                'The node stops for a moment while it is built. Your chain data is kept, so there is no resync.',
        )
    ) {
        return;
    }
    try {
        await api('/api/update/apply', { method: 'POST', body: { version } });
        openConsole(`Installing ${version}`);
        $('install-release').disabled = true;
    } catch (e) {
        toast(e.message, 'bad');
    }
});

// --------------------------------------------------------------- settings ---

let currentConfig = null;

const FLAGS = [
    'utxoindex',
    'archival',
    'unsaferpc',
    'perfMetrics',
    'disableUpnp',
    'noDnsSeed',
    'enableUnsyncedMining',
    'sanity',
    'noLogFiles',
];

async function loadSettings() {
    const r = await api('/api/config');
    currentConfig = r.config;
    const c = r.config;

    $('cfg-network').value = c.network;

    for (const flag of FLAGS) $(`cfg-flag-${flag}`).checked = Boolean(c.flags[flag]);

    $('cfg-loglevel').value = c.tuning.logLevel;
    $('cfg-outpeers').value = c.tuning.outpeers;
    $('cfg-maxinpeers').value = c.tuning.maxinpeers;
    $('cfg-rpcmaxclients').value = c.tuning.rpcmaxclients;
    $('cfg-maxtracked').value = c.tuning.maxTrackedAddresses;
    $('cfg-ramscale').value = c.tuning.ramScale;
    $('cfg-retention').value = c.tuning.retentionPeriodDays ?? '';
    $('cfg-asyncthreads').value = c.tuning.asyncThreads ?? '';

    $('cfg-externalip').value = c.peering.externalip;
    $('cfg-uacomment').value = c.peering.uacomment;
    $('cfg-addpeers').value = (c.peering.addPeers || []).join('\n');
    $('cfg-connectpeers').value = (c.peering.connectPeers || []).join('\n');
    $('cfg-extraargs').value = (c.extraArgs || []).join('\n');

    networksMeta = r.networks;
    $('args-preview').textContent = r.argsPreview.join(' \\\n  ');
}

let networksMeta = null;

const lines = (id) =>
    $(id)
        .value.split('\n')
        .map((v) => v.trim())
        .filter(Boolean);

function collectConfig() {
    const flags = {};
    for (const flag of FLAGS) flags[flag] = $(`cfg-flag-${flag}`).checked;
    return {
        network: $('cfg-network').value,
        // Owned by the Ports card, which applies immediately; pass the current
        // values straight through so saving settings cannot revert them.
        services: { ...currentConfig.services },
        expose: { ...currentConfig.expose },
        flags,
        tuning: {
            logLevel: $('cfg-loglevel').value,
            outpeers: $('cfg-outpeers').value,
            maxinpeers: $('cfg-maxinpeers').value,
            rpcmaxclients: $('cfg-rpcmaxclients').value,
            maxTrackedAddresses: $('cfg-maxtracked').value,
            ramScale: $('cfg-ramscale').value,
            retentionPeriodDays: $('cfg-retention').value,
            asyncThreads: $('cfg-asyncthreads').value,
            rocksdbPreset: currentConfig?.tuning?.rocksdbPreset ?? '',
        },
        peering: {
            externalip: $('cfg-externalip').value,
            uacomment: $('cfg-uacomment').value,
            addPeers: lines('cfg-addpeers'),
            connectPeers: lines('cfg-connectpeers'),
        },
        extraArgs: lines('cfg-extraargs'),
    };
}

$('settings-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    const err = $('settings-error');
    err.hidden = true;
    try {
        await api('/api/config', { method: 'PUT', body: { config: collectConfig() } });
        openConsole('Applying node configuration');
        setTimeout(loadSettings, 1500);
    } catch (e) {
        err.textContent = e.message;
        err.hidden = false;
    }
});

$('settings-reset').addEventListener('click', () => loadSettings());

// ----------------------------------------------------------------- mining ---

let miningConfig = null;
let miningTimer = null;
let miningPublicIp = null;
let miningLan = null;
let miningExtraSubnets = null;

// Worker hashrate arrives in GH/s (the bridge's own unit).
function fmtHashrate(ghs) {
    const n = Number(ghs);
    if (!Number.isFinite(n) || n <= 0) return '0';
    const units = ['GH/s', 'TH/s', 'PH/s', 'EH/s'];
    let value = n;
    let unit = 0;
    while (value >= 1000 && unit < units.length - 1) {
        value /= 1000;
        unit++;
    }
    return `${value.toFixed(value < 10 ? 2 : value < 100 ? 1 : 0)} ${units[unit]}`;
}

// The node's network hashrate is a raw hashes/second count, not GH/s.
function fmtRawHashrate(hs) {
    const n = Number(hs);
    if (!Number.isFinite(n) || n <= 0) return '–';
    return fmtHashrate(n / 1e9);
}

function fmtSeconds(secs) {
    const n = Number(secs);
    if (!Number.isFinite(n) || n <= 0) return '–';
    const d = Math.floor(n / 86400);
    const h = Math.floor((n % 86400) / 3600);
    const m = Math.floor((n % 3600) / 60);
    if (d) return `${d}d ${h}h`;
    if (h) return `${h}h ${m}m`;
    if (m) return `${m}m`;
    return `${Math.floor(n)}s`;
}

function renderInstances(instances) {
    $('instances-body').innerHTML = instances
        .map(
            (inst, i) => `<tr data-i="${i}">
      <td><input type="number" class="inst-port" min="1024" max="65535" value="${inst.stratumPort}"></td>
      <td><input type="number" class="inst-diff" min="1" value="${inst.minShareDiff}"></td>
      <td style="text-align:center"><input type="checkbox" class="inst-pub" ${inst.publish !== false ? 'checked' : ''}></td>
      <td><button type="button" class="ghost danger inst-del" title="Remove">×</button></td>
    </tr>`,
        )
        .join('');
}

function collectInstances() {
    return [...document.querySelectorAll('#instances-body tr')].map((row) => ({
        stratumPort: Number(el('.inst-port', row).value),
        minShareDiff: Number(el('.inst-diff', row).value),
        publish: el('.inst-pub', row).checked,
    }));
}

$('instance-add').addEventListener('click', () => {
    const next = collectInstances();
    const highest = next.reduce((max, i) => Math.max(max, i.stratumPort || 0), 5554);
    next.push({ stratumPort: highest + 1, minShareDiff: 512, publish: true });
    renderInstances(next);
});

$('instances-body').addEventListener('click', (event) => {
    if (!event.target.classList.contains('inst-del')) return;
    const rows = collectInstances();
    if (rows.length <= 1) return toast('At least one stratum port is required.', 'bad');
    const index = Number(event.target.closest('tr').dataset.i);
    renderInstances(rows.filter((_, i) => i !== index));
});

async function loadMining() {
    const r = await api('/api/mining');
    miningConfig = r.config;
    miningPublicIp = r.publicIp;
    miningLan = r.lan;
    miningExtraSubnets = r.extraSubnets ?? '';
    const c = r.config;

    $('mining-vardiff').checked = c.varDiff;
    $('mining-spm').value = c.sharesPerMin;
    $('mining-pow2').checked = c.pow2Clamp;
    $('mining-vdstats').checked = c.varDiffStats;
    $('mining-extranonce').value = c.extranonceSize;
    $('mining-blockwait').value = c.blockWaitTimeMs;
    $('mining-tag').value = c.coinbaseTagSuffix;
    $('mining-logfile').checked = c.logToFile;
    $('mining-dash').checked = c.publishDashboard;
    renderInstances(c.instances);

    const blockers = $('mining-blockers');
    blockers.hidden = !r.blockers.length;
    blockers.textContent = r.blockers.join(' ');

    renderMiningState(r.container, r.stats);
    // Same release as the node, so a mismatch here means an update only got
    // half way. Blank when mining is off and there is no container to ask.
    $('mining-version').textContent = r.version || '';
    renderStratumTargets(c);
    renderEconomics(r);
    setNavSwitch('mining', c.enabled);
    setNavHealth('mining', !c.enabled ? 'off' : r.container?.running ? 'ok' : 'bad');
}

function renderMiningState(container, stats) {
    const badge = $('mining-state');
    const running = container?.running;
    badge.textContent = !miningConfig?.enabled ? 'off' : running ? 'running' : container?.status || 'stopped';
    badge.className = `tag ${!miningConfig?.enabled ? 'off' : running ? 'ok' : ''}`;

    const on = Boolean(miningConfig?.enabled);
    $('mining-live').hidden = !on;
    $('mining-workers-card').hidden = !on;
    $('mining-blocks-card').hidden = !on;
    if (!on) return;

    if (!stats || !stats.reachable) {
        $('m-unreachable').hidden = false;
        $('m-unreachable').textContent = running
            ? 'Starting up. Numbers will appear once it has connected to the node.'
            : 'The bridge container is not running.';
        return;
    }
    $('m-unreachable').hidden = true;

    const s = stats.summary;
    $('m-hashrate').textContent = fmtHashrate(s.poolHashrate);
    $('m-workers').textContent = fmtNum(s.activeWorkers);
    $('m-blocks').textContent = fmtNum(s.totalBlocks);
    $('m-shares').textContent = fmtNum(s.totalShares);
    $('m-nethash').textContent = fmtRawHashrate(s.networkHashrate);
    $('m-netdiff').textContent = s.networkDifficulty ? Number(s.networkDifficulty).toExponential(3) : '–';
    $('m-uptime').textContent = fmtSeconds(s.bridgeUptime);

    renderWorkers(stats.workers);
    renderBlocks(stats.blocks);
}

/**
 * Ten columns never fit beside the blocks table, and scrolling sideways to read
 * a worker's own stats is worse than a denser row. Nothing is dropped: status
 * became the dot on the name, the wallet moved to the row's tooltip where it
 * was truncated anyway, and stale and invalid sit under the share count they
 * describe.
 */
function renderWorkers(workers) {
    if (!workers.length) {
        $('workers-body').innerHTML =
            '<tr><td colspan="6" class="empty">No miners connected yet. Point one at a stratum port, see Connect Your Miner.</td></tr>';
        return;
    }
    $('workers-body').innerHTML = workers
        .map((w) => {
            const status = w.status || 'offline';
            const bad = (Number(w.stale) || 0) + (Number(w.invalid) || 0);
            const title =
                `${w.worker || 'worker'} is ${status}` +
                (w.wallet ? `\nPaying ${w.wallet}` : '') +
                `\n${fmtNum(w.stale)} stale, ${fmtNum(w.invalid)} invalid`;
            return `<tr title="${escapeHtml(title)}">
        <td class="name"><span class="dot ${status === 'online' ? 'ok' : status === 'idle' ? 'warn' : ''}"></span>${escapeHtml(w.worker || '–')}</td>
        <td>${fmtHashrate(w.hashrate)}</td>
        <td>${w.currentDifficulty ? fmtNum(Math.round(w.currentDifficulty)) : '–'}</td>
        <td>${fmtNum(w.shares)}${bad ? `<small class="sub">${fmtNum(bad)} bad</small>` : ''}</td>
        <td>${fmtNum(w.blocks)}</td>
        <td>${fmtSeconds(w.sessionUptime)}</td>
      </tr>`;
        })
        .join('');
}

function renderBlocks(blocks) {
    if (!blocks.length) {
        $('blocks-body').innerHTML = '<tr><td colspan="4" class="empty">No blocks found yet.</td></tr>';
        return;
    }
    $('blocks-body').innerHTML = blocks
        .slice(0, 25)
        .map(
            (b) => `<tr>
      <td class="name">${escapeHtml(b.timestamp || '–')}</td>
      <td class="name">${escapeHtml(b.worker || '–')}</td>
      <td>${escapeHtml(b.bluescore || '–')}</td>
      <td><span class="trunc" title="${escapeHtml(b.hash || '')}">${escapeHtml(b.hash || '–')}</span></td>
    </tr>`,
        )
        .join('');
}

// A miner needs the address of the machine it can actually route to: the LAN
// address on your own network, the public one from outside. Showing only the
// public IP sent people to an address their ASIC usually cannot reach.
function stratumRow(port, host, diff, note) {
    const url = `stratum+tcp://${host}:${port}`;
    return `<tr>
      <td class="port">${port}</td>
      <td>
        <span class="copyable">
          <code>${escapeHtml(url)}</code>
          <button type="button" class="copy-btn" data-copy="${escapeHtml(url)}">Copy</button>
        </span>
      </td>
      <td>starts at difficulty ${fmtNum(diff)}</td>
      <td>${note}</td>
    </tr>`;
}

const fmtKas = (n) =>
    !Number.isFinite(n) || n <= 0
        ? '0'
        : n >= 1000
          ? Math.round(n).toLocaleString()
          : n >= 1
            ? n.toFixed(2)
            : n.toFixed(4);

function fmtDaysUntil(seconds) {
    const days = seconds / 86_400;
    if (days >= 2) return `in ${Math.round(days)} days`;
    const hours = seconds / 3600;
    if (hours >= 2) return `in ${Math.round(hours)} hours`;
    return `in ${Math.max(1, Math.round(seconds / 60))} minutes`;
}

let lastEconomics = null;

/** Block reward, the next reduction, and what today's rate would pay. */
const trimKas = (kas) => kas.toFixed(8).replace(/0+$/, '').replace(/\.$/, '');

/**
 * The reward sits with the other live figures now. Two numbers earn a place
 * there: what a block pays, and what it drops to next. The emission rate, the
 * month index and the DAA score were detail nobody needs at a glance, so they
 * moved to the tooltip.
 */
function renderEconomics(r) {
    lastEconomics = r;
    const reward = r.reward;
    if (!reward) {
        $('m-reward').textContent = '–';
        $('m-next-reward').textContent = '–';
        return;
    }

    $('m-reward').textContent = `${trimKas(reward.currentKas)} KAS`;

    const next = reward.next;
    $('m-next-reward').textContent = `${trimKas(next.kas)} KAS ${fmtDaysUntil(next.secondsUntil)}`;
    $('m-next-reward').title =
        `A ${next.dropPercent.toFixed(2)}% drop, at DAA score ${next.daaScore.toLocaleString()}. ` +
        `The network pays ${(reward.currentKas * reward.blocksPerSecond).toFixed(2)} KAS/s across ${reward.blocksPerSecond} blocks a second.`;

    renderProjection(r.projection, r.networkHashrate);
}

function renderProjection(p, net) {
    if (!p) return;
    // Do not fight the user while they are typing a what-if figure.
    if (document.activeElement !== $('earn-hashrate')) {
        const unit = Number($('earn-unit').value);
        $('earn-hashrate').value = p.hashrate ? (p.hashrate / unit).toFixed(3).replace(/\.?0+$/, '') : '';
    }

    const byMonths = Object.fromEntries((p.horizons ?? []).map((h) => [h.months, h.kas]));
    $('earn-day').textContent = fmtKas(p.perDayKas ?? 0);
    $('earn-1').textContent = fmtKas(byMonths[1] ?? 0);
    $('earn-6').textContent = fmtKas(byMonths[6] ?? 0);
    $('earn-12').textContent = fmtKas(byMonths[12] ?? 0);

    // Say plainly whether these numbers come from real miners or a typed
    // what-if, and do not offer a button that would fill in a zero.
    const hasMeasured = Number(p.measured) > 0;
    const usingMeasured = hasMeasured && !p.hypothetical;
    const source = $('earn-source');
    source.textContent = usingMeasured ? 'from your miners' : p.hashrate > 0 ? 'what-if' : 'no hashrate';
    source.className = `tag ${usingMeasured ? 'ok' : 'off'}`;

    const reset = $('earn-reset');
    reset.disabled = !hasMeasured || usingMeasured;
    reset.title = !hasMeasured
        ? 'No miners are connected, so there is no measured hashrate to use.'
        : usingMeasured
          ? 'Already showing your miners\' reported hashrate.'
          : 'Put your miners\' reported hashrate back in the box.';

    $('earn-share').textContent = p.share > 0 ? `${(p.share * 100).toPrecision(3)}%` : '–';
    $('earn-nethash').textContent = net?.value
        ? `${fmtRawHashrate(net.value)}${net.source ? ` (from the ${net.source})` : ''}`
        : 'unknown';
    $('earn-drag').textContent = p.decayDragPercent
        ? `${p.decayDragPercent.toFixed(1)}% less over a year than a flat reward`
        : '–';

    $('earn-note').textContent =
        p.hypothetical || (!p.measured && p.hashrate)
            ? "Based on the hashrate you typed in. This is what you would earn if difficulty and the reward stayed where they are today, with the monthly drops taken into account. It is not a prediction, and it says nothing about price."
            : p.measured
              ? "Based on what your miners are actually reporting. This is what you would earn if difficulty and the reward stayed where they are today, with the monthly drops taken into account. It is not a prediction, and it says nothing about price."
              : 'No miners are connected yet. Type a hashrate above to see what it would earn.';
}

async function refreshProjection(hashrate) {
    try {
        const query = hashrate === null ? '' : `?hashrate=${encodeURIComponent(hashrate)}`;
        const r = await api(`/api/mining/projection${query}`);
        renderEconomics(r);
    } catch (e) {
        toast(e.message, 'bad');
    }
}

const recalcProjection = () => {
    const value = Number($('earn-hashrate').value);
    const unit = Number($('earn-unit').value);
    if (!Number.isFinite(value) || value < 0) return;
    refreshProjection(value * unit);
};

$('earn-hashrate').addEventListener('input', debounce(recalcProjection, 400));
$('earn-unit').addEventListener('change', recalcProjection);
$('earn-reset').addEventListener('click', () => refreshProjection(null));

function renderStratumTargets(cfg) {
    const lanIp = miningLan?.ip;
    $('connect-lan-ip').textContent = lanIp ?? 'this machine';
    // Kept so the preset list can point out that this one is already covered.
    ownSubnet = lanIp ? `${lanIp.split('.').slice(0, 3).join('.')}.0/24` : null;
    $('scan-own').textContent = ownSubnet ?? 'unknown';
    if (document.activeElement !== $('scan-extra') && miningExtraSubnets !== null) {
        $('scan-extra').value = miningExtraSubnets;
    }

    $('stratum-local').innerHTML = cfg.instances
        .map((inst) =>
            stratumRow(
                inst.stratumPort,
                lanIp ?? 'this-machine-ip',
                inst.minShareDiff,
                lanIp ? '<span class="tag ok">ready</span>' : '<span class="tag">LAN address unknown</span>',
            ),
        )
        .join('');

    $('stratum-public').innerHTML = cfg.instances
        .map((inst) =>
            stratumRow(
                inst.stratumPort,
                miningPublicIp ?? 'your-public-ip',
                inst.minShareDiff,
                inst.publish
                    ? '<span class="tag">needs port forwarded</span>'
                    : '<span class="tag off">port not published</span>',
            ),
        )
        .join('');
}

// Copy needs a secure context. The panel is on 127.0.0.1 so it normally has
// one, but over plain http on a LAN address it does not -- hence the fallback.
async function copyText(text) {
    try {
        if (navigator.clipboard && window.isSecureContext) {
            await navigator.clipboard.writeText(text);
            return true;
        }
    } catch {
        /* fall through */
    }
    const scratch = document.createElement('textarea');
    scratch.value = text;
    scratch.setAttribute('readonly', '');
    scratch.style.cssText = 'position:fixed;top:-1000px';
    document.body.appendChild(scratch);
    scratch.select();
    let ok = false;
    try {
        ok = document.execCommand('copy');
    } catch {
        ok = false;
    }
    scratch.remove();
    return ok;
}

document.addEventListener('click', async (event) => {
    const text = event.target.dataset?.copy;
    if (!text) return;
    const button = event.target;
    const ok = await copyText(text);
    button.textContent = ok ? 'Copied' : 'Select it';
    button.classList.toggle('copied', ok);
    if (!ok) toast('Could not copy for you. Select the address and copy it yourself.', 'bad');
    setTimeout(() => {
        button.textContent = 'Copy';
        button.classList.remove('copied');
    }, 1600);
});

// --- LAN scan ---

let lastScan = null;

/**
 * Only miners are listed. A sweep turns up routers, printers and whatever else
 * answers on port 80, and none of that is what someone came here for. The
 * others are counted, not listed, so it is still obvious the scan worked, and
 * "show everything" is there for the case that matters: a miner this does not
 * recognise yet.
 */
function renderScan() {
    const r = lastScan;
    if (!r) return;
    const showAll = $('scan-show-all').checked;
    const answered = r.devices.filter((d) => !d.self);
    const miners = answered.filter((d) => d.likelyMiner);
    const shown = showAll ? answered : miners;
    const others = answered.length - miners.length;

    const found = miners.length
        ? `Found ${miners.length} miner${miners.length === 1 ? '' : 's'}.`
        : 'No miners found.';
    const rest = others ? ` ${others} other device${others === 1 ? '' : 's'} answered.` : '';
    $('scan-note').textContent =
        `Checked ${r.scanned.toLocaleString()} addresses in ${r.subnets.join(', ')}. ${found}${rest}`;

    $('scan-results').innerHTML = shown.length
        ? shown
              .map((d) => {
                  const what = d.vendor
                      ? `<span class="tag ok">${escapeHtml(d.vendor)}</span>`
                      : d.connectedToBridge
                        ? '<span class="tag ok">mining here</span>'
                        : d.likelyMiner
                          ? '<span class="tag">looks like a miner</span>'
                          : '<span class="tag off">not a miner</span>';
                  const link = d.ports.includes(80)
                      ? `<a href="http://${d.ip}${d.path && d.path !== '/' ? d.path : ''}" target="_blank" rel="noreferrer noopener">${
                            d.vendor ? `open ${escapeHtml(d.vendor)} ↗` : 'open its page ↗'
                        }</a>`
                      : '<span class="muted">no web page</span>';
                  const seen = d.title ? escapeHtml(d.title) : d.server ? escapeHtml(d.server) : '';
                  return `<tr>
          <td class="port">${escapeHtml(d.ip)}</td>
          <td>${link}</td>
          <td>${what}</td>
          <td class="muted">${seen}${seen ? ' · ' : ''}ports ${d.ports.join(', ')}</td>
        </tr>`;
              })
              .join('')
        : `<tr><td colspan="4" class="empty">${
              others
                  ? 'No miners here. Tick “show everything” if your miner is on this network but not being recognised.'
                  : 'Nothing answered. If your miner is on another network, add it above.'
          }</td></tr>`;
}

let ownSubnet = null;

$('scan-show-all').addEventListener('change', renderScan);

/**
 * The preset list adds to the box rather than replacing it, so several ranges
 * can be picked in a row, and anything typed by hand survives. The field stays
 * free-form because the list can only ever cover the common cases.
 */
$('scan-preset').addEventListener('change', (event) => {
    const range = event.target.value;
    event.target.selectedIndex = 0;
    if (!range) return;

    const box = $('scan-extra');
    const already = box.value.split(/[\s,]+/).filter(Boolean);
    if (already.includes(range)) {
        toast(`${range} is already in the list.`);
        return;
    }
    // The machine's own network is always swept, so adding it would only make
    // the scan look like it covered more than it did.
    if (ownSubnet && range === ownSubnet) {
        toast('That is this machine\'s own network, which is always scanned.');
        return;
    }
    box.value = [...already, range].join(', ');
    box.focus();
});

$('miner-scan').addEventListener('click', async () => {
    const button = $('miner-scan');
    button.disabled = true;
    $('scan-note').textContent = 'Looking…';
    $('scan-results').innerHTML = '';
    try {
        lastScan = await api('/api/mining/scan', {
            method: 'POST',
            body: { extraSubnets: $('scan-extra').value.trim() },
        });
        miningExtraSubnets = lastScan.extraSubnets ?? '';
        if (lastScan.problems?.length) toast(lastScan.problems[0], 'bad');
        renderScan();
    } catch (e) {
        $('scan-note').textContent = '';
        toast(e.message, 'bad');
    } finally {
        button.disabled = false;
    }
});

/** Everything the Settings sub-tab owns, without the on/off state. */
function collectMiningConfig() {
    return {
        // Carried through from what is loaded; the switch lives in the sidebar.
        enabled: Boolean(miningConfig?.enabled),
        instances: collectInstances(),
        varDiff: $('mining-vardiff').checked,
        sharesPerMin: $('mining-spm').value,
        varDiffStats: $('mining-vdstats').checked,
        pow2Clamp: $('mining-pow2').checked,
        extranonceSize: $('mining-extranonce').value,
        blockWaitTimeMs: $('mining-blockwait').value,
        coinbaseTagSuffix: $('mining-tag').value,
        logToFile: $('mining-logfile').checked,
        publishDashboard: $('mining-dash').checked,
    };
}

$('mining-save').addEventListener('click', async () => {
    const err = $('mining-settings-error');
    err.hidden = true;
    try {
        await api('/api/mining', { method: 'PUT', body: { config: collectMiningConfig() } });
        openConsole('Applying mining settings');
        setTimeout(loadMining, 2000);
    } catch (e) {
        err.textContent = e.message;
        err.hidden = false;
    }
});

for (const button of document.querySelectorAll('[data-bridge]')) {
    button.addEventListener('click', async () => {
        try {
            await api(`/api/mining/${button.dataset.bridge}`, { method: 'POST' });
            openConsole(`${button.dataset.bridge} stratum bridge`);
        } catch (e) {
            toast(e.message, 'bad');
        }
    });
}

async function refreshMiningStats() {
    if (!miningConfig?.enabled) return;
    try {
        const [stats, state] = await Promise.all([api('/api/mining/stats'), api('/api/mining')]);
        renderMiningState(state.container, stats.enabled ? stats : null);
    } catch {
        /* transient; the next tick retries */
    }
}

// Only poll while the tab is actually being looked at.
function setMiningPolling(active) {
    clearInterval(miningTimer);
    miningTimer = null;
    if (active) {
        refreshMiningStats();
        miningTimer = setInterval(refreshMiningStats, 5000);
    }
}

// ------------------------------------------------------------------- apps ---

let appsState = null;

async function loadApps() {
    const r = await api('/api/apps');
    appsState = r;
    const c = r.config;

    // --- KaChat ---
    $('kachat-ref').value = c.kachat.ref;
    $('kachat-network').value = c.kachat.network;
    $('kachat-pub-api').checked = c.kachat.publish.api;
    $('kachat-pub-chat').checked = c.kachat.publish.chat;
    renderAppState('kachat', r.apps.kachat);

    // --- KaChat Desktop ---
    // Defaults here as well as on the server. This whole function is one long
    // sequence of assignments, so a single missing key used to throw and leave
    // every field below it unpopulated, which the next save then posted back as
    // empty values. Nothing in here should be able to do that again.
    $('desktop-ref').value = c.desktop?.ref ?? 'main';
    $('desktop-port').value = c.desktop?.hostPort ?? 5173;
    renderAppState('desktop', r.apps.desktop);

    // --- Nextcloud ---
    $('nextcloud-ref').value = c.nextcloud.ref;
    $('nextcloud-pub-web').checked = c.nextcloud.publish.web;
    $('nextcloud-port').value = c.nextcloud.hostPort;
    $('nextcloud-user').value = c.nextcloud.adminUser;
    $('nextcloud-domains').value = c.nextcloud.trustedDomains;
    renderAppState('nextcloud', r.apps.nextcloud);
    loadNextcloudAdmin();
    loadRefPickers();
    setNavSwitch('kachat', c.kachat.enabled);
    setNavSwitch('desktop', c.desktop.enabled);
    setNavSwitch('nextcloud', c.nextcloud.enabled);
    for (const [app, tab] of [['kachat', 'kachat'], ['desktop', 'desktop'], ['nextcloud', 'nextcloud']]) {
        const running = Boolean(r.apps[app]?.container?.running);
        setNavHealth(tab, !c[app]?.enabled ? 'off' : running ? 'ok' : 'bad');
    }
}

/**
 * The message for an app that is switched on but has no container. Saying
 * "starting up" is right while it is still working and wrong once it has given
 * up, and a build that fails leaves exactly that second state behind, so the
 * outcome of the last attempt is what decides which one you get.
 */
function startFailure(state) {
    if (state.lastRun?.ok !== false) return null;
    const reason = (state.lastRun.error || '').trim();
    return `Could not start. ${reason ? `${reason} ` : ''}The full output is under All logs; switching it off and on again retries.`;
}

function renderAppState(name, state) {
    const badge = $(`${name}-state`);
    const running = state.container?.running;
    const enabled = Boolean(appsState.config?.[name]?.enabled);
    badge.textContent = !enabled ? 'off' : running ? 'running' : state.container?.status || 'stopped';
    badge.className = `tag ${!enabled ? 'off' : running ? 'ok' : ''}`;

    const notice = $(`${name}-notice`);
    if (state.blockers?.length) {
        notice.hidden = false;
        notice.className = 'verdict bad';
        notice.textContent = state.blockers.join(' ');
    } else {
        notice.hidden = true;
    }

    if (name === 'kachat') {
        if (enabled && !running && !state.blockers?.length) {
            notice.hidden = false;
            const failure = startFailure(state);
            notice.className = failure ? 'verdict bad' : 'verdict';
            notice.textContent =
                failure ??
                'Starting up. The first build compiles the indexer from source, which takes a while. You can watch it under All logs.';
        }

        const build = $('kachat-build');
        build.textContent = state.build?.sha
            ? `Built from ${String(state.build.sha).slice(0, 7)} on ${new Date(state.build.builtAt).toLocaleString()}`
            : 'Not built yet.';
    }

    if (name === 'nextcloud') {
        const link = $('nextcloud-link');
        const cfg = appsState.config.nextcloud;
        if (enabled && running && cfg.publish.web) {
            const url = `http://${location.hostname}:${cfg.hostPort}`;
            link.hidden = false;
            link.className = 'verdict ok';
            link.innerHTML = `<a href="${url}" target="_blank" rel="noreferrer noopener">${escapeHtml(url)} ↗</a>`;
        } else if (enabled && running) {
            link.hidden = false;
            link.className = 'verdict';
            link.textContent =
                'Running, but not published on the host. Reach it through a proxy host, or tick "Publish on the host" under Settings.';
        } else {
            const failure = enabled ? startFailure(state) : null;
            link.hidden = false;
            link.className = failure ? 'verdict bad' : 'verdict';
            link.textContent = failure ?? (enabled ? 'Starting up…' : 'Not running. Switch it on above.');
        }

        const build = $('nextcloud-build');
        build.textContent = state.build?.sha
            ? `Built from ${String(state.build.sha).slice(0, 7)} on ${new Date(state.build.builtAt).toLocaleString()}`
            : 'Not built yet.';
    }

    if (name === 'desktop') {
        const link = $('desktop-link');
        const cfg = appsState.config.desktop;
        link.hidden = false;
        if (enabled && running) {
            // location.hostname rather than localhost: the panel is often open
            // from another machine on the LAN, and localhost would send that
            // browser to itself.
            const url = `http://${location.hostname}:${cfg.hostPort}`;
            link.className = 'verdict ok';
            link.innerHTML = `<a href="${url}" target="_blank" rel="noreferrer noopener">${escapeHtml(url)} ↗</a>`;
        } else {
            const failure = enabled ? startFailure(state) : null;
            link.className = failure ? 'verdict bad' : 'verdict';
            link.textContent =
                failure ??
                (enabled
                    ? 'Starting up. The first build installs the app dependencies, which takes a few minutes.'
                    : 'Not running. Switch it on in the sidebar.');
        }

        const build = $('desktop-build');
        build.textContent = state.build?.sha
            ? `Built from ${String(state.build.sha).slice(0, 7)} on ${new Date(state.build.builtAt).toLocaleString()}`
            : 'Not built yet.';
    }
}

// --- branch pickers ---

// Git forbids ".." in a ref name, so this can never collide with a real one.
// A control character would also be unique, but it does not survive being
// written into an attribute and read back, which made the option select itself
// and then save its own placeholder as the branch.
const REF_CUSTOM = '..custom';

/** The ref an app should track: the chosen branch, or a typed one. */
function appRef(name) {
    const select = $(`${name}-ref`);
    if (select.value === REF_CUSTOM) return $(`${name}-ref-custom`).value.trim() || 'main';
    return select.value.trim() || 'main';
}

/**
 * Fills a branch picker from whatever the repository actually has.
 *
 * The configured ref is always present as an option even when the scan did not
 * return it: it might be a commit, a tag that was not listed, or a branch that
 * has since been deleted. Dropping it would silently retarget the app on the
 * next save.
 */
function fillRefPicker(name, refs, current) {
    const select = $(`${name}-ref`);
    const groups = [];
    if (refs?.branches?.length) {
        groups.push(`<optgroup label="Branches">${refs.branches.map(opt).join('')}</optgroup>`);
    }
    if (refs?.tags?.length) {
        groups.push(`<optgroup label="Tags">${refs.tags.slice(0, 50).map(opt).join('')}</optgroup>`);
    }
    const known = [...(refs?.branches ?? []), ...(refs?.tags ?? [])];
    if (current && !known.includes(current)) {
        groups.unshift(`<optgroup label="In use">${opt(current)}</optgroup>`);
    }
    groups.push(`<option value="${REF_CUSTOM}">Something else…</option>`);
    select.innerHTML = groups.join('');
    select.value = current ?? 'main';
    toggleRefCustom(name);
}

const opt = (v) => `<option value="${escapeHtml(v)}">${escapeHtml(v)}</option>`;

function toggleRefCustom(name) {
    $(`${name}-ref-custom-row`).hidden = $(`${name}-ref`).value !== REF_CUSTOM;
}

for (const name of ['kachat', 'desktop', 'nextcloud']) {
    $(`${name}-ref`).addEventListener('change', () => {
        toggleRefCustom(name);
        if ($(`${name}-ref`).value === REF_CUSTOM) $(`${name}-ref-custom`).focus();
    });

    $(`${name}-refs-scan`).addEventListener('click', async () => {
        const button = $(`${name}-refs-scan`);
        button.disabled = true;
        try {
            const refs = await api(`/api/apps/${name}/refs?force=1`);
            fillRefPicker(name, refs, appsState?.config?.[name]?.ref);
            toast(`${refs.branches.length} branch${refs.branches.length === 1 ? '' : 'es'} on ${refs.repo}.`);
        } catch (e) {
            toast(e.message, 'bad');
        } finally {
            button.disabled = false;
        }
    });
}

/** Loads the pickers from cache when the apps page does. */
async function loadRefPickers() {
    for (const name of ['kachat', 'desktop', 'nextcloud']) {
        const current = appsState?.config?.[name]?.ref ?? 'main';
        try {
            fillRefPicker(name, await api(`/api/apps/${name}/refs`), current);
        } catch {
            // Offline or rate limited: still offer what is configured, so the
            // picker never comes up empty and the ref cannot be lost on save.
            fillRefPicker(name, null, current);
        }
    }
}

function collectAppConfig(name) {
    if (name === 'kachat') {
        return {
            enabled: Boolean(appsState?.config?.kachat?.enabled),
            ref: appRef('kachat'),
            network: $('kachat-network').value,
            publish: { api: $('kachat-pub-api').checked, chat: $('kachat-pub-chat').checked },
        };
    }
    if (name === 'desktop') {
        return {
            enabled: Boolean(appsState?.config?.desktop?.enabled),
            ref: appRef('desktop'),
            publish: { web: true },
            hostPort: Number($('desktop-port').value),
        };
    }
    return {
        enabled: Boolean(appsState?.config?.nextcloud?.enabled),
        ref: appRef('nextcloud'),
        publish: { web: $('nextcloud-pub-web').checked },
        hostPort: Number($('nextcloud-port').value),
        adminUser: $('nextcloud-user').value.trim(),
        trustedDomains: $('nextcloud-domains').value.trim(),
    };
}

/**
 * The branch lives on the Updates tab, but Apply lives on Settings with the
 * access fields. Rather than send someone between tabs to change a branch, this
 * runs the same save: the whole config is sent either way, so pressing it from
 * here is the same operation under a name that fits where it sits.
 */
for (const app of ['kachat', 'desktop', 'nextcloud']) {
    $(`${app}-rebuild`).addEventListener('click', async () => {
        const err = $(`${app}-error`);
        err.hidden = true;
        try {
            await api(`/api/apps/${app}`, { method: 'PUT', body: { config: collectAppConfig(app) } });
            openConsole(`Rebuilding ${SERVICE_NAMES[app]}`);
            setTimeout(loadApps, 2000);
        } catch (e) {
            toast(e.message, 'bad');
        }
    });
}

// --- nextcloud admin password ---

/**
 * The install-time password, shown because there is nowhere else to find it
 * short of reading the stack's .env by hand. Masked until asked for, so it is
 * not left sitting on screen.
 */
async function loadNextcloudAdmin() {
    try {
        const r = await api('/api/apps/nextcloud/admin');
        $('nextcloud-pass').value = r.password || '';
        $('nextcloud-pass').placeholder = r.password ? '' : 'not set yet';
    } catch {
        /* the card is only useful once the stack has been installed */
    }
}

$('nextcloud-pass-show').addEventListener('click', () => {
    const box = $('nextcloud-pass');
    const hidden = box.type === 'password';
    box.type = hidden ? 'text' : 'password';
    $('nextcloud-pass-show').textContent = hidden ? 'Hide' : 'Show';
});

$('nextcloud-pass-copy').addEventListener('click', async () => {
    const value = $('nextcloud-pass').value;
    if (!value) return toast('There is no password to copy yet.', 'bad');
    try {
        await navigator.clipboard.writeText(value);
        toast('Password copied.');
    } catch {
        // Clipboard access needs a secure context, which plain http on another
        // machine is not. Selecting it is then the only way to get at it.
        $('nextcloud-pass').type = 'text';
        $('nextcloud-pass').select();
        toast('Could not reach the clipboard, so it is selected instead.', 'bad');
    }
});

$('nextcloud-pass-save').addEventListener('click', async () => {
    const box = $('nextcloud-pass-new');
    const password = box.value;
    if (password.length < 10) return toast('Nextcloud needs at least 10 characters.', 'bad');

    const button = $('nextcloud-pass-save');
    button.disabled = true;
    try {
        await api('/api/apps/nextcloud/admin/password', { method: 'POST', body: { password } });
        box.value = '';
        toast('Password changed.');
        loadNextcloudAdmin();
    } catch (e) {
        toast(e.message, 'bad');
    } finally {
        button.disabled = false;
    }
});

for (const name of ['kachat', 'desktop', 'nextcloud']) {
    // The switch is a power control: it takes effect on the spot, matching the
    // one on Mining. Everything that needs an explicit Apply stays a checkbox.
    $(`${name}-save`).addEventListener('click', async () => {
        const err = $(`${name}-error`);
        err.hidden = true;
        try {
            await api(`/api/apps/${name}`, { method: 'PUT', body: { config: collectAppConfig(name) } });
            openConsole(`Applying ${SERVICE_NAMES[name]} settings`);
            setTimeout(loadApps, 2000);
        } catch (e) {
            err.textContent = e.message;
            err.hidden = false;
        }
    });

    $(`${name}-check`).addEventListener('click', async () => {
        // Report next to the button that was pressed. KaChat's update controls
        // live on their own tab, and its `-notice` element is on Overview, so
        // writing there would put the answer on a page nobody is looking at.
        const notice = $(`${name}-update-status`) ?? $(`${name}-notice`);
        notice.hidden = false;
        notice.className = 'verdict';
        notice.textContent = 'Checking GitHub…';
        try {
            const r = await api(`/api/apps/${name}/check`);
            $(`${name}-update`).disabled = !r.updateAvailable;
            if (r.neverBuilt) {
                notice.textContent = `${r.repo}@${r.ref} is at ${r.shortSha}: "${r.message}". Nothing built yet, so press Apply settings to build it.`;
            } else if (r.updateAvailable) {
                notice.className = 'verdict bad';
                notice.textContent = `There is an update: ${r.shortSha}, "${r.message}". You are running ${String(r.builtSha).slice(0, 7)}.`;
            } else {
                notice.className = 'verdict ok';
                notice.textContent = `You are up to date, running ${r.shortSha}, the newest commit on ${r.ref}.`;
            }
        } catch (e) {
            notice.className = 'verdict bad';
            notice.textContent = e.message;
        }
    });

    $(`${name}-update`).addEventListener('click', async () => {
        if (!confirm(`Rebuild ${name} from the newest commit?\n\nIt will be unavailable while it rebuilds.`)) return;
        try {
            await api(`/api/apps/${name}/update`, { method: 'POST' });
            openConsole(`Updating ${name}`);
            $(`${name}-update`).disabled = true;
        } catch (e) {
            toast(e.message, 'bad');
        }
    });
}

for (const button of document.querySelectorAll('[data-app-action]')) {
    button.addEventListener('click', async () => {
        try {
            await api(`/api/apps/${button.dataset.appAction}`, { method: 'POST' });
            openConsole(button.dataset.appAction.replace('/', ' '));
        } catch (e) {
            toast(e.message, 'bad');
        }
    });
}

// ----------------------------------------------------------- kachat panel ---

/**
 * The indexer's dashboard, native to this panel.
 *
 * The indexer is the engine and this is the interface to it. Everything here
 * goes through the manager's /kachat proxy, because the indexer binds its admin
 * API to loopback inside its own container and nothing outside can dial it.
 *
 * Every screen has to cope with the indexer not being there: it can be switched
 * off, still compiling on a first run, or up but not yet caught up with the
 * chain. None of those are errors worth shouting about, so they all render as a
 * quiet "not running yet" rather than a failure.
 */

// The chat metrics worth showing as tiles, in reading order. Anything the
// indexer reports that is not named here still appears, folded away below.
// Four, not eight. Eight wrapped to two rows on anything but a wide window and
// made this the one KaChat panel that would not fit a screen. The rest are not
// lost: everything the indexer reports that is not named here is under the fold
// below, which is where the sent/received breakdowns and the counters live.
const CHAT_HEADLINE = [
    ['contextual_messages', 'direct messages'],
    ['handshakes_by_sender', 'handshakes'],
    ['payments_by_sender', 'payments'],
    ['group_messages', 'group messages'],
];

class IndexerDown extends Error {}

async function kachat(path, { method = 'GET', body, raw = false } = {}) {
    // When the container is not there, the proxy still spends five seconds
    // failing to resolve its hostname before giving up. We already know the
    // answer, so do not make anyone wait for it.
    if (appsState && !kachatRunning()) throw new IndexerDown('The indexer is not running.');

    const res = await fetch(`/kachat/api/${path}`, {
        method,
        headers: body ? { 'Content-Type': 'application/json' } : {},
        body: body ? JSON.stringify(body) : undefined,
    });
    if (res.status === 502) throw new IndexerDown('The indexer is not answering yet.');
    if (raw) {
        if (!res.ok) throw new Error(res.statusText);
        return res;
    }
    let data = {};
    try {
        data = await res.json();
    } catch {
        /* empty body */
    }
    if (!res.ok) throw new Error(data.error || res.statusText);
    return data;
}

// --- formatting ---

const kAge = (ms) => {
    if (ms == null || ms < 0) return '–';
    const s = Math.floor(ms / 1000);
    if (s < 60) return `${s}s ago`;
    if (s < 3600) return `${Math.floor(s / 60)}m ago`;
    if (s < 86_400) return `${Math.floor(s / 3600)}h ago`;
    return `${Math.floor(s / 86_400)}d ago`;
};
const kTime = (ms) => (ms ? new Date(ms).toLocaleString() : '–');
const kBytes = (b) => {
    if (!b) return '–';
    const units = ['B', 'KB', 'MB', 'GB', 'TB'];
    let i = 0;
    let n = b;
    while (n >= 1024 && i < units.length - 1) {
        n /= 1024;
        i += 1;
    }
    return `${n.toFixed(1)} ${units[i]}`;
};
const kDot = (status) =>
    status === 'healthy' ? 'ok' : ['lagging', 'starting', 'catching_up', 'degraded'].includes(status) ? 'warn' : 'bad';
const kWords = (s) => String(s || '').replace(/_/g, ' ');
const kTile = (label, value, cls = '') =>
    `<div class="stat"><span class="${cls}">${escapeHtml(String(value))}</span><small>${escapeHtml(label)}</small></div>`;

/** Turns the chat indexer's nested metrics object into flat label/value pairs. */
function kFlatten(obj, prefix = '') {
    let out = [];
    for (const [k, v] of Object.entries(obj || {})) {
        const key = prefix ? `${prefix}.${k}` : k;
        if (v && typeof v === 'object' && !Array.isArray(v)) out = out.concat(kFlatten(v, key));
        else out.push([key, Array.isArray(v) ? v.join(', ') : v]);
    }
    return out;
}
const kPretty = (k) => String(k).replace(/[._]+/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());

/** Long hashes get shortened; the full value stays in the tooltip. */
function kMetric(v) {
    if (v === null || v === undefined || v === '') return '–';
    if (typeof v === 'number') return v.toLocaleString();
    const s = String(v);
    if (/^\d+$/.test(s)) return Number(s).toLocaleString();
    if (s.length > 20 && !s.includes(' ')) return `${s.slice(0, 10)}…${s.slice(-6)}`;
    return s;
}

/** Shows a result box, in its "this went wrong" colours when it did. */
function kResult(id, text, bad = false) {
    const node = $(id);
    node.hidden = false;
    node.className = `verdict ${bad ? 'bad' : ''}`;
    node.textContent = text;
}

// --- loaders ---

const kachatRunning = () => Boolean(appsState?.apps?.kachat?.container?.running);

async function loadKachatOverview() {
    try {
        const health = await kachat('health');
        const tag = $('kachat-health-tag');
        tag.textContent = kWords(health.status) || 'unknown';
        tag.className = `tag ${kDot(health.status) === 'ok' ? 'ok' : kDot(health.status) === 'bad' ? 'off' : ''}`;
        $('kachat-lag').textContent = kAge(health.node_lag_ms);
        $('kachat-newest-tx').textContent = kTime(health.newest_transaction_time);
        $('kachat-newest-content').textContent = kTime(health.newest_content_time);
    } catch (e) {
        $('kachat-health-tag').textContent = e instanceof IndexerDown ? 'not running' : 'error';
        $('kachat-health-tag').className = 'tag off';
    }

    try {
        const services = await kachat('services');
        $('kachat-services').innerHTML = services.length
            ? services
                  .map(
                      // The name leads, not the status: five tiles all reading
                      // "healthy" says nothing, and the dot carries that anyway.
                      (s) =>
                          `<div class="stat"><span class="small"><span class="svc-dot ${kDot(s.status)}"></span>${escapeHtml(
                              s.name,
                          )}</span><small>${escapeHtml(kWords(s.status))}${
                              s.detail ? `, ${escapeHtml(s.detail)}` : ''
                          }</small></div>`,
                  )
                  .join('')
            : '<p class="muted">No services reported.</p>';
    } catch {
        $('kachat-services').innerHTML = '<p class="muted">Waiting for the indexer.</p>';
    }

    try {
        const s = await kachat('stats');
        let cm = {};
        try {
            const d = await kachat('chat-metrics');
            if (d?.reachable) cm = d.metrics || {};
        } catch {
            /* the chat indexer is a separate process and may lag behind */
        }

        $('kachat-ingest').textContent = `${fmtNum(s.ingest_last_60m)} items`;

        // The headline figures. ingest_last_60m counts transactions the block
        // ingester stored in the last hour, so it sits at zero while the ingest
        // is still backfilling history and only becomes a live rate once it has
        // caught up with the tip.
        $('kachat-hour').textContent = fmtNum(s.ingest_last_60m);
        $('kachat-5m').textContent = fmtNum(s.ingest_last_5m);
        $('kachat-messages').textContent = fmtNum(cm.contextual_messages ?? 0);
        $('kachat-blocks').textContent = fmtNum(cm.blocks_processed ?? 0);

        $('kachat-stats').innerHTML = [
            ['posts', s.posts],
            ['replies', s.replies],
            ['quotes', s.quotes],
            ['reposts', s.reposts],
            ['upvotes', s.upvotes],
            ['downvotes', s.downvotes],
            ['follows', s.follows],
            ['blocks', s.blocks],
            ['mentions', s.mentions],
            ['hashtags', s.hashtags],
        ]
            .map(([label, v]) => kTile(label, fmtNum(v)))
            .join('');

        $('kachat-activity').innerHTML = [
            ['direct messages', fmtNum(cm.contextual_messages ?? 0)],
            ['handshakes', fmtNum(cm.handshakes_by_sender ?? 0)],
            ['payments', fmtNum(cm.payments_by_sender ?? 0)],
            ['group messages', fmtNum(cm.group_messages ?? 0)],
            ['broadcasts, 30 days', fmtNum(s.bcast_total)],
            ['indexed last 5 min', fmtNum(s.ingest_last_5m)],
            ['chat store', kBytes(s.chat_store_bytes ?? 0)],
            ['KaPosts database', kBytes(s.db_size_bytes)],
        ]
            .map(([label, v]) => kTile(label, v, 'small'))
            .join('');
    } catch {
        $('kachat-stats').innerHTML = '';
        $('kachat-activity').innerHTML = '';
    }
}

async function loadKachatKaposts() {
    loadKachatFeatures();
    try {
        const rows = await kachat('moderation/recent?limit=25');
        $('kachat-recent').innerHTML = rows.length
            ? rows
                  .map(
                      (r) => `<tr>
                        <td><button type="button" class="ghost mini" data-kachat-del-content="${escapeHtml(
                            r.transaction_id,
                        )}" title="Delete this item">✕</button></td>
                        <td class="muted" title="${escapeHtml(kTime(r.timestamp))}">${escapeHtml(
                            kAge(Date.now() - r.timestamp),
                        )}</td>
                        <td>${escapeHtml(r.content_type)}</td>
                        <td class="mono" title="${escapeHtml(r.sender_pubkey)}">${escapeHtml(
                            r.sender_pubkey.slice(0, 12),
                        )}…<button type="button" class="ghost mini" data-kachat-pick="${escapeHtml(
                            r.sender_pubkey,
                        )}">use</button></td>
                        <td>${escapeHtml(r.preview) || '<span class="muted">–</span>'}</td>
                      </tr>`,
                  )
                  .join('')
            : '<tr><td colspan="5" class="muted">Nothing indexed yet.</td></tr>';
    } catch (e) {
        $('kachat-recent').innerHTML = `<tr><td colspan="5" class="muted">${
            e instanceof IndexerDown ? 'The indexer is not running.' : 'Could not load.'
        }</td></tr>`;
    }

    try {
        const rows = await kachat('kaposts/denylist');
        $('kachat-denylist').innerHTML = rows.length
            ? rows
                  .map(
                      (r) => `<tr>
                        <td><button type="button" class="ghost mini" data-kachat-unblock="${escapeHtml(
                            r.pubkey,
                        )}" title="Allow this author again">✕</button></td>
                        <td class="mono" title="${escapeHtml(r.pubkey)}">${escapeHtml(r.pubkey.slice(0, 18))}…</td>
                        <td class="muted">${escapeHtml(kTime(r.added_at))}</td>
                      </tr>`,
                  )
                  .join('')
            : '<tr><td colspan="3" class="muted">Indexing every author.</td></tr>';
    } catch {
        $('kachat-denylist').innerHTML = '<tr><td colspan="3" class="muted">Could not load.</td></tr>';
    }
}

/**
 * The tracked-channel list.
 *
 * Three states the indexer distinguishes, and the wording has to keep them
 * apart because two of them look like "off":
 *
 *   key absent   -> the thirteen it ships with
 *   key present  -> exactly that list
 *   present, empty -> nothing at all
 *
 * Separately, the Index broadcasts switch decides whether any of it runs. So a
 * full list with the switch off stores nothing either, and that is not the same
 * as an empty list.
 */
let channelState = { tracked: [], defaults: [], configured: false };

const CHANNEL_RE = /^[a-z0-9][a-z0-9._-]{0,35}$/;

async function loadKachatBroadcasts() {
    loadKachatFeatures();

    let counts = {};
    let total = 0;
    try {
        const stats = await kachat('stats');
        counts = Object.fromEntries((stats.bcast_by_channel || []).map((c) => [c.channel, c.count]));
        total = stats.bcast_total ?? 0;
    } catch {
        /* the list still renders; the counts are the part that is missing */
    }

    try {
        const settings = await kachat('settings');

        // An indexer built before this feature answers without these fields at
        // all. It still tracks its thirteen, in code, so reporting "none
        // tracked" would be the opposite of the truth.
        if (!Array.isArray(settings.available_broadcast_channels)) {
            channelState = { tracked: [], defaults: [], configured: false, unsupported: true };
            $('kachat-channels-tag').textContent = 'not configurable';
            $('kachat-channels-tag').className = 'tag';
            $('kachat-channels').innerHTML =
                '<p class="verdict">This indexer is older than per-channel tracking, so it follows the ' +
                'thirteen it was built with and they cannot be changed from here. Update it under the ' +
                'Updates tab to choose between them.</p>';
            $('kachat-channel-new').disabled = true;
            $('kachat-channel-add').disabled = true;
            return;
        }
        $('kachat-channel-new').disabled = false;
        $('kachat-channel-add').disabled = false;
        channelState.unsupported = false;
        channelState.defaults = settings.available_broadcast_channels || [];
        // "" and absent both arrive as an empty string, so the flag distinguishes
        // "not configured" from "configured to nothing" the way the indexer does.
        channelState.configured = typeof settings.broadcast_channels === 'string' && settings.broadcast_channels.length > 0;
        channelState.tracked = channelState.configured
            ? settings.broadcast_channels.split(/\s+/).filter(Boolean)
            : [...channelState.defaults];
    } catch {
        $('kachat-channels').innerHTML = '<p class="muted">The indexer is not answering.</p>';
        return;
    }

    channelState.counts = counts;
    channelState.total = total;
    setChannelsDirty(false);
    document.getElementById('kachat-channels-none')?.remove();
    renderChannels(counts, total);
    renderChannelSelects();
    await loadBroadcastRows();
}

function renderChannels(counts, total) {
    // A channel with rows but no longer tracked still gets a card, switched
    // off: the count is real and feeds the total, so dropping it would make the
    // total look wrong.
    const stored = Object.keys(counts).filter((c) => !channelState.tracked.includes(c));
    const names = [...channelState.tracked, ...stored].sort();

    const tag = $('kachat-channels-tag');
    const n = channelState.tracked.length;
    tag.textContent = n ? `${n} channel${n === 1 ? '' : 's'} indexed` : 'none indexed';
    tag.className = `tag ${n ? 'ok' : 'off'}`;

    const card = (name) => {
        const on = channelState.tracked.includes(name);
        // Only a channel the indexer does not ship with can be removed outright;
        // the default thirteen are switched off instead, so the list it came
        // with stays recoverable.
        const removable = !channelState.defaults.includes(name);
        return `<div class="channel-card${on ? '' : ' off'}${on ? '' : ' untracked'}">
          <div class="head">
            <span class="name" title="#${escapeHtml(name)}">#${escapeHtml(name)}</span>
            ${removable ? `<button type="button" class="drop" data-drop-channel="${escapeHtml(name)}" title="Remove from the list">✕</button>` : ''}
            <label class="switch"><input type="checkbox" data-channel="${escapeHtml(name)}"${on ? ' checked' : ''}><span class="track"></span></label>
          </div>
          <div class="count">${fmtNum(counts[name] || 0)}</div>
        </div>`;
    };

    $('kachat-channels').innerHTML =
        names.map(card).join('') +
        `<div class="channel-card total">
           <div class="head"><span class="name">Total broadcasts</span></div>
           <div class="count">${fmtNum(total)}</div>
         </div>`;

    if (!channelState.tracked.length) {
        $('kachat-channels').insertAdjacentHTML(
            'afterend',
            '<p class="verdict bad" id="kachat-channels-none">Nothing is tracked, so no broadcasts are being stored at all.</p>',
        );
    }
}

/** Marks the list as changed but not yet sent. */
function setChannelsDirty(dirty) {
    channelState.dirty = dirty;
    $('kachat-channels-dirty').hidden = !dirty;
}

/** Sends the list as it now stands. No restart; the indexer picks it up. */
async function saveChannels() {
    try {
        await kachat('settings', { method: 'POST', body: { broadcast_channels: channelState.tracked.join('\n') } });
        channelState.configured = true;
        setChannelsDirty(false);
        toast(
            channelState.tracked.length
                ? `${channelState.tracked.length} channels indexed. Live within about fifteen seconds.`
                : 'No channels tracked, so nothing is being stored.',
            channelState.tracked.length ? '' : 'bad',
        );
        loadKachatBroadcasts();
    } catch (e) {
        toast(e instanceof IndexerDown ? 'The indexer is not running.' : e.message, 'bad');
    }
}

$('kachat-channels-save').addEventListener('click', saveChannels);

// Toggling and removing change the list on screen; nothing is sent until Save
// and apply, which is why the unsaved marker exists.
$('kachat-channels').addEventListener('change', (event) => {
    const channel = event.target.dataset?.channel;
    if (!channel) return;
    channelState.tracked = event.target.checked
        ? [...channelState.tracked, channel]
        : channelState.tracked.filter((c) => c !== channel);
    setChannelsDirty(true);
    renderChannels(channelState.counts, channelState.total);
});

$('kachat-channels').addEventListener('click', (event) => {
    const channel = event.target.dataset?.dropChannel;
    if (!channel) return;
    channelState.tracked = channelState.tracked.filter((c) => c !== channel);
    setChannelsDirty(true);
    renderChannels(channelState.counts, channelState.total);
});

$('kachat-channel-add').addEventListener('click', () => {
    const box = $('kachat-channel-new');
    // The indexer lowercases and silently drops anything it does not like, so a
    // bad name would look added and never appear. Checked before it goes in.
    const name = box.value.trim().replace(/^#/, '').toLowerCase();
    if (!name) return;
    if (!CHANNEL_RE.test(name)) {
        return toast('Lowercase letters, digits, dots, dashes and underscores, up to 36 characters.', 'bad');
    }
    if (channelState.tracked.includes(name)) return toast(`#${name} is already on the list.`);

    channelState.tracked = [...channelState.tracked, name];
    box.value = '';
    setChannelsDirty(true);
    renderChannels(channelState.counts, channelState.total);
    toast(`#${name} added. Save and apply to start collecting it.`);
});

$('kachat-channel-new').addEventListener('keydown', (event) => {
    if (event.key === 'Enter') $('kachat-channel-add').click();
});

/** The two channel pickers follow whatever is tracked. */
function renderChannelSelects() {
    const options = channelState.tracked.map((c) => `<option value="${escapeHtml(c)}">#${escapeHtml(c)}</option>`).join('');
    const feed = $('kachat-bcast-channel');
    const keep = feed.value;
    feed.innerHTML = `<option value="">All channels</option>${options}`;
    if ([...feed.options].some((o) => o.value === keep)) feed.value = keep;
    $('kachat-purge-channel').innerHTML = options;
}

async function loadBroadcastRows() {
    const channel = $('kachat-bcast-channel').value;
    const query = channel ? `?channel=${encodeURIComponent(channel)}&limit=50` : '?limit=50';
    try {
        const rows = await kachat(`broadcasts${query}`);
        $('kachat-bcast-rows').innerHTML = rows.length
            ? rows
                  .map(
                      (r) => `<tr>
                        <td><button type="button" class="ghost mini" data-kachat-del-bcast="${escapeHtml(
                            r.tx_id,
                        )}" title="Delete this broadcast">✕</button></td>
                        <td class="muted" title="${escapeHtml(kTime(r.timestamp))}">${escapeHtml(
                            kAge(Date.now() - r.timestamp),
                        )}</td>
                        <td>#${escapeHtml(r.channel)}</td>
                        <td class="mono" title="${escapeHtml(r.sender_address)}">${escapeHtml(
                            r.sender_address.slice(0, 18),
                        )}…</td>
                        <td>${escapeHtml(r.preview) || '<span class="muted">–</span>'}</td>
                      </tr>`,
                  )
                  .join('')
            : '<tr><td colspan="5" class="muted">Nothing here yet.</td></tr>';
    } catch (e) {
        $('kachat-bcast-rows').innerHTML = `<tr><td colspan="5" class="muted">${
            e instanceof IndexerDown ? 'The indexer is not running.' : 'Could not load.'
        }</td></tr>`;
    }
}

/** Chats and group chats read the same endpoint, differing only in what they show. */
async function loadKachatChat(kind) {
    const tag = $(kind === 'group' ? 'kachat-group-tag' : 'kachat-chat-tag');
    const grid = $(kind === 'group' ? 'kachat-group-tiles' : 'kachat-chat-tiles');
    if (kind === 'chat') {
        loadKachatPersonal();
        loadKachatFeatures();
    }
    if (kind === 'group') loadKachatGroupPersonal();
    try {
        const d = await kachat('chat-metrics');
        if (!d.reachable) {
            tag.textContent = 'not reachable';
            tag.className = 'tag off';
            grid.innerHTML =
                '<p class="muted">The chat indexer is not answering. It may be switched off, still building, or catching up.</p>';
            return;
        }
        tag.textContent = 'running';
        tag.className = 'tag ok';
        const m = d.metrics || {};
        if (kind === 'group') {
            grid.innerHTML =
                kTile('group messages', fmtNum(m.group_messages ?? 0)) +
                kTile('group controls', fmtNum(m.group_controls ?? 0));
            return;
        }
        const entries = kFlatten(m);
        const byKey = Object.fromEntries(entries);

        // Tiles for what somebody actually came to look at. The rest are
        // internal tallies, mostly zero, and go under the fold.
        const shown = CHAT_HEADLINE.filter(([key]) => key in byKey);
        grid.innerHTML = shown.length
            ? shown.map(([key, label]) => kTile(label, kMetric(byKey[key]))).join('')
            : '<p class="muted">No metrics reported.</p>';

        const named = new Set(CHAT_HEADLINE.map(([key]) => key));
        const rest = entries.filter(([k]) => !named.has(k));
        const more = $('kachat-chat-more');
        more.hidden = rest.length === 0;
        $('kachat-chat-rest').innerHTML = rest
            .map(
                ([k, v]) =>
                    `<div title="${escapeHtml(String(v ?? ''))}"><dt>${escapeHtml(kPretty(k))}</dt><dd>${escapeHtml(
                        kMetric(v),
                    )}</dd></div>`,
            )
            .join('');
    } catch {
        tag.textContent = 'error';
        tag.className = 'tag off';
        grid.innerHTML = '<p class="muted">Could not reach the chat indexer.</p>';
    }
}

/**
 * The personal-indexing card, which lives on the Chats panel rather than in
 * Settings: it decides whose chats get stored, so it belongs next to them.
 */
async function loadKachatPersonal() {
    try {
        const s = await kachat('settings');
        const box = $('kachat-personal-addrs');
        // This panel re-reads every few seconds; do not overwrite an address
        // somebody is halfway through typing.
        if (document.activeElement !== box) box.value = s.personal_addresses || '';

        const tag = $('kachat-personal-tag');
        tag.textContent = s.personal_mode ? 'only your chats' : 'indexing everything';
        tag.className = `tag ${s.personal_mode ? 'ok' : ''}`;
    } catch {
        /* the chat stats above already say the indexer is not answering */
    }
}

/**
 * The group allowlist, on the Group chats panel for the same reason the address
 * list sits on Chats: it decides what gets stored there.
 */
async function loadKachatGroupPersonal() {
    try {
        const s = await kachat('settings');
        const box = $('kachat-group-ids');
        if (document.activeElement !== box) box.value = s.personal_group_ids || '';

        const tag = $('kachat-group-personal-tag');
        const count = (s.personal_group_ids || '').split(/\s+/).filter(Boolean).length;
        tag.textContent = s.group_personal_mode ? `${count} group${count === 1 ? '' : 's'}` : 'all groups';
        tag.className = `tag ${s.group_personal_mode ? 'ok' : ''}`;
    } catch {
        /* the stats below already report the indexer being unreachable */
    }
}

// A blinded group id is 32 bytes as hex. The indexer silently drops anything
// that is not, so entries are checked here first: a typo that just vanished on
// save would look like the setting had been accepted.
const GROUP_ID_RE = /^[0-9a-f]{64}$/i;

/**
 * The three "index this" switches. They sit on the tabs they govern rather than
 * in a settings list, so each of those tabs has to be able to read them without
 * Settings having been opened first.
 */
async function loadKachatFeatures() {
    try {
        const s = await kachat('settings');
        $('kachat-tg-kaposts').checked = Boolean(s.feature_kaposts);
        $('kachat-tg-broadcasts').checked = Boolean(s.feature_broadcasts);
        $('kachat-tg-chat').checked = Boolean(s.chat_indexer);
    } catch {
        /* the panel it sits on already reports the indexer being unreachable */
    }
}

async function loadKachatSettings() {
    try {
        const s = await kachat('settings');
        $('kachat-set-name').value = s.instance_name || '';
        $('kachat-set-tagline').value = s.instance_tagline || '';
        $('kachat-set-url').value = s.instance_url || '';
        $('kachat-operator-addr').value = s.kaposts_operator_address || '';
        $('kachat-kap-personal').checked = Boolean(s.kaposts_personal_mode);
        $('kachat-kap-personal-body').hidden = !s.kaposts_personal_mode;
    } catch {
        /* the container settings above still work without the indexer */
    }
}

/** Settings take a partial document, so only the changed field is sent. */
async function saveKachatSettings(patch, message) {
    try {
        await kachat('settings', { method: 'POST', body: patch });
        toast(message);
        // Reload whichever panel is open: these settings are spread across
        // Chats and Settings, so refreshing one by name would miss the other.
        refreshKachatPanel();
    } catch (e) {
        toast(e instanceof IndexerDown ? 'The indexer is not running.' : e.message, 'bad');
        refreshKachatPanel();
    }
}

/**
 * Says the same thing everywhere when the indexer is not up: an empty table
 * otherwise reads as "running, nothing indexed", which is a different situation
 * and sends people looking for the wrong problem.
 */
function renderKachatOffline() {
    const message = 'The indexer is not running. Switch it on under Overview.';
    for (const [id, span] of [
        ['kachat-recent', 5],
        ['kachat-denylist', 3],
        ['kachat-bcast-rows', 5],
    ]) {
        $(id).innerHTML = `<tr><td colspan="${span}" class="muted">${message}</td></tr>`;
    }
    for (const id of ['kachat-services', 'kachat-chat-tiles', 'kachat-group-tiles']) {
        $(id).innerHTML = `<p class="muted">${message}</p>`;
    }
    for (const id of ['kachat-stats', 'kachat-activity', 'kachat-bcast-tiles']) $(id).innerHTML = '';
    // Stale counters under a fold nobody opened would outlive the indexer.
    $('kachat-chat-more').hidden = true;
    for (const id of [
        'kachat-health-tag',
        'kachat-chat-tag',
        'kachat-group-tag',
        'kachat-personal-tag',
        'kachat-group-personal-tag',
    ]) {
        $(id).textContent = 'not running';
        $(id).className = 'tag off';
    }
    for (const id of [
        'kachat-lag',
        'kachat-newest-tx',
        'kachat-newest-content',
        'kachat-ingest',
        'kachat-hour',
        'kachat-5m',
        'kachat-messages',
        'kachat-blocks',
    ]) {
        $(id).textContent = '–';
    }
}

/** Loads whichever KaChat panel is on screen, and only that one. */
function refreshKachatPanel() {
    if (!kachatRunning()) return renderKachatOffline();
    switch (activeSubtab('kachat')) {
        case 'kachat-overview':
            loadKachatOverview();
            break;
        case 'kachat-kaposts':
            loadKachatKaposts();
            break;
        case 'kachat-broadcasts':
            loadKachatBroadcasts();
            break;
        case 'kachat-chats':
            loadKachatChat('chat');
            break;
        case 'kachat-groups':
            loadKachatChat('group');
            break;
        case 'kachat-settings':
            loadKachatSettings();
            break;
        default:
            break;
    }
}

let kachatTimer = null;
function setKachatPolling(active) {
    clearInterval(kachatTimer);
    kachatTimer = null;
    if (active) {
        refreshKachatPanel();
        kachatTimer = setInterval(refreshKachatPanel, 8000);
    }
}

// --- controls ---

$('kachat-bcast-channel').addEventListener('change', loadBroadcastRows);
$('kachat-bcast-refresh').addEventListener('click', loadKachatBroadcasts);

// Moderation: a dry run has to happen before the destructive button unlocks, so
// nobody deletes an author's history on a typo'd pubkey.
$('kachat-pk').addEventListener('input', () => {
    $('kachat-remove').disabled = true;
    $('kachat-mod-result').hidden = true;
});

$('kachat-preview').addEventListener('click', async () => {
    const pubkey = $('kachat-pk').value.trim();
    if (!pubkey) return toast('Enter an author pubkey first.', 'bad');
    try {
        const d = await kachat('moderation/remove', { method: 'POST', body: { pubkey, dry_run: true } });
        kResult(
            'kachat-mod-result',
            `Removing this author would delete ${d.total} rows: ${d.contents} content, ${d.mentions} mentions, ` +
                `${d.votes} votes, ${d.broadcasts} broadcasts, ${d.blocks} blocks, ${d.follows} follows.`,
        );
        $('kachat-remove').disabled = d.total === 0;
    } catch (e) {
        kResult('kachat-mod-result', e.message, true);
    }
});

$('kachat-remove').addEventListener('click', async () => {
    const pubkey = $('kachat-pk').value.trim();
    if (!confirm(`Permanently delete every indexed row from ${pubkey.slice(0, 16)}…?\n\nThis cannot be undone here.`)) return;
    try {
        const d = await kachat('moderation/remove', { method: 'POST', body: { pubkey, dry_run: false } });
        kResult('kachat-mod-result', `Deleted ${d.total} rows.`);
        $('kachat-remove').disabled = true;
        loadKachatKaposts();
    } catch (e) {
        kResult('kachat-mod-result', e.message, true);
    }
});

$('kachat-block').addEventListener('click', async () => {
    const pubkey = $('kachat-pk').value.trim();
    if (!pubkey) return toast('Enter an author pubkey first.', 'bad');
    if (!confirm(`Block ${pubkey.slice(0, 16)}…?\n\nEverything of theirs is purged and nothing new is stored.`)) return;
    try {
        await kachat('kaposts/denylist/add', { method: 'POST', body: { pubkey } });
        kResult('kachat-mod-result', 'Blocked, purged, and no longer indexed.');
        loadKachatKaposts();
    } catch (e) {
        kResult('kachat-mod-result', e.message, true);
    }
});

// Personal mode is not a stored flag: the indexer reports it on whenever an
// operator address is set. So switching on only reveals the field, and
// switching off is what actually writes, by clearing the address.
$('kachat-kap-personal').addEventListener('change', (e) => {
    $('kachat-kap-personal-body').hidden = !e.target.checked;
    if (e.target.checked) {
        $('kachat-operator-addr').focus();
        return;
    }
    if (!confirm('Turn off KaPosts personal mode?\n\nEvery author gets indexed again. Anyone you blocked by hand stays blocked.')) {
        e.target.checked = true;
        $('kachat-kap-personal-body').hidden = false;
        return;
    }
    saveKachatSettings({ kaposts_operator_address: '' }, 'Personal mode off.');
});

$('kachat-kap-save').addEventListener('click', () =>
    saveKachatSettings({ kaposts_operator_address: $('kachat-operator-addr').value.trim() }, 'Address saved.'),
);

$('kachat-set-save').addEventListener('click', () =>
    saveKachatSettings(
        {
            instance_name: $('kachat-set-name').value.trim(),
            instance_tagline: $('kachat-set-tagline').value.trim(),
            instance_url: $('kachat-set-url').value.trim(),
        },
        'Identity saved.',
    ),
);

for (const [id, key, label] of [
    ['kachat-tg-kaposts', 'feature_kaposts', 'KaPosts'],
    ['kachat-tg-broadcasts', 'feature_broadcasts', 'Broadcasts'],
    ['kachat-tg-chat', 'chat_indexer', 'The chat indexer'],
]) {
    $(id).addEventListener('change', (e) =>
        saveKachatSettings({ [key]: e.target.checked }, `${label} ${e.target.checked ? 'on' : 'off'}.`),
    );
}

$('kachat-personal-save').addEventListener('click', () =>
    saveKachatSettings(
        { personal_addresses: $('kachat-personal-addrs').value.trim() },
        'Saved. The chat indexer is restarting.',
    ),
);

$('kachat-group-save').addEventListener('click', () => {
    const entries = $('kachat-group-ids').value.split(/[\s,]+/).filter(Boolean);
    const bad = entries.filter((id) => !GROUP_ID_RE.test(id));
    if (bad.length) {
        toast(
            `${bad.length} of ${entries.length} is not a group id. They are 64 hex characters; ` +
                `"${bad[0].slice(0, 12)}${bad[0].length > 12 ? '…' : ''}" is ${bad[0].length}.`,
            'bad',
        );
        return;
    }
    saveKachatSettings(
        { personal_group_ids: entries.join('\n') },
        entries.length
            ? `Keeping ${entries.length} group${entries.length === 1 ? '' : 's'}. The chat indexer is restarting.`
            : 'Keeping every group. The chat indexer is restarting.',
    );
});

// --- export and import ---

$('kachat-export').addEventListener('click', async () => {
    kResult('kachat-file-result', 'Building the export, which can take a moment on a large store.');
    try {
        const res = await kachat('chat-export', { raw: true });
        const blob = await res.blob();
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = 'kachat-chat-store.bin';
        a.click();
        URL.revokeObjectURL(url);
        kResult('kachat-file-result', `Exported ${kBytes(blob.size)}.`);
    } catch (e) {
        kResult('kachat-file-result', e instanceof IndexerDown ? 'The indexer is not running.' : e.message, true);
    }
});

$('kachat-import-file-btn').addEventListener('click', () => $('kachat-import-file').click());

$('kachat-import-file').addEventListener('change', async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    kResult('kachat-file-result', `Uploading ${file.name} (${kBytes(file.size)}).`);
    try {
        const res = await fetch('/kachat/api/chat-import-file', { method: 'POST', body: file });
        // Upstream answers this one in plain text, not JSON.
        const text = (await res.text()).trim();
        if (!res.ok) throw new Error(text || res.statusText);
        kResult('kachat-file-result', text || 'Imported.');
    } catch (err) {
        kResult('kachat-file-result', err.message, true);
    } finally {
        // Let the same file be picked again if the first go failed.
        e.target.value = '';
    }
});

$('kachat-import').addEventListener('click', async () => {
    const address = $('kachat-import-addr').value.trim();
    if (!address) return toast('Enter an address to import.', 'bad');
    kResult('kachat-import-result', 'Importing. This pages through the block explorer, so give it a moment.');
    $('kachat-import').disabled = true;
    try {
        const d = await kachat('chat-import', { method: 'POST', body: { address } });
        kResult(
            'kachat-import-result',
            d.error
                ? `${d.error} (scanned ${d.scanned}, imported ${d.imported})`
                : `Scanned ${fmtNum(d.scanned)} transactions over ${d.pages} pages, forwarded ${fmtNum(
                      d.forwarded,
                  )}, imported ${fmtNum(d.imported)}, skipped ${fmtNum(d.skipped)}.`,
            Boolean(d.error),
        );
    } catch (e) {
        kResult('kachat-import-result', e.message, true);
    } finally {
        $('kachat-import').disabled = false;
    }
});

// --- deletions ---

$('kachat-del-content-btn').addEventListener('click', async () => {
    const tx = $('kachat-del-content').value.trim();
    if (!tx) return toast('Enter a transaction id.', 'bad');
    try {
        const d = await kachat('kaposts/delete', { method: 'POST', body: { tx_id: tx } });
        kResult('kachat-kaposts-del-result', `Deleted ${d.deleted} row${d.deleted === 1 ? '' : 's'}.`);
        $('kachat-del-content').value = '';
    } catch (e) {
        kResult('kachat-kaposts-del-result', e.message, true);
    }
});

$('kachat-del-bcast-btn').addEventListener('click', async () => {
    const tx = $('kachat-del-bcast').value.trim();
    if (!tx) return toast('Enter a transaction id.', 'bad');
    try {
        const d = await kachat('broadcasts/delete', { method: 'POST', body: { tx_id: tx } });
        kResult('kachat-bcast-del-result', `Deleted ${d.deleted} broadcast${d.deleted === 1 ? '' : 's'}.`);
        $('kachat-del-bcast').value = '';
    } catch (e) {
        kResult('kachat-bcast-del-result', e.message, true);
    }
});

$('kachat-purge-channel-btn').addEventListener('click', async () => {
    const channel = $('kachat-purge-channel').value;
    if (!confirm(`Delete every stored broadcast in #${channel}?`)) return;
    try {
        const d = await kachat('broadcasts/delete', { method: 'POST', body: { channel } });
        kResult('kachat-bcast-del-result', `Deleted ${d.deleted} broadcasts from #${channel}.`);
    } catch (e) {
        kResult('kachat-bcast-del-result', e.message, true);
    }
});

$('kachat-purge-all-btn').addEventListener('click', async () => {
    if (!confirm('Delete every stored broadcast in every channel?\n\nThis cannot be undone here.')) return;
    try {
        const d = await kachat('broadcasts/delete', { method: 'POST', body: { all: true } });
        kResult('kachat-bcast-del-result', `Deleted ${d.deleted} broadcasts.`);
    } catch (e) {
        kResult('kachat-bcast-del-result', e.message, true);
    }
});

$('kachat-purge-chat-btn').addEventListener('click', async () => {
    if (!confirm('Wipe every message, group, handshake and payment from the chat store?\n\nThis cannot be undone here.'))
        return;
    try {
        await kachat('chat/purge', { method: 'POST' });
        kResult('kachat-chat-del-result', 'The chat store is empty. It will refill from the chain going forward.');
    } catch (e) {
        kResult('kachat-chat-del-result', e.message, true);
    }
});

// Row buttons are created as the tables render, so they are handled from the
// section rather than bound one by one.
$('tab-kachat').addEventListener('click', async (event) => {
    const button = event.target.closest('button[data-kachat-pick], button[data-kachat-unblock], button[data-kachat-del-content], button[data-kachat-del-bcast]');
    if (!button) return;
    const d = button.dataset;

    if (d.kachatPick) {
        $('kachat-pk').value = d.kachatPick;
        $('kachat-remove').disabled = true;
        selectSubtab($('tab-kachat'), 'kachat-kaposts');
        $('kachat-pk').focus();
        return;
    }
    try {
        if (d.kachatUnblock) {
            await kachat('kaposts/denylist/remove', { method: 'POST', body: { pubkey: d.kachatUnblock } });
            toast('Unblocked. Their content can be indexed again.');
            loadKachatKaposts();
        } else if (d.kachatDelContent) {
            if (!confirm('Delete this item from the index?')) return;
            await kachat('kaposts/delete', { method: 'POST', body: { tx_id: d.kachatDelContent } });
            toast('Deleted.');
            loadKachatKaposts();
        } else if (d.kachatDelBcast) {
            if (!confirm('Delete this broadcast from the index?')) return;
            await kachat('broadcasts/delete', { method: 'POST', body: { tx_id: d.kachatDelBcast } });
            toast('Deleted.');
            loadKachatBroadcasts();
        }
    } catch (e) {
        toast(e.message, 'bad');
    }
});

// -------------------------------------------------------------- kassigner ---

/**
 * KasSigner is a device rather than a service, so this page is a sequence
 * instead of a dashboard: pick the board, plug it in, find it, write to it.
 *
 * Nothing runs in the background and nothing here holds a key. The firmware is
 * downloaded and hash-checked by the manager, and the write happens in a
 * throwaway container with only that one serial port passed into it.
 */
let kassignerState = null;
let kassignerBoards = {};
let chosenBoard = null;

async function loadKassigner() {
    const r = await api('/api/kassigner');
    kassignerState = r.state;
    kassignerBoards = r.boards;

    const on = Boolean(r.state.enabled);
    const tag = $('kassigner-state');
    tag.textContent = on ? r.state.release || 'ready' : 'off';
    tag.className = `tag ${on ? 'ok' : 'off'}`;
    setNavSwitch('kassigner', on);
    setNavHealth('kassigner', on ? 'ok' : 'off');

    const notice = $('kassigner-notice');
    notice.hidden = on;
    if (!on) {
        notice.className = 'verdict';
        notice.textContent = 'Switch it on to download the firmware and check it. Nothing is written to a device until you ask.';
    }

    $('kassigner-build').textContent = r.state.verifiedAt
        ? `${r.state.release} verified on ${new Date(r.state.verifiedAt).toLocaleString()}`
        : 'Nothing downloaded yet.';

    renderKassignerBoards();
    // Choosing a board only makes sense once the firmware is actually here.
    $('kassigner-step-board').hidden = !on;
}

function renderKassignerBoards() {
    $('kassigner-boards').innerHTML = Object.entries(kassignerBoards)
        .map(
            ([key, b]) => `<article class="card board-card" data-board="${escapeHtml(key)}">
              <h3>${escapeHtml(b.label)}</h3>
              <p class="muted">${escapeHtml(b.blurb)}</p>
              <div class="row"><button type="button" class="primary" data-pick-board="${escapeHtml(key)}">This is mine</button></div>
              ${
                  b.buy
                      ? `<p class="hint buy">Do not have one? <a href="${escapeHtml(b.buy.url)}" target="_blank" rel="noreferrer noopener">${escapeHtml(b.buy.label)} ↗</a></p>`
                      : ''
              }
            </article>`,
        )
        .join('') +
        // Not a choice, so it has no button and nothing to click. It is here to
        // answer "is this the whole list?" without anyone having to ask.
        `<article class="card board-card soon">
              <h3>More devices</h3>
              <p class="muted">Coming soon. These are the boards KasSigner has firmware for today, and more are being added.</p>
            </article>`;
}

const boardAsset = (key) => kassignerBoards[key].asset;

$('kassigner-boards').addEventListener('click', (event) => {
    const key = event.target.dataset?.pickBoard;
    if (!key) return;
    chosenBoard = { key, asset: boardAsset(key), label: kassignerBoards[key].label };

    $('kassigner-step-board').hidden = true;
    $('kassigner-step-plug').hidden = false;
    $('kassigner-board-chosen').textContent = chosenBoard.label;
    $('kassigner-plug-hint').textContent =
        key === 'm5stack'
            ? 'Connect it over USB. If it has been used before, hold the reset button while plugging it in so it comes up ready to be written to.'
            : 'Connect it over USB. If it has been used before, hold the BOOT button while plugging it in so it comes up ready to be written to.';
    $('kassigner-devices').innerHTML = '';
    $('kassigner-detect-note').textContent = '';
});

$('kassigner-back').addEventListener('click', () => {
    chosenBoard = null;
    $('kassigner-step-plug').hidden = true;
    $('kassigner-step-board').hidden = false;
});

$('kassigner-detect').addEventListener('click', async () => {
    const button = $('kassigner-detect');
    button.disabled = true;
    $('kassigner-detect-note').textContent = 'Looking at the USB ports…';
    try {
        const { devices } = await api('/api/kassigner/devices');
        renderKassignerDevices(devices);
        $('kassigner-detect-note').textContent = devices.length
            ? `${devices.length} serial device${devices.length === 1 ? '' : 's'} found.`
            : 'Nothing there yet.';
    } catch (e) {
        $('kassigner-detect-note').textContent = '';
        toast(e.message, 'bad');
    } finally {
        button.disabled = false;
    }
});

function renderKassignerDevices(devices) {
    const box = $('kassigner-devices');
    if (!devices.length) {
        box.innerHTML =
            '<p class="verdict">No serial device is connected. Check the cable is a data cable rather than charge-only, ' +
            'and that the board is in download mode.</p>';
        return;
    }
    box.innerHTML = `<div class="scroll-x"><table class="blocks">
        <thead><tr><th>Port</th><th>What it says it is</th><th></th></tr></thead>
        <tbody>${devices
            .map(
                (d) => `<tr>
                  <td class="mono">${escapeHtml(d.port)}</td>
                  <td class="muted">${escapeHtml(d.id || 'no identifier')}${
                      d.looksLikeEsp32 ? ' <span class="tag ok">looks right</span>' : ''
                  }</td>
                  <td><button type="button" class="primary" data-flash="${escapeHtml(d.port)}">Write firmware</button></td>
                </tr>`,
            )
            .join('')}</tbody></table></div>
        <p class="hint">
          Writing replaces everything on the board. It does not touch a seed,
          because a KasSigner never stores one: keys live in RAM and are gone at
          power-off.
        </p>`;
}

$('kassigner-devices').addEventListener('click', async (event) => {
    const port = event.target.dataset?.flash;
    if (!port || !chosenBoard) return;
    if (
        !confirm(
            `Write KasSigner ${kassignerState?.release || ''} to ${port}?\n\n` +
                `Board: ${chosenBoard.label}\n\n` +
                'Everything currently on the device is replaced. The image was checked against the hash the project publishes.',
        )
    ) {
        return;
    }
    const panel = $('kassigner-flash');
    const state = $('kassigner-flash-state');
    panel.hidden = false;
    state.textContent = 'working';
    state.className = 'tag';
    for (const b of document.querySelectorAll('[data-flash]')) b.disabled = true;

    claimJob('Write firmware', {
        el: $('kassigner-log'),
        state,
        onEnd: (job) => {
            state.textContent = job.status === 'succeeded' ? 'done' : 'failed';
            state.className = `tag ${job.status === 'succeeded' ? 'ok' : 'off'}`;
            for (const b of document.querySelectorAll('[data-flash]')) b.disabled = false;
        },
    });

    try {
        await api('/api/kassigner/flash', { method: 'POST', body: { port, board: chosenBoard.asset, image: 'full' } });
    } catch (e) {
        inlineJob = null;
        panel.hidden = true;
        for (const b of document.querySelectorAll('[data-flash]')) b.disabled = false;
        toast(e.message, 'bad');
    }
});

// --- updates ---

async function loadKassignerReleases({ force = false } = {}) {
    const select = $('kassigner-release');
    const { releases } = await api(`/api/kassigner/releases${force ? '?force=1' : ''}`);
    const stable = releases.filter((r) => !r.prerelease);
    const pre = releases.filter((r) => r.prerelease);
    const opts = (list) => list.map((r) => `<option value="${escapeHtml(r.tag)}">${escapeHtml(r.tag)}</option>`).join('');
    select.innerHTML =
        '<option value="">newest release</option>' +
        (stable.length ? `<optgroup label="Releases">${opts(stable)}</optgroup>` : '') +
        (pre.length ? `<optgroup label="Prereleases">${opts(pre)}</optgroup>` : '');
    if (kassignerState?.release) select.value = kassignerState.release;
    return releases;
}

$('kassigner-releases-scan').addEventListener('click', async () => {
    try {
        const r = await loadKassignerReleases({ force: true });
        toast(`${r.length} releases upstream.`);
    } catch (e) {
        toast(e.message, 'bad');
    }
});

$('kassigner-check').addEventListener('click', async () => {
    const status = $('kassigner-update-status');
    status.className = 'verdict';
    status.textContent = 'Checking GitHub…';
    try {
        const releases = await loadKassignerReleases({ force: true });
        const newest = releases.find((r) => !r.prerelease) ?? releases[0];
        const have = kassignerState?.release;
        if (!have) {
            status.textContent = `${newest.tag} is the newest release. Nothing is downloaded here yet.`;
        } else if (have === newest.tag) {
            status.className = 'verdict ok';
            status.textContent = `You have ${have}, which is the newest.`;
        } else {
            status.className = 'verdict bad';
            status.textContent = `${newest.tag} is out, and you have ${have}.`;
        }
    } catch (e) {
        status.className = 'verdict bad';
        status.textContent = e.message;
    }
});

$('kassigner-fetch').addEventListener('click', async () => {
    try {
        await api('/api/kassigner', { method: 'PUT', body: { enabled: true, tag: $('kassigner-release').value || null } });
        openConsole('Fetching KasSigner firmware');
    } catch (e) {
        toast(e.message, 'bad');
    }
});

// ---------------------------------------------------------------- proxies ---

let proxies = [];
// The kinds a proxy host can forward to, as the server defines them. The dialog
// used to carry its own copy in markup, which went stale the moment the apps
// became targets: editing a Nextcloud host showed an empty "Forwards to".
let targetKinds = {};

async function loadProxies() {
    const r = await api('/api/proxies');
    proxies = r.proxies;
    targetKinds = r.targets ?? {};

    // Reflect whether the proxy is running before anything else: with it off,
    // adding a host would write config nothing is serving.
    const on = Boolean(r.enabled);
    const badge = $('proxy-state');
    badge.textContent = !on ? 'off' : r.container?.running ? 'running' : r.container?.status || 'starting';
    badge.className = `tag ${!on ? 'off' : r.container?.running ? 'ok' : ''}`;
    setNavSwitch('proxy', on);
    setNavHealth('proxy', on ? 'ok' : 'off');

    // With the proxy off, the settings are not just unusable, they are
    // misleading: a saved host writes nginx config nothing is serving. So the
    // page says what to do rather than showing controls that cannot work.
    $('proxy-config').hidden = !on;

    // With nothing else on the page, a full-width card of two sentences is
    // mostly empty space; narrowed and centred it reads as the one thing there
    // is to do. It goes back to full width once the settings are under it.
    $('tab-proxy').classList.toggle('alone', !on);

    for (const id of ['proxy-reload', 'proxy-renew', 'dd-now']) {
        const button = $(id);
        button.disabled = !on;
        button.title = on ? '' : 'Turn the reverse proxy on first.';
    }

    // The one table on this page is the service view, which reads the same
    // proxy list back from its own endpoint.
    await loadPublish();
}

// ------------------------------------------------- services and domains ---

/**
 * The whole of this page. It asks "what do you want reachable" rather than
 * "what is an upstream", and the wizard behind the Set up button answers every
 * other question -- the name, the DNS record, the certificate, whatever the
 * service needs switched on -- so that nobody has to learn nginx to publish a
 * node. The proxy-host dialog is still here for the details, reached from a
 * published row rather than from a screen of its own.
 */
let publishState = { services: [], domains: [] };

async function loadPublish() {
    try {
        publishState = await api('/api/publish');
        if (publishState.publicPorts) {
            const p = publishState.publicPorts;
            $('ports-http').value = p.http;
            $('ports-https').value = p.https;
            $('ports-bind-http').value = p.bindHttp;
            $('ports-bind-https').value = p.bindHttps;
            $('panel-port').value = p.panel;
            $('panel-port-state').textContent = `This panel answers on port ${p.panel}. The reverse proxy holds ${p.bindHttp} and ${p.bindHttps} on this machine.`;
        }
    } catch {
        // The proxy card above already reports anything that is actually wrong.
        return;
    }
    renderPublishServices();
}

/** What a target kind reads as, for "in use by" and for taken-domain options. */
const serviceLabel = (kind) => publishState.services.find((s) => s.kind === kind)?.label ?? 'another proxy host';

function renderPublishServices() {
    const { services, domains } = publishState;

    $('publish-body').innerHTML = services
        .map((s) => {
            // The proxy host behind this row, and the domain record behind
            // that. Both are read all over the cells below, so they are worked
            // out once, first: a `const` further down would be in the temporal
            // dead zone for everything above it, and the row would throw.
            const proxy = proxies.find((p) => p.id === s.proxyId);
            const record = domains.find((d) => d.domain === s.domain);

            // "not running" is a state, not a problem: a domain can be assigned
            // now and answer when the service is started. "unavailable" is the
            // one that means the panel will refuse.
            const status = s.blocked
                ? `<span class="tag off" title="${escapeHtml(s.reason)}">unavailable</span>`
                : s.ready
                  ? '<span class="tag ok">ready</span>'
                  : `<span class="tag" title="${escapeHtml(s.reason ?? '')}">not running</span>`;

            // Certificate life is on screen rather than in an e-mail nobody
            // asked for. Renewal is automatic, so this is a check, not a chore.
            const days = record?.expiry?.daysLeft;
            const https = Number.isFinite(days)
                ? `<span class="tag ${days <= 14 ? 'warn' : 'ok'}" title="The certificate renews automatically about a month before this.">https, ${days}d left</span>`
                : record?.ssl?.mode === 'letsencrypt'
                  ? '<span class="tag" title="Not issued yet. Retry HTTPS asks again.">no certificate</span>'
                  : '';

            const address = s.url
                ? `<a href="${escapeHtml(s.url)}" target="_blank" rel="noreferrer noopener">${escapeHtml(s.domain)}${
                      s.path && s.path !== '/' ? escapeHtml(s.path) : ''
                  }</a> ${https}${proxy?.auth?.enabled ? ' <span class="tag">password</span>' : ''}${
                      (proxy?.allowlist || []).length ? ' <span class="tag">ip filter</span>' : ''
                  }`
                // The button beside this already says "Set up", so repeating
                // "not published" here would be two answers to one question.
                : '<span class="muted">–</span>';

            // Setting up and moving to another name are the same walk from a
            // different starting point, so one button covers both. Everything
            // the advanced screen used to offer for a host is on the row that
            // host belongs to: retry the certificate, open the details, take it
            // down.
            const needsCert = proxy?.ssl?.mode === 'letsencrypt' && !proxy.certificate;
            const actions = s.blocked
                ? `<button class="ghost" disabled title="${escapeHtml(s.reason)}">Set up</button>`
                : [
                      `<button class="primary" data-setup="${s.key}">${s.domain ? 'Change' : 'Set up'}</button>`,
                      needsCert ? `<button class="ghost" data-cert="${s.proxyId}" title="The name has no certificate yet. This asks Let's Encrypt again.">Retry HTTPS</button>` : '',
                      s.proxyId ? `<button class="ghost" data-options="${s.proxyId}" title="Basic auth, IP allowlist, rate limit, custom nginx.">Options</button>` : '',
                      s.domain ? `<button class="ghost danger" data-unpublish="${s.key}">Unpublish</button>` : '',
                  ]
                      .filter(Boolean)
                      .join(' ');

            return `<tr title="${escapeHtml(`Forwards to ${s.upstreamLabel}`)}">
      <td><span class="service-name">${escapeHtml(s.label)}</span><small class="service-detail">${escapeHtml(s.detail)}</small></td>
      <td>${status}</td>
      <td>${address}</td>
      <td class="row-actions">${actions}</td>
    </tr>`;
        })
        .join('');

}

// Everything a published address needs is on its own row: set it up, retry the
// certificate, open the details, take it down.
$('publish-body').addEventListener('click', async (event) => {
    const { setup, unpublish, cert, options } = event.target.dataset ?? {};
    if (setup) return openSetup(setup);
    if (options) return openProxyDialog(proxies.find((p) => p.id === options));

    if (cert) {
        const proxy = proxies.find((p) => p.id === cert);
        try {
            await api(`/api/proxies/${cert}/certificate`, { method: 'POST', body: { email: proxy?.ssl?.email } });
            openConsole(`Issuing certificate for ${proxy.domain}`);
        } catch (e) {
            toast(e.message, 'bad');
        }
        return;
    }

    if (!unpublish) return;

    const service = publishState.services.find((s) => s.key === unpublish);
    if (!confirm(`Stop publishing ${service?.label ?? unpublish} on ${service?.domain}?\n\nThe name stays on your list and the certificate is left alone.`)) {
        return;
    }
    event.target.disabled = true;
    try {
        await api(`/api/publish/${unpublish}`, { method: 'POST', body: { domain: null } });
        toast(`${service?.label ?? unpublish} is no longer published`);
        await loadProxies();
    } catch (e) {
        toast(e.message, 'bad');
        event.target.disabled = false;
    }
});

$('ports-save').addEventListener('click', async () => {
    $('ports-save').disabled = true;
    try {
        const r = await api('/api/proxy/ports', {
            method: 'POST',
            body: {
                http: Number($('ports-http').value),
                https: Number($('ports-https').value),
                bindHttp: Number($('ports-bind-http').value),
                bindHttps: Number($('ports-bind-https').value),
            },
        });
        if (r.jobId) openConsole(`Moving the proxy to ports ${r.bindHttp} and ${r.bindHttps}`);
        else toast(`Addresses will use ${r.http === 80 ? 'the default http port' : `http port ${r.http}`} and ${r.https === 443 ? 'the default https port' : `https port ${r.https}`}.`);
        await loadProxies();
    } catch (e) {
        toast(e.message, 'bad');
    } finally {
        $('ports-save').disabled = false;
    }
});

/**
 * The reachability check. It reports what this machine does and what the
 * internet can see separately, because those need opposite fixes and look
 * identical from outside: a closed port and a stopped proxy both just fail.
 */
$('ports-check').addEventListener('click', async () => {
    const button = $('ports-check');
    const out = $('ports-check-result');
    button.disabled = true;
    button.textContent = 'Checking…';
    out.hidden = false;
    out.innerHTML = '<p class="muted">Asking a few places on the internet to connect. This takes a few seconds.</p>';

    try {
        const r = await api('/api/proxy/portcheck');
        const line = (ok, text) => `<li class="${ok === null ? '' : ok ? 'ok' : 'bad'}">${escapeHtml(text)}</li>`;
        const rows = [];
        const bound = `${r.local.bindHttp} and ${r.local.bindHttps}`;

        rows.push(line(r.local.proxyRunning, r.local.proxyRunning ? 'The reverse proxy is running here.' : 'The reverse proxy is not running, so nothing would answer even on an open port.'));
        rows.push(line(r.local.publishesHttp && r.local.publishesHttps,
            r.local.publishesHttp && r.local.publishesHttps
                ? `It holds ports ${bound} on this machine.`
                : `It is missing ${[!r.local.publishesHttp && r.local.bindHttp, !r.local.publishesHttps && r.local.bindHttps].filter(Boolean).join(' and ')} on this machine.`));
        rows.push(line(r.local.servesChallenge, r.local.servesChallenge
            ? "It serves the file Let's Encrypt asks for."
            : "It did not serve the file Let's Encrypt asks for, which is the thing to fix first."));

        if (r.outside) {
            for (const key of ['http', 'https']) {
                const p = r.outside[key];
                const port = p.port;
                // Port 80 is always identified -- the check fetches a file
                // from this machine. Port 443 only once a certificate exists,
                // and saying which is which is the difference between "it
                // works" and "something out there answered".
                const identified = key === 'http' || p.identified;
                rows.push(
                    line(
                        p.open,
                        `Port ${port}: ${
                            p.open
                                ? identified
                                    ? 'reaches this machine'
                                    : 'something accepts connections, which may be your router rather than this machine'
                                : p.open === null
                                  ? 'no answer in time'
                                  : 'does not reach this machine'
                        } (${p.detail}).`,
                    ),
                );
            }
        } else {
            rows.push(line(null, `Could not check from outside: ${r.error ?? 'unknown reason'}.`));
        }

        const bothOpen = r.outside && r.outside.http?.open && r.outside.https?.open;
        // A DuckDNS name is proved with a TXT record, so a closed http port
        // costs the ability to serve plain http and nothing else. Reporting
        // that as a failure would send someone into their router for no reason.
        const certNote = r.dnsChallenge
            ? ' Certificates do not depend on any of this: your DuckDNS name is proved with a DNS record.'
            : " Let's Encrypt validates over port 80, so that one has to reach this machine before a certificate can be issued.";

        const verdict = bothOpen
            ? `<p class="muted">Both ports reach this machine.${certNote}</p>`
            : r.outside && r.local.servesChallenge
              ? `<p class="muted">This machine is set up correctly, so what is missing is the forwarding. Two numbers per rule, and they are not the same one: the outside port is what the internet dials, the forward port is what this machine listens on. On your router, external <strong>${escapeHtml(String(r.outside.http.port))}</strong> to this machine on port <strong>${escapeHtml(String(r.local.bindHttp))}</strong>, and external <strong>${escapeHtml(String(r.outside.https.port))}</strong> to port <strong>${escapeHtml(String(r.local.bindHttps))}</strong>. A rule that forwards ${escapeHtml(String(r.outside.http.port))} to ${escapeHtml(String(r.outside.http.port))} arrives at a port nothing is bound to.${certNote}</p>`
              : '';

        out.innerHTML = `<ul class="port-result">${rows.join('')}</ul>${verdict}`;
    } catch (e) {
        out.innerHTML = `<p class="error">${escapeHtml(e.message)}</p>`;
    } finally {
        button.disabled = false;
        button.textContent = 'Check from outside';
    }
});

// ------------------------------------------------------- kassigner verify ---

/**
 * Runs the firmware check and shows the whole comparison.
 *
 * The output is the feature, not the verdict: this is a device that holds keys,
 * and "trust me, it matched" is worth less than a log naming both hashes for
 * every file. So it streams into the tab rather than a modal that closes.
 */
$('kassigner-verify-btn').addEventListener('click', async () => {
    const button = $('kassigner-verify-btn');
    const state = $('kassigner-verify-state');

    button.disabled = true;
    state.textContent = 'checking';
    state.className = 'tag';

    claimJob('Verify KasSigner', {
        el: $('kassigner-verify-log'),
        state,
        onEnd: (job) => {
            const ok = job.status === 'succeeded';
            state.textContent = ok ? 'matches the release' : 'failed';
            state.className = `tag ${ok ? 'ok' : 'off'}`;
            button.disabled = false;
        },
    });

    try {
        await api('/api/kassigner/verify', { method: 'POST', body: {} });
    } catch (e) {
        inlineJob = null;
        state.textContent = 'failed';
        state.className = 'tag off';
        button.disabled = false;
        toast(e.message, 'bad');
    }
});

// -------------------------------------------------------------- lifecycle ---

/**
 * Install, run, uninstall.
 *
 * The sidebar switch used to mean "exists or does not", so turning something
 * off threw away an hour of building. Now a service that has never been
 * installed offers a button that says so, and the switch only appears once
 * there is something to switch: from then on it starts and stops, and nothing
 * it does removes anything.
 *
 * Removing is its own tab, per service, and says what it will delete.
 */
let serviceState = {};

const UNINSTALL_COPY = {
    kachat: 'the indexed chat history and its Postgres database',
    desktop: 'nothing: it keeps no state of its own',
    nextcloud: 'every file, photo and calendar stored in it',
    gift: 'the record of who has already claimed a gift',
    node: 'the entire synced blockchain. Tens of gigabytes, and days of syncing to get back',
    kassigner: 'the downloaded firmware and the record of what was verified. A device you have already flashed is unaffected',
    mining: "the bridge's own share and block records",
    proxy: 'nothing. Your domains and certificates live in the stack directory and are kept',
};

async function loadServices() {
    try {
        serviceState = (await api('/api/services')).services ?? {};
    } catch {
        return;
    }
    for (const [key, state] of Object.entries(serviceState)) {
        renderServiceRow(key, state);
        renderInstallGate(key, state);
    }
    renderUninstallCards();
}

/** The sidebar row: a button before it exists, a switch after. */
function renderServiceRow(key, state) {
    const input = navSwitch(key);
    if (!input) return;
    const label = input.closest('.switch');
    const row = label?.closest('.nav-row');
    if (!row) return;

    let button = row.querySelector('[data-install]');
    if (!button) {
        button = document.createElement('button');
        button.className = 'nav-install';
        button.dataset.install = key;
        button.textContent = 'Install';
        row.appendChild(button);
    }

    const installed = Boolean(state?.installed);
    // Something with nothing to run gets the Install button like everything
    // else, and then no control at all. KasSigner's switch used to be its
    // install -- flipping it downloaded firmware -- which left it showing a
    // toggle where every other service showed Install, and a toggle that
    // claimed to start something that does not run.
    const runnable = state?.runnable !== false;

    button.hidden = installed;
    if (label) label.hidden = !installed || !runnable;

    // Set before any tab has been opened, so a service nobody has looked at
    // still shows the right colour.
    setNavHealth(state?.tab ?? key, !installed ? 'absent' : state.running ? 'ok' : 'bad');

    // A switch that is showing should say what is actually true, without
    // waiting for the next status poll to correct it.
    if (installed && runnable && input.dataset.busy !== '1') input.checked = Boolean(state.running);
}

/**
 * A service that is not installed has nothing to show, so it does not show it.
 *
 * The page underneath is real markup with empty numbers and dead switches, and
 * reading it as though it meant something is the obvious mistake. Blurred and
 * covered, it reads as what it is: a preview of what installing gets you.
 */
function renderInstallGate(key, state) {
    // The switch key and the tab name are not always the same word: the node's
    // switch is 'node' and its tab is 'kaspad'.
    const section = document.getElementById(`tab-${state?.tab ?? key}`);
    if (!section) return;

    const installed = Boolean(state?.installed);
    section.classList.toggle('not-installed', !installed);

    let gate = section.querySelector(':scope > .install-gate');
    if (installed) return gate?.remove();

    if (!gate) {
        gate = document.createElement('div');
        gate.className = 'install-gate';
        section.appendChild(gate);
    }
    const label = escapeHtml(state?.label ?? key);
    gate.innerHTML = `
      <div class="install-gate-card">
        <h3>${label} is not installed</h3>
        <p class="muted">${
            state?.runnable === false
                ? 'Installing downloads the firmware and checks it against the hashes the release publishes.'
                : 'Installing builds its image and creates its container. Everything behind this is what it will look like.'
        }</p>
        <button class="primary big" data-install="${escapeHtml(key)}">Install ${label}</button>
      </div>`;
}

function renderUninstallCards() {
    for (const card of document.querySelectorAll('.uninstall-card')) {
        const key = card.dataset.uninstall;
        const state = serviceState[key];
        const installed = Boolean(state?.installed);

        card.innerHTML = `
      <h3>Uninstall ${escapeHtml(state?.label ?? key)}</h3>
      <p class="muted">
        Removes the containers, the images built for it, and by default its data.
        Everything else in the panel leaves all of that alone: stopping a service
        keeps it, and this is the only place that does not.
      </p>
      <div class="notice">
        <p><strong>What goes:</strong> ${escapeHtml(UNINSTALL_COPY[key] ?? 'its data')}.</p>
        <p class="muted">Installing it again afterwards starts from nothing, and rebuilds.</p>
      </div>
      <label class="check">
        <input type="checkbox" data-keepdata="${key}"> Keep the data, remove only the containers and images
      </label>
      <div class="row">
        <button class="ghost danger" data-douninstall="${key}" ${installed ? '' : 'disabled'}>
          ${installed ? 'Uninstall' : 'Not installed'}
        </button>
        <span class="muted">${installed ? '' : 'There is nothing here to remove.'}</span>
      </div>`;
    }
}

document.addEventListener('click', async (event) => {
    const key = event.target?.dataset?.install;
    if (!key) return;

    event.target.disabled = true;
    try {
        await api(`/api/services/${key}/install`, { method: 'POST' });
        openConsole(`Installing ${serviceState[key]?.label ?? key}`);
    } catch (e) {
        toast(e.message, 'bad');
        event.target.disabled = false;
    }
});

document.addEventListener('click', async (event) => {
    const key = event.target?.dataset?.douninstall;
    if (!key) return;

    const state = serviceState[key];
    const keepData = document.querySelector(`[data-keepdata="${key}"]`)?.checked === true;
    const what = keepData ? 'its containers and images' : `its containers, images and ${UNINSTALL_COPY[key]}`;

    // Typed rather than clicked. This is the one action in the panel that
    // deletes something a person cannot get back.
    const typed = prompt(
        `This removes ${what}.\n\nThis cannot be undone. Type the name to confirm:\n\n  ${key}`,
    );
    if (typed !== key) return toast(typed === null ? 'Nothing was removed.' : 'That did not match, so nothing was removed.');

    event.target.disabled = true;
    try {
        await api(`/api/services/${key}/uninstall`, { method: 'POST', body: { confirm: key, keepData } });
        openConsole(`Uninstalling ${state?.label ?? key}`);
    } catch (e) {
        toast(e.message, 'bad');
        event.target.disabled = false;
    }
});

// ------------------------------------------------------------ gift service ---

/**
 * The gift service: a faucet that hands a new KaChat user their first 3 KAS.
 *
 * The panel's job here is the credentials. Apple hands out a .p8 exactly once
 * and Google a service account JSON, both authenticate as somebody's app, and
 * both arrive by being pasted into a box. So the wizard's last step is a real
 * request to the real store, because a wrong key id and a revoked key produce
 * the same silence months later, when a user taps a button.
 */
let giftState = { config: {}, status: null, credentials: {} };

async function loadGift() {
    try {
        giftState = await api('/api/gift');
    } catch {
        return;
    }
    const { config, status, container, credentials } = giftState;

    const running = Boolean(container?.running);
    const badge = $('gift-state');
    badge.textContent = running ? (status ? 'running' : 'starting') : container?.status || 'off';
    badge.className = `tag ${running && status ? 'ok' : running ? '' : 'off'}`;
    setNavSwitch('gift', Boolean(config.enabled));
    setNavHealth('gift', !config.enabled ? 'off' : running && status ? 'ok' : 'warn');

    $('gift-mode').textContent = status
        ? status.mode === 'live'
            ? 'sending for real'
            : 'recording only, sending nothing'
        : config.mode === 'live'
          ? 'sending for real (not running)'
          : 'recording only (not running)';
    $('gift-amount').textContent = `${config.amountKas ?? 3} KAS`;
    $('gift-today').textContent = status ? `${status.claims.paidTodayKas} of ${status.caps.dailyKas} KAS` : '–';
    // The pool is the wallet's balance, which only exists once payouts do.
    $('gift-pool').textContent = status?.pool ? `${status.pool.balanceKas} KAS` : 'no wallet yet';
    $('gift-apple-count').textContent = status ? status.claims.apple : '–';
    $('gift-android-count').textContent = status ? status.claims.android : '–';

    $('gift-set-amount').value = config.amountKas ?? 3;
    $('gift-set-daily').value = config.dailyCapKas ?? 300;
    $('gift-set-floor').value = config.poolFloorKas ?? 50;
    $('gift-set-live').checked = config.mode === 'live';
    $('gift-ref').value = config.ref ?? 'main';
    $('gift-repo').textContent = giftState.repo ?? 'KaspaSilver/KaChat-Gift-Service';

    const ready = [
        credentials.apple ? 'iPhone ready' : 'iPhone not set up',
        credentials.google ? 'Android ready' : 'Android not set up',
    ].join(' · ');
    $('gift-credentials-state').textContent = ready;
    $('gift-overview-note').textContent = status
        ? status.mode === 'live'
            ? 'Claims are being paid.'
            : 'Claims are being checked and recorded, and nothing is being sent. Tick the box below when you have watched enough of them.'
        : config.enabled
          ? 'Switched on but not answering yet. Give it a moment, or look at the log.'
          : 'Switched off. Set up at least one phone, then start it from the switch beside the sidebar entry.';
}

/** What each console gives you, and where to find it. */
const GIFT_STEPS = {
    apple: {
        title: 'Set up iPhone',
        step1: 'What to get from App Store Connect',
        body: `
      <p>The claim is proved with <strong>DeviceCheck</strong>: two bits Apple stores
      against the device itself. That is why a reinstall, a restore or a wipe cannot
      clear "already claimed" &mdash; the mark was never on the phone.</p>
      <ol class="steps">
        <li><strong>Team ID</strong> &mdash; App Store Connect, <em>Membership</em>. Ten characters.</li>
        <li><strong>Bundle ID</strong> &mdash; your app's, exactly.</li>
        <li><strong>A key</strong> &mdash; <em>Users and Access</em> → <em>Integrations</em> →
        <em>App Store Connect API</em> → <strong>+</strong>, and tick <strong>DeviceCheck</strong>.
        Note the <strong>Key ID</strong> and download the <code>.p8</code>.</li>
      </ol>
      <p><strong>Apple gives you the .p8 once.</strong> There is no second download. If you
      lose it, revoke that key and make another.</p>`,
        test: "This asks Apple to answer a query signed with your key, carrying a deliberately fake device token. A 400 is the good answer: it means Apple accepted the key and rejected the token, which is exactly what it should do.",
    },
    android: {
        title: 'Set up Android',
        step1: 'What to get from Google',
        body: `
      <p>The claim is proved with <strong>Play Integrity</strong>: Google's own verdict on
      whether this is your app, from Play, on a real device.</p>
      <ol class="steps">
        <li><strong>Package name</strong> &mdash; as published. The debug build has its own and
        will not pass with the release one.</li>
        <li><strong>A service account</strong> &mdash; Google Cloud console, on the project linked
        to your Play listing: <em>IAM and Admin</em> → <em>Service Accounts</em> →
        <em>Create</em>, then <em>Keys</em> → <em>Add key</em> → <strong>JSON</strong>.</li>
        <li>Enable the <strong>Play Integrity API</strong> on that project, and link it under
        Play Console → <em>Monetise</em> → <em>App integrity</em>.</li>
      </ol>
      <p><strong>Worth knowing:</strong> Play Integrity proves the app, but it remembers
      nothing across reinstalls the way Apple's DeviceCheck does. On Android, repeat claims
      are bounded by the daily ceiling rather than prevented, so set that ceiling to what you
      are willing to lose in a day.</p>`,
        test: 'This asks Google for an access token with the service account, which is the same thing the service does on its first real claim.',
    },
};

let giftWizard = { platform: null, step: 1 };

function openGiftWizard(platform) {
    const copy = GIFT_STEPS[platform];
    giftWizard = { platform, step: 1 };

    $('gift-wizard-title').textContent = copy.title;
    $('gift-step1-title').textContent = copy.step1;
    $('gift-step1-body').innerHTML = copy.body;
    $('gift-test-intro').textContent = copy.test;
    $('gift-test-result').textContent = 'Not checked yet.';

    const cfg = giftState.config ?? {};
    $('gift-team-id').value = cfg.apple?.teamId ?? '';
    $('gift-key-id').value = cfg.apple?.keyId ?? '';
    $('gift-bundle-id').value = cfg.apple?.bundleId ?? 'com.kachat.app';
    $('gift-package').value = cfg.android?.packageName ?? 'com.kachat.app';
    // Never repopulated from the server: the panel does not read keys back out,
    // and an empty box here means "keep what is saved" rather than "erase it".
    $('gift-apple-key').value = '';
    $('gift-google-key').value = '';

    $('gift-apple-fields').hidden = platform !== 'apple';
    $('gift-android-fields').hidden = platform !== 'android';

    renderGiftStep();
    $('gift-wizard').showModal();
}

function renderGiftStep() {
    const { step } = giftWizard;
    for (const section of document.querySelectorAll('#gift-wizard-form .setup-step')) {
        section.hidden = Number(section.dataset.giftstep) !== step;
    }
    $('gift-wizard-back').hidden = step === 1;
    $('gift-wizard-next').hidden = step === 3;
    $('gift-wizard-save').hidden = step !== 2;
    $('gift-wizard-test').hidden = step !== 3;
}

$('gift-wizard-next').addEventListener('click', () => {
    giftWizard.step = Math.min(3, giftWizard.step + 1);
    renderGiftStep();
});
$('gift-wizard-back').addEventListener('click', () => {
    giftWizard.step = Math.max(1, giftWizard.step - 1);
    renderGiftStep();
});

$('gift-wizard-save').addEventListener('click', async () => {
    const { platform } = giftWizard;
    const body =
        platform === 'apple'
            ? {
                  teamId: $('gift-team-id').value.trim(),
                  keyId: $('gift-key-id').value.trim(),
                  bundleId: $('gift-bundle-id').value.trim(),
                  key: $('gift-apple-key').value.trim() || undefined,
              }
            : {
                  packageName: $('gift-package').value.trim(),
                  serviceAccount: $('gift-google-key').value.trim() || undefined,
              };

    $('gift-wizard-save').disabled = true;
    try {
        const r = await api(`/api/gift/${platform}`, { method: 'POST', body });
        if (!r.hasKey) {
            return toast('Saved, but there is still no key here. Paste the file contents in.', 'bad');
        }
        toast(`${platform === 'apple' ? 'iPhone' : 'Android'} credentials saved.`);
        // The key is out of the browser the moment it is saved.
        $('gift-apple-key').value = '';
        $('gift-google-key').value = '';
        giftWizard.step = 3;
        renderGiftStep();
        await loadGift();
    } catch (e) {
        toast(e.message, 'bad');
    } finally {
        $('gift-wizard-save').disabled = false;
    }
});

$('gift-wizard-test').addEventListener('click', async () => {
    const { platform } = giftWizard;
    const out = $('gift-test-result');
    $('gift-wizard-test').disabled = true;
    out.textContent = 'Asking…';
    try {
        const r = await api(`/api/gift/test/${platform}`, { method: 'POST', body: {} });
        out.textContent = `${r.ok ? 'OK' : 'Not working'}\n\n${r.detail}`;
    } catch (e) {
        out.textContent = e.message;
    } finally {
        $('gift-wizard-test').disabled = false;
    }
});

$('gift-setup-apple').addEventListener('click', () => openGiftWizard('apple'));
$('gift-setup-android').addEventListener('click', () => openGiftWizard('android'));

$('gift-save-settings').addEventListener('click', async () => {
    const live = $('gift-set-live').checked;
    if (live && giftState.config?.mode !== 'live') {
        const ok = confirm(
            'Send real Kaspa from now on?\n\n' +
                'Until now claims have been checked and recorded without paying. From here, a claim that passes ' +
                'Apple or Google is paid from the wallet, up to the daily ceiling.',
        );
        if (!ok) return;
    }

    try {
        await api('/api/gift/settings', {
            method: 'POST',
            body: {
                amountKas: Number($('gift-set-amount').value),
                dailyCapKas: Number($('gift-set-daily').value),
                poolFloorKas: Number($('gift-set-floor').value),
                mode: live ? 'live' : 'record-only',
            },
        });
        kResult('gift-settings-result', 'Saved. The service picks these up when it next starts.', false);
        await loadGift();
    } catch (e) {
        toast(e.message, 'bad');
    }
});

$('gift-rebuild').addEventListener('click', async () => {
    try {
        await api('/api/apps/gift', { method: 'PUT', body: { enabled: true, ref: $('gift-ref').value.trim() || 'main' } });
        openConsole('Rebuilding the gift service');
    } catch (e) {
        toast(e.message, 'bad');
    }
});

// ------------------------------------------------------------ setup wizard ---

/**
 * The guided path to a public address, which is the only path most people
 * should need. It asks for a DuckDNS name and a token, shows exactly what it is
 * about to change, and then does all of it: the DNS record, whatever the
 * service needs switched on, the vhost, and the certificate.
 *
 * The alternative -- add a domain, pick an upstream, remember to click "get
 * certificate" -- is still there under Domains and Advanced. This is for the
 * person who wants their node reachable and does not want to learn nginx to get
 * there.
 */
let setupState = { key: null, step: 1, plan: null, mode: 'new', domain: null };

async function openSetup(key) {
    const service = publishState.services.find((s) => s.key === key);
    setupState = { key, step: 1, plan: null, mode: 'new', domain: null };

    $('setup-title').textContent = `Publish ${service?.label ?? key}`;
    $('setup-error').hidden = true;
    $('setup-subdomain').value = '';
    $('setup-token').value = '';

    let info;
    try {
        info = await api(`/api/setup/${key}`);
    } catch (e) {
        return toast(e.message, 'bad');
    }
    setupState.plan = info;

    // A name and token already saved means this is someone's second service, so
    // the first two steps are a confirmation rather than a chore.
    if (info.duckdns?.subdomain) $('setup-subdomain').value = info.duckdns.subdomain;
    $('setup-token-note').hidden = !info.duckdns?.hasToken;
    $('setup-token').placeholder = info.duckdns?.hasToken ? 'unchanged' : 'from duckdns.org';
    $('setup-ip').textContent = info.publicIp
        ? `This connection looks like ${info.publicIp} from the outside. DuckDNS will point the name here.`
        : 'Could not work out this connection\'s public address, which is not fatal: DuckDNS uses the address it sees.';

    $('setup-after').textContent = (service?.afterNote ?? '').replace('{domain}', 'that name');
    $('setup-auth').checked = false;
    $('setup-auth-fields').hidden = true;
    $('setup-allowlist').value = '';

    // A second service starts from a list of names rather than from duckdns.org.
    renderDomainChoices();
    setupState.step = publishState.domains.length ? 0 : 1;
    renderSetupStep();
    $('setup-dialog').showModal();
}

/**
 * The domain list, which used to be a screen of its own. It only ever answered
 * two questions -- which names do I have, and can I get rid of this one -- and
 * both belong at the point where a name is being chosen.
 */
function renderDomainChoices() {
    const list = $('setup-domain-list');
    const service = publishState.services.find((s) => s.key === setupState.key);

    list.innerHTML = publishState.domains
        .map((d) => {
            const others = (d.hosts ?? []).filter((h) => h.kind !== service?.kind);
            const mine = (d.hosts ?? []).find((h) => h.kind === service?.kind);

            // A name can carry several services, so "in use" is information
            // rather than a refusal. The one arrangement that cannot work is a
            // service that must own the root joining a name whose root is taken.
            const blocked = service?.rootOnly && !d.rootFree && !mine;
            const sharing = others
                .map((h) => `${serviceLabel(h.kind)}${h.path === '/' ? '' : ` at ${h.path}`}`)
                .join(', ');

            const note = blocked
                ? `${serviceLabel(d.usedBy)} is at the root, and this has to be`
                : mine
                  ? `already serving this${mine.path === '/' ? '' : ` at ${mine.path}`}`
                  : others.length
                    ? `shared with ${sharing}, so this joins at ${escapeHtml(service?.sharedPath ?? '/' + setupState.key)}`
                    : d.certificate
                      ? 'free, and has an HTTPS certificate'
                      : 'free, no certificate yet';

            return `<label class="domain-choice${blocked ? ' taken' : ''}">
        <input type="radio" name="setup-domain" value="${escapeHtml(d.domain)}"${blocked ? ' disabled' : ''}>
        <span>
          <strong>${escapeHtml(d.domain)}</strong>
          <small>${note}</small>
        </span>
        ${(d.hosts ?? []).length ? '' : `<button type="button" class="ghost danger" data-domain-del="${d.id}">Remove</button>`}
      </label>`;
        })
        .join('')
        .concat(
            `<label class="domain-choice">
        <input type="radio" name="setup-domain" value="" checked>
        <span><strong>Create another DuckDNS name</strong><small>free, and kept pointed here for you</small></span>
      </label>`,
        );
}

$('setup-domain-list').addEventListener('click', async (event) => {
    const id = event.target.dataset?.domainDel;
    if (!id) return;
    const record = publishState.domains.find((d) => d.id === id);
    if (!confirm(`Remove ${record?.domain}?\n\nNothing is published on it, so this only takes the name off the list.`)) return;
    try {
        await api(`/api/domains/${id}`, { method: 'DELETE' });
        await loadPublish();
        renderDomainChoices();
    } catch (e) {
        toast(e.message, 'bad');
    }
});

/** The name this run will publish on, whichever way it was chosen. */
const setupDomain = () =>
    setupState.mode === 'existing'
        ? setupState.domain
        : `${$('setup-subdomain').value.trim().toLowerCase()}.duckdns.org`;

function renderSetupStep() {
    const { step, plan } = setupState;
    for (const section of document.querySelectorAll('#setup-form .setup-step')) {
        section.hidden = Number(section.dataset.step) !== step;
    }
    $('setup-back').hidden = step === (publishState.domains.length ? 0 : 1);
    $('setup-next').hidden = step === 3;
    $('setup-run').hidden = step !== 3;

    if (step !== 3) return;

    const domain = setupDomain();
    const record = publishState.domains.find((d) => d.domain === domain);
    const joining = (record?.hosts ?? []).filter((h) => h.kind !== plan.service.kind);
    // The address is the name plus wherever this service lands on it, which is
    // not always the root once a name is shared.
    const path = joining.some((h) => h.path === '/') ? (plan.service.sharedPath ?? `/${setupState.key}`) : '';
    setupState.address = `https://${domain}${path}`;

    $('setup-summary').textContent = joining.length
        ? `${plan.service.label} will answer on ${setupState.address}, alongside ${joining
              .map((h) => serviceLabel(h.kind))
              .join(', ')} already on that name. Everything below happens in one go:`
        : `${plan.service.label} will answer on ${setupState.address}. Everything below happens in one go:`;
    $('setup-plan').innerHTML = (plan.steps ?? [])
        // The DNS step belongs to creating a name. Choosing one that is already
        // here skips it, and listing it anyway would promise work that will not
        // happen.
        .filter((st) => !(st.key === 'dns' && setupState.mode === 'existing'))
        .map(
            (st) => `<li class="${st.done ? 'done' : ''}">
        <strong>${escapeHtml(st.label)}</strong>${st.done ? ' <span class="tag ok">already done</span>' : ''}
        <small>${escapeHtml(st.detail ?? '')}</small>
      </li>`,
        )
        .join('');

    const svc = publishState.services.find((s) => s.key === setupState.key);
    $('setup-after').textContent = (svc?.afterNote ?? '').replace('{domain}', setupState.address.replace(/^https:\/\//, ''));
}

$('setup-next').addEventListener('click', () => {
    const { step } = setupState;
    $('setup-error').hidden = true;

    if (step === 0) {
        const chosen = document.querySelector('input[name="setup-domain"]:checked')?.value ?? '';
        setupState.mode = chosen ? 'existing' : 'new';
        setupState.domain = chosen || null;
        // A name already here needs nothing else: no token to save, and the
        // certificate is issued without a contact address.
        setupState.step = chosen ? 3 : 1;
        renderSetupStep();
        return;
    }

    if (step === 1) {
        const name = $('setup-subdomain').value.trim().toLowerCase().replace(/\.duckdns\.org\.?$/, '');
        if (!/^[a-z0-9-]{1,63}$/.test(name)) return toast('Enter the name you created at duckdns.org.', 'bad');
        $('setup-subdomain').value = name;
    }

    if (step === 2) {
        // A name already on this panel needs no token: either it is already
        // being refreshed, or it is not a DuckDNS name in the first place.
        if (!$('setup-token').value.trim() && !setupState.plan?.duckdns?.hasToken) {
            return toast('Paste the token from duckdns.org.', 'bad');
        }
    }

    setupState.step = Math.min(3, step + 1);
    renderSetupStep();
});

$('setup-back').addEventListener('click', () => {
    const { step, mode } = setupState;
    // Coming back from the plan on an existing name lands on the list it was
    // chosen from, not on the DuckDNS steps it never saw.
    setupState.step = step === 3 && mode === 'existing' ? 0 : Math.max(publishState.domains.length ? 0 : 1, step - 1);
    renderSetupStep();
});

$('setup-auth').addEventListener('change', (event) => {
    $('setup-auth-fields').hidden = !event.target.checked;
});

$('setup-run').addEventListener('click', async () => {
    const { key, mode, domain } = setupState;
    const body = {
        domain: mode === 'existing' ? domain : undefined,
        subdomain: mode === 'existing' ? undefined : $('setup-subdomain').value.trim(),
        token: $('setup-token').value.trim(),
        auth: $('setup-auth').checked
            ? { enabled: true, user: $('setup-auth-user').value.trim(), password: $('setup-auth-pass').value }
            : { enabled: false },
        allowlist: $('setup-allowlist').value,
    };

    $('setup-run').disabled = true;
    try {
        const r = await api(`/api/setup/${key}`, { method: 'POST', body });
        $('setup-dialog').close();
        // The job console is where every long job in this panel reports, and
        // this one has more to say than a toast can hold.
        openConsole(`Publishing on ${r.domain}`);
    } catch (e) {
        const box = $('setup-error');
        box.textContent = e.message;
        box.hidden = false;
    } finally {
        $('setup-run').disabled = false;
    }
});




$('proxy-reload').addEventListener('click', async () => {
    try {
        await api('/api/proxy/reload', { method: 'POST' });
        toast('nginx configuration reloaded.', 'good');
    } catch (e) {
        toast(e.message, 'bad');
    }
});

$('proxy-renew').addEventListener('click', async () => {
    try {
        await api('/api/proxy/renew', { method: 'POST' });
        openConsole('Renewing certificates');
    } catch (e) {
        toast(e.message, 'bad');
    }
});

let editingId = null;

function openProxyDialog(proxy) {
    editingId = proxy?.id ?? null;
    $('proxy-dialog-title').textContent = proxy ? `Edit ${proxy.domain}` : 'Add proxy host';
    $('px-error').hidden = true;

    const kind = proxy?.target?.kind ?? 'borsh';
    $('px-target').innerHTML = Object.entries(targetKinds)
        .map(([key, meta]) => `<option value="${key}">${escapeHtml(meta.label ?? key)}</option>`)
        .join('');
    // A host pointing at something this panel no longer offers keeps its own
    // option, so opening it cannot silently repoint it at the first in the list.
    if (kind && !targetKinds[kind]) {
        $('px-target').insertAdjacentHTML('beforeend', `<option value="${escapeHtml(kind)}">${escapeHtml(kind)}</option>`);
    }

    $('px-domain').value = proxy?.domain ?? '';
    $('px-target').value = kind;
    $('px-scheme').value = proxy?.target?.scheme ?? 'http';
    $('px-host').value = proxy?.target?.host ?? '';
    $('px-port').value = proxy?.target?.port ?? '';
    $('px-websocket').checked = proxy?.websocket ?? true;
    $('px-tls').checked = proxy?.ssl?.mode === 'letsencrypt';
    $('px-email').value = proxy?.ssl?.email ?? '';
    $('px-forcehttps').checked = proxy?.ssl?.forceHttps !== false;
    $('px-staging').checked = false;
    $('px-auth').checked = Boolean(proxy?.auth?.enabled);
    $('px-user').value = proxy?.auth?.user ?? '';
    $('px-pass').value = '';
    $('px-allow').value = (proxy?.allowlist ?? []).join('\n');
    $('px-rate').value = proxy?.rateLimit ?? '';
    $('px-enabled').checked = proxy?.enabled !== false;

    toggleCustomTarget();
    $('proxy-dialog').showModal();
}

const toggleCustomTarget = () => {
    $('px-custom').hidden = $('px-target').value !== 'custom';
};
$('px-target').addEventListener('change', toggleCustomTarget);

$('proxy-form').addEventListener('submit', async (event) => {
    if (event.submitter?.value !== 'save') return; // cancel
    event.preventDefault();

    const err = $('px-error');
    err.hidden = true;

    const payload = {
        domain: $('px-domain').value.trim().toLowerCase(),
        enabled: $('px-enabled').checked,
        websocket: $('px-websocket').checked,
        target: {
            kind: $('px-target').value,
            scheme: $('px-scheme').value,
            host: $('px-host').value.trim(),
            port: Number($('px-port').value) || undefined,
        },
        ssl: {
            mode: $('px-tls').checked ? 'letsencrypt' : 'none',
            email: $('px-email').value.trim(),
            forceHttps: $('px-forcehttps').checked,
        },
        auth: {
            enabled: $('px-auth').checked,
            user: $('px-user').value.trim(),
            password: $('px-pass').value || undefined,
        },
        allowlist: lines('px-allow'),
        rateLimit: Number($('px-rate').value) || null,
    };

    try {
        if (editingId) await api(`/api/proxies/${editingId}`, { method: 'PUT', body: { proxy: payload } });
        else await api('/api/proxies', { method: 'POST', body: { proxy: payload } });

        $('proxy-dialog').close();
        await loadProxies();
        toast('Proxy host saved.', 'good');

        // A brand new https host has no certificate yet; offer to fetch it now.
        const saved = proxies.find((p) => p.domain === payload.domain);
        if (saved && payload.ssl.mode === 'letsencrypt' && !saved.certificate) {
            if (confirm(`Request a Let's Encrypt certificate for ${payload.domain} now?\n\nPort 80 must already reach this machine.`)) {
                await api(`/api/proxies/${saved.id}/certificate`, {
                    method: 'POST',
                    body: { email: payload.ssl.email, staging: $('px-staging').checked },
                });
                openConsole(`Issuing certificate for ${payload.domain}`);
            }
        }
    } catch (e) {
        err.textContent = e.message;
        err.hidden = false;
    }
});

// ---------------------------------------------------------------- duckdns ---

/**
 * DuckDNS has no screen of its own any more: the wizard sets the name and the
 * token, and this is the one line that says whether the refresh is alive. The
 * public address it also reports is used on the Kaspad ports page.
 */
async function loadDuckDns() {
    const r = await api('/api/duckdns');
    $('public-ip').textContent = r.publicIp || 'unknown';

    const names = r.duckdns.domains
        ? r.duckdns.domains
              .split(',')
              .filter(Boolean)
              .map((d) => `${d}.duckdns.org`)
              .join(', ')
        : '';
    const last = r.duckdns.lastRunAt
        ? `checked ${new Date(r.duckdns.lastRunAt).toLocaleTimeString()}, ${r.duckdns.lastResult}`
        : 'not checked yet';

    $('duck-status').textContent = r.duckdns.enabled
        ? `DuckDNS: ${names} (${last}, every ${r.duckdns.intervalMinutes} min)`
        : 'DuckDNS: nothing set up yet. Set up a service and it is arranged for you.';
}

$('dd-now').addEventListener('click', async () => {
    try {
        const r = await api('/api/duckdns/update', { method: 'POST' });
        toast(`Updated ${r.domains.join(', ')}`, 'good');
        loadDuckDns();
    } catch (e) {
        toast(e.message, 'bad');
    }
});

// ------------------------------------------------------------------- logs ---

// Log text size, kept per view. Each log is read for its own reasons -- one
// gets skimmed for a single line, another gets stared at -- so a size that
// suits one is rarely the size that suits the next.
const LOG_ZOOM_KEY = 'kaspa-node-log-size';
const LOG_SIZE_MIN = 9;
const LOG_SIZE_MAX = 22;
const LOG_SIZE_DEFAULT = 11.5;
const LOG_SIZE_STEP = 1.5;

const logSizeKey = (view) => `${LOG_ZOOM_KEY}:${view}`;

function logSize(view) {
    const stored = Number(localStorage.getItem(logSizeKey(view)));
    return Number.isFinite(stored) && stored >= LOG_SIZE_MIN && stored <= LOG_SIZE_MAX ? stored : LOG_SIZE_DEFAULT;
}

/**
 * Sets the size on the view's own element, so the variable resolves for that
 * subtree only. The buttons that drive it disable at the ends of the range.
 */
function applyLogSize(view, size) {
    const clamped = Math.min(LOG_SIZE_MAX, Math.max(LOG_SIZE_MIN, size));
    const nodes = document.querySelectorAll(`[data-logview="${view}"]`);
    // One id, one view. Styling every match keeps this correct even if a view
    // id is ever reused, instead of silently resizing whichever came first.
    for (const node of nodes) node.style.setProperty('--log-size', `${clamped}px`);
    try {
        localStorage.setItem(logSizeKey(view), String(clamped));
    } catch {
        /* private browsing: the size just will not persist */
    }
    for (const button of document.querySelectorAll(`[data-zoom][data-zoom-view="${view}"]`)) {
        const step = Number(button.dataset.zoom);
        button.disabled = step < 0 ? clamped <= LOG_SIZE_MIN : clamped >= LOG_SIZE_MAX;
    }
    return clamped;
}

/** Re-applies a stored size to a view, for tiles that are created later. */
function restoreLogSize(view) {
    applyLogSize(view, logSize(view));
}

document.addEventListener('click', (event) => {
    const button = event.target.closest?.('[data-zoom][data-zoom-view]');
    if (!button) return;
    const view = button.dataset.zoomView;
    const node = document.querySelector(`[data-logview="${view}"]`);
    // Keep a view that is pinned to the bottom pinned after the text resizes.
    const atBottom = node ? node.scrollHeight - node.scrollTop - node.clientHeight < 4 : false;
    applyLogSize(view, logSize(view) + Number(button.dataset.zoom) * LOG_SIZE_STEP);
    if (node && atBottom) node.scrollTop = node.scrollHeight;
});

restoreLogSize('kaspad');

// None of these is a service, so their dots stay hollow rather than implying a
// state they cannot have.
setNavHealth('logs', 'none');
setNavHealth('global', 'none');
setNavHealth('support', 'none');

// One tile per container, all fed by a single multiplexed EventSource. Per-tile
// streams would need one connection each, and browsers cap concurrent
// HTTP/1.1 connections per origin at about six -- which the status poll and the
// job console also need.
let logStream = null;
const logBuffers = new Map();
const LOG_TILE_LINES = 400;

function logTile(key, label) {
    return `<article class="log-tile" data-tile="${key}">
      <div class="log-tile-head">
        <span class="dot" data-tiledot="${key}"></span>
        <span class="name">${escapeHtml(label)}</span>
        <span class="count" data-tilecount="${key}">0</span>
        <span class="zoom" role="group" aria-label="Text size"><button type="button" class="zoom-btn" data-zoom="-1" data-zoom-view="tile:${key}" title="Smaller text">−</button><button type="button" class="zoom-btn" data-zoom="1" data-zoom-view="tile:${key}" title="Larger text">+</button></span>
        <button type="button" data-expand="${key}" title="Expand this one to full width">⤢</button>
        <button type="button" data-clear="${key}" title="Clear">✕</button>
      </div>
      <pre data-tilelog="${key}" data-logview="tile:${key}"></pre>
    </article>`;
}

function renderLogTile(key) {
    const pre = document.querySelector(`[data-tilelog="${key}"]`);
    if (!pre) return;
    const buf = logBuffers.get(key) ?? [];
    const filter = $('log-filter').value.trim().toLowerCase();
    const shown = filter ? buf.filter((l) => l.toLowerCase().includes(filter)) : buf;

    // While filtering, a container with no match is dropped rather than left as
    // an empty box: the point of a filter is to be shown only what matched.
    const tile = document.querySelector(`[data-tile="${key}"]`);
    if (tile) tile.hidden = Boolean(filter) && shown.length === 0;

    pre.textContent = shown.join('\n');
    const count = document.querySelector(`[data-tilecount="${key}"]`);
    if (count) count.textContent = filter ? `${shown.length}/${buf.length}` : String(buf.length);
    if ($('log-follow').checked) pre.scrollTop = pre.scrollHeight;
}

/** Keeps the toolbar honest about what the filter is hiding. */
function updateLogSummary() {
    const tiles = [...document.querySelectorAll('.log-tile')];
    if (!tiles.length) return;
    const visible = tiles.filter((t) => !t.hidden);
    const filter = $('log-filter').value.trim();
    const note = $('logs-note');

    if (!filter) {
        note.textContent = `${tiles.length} container${tiles.length === 1 ? '' : 's'} running`;
    } else if (visible.length) {
        note.textContent = `${visible.length} of ${tiles.length} container${tiles.length === 1 ? '' : 's'} match “${filter}”`;
    } else {
        note.textContent = `Nothing matches “${filter}”`;
    }

    let empty = document.getElementById('log-no-match');
    if (!visible.length && filter) {
        if (!empty) {
            empty = document.createElement('p');
            empty.id = 'log-no-match';
            empty.className = 'empty-tile';
            $('log-grid').appendChild(empty);
        }
        empty.textContent = `No lines in any container match “${filter}”.`;
        empty.hidden = false;
    } else if (empty) {
        empty.hidden = true;
    }
}

function connectLogs() {
    logStream?.close();
    logBuffers.clear();
    const grid = $('log-grid');
    grid.innerHTML = '<p class="empty-tile">Connecting…</p>';

    logStream = new EventSource('/api/logs/stream-all');

    logStream.addEventListener('containers', (event) => {
        const { containers } = JSON.parse(event.data);
        $('logs-note').textContent = containers.length
            ? `${containers.length} container${containers.length === 1 ? '' : 's'} running`
            : '';
        // The tiles are about to be replaced, so anything lifted over them is
        // gone too; leaving the scrim would dim the page with nothing on top.
        closeLogOverlay();
        grid.innerHTML = containers.length
            ? containers.map((c) => logTile(c.key, c.label)).join('')
            : '<p class="empty-tile">No containers are running.</p>';
        for (const c of containers) {
            logBuffers.set(c.key, []);
            // The tile was just recreated, so its stored size needs reapplying.
            restoreLogSize(`tile:${c.key}`);
            const dot = document.querySelector(`[data-tiledot="${c.key}"]`);
            if (dot) dot.className = 'dot ok';
        }
        updateLogSummary();
    });

    logStream.addEventListener('line', (event) => {
        const { key, line } = JSON.parse(event.data);
        const buf = logBuffers.get(key);
        if (!buf) return;
        buf.push(line);
        if (buf.length > LOG_TILE_LINES) buf.splice(0, buf.length - LOG_TILE_LINES);
        const wasHidden = document.querySelector(`[data-tile="${key}"]`)?.hidden;
        renderLogTile(key);
        // A newly arrived line can pull a hidden container back into the match.
        if (wasHidden !== document.querySelector(`[data-tile="${key}"]`)?.hidden) updateLogSummary();
    });

    logStream.addEventListener('error', () => {
        for (const dot of document.querySelectorAll('[data-tiledot]')) dot.className = 'dot bad';
    });
}

/**
 * Lifts one log out of the grid and centres it over the rest.
 *
 * The tile is not moved in the DOM, only positioned over everything else, so it
 * keeps receiving the same stream it was already getting. Re-parenting it would
 * have meant rebuilding the element and losing whatever had scrolled past.
 */
let logOverlay = null;

function toggleLogOverlay(key) {
    const tile = document.querySelector(`[data-tile="${key}"]`);
    if (!tile) return;
    if (logOverlay === key) return closeLogOverlay();

    closeLogOverlay();
    tile.classList.add('expanded');
    logOverlay = key;

    const scrim = document.createElement('div');
    scrim.className = 'log-scrim';
    scrim.addEventListener('click', closeLogOverlay);
    document.body.appendChild(scrim);

    // A log pinned to the bottom should still be pinned after it changes size.
    const pre = tile.querySelector('pre');
    if (pre) pre.scrollTop = pre.scrollHeight;
}

function closeLogOverlay() {
    if (!logOverlay) return;
    document.querySelector(`[data-tile="${logOverlay}"]`)?.classList.remove('expanded');
    document.querySelector('.log-scrim')?.remove();
    logOverlay = null;
}

// Escape closes it, which is what every other overlay on the web does.
document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') closeLogOverlay();
});

$('log-filter').addEventListener('input', () => {
    for (const key of logBuffers.keys()) renderLogTile(key);
    updateLogSummary();
});

$('log-grid').addEventListener('click', (event) => {
    const expand = event.target.dataset?.expand;
    const clear = event.target.dataset?.clear;
    if (expand) {
        toggleLogOverlay(expand);
    } else if (clear) {
        logBuffers.set(clear, []);
        renderLogTile(clear);
    }
});

// ---------------------------------------------------------------- console ---

let jobStream = null;

/**
 * What is waiting behind the job on screen. The console shows one job at a
 * time, so without this a queue of three looks like one.
 */
function renderQueue(pending) {
    const node = $('console-queue');
    if (!node) return;
    const list = pending ?? [];
    node.hidden = list.length === 0;
    node.textContent = list.length ? `then: ${list.map((j) => j.name).join(', ')}` : '';
}

const refreshQueueSoon = debounce(async () => {
    try {
        const { job } = await api('/api/jobs/current');
        renderQueue(job?.pending);
    } catch {
        /* the console is cosmetic */
    }
}, 250);

function openConsole(title) {
    $('console-title').textContent = title;
    $('console-body').textContent = '';
    $('console').classList.remove('hidden');
}

$('console-close').addEventListener('click', () => $('console').classList.add('hidden'));

function appendConsole(line) {
    const body = $('console-body');
    body.textContent += `${line}\n`;
    body.scrollTop = body.scrollHeight;
}

/**
 * A job that renders on its own page rather than in the console overlay.
 *
 * Flashing is watched from the screen you started it on: you have a board in
 * your hand and the port you picked is on that screen, so throwing a modal over
 * it hides the context you need if something goes wrong.
 */
let inlineJob = null;

function claimJob(namePrefix, { el, state, onEnd }) {
    inlineJob = { namePrefix, el, state, onEnd };
    el.textContent = '';
}

function inlineJobHandles(name) {
    return inlineJob && String(name || '').startsWith(inlineJob.namePrefix);
}

function appendInline(line) {
    const el = inlineJob.el;
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
    el.textContent += `${line}\n`;
    if (atBottom) el.scrollTop = el.scrollHeight;
}

function connectJobs() {
    jobStream?.close();
    jobStream = new EventSource('/api/jobs/stream');
    jobStream.addEventListener('snapshot', (event) => {
        const job = JSON.parse(event.data);
        if (job.status !== 'running') return;
        if (inlineJobHandles(job.name)) return;
        openConsole(job.name);
        $('console-body').textContent = `${job.lines.join('\n')}\n`;
    });
    jobStream.addEventListener('start', (event) => {
        const job = JSON.parse(event.data);
        renderQueue(job.pending);
        if (inlineJobHandles(job.name)) return;
        openConsole(job.name);
    });
    // Something was accepted but has not started. Saying so is the difference
    // between a queue and a click that appeared to do nothing.
    jobStream.addEventListener('queued', (event) => {
        const job = JSON.parse(event.data);
        if (job.ahead === 0 && !job.running) return;
        toast(`${job.name}: queued behind ${job.running ?? 'the job running now'}`);
        refreshQueueSoon();
    });
    jobStream.addEventListener('line', (event) => {
        const { line } = JSON.parse(event.data);
        if (inlineJob) return appendInline(line);
        appendConsole(line);
    });
    jobStream.addEventListener('end', (event) => {
        const job = JSON.parse(event.data);
        renderQueue(job.pending);
        // Whether a service exists changes when a job finishes, and nothing
        // else tells the page that. Without this the Install overlay sat there
        // for up to ten seconds after the log had already said Done.
        loadServices().catch(() => {});

        if (inlineJob) {
            appendInline(job.status === 'succeeded' ? '\n✓ Done.' : `\n✗ Failed: ${job.error}`);
            inlineJob.onEnd?.(job);
            inlineJob = null;
            refreshStatus();
            return;
        }
        appendConsole(job.status === 'succeeded' ? '\n✓ Done.' : `\n✗ Failed: ${job.error}`);
        toast(job.status === 'succeeded' ? `${job.name}: done` : `${job.name}: failed`, job.status === 'succeeded' ? 'good' : 'bad');
        refreshStatus();
        loadProxies();
        loadMining();
        loadApps();
        loadKassigner();
    });
}

// ------------------------------------------------------------------- boot ---

// Which services exist at all, which decides whether each row shows a button or
// a switch. Refreshed alongside the status poll so an install or an uninstall
// finishing is reflected without a reload.
setInterval(() => loadServices().catch(() => {}), 30_000);

api('/api/session')
    .then((s) => {
        if (s.panelVersion) $('version-badge').textContent = `v${s.panelVersion}`;
        renderPasswordCard(Boolean(s.required));
        // No password set: skip the sign-in screen entirely and say why, so the
        // absence of a login prompt reads as a decision rather than a bug.
        $('logout').hidden = !s.required;
        $('auth-note').hidden = Boolean(s.required);
        if (s.passwordUnusable) {
            // No password will be accepted, so say that rather than let someone
            // retype a correct one until they give up.
            const note = $('login-error');
            note.hidden = false;
            note.textContent =
                'The stored password cannot be read, so none will be accepted. It was truncated by an old bug in how the hash was saved. Clear ADMIN_PASSWORD_HASH in the .env file in your install directory, recreate the panel container, and set a new password from Global settings.';
        }
        if (s.authenticated) {
            showApp();
            loadServices().catch(() => {});
        } else showLogin();
    })
    .catch(() => showLogin());

// -------------------------------------------------------- admin password ---

/**
 * Setting a password is the one change that replaces the container serving this
 * page, so it cannot report success the way everything else does: the answer
 * arrives as the panel coming back with a sign-in screen.
 */
function renderPasswordCard(isSet) {
    $('password-state').textContent = isSet
        ? 'A password is required to open this panel. Change it below, or remove it if the panel is only ever reached from this machine.'
        : 'No password is set. Anyone who can reach this port has full control of the node and of Docker, which is why the installer keeps the panel on 127.0.0.1 until you set one.';
    $('password-current-row').hidden = !isSet;
    $('password-clear').hidden = !isSet;
    $('password-save').textContent = isSet ? 'Change it' : 'Set a password';
}

/**
 * Waits for the panel to go away and come back, then reloads. The restart is
 * done by a detached container a second or two after the request returns, so
 * "still answering" does not yet mean "finished".
 */
async function waitForPanelRestart(note) {
    const deadline = Date.now() + 120_000;
    let wentDown = false;
    kResult('password-result', note, false);

    while (Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 1500));
        try {
            const res = await fetch('/healthz', { cache: 'no-store' });
            if (res.ok && wentDown) return location.reload();
        } catch {
            wentDown = true;
        }
    }
    kResult('password-result', 'The panel has not come back. Check `docker logs kaspa-node-manager`.', true);
}

$('password-save').addEventListener('click', async () => {
    const password = $('password-new').value;
    const repeat = $('password-repeat').value;

    if (password.length < 8) return toast('Use at least 8 characters.', 'bad');
    if (password !== repeat) return toast('The two passwords are not the same.', 'bad');

    $('password-save').disabled = true;
    try {
        await api('/api/auth/password', {
            method: 'POST',
            body: { password, current: $('password-current').value },
        });
        $('password-new').value = '';
        $('password-repeat').value = '';
        $('password-current').value = '';
        await waitForPanelRestart('Password saved. The panel is restarting, and will ask you to sign in.');
    } catch (e) {
        toast(e.message, 'bad');
        $('password-save').disabled = false;
    }
});

$('panel-port-save').addEventListener('click', async () => {
    const port = Number($('panel-port').value);
    if (!confirm(`Move this panel to port ${port}?\n\nIt restarts, and this page will follow it to the new address. Anything you have bookmarked stops working.`)) return;

    $('panel-port-save').disabled = true;
    try {
        const r = await api('/api/panel/port', { method: 'POST', body: { port } });
        if (r.unchanged) return toast('It is already on that port.');
        // The address this page is on is about to stop answering, so it waits
        // for the new one rather than for this one to come back.
        kResult('panel-port-result', `Moving to port ${port}. This page will go there once it answers.`, false);
        const target = `${location.protocol}//${location.hostname}:${port}${location.pathname}`;
        const deadline = Date.now() + 120_000;
        while (Date.now() < deadline) {
            await new Promise((res) => setTimeout(res, 2000));
            try {
                await fetch(`${location.protocol}//${location.hostname}:${port}/healthz`, { mode: 'no-cors', cache: 'no-store' });
                return location.assign(target);
            } catch {
                /* not up yet */
            }
        }
        kResult('panel-port-result', `It has not answered on ${port} yet. Try ${target} directly.`, true);
    } catch (e) {
        toast(e.message, 'bad');
    } finally {
        $('panel-port-save').disabled = false;
    }
});

$('password-clear').addEventListener('click', async () => {
    if (!confirm('Remove the password?\n\nAnyone who can reach this port will then have full control of the node and of Docker. Only sensible while the panel is on 127.0.0.1.')) {
        return;
    }
    $('password-clear').disabled = true;
    try {
        await api('/api/auth/password', { method: 'POST', body: { clear: true, current: $('password-current').value } });
        await waitForPanelRestart('Password removed. The panel is restarting.');
    } catch (e) {
        toast(e.message, 'bad');
        $('password-clear').disabled = false;
    }
});

// -------------------------------------------------------- global settings ---

/**
 * Both actions here replace or delete the container serving this page, so
 * neither reports back the way every other job does. The panel does not get to
 * see the end of its own update: the request returns as soon as a detached
 * container has picked the work up, and the result is read out of a status file
 * once the panel is running again.
 */
async function loadGlobal() {
    const r = await api('/api/system');
    $('global-panel-version').textContent = r.panelVersion || '–';
    $('global-stack-dir').textContent = r.stackDir || '–';

    const last = r.lastUpdate;
    if (!last) return;
    kResult(
        'global-update-result',
        last.ok
            ? `Updated from ${last.repo}@${last.ref} at ${new Date(last.at).toLocaleString()}.`
            : `Last update failed: ${last.error || 'no reason recorded'}`,
        !last.ok,
    );
}

/**
 * Nothing here polls GitHub in the background. A control panel that phones home
 * on a timer is a surprise, and the answer is only interesting at the moment
 * somebody is thinking about updating.
 */
$('global-check-btn').addEventListener('click', async () => {
    const button = $('global-check-btn');
    const repo = $('global-repo').value.trim();
    const ref = $('global-ref').value.trim();
    button.disabled = true;
    $('global-check-status').textContent = 'Checking…';
    try {
        const q = new URLSearchParams({ repo, ref });
        const r = await api(`/api/system/panel-latest?${q}`);
        const when = r.latest.date ? new Date(r.latest.date).toLocaleString() : 'unknown date';
        if (r.upToDate === true) {
            $('global-check-status').textContent = `Up to date. ${ref} is at ${r.latest.shortSha}, ${when}.`;
        } else if (r.upToDate === false) {
            const behind = r.compare?.behind ? `, ${r.compare.behind} commit${r.compare.behind === 1 ? '' : 's'} ahead of yours` : '';
            $('global-check-status').textContent = `Update available: ${r.latest.shortSha}${behind}. ${r.latest.message}`;
        } else {
            // No recorded sha, which is every install that has not used this
            // button yet. Saying "up to date" here would be a guess.
            $('global-check-status').textContent =
                `${ref} is at ${r.latest.shortSha} (${when}). This install has no recorded commit, so there is nothing to compare it against yet.`;
        }
    } catch (e) {
        $('global-check-status').textContent = e.message;
    } finally {
        button.disabled = false;
    }
});

$('global-update-btn').addEventListener('click', async () => {
    const button = $('global-update-btn');
    const repo = $('global-repo').value.trim();
    const ref = $('global-ref').value.trim();
    if (!confirm(`Update the panel from ${repo}@${ref}?\n\nIt will go offline for a minute or two while it rebuilds. The node keeps running.`)) return;

    button.disabled = true;
    try {
        await api('/api/system/panel-update', { method: 'POST', body: { repo, ref } });
        kResult('global-update-result', 'Rebuilding. This page will drop out and come back on its own.');
        waitForPanel();
    } catch (e) {
        kResult('global-update-result', e.message, true);
        button.disabled = false;
    }
});

/**
 * Polls until the panel answers again. The rebuild takes it away mid-request,
 * so failures here are expected and are not worth showing until it has been
 * gone long enough to mean something.
 */
function waitForPanel() {
    const deadline = Date.now() + 10 * 60_000;
    let wasDown = false;

    const tick = async () => {
        try {
            const res = await fetch('/healthz', { cache: 'no-store' });
            if (res.ok) {
                if (wasDown) return location.reload();
                // Still the old panel: it has not gone down yet.
            }
        } catch {
            wasDown = true;
        }
        if (Date.now() > deadline) {
            kResult('global-update-result', 'The panel has not come back after ten minutes. Check `docker logs kaspa-node-panel-update`.', true);
            $('global-update-btn').disabled = false;
            return;
        }
        setTimeout(tick, 3000);
    };
    setTimeout(tick, 4000);
}

// Nothing else in the panel is guarded like this, because nothing else deletes
// the node, its chain data and the panel in one go.
const TEARDOWN_PHRASE = 'DELETE EVERYTHING';

$('global-teardown-confirm').addEventListener('input', (event) => {
    $('global-teardown-btn').disabled = event.target.value.trim() !== TEARDOWN_PHRASE;
});

$('global-teardown-btn').addEventListener('click', async () => {
    if (!confirm('Remove the node, all its data and this panel?\n\nThis cannot be undone. Docker itself stays installed.')) return;

    $('global-teardown-btn').disabled = true;
    try {
        await api('/api/system/teardown', { method: 'POST', body: { confirm: TEARDOWN_PHRASE } });
        kResult(
            'global-teardown-result',
            'Removing everything. This panel will stop responding shortly, which is what finishing looks like.',
        );
    } catch (e) {
        kResult('global-teardown-result', e.message, true);
        $('global-teardown-btn').disabled = false;
    }
});
