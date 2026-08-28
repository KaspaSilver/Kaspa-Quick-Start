const $ = (id) => document.getElementById(id);
const el = (sel, root = document) => root.querySelector(sel);

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

const isLocked = (name) => {
    const item = document.querySelector(`.nav-item[data-tab="${name}"]`);
    return Boolean(item?.classList.contains('locked'));
};

function selectTab(name) {
    if (isLocked(name)) {
        toast(lockReason || 'This section needs a running, synced node.', 'bad');
        return;
    }
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
    // Same for the kaspad log: no point streaming it from another section.
    if (name !== 'kaspad') setKaspadLog(false);
    else setKaspadLog(activeSubtab('kaspad') === 'kaspadlog');
    // On the drawer layout, picking a destination should get out of the way.
    if (MOBILE()) closeDrawer();
}

for (const item of document.querySelectorAll('.nav-item')) {
    item.addEventListener('click', () => selectTab(item.dataset.tab));
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
function setNavSwitch(service, on, { disabled = false, reason = '' } = {}) {
    const input = navSwitch(service);
    if (!input || input.dataset.busy === '1') return;
    input.checked = Boolean(on);
    input.disabled = disabled;
    const label = input.closest('.switch');
    if (label) label.title = disabled && reason ? reason : label.getAttribute('aria-title') || label.title;
}

// Each service is switched on in whatever way its own API expects.
const SERVICE_ACTIONS = {
    node: (on) => api(`/api/node/${on ? 'start' : 'stop'}`, { method: 'POST' }),
    mining: (on) => api('/api/mining', { method: 'PUT', body: { config: { ...collectMiningConfig(), enabled: on } } }),
    kachat: (on) => api('/api/apps/kachat', { method: 'PUT', body: { config: { ...collectAppConfig('kachat'), enabled: on } } }),
    nextcloud: (on) =>
        api('/api/apps/nextcloud', { method: 'PUT', body: { config: { ...collectAppConfig('nextcloud'), enabled: on } } }),
    proxy: (on) => api('/api/proxy/enabled', { method: 'POST', body: { enabled: on } }),
};

const SERVICE_NAMES = {
    node: 'the node',
    mining: 'mining',
    kachat: 'the KaChat indexer',
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

async function refreshStatus() {
    let s;
    try {
        s = await api('/api/status');
    } catch {
        $('health-dot').className = 'dot bad';
        return;
    }
    lastStatus = s;

    const running = s.container.running;
    const synced = s.rpc.synced === true;
    $('health-dot').className = `dot ${!running ? 'bad' : synced ? 'ok' : 'warn'}`;

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
    $('stat-utxo').textContent = s.rpc.info ? (s.rpc.info.isUtxoIndexed ? 'enabled' : 'DISABLED') : '–';

    const containerTag = $('stat-container');
    containerTag.textContent = s.container.status || 'absent';
    containerTag.className = `tag ${running ? 'ok' : 'off'}`;
    setNavSwitch('node', running);
    $('stat-network').textContent = s.rpc.dag?.networkName || s.network;
    $('stat-version').textContent = s.version?.version || '–';
    $('stat-uptime').textContent = running ? fmtDuration(s.container.startedAt) : '–';
    $('stat-disk').textContent = fmtBytes(s.disk?.size);
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
function applyNodeGating(status) {
    const ready = Boolean(status?.ready);
    lockReason = ready
        ? null
        : !status?.container?.running
          ? 'The node is not running yet. Start it on the Kaspad page.'
          : !status?.rpc?.reachable
            ? 'The node is still starting up.'
            : 'The node is still catching up. This unlocks once it is done.';

    for (const service of ['mining', 'kachat']) {
        const input = navSwitch(service);
        if (input && input.dataset.busy !== '1') {
            input.disabled = !ready;
            const label = input.closest('.switch');
            if (label) label.title = ready ? `Start or stop ${SERVICE_NAMES[service]}` : lockReason;
        }
    }

    for (const item of document.querySelectorAll('.nav-item[data-requires-node]')) {
        item.classList.toggle('locked', !ready);
        item.setAttribute('aria-disabled', String(!ready));
        item.title = ready
            ? item.querySelector('.label').textContent
            : `${item.querySelector('.label').textContent}: ${lockReason}`;
    }

    // If the node falls out of sync while one of these is open, do not strand
    // the user on a section whose controls no longer work.
    const active = document.querySelector('.nav-item.active');
    if (!ready && active?.hasAttribute('data-requires-node')) {
        selectTab('kaspad');
        toast(lockReason, 'bad');
    }
}

/**
 * Every port gets a switch, on by default because that is how the node starts
 * out. Every port is listed whether it is on or off -- showing only the enabled
 * ones would remove a port's own row when you switched it off, leaving no way
 * to switch it back on.
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

    // The block count is exact and always available, so it is the answer when
    // there is nothing measured to beat it. A size only appears once it has
    // actually been observed, either across a past prune or from how fast the
    // volume is filling up now.
    const size = p.measured && p.measured.freedBytes > 100e6 ? p.measured.freedBytes : null;
    const note = size
        ? `the last one gave back ${fmtByteCount(size)}`
        : p.projected
          ? `should give back around ${fmtByteCount(p.projected.bytes)}`
          : `drops ${fmtNum(p.blocksPerStep)} blocks (${p.stepHours} hours of history)`;

    el.innerHTML =
        `${escapeHtml(fmtCountdown(p.secondsUntil))} <span class="muted">· ${escapeHtml(note)}</span>`;

    const lines = [
        `Kaspad keeps roughly ${p.retentionHours} hours of full block data and drops the oldest ${p.stepHours} hours at a time.`,
        `Next step when the chain reaches blue score ${Math.round(p.firesAtBlueScore).toLocaleString()}, which is ${Math.round(p.blueScoreRemaining).toLocaleString()} away.`,
    ];
    if (p.projected) {
        lines.push(
            `Estimated from ${fmtByteCount(p.projected.observedBytes)} of growth over the last ` +
                `${fmtCountdown(p.projected.observedSeconds).replace(/^in /, '')}, scaled to a full cycle.`,
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

// --------------------------------------------------------------- settings ---

let currentConfig = null;

const FLAGS = [
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
    renderStratumTargets(c);
    renderEconomics(r);
    setNavSwitch('mining', c.enabled);
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
    $('scan-own').textContent = lanIp ? `${lanIp.split('.').slice(0, 3).join('.')}.0/24` : 'unknown';
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

$('scan-show-all').addEventListener('change', renderScan);

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
let adminPath = '/kachat';

async function loadApps() {
    const r = await api('/api/apps');
    appsState = r;
    adminPath = r.adminPath || '/kachat';
    const c = r.config;

    // --- KaChat ---
    $('kachat-ref').value = c.kachat.ref;
    $('kachat-network').value = c.kachat.network;
    $('kachat-pub-api').checked = c.kachat.publish.api;
    $('kachat-pub-chat').checked = c.kachat.publish.chat;
    renderAppState('kachat', r.apps.kachat);

    // --- Nextcloud ---
    $('nextcloud-ref').value = c.nextcloud.ref;
    $('nextcloud-pub-web').checked = c.nextcloud.publish.web;
    $('nextcloud-port').value = c.nextcloud.hostPort;
    $('nextcloud-user').value = c.nextcloud.adminUser;
    $('nextcloud-domains').value = c.nextcloud.trustedDomains;
    renderAppState('nextcloud', r.apps.nextcloud);
    setNavSwitch('kachat', c.kachat.enabled);
    setNavSwitch('nextcloud', c.nextcloud.enabled);
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
    const enabled = appsState.config[name].enabled;
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
        // Only point the frame at the dashboard once the container is actually
        // up, so the panel does not show a proxy error while it boots.
        const shell = $('kachat-embed-shell');
        const frame = $('kachat-frame');
        const show = enabled && running;
        shell.hidden = !show;
        if (show && !frame.src.includes(adminPath)) frame.src = adminPath;
        if (!show) frame.src = 'about:blank';

        $('kachat-open').disabled = !show;
        if (enabled && !running && !state.blockers?.length) {
            notice.hidden = false;
            const failure = startFailure(state);
            notice.className = failure ? 'verdict bad' : 'verdict';
            notice.textContent =
                failure ??
                'Starting up. The first build compiles the indexer from source, which takes a while. You can watch it under All logs.';
        }
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
}

function collectAppConfig(name) {
    if (name === 'kachat') {
        return {
            enabled: Boolean(appsState?.config.kachat.enabled),
            ref: $('kachat-ref').value.trim() || 'main',
            network: $('kachat-network').value,
            publish: { api: $('kachat-pub-api').checked, chat: $('kachat-pub-chat').checked },
        };
    }
    return {
        enabled: Boolean(appsState?.config.nextcloud.enabled),
        ref: $('nextcloud-ref').value.trim() || 'main',
        publish: { web: $('nextcloud-pub-web').checked },
        hostPort: Number($('nextcloud-port').value),
        adminUser: $('nextcloud-user').value.trim(),
        trustedDomains: $('nextcloud-domains').value.trim(),
    };
}

for (const name of ['kachat', 'nextcloud']) {
    // The switch is a power control: it takes effect on the spot, matching the
    // one on Mining. Everything that needs an explicit Apply stays a checkbox.
    $(`${name}-save`).addEventListener('click', async () => {
        const err = $(`${name}-error`);
        err.hidden = true;
        try {
            await api(`/api/apps/${name}`, { method: 'PUT', body: { config: collectAppConfig(name) } });
            openConsole(`Applying ${name} settings`);
            setTimeout(loadApps, 2000);
        } catch (e) {
            err.textContent = e.message;
            err.hidden = false;
        }
    });

    $(`${name}-check`).addEventListener('click', async () => {
        const notice = $(`${name}-notice`);
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

$('kachat-open').addEventListener('click', () => window.open(adminPath, '_blank', 'noopener'));

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

// ---------------------------------------------------------------- proxies ---

let proxies = [];

async function loadProxies() {
    const r = await api('/api/proxies');
    proxies = r.proxies;

    // Reflect whether the proxy is running before anything else: with it off,
    // adding a host would write config nothing is serving.
    const on = Boolean(r.enabled);
    const badge = $('proxy-state');
    badge.textContent = !on ? 'off' : r.container?.running ? 'running' : r.container?.status || 'starting';
    badge.className = `tag ${!on ? 'off' : r.container?.running ? 'ok' : ''}`;
    setNavSwitch('proxy', on);
    for (const id of ['proxy-add', 'proxy-reload', 'proxy-renew']) {
        const button = $(id);
        button.disabled = !on;
        button.title = on ? '' : 'Turn the reverse proxy on first.';
    }

    const body = $('proxy-body');

    if (!proxies.length) {
        body.innerHTML = '<tr><td colspan="5" class="empty">No proxy hosts yet.</td></tr>';
        return;
    }

    body.innerHTML = proxies
        .map((p) => {
            const target =
                p.target.kind === 'custom'
                    ? `${p.target.scheme}://${p.target.host}:${p.target.port}`
                    : { borsh: 'kaspad wRPC Borsh', json: 'kaspad wRPC JSON', grpc: 'kaspad gRPC', manager: 'control panel' }[
                          p.target.kind
                      ];
            const tls =
                p.ssl?.mode === 'letsencrypt'
                    ? p.certificate
                        ? '<span class="tag ok">https</span>'
                        : '<span class="tag">pending</span>'
                    : '<span class="tag off">http only</span>';
            const extras = [
                p.enabled === false ? '<span class="tag off">disabled</span>' : '',
                p.auth?.enabled ? '<span class="tag">password</span>' : '',
                (p.allowlist || []).length ? '<span class="tag">ip filter</span>' : '',
                p.rateLimit ? `<span class="tag">${p.rateLimit}/s</span>` : '',
            ]
                .filter(Boolean)
                .join('');
            return `<tr>
        <td><a href="${p.ssl?.mode === 'letsencrypt' && p.certificate ? 'https' : 'http'}://${p.domain}" target="_blank" rel="noreferrer noopener">${p.domain}</a></td>
        <td>${target}</td>
        <td>${tls}</td>
        <td>${extras || '<span class="muted">–</span>'}</td>
        <td>
          ${p.ssl?.mode === 'letsencrypt' && !p.certificate ? `<button class="ghost" data-cert="${p.id}">Get certificate</button>` : ''}
          <button class="ghost" data-edit="${p.id}">Edit</button>
          <button class="ghost danger" data-del="${p.id}">Delete</button>
        </td>
      </tr>`;
        })
        .join('');
}

$('proxy-body').addEventListener('click', async (event) => {
    const { edit, del, cert } = event.target.dataset;
    if (edit) return openProxyDialog(proxies.find((p) => p.id === edit));
    if (cert) {
        const proxy = proxies.find((p) => p.id === cert);
        try {
            await api(`/api/proxies/${cert}/certificate`, { method: 'POST', body: { email: proxy.ssl?.email } });
            openConsole(`Issuing certificate for ${proxy.domain}`);
        } catch (e) {
            toast(e.message, 'bad');
        }
        return;
    }
    if (del) {
        const proxy = proxies.find((p) => p.id === del);
        if (!confirm(`Delete the proxy host for ${proxy.domain}?`)) return;
        try {
            await api(`/api/proxies/${del}`, { method: 'DELETE' });
            toast('Proxy host removed.', 'good');
            loadProxies();
        } catch (e) {
            toast(e.message, 'bad');
        }
    }
});

$('proxy-add').addEventListener('click', () => openProxyDialog(null));

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

    $('px-domain').value = proxy?.domain ?? '';
    $('px-target').value = proxy?.target?.kind ?? 'borsh';
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

async function loadDuckDns() {
    const r = await api('/api/duckdns');
    $('dd-enabled').checked = r.duckdns.enabled;
    $('dd-domains').value = r.duckdns.domains;
    $('dd-token').value = r.duckdns.token;
    $('dd-interval').value = r.duckdns.intervalMinutes;
    $('public-ip').textContent = r.publicIp || 'unknown';
    $('dd-status').textContent = r.duckdns.lastRunAt
        ? `Last updated ${new Date(r.duckdns.lastRunAt).toLocaleString()}: ${r.duckdns.lastResult}`
        : 'Never updated.';
}

$('dd-save').addEventListener('click', async () => {
    try {
        const r = await api('/api/duckdns', {
            method: 'PUT',
            body: {
                enabled: $('dd-enabled').checked,
                domains: $('dd-domains').value,
                token: $('dd-token').value,
                intervalMinutes: Number($('dd-interval').value),
            },
        });
        toast(r.domains.length ? `Saved. Keeping ${r.domains.join(', ')} up to date.` : 'Saved.', 'good');
        loadDuckDns();
    } catch (e) {
        toast(e.message, 'bad');
    }
});

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

// Log text size. One setting for every log view, so zooming in one place does
// not leave the others unreadable, and it survives a reload.
const LOG_ZOOM_KEY = 'kaspa-node-log-size';
const LOG_SIZE_MIN = 9;
const LOG_SIZE_MAX = 22;
const LOG_SIZE_DEFAULT = 11.5;

function logSize() {
    const stored = Number(localStorage.getItem(LOG_ZOOM_KEY));
    return Number.isFinite(stored) && stored >= LOG_SIZE_MIN && stored <= LOG_SIZE_MAX ? stored : LOG_SIZE_DEFAULT;
}

function applyLogSize(size) {
    const clamped = Math.min(LOG_SIZE_MAX, Math.max(LOG_SIZE_MIN, size));
    document.documentElement.style.setProperty('--log-size', `${clamped}px`);
    try {
        localStorage.setItem(LOG_ZOOM_KEY, String(clamped));
    } catch {
        /* private browsing: the size just will not persist */
    }
    for (const button of document.querySelectorAll('[data-zoom]')) {
        const step = Number(button.dataset.zoom);
        button.disabled = step < 0 ? clamped <= LOG_SIZE_MIN : clamped >= LOG_SIZE_MAX;
    }
    return clamped;
}

document.addEventListener('click', (event) => {
    const step = event.target.dataset?.zoom;
    if (step === undefined) return;
    // Keep whatever is pinned to the bottom pinned after the text resizes.
    const views = [...document.querySelectorAll('.logview, .log-tile pre')];
    const atBottom = views.map((v) => v.scrollHeight - v.scrollTop - v.clientHeight < 4);
    applyLogSize(logSize() + Number(step) * 1.5);
    views.forEach((v, i) => {
        if (atBottom[i]) v.scrollTop = v.scrollHeight;
    });
});

applyLogSize(logSize());

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
        <button type="button" data-expand="${key}" title="Expand this one to full width">⤢</button>
        <button type="button" data-clear="${key}" title="Clear">✕</button>
      </div>
      <pre data-tilelog="${key}"></pre>
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
        grid.innerHTML = containers.length
            ? containers.map((c) => logTile(c.key, c.label)).join('')
            : '<p class="empty-tile">No containers are running.</p>';
        for (const c of containers) {
            logBuffers.set(c.key, []);
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

$('log-filter').addEventListener('input', () => {
    for (const key of logBuffers.keys()) renderLogTile(key);
    updateLogSummary();
});

$('log-grid').addEventListener('click', (event) => {
    const expand = event.target.dataset?.expand;
    const clear = event.target.dataset?.clear;
    if (expand) {
        document.querySelector(`[data-tile="${expand}"]`)?.classList.toggle('expanded');
    } else if (clear) {
        logBuffers.set(clear, []);
        renderLogTile(clear);
    }
});

// ---------------------------------------------------------------- console ---

let jobStream = null;

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

function connectJobs() {
    jobStream?.close();
    jobStream = new EventSource('/api/jobs/stream');
    jobStream.addEventListener('snapshot', (event) => {
        const job = JSON.parse(event.data);
        if (job.status !== 'running') return;
        openConsole(job.name);
        $('console-body').textContent = `${job.lines.join('\n')}\n`;
    });
    jobStream.addEventListener('start', (event) => openConsole(JSON.parse(event.data).name));
    jobStream.addEventListener('line', (event) => appendConsole(JSON.parse(event.data).line));
    jobStream.addEventListener('end', (event) => {
        const job = JSON.parse(event.data);
        appendConsole(job.status === 'succeeded' ? '\n✓ Done.' : `\n✗ Failed: ${job.error}`);
        toast(job.status === 'succeeded' ? `${job.name}: done` : `${job.name}: failed`, job.status === 'succeeded' ? 'good' : 'bad');
        refreshStatus();
        loadProxies();
        loadMining();
        loadApps();
    });
}

// ------------------------------------------------------------------- boot ---

api('/api/session')
    .then((s) => {
        if (s.panelVersion) $('version-badge').textContent = `v${s.panelVersion}`;
        // No password set: skip the sign-in screen entirely and say why, so the
        // absence of a login prompt reads as a decision rather than a bug.
        $('logout').hidden = !s.required;
        $('auth-note').hidden = Boolean(s.required);
        if (s.authenticated) showApp();
        else showLogin();
    })
    .catch(() => showLogin());
