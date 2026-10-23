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

/**
 * A poller that never stacks: while the previous call is still waiting, the next tick is
 * skipped. A slow /api/status (a node restarting) used to start a new request every few
 * seconds until the browser's six connections per origin were all taken, and every click
 * queued behind them, so the panel looked frozen (docs/HANDOFF-PANEL-STATUS-SPEED.md).
 */
// Overview's live BlockDAG view (see setDagView); here so selectTab can reach it at any point.
const dag = { blocks: new Map(), reds: new Set(), next: null, active: false, timer: null, frame: null, view: null, arrivals: [] };

function noOverlap(fn) {
    let running = false;
    return async (...args) => {
        if (running) return;
        running = true;
        try {
            return await fn(...args);
        } finally {
            running = false;
        }
    };
}

async function api(path, { method = 'GET', body, headers = {} } = {}) {
    const res = await fetch(path, {
        method,
        headers: body ? { 'Content-Type': 'application/json', ...headers } : headers,
        body: body ? JSON.stringify(body) : undefined,
    });
    let data = {};
    try {
        data = await res.json();
    } catch {
        /* empty body */
    }
    if (res.status === 401) {
        // With no password set yet, everything answers 401: stay on (or return to) the
        // set-password screen rather than offering a sign-in nobody can complete.
        if (needsSetup) showFirstRun();
        else showLogin();
        throw new Error('Not signed in.');
    }
    if (!res.ok) {
        const detail = Array.isArray(data.details) ? `\n• ${data.details.join('\n• ')}` : '';
        throw new Error(`${data.error || res.statusText}${detail}`);
    }
    return data;
}

// How this browser reached the panel, from the server's point of view: whether
// the request came through the reverse proxy, and the panel's own direct address
// to fall back on. Set once from /api/session. Used to warn before stopping the
// proxy would disconnect the very page asking for it.
let panelAccess = { viaProxy: false, directUrl: '' };

// No admin password is set yet (from /api/session): the panel only shows the screen to set
// one, and a 401 from any background request must not flip it to the sign-in screen.
let needsSetup = false;

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

// Binary units, because that is what a filesystem and a kernel both report:
// a "16 GB" stick of RAM is 16 GiB, and rendering it as 17.2 GB to be decimally
// correct only makes people think something is missing.
function fmtSize(bytes) {
    if (bytes === null || bytes === undefined || !Number.isFinite(Number(bytes))) return '–';
    let value = Number(bytes);
    const units = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'];
    let unit = 0;
    while (value >= 1024 && unit < units.length - 1) {
        value /= 1024;
        unit += 1;
    }
    // Sub-10 values keep a decimal so a bar that is creeping still visibly moves.
    return `${value < 10 && unit > 0 ? value.toFixed(1) : Math.round(value)} ${units[unit]}`;
}

function fmtUptime(seconds) {
    if (!Number.isFinite(Number(seconds))) return '–';
    const secs = Math.max(0, Math.floor(Number(seconds)));
    const d = Math.floor(secs / 86400);
    const h = Math.floor((secs % 86400) / 3600);
    const m = Math.floor((secs % 3600) / 60);
    if (d) return `${d}d ${h}h`;
    if (h) return `${h}h ${m}m`;
    return `${m}m`;
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
    $('firstrun').classList.add('hidden');
    $('app').classList.add('hidden');
    stopPolling();
}

function showApp() {
    $('login').classList.add('hidden');
    $('firstrun').classList.add('hidden');
    $('app').classList.remove('hidden');
    // The heading is static markup until something navigates; seed it from
    // whichever entry starts active so it is not stale on first paint.
    $('page-title').textContent = document.querySelector('.nav-item.active .label').textContent;
    // Tab-scoped pollers are started by selectTab, which nothing has called
    // yet on first paint. Read the landing tab out of the markup rather than
    // naming it here, so moving which one starts active cannot leave its page
    // sitting empty until someone navigates away and back.
    setHostPolling(document.querySelector('.nav-item.active')?.dataset.tab === 'overview');
    setDagView(document.querySelector('.nav-item.active')?.dataset.tab === 'overview');
    startPolling();
    // A remembered Testnet view hides Kaspad's mainnet-only sub-tabs from the start.
    applyKaspadSubtabsForView();
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
        // 409: no password is set yet (e.g. it was cleared from .env), so set one instead.
        if (/No password is set yet/.test(e.message)) {
            needsSetup = true;
            showFirstRun();
            return;
        }
        err.textContent = e.message;
        err.hidden = false;
    }
});

$('logout').addEventListener('click', async () => {
    await fetch('/api/logout', { method: 'POST' });
    showLogin();
});

// --- first run: set the admin password on the panel, not in the terminal ---

function showFirstRun() {
    $('firstrun').classList.remove('hidden');
    $('login').classList.add('hidden');
    $('app').classList.add('hidden');
    stopPolling();
}

$('firstrun-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    const err = $('firstrun-error');
    err.hidden = true;
    const password = $('firstrun-password').value;
    const repeat = $('firstrun-repeat').value;
    if (password.length < 8) {
        err.textContent = 'Use at least 8 characters.';
        err.hidden = false;
        return;
    }
    if (password !== repeat) {
        err.textContent = 'The two passwords are not the same.';
        err.hidden = false;
        return;
    }
    const btn = event.target.querySelector('button[type="submit"]');
    btn.disabled = true;
    try {
        // No `current`: this only runs when none is set. The response carries a
        // session cookie and the password is in force at once (auth reads it live
        // from .env), so there is no restart to wait on -- just reload into the
        // panel, already signed in.
        await api('/api/auth/password', { method: 'POST', body: { password } });
        const status = $('firstrun-status');
        status.hidden = false;
        status.textContent = 'Password set. Opening the panel…';
        location.reload();
    } catch (e) {
        err.textContent = e.message;
        err.hidden = false;
        btn.disabled = false;
    }
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
    // The System screens live in the top banner, on every page (no sidebar row).
    for (const item of document.querySelectorAll('.sys-item')) {
        const active = item.dataset.tab === name;
        item.classList.toggle('active', active);
        if (active) title = item.title;
    }
    for (const tab of document.querySelectorAll('.tab')) {
        tab.classList.toggle('active', tab.id === `tab-${name}`);
    }
    $('page-title').textContent = title;
    // Mining stats are only polled while that tab is on screen.
    setMiningPolling(name === 'mining');
    // Same for the machine's own disk/memory figures.
    setHostPolling(name === 'overview');
    setDagView(name === 'overview');
    // The KaChat panels do the same, and each one loads only itself.
    setKachatPolling(name === 'kachat');
    // A section's log streams only while it is on screen.
    syncSvcLog();
    // Read on arrival rather than polled: nothing on it changes by itself.
    if (name === 'global') {
        loadGlobal().catch(() => {});
        // Updates is the first sub-tab, so its app list starts on arrival too.
        setGlobalAppUpdates(!!$('sub-global-update')?.classList.contains('active'));
    }
    setUpdateQueueView(name === 'queue');
    if (name === 'bot') loadBot().catch(() => {});
    if (name === 'push') loadPush().catch(() => {});
    if (name === 'names') loadNames().catch(() => {});
    if (name === 'x4kas') loadX4kas().catch(() => {});
    if (name === 'experimental') loadExperimental().catch(() => {});
    // The machine's LAN address sits beside the title on Proxy & domains.
    $('topbar-lan').hidden = name !== 'proxy';
    if (name === 'proxy') loadLanIp().catch(() => {});
    // On the drawer layout, picking a destination should get out of the way.
    if (MOBILE()) closeDrawer();
}

for (const item of document.querySelectorAll('.nav-item, .sys-item')) {
    item.addEventListener('click', () => {
        selectTab(item.dataset.tab);
        // Back on Overview: the dashboard cycle (if it is on) starts again from here.
        if (item.dataset.tab === 'overview' && cycleEnabled()) startCycle();
    });
}

// --- Overview dashboard mode: every app's Overview in turn ---

/**
 * Overview > "Cycle through app overviews": the panel shows Overview, then each app switched on
 * in the sidebar (on its own Overview sub-tab), 8 seconds each, fading from one to the next,
 * and last All logs, scrolled smoothly from top to bottom and held 8 seconds; round and round. Any click or key pauses it, so it never moves a page out from under someone
 * using the panel; Resume in the top bar, or coming back to Overview, starts it again. The
 * setting is this browser's (localStorage); a hidden tab does not cycle.
 */
const CYCLE_KEY = 'kqs-cycle-overviews';
const CYCLE_MS = 8_000;
const CYCLE_FADE_MS = 450;
// Not shown: settings pages, and the Push Service and Proxy & domains screens (owner's choice).
// kassigner and desktop are out by request: a hardware flasher and a static web app, with
// nothing live to glance at.
const NOT_CYCLED = new Set(['overview', 'logs', 'experimental', 'global', 'support', 'push', 'proxy', 'kassigner', 'desktop']);
const CYCLE_SCROLL_PX_PER_S = 120;       // All logs scrolls at a pace you can follow
let cycleRunning = false;
let cycleTimer = null;
let cycleScroll = null;                  // the All logs scroll in progress (an animation frame)
let cycleTab = 'overview';
// The switch's state; this browser's localStorage keeps it across reloads when it can.
let cycleSetting = (() => {
    try {
        return localStorage.getItem(CYCLE_KEY) === '1';
    } catch {
        return false;
    }
})();

function cycleEnabled() {
    return cycleSetting;
}

/** Overview, then every app switched on in the sidebar that this network view shows. */
function cycleScreens() {
    const out = ['overview'];
    for (const row of document.querySelectorAll('.nav-row')) {
        const item = row.querySelector('.nav-item');
        const tab = item?.dataset.tab;
        if (!tab || NOT_CYCLED.has(tab) || out.includes(tab)) continue;
        if (!row.querySelector('input[data-service]')?.checked) continue;
        if (row.offsetParent === null || item.classList.contains('locked')) continue;
        out.push(tab);
    }
    out.push('logs');
    return out;
}

/** A tab on its Overview sub-tab (the first one this view shows). */
function showOverviewOf(tab) {
    selectTab(tab);
    const section = document.getElementById(`tab-${tab}`);
    const buttons = [...(section?.querySelectorAll('.subtab-btn') ?? [])].filter((b) => b.offsetParent !== null);
    const pick = buttons.find((b) => /overview$/.test(b.dataset.subtab)) ?? buttons[0];
    if (pick) selectSubtab(section, pick.dataset.subtab);
    cycleTab = tab;
}

function updateCyclePill() {
    const pill = $('topbar-cycle');
    if (!pill) return;
    pill.hidden = !cycleEnabled();
    const screens = cycleScreens();
    const i = Math.max(0, screens.indexOf(cycleTab));
    // A sidebar item's label, or a topbar System button's name (All logs ends every cycle);
    // never a body-wide lookup, which found the sidebar brand for an unmatched tab (KQS-036).
    const label =
        document.querySelector(`.nav-item[data-tab="${cycleTab}"] .label`)?.textContent ??
        document.querySelector(`.sys-item[data-tab="${cycleTab}"]`)?.title ??
        cycleTab;
    $('cycle-now').textContent = cycleRunning ? `Cycling: ${label} (${i + 1} of ${screens.length})` : 'Cycling paused';
    $('cycle-pause').textContent = cycleRunning ? 'Pause' : 'Resume';
}

function scheduleCycle() {
    clearTimeout(cycleTimer);
    if (cycleRunning && !document.hidden && cycleScroll == null) cycleTimer = setTimeout(cycleStep, CYCLE_MS);
}

/** All logs: once it has faded in, scroll smoothly to the bottom, then the usual 8 seconds. */
function cycleScrollLogs() {
    const from = window.scrollY;
    const to = Math.max(0, document.documentElement.scrollHeight - window.innerHeight);
    if (to - from < 20) return scheduleCycle();
    const ms = Math.min(45_000, Math.max(2_500, ((to - from) / CYCLE_SCROLL_PX_PER_S) * 1000));
    const ease = (p) => (p < 0.5 ? 2 * p * p : 1 - (-2 * p + 2) ** 2 / 2);
    let start = null;
    const frame = (t) => {
        if (!cycleRunning) return;
        start ??= t;
        const p = Math.min(1, (t - start) / ms);
        window.scrollTo(0, from + (to - from) * ease(p));
        if (p < 1) {
            cycleScroll = requestAnimationFrame(frame);
        } else {
            cycleScroll = null;
            scheduleCycle();
        }
    };
    cycleScroll = requestAnimationFrame(frame);
}

function cycleStep() {
    if (!cycleRunning) return;
    const screens = cycleScreens();
    const next = screens[(screens.indexOf(cycleTab) + 1) % screens.length] ?? 'overview';
    document.body.classList.add('cycle-leaving');
    setTimeout(() => {
        if (!cycleRunning) return;
        try {
            showOverviewOf(next);
        } catch (e) {
            // One app's page failing to draw must not leave the screen faded out and the cycle
            // stopped (it did on the Indexer): note it, show what there is, and carry on.
            console.warn(`overview cycle: ${next}:`, e);
            cycleTab = next;
        } finally {
            window.scrollTo({ top: 0 });
            document.body.classList.remove('cycle-leaving');
            updateCyclePill();
            if (cycleTab === 'logs') {
                // The dashboard look: every tile follows its newest line while the page drifts
                // past, so each log is visibly moving.
                const follow = $('log-follow');
                if (follow && !follow.checked) {
                    follow.checked = true;
                    for (const key of logBuffers.keys()) renderLogTile(key);
                }
                // Let it fade in and the tiles fill first, then scroll.
                cycleScroll = -1;
                setTimeout(() => {
                    cycleScroll = null;
                    for (const pre of document.querySelectorAll('[data-tilelog]')) pre.scrollTop = pre.scrollHeight;
                    if (cycleRunning) cycleScrollLogs();
                }, 1200);
            } else {
                scheduleCycle();
            }
        }
    }, CYCLE_FADE_MS);
}

function startCycle() {
    if (!cycleEnabled()) return;
    cycleRunning = true;
    cycleTab = document.querySelector('.tab.active')?.id?.replace(/^tab-/, '') || 'overview';
    document.body.classList.add('cycling');
    updateCyclePill();
    scheduleCycle();
}

function pauseCycle() {
    cycleRunning = false;
    clearTimeout(cycleTimer);
    if (cycleScroll > 0) cancelAnimationFrame(cycleScroll);
    cycleScroll = null;
    document.body.classList.remove('cycling', 'cycle-leaving');
    updateCyclePill();
}

// Someone is using the panel: stop moving it (the pill's own button excepted).
for (const type of ['pointerdown', 'keydown', 'wheel']) {
    document.addEventListener(
        type,
        (e) => {
            if (cycleRunning && !e.target.closest?.('#topbar-cycle')) pauseCycle();
        },
        { capture: true, passive: true },
    );
}
document.addEventListener('visibilitychange', () => (document.hidden ? clearTimeout(cycleTimer) : scheduleCycle()));
$('cycle-pause')?.addEventListener('click', () => (cycleRunning ? pauseCycle() : startCycle()));
$('cycle-enabled')?.addEventListener('change', (e) => {
    cycleSetting = e.target.checked;
    try {
        localStorage.setItem(CYCLE_KEY, cycleSetting ? '1' : '0');
    } catch {
        /* this browser keeps no settings: it cycles until the page is reloaded */
    }
    if (e.target.checked) startCycle();
    else pauseCycle();
    updateCyclePill();
});
if ($('cycle-enabled')) $('cycle-enabled').checked = cycleEnabled();
// Opened on Overview with the cycle on: start once the sidebar knows which apps are on.
setTimeout(() => {
    if (cycleEnabled() && $('tab-overview')?.classList.contains('active')) startCycle();
}, 3000);

// --- in-page confirm ---

/**
 * A yes/no question asked inside the page, in place of window.confirm().
 *
 * Browsers can block or auto-dismiss native dialogs (Chrome's "prevent this page
 * from creating additional dialogs", embedded views), and window.confirm then
 * answers "cancel" without showing anything: buttons looked dead. This cannot be
 * suppressed. The first line of the message is the question; the rest is detail.
 */
function askConfirm(message) {
    return new Promise((resolve) => {
        const [question, ...rest] = String(message).split('\n');
        // A real modal <dialog>, not a positioned div: other screens (the publish wizard,
        // the proxy editor) are <dialog>s opened with showModal(), which sit in the
        // browser's top layer above every z-index. Opening this one with showModal() too
        // puts it on top of whichever dialog asked the question.
        const dlg = document.createElement('dialog');
        dlg.className = 'ask-dialog';
        dlg.setAttribute('aria-labelledby', 'ask-q');
        dlg.innerHTML = `<div class="ask-box card" role="alertdialog">
            <h3 id="ask-q"></h3>
            <p class="ask-detail muted"></p>
            <div class="row ask-actions">
              <button type="button" class="ghost" data-ask="no">Cancel</button>
              <button type="button" class="primary" data-ask="yes">Continue</button>
            </div>
          </div>`;
        dlg.querySelector('#ask-q').textContent = question;
        dlg.querySelector('.ask-detail').textContent = rest.join('\n').trim();
        let settled = false;
        const done = (answer) => {
            if (settled) return;
            settled = true;
            if (dlg.open) dlg.close();
            dlg.remove();
            resolve(answer);
        };
        // Escape: answer "no" and close only this dialog, not the one underneath.
        dlg.addEventListener('cancel', (event) => {
            event.preventDefault();
            done(false);
        });
        dlg.addEventListener('click', (event) => {
            // A click on the backdrop lands on the <dialog> element itself.
            if (event.target === dlg) return done(false);
            const answer = event.target.closest?.('[data-ask]')?.dataset.ask;
            if (answer) done(answer === 'yes');
        });
        document.body.appendChild(dlg);
        dlg.showModal();
        dlg.querySelector('[data-ask="yes"]').focus();
    });
}

// --- per-section logs ---

/**
 * Every section that runs something has a log card (`<div class="svclog"
 * data-svclog="…">`), filled in here. Which containers a card can show depends on
 * the network being viewed, so the Kaspad tab's log is kaspad-testnet's in the
 * Testnet view; a section with several containers gets a chip per container.
 * Keys are dockerctl.LOG_SOURCES keys (some are a container plus a line filter).
 *
 * Only one card streams at a time -- the one on screen. Browsers allow roughly
 * six concurrent connections to one origin, and the status poll, the all-logs
 * stream and the job console already want several of them, so a card's stream
 * is opened on demand and closed the moment you navigate away.
 */
const SVC_LOGS = {
    kaspad: { mainnet: [['kaspad', 'kaspad']], testnet: [['kaspad-testnet', 'kaspad']] },
    mining: {
        mainnet: [['bridge', 'stratum bridge']],
        testnet: [['cpuminer-testnet', 'cpu miner'], ['bridge-testnet', 'stratum bridge']],
    },
    kachat: {
        mainnet: [
            ['kachat', 'indexer'],
            ['kachat-profiles', 'profiles'],
            ['kachat-db', 'postgres'],
            ['libretranslate', 'libretranslate'],
        ],
        testnet: [['kachat-testnet', 'indexer'], ['kachat-profiles-testnet', 'profiles'], ['kachat-db-testnet', 'postgres']],
    },
    names: {
        mainnet: [['kachat-names', '.kachat Domains'], ['kachat-names-db', 'postgres']],
        testnet: [['kachat-names-testnet', '.kachat Domains'], ['kachat-names-db-testnet', 'postgres']],
    },
    desktop: { mainnet: [['kachat-desktop', 'kachat desktop']] },
    bot: { mainnet: [['kachat-bot', 'kachat bot']] },
    push: { mainnet: [['kachat-push', 'push service']], testnet: [['kachat-push-testnet', 'push service']] },
    nextcloud: {
        mainnet: [
            ['nextcloud', 'nextcloud'],
            ['nextcloud-db', 'mariadb'],
            ['nextcloud-redis', 'redis'],
            ['nextcloud-imaginary', 'imaginary'],
        ],
    },
    proxy: { mainnet: [['proxy', 'nginx proxy']] },
    global: { mainnet: [['manager', 'control panel']] },
};
const SVC_LOG_LINES = 2000;
const svcLogPick = {}; // card -> chosen source key, per network
let svcLog = null; // { card, key, stream }

const svcLogSources = (card) => {
    const nets = SVC_LOGS[card] ?? {};
    return (networkView === 'testnet' && nets.testnet) || nets.mainnet || [];
};

function renderSvcLogCard(node) {
    const card = node.dataset.svclog;
    const sources = svcLogSources(card);
    const pick = svcLogPick[`${card}:${networkView}`] ?? sources[0]?.[0];
    const title = node.dataset.title || `${sources.find(([k]) => k === pick)?.[1] ?? card} log`;
    const chips =
        sources.length > 1
            ? `<span class="svclog-chips" role="group" aria-label="Which log">${sources
                  .map(
                      ([key, label]) =>
                          `<button type="button" class="svclog-chip${key === pick ? ' active' : ''}" data-svclog-pick="${key}">${escapeHtml(label)}</button>`,
                  )
                  .join('')}</span>`
            : '';
    node.innerHTML = `<article class="card span2">
        <h3>
          ${escapeHtml(sources.length > 1 ? 'Logs' : title)}
          ${chips}
          <span class="zoom" role="group" aria-label="Log text size"><button type="button" class="zoom-btn" data-zoom="-1" data-zoom-view="${card}" title="Smaller text" aria-label="Smaller log text">−</button><button type="button" class="zoom-btn" data-zoom="1" data-zoom-view="${card}" title="Larger text" aria-label="Larger log text">+</button></span>
          <label class="check tail" title="Jump to the newest line as it arrives. Untick to scroll back through history without being pulled to the bottom."><input type="checkbox" data-svclog-follow checked> auto-scroll</label>
        </h3>
        <pre class="logview" data-logview="${card}"></pre>
      </article>`;
    restoreLogSize(card);
    return pick;
}

/** The log card on screen right now, if any (inside the active tab and sub-tab). */
function visibleSvcLog() {
    for (const node of document.querySelectorAll('section.tab.active .svclog')) {
        const sub = node.closest('.subtab');
        if (!sub || sub.classList.contains('active')) return node;
    }
    return null;
}

function stopSvcLog() {
    svcLog?.stream.close();
    svcLog = null;
}

/** Streams the visible card's chosen log; closes the stream when no card is visible. */
function syncSvcLog() {
    const node = visibleSvcLog();
    const card = node?.dataset.svclog;
    const sources = card ? svcLogSources(card) : [];
    if (!node || !sources.length) return stopSvcLog();
    const want = svcLogPick[`${card}:${networkView}`] ?? sources[0][0];
    if (svcLog && svcLog.card === card && svcLog.key === want && svcLog.node === node) return;
    stopSvcLog();

    const key = renderSvcLogCard(node);
    const view = node.querySelector('pre');
    const followBox = node.querySelector('[data-svclog-follow]');
    const stream = new EventSource(`/api/logs/stream?container=${encodeURIComponent(key)}`);
    svcLog = { card, key, node, stream };

    stream.addEventListener('line', (event) => {
        const { line } = JSON.parse(event.data);
        // Only chase the bottom when the reader is already there, so scrolling
        // back through history is not yanked away on the next line.
        const atBottom = view.scrollHeight - view.scrollTop - view.clientHeight < 40;
        view.textContent += `${line}\n`;
        // Trim from the front so a long-running container does not grow the DOM
        // node without limit.
        if (view.textContent.length > SVC_LOG_LINES * 200) {
            view.textContent = view.textContent.split('\n').slice(-SVC_LOG_LINES).join('\n');
        }
        if (followBox.checked && atBottom) view.scrollTop = view.scrollHeight;
    });
    stream.addEventListener('error', () => {
        view.textContent += '\n[the log stream dropped; reopen this tab to reconnect]\n';
        stream.close();
    });
}

document.addEventListener('click', (event) => {
    const chip = event.target.closest?.('[data-svclog-pick]');
    if (!chip) return;
    const card = chip.closest('.svclog')?.dataset.svclog;
    if (!card) return;
    svcLogPick[`${card}:${networkView}`] = chip.dataset.svclogPick;
    syncSvcLog();
});

// --- network view (Mainnet / Testnet) ---
//
// Testnet narrows the nav to the services a testnet deployment uses -- the node,
// mining, the KaChat indexer and the (shared) proxy -- and, crucially, re-points the
// shared Kaspad/Mining/Indexer switches, install buttons and health dots at the
// parallel *-testnet units, so both networks run side by side from one panel. The
// choice is remembered across reloads.
const NET_VIEW_KEY = 'kqs-network-view';
const TESTNET_TABS = new Set(['overview', 'kaspad', 'mining', 'kachat', 'names', 'proxy', 'logs', 'global', 'experimental', 'support']);

// Proxy & domains state (filled by loadPublish). Declared up here because
// applyNetworkView runs at load and re-renders it.
let publishState = { services: [], domains: [] };
// Which lifecycle unit each shared nav switch drives in the testnet view.
// Testnet mining is the CPU miner (kaspanet/cpuminer), not the ASIC stratum bridge.
const TESTNET_UNIT = {
    node: 'node-testnet',
    mining: 'cpuminer-testnet',
    kachat: 'kachat-testnet',
    'kachat-domains': 'kachat-domains-testnet',
};
const TESTNET_UNIT_VALUES = new Set(Object.values(TESTNET_UNIT));
// The current view. Read by the service renderers + switch handler so one set of
// controls drives mainnet or testnet depending on it.
let networkView = 'mainnet';
const effectiveService = (key) => (networkView === 'testnet' && TESTNET_UNIT[key] ? TESTNET_UNIT[key] : key);

function applyNetworkView(net) {
    const testnet = net === 'testnet';
    networkView = testnet ? 'testnet' : 'mainnet';
    // Hides [data-mainnet-only] / shows [data-testnet-only] parts of every tab.
    document.body.classList.toggle('testnet-view', testnet);

    // Show/hide each nav row by whether its tab belongs in the testnet view.
    // A `data-testnet-only` item (the .kachat registry) shows only in the testnet view.
    for (const row of document.querySelectorAll('.nav .nav-row')) {
        const item = el('.nav-item', row);
        const tab = item?.dataset.tab;
        row.hidden = testnet
            ? tab
                ? !TESTNET_TABS.has(tab)
                : false
            : item?.hasAttribute('data-testnet-only') ?? false;
    }
    // Hide a group heading when every row under it (up to the next heading) is hidden.
    for (const title of document.querySelectorAll('.nav .nav-group-title')) {
        let anyVisible = false;
        for (let n = title.nextElementSibling; n && !n.classList.contains('nav-group-title'); n = n.nextElementSibling) {
            if (n.classList.contains('nav-row') && !n.hidden) anyVisible = true;
        }
        title.hidden = !anyVisible;
    }

    // Reflect the choice on the switch + note.
    for (const tabBtn of document.querySelectorAll('.net-tab')) {
        const on = tabBtn.dataset.net === net;
        tabBtn.classList.toggle('active', on);
        tabBtn.setAttribute('aria-selected', on ? 'true' : 'false');
    }
    const note = $('net-note');
    if (note) note.hidden = !testnet;

    // Proxy & domains lists the services of the network being viewed.
    if (publishState.services.length) renderPublishServices();

    // If the tab you were on is now hidden, fall back to Overview.
    const active = document.querySelector('.nav-item.active');
    if (active && active.closest('.nav-row')?.hidden) selectTab('overview');

    try {
        localStorage.setItem(NET_VIEW_KEY, net);
    } catch {
        /* private mode / storage disabled — the view just won't persist */
    }

    // Re-render the sidebar rows so the shared switches/dots reflect the units this
    // view drives (guarded: loadServices is defined later but hoisted).
    if (typeof loadServices === 'function') loadServices().catch(() => {});
}

for (const tabBtn of document.querySelectorAll('.net-tab')) {
    tabBtn.addEventListener('click', () => {
        applyNetworkView(tabBtn.dataset.net);
        refreshKaspadForView();
    });
}

// Kaspad's tab follows the network being viewed: status, settings and the log
// are re-read for the other node. Only on a click -- at load everything below is
// still being declared, and the first status poll/loadSettings read the view anyway.
function refreshKaspadForView() {
    applyKaspadSubtabsForView();
    // Every log card re-reads the viewed network's containers.
    stopSvcLog();
    syncSvcLog();
    loadSettings().catch(() => {});
    refreshStatus().catch(() => {});
    uninstallSignature = null;
    renderUninstallCards();
    // The Indexer and Mining tabs read the viewed network's containers.
    if (activeSubtab('kachat')) refreshKachatPanel();
    if (activeSubtab('kachat') === 'kachat-chess') loadChess().catch(() => {});
    if (activeSubtab('kachat') === 'kachat-profiles') loadProfiles().catch(() => {});
    if (activeSubtab('kachat') === 'kachat-updates') loadTestnetIndexerUpdate().catch(() => {});
    // .kachat Domains installs and follows a registry per network.
    if (document.querySelector('.nav-item.active')?.dataset.tab === 'names') loadNames().catch(() => {});
    if (activeSubtab('names') === 'names-rules') loadNamesRules().catch(() => {});
    loadMining().catch(() => {});
    if (appsState) renderAppState('kachat', appsState.apps?.kachat ?? {});
    // A version check belongs to one node; drop it so Update cannot act on the other's.
    latestRelease = null;
    $('apply-update').disabled = true;
    $('update-status').className = 'update-status';
    $('update-status').textContent = 'Not checked yet.';
    $('release-notes').hidden = true;
}

// Sub-tabs marked data-mainnet-only (CSS hides them in the Testnet view) must not
// stay selected there: fall back to the section's first visible sub-tab.
function applyKaspadSubtabsForView() {
    if (networkView !== 'testnet') return;
    for (const section of document.querySelectorAll('section.tab')) {
        const active = section.querySelector('.subtab-btn.active');
        if (!active || !active.hasAttribute('data-mainnet-only')) continue;
        const first = section.querySelector('.subtab-btn:not([data-mainnet-only])');
        if (first) selectSubtab(section, first.dataset.subtab);
    }
}

// Restore the remembered view on load (default mainnet = full nav).
applyNetworkView((() => {
    try {
        return localStorage.getItem(NET_VIEW_KEY) === 'testnet' ? 'testnet' : 'mainnet';
    } catch {
        return 'mainnet';
    }
})());

// --- sub-tabs (panels inside one destination) ---

function selectSubtab(section, name) {
    for (const button of section.querySelectorAll('.subtab-btn')) {
        button.classList.toggle('active', button.dataset.subtab === name);
    }
    for (const panel of section.querySelectorAll(':scope > .subtab')) {
        panel.classList.toggle('active', panel.id === `sub-${name}`);
    }
    // A log card only streams while it is on screen.
    syncSvcLog();
    // The world map is fetched the first time "Am I public?" is opened.
    if (name === 'public') loadPublicMap().catch(() => {});
    // The go-public wizard reads live state each time it is opened.
    if (name === 'public-howto') loadGoPublic().catch(() => {});
    // The ROI calculator seeds itself from the connected miners on open.
    if (name === 'mining-roi') loadRoi().catch(() => {});
    // A KaChat panel loads when it is opened rather than all of them upfront.
    // Chess is its own read-only view (the leaderboard the indexer replays), so it
    // loads its own data rather than the general indexer-panel refresh.
    if (name === 'kachat-chess') loadChess().catch(() => {});
    if (name === 'kachat-profiles') loadProfiles().catch(() => {});
    if (name === 'kachat-updates') loadTestnetIndexerUpdate().catch(() => {});
    else if (name === 'kachat-transfer') { loadBackup().catch(() => {}); loadReindex().catch(() => {}); refreshKachatPanel(); }
    else if (name.startsWith('kachat-')) refreshKachatPanel();
    // Its own call: refreshKachatPanel gives up when the indexer is not
    // running, and this screen works without it -- the engine it configures is
    // a different container.
    if (name === 'kachat-translate') loadTranslate().catch(() => {});
    // Same for the release list: it costs a GitHub call, so it is fetched when
    // the tab that shows it is opened rather than on every page load.
    if (name === 'updates') loadReleasePicker().catch(() => {});
    if (name === 'kassigner-updates') loadKassignerReleases().catch(() => {});
    setGlobalAppUpdates(name === 'global-update');
    if (name === 'names-rules') loadNamesRules().catch(() => {});
    if (name === 'names-refunds') loadKeeper().catch(() => {});
    if (name === 'global-cache') loadDiskCache().catch(() => {});
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

/**
 * Only for switches nothing else owns.
 *
 * The switch means one thing: this container is running. Several screens used
 * to write it from their own saved 'enabled' flag instead -- the mining tab
 * every five seconds, the apps tab on its own poll -- while loadServices wrote
 * what docker actually reported. A service that is installed and stopped has
 * enabled=true and running=false, so the two pollers took turns and the switch
 * flipped itself back and forth without anybody touching it. It looked exactly
 * like a service starting and stopping on its own.
 *
 * loadServices is the only writer for anything with a container now.
 */
function setNavSwitch(service, on, { disabled = false, reason = '' } = {}) {
    const input = navSwitch(service);
    if (!input || input.dataset.busy === '1') return;
    input.checked = Boolean(on);
    input.disabled = disabled;
    const label = input.closest('.switch');
    if (label) label.title = disabled && reason ? reason : label.getAttribute('aria-title') || label.title;
}

// ------------------------------------------------------- blocking actions ---

/**
 * Installing, starting, stopping and uninstalling take over the screen.
 *
 * They used to run in the background: a toast, and a log in the corner. That
 * reads as though the panel can do several of these at once, and it cannot --
 * there is one docker daemon, and the jobs queue. Clicking a switch while
 * Nextcloud was building put a five-second stop behind a twenty-minute build,
 * which from the outside is indistinguishable from a switch that does nothing.
 *
 * So: one at a time, everything else covered and blurred while it runs, the log
 * in front of you, and no way out until it is finished. Slower to look at, and
 * it never lies about what is happening.
 */
let pendingAction = null;

/**
 * Lines that arrived before we knew which job was ours.
 *
 * The server queues the job and starts streaming it before it answers the
 * request that asked for it, so the first lines of a fast job can beat their
 * own job id back to the browser. Held by id until an action claims them.
 */
const earlyLines = new Map();
const earlyEnds = new Map();

/**
 * How far along the thing in the overlay is.
 *
 * There is no honest single number for "install KaChat": it is a Rust build
 * that takes half an hour, and docker does not know how long it has left any
 * more than we do. What there is, is a log that says what has happened, so the
 * bar is driven entirely by that -- every position it takes is something the
 * job has actually reported, and it only ever moves forwards.
 *
 * Between two reports it stops, because inventing movement is how a progress
 * bar starts lying. The stripes are what say it is still working; the elapsed
 * clock beside it is the other real number on offer.
 */
const ACTION_MARKS = [
    // Our own phase lines, from lifecycle.js and the routes.
    [/^Building /i, 0.04],
    [/^Removing the .* containers/i, 0.2],
    [/^Deleting volume /i, 0.55],
    [/^Keeping \d+ volume/i, 0.55],
    [/^Starting /i, 0.35],
    [/^Stopping /i, 0.35],
    [/^Creating the .* container/i, 0.86],
    [/^Recreating /i, 0.5],
    [/removed: \d+ container/i, 0.95],
    [/is installed and switched off/i, 0.97],

    // Compose's own progress, which is the tail of nearly every job here.
    [/\bPulling fs layer\b|\bPulling\b.*\.\.\.$/i, 0.1],
    [/\bDownload complete\b|\bPull complete\b/i, 0.3],
    [/Container .* (?:Creating|Created)\b/i, 0.9],
    [/Container .* (?:Starting|Started|Running|Stopping|Stopped|Removing|Removed)\b/i, 0.94],
    [/Volume .* (?:Creating|Created|Removing|Removed)\b/i, 0.9],
    [/Network .* (?:Creating|Created)\b/i, 0.88],

    // cargo, at the end of the long one.
    [/Finished `release` profile/i, 0.82],
];

/**
 * BuildKit's own step counter: "#21 [ourbuild 9/9] RUN cargo build --release",
 * and the line that ends a stage: "#22 DONE 1889.6s".
 *
 * Kept per stage. Two of these build in parallel and report interleaved, so
 * reading whichever line arrived last as "the" progress makes the bar jump to
 * whatever the furthest-along stage has reached while the other is barely
 * started. The average across the stages seen is the honest reading.
 */
const BUILDKIT_STEP = /^(#\d+) \[[^\]]*?(\d+)\/(\d+)\]/;
const BUILDKIT_DONE = /^(#\d+) DONE\b/;

let progressTimer = null;

function resetProgress() {
    const bar = $('action-bar');
    const fill = $('action-bar-fill');
    bar.hidden = false;
    bar.className = 'action-bar working';
    bar.setAttribute('aria-valuenow', '0');
    fill.style.width = '0%';

    clearInterval(progressTimer);
    progressTimer = setInterval(tickElapsed, 1000);
    tickElapsed();
}

function setProgress(fraction) {
    if (!pendingAction || pendingAction.finished) return;
    // Forwards only. Two builds run in parallel and report their steps
    // interleaved, so the raw numbers go up and down; a bar that does the same
    // is worse than no bar.
    const next = Math.max(pendingAction.progress ?? 0, Math.min(fraction, 0.99));
    if (next === pendingAction.progress) return;
    pendingAction.progress = next;
    $('action-bar-fill').style.width = `${(next * 100).toFixed(1)}%`;
    $('action-bar').setAttribute('aria-valuenow', String(Math.round(next * 100)));
}

/** Reads one log line for anything that says where the job has got to. */
function progressFromLine(line) {
    if (!pendingAction) return;
    const stages = (pendingAction.stages ??= new Map());

    const step = BUILDKIT_STEP.exec(line);
    const done = BUILDKIT_DONE.exec(line);
    if (step && Number(step[3]) > 0) stages.set(step[1], Number(step[2]) / Number(step[3]));
    else if (done) stages.set(done[1], 1);

    if (step || done) {
        const mean = [...stages.values()].reduce((a, b) => a + b, 0) / stages.size;
        // The build occupies the middle of the bar: something has already
        // happened before the first step, and creating the container still has
        // to happen after the last one.
        return setProgress(0.06 + 0.74 * mean);
    }

    for (const [re, fraction] of ACTION_MARKS) {
        if (re.test(line)) return setProgress(fraction);
    }
}

function tickElapsed() {
    if (!pendingAction) return;
    const seconds = Math.round((Date.now() - pendingAction.startedAt) / 1000);
    const label = seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m ${String(seconds % 60).padStart(2, '0')}s`;
    $('action-elapsed').textContent = label;
}

function openAction({ key, title, note }) {
    const action = { key, title, jobId: null, finished: false, resolve: null, progress: 0, startedAt: Date.now() };
    action.done = new Promise((resolve) => {
        action.resolve = resolve;
    });
    pendingAction = action;

    $('action-title').textContent = title;
    $('action-note').textContent = note ?? '';
    $('action-log').textContent = '';
    $('action-spinner').hidden = false;
    // Docker can take a few seconds to say anything at all, and an empty black
    // box for those seconds reads as nothing having happened.
    actionAppend(`> ${title}…`);
    // Hidden rather than disabled-and-labelled: the bar says how far along this
    // is, and Cancel is the only thing to press until it finishes.
    const close = $('action-close');
    close.disabled = true;
    close.hidden = true;
    const cancel = $('action-cancel');
    cancel.hidden = true;
    cancel.disabled = false;
    cancel.textContent = 'Cancel';
    resetProgress();
    $('action-overlay').hidden = false;
    return action;
}

function actionAppend(line) {
    const log = $('action-log');
    if (!log) return;
    progressFromLine(line);
    const atBottom = log.scrollHeight - log.scrollTop - log.clientHeight < 40;
    log.textContent += `${line}\n`;
    if (atBottom) log.scrollTop = log.scrollHeight;
}

/** Ours, somebody else's, or too early to tell. */
function actionLine(jobId, line) {
    if (!pendingAction || pendingAction.finished) return;
    if (pendingAction.jobId === jobId) return actionAppend(line);
    if (pendingAction.jobId === null) {
        const held = earlyLines.get(jobId) ?? [];
        held.push(line);
        earlyLines.set(jobId, held);
    }
}

/** Takes ownership of a job id, and of anything it printed before we had it. */
function adoptActionJob(jobId) {
    if (!pendingAction) return;
    pendingAction.jobId = jobId;
    // Nothing can be cancelled until there is something to name, and some
    // things are not cancellable at all.
    $('action-cancel').hidden = pendingAction.cancellable === false;
    for (const line of earlyLines.get(jobId) ?? []) actionAppend(line);
    earlyLines.clear();
    const ended = earlyEnds.get(jobId);
    earlyEnds.clear();
    if (ended) finishAction(ended);
}

/** The job is over. Only now is there a way out of this. */
function finishAction(job) {
    if (!pendingAction || pendingAction.finished) return;
    const cancelled = job.status === 'cancelled';
    const ok = job.status === 'succeeded';
    actionAppend(
        cancelled
            ? '\n■ Cancelled. Anything it had already done is still done.'
            : ok
              ? '\n✓ Done.'
              : `\n✗ Failed: ${job.error ?? 'it did not finish'}`,
    );

    pendingAction.finished = true;
    $('action-spinner').hidden = true;
    $('action-cancel').hidden = true;
    $('action-title').textContent = `${pendingAction.title}: ${cancelled ? 'cancelled' : ok ? 'done' : 'failed'}`;

    // Full either way: the bar tracks the job reaching its end, not the job
    // succeeding. Which of those happened is the colour, the title and the last
    // line of the log.
    clearInterval(progressTimer);
    progressTimer = null;
    tickElapsed();
    $('action-bar').className = `action-bar${ok || cancelled ? '' : ' failed'}`;
    $('action-bar-fill').style.width = '100%';
    $('action-bar').setAttribute('aria-valuenow', '100');

    const close = $('action-close');
    close.disabled = false;
    close.hidden = false;
    close.focus();
    // Resolved rather than rejected even when the job failed: every caller
    // wants to know how it went, and none of them want an exception for a
    // container that would not start.
    pendingAction.resolve({ ...job, ok });
}

/** Called by the job stream when any job ends, ours or not. */
function actionJobEnded(job) {
    if (!pendingAction || pendingAction.finished) return;
    if (pendingAction.jobId === job.id) return finishAction(job);
    // A job that failed before its request came back -- 'no such service' is
    // instant. Held, or the overlay waits forever for a job that is over.
    if (pendingAction.jobId === null) earlyEnds.set(job.id, job);
}

/** Jobs the overlay has been closed on, so a reconnect does not reopen them. */
const dismissedJobs = new Set();

function closeAction() {
    if (!pendingAction?.finished) return;
    if (pendingAction.jobId) dismissedJobs.add(pendingAction.jobId);
    clearInterval(progressTimer);
    progressTimer = null;
    $('action-overlay').hidden = true;
    pendingAction = null;
    earlyLines.clear();
    earlyEnds.clear();

    // What exists, what is running and what every tab shows can all have
    // changed while this was on screen. Failures here are the panel not
    // knowing something yet, which the next poll fixes.
    for (const reload of [loadServices, refreshStatus, loadMining, loadApps, loadKassigner, loadProxies]) {
        Promise.resolve(reload()).catch(() => {});
    }
}

$('action-close').addEventListener('click', closeAction);

// Escape is the usual way out of a dialog, and here it must not be one until
// the job has finished. Capturing, so nothing else sees the key first.
document.addEventListener(
    'keydown',
    (event) => {
        if (!pendingAction) return;
        if (event.key === 'Escape') {
            event.preventDefault();
            event.stopPropagation();
            if (pendingAction.finished) closeAction();
            return;
        }
        // The overlay stops the mouse reaching the page behind it; tab does not
        // care about overlays, so focus is put back by hand.
        if (event.key === 'Tab') {
            const card = el('.action-card');
            if (card && !card.contains(document.activeElement)) {
                event.preventDefault();
                $('action-close').focus();
            }
        }
    },
    true,
);



/**
 * For the one action that ends by removing the panel.
 *
 * Nothing will ever report that it finished, because the thing that would do
 * the reporting is what gets removed. So the panel going quiet is the signal,
 * and it is confirmed rather than assumed: two failed health checks in a row,
 * three seconds apart, so a single dropped request does not declare the stack
 * gone while it is still working.
 */
function watchForPanelGone() {
    let misses = 0;
    const timer = setInterval(async () => {
        if (!pendingAction?.terminal || pendingAction.finished) return clearInterval(timer);
        try {
            const res = await fetch('/healthz', { cache: 'no-store' });
            if (res.ok) {
                misses = 0;
                return;
            }
            misses += 1;
        } catch {
            misses += 1;
        }
        if (misses < 2) return;

        clearInterval(timer);
        actionAppend('');
        actionAppend('The panel has been removed, so there is nothing left here to report from.');
        actionAppend('The last steps -- its own image, the network and the install directory -- finish in the container doing the removing.');
        finishAction({ status: 'succeeded' });
    }, 3000);
}

/**
 * Stop the job the overlay is watching.
 *
 * Confirmed, and the confirmation is the honest part: cancelling does not
 * rewind. A build keeps the layers it finished, an uninstall does not put back
 * what it removed, and a container that was half-way up is left wherever the
 * kill found it. What it buys is not spending the next half hour on something
 * you no longer want.
 */
$('action-cancel').addEventListener('click', async () => {
    const action = pendingAction;
    if (!action?.jobId || action.finished) return;
    if (
        !await askConfirm(
            `Cancel "${action.title}"?\n\n` +
                'Whatever it has already done stays done -- this stops it where it is rather than undoing it. ' +
                'A build keeps the parts it finished, so starting again does not start from the beginning.',
        )
    ) {
        return;
    }

    const button = $('action-cancel');
    button.disabled = true;
    button.textContent = 'Cancelling…';
    try {
        await api(`/api/jobs/${action.jobId}/cancel`, { method: 'POST' });
    } catch (e) {
        // It finished on its own between the click and the request, most
        // likely. The end event says which, so this only reports and waits.
        actionAppend(`Could not cancel: ${e.message}`);
        button.disabled = false;
        button.textContent = 'Cancel';
    }
});

/**
 * Runs one of them: opens the overlay, starts the job, and resolves when the
 * job has finished -- not when the overlay is dismissed, which is the user's
 * own time and nothing should wait for it.
 */
async function runAction({ key, title, note, request, cancellable = true, terminal = false }) {
    if (pendingAction) {
        toast('Something else is running. Wait for it to finish.', 'bad');
        return null;
    }
    const action = openAction({ key, title, note });
    // Some things must not be stopped half way. Removing everything is the one:
    // it deletes the panel itself, so a cancel would land on a stack that is
    // partly gone with nothing left to finish taking it apart.
    action.cancellable = cancellable;
    // And this one ends by taking the panel away, so the log stopping is the
    // result rather than a fault.
    action.terminal = terminal;
    if (terminal) watchForPanelGone();

    let response;
    try {
        response = await request();
    } catch (e) {
        finishAction({ status: 'failed', error: e.message });
        return action.done;
    }

    // Something that finished inside the request itself, with no job to watch.
    // "Already on the newest version" is a real answer, and an overlay that
    // only ever says Done would hide it.
    if (!response?.jobId) {
        if (response?.message) actionAppend(response.message);
        finishAction({ status: 'succeeded' });
        return action.done;
    }
    adoptActionJob(response.jobId);
    return action.done;
}

/**
 * Updates and rebuilds go to the Update Queue (System, Update Queue) instead of
 * the overlay. A build can take half an hour, and the overlay meant watching
 * every one of them before the next could be asked for. Now each Update click
 * lines its job up and hands the page straight back; the manager runs them one
 * at a time in the order they were asked for, and the queue page shows the one
 * running (its log and how long it has been going) and what waits behind it.
 *
 * `request(headers)` must pass the headers to its api() call: they tell the
 * manager this job is a queued one, and what to call it there.
 */
const queueEnds = new Map();
// Jobs that ended before this page was waiting on them (an instant failure can
// beat its own job id back), kept briefly so the wait still settles.
const queueEnded = new Map();

/** A job ended: settle whoever is waiting on it, or keep it for whoever is about to. */
function settleQueueJob(job) {
    const waiter = queueEnds.get(job.id);
    if (waiter) {
        queueEnds.delete(job.id);
        waiter(job);
        return;
    }
    queueEnded.set(job.id, job);
    if (queueEnded.size > 50) queueEnded.delete(queueEnded.keys().next().value);
}

/**
 * Resolves with the job ({ ok, status, error, ... }) once it has finished, so a
 * switch can stay held until then and flip back on failure; the page itself
 * stays usable the whole time. `noCancel`: once started it runs to the end.
 */
let queueActionsInFlight = 0;

async function queueAction({ title, request, onEnd, noCancel = false }) {
    const headers = { 'X-KQS-Queue': '1', 'X-KQS-Queue-Title': encodeURIComponent(title) };
    if (noCancel) headers['X-KQS-No-Cancel'] = '1';
    let response;
    queueActionsInFlight += 1;
    try {
        response = await request(headers);
    } catch (e) {
        toast(`${title}: ${e.message}`, 'bad');
        return { ok: false, status: 'failed', error: e.message };
    } finally {
        // A fast job's start event can beat its own request back; held a moment longer so
        // that start is not announced twice.
        setTimeout(() => (queueActionsInFlight -= 1), 1500);
    }
    // Answered on the spot ("already on the newest version"): nothing to queue.
    if (!response?.jobId) {
        toast(response?.message ?? `${title}: nothing to do.`);
        return { ok: true, status: 'succeeded' };
    }
    const ended = new Promise((resolve) => {
        const finish = (job) => {
            const result = { ...job, ok: job.status === 'succeeded' };
            Promise.resolve()
                .then(() => onEnd?.(result))
                .catch(() => {});
            resolve(result);
        };
        const early = queueEnded.get(response.jobId);
        if (early) {
            queueEnded.delete(response.jobId);
            finish(early);
        } else queueEnds.set(response.jobId, finish);
    });
    const ahead = updateQueue.current ? 1 + updateQueue.pending.length : 0;
    // A small log popup rather than a toast, which is easy to miss: it shows the first lines
    // and goes away on its own; the topbar badge keeps the count.
    queuePeek.show(response.jobId, title, ahead ? `waiting, ${ahead} ahead of it` : 'starting');
    loadUpdateQueue();
    return ended;
}

const ACTION_VERBS = { start: 'Starting', stop: 'Stopping', restart: 'Restarting' };

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
const start = (key) => (on, headers) => api(`/api/services/${key}/${on ? 'start' : 'stop'}`, { method: 'POST', headers });

const SERVICE_ACTIONS = {
    node: (on, headers) => api(`/api/node/${on ? 'start' : 'stop'}`, { method: 'POST', headers }),
    // Not a container: it fetches and verifies firmware, so there is nothing to
    // install or leave running.
    kassigner: (on, headers) => api('/api/kassigner', { method: 'PUT', body: { enabled: on }, headers }),
    mining: start('mining'),
    kachat: start('kachat'),
    desktop: start('desktop'),
    nextcloud: start('nextcloud'),
    bot: start('bot'),
    // No sidebar row: its switch lives on the indexer's Translation tab.
    translate: start('translate'),
    proxy: start('proxy'),
    // Mainnet's unit (the Testnet view maps the switch to kachat-domains-testnet).
    'kachat-domains': start('kachat-domains'),
};

const SERVICE_NAMES = {
    node: 'the node',
    mining: 'mining',
    kachat: 'KaChat-Indexer',
    desktop: 'KaChat-Desktop',
    kassigner: 'KasSigner',
    nextcloud: 'Nextcloud',
    bot: 'the KaChat Bot',
    translate: 'the translation engine',
    proxy: 'the reverse proxy',
    'kachat-domains': '.kachat Domains',
};

for (const input of document.querySelectorAll('[data-service]')) {
    input.addEventListener('change', async () => {
        const service = input.dataset.service;
        const wanted = input.checked;
        const name = SERVICE_NAMES[service] ?? service;

        // Held across the whole action so the status poll cannot flip the
        // switch back and forth underneath what is happening.
        input.dataset.busy = '1';
        input.disabled = true;

        // Push is not a container: flip the indexer's master flag instead of start/stop, applied
        // on a short indexer restart (same restart "Save push settings" does).
        if (service === 'push') {
            const job = await queueAction({
                title: wanted ? 'Turning push on' : 'Turning push off',
                request: (headers) => api('/api/push/config', { method: 'POST', body: { pushEnabled: wanted }, headers }),
            });
            if (!job?.ok) input.checked = !wanted; // setting .checked fires no change event
            input.dataset.busy = '0';
            input.disabled = false;
            loadPush().catch(() => {});
            return;
        }

        // Stopping the reverse proxy while you are viewing this panel THROUGH it
        // pulls the route out from under the reply: the stop succeeds, but this
        // page hangs on "Stopping…" forever because nothing can answer it any
        // more. Warn first, and point at the panel's direct address so they can
        // get back in and turn it on again.
        if (service === 'proxy' && !wanted && panelAccess.viaProxy) {
            const where = panelAccess.directUrl || 'the panel on its own port';
            const proceed = await askConfirm(
                'You are viewing this panel through the reverse proxy, so stopping it will ' +
                    'disconnect you and this page will freeze on "Stopping…".\n\n' +
                    `Open the panel directly at ${where} on the machine running the node first, ` +
                    'then stop the proxy from there.\n\nStop it anyway?',
            );
            if (!proceed) {
                input.checked = !wanted; // setting .checked fires no change event
                input.dataset.busy = '0';
                input.disabled = false;
                return;
            }
        }

        // In the testnet view the shared switches drive the *-testnet units via the
        // generic start/stop route; mainnet keeps its bespoke actions (the node's
        // start/stop is a dedicated endpoint, not /api/services/node).
        const unitKey = effectiveService(service);
        // Anything without a bespoke action goes through the generic route, so a new switch can
        // never fail in the browser for want of an entry here.
        const request = unitKey === service ? (SERVICE_ACTIONS[service] ?? start(service)) : (on, headers) => start(unitKey)(on, headers);

        // Into the Update Queue; the switch stays held until the job has finished.
        const job = await queueAction({
            title: `${wanted ? 'Starting' : 'Stopping'} ${name}${unitKey !== service ? ' (testnet)' : ''}`,
            request: (headers) => request(wanted, headers),
        });

        // Setting .checked does not fire change, so putting the switch back is
        // not another request.
        if (!job?.ok) input.checked = !wanted;
        input.dataset.busy = '0';
        input.disabled = false;
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
    if (!pollTimer) pollTimer = setInterval(refreshStatusPoll, 4000);
};
const stopPolling = () => {
    clearInterval(pollTimer);
    pollTimer = null;
    setMiningPolling(false);
    setHostPolling(false);
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

const refreshStatusPoll = noOverlap(() => refreshStatus());

async function refreshStatus() {
    let s;
    const testnet = networkView === 'testnet';
    try {
        s = await api(testnet ? '/api/status-testnet' : '/api/status');
    } catch {
        return;
    }
    if (reloadIfManagerRestarted(s.bootId)) return;
    // The view may have flipped while this was in flight; a stale answer for the
    // other node must not paint over the current one.
    if (testnet !== (networkView === 'testnet')) return;
    // lastStatus is read as "the mainnet node" elsewhere, so testnet never sets it.
    if (!testnet) lastStatus = s;

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
    // The shared node switch/dot belong to the testnet unit while that view is on;
    // loadServices renders them from the testnet state then.
    if (networkView !== 'testnet') {
        setNavSwitch('node', running);
        setNavHealth('kaspad', !running ? 'bad' : synced ? 'ok' : 'warn');
    }
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

    // The Testnet view shows the testnet node's own ports (162xx/172xx/182xx);
    // mainnet's status never drives that table.
    if (networkView === 'testnet') renderTestnetPorts();
    else renderPorts(s);
    applyNodeGating(s);
}

async function renderTestnetPorts() {
    try {
        renderPorts(await api('/api/ports-testnet'));
    } catch {
        /* the next status poll tries again */
    }
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

    // Never disabled, in either direction.
    //
    // These switches used to grey out whenever the node was not ready, which
    // made both halves of them unavailable: you could not stop something that
    // was running, and you could not start something that is perfectly capable
    // of waiting. Neither service needs the node to be up to be started -- the
    // bridge and the indexer both sit in a retry loop until it is there, which
    // is what they do anyway every time the node restarts underneath them.
    //
    // What the node's state changes is what the service can usefully do, and
    // the banner on the tab says that. It does not change who is allowed to
    // press the switch.
    for (const service of ['mining', 'kachat']) {
        const input = navSwitch(service);
        if (!input || input.dataset.busy === '1') continue;
        input.disabled = false;
        const label = input.closest('.switch');
        if (label) {
            label.title = ready
                ? `Start or stop ${SERVICE_NAMES[service]}`
                : `Start or stop ${SERVICE_NAMES[service]}. ${lockReason} It waits until then.`;
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

// A port switch the user just flipped, kept where they put it until the node
// reports the same thing back. Flipping a port restarts the node, and a status
// poll landing mid restart would otherwise redraw the switch from the state it
// is leaving -- which is the "flips back on its own" this fixes.
const pendingPorts = new Map(); // `${key}:${axis}` -> { value, until }
// Last table markup written, so a poll that changed nothing skips the DOM write
// -- what keeps the switches from churning (and feeling laggy) under the pointer.
let lastPortsHtml = '';

// --- Unsafe RPC vs RPC that other machines can reach (KQS-024) ---
// --unsaferpc lets any RPC client shut the node down or ban and add peers, so it must never meet
// an RPC endpoint published on the network or through Proxy & domains. Not forbidden (an
// operator may know their firewall), but confirmed twice and flagged in red while both are true.
const RPC_PORT_KEYS = new Set(['grpc', 'borsh', 'json']);
const RPC_PROXY_KINDS = new Set(['borsh', 'json', 'grpc']);
let lastPortMatrix = [];

const unsafeRpcOn = () => Boolean(currentConfig?.flags?.unsaferpc);

/** How the node's RPC is reachable from other machines, in words ([] when it is not). */
function rpcPublishedVia() {
    const out = lastPortMatrix.filter((p) => RPC_PORT_KEYS.has(p.key) && p.public).map((p) => `${p.name} port ${p.port} on the network`);
    for (const p of proxies ?? []) {
        if (p.enabled !== false && RPC_PROXY_KINDS.has(p.target?.kind)) out.push(`${p.domain} through Proxy & domains`);
    }
    return out;
}

function renderUnsafeRpcNotice() {
    const via = unsafeRpcOn() ? rpcPublishedVia() : [];
    const text = via.length
        ? `Unsafe RPC calls are on while the node's RPC is reachable from other machines (${via.join(', ')}). ` +
          'Anyone who can reach it can shut the node down or ban its peers. Turn off unsafe RPC (Kaspad, Settings) or stop publishing RPC.'
        : '';
    for (const id of ['unsafe-rpc-notice-ports', 'unsafe-rpc-notice-proxy']) {
        const el = $(id);
        if (!el) continue;
        el.hidden = !text;
        el.textContent = text;
    }
}

async function confirmUnsafeRpc(what) {
    return askConfirm(
        `${what}\n\nWith unsafe RPC calls on, anyone who can reach the node's RPC can shut the node down or ban and add its peers. ` +
            'Only do this if you are sure nothing outside your own machines can reach it.',
    );
}

$('cfg-flag-unsaferpc')?.addEventListener('change', async (event) => {
    const via = rpcPublishedVia();
    if (!event.target.checked || !via.length) return;
    if (!await confirmUnsafeRpc(`Turn on unsafe RPC calls while the node's RPC is reachable from other machines (${via.join(', ')})?`)) {
        event.target.checked = false;
    }
});

function renderPorts(s) {
    lastPortMatrix = s.portMatrix || [];
    renderUnsafeRpcNotice();
    const publishedSet = new Set(s.published.map((p) => (p.container || '').split('/')[0]));
    const now = Date.now();

    // The switch shows intent; the node's own reading catches up a few seconds
    // later. When it matches -- or the grace window lapses -- the hold is done.
    const effective = (key, axis, serverOn) => {
        const id = `${networkView}:${key}:${axis}`;
        const held = pendingPorts.get(id);
        if (!held) return serverOn;
        if (held.value === serverOn || now > held.until) {
            pendingPorts.delete(id);
            return serverOn;
        }
        return held.value;
    };

    const sw = (p, axis, on, enabled, title) =>
        `<label class="switch" title="${escapeHtml(title)}">
           <input type="checkbox" data-port="${p.key}" data-axis="${axis}" ${on ? 'checked' : ''} ${enabled ? '' : 'disabled'}>
           <span class="track"></span>
         </label>`;

    const html = (s.portMatrix || [])
        .map((p) => {
            const live = publishedSet.has(String(p.port));
            const localOn = effective(p.key, 'local', p.local);
            const publicOn = effective(p.key, 'public', p.public);
            // The dot keeps telling the truth about what the node is doing, so a
            // held switch reads as "applying…" until the change actually lands.
            const applying = localOn !== p.local || publicOn !== p.public;
            const now = publicOn ? 'public' : localOn ? 'local' : 'off';
            const state = applying
                ? { cls: '', text: 'applying…' }
                : now === 'off'
                  ? p.forcedListen
                      ? { cls: 'warn', text: 'internal only, in use by another service in this stack' }
                      : { cls: 'off', text: 'not published' }
                  : now === 'local'
                    ? { cls: 'warn', text: 'reachable from this machine only (127.0.0.1)' }
                    : live
                      ? { cls: 'ok', text: 'public, reachable from the network (0.0.0.0)' }
                      : { cls: '', text: 'applying…' };
            // Local is the base switch; Public sits on top of it, so it only
            // opens once the port is at least local. Pinned ports are always
            // local, so their Public switch is free to move.
            const localCell = p.pinned
                ? `<span class="locked" title="${escapeHtml(p.localNote)}">always</span>`
                : sw(p, 'local', localOn, true, p.localNote);
            const publicCell = sw(p, 'public', publicOn, p.pinned || localOn, p.publicNote);
            const title = `${p.name}: ${state.text}${p.required ? '. This is the one to forward on your router to be a public node.' : ''}`;
            return `<tr title="${escapeHtml(title)}">
      <td class="port"><span class="dot ${state.cls}"></span>${p.port}</td>
      <td>${escapeHtml(p.name)}${p.required ? ' <span class="tag">required</span>' : ''}</td>
      <td class="toggle">${localCell}</td>
      <td class="toggle">${publicCell}</td>
      <td><button class="ghost" data-portcheck="${p.port}" ${p.public ? '' : 'disabled'}>Test</button></td>
    </tr>`;
        })
        .join('');
    // Steady state renders the identical string every poll; skipping the write
    // then leaves the switches (and any focus/press state) alone.
    if (html !== lastPortsHtml) {
        lastPortsHtml = html;
        $('ports-body').innerHTML = html;
    }
}

// Flipping either switch restarts the node with that change applied.
$('ports-body').addEventListener('change', async (event) => {
    const { port: key, axis } = event.target.dataset ?? {};
    if (!key || !axis) return;
    const value = event.target.checked;
    if (value && axis === 'public' && RPC_PORT_KEYS.has(key) && unsafeRpcOn()) {
        const name = lastPortMatrix.find((p) => p.key === key)?.name ?? key;
        if (!await confirmUnsafeRpc(`Open ${name} to the network while unsafe RPC calls are on?`)) {
            event.target.checked = false;
            return;
        }
    }
    // Hold the intent so the next status poll cannot redraw it back while the
    // node restarts with the change. renderPorts clears the hold once the node
    // reports the same value, or after this grace window if it never takes.
    // The Testnet view drives the testnet node only; mainnet is never touched from it.
    const hold = `${networkView}:${key}:${axis}`;
    pendingPorts.set(hold, { value, until: Date.now() + 60_000 });
    event.target.disabled = true;
    try {
        const route = networkView === 'testnet' ? `/api/ports-testnet/${key}` : `/api/ports/${key}`;
        await api(route, { method: 'POST', body: { [axis]: value } });
    } catch (e) {
        // The node was not changed; drop the hold and put the switch back.
        pendingPorts.delete(hold);
        event.target.checked = !value;
        toast(e.message, 'bad');
    } finally {
        event.target.disabled = false;
    }
});

document.addEventListener('click', async (event) => {
    const port = event.target.dataset?.portcheck;
    if (!port) return;
    event.target.disabled = true;
    event.target.textContent = 'Testing…';
    try {
        const r = await api(`/api/portcheck?port=${port}`);
        // No address in the message (screen-recording safe): it is this connection's.
        toast(`Your public address, port ${r.port}, is ${r.open ? 'open' : 'closed'}. ${r.note}`, r.open ? 'good' : 'bad');
    } catch (e) {
        toast(e.message, 'bad');
    } finally {
        event.target.disabled = false;
        event.target.textContent = 'Test';
    }
});

// The same three actions as the sidebar switch, so the same overlay.
for (const button of document.querySelectorAll('[data-node]')) {
    button.addEventListener('click', async () => {
        const action = button.dataset.node;
        await queueAction({
            title: `${ACTION_VERBS[action] ?? action} the node`,
            request: (headers) => api(`/api/node/${action}`, { method: 'POST', headers }),
        });
    });
}


// ---------------------------------------------------------------- updates ---

let latestRelease = null;

/**
 * The one update-status look, shared by every "Check for updates" in the panel
 * so kaspad, mining and every app read the same way as Global settings: a lit,
 * breathing arrow when an update is waiting, a calm green tick when current,
 * red on error, and plain for "nothing to compare yet". `state` is one of
 * 'checking' | 'info' | 'available' | 'current' | 'error'.
 */
function setUpdateStatus(el, state, text) {
    if (!el) return;
    el.hidden = false;
    const cls = { available: 'available', current: 'current', error: 'error' }[state] ?? '';
    el.className = cls ? `update-status ${cls}` : 'update-status';
    const prefix = state === 'available' ? '⬆ ' : state === 'current' ? '✓ ' : '';
    el.textContent = `${prefix}${text}`;
}

// --- Global settings > Updates: every running app's updates in one list ---

/**
 * One row per app switched on in the sidebar (and shown in this network view): its build, its
 * update status as its own Updates tab shows it, and Check / Update / Open. Check and Update
 * press that app's own buttons, so they behave exactly as there (confirmations included), and
 * Update is only pressable when the app's own is (a check found one). KasSigner writes firmware
 * to a device, so it only gets Open. Refreshed every second while this sub-tab is on screen.
 */
const APP_UPDATES = [
    { tab: 'kaspad', sub: 'updates', status: 'update-status', check: 'check-update', update: 'apply-update', build: 'stat-version' },
    { tab: 'kachat', sub: 'kachat-updates', status: 'kachat-update-status', check: 'kachat-check', update: 'kachat-update', build: 'kachat-build' },
    { tab: 'names', sub: 'names-updates', status: 'kd-update-status', check: 'kd-check', update: 'kd-update', build: 'kd-installed' },
    { tab: 'desktop', sub: 'desktop-updates', status: 'desktop-update-status', check: 'desktop-check', update: 'desktop-update', build: 'desktop-build' },
    { tab: 'nextcloud', sub: 'nextcloud-updates', status: 'nextcloud-update-status', check: 'nextcloud-check', update: 'nextcloud-update', build: 'nextcloud-build' },
    { tab: 'bot', sub: 'bot-updates', status: 'bot-update-status', check: 'bot-check', update: 'bot-update', build: 'bot-build' },
    { tab: 'kassigner', sub: 'kassigner-updates', status: 'kassigner-update-status', check: 'kassigner-check', update: null, build: 'kassigner-build' },
];
let globalAppTimer = null;
let globalAppKey = '';

function runningApps() {
    return APP_UPDATES.filter((a) => {
        const row = document.querySelector(`.nav-item[data-tab="${a.tab}"]`)?.closest('.nav-row');
        return row && row.offsetParent !== null && row.querySelector('input[data-service]')?.checked;
    });
}

function setGlobalAppUpdates(on) {
    clearInterval(globalAppTimer);
    globalAppTimer = null;
    if (!on) return;
    globalAppKey = '';
    renderGlobalAppUpdates();
    globalAppTimer = setInterval(() => {
        if (!$('sub-global-update')?.classList.contains('active') || !$('tab-global')?.classList.contains('active')) {
            return setGlobalAppUpdates(false);
        }
        renderGlobalAppUpdates();
    }, 1000);
}

function renderGlobalAppUpdates() {
    const box = $('global-app-updates');
    if (!box) return;
    const apps = runningApps();
    const key = apps.map((a) => a.tab).join(',');
    // Rows are built when the set of apps changes and updated in place otherwise, so a button is
    // never replaced under the pointer.
    if (key !== globalAppKey) {
        globalAppKey = key;
        box.innerHTML = apps.length
            ? apps
                  .map((a) => {
                      const label = el('.label', document.querySelector(`.nav-item[data-tab="${a.tab}"]`))?.textContent || a.tab;
                      return `<div class="app-update-row" data-app="${a.tab}">
                        <div class="app-update-what"><strong>${escapeHtml(label)}</strong><small data-f="build"></small></div>
                        <div class="app-update-status" data-f="status"></div>
                        <div class="row">
                          <button type="button" class="ghost mini" data-press="${a.check}">Check</button>
                          ${a.update ? `<button type="button" class="primary mini" data-press="${a.update}" disabled>Update</button>` : ''}
                          <button type="button" class="ghost mini" data-open="${a.tab}/${a.sub}">Open</button>
                        </div>
                      </div>`;
                  })
                  .join('')
            : '<p class="muted">No apps switched on.</p>';
    }
    for (const a of apps) {
        const row = box.querySelector(`[data-app="${a.tab}"]`);
        if (!row) continue;
        const status = $(a.status);
        const statusBox = row.querySelector('[data-f="status"]');
        statusBox.textContent = status?.textContent?.trim() || 'Not checked yet.';
        statusBox.className = `app-update-status ${status?.className?.replace(/\bverdict\b/, '') ?? ''}`;
        row.querySelector('[data-f="build"]').textContent = $(a.build)?.textContent?.trim() || '';
        if (a.update) row.querySelector(`[data-press="${a.update}"]`).disabled = Boolean($(a.update)?.disabled);
    }
}

$('global-app-updates')?.addEventListener('click', (event) => {
    const press = event.target.closest('[data-press]');
    if (press && !press.disabled) {
        $(press.dataset.press)?.click();
        return;
    }
    const open = event.target.closest('[data-open]');
    if (open) {
        const [tab, sub] = open.dataset.open.split('/');
        selectTab(tab);
        selectSubtab($(`tab-${tab}`), sub);
    }
});

$('global-apps-check-all')?.addEventListener('click', () => {
    for (const a of runningApps()) $(a.check)?.click();
});

$('check-update').addEventListener('click', async () => {
    const status = $('update-status');
    setUpdateStatus(status, 'checking', 'Checking GitHub…');
    try {
        const r = await api(`/api/update/check${networkView === 'testnet' ? '?net=testnet' : ''}`);
        latestRelease = r;
        $('upstream-repo').textContent = r.repo;
        $('apply-update').disabled = !r.updateAvailable || !r.hasLinuxAsset;

        if (r.updateAvailable) {
            let text = `${r.latest} is available (you run ${r.current || 'an unknown version'}).`;
            if (!r.hasLinuxAsset) {
                text += ' That release has no linux build attached, so it cannot be installed automatically.';
            }
            setUpdateStatus(status, 'available', text);
        } else {
            setUpdateStatus(status, 'current', `Up to date: running ${r.current || '?'}, the newest release.`);
        }
        if (r.notes) {
            $('release-notes').hidden = false;
            $('release-notes-body').textContent = r.notes;
        }
    } catch (e) {
        setUpdateStatus(status, 'error', e.message);
    }
});

$('apply-update').addEventListener('click', async () => {
    if (!latestRelease) return;
    const testnet = networkView === 'testnet';
    const ok = await askConfirm(
        `Update ${testnet ? 'the testnet-10 kaspad' : 'kaspad'} to ${latestRelease.latest}?\n\n` +
            'The node will stop for a moment while the new version is installed. ' +
            'Your chain data is kept, so there is no resync.',
    );
    if (!ok) return;

    await queueAction({
        title: `Updating ${testnet ? 'the testnet kaspad' : 'kaspad'} to ${latestRelease.latest}`,
        request: async (headers) => {
            const r = await api('/api/update/apply', { method: 'POST', body: { version: latestRelease.latest, testnet }, headers });
            return r.alreadyCurrent ? { ...r, message: 'Already on the newest version. Nothing to do.' } : r;
        },
    });
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
        !await askConfirm(
            `Install kaspad ${version}?\n\n` +
                (running ? `You are running ${running}. ` : '') +
                'The node stops for a moment while it is built. Your chain data is kept, so there is no resync.',
        )
    ) {
        return;
    }
    await queueAction({
        title: `Installing ${networkView === 'testnet' ? 'the testnet kaspad' : 'kaspad'} ${version}`,
        request: (headers) => api('/api/update/apply', { method: 'POST', body: { version, testnet: networkView === 'testnet' }, headers }),
    });
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
    const testnet = networkView === 'testnet';
    const r = await api(testnet ? '/api/config-testnet' : '/api/config');
    currentConfig = r.config;
    const c = r.config;

    $('cfg-network').value = c.network;
    // The testnet node is always testnet-10; mainnet's selector is not offered there.
    $('cfg-network').disabled = testnet;

    for (const flag of FLAGS) $(`cfg-flag-${flag}`).checked = Boolean(c.flags[flag]);
    renderUnsafeRpcNotice();

    $('cfg-loglevel').value = c.tuning.logLevel;
    $('cfg-outpeers').value = c.tuning.outpeers;
    $('cfg-maxinpeers').value = c.tuning.maxinpeers;
    $('cfg-rpcmaxclients').value = c.tuning.rpcmaxclients;
    $('cfg-maxtracked').value = c.tuning.maxTrackedAddresses;
    $('cfg-ramscale').value = c.tuning.ramScale;
    $('cfg-retention').value = c.tuning.retentionPeriodDays ?? '';
    $('cfg-asyncthreads').value = c.tuning.asyncThreads ?? '';

    $('cfg-externalip').value = c.peering.externalip;
    $('cfg-externalip-auto').checked = Boolean(c.peering.externalipAuto);
    reflectExternalIpAuto();
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
        // per-port levels straight through so saving settings cannot revert them.
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
            externalipAuto: $('cfg-externalip-auto').checked,
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
        const route = networkView === 'testnet' ? '/api/config-testnet' : '/api/config';
        await api(route, { method: 'PUT', body: { config: collectConfig() } });
        setTimeout(loadSettings, 1500);
    } catch (e) {
        err.textContent = e.message;
        err.hidden = false;
    }
});

$('settings-reset').addEventListener('click', () => loadSettings());

// When auto-follow is on the manager owns the External IP, so the manual field
// and its button step aside rather than pretend to be in charge.
function reflectExternalIpAuto() {
    const auto = $('cfg-externalip-auto').checked;
    $('cfg-externalip').disabled = auto;
    $('cfg-externalip-detect').disabled = auto;
    $('cfg-externalip').placeholder = auto ? 'kept in step with your connection' : 'auto-detected';
}

$('cfg-externalip-auto').addEventListener('change', reflectExternalIpAuto);

$('cfg-externalip-detect').addEventListener('click', async () => {
    const btn = $('cfg-externalip-detect');
    btn.disabled = true;
    try {
        const { ip } = await api('/api/node/external-ip');
        $('cfg-externalip').value = ip;
        toast(`Filled in ${ip}. Save settings to apply it.`);
    } catch (e) {
        toast(e.message, 'bad');
    } finally {
        // Leave it disabled if auto took over in the meantime; otherwise re-enable.
        reflectExternalIpAuto();
    }
});

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

// Stratum ports shown on Connect: the testnet bridge listens on the mainnet ports + 100.
let miningPortOffset = 0;
const miningQuery = () => (networkView === 'testnet' ? '?net=testnet' : '');

// ---- Testnet: the CPU miner card ----
async function loadCpuMiner() {
    const r = await api('/api/cpuminer');
    const s = r.state ?? {};
    const tag = $('cpuminer-state');
    tag.textContent = !s.installed ? 'not installed' : s.running ? 'mining' : 'stopped';
    tag.className = `tag ${!s.installed ? 'off' : s.running ? 'ok' : ''}`;
    const h = r.stats?.hashrate;
    $('cpuminer-hashrate').textContent = s.running && h ? `${h.value} ${h.unit}` : '–';
    $('cpuminer-blocks').textContent = s.running ? fmtNum(r.stats?.blocks ?? 0) : '–';
    const note = $('cpuminer-note');
    note.hidden = !(s.running && r.stats?.notSynced) && Boolean(r.config.address);
    note.className = 'verdict';
    note.textContent = !r.config.address
        ? 'Set your testnet reward address and save, then switch the miner on in the sidebar.'
        : 'Waiting for the testnet node to finish syncing; the miner starts hashing once it has.';
    // Never overwrite what someone is typing.
    if (document.activeElement !== $('cpuminer-address')) $('cpuminer-address').value = r.config.address;
    if (document.activeElement !== $('cpuminer-threads')) $('cpuminer-threads').value = r.config.threads;
    $('cpuminer-threads').max = r.cpus;
    $('cpuminer-cores').textContent = `of ${r.cpus} cores`;
    const last = $('cpuminer-last');
    last.hidden = !(s.running && r.stats?.lastLine);
    last.textContent = r.stats?.lastLine ?? '';
}

$('cpuminer-save')?.addEventListener('click', async () => {
    const body = { address: $('cpuminer-address').value.trim(), threads: Number($('cpuminer-threads').value) };
    $('cpuminer-save').disabled = true;
    try {
        const r = await api('/api/cpuminer', { method: 'PUT', body });
        toast(r.jobId ? 'Saved. Restarting the miner with the new settings.' : 'Saved.');
        await loadCpuMiner();
    } catch (e) {
        toast(e.message, 'bad');
    } finally {
        $('cpuminer-save').disabled = false;
    }
});

async function loadMining() {
    if (networkView === 'testnet') return loadCpuMiner();
    const r = await api(`/api/mining${miningQuery()}`);
    miningPortOffset = r.stratumOffset ?? 0;
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
    syncMinersToggle();
    // renderEconomics just drew the live figure; if the user is in what-if mode
    // put their typed hashrate back in charge of the numbers.
    if (!useMyMiners) recalcProjection();
    if (networkView !== 'testnet') {
        setNavHealth('mining', !c.enabled ? 'off' : r.container?.running ? 'ok' : 'bad');
    }
}

function renderMiningState(container, stats) {
    const badge = $('mining-state');
    const running = container?.running;
    badge.textContent = containerWord(container);
    badge.className = `tag ${!container?.exists ? 'off' : running ? 'ok' : ''}`;

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
    $('m-rejected').textContent = fmtNum(s.rejectedBlocks ?? 0);
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
            const ip = /^\d+\.\d+\.\d+\.\d+$/.test(String(w.ip || '')) ? w.ip : null;
            const title =
                `${w.worker || 'worker'} is ${status}` +
                (w.wallet ? `\nPaying ${w.wallet}` : '') +
                (ip ? `\nMining from ${ip}. Click the name for its dashboard` : '') +
                `\n${fmtNum(w.stale)} stale, ${fmtNum(w.invalid)} invalid`;
            const label = escapeHtml(w.worker || '–');
            // The name links to the miner's own web dashboard when its address is
            // known -- for an IceRiver on the LAN that is a page on the box.
            const name = ip
                ? `<a href="http://${escapeHtml(ip)}/" target="_blank" rel="noreferrer noopener">${label}</a>`
                : label;
            return `<tr title="${escapeHtml(title)}">
        <td class="name"><span class="dot ${status === 'online' ? 'ok' : status === 'idle' ? 'warn' : ''}"></span>${name}</td>
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
        $('blocks-body').innerHTML = '<tr><td colspan="5" class="empty">No blocks found yet.</td></tr>';
        return;
    }
    // Every block a solo miner finds pays the coinbase subsidy in full, and the
    // bridge does not report the amount, so this is the current block reward --
    // exact for anything recent, since it only steps down once a month.
    const rewardKas = Number(lastEconomics?.reward?.currentKas) || null;
    const rewardCell = rewardKas
        ? `${trimKas(rewardKas)} KAS${lastPrice ? `<small class="sub">${fmtFiat(rewardKas * lastPrice)}</small>` : ''}`
        : '–';
    $('blocks-body').innerHTML = blocks
        .slice(0, 25)
        .map(
            (b) => `<tr>
      <td class="name">${escapeHtml(b.timestamp || '–')}</td>
      <td class="name">${escapeHtml(b.worker || '–')}</td>
      <td>${rewardCell}</td>
      <td>${escapeHtml(b.bluescore || '–')}</td>
      <td><span class="trunc" title="${escapeHtml(b.hash || '')}">${escapeHtml(b.hash || '–')}</span></td>
    </tr>`,
        )
        .join('');
}

// A miner needs the address of the machine it can actually route to: the LAN
// address on your own network, the public one from outside. Showing only the
// public IP sent people to an address their ASIC usually cannot reach.
// --- private values (screen-recording safe) ---
//
// The machine's public IP is not shown until asked for: the panel is filmed for video
// guides, and an address sitting on screen is an address in every recording. A masked
// value carries an eye button that shows it for this page view (pressed again, hides it);
// Copy still copies the real value, since the clipboard is not on screen.
const MASK = '•••.•••.•••.•••';
let publicRevealed = false;

/** A masked value (HTML); pair it with revealButton(). `mask` is what shows meanwhile. */
function privateValue(value, mask = MASK) {
    const shown = publicRevealed;
    return `<span class="private-value" data-private="${escapeHtml(value)}" data-mask="${escapeHtml(mask)}">${escapeHtml(
        shown ? value : mask,
    )}</span>`;
}
// The last "Am I public?" location: its map pin is only drawn while revealed.
let lastPublicGeo = null;
// Same eye as the password fields: open = "show it", struck through = "hide it again".
const revealButton = () =>
    `<button type="button" class="reveal-eye" data-reveal aria-pressed="${publicRevealed}" aria-label="${
        publicRevealed ? 'Hide' : 'Show'
    } the address" title="${publicRevealed ? 'Hide' : 'Show'} the address">${publicRevealed ? EYE_SHUT : EYE_OPEN}</button>`;

document.addEventListener('click', (event) => {
    const btn = event.target.closest?.('[data-reveal]');
    if (!btn) return;
    publicRevealed = !publicRevealed;
    for (const el of document.querySelectorAll('[data-private]')) el.textContent = publicRevealed ? el.dataset.private : el.dataset.mask || MASK;
    for (const b of document.querySelectorAll('[data-reveal]')) b.outerHTML = revealButton();
    pingLocation(publicRevealed ? lastPublicGeo : null);
});

function stratumRow(port, host, diff, note, { privateHost = false } = {}) {
    const url = `stratum+tcp://${host}:${port}`;
    const shown = privateHost
        ? `stratum+tcp://${privateValue(host)}:${port}`
        : escapeHtml(url);
    return `<tr>
      <td class="port">${port}</td>
      <td>
        <span class="copyable">
          <code>${shown}</code>
          ${privateHost ? revealButton() : ''}
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
let lastPrice = null;

const MINERS_KEY = 'kaspa-node-use-miners';
// Default on: someone opening this is usually watching their own miners, not
// modelling a stranger's. Off is the deliberate "what if I had X" mode.
let useMyMiners = localStorage.getItem(MINERS_KEY) !== '0';

/** A KAS amount as an approximate fiat figure, or '' when there is no price. */
const fmtFiat = (usd) => {
    if (!Number.isFinite(usd) || usd <= 0) return '';
    if (usd >= 1000) return `~$${Math.round(usd).toLocaleString()}`;
    if (usd >= 1) return `~$${usd.toFixed(2)}`;
    return `~$${usd.toFixed(4)}`;
};

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
    lastPrice = Number(r.price?.usd) || null;
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
    // While "use my miners" is on the box mirrors the live figure; leave it
    // alone otherwise, so a typed what-if is not overwritten from under the
    // cursor or by a poll.
    if (useMyMiners && document.activeElement !== $('earn-hashrate')) {
        const unit = Number($('earn-unit').value);
        $('earn-hashrate').value = p.hashrate ? (p.hashrate / unit).toFixed(3).replace(/\.?0+$/, '') : '';
    }

    const byMonths = Object.fromEntries((p.horizons ?? []).map((h) => [h.months, h.kas]));
    $('earn-day').textContent = fmtKas(p.perDayKas ?? 0);
    $('earn-1').textContent = fmtKas(byMonths[1] ?? 0);
    $('earn-6').textContent = fmtKas(byMonths[6] ?? 0);
    $('earn-12').textContent = fmtKas(byMonths[12] ?? 0);

    // The same figures in fiat, when a price is to hand. Quiet when it is not.
    $('earn-day-fiat').textContent = lastPrice ? fmtFiat((p.perDayKas ?? 0) * lastPrice) : '';
    $('earn-1-fiat').textContent = lastPrice ? fmtFiat((byMonths[1] ?? 0) * lastPrice) : '';
    $('earn-6-fiat').textContent = lastPrice ? fmtFiat((byMonths[6] ?? 0) * lastPrice) : '';
    $('earn-12-fiat').textContent = lastPrice ? fmtFiat((byMonths[12] ?? 0) * lastPrice) : '';

    // Say plainly whether these numbers come from real miners or a typed what-if.
    const hasMeasured = Number(p.measured) > 0;
    const usingMeasured = hasMeasured && !p.hypothetical;
    const source = $('earn-source');
    source.textContent = usingMeasured ? 'from your miners' : p.hashrate > 0 ? 'what-if' : 'no hashrate';
    source.className = `tag ${usingMeasured ? 'ok' : 'off'}`;

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

/** Keep the switch and the box agreeing: on locks the box to the live figure. */
function syncMinersToggle() {
    $('earn-live').checked = useMyMiners;
    const box = $('earn-hashrate');
    box.readOnly = useMyMiners;
    box.classList.toggle('locked', useMyMiners);
}

$('earn-hashrate').addEventListener('input', debounce(recalcProjection, 400));
$('earn-unit').addEventListener('change', () => (useMyMiners ? refreshProjection(null) : recalcProjection()));
$('earn-live').addEventListener('change', (e) => {
    useMyMiners = e.target.checked;
    localStorage.setItem(MINERS_KEY, useMyMiners ? '1' : '0');
    syncMinersToggle();
    if (useMyMiners) refreshProjection(null);
    else recalcProjection();
});

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
                inst.stratumPort + miningPortOffset,
                lanIp ?? 'this-machine-ip',
                inst.minShareDiff,
                lanIp ? '<span class="tag ok">ready</span>' : '<span class="tag">LAN address unknown</span>',
            ),
        )
        .join('');

    $('stratum-public').innerHTML = cfg.instances
        .map((inst) =>
            stratumRow(
                inst.stratumPort + miningPortOffset,
                miningPublicIp ?? 'your-public-ip',
                inst.minShareDiff,
                inst.publish
                    ? '<span class="tag">needs port forwarded</span>'
                    : '<span class="tag off">port not published</span>',
                // The public IP is masked until its eye button is pressed.
                { privateHost: Boolean(miningPublicIp) },
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
        setTimeout(loadMining, 2000);
    } catch (e) {
        err.textContent = e.message;
        err.hidden = false;
    }
});

for (const button of document.querySelectorAll('[data-bridge]')) {
    button.addEventListener('click', async () => {
        const action = button.dataset.bridge;
        await queueAction({
            title: `${ACTION_VERBS[action] ?? action} the stratum bridge`,
            request: (headers) => api(`/api/mining/${action}`, { method: 'POST', headers }),
        });
    });
}

// The bridge ships inside the node's release, so a mining update is a node
// update. This checks the same upstream and points at where to do it, using
// the shared update-status look.
$('mining-check').addEventListener('click', async () => {
    const el = $('mining-update-status');
    setUpdateStatus(el, 'checking', 'Checking GitHub…');
    try {
        const r = await api(`/api/update/check${networkView === 'testnet' ? '?net=testnet' : ''}`);
        if (r.updateAvailable) {
            setUpdateStatus(
                el,
                'available',
                `${r.latest} is available (the bridge runs ${r.current || 'the current node release'}). Update the node under Kaspad, Updates to move the bridge to it as well.`,
            );
        } else {
            setUpdateStatus(el, 'current', `Up to date: the bridge ships with node ${r.current || 'the newest release'}.`);
        }
    } catch (e) {
        setUpdateStatus(el, 'error', e.message);
    }
});

async function refreshMiningStats() {
    if (networkView === 'testnet') return void loadCpuMiner().catch(() => {});
    if (!miningConfig?.enabled) return;
    try {
        const [stats, state] = await Promise.all([api(`/api/mining/stats${miningQuery()}`), api(`/api/mining${miningQuery()}`)]);
        // In "use my miners" mode the earnings follow the miners live, so redraw
        // them from the same fetch. Do it first: it refreshes the block reward
        // and price the blocks table reads. A what-if is left untouched.
        if (useMyMiners) renderEconomics(state);
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
        miningTimer = setInterval(noOverlap(refreshMiningStats), 5000);
    }
}

// --- overview: the machine ------------------------------------------------

let hostTimer = null;

/**
 * Colour the bars by how close to full they are, not by taste.
 *
 * The accent is the resting state; a disk at 80% is worth noticing and one at
 * 90% is worth acting on. Memory gets the same treatment even though a full
 * one is less alarming, because the alternative -- two bars that mean different
 * things at the same colour -- is worse than being slightly over-cautious.
 */
function barTone(percent) {
    if (percent === null || percent === undefined) return '';
    if (percent >= 90) return 'bad';
    if (percent >= 80) return 'warn';
    return '';
}

function renderHost(data) {
    const disk = data.storage;
    $('host-disk-pct').textContent = disk?.percent === null || disk?.percent === undefined ? '–' : `${disk.percent}%`;
    $('host-disk-pct').title = disk?.path ? `Measured at ${disk.path}` : '';
    $('host-disk-bar').style.width = `${disk?.percent ?? 0}%`;
    $('host-disk-bar').className = barTone(disk?.percent);
    $('host-disk-detail').textContent = disk
        ? `${fmtSize(disk.availableBytes)} free of ${fmtSize(disk.totalBytes)}`
        : 'Could not read the disk.';

    const mem = data.memory;
    $('host-mem-pct').textContent = mem?.percent === null || mem?.percent === undefined ? '–' : `${mem.percent}%`;
    $('host-mem-bar').style.width = `${mem?.percent ?? 0}%`;
    $('host-mem-bar').className = barTone(mem?.percent);
    $('host-mem-detail').textContent = mem
        ? `${fmtSize(mem.availableBytes)} free of ${fmtSize(mem.totalBytes)}`
        : 'Could not read memory.';

    const machine = data.machine ?? {};
    $('host-name').textContent = machine.hostname || '–';
    $('host-system').textContent = [machine.system, machine.kernel && `(${machine.kernel})`, machine.arch]
        .filter(Boolean)
        .join(' ') || '–';
    $('host-cpu').textContent = machine.cores ? `${machine.cores} core${machine.cores === 1 ? '' : 's'}` : '–';
    $('host-uptime').textContent = fmtUptime(machine.uptimeSeconds);
    $('host-load').textContent = Array.isArray(machine.loadAverage) ? machine.loadAverage.join('  ') : '–';

    hostServices = [...(data.services ?? [])].sort((a, b) => svcOrder(a) - svcOrder(b));
    renderHostServices();
}

// --- Overview: the Services card, folded behind its counts ---

/**
 * Collapsed, the card is one line: "N running, N stopped, N not installed", each count a
 * filter. Clicking one shows that status's tiles; clicking it again folds the card. The
 * choice holds while the page lives (the status poll redraws every ten seconds) and starts
 * folded on a fresh load.
 */
let hostServices = [];
let indexerServices = [];
let svcFilter = null;
// running, degraded (crash-looping, dead, or running with a failing healthcheck), stopped, absent.
const svcDegraded = (svc) => svc.installed && (svc.health === 'unhealthy' || svc.status === 'restarting' || svc.status === 'dead');
const svcOrder = (svc) => (!svc.installed ? 3 : svcDegraded(svc) ? 1 : svc.running ? 0 : 2);

function renderHostServices() {
    const box = $('svc-filters');
    if (!box) return;
    // One list: the containers, then the indexer's processes as "Indexer:" rows. A healthy
    // process counts as running; anything else (degraded, down) lands under the red chip,
    // with its own dot and words on the tile.
    const entries = hostServices
        .map((svc) => ({
            group: svcOrder(svc),
            tile: (() => {
                const [dot, word] = !svc.installed
                    ? ['', 'not installed']
                    : svcDegraded(svc)
                      ? ['bad', svc.health === 'unhealthy' ? 'running, failing its health check' : svc.status]
                      : svc.running
                        ? ['ok', 'running']
                        : ['warn', svc.status || 'stopped'];
                const uptime = svc.running && svc.startedAt ? `, up ${fmtDuration(svc.startedAt)}` : '';
                return `<div class="svc-card${svc.installed ? '' : ' absent'}"><span class="svc-dot ${dot}"></span><div class="svc-meta"><strong>${escapeHtml(svc.label)}</strong><small>${escapeHtml(word + uptime)}</small></div></div>`;
            })(),
        }))
        .concat(
            indexerServices.map((s) => ({
                group: s.status === 'healthy' ? 0 : 1,
                tile: svcTile(`Indexer: ${s.name}`, kDot(s.status), svcLabel(s.status, s.detail)),
            })),
        );
    if (!entries.length) {
        box.innerHTML = '<span class="muted">Nothing on this machine yet.</span>';
        $('host-services').hidden = true;
        $('host-services-hint').hidden = true;
        return;
    }
    // Each chip carries the same dot its tiles do: green running, red degraded, amber
    // stopped, grey absent. Degraded only shows while something is: most days it is not there.
    const groups = [
        [0, 'running', 'ok'],
        [1, 'degraded', 'bad'],
        [2, 'stopped', 'warn'],
        [3, 'not installed', ''],
    ];
    box.innerHTML = groups
        .map(([n, word, dot]) => {
            const c = entries.filter((e) => e.group === n).length;
            if (!c && n === 1) return '';
            return `<button type="button" class="svc-filter${svcFilter === n ? ' active' : ''}" data-svc-filter="${n}" ${c ? '' : 'disabled'}><span class="svc-dot ${dot}"></span>${c} ${word}</button>`;
        })
        .join('');
    $('host-services').hidden = svcFilter === null;
    $('host-services-hint').hidden = svcFilter !== 3;
    $('host-services').innerHTML = entries
        .filter((e) => svcFilter !== null && e.group === svcFilter)
        .map((e) => e.tile)
        .join('');
}

$('svc-filters')?.addEventListener('click', (event) => {
    const chip = event.target.closest('[data-svc-filter]');
    if (!chip) return;
    const n = Number(chip.dataset.svcFilter);
    svcFilter = svcFilter === n ? null : n;
    renderHostServices();
});

// --- Overview: live BlockDAG ---

/**
 * The newest blocks from this node, drawn as they arrive: x is blue score (so the picture drifts
 * left at the network's pace), blocks with the same blue score stack, thin lines join each block
 * to its parents, the selected chain (followed back from the top block's selected parents) is
 * highlighted, and blocks merged as red are red. Polls /api/dag/blocks once a second, only while
 * Overview is on screen and the node is running and fully synced.
 */
// Tighter than the first cut (18px, 160 kept): a long DAG should show real history, on the
// card and above all expanded, not just the last minute's blocks.
const DAG_PX_PER_BLUE = 12;
const DAG_KEEP_BLUE = 360;
// (`dag`, the view's state, is declared at the top of this file: selectTab can run before here.)

function setDagView(active) {
    dag.active = active;
    clearInterval(dag.timer);
    dag.timer = null;
    if (active) {
        pollDag();
        dag.timer = setInterval(noOverlap(pollDag), 1000);
        if (dag.frame == null) dag.frame = requestAnimationFrame(drawDag);
    } else {
        // Leaving Overview (a tab click, the cycle) takes the full-screen view with it.
        setDagFull(false);
        if (dag.frame != null) {
            cancelAnimationFrame(dag.frame);
            dag.frame = null;
        }
    }
}

/** The BlockDAG over the whole screen; the same canvas, just bigger. Esc or Close ends it. */
function setDagFull(on) {
    const card = document.querySelector('.dag-card');
    if (!card || card.classList.contains('dag-full') === Boolean(on)) return;
    card.classList.toggle('dag-full', on);
    document.body.classList.toggle('dag-fullscreen', on);
    const btn = $('dag-expand');
    if (btn) btn.textContent = on ? 'Close' : 'Expand';
}

$('dag-expand')?.addEventListener('click', () => setDagFull(!document.querySelector('.dag-card.dag-full')));

document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && document.querySelector('.dag-card.dag-full')) setDagFull(false);
});

async function pollDag() {
    if (document.hidden) return;
    // After a pause (a locked screen, a hidden tab, a sign-in) the cursor is far behind, and
    // following it from there replays history a page a second, which at ten blocks a second
    // never catches up. Start again at the tip, as on the first poll.
    const paused = dag.lastAt != null && performance.now() - dag.lastAt > 5000;
    if (paused && dag.next) {
        dag.next = null;
        dag.blocks.clear();
        dag.reds.clear();
        dag.arrivals = [];
        dag.view = null;
    }
    let r;
    try {
        r = await api(`/api/dag/blocks?net=${networkView}${dag.next ? `&since=${dag.next}` : ''}`);
    } catch {
        return;
    }
    dag.lastAt = performance.now();
    if (!r?.available) {
        dag.blocks.clear();
        dag.reds.clear();
        dag.next = null;
        dag.view = null;
        $('dag-note').textContent =
            r?.reason === 'syncing'
                ? 'Waiting for Kaspad to finish syncing: the BlockDAG shows once it is 100% synced.'
                : 'Starts when Kaspad is running and 100% synced.';
        $('dag-stats').textContent = '';
        return;
    }
    const now = performance.now();
    for (const b of r.blocks ?? []) {
        if (!dag.blocks.has(b.h)) {
            dag.blocks.set(b.h, b);
            dag.arrivals.push(now);
        }
        for (const red of b.r ?? []) dag.reds.add(red);
    }
    dag.next = r.next;
    // Keep a short window: everything well behind the top falls away.
    const top = Math.max(0, ...[...dag.blocks.values()].map((b) => b.b));
    for (const [h, b] of dag.blocks) if (b.b < top - DAG_KEEP_BLUE) dag.blocks.delete(h);
    dag.arrivals = dag.arrivals.filter((t) => now - t < 10_000);
    $('dag-note').innerHTML =
        '<span class="dag-legend"><i style="background:var(--accent)"></i>selected chain</span>' +
        '<span class="dag-legend"><i style="background:var(--muted)"></i>blue</span>' +
        '<span class="dag-legend"><i style="background:var(--danger)"></i>red</span> Live from your node.';
    if (dag.blocks.size) {
        const reds = [...dag.blocks.keys()].filter((h) => dag.reds.has(h)).length;
        $('dag-stats').textContent = `blue score ${fmtNum(top)}, ${(dag.arrivals.length / 10).toFixed(1)} blocks/s, ${reds} red of ${dag.blocks.size}`;
    }
}

function drawDag() {
    dag.frame = dag.active ? requestAnimationFrame(drawDag) : null;
    const canvas = $('dag-canvas');
    if (!canvas || !canvas.offsetParent) return;
    const ratio = window.devicePixelRatio || 1;
    const w = canvas.clientWidth;
    const hgt = canvas.clientHeight;
    if (canvas.width !== Math.round(w * ratio) || canvas.height !== Math.round(hgt * ratio)) {
        canvas.width = Math.round(w * ratio);
        canvas.height = Math.round(hgt * ratio);
    }
    const ctx = canvas.getContext('2d');
    ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
    ctx.clearRect(0, 0, w, hgt);
    const blocks = [...dag.blocks.values()];
    if (!blocks.length) return;
    const css = getComputedStyle(document.documentElement);
    const color = (v, fb) => css.getPropertyValue(v).trim() || fb;
    const accent = color('--accent', '#49eacb');
    const muted = color('--muted', '#8aa');
    const danger = color('--danger', '#e5484d');

    // The view's right edge glides toward the top blue score instead of jumping.
    const top = Math.max(...blocks.map((b) => b.b));
    dag.view = dag.view == null ? top : dag.view + (top - dag.view) * 0.08;

    // Lanes: blocks sharing a blue score stack around the middle line, in arrival order.
    const lanes = new Map();
    const pos = new Map();
    const laneH = 18;
    const mid = hgt / 2;
    for (const b of blocks) {
        const n = lanes.get(b.b) ?? 0;
        lanes.set(b.b, n + 1);
        const off = n === 0 ? 0 : (n % 2 ? 1 : -1) * Math.ceil(n / 2);
        const x = w - 24 - (dag.view - b.b) * DAG_PX_PER_BLUE;
        pos.set(b.h, { x, y: mid + off * laneH });
    }

    // The selected chain: from the top block back along selected parents.
    const chain = new Set();
    let cur = blocks.reduce((best, b) => (b.b > best.b ? b : best), blocks[0]);
    while (cur && !chain.has(cur.h)) {
        chain.add(cur.h);
        cur = cur.s ? dag.blocks.get(cur.s) : null;
    }

    ctx.lineWidth = 1;
    for (const b of blocks) {
        const a = pos.get(b.h);
        if (a.x < -20) continue;
        for (const p of b.p ?? []) {
            const q = pos.get(p);
            if (!q) continue;
            const onChain = chain.has(b.h) && b.s === p;
            ctx.strokeStyle = onChain ? accent : muted;
            ctx.globalAlpha = onChain ? 0.9 : 0.4;
            // A gentle curve, so links between neighbouring blocks stay visible.
            const mx = (a.x + q.x) / 2;
            ctx.beginPath();
            ctx.moveTo(a.x - 4, a.y);
            ctx.bezierCurveTo(mx, a.y, mx, q.y, q.x + 4, q.y);
            ctx.stroke();
        }
    }
    ctx.globalAlpha = 1;
    for (const b of blocks) {
        const { x, y } = pos.get(b.h);
        if (x < -20 || x > w + 20) continue;
        ctx.fillStyle = dag.reds.has(b.h) ? danger : chain.has(b.h) ? accent : muted;
        ctx.beginPath();
        if (ctx.roundRect) ctx.roundRect(x - 4, y - 4, 8, 8, 2);
        else ctx.rect(x - 4, y - 4, 8, 8);
        ctx.fill();
    }
}

async function refreshHost() {
    try {
        renderHost(await api('/api/host'));
    } catch {
        /* transient; the next tick retries */
    }
    // The indexer's own processes (database, ingest, processor, API, chat indexer, translation)
    // belong on the Overview too: its container being green says nothing about them, as two
    // days of a crash-looping processor behind a green tile proved. Best effort: no indexer,
    // no rows.
    try {
        indexerServices = kachatRunning() ? ((await kachat('services')) ?? []) : [];
    } catch {
        indexerServices = [];
    }
    renderHostServices();
}

// Reads the filesystem and asks the daemon, so it is slower than the status
// poll and does not need to be as quick: none of it moves in five seconds.
function setHostPolling(active) {
    clearInterval(hostTimer);
    hostTimer = null;
    if (active) {
        refreshHost();
        hostTimer = setInterval(noOverlap(refreshHost), 10_000);
    }
}

// --- "Am I public?" ---------------------------------------------------------

const MAP_W = 1000;
const MAP_H = 500;
let publicMapLoaded = false;

// The world map is a ~40KB static asset, fetched the first time this tab is
// opened rather than carried in the page everyone loads. Equirectangular, so a
// longitude/latitude maps to x/y with the same projection it was drawn with.
async function loadPublicMap() {
    if (publicMapLoaded) return;
    publicMapLoaded = true;
    try {
        const res = await fetch('/world.svg');
        if (!res.ok) throw new Error(String(res.status));
        $('public-map').innerHTML = await res.text();
    } catch {
        publicMapLoaded = false; // let the next open try again
    }
}

const lonToX = (lon) => ((Number(lon) + 180) / 360) * MAP_W;
const latToY = (lat) => ((90 - Number(lat)) / 180) * MAP_H;

/** Drop a pulsing pin at a location, or clear it when there is none. */
function pingLocation(geo) {
    const pings = $('public-map').querySelector('#world-pings');
    if (!pings) return;
    pings.textContent = '';
    if (!geo || !Number.isFinite(geo.lat) || !Number.isFinite(geo.lon)) return;

    const NS = 'http://www.w3.org/2000/svg';
    const g = document.createElementNS(NS, 'g');
    g.setAttribute('class', 'ping');
    g.setAttribute('transform', `translate(${lonToX(geo.lon)} ${latToY(geo.lat)})`);
    for (const [cls, r] of [['ping-wave', 6], ['ping-wave delay', 6], ['ping-dot', 3.5]]) {
        const c = document.createElementNS(NS, 'circle');
        c.setAttribute('class', cls);
        c.setAttribute('r', String(r));
        g.appendChild(c);
    }
    pings.appendChild(g);
}

async function runPublicCheck() {
    const btn = $('public-run');
    btn.disabled = true;
    const v = $('public-verdict');
    v.textContent = 'testing…';
    v.className = 'tag';
    await loadPublicMap();
    try {
        const r = await api('/api/node/public-check', { method: 'POST' });
        renderPublicCheck(r);
    } catch (e) {
        v.textContent = 'test failed';
        v.className = 'tag off';
        toast(e.message, 'bad');
    } finally {
        btn.disabled = false;
    }
}

function renderPublicCheck(r) {
    const yes = r.public === true;
    const v = $('public-verdict');
    v.textContent = yes ? 'public ✓' : 'not reachable';
    v.className = `tag ${yes ? 'ok' : 'off'}`;

    $('public-facts').hidden = false;
    // Masked until its eye button is pressed (screen-recording safe).
    $('public-node-ip').innerHTML = r.ip ? `${privateValue(r.ip)} ${revealButton()}` : '–';
    $('public-port').textContent = r.exposed ? `${r.port}` : `${r.port} (not published to the host)`;
    $('public-probe').textContent =
        r.probe?.open === true
            ? `yes: ${r.probe.detail}`
            : r.probe?.open === false
              ? `no: ${r.probe.detail}`
              : r.probe?.detail || 'could not test';
    $('public-inbound').textContent = `${r.peers?.inbound ?? 0} in, ${r.peers?.outbound ?? 0} out`;

    // The location is as identifying as the address: masked, and no map pin, until the
    // eye button is pressed (it shares the address's toggle).
    const where = r.geo && (r.geo.city || r.geo.country) ? [r.geo.city, r.geo.country].filter(Boolean).join(', ') : null;
    $('public-where').innerHTML = !where
        ? ''
        : `${yes ? 'Found you near' : 'This connection looks like it is near'} ${privateValue(where, '••••••')}. ${revealButton()}`;

    const help = $('public-help');
    if (yes) {
        help.hidden = true;
    } else {
        help.hidden = false;
        help.innerHTML = !r.exposed
            ? `Your P2P port is not published to the host. Turn it on under <strong>Ports</strong>, then forward TCP port ${r.port} on your router to this machine.`
            : `The port is published here, so the next step is your router: forward TCP port ${r.port} to this machine. Some home routers also refuse to connect back to your own address, which makes this test read worse than it is. An inbound peer above is the real proof.`;
    }

    lastPublicGeo = r.geo ?? null;
    pingLocation(publicRevealed ? lastPublicGeo : null);
}

$('public-run').addEventListener('click', runPublicCheck);

// --- "How to go public" wizard ---------------------------------------------
//
// Every control here drives the same endpoint the real setting does, so a flip
// in the wizard shows up in Overview or Settings and the other way round. The
// wizard is a friendlier front door to those settings, not a second copy of
// the state.

function setHowtoStep(key, done, label) {
    $(`howto-step-${key}`).classList.toggle('done', done);
    const status = $(`howto-status-${key}`);
    if (status) {
        status.textContent = label;
        status.className = `tag howto-status ${done ? 'ok' : 'off'}`;
    }
}

function reflectHowtoAuto() {
    const auto = $('howto-externalip-auto').checked;
    $('howto-externalip').disabled = auto;
    $('howto-externalip-detect').disabled = auto;
    $('howto-externalip').placeholder = auto ? 'kept up to date for you' : 'your public address';
}

async function loadGoPublic() {
    let s;
    try {
        s = await api('/api/node/go-public');
    } catch {
        return;
    }
    $('howto-port').textContent = s.port;
    $('howto-router-port').textContent = s.port;
    $('howto-router-lan').textContent = s.lan || "this computer's local IP address";

    $('howto-p2p').checked = s.p2pPublic;
    setHowtoStep('p2p', s.p2pPublic, s.p2pPublic ? 'public' : 'off');

    if (document.activeElement !== $('howto-externalip')) $('howto-externalip').value = s.externalip;
    $('howto-externalip-auto').checked = s.externalipAuto;
    reflectHowtoAuto();
    const ipDone = Boolean(s.externalip) || s.externalipAuto;
    setHowtoStep('ip', ipDone, s.externalipAuto ? 'auto' : s.externalip ? 'set' : 'not set');
}

$('howto-p2p').addEventListener('change', async (e) => {
    await runAction({
        key: null,
        title: e.target.checked ? 'Publishing P2P to the network (0.0.0.0)' : 'Restricting P2P to this machine',
        note: 'The node restarts to apply this.',
        request: () => api('/api/ports/p2p', { method: 'POST', body: { public: e.target.checked } }),
    });
    loadGoPublic();
    refreshStatus().catch(() => {});
});

$('howto-externalip-auto').addEventListener('change', reflectHowtoAuto);

$('howto-externalip-detect').addEventListener('click', async () => {
    const btn = $('howto-externalip-detect');
    btn.disabled = true;
    try {
        const { ip } = await api('/api/node/external-ip');
        $('howto-externalip').value = ip;
        toast(`Filled in ${ip}. Press Save address to apply it.`);
    } catch (e) {
        toast(e.message, 'bad');
    } finally {
        reflectHowtoAuto();
    }
});

$('howto-externalip-save').addEventListener('click', async () => {
    let config;
    try {
        ({ config } = await api('/api/config'));
    } catch (e) {
        return toast(e.message, 'bad');
    }
    config.peering.externalip = $('howto-externalip').value.trim();
    config.peering.externalipAuto = $('howto-externalip-auto').checked;
    await runAction({
        key: null,
        title: 'Saving your address',
        note: 'The node restarts so it advertises the new address.',
        request: () => api('/api/config', { method: 'PUT', body: { config } }),
    });
    loadGoPublic();
});

$('howto-check').addEventListener('click', () => {
    selectSubtab(document.getElementById('tab-kaspad'), 'public');
    runPublicCheck();
});

// --- mining ROI calculator -------------------------------------------------

const fmtMoney = (n) =>
    `$${(Number(n) || 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

/**
 * When the miner pays for itself. The earnings side comes from the same
 * projection the Overview uses (KAS per day at this hashrate, times the live
 * price); the cost side is the electricity the miner draws. Net of the two
 * against the purchase price gives the payback date.
 */
async function recalcRoi() {
    const hs = Number($('roi-hashrate').value) * Number($('roi-unit').value);
    const watts = Number($('roi-watts').value) || 0;
    const kwh = Number($('roi-kwh').value) || 0;
    const cost = Number($('roi-cost').value) || 0;
    if (!Number.isFinite(hs) || hs < 0) return;

    let r;
    try {
        r = await api(`/api/mining/projection?hashrate=${encodeURIComponent(hs)}`);
    } catch {
        return;
    }
    const perDayKas = r.projection?.perDayKas ?? 0;
    const price = Number(r.price?.usd) || 0;
    const gross = perDayKas * price;
    const power = (watts / 1000) * 24 * kwh;
    const net = gross - power;

    $('roi-daily-kas').textContent = fmtKas(perDayKas);
    $('roi-daily-gross').textContent = price ? fmtMoney(gross) : 'no price';
    $('roi-daily-power').textContent = fmtMoney(power);
    $('roi-daily-net').textContent = price ? fmtMoney(net) : '–';
    $('roi-month').textContent = price ? fmtMoney(net * 30.44) : '–';
    $('roi-year').textContent = price ? fmtMoney(net * 365) : '–';

    if (price && cost > 0 && net > 0) {
        const days = cost / net;
        $('roi-days').textContent =
            days >= 365 ? `${(days / 365).toFixed(1)} years (about ${Math.round(days).toLocaleString()} days)` : `${Math.round(days)} days`;
        const date = new Date(Date.now() + days * 86_400_000);
        $('roi-date').textContent = date.toLocaleDateString(undefined, { year: 'numeric', month: 'long', day: 'numeric' });
    } else {
        const never = price && net <= 0 && cost > 0;
        $('roi-days').textContent = never ? 'it does not pay off at these numbers' : '–';
        $('roi-date').textContent = never ? 'never at these numbers' : '–';
    }

    $('roi-note').textContent = !price
        ? 'Earnings in money need a live Kaspa price, which the panel could not fetch just now. The KAS per day figure still holds.'
        : net <= 0 && (watts > 0 || cost > 0)
          ? 'At these numbers the electricity costs more than the miner earns, so it never pays itself back. Cheaper power, a more efficient miner or a higher price would change that.'
          : "Based on today's difficulty, block reward and Kaspa price. All three move over time, so the real date will differ.";
}

const recalcRoiSoon = debounce(recalcRoi, 400);

async function loadRoi() {
    // Seed the hashrate from the connected miners the first time, so the tab is
    // useful before anyone types anything. Left alone once it has a value.
    if (!$('roi-hashrate').value) {
        try {
            const r = await api('/api/mining/projection');
            const measured = Number(r.projection?.measured) || 0;
            if (measured > 0) $('roi-hashrate').value = (measured / Number($('roi-unit').value)).toFixed(3).replace(/\.?0+$/, '');
        } catch {
            /* leave it empty; the user can type one */
        }
    }
    recalcRoi();
}

for (const id of ['roi-hashrate', 'roi-watts', 'roi-kwh', 'roi-cost']) {
    $(id).addEventListener('input', recalcRoiSoon);
}
$('roi-unit').addEventListener('change', recalcRoi);

$('roi-use-miners').addEventListener('click', async () => {
    try {
        const r = await api('/api/mining/projection');
        const measured = Number(r.projection?.measured) || 0;
        if (measured <= 0) return toast('No miners are reporting a hashrate right now.', 'bad');
        $('roi-hashrate').value = (measured / Number($('roi-unit').value)).toFixed(3).replace(/\.?0+$/, '');
        recalcRoi();
    } catch (e) {
        toast(e.message, 'bad');
    }
});

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
    // No ref: it is built on a docker tag, not a branch of anything.
    $('nextcloud-pub-web').checked = c.nextcloud.publish.web;
    $('nextcloud-port').value = c.nextcloud.hostPort;
    $('nextcloud-user').value = c.nextcloud.adminUser;
    $('nextcloud-domains').value = c.nextcloud.trustedDomains;
    renderAppState('nextcloud', r.apps.nextcloud);
    loadNextcloudAdmin();
    loadRefPickers();
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

/**
 * The one word a status badge shows, and it comes from the container.
 *
 * Three states somebody can act on -- nothing there, there but stopped, up --
 * said in the panel's own words. Docker's own vocabulary leaks otherwise: a
 * container somebody switched off reports "exited", which is true, is not what
 * they did, and sits oddly next to a switch labelled off.
 */
function containerWord(container) {
    if (!container?.exists) return 'not installed';
    if (container.running) return 'running';
    if (container.status === 'restarting') return 'restarting';
    return 'stopped';
}

/**
 * What to say about an app that has no link to offer.
 *
 * Driven by the container and never by the saved `enabled` flag. That flag is
 * what separates stopped from uninstalled, so it stays true across a stop --
 * and reading it as "this is meant to be up" is how a service somebody had
 * switched off spent the whole time claiming to be starting up.
 */
function appStatusNote(state, { absent, stopped }) {
    const container = state.container ?? {};
    if (!container.exists) return { text: absent, bad: false };
    // A container that exists, is not running, and failed the last time it was
    // asked to. Not the same as one that was switched off.
    const failure = startFailure(state);
    if (failure) return { text: failure, bad: true };
    if (container.status === 'restarting') {
        return { text: 'Restarting. If it keeps doing this, All logs says why.', bad: true };
    }
    // Every caller shows a link instead of reaching this, but a helper whose
    // answer depends on that is one refactor away from saying "not running"
    // about something that is.
    if (container.running) return { text: 'Running.', bad: false };
    return { text: stopped, bad: false };
}

function renderAppState(name, state) {
    // The Testnet view's Indexer tab describes the testnet indexer, never mainnet's.
    if (name === 'kachat' && networkView === 'testnet') return renderTestnetIndexerState();
    const badge = $(`${name}-state`);
    const container = state.container ?? {};
    const running = container.running;
    badge.textContent = containerWord(container);
    badge.className = `tag ${!container.exists ? 'off' : running ? 'ok' : ''}`;

    const notice = $(`${name}-notice`);
    if (state.blockers?.length) {
        notice.hidden = false;
        notice.className = 'verdict bad';
        notice.textContent = state.blockers.join(' ');
    } else {
        notice.hidden = true;
    }

    if (name === 'kachat') {
        if (!running && !state.blockers?.length) {
            const note = appStatusNote(state, {
                absent: 'Not installed yet.',
                stopped: 'Not running. Its switch in the sidebar starts it.',
            });
            notice.hidden = false;
            notice.className = note.bad ? 'verdict bad' : 'verdict';
            notice.textContent = note.text;
        }

        const build = $('kachat-build');
        build.textContent = state.build?.sha
            ? `Built from ${String(state.build.sha).slice(0, 7)} on ${new Date(state.build.builtAt).toLocaleString()}`
            : 'Not built yet.';
    }

    if (name === 'nextcloud') {
        const link = $('nextcloud-link');
        const cfg = appsState.config.nextcloud;
        link.hidden = false;
        if (running && cfg.publish.web) {
            const url = `http://${location.hostname}:${cfg.hostPort}`;
            link.className = 'verdict ok';
            link.innerHTML = `<a href="${url}" target="_blank" rel="noreferrer noopener">${escapeHtml(url)} ↗</a>`;
        } else if (running) {
            link.className = 'verdict';
            link.textContent =
                'Running, but not published on the host. Reach it through a proxy host, or tick "Publish on the host" under Settings.';
        } else {
            const note = appStatusNote(state, {
                absent: 'Not installed yet. Installing builds it and leaves it switched off.',
                stopped: 'Not running. Its switch in the sidebar starts it.',
            });
            link.className = note.bad ? 'verdict bad' : 'verdict';
            link.textContent = note.text;
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
        if (running) {
            // location.hostname rather than localhost: the panel is often open
            // from another machine on the LAN, and localhost would send that
            // browser to itself.
            const url = `http://${location.hostname}:${cfg.hostPort}`;
            link.className = 'verdict ok';
            link.innerHTML = `<a href="${url}" target="_blank" rel="noreferrer noopener">${escapeHtml(url)} ↗</a>`;
        } else {
            const note = appStatusNote(state, {
                absent: 'Not installed yet. Installing builds it and leaves it switched off.',
                stopped: 'Not running. Its switch in the sidebar starts it.',
            });
            link.className = note.bad ? 'verdict bad' : 'verdict';
            link.textContent = note.text;
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

// Only the apps built from a git ref. Nextcloud is built on a docker tag and
// has no branches to pick between.
for (const name of ['kachat', 'desktop']) {
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
    for (const name of ['kachat', 'desktop']) {
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
            publish: { api: $('kachat-pub-api').checked },
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
        // Carried through untouched. The saved value is meaningless for an app
        // built on a docker tag, but dropping it from the document would fail
        // the server's validation of the whole apps config.
        ref: appsState?.config?.nextcloud?.ref ?? 'main',
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
// Nextcloud has no Rebuild: there is no branch to rebuild *from*, and Update
// already pulls the tag and rebuilds on it.
for (const app of ['kachat', 'desktop']) {
    $(`${app}-rebuild`).addEventListener('click', async () => {
        $(`${app}-error`).hidden = true;
        // Into the Update Queue, where its build log can be watched (System, Update Queue).
        await queueAction({
            title: `Rebuilding ${appsState?.apps?.[app]?.label ?? app}`,
            request: (headers) => api(`/api/apps/${app}`, { method: 'PUT', body: { config: collectAppConfig(app) }, headers }),
        });
        loadApps();
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
        setUpdateStatus(notice, 'checking', 'Checking GitHub…');
        try {
            const r = await api(`/api/apps/${name}/check`);
            $(`${name}-update`).disabled = !r.updateAvailable;
            // An app built on somebody else's image has no commits and no
            // branch, so it is described as what it is: a tag, and the image
            // that tag currently names.
            const source = r.image ? `the ${r.image} tag` : `${r.repo}@${r.ref}`;
            const version = r.image ? 'image' : 'commit';
            if (r.neverBuilt) {
                setUpdateStatus(notice, 'info', `${source} is at ${r.shortSha}. Nothing built here yet, so install it first.`);
            } else if (r.builtUnknown) {
                setUpdateStatus(
                    notice,
                    'available',
                    `This is running an image from an earlier setup, so the panel cannot tell its version. Press Rebuild from this branch to move to the latest ${version} (${r.shortSha}) and start tracking updates.`,
                );
            } else if (r.updateAvailable) {
                setUpdateStatus(
                    notice,
                    'available',
                    r.image
                        ? `${r.image} has moved: it is now ${r.shortSha}, and this was built on ${String(r.builtSha).replace(/^sha256:/, '').slice(0, 12)}.`
                        : `Update available: ${r.shortSha}, "${r.message}". You are running ${String(r.builtSha).slice(0, 7)}.`,
                );
            } else {
                setUpdateStatus(notice, 'current', `Up to date, running the ${version} ${source} points at now (${r.shortSha}).`);
            }
        } catch (e) {
            setUpdateStatus(notice, 'error', e.message);
        }
    });

    $(`${name}-update`).addEventListener('click', async () => {
        if (!await askConfirm(`Rebuild ${name} from the newest commit?\n\nIt will be unavailable while it rebuilds.`)) return;
        await queueAction({
            title: `Updating ${appsState?.apps?.[name]?.label ?? name}`,
            request: (headers) => api(`/api/apps/${name}/update`, { method: 'POST', headers }),
        });
    });
}

// Restart, and whatever else gets one of these later. The same container
// actions as the sidebar switches, so they get the same overlay.
for (const button of document.querySelectorAll('[data-app-action]')) {
    button.addEventListener('click', async () => {
        const [name, action] = button.dataset.appAction.split('/');
        const verb = ACTION_VERBS[action] ?? action;
        await queueAction({
            title: `${verb} ${appsState?.apps?.[name]?.label ?? name}`,
            request: (headers) => api(`/api/apps/${button.dataset.appAction}`, { method: 'POST', headers }),
        });
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

const kachatBase = () => (networkView === 'testnet' ? '/kachat-testnet/api/' : '/kachat/api/');

async function kachat(path, { method = 'GET', body, raw = false } = {}) {
    // When the container is not there, the proxy still spends five seconds
    // failing to resolve its hostname before giving up. We already know the
    // answer, so do not make anyone wait for it.
    if (appsState && !kachatRunning()) throw new IndexerDown('The indexer is not running.');

    // The Testnet view talks only to the testnet indexer's admin API.
    const res = await fetch(`${kachatBase()}${path}`, {
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

/** One service square: a bold online/down dot, the name, then its state. */
const svcTile = (name, dotClass, label) =>
    `<div class="svc-card"><span class="svc-dot ${dotClass}"></span><div class="svc-meta"><strong>${escapeHtml(name)}</strong><small>${escapeHtml(label)}</small></div></div>`;

const svcLabel = (status, detail) => kWords(status) + (detail ? `, ${detail}` : '');

/**
 * The translation engine as a service square. It is a container the panel runs,
 * not something the indexer reports, so its state and uptime come from the
 * panel's own view of it.
 */
async function translateTile() {
    const { engine: e = {} } = await api('/api/kachat/translate');
    const dot = !e.installed ? '' : e.running ? 'ok' : 'bad';
    const label = !e.installed
        ? 'not installed'
        : !e.running
          ? 'stopped'
          : e.startedAt
            ? `up ${fmtDuration(e.startedAt)}`
            : 'running';
    return svcTile('Translation', dot, label);
}

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

const kachatRunning = () =>
    networkView === 'testnet'
        ? Boolean(serviceState?.['kachat-testnet']?.running)
        : Boolean(appsState?.apps?.kachat?.container?.running);

// ---- The testnet-10 indexer in the Indexer tab ----------------------------------
let testnetIndexerUpdate = null;

function renderTestnetIndexerState() {
    const unit = serviceState?.['kachat-testnet'] ?? {};
    const badge = $('kachat-state');
    if (badge) {
        badge.textContent = !unit.installed ? 'not installed' : unit.running ? 'running' : 'stopped';
        badge.className = `tag ${!unit.installed ? 'off' : unit.running ? 'ok' : ''}`;
    }
    const notice = $('kachat-notice');
    if (notice) {
        notice.hidden = Boolean(unit.running);
        notice.className = 'verdict';
        notice.textContent = !unit.installed
            ? 'The testnet indexer is not installed yet.'
            : 'The testnet indexer is not running. Its switch in the sidebar starts it.';
    }
    const build = $('kachat-build');
    const built = testnetIndexerUpdate?.built;
    if (build) {
        build.textContent = built?.sha
            ? `Testnet indexer built from ${String(built.sha).slice(0, 7)} on ${new Date(built.builtAt).toLocaleString()}`
            : 'Testnet indexer: no build recorded yet (check for updates).';
    }
}

async function loadTestnetIndexerUpdate() {
    if (networkView !== 'testnet') return;
    const status = $('kachat-update-status');
    setUpdateStatus(status, 'checking', 'Checking KaChat-Indexer…');
    try {
        const r = await api('/api/kachat-testnet/update');
        testnetIndexerUpdate = r;
        renderTestnetIndexerState();
        $('kachat-update').disabled = !r.updateAvailable || !r.state?.installed;
        if (r.error) setUpdateStatus(status, 'error', r.error);
        else if (r.updateAvailable) {
            setUpdateStatus(status, 'available', `${r.repo}@${r.ref} has ${r.latest.shortSha}: ${r.latest.message}`);
        } else setUpdateStatus(status, 'current', `Up to date with ${r.repo}@${r.ref} (${r.latest?.shortSha ?? '?'}).`);
    } catch (e) {
        setUpdateStatus(status, 'error', e.message);
    }
}

// In the Testnet view the Indexer's Check / Update buttons act on the testnet indexer.
// Capture phase, so the mainnet handlers on the buttons never see these clicks.
document.addEventListener(
    'click',
    async (event) => {
        if (networkView !== 'testnet') return;
        const id = event.target?.closest?.('button')?.id;
        if (id !== 'kachat-check' && id !== 'kachat-update' && id !== 'kachat-rebuild') return;
        event.stopPropagation();
        event.preventDefault();
        if (id === 'kachat-check') return void loadTestnetIndexerUpdate();
        if (id === 'kachat-update') {
            if (!await askConfirm('Update the testnet-10 indexer?\n\nIt rebuilds KaChat-Indexer and recreates only the testnet indexer. Indexed data is kept.')) return;
            return void queueAction({
                title: 'Updating the testnet indexer',
                request: (headers) => api('/api/kachat-testnet/update', { method: 'POST', headers }),
                onEnd: () => loadTestnetIndexerUpdate(),
            });
        }
    },
    true,
);

// The kinds after kchat:1:, grouped the way people think of them; anything else is "other".
const KACHAT_TX_GROUPS = [
    ['private chats', ['comm', 'dm', 'handshake', 'self_stash']],
    ['group chats', ['gcomm', 'gctl']],
    ['public chats', ['bcast']],
    ['payments', ['pay']],
    // Every KaPosts op the indexer reads (kasia-indexer FOREIGN_KACHAT_OPS), tips apart (KQS-030).
    ['KaPosts', ['post', 'reply', 'quote', 'unquote', 'vote', 'upvote', 'downvote', 'follow', 'unfollow', 'block', 'unblock', 'edit', 'delete', 'poll', 'pollvote', 'broadcast']],
    ['tips', ['tip']],
    ['.kachat', ['name', 'offer', 'prices']],
    ['profiles', ['profile']],
];

function kachatDayBreakdown(d) {
    const by = { ...(d.by_kind ?? {}) };
    const parts = [];
    for (const [label, kinds] of KACHAT_TX_GROUPS) {
        const n = kinds.reduce((sum, k) => sum + (by[k] ?? 0), 0);
        for (const k of kinds) delete by[k];
        if (n) parts.push(`${fmtNum(n)} ${label}`);
    }
    const other = Object.values(by).reduce((a, b) => a + b, 0);
    if (other) parts.push(`${fmtNum(other)} other`);
    const since = d.since ? ` (counting since ${new Date(d.since).toLocaleString([], { weekday: 'short', hour: 'numeric', minute: '2-digit' })})` : '';
    return (parts.join(', ') || 'none yet') + since;
}

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

    // Services: the indexer's own subservices, plus the translation engine the
    // panel runs alongside it. The dot carries online/down; the name leads.
    let tiles = [];
    try {
        const services = await kachat('services');
        tiles = services.map((s) => svcTile(s.name, kDot(s.status), svcLabel(s.status, s.detail)));
    } catch {
        /* indexer down; the translation tile below still stands on its own */
    }
    try {
        tiles.push(await translateTile());
    } catch {
        /* leave translation out rather than block the rest */
    }
    $('kachat-services').innerHTML = tiles.length ? tiles.join('') : '<p class="muted">Waiting for the indexer.</p>';

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
        // Every KaChat transaction of the last 24 hours, by kind (the word after kchat:1:),
        // grouped for reading. An indexer from before this leaves it blank.
        const d = s.tx_24h;
        $('kachat-day').textContent = d ? fmtNum(d.total) : '–';
        $('kachat-day-detail').textContent = !d ? 'Update the indexer to count these.' : kachatDayBreakdown(d);
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
            ['public chats, 30 days', fmtNum(s.bcast_total)],
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

// Inline trash-can icon for per-row delete buttons.
const TRASH_SVG =
    '<svg viewBox="0 0 24 24" width="15" height="15" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18M8 6V4a1 1 0 011-1h6a1 1 0 011 1v2m2 0v14a1 1 0 01-1 1H6a1 1 0 01-1-1V6"/><path d="M10 11v6M14 11v6"/></svg>';

// "Recently indexed" is a numbered pager: 25 rows a page, click a page number to
// jump anywhere in the whole k_contents index. The admin API returns {total, items}
// for a given offset, so `total` tells us how many page buttons to show.
const KAPOSTS_PAGE = 25;
let kapostsPage = { page: 1, total: 0 };

function renderRecentPager() {
    const pager = $('kachat-recent-pager');
    if (!pager) return;
    const pages = Math.max(1, Math.ceil(kapostsPage.total / KAPOSTS_PAGE));
    const cur = kapostsPage.page;
    if (kapostsPage.total === 0) {
        pager.innerHTML = '';
        return;
    }
    // Windowed set: first, last, and the current page ±2, with … for the gaps.
    const want = new Set([1, pages, cur, cur - 1, cur - 2, cur + 1, cur + 2]);
    const shown = [...want].filter((n) => n >= 1 && n <= pages).sort((a, b) => a - b);

    const btn = (n, label, extra = '') =>
        `<button type="button" class="ghost mini" data-recent-page="${n}" ${extra}>${label}</button>`;

    let html = btn(Math.max(1, cur - 1), '←', cur === 1 ? 'disabled' : '');
    let prev = 0;
    for (const n of shown) {
        if (n - prev > 1) html += '<span class="muted" style="padding:0 2px">…</span>';
        html +=
            n === cur
                ? `<button type="button" class="ghost mini" data-recent-page="${n}" aria-current="page" style="font-weight:700;text-decoration:underline">${n}</button>`
                : btn(n, String(n));
        prev = n;
    }
    html += btn(Math.min(pages, cur + 1), '→', cur === pages ? 'disabled' : '');
    html += `<span class="muted" style="margin-left:8px">${fmtNum(kapostsPage.total)} item${
        kapostsPage.total === 1 ? '' : 's'
    }</span>`;
    pager.innerHTML = html;
}

function renderRecentRows(rows) {
    const tbody = $('kachat-recent');
    tbody.innerHTML = rows.length
        ? rows
              .map(
                  (r) => `<tr>
                    <td><button type="button" class="ghost mini danger" data-kachat-del-content="${escapeHtml(
                        r.transaction_id,
                    )}" title="Delete this item" aria-label="Delete this item">${TRASH_SVG}</button></td>
                    <td class="muted" title="${escapeHtml(kTime(r.timestamp))}">${escapeHtml(
                        kAge(Date.now() - r.timestamp),
                    )}</td>
                    <td>${escapeHtml(r.content_type)}</td>
                    <td class="mono" title="${escapeHtml(r.sender_pubkey)}">${escapeHtml(
                        r.sender_pubkey.slice(0, 12),
                    )}…</td>
                    <td>${escapeHtml(r.preview) || '<span class="muted">–</span>'}</td>
                  </tr>`,
              )
              .join('')
        : '<tr><td colspan="5" class="muted">Nothing indexed yet.</td></tr>';
}

async function loadRecentPage(page) {
    const offset = (page - 1) * KAPOSTS_PAGE;
    const res = await kachat(`moderation/recent?limit=${KAPOSTS_PAGE}&offset=${offset}`);
    // New API returns {total, items}; tolerate the old bare-array shape until the indexer is updated
    // (then there is just one page).
    const items = Array.isArray(res) ? res : res.items || [];
    const total = Array.isArray(res) ? items.length : res.total || 0;
    renderRecentRows(items);
    kapostsPage.page = page;
    kapostsPage.total = total;
    renderRecentPager();
}

async function loadKachatKaposts() {
    loadKachatFeatures();
    kapostsPage = { page: 1, total: 0 };
    try {
        await loadRecentPage(1);
    } catch (e) {
        $('kachat-recent').innerHTML = `<tr><td colspan="5" class="muted">${
            e instanceof IndexerDown ? 'The indexer is not running.' : 'Could not load.'
        }</td></tr>`;
        $('kachat-recent-pager').innerHTML = '';
    }
}

/**
 * The tracked-channel list.
 *
 * Three states the indexer distinguishes, and the wording has to keep them
 * apart because two of them look like "off":
 *
 *   key absent   -> whatever set it ships with
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
        // all. It still tracks the set it was built with, in code, so reporting
        // "none tracked" would be the opposite of the truth.
        if (!Array.isArray(settings.available_broadcast_channels)) {
            channelState = { tracked: [], defaults: [], configured: false, unsupported: true };
            $('kachat-channels-tag').textContent = 'not configurable';
            $('kachat-channels-tag').className = 'tag';
            $('kachat-channels').innerHTML =
                '<p class="verdict">This indexer is older than per-channel tracking, so it follows the ' +
                'channels it was built with and they cannot be changed from here. Update it under the ' +
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
    renderChannels(counts, total);
    renderChannelSelects();
    await loadBroadcastRows();
}

function renderChannels(counts, total) {
    // Three things get a card, all of them switched off unless tracked:
    //
    //   tracked   what the indexer is collecting.
    //   stored    a channel with rows that is no longer tracked. The count is
    //             real and feeds the total, so dropping it would make the total
    //             look wrong.
    //   offered   a channel the indexer ships as a default. Without these, one
    //             added upstream after somebody saved their own list is
    //             invisible here -- not tracked and no rows, so nothing to
    //             render -- and the only way to find it is to already know the
    //             name and type it in.
    const names = [
        ...new Set([...channelState.tracked, ...Object.keys(counts), ...channelState.defaults]),
    ].sort();

    const tag = $('kachat-channels-tag');
    const n = channelState.tracked.length;
    tag.textContent = n ? `${n} channel${n === 1 ? '' : 's'} indexed` : 'none indexed';
    tag.className = `tag ${n ? 'ok' : 'off'}`;

    const card = (name) => {
        const on = channelState.tracked.includes(name);
        // Only a channel the indexer does not ship with can be removed outright;
        // the ones it ships are switched off instead, so the list it came with
        // stays recoverable. How many that is, is upstream's to decide.
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

    // Anything this function appended last time. It is called on every poll and
    // again on every toggle, and insertAdjacentHTML does not replace: without
    // this, flipping two switches leaves two notices.
    document.getElementById('kachat-channels-none')?.remove();

    $('kachat-channels').innerHTML =
        names.map(card).join('') +
        `<div class="channel-card total">
           <div class="head"><span class="name">Total public chats</span></div>
           <div class="count">${fmtNum(total)}</div>
         </div>`;

    if (!channelState.tracked.length) {
        $('kachat-channels').insertAdjacentHTML(
            'afterend',
            '<p class="verdict bad" id="kachat-channels-none">Nothing is tracked, so no public chats are being stored at all.</p>',
        );
        return;
    }

    // A saved list is a decision and is never overridden, so a channel the
    // indexer has started shipping since it was saved is pointed at rather than
    // added. Only for a list somebody actually saved: an indexer with no list
    // configured follows its own defaults and has nothing to miss.
    const missing = channelState.configured
        ? channelState.defaults.filter((c) => !channelState.tracked.includes(c))
        : [];
    if (!missing.length) return;

    $('kachat-channels').insertAdjacentHTML(
        'afterend',
        `<p class="verdict" id="kachat-channels-none">
           The indexer now ships ${missing.length === 1 ? 'a channel' : `${missing.length} channels`} your saved
           list does not track: ${missing.map((c) => `#${escapeHtml(c)}`).join(', ')}.
           <button type="button" class="ghost" id="kachat-channels-adopt">Track ${missing.length === 1 ? 'it' : 'them'}</button>
         </p>`,
    );
    $('kachat-channels-adopt').addEventListener('click', () => {
        channelState.tracked = [...channelState.tracked, ...missing];
        setChannelsDirty(true);
        renderChannels(channelState.counts, channelState.total);
        renderChannelSelects();
        toast('Added. Save and apply to start collecting them.');
    });
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
    // The Delete tab's picker: refreshed every few seconds, so it keeps what was picked.
    const purge = $('kachat-purge-channel');
    const picked = purge.value;
    purge.innerHTML = options;
    if ([...purge.options].some((o) => o.value === picked)) purge.value = picked;
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
                        <td><button type="button" class="ghost mini danger" data-kachat-del-bcast="${escapeHtml(
                            r.tx_id,
                        )}" title="Delete this message" aria-label="Delete this message">${TRASH_SVG}</button></td>
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
        case 'kachat-translate':
            loadTranslate();
            break;
        case 'kachat-delete':
            // Its public-chat purge needs the tracked channels for its picker.
            loadKachatBroadcasts();
            break;
        default:
            break;
    }
}

// ------------------------------------------------------------- translation ---

/**
 * Server-side translation of KaPosts.
 *
 * The apps send a post and a target language to the indexer they are already
 * pointed at, and get it back translated; the work is done here by a
 * LibreTranslate container, offline, with no API key and nothing leaving the
 * machine. This screen is the whole operator side of it: whether the engine
 * exists, whether it is running, and which languages it has loaded.
 *
 * It is not gated on the indexer running. The engine is a separate container
 * with its own install and its own switch, and setting it up before the indexer
 * is up is a perfectly reasonable order to do things in.
 */
const TRANSLATE_LANGUAGES = [
    ['en', 'English'], ['es', 'Spanish'], ['pt', 'Portuguese'], ['fr', 'French'],
    ['de', 'German'], ['ru', 'Russian'], ['zh', 'Chinese'], ['ja', 'Japanese'],
    ['ko', 'Korean'], ['ar', 'Arabic'], ['it', 'Italian'], ['nl', 'Dutch'],
    ['pl', 'Polish'], ['tr', 'Turkish'], ['hi', 'Hindi'], ['id', 'Indonesian'],
    ['uk', 'Ukrainian'], ['vi', 'Vietnamese'], ['sv', 'Swedish'], ['cs', 'Czech'],
    ['el', 'Greek'], ['he', 'Hebrew'], ['fa', 'Persian'], ['ro', 'Romanian'],
];

let translateState = null;

function renderTranslateLanguages(selected) {
    const chosen = new Set(String(selected || '').split(','));
    $('translate-langs').innerHTML = TRANSLATE_LANGUAGES.map(
        ([tag, name]) => `
        <label class="check">
          <input type="checkbox" data-lang="${tag}" ${chosen.has(tag) ? 'checked' : ''}>
          ${escapeHtml(name)} <span class="muted">${tag}</span>
        </label>`,
    ).join('');
    updateTranslateCount();
}

function chosenLanguages() {
    return [...document.querySelectorAll('#translate-langs [data-lang]')]
        .filter((box) => box.checked)
        .map((box) => box.dataset.lang);
}

function updateTranslateCount() {
    const count = chosenLanguages().length;
    // No per-language size estimate. The number that is actually knowable is
    // the ceiling the container runs under; how much of it a given model takes
    // is a guess, and a guess printed to one decimal place reads as a fact.
    $('translate-count').textContent = count
        ? `${count} language${count === 1 ? '' : 's'} selected, sharing the engine's 4GB.`
        : 'Nothing selected, which the engine will refuse.';
}

$('translate-langs').addEventListener('change', updateTranslateCount);

async function loadTranslate() {
    let info;
    try {
        info = await api('/api/kachat/translate');
    } catch {
        return;
    }
    translateState = info;
    const engine = info.engine ?? {};

    // Install, then a switch: the same two states every other service has.
    renderTranslateRow(engine);

    // The saved list, not the loaded one: this is what it will load next time.
    if (!document.querySelector('#translate-langs [data-lang]')) renderTranslateLanguages(info.languages);

    $('translate-state').textContent = !engine.installed
        ? 'not installed'
        : engine.running
          ? engine.health === 'starting' || engine.health === 'unhealthy'
              ? 'loading models'
              : 'running'
          : 'stopped';

    // Everything below comes from the indexer, which has to be running to
    // answer for it. Not being able to ask is not an error worth shouting
    // about; it is the ordinary state of a stopped indexer.
    let status = null;
    try {
        status = await kachat('translate-status');
    } catch {
        /* the indexer is not up */
    }

    $('translate-loaded').textContent = status ? String(status.languages?.length ?? 0) : '–';
    $('translate-cached').textContent = status ? fmtNum(status.cached_translations ?? 0) : '–';

    const notice = $('translate-notice');
    const hint = $('translate-hint');
    if (!engine.installed) {
        notice.hidden = true;
        hint.textContent =
            'Nothing is installed yet. Installing downloads the engine image; it does not start it, and it does not download any language until it first runs.';
    } else if (!engine.running) {
        notice.hidden = true;
        hint.textContent = 'The engine is stopped, so /translate fails for everybody. Its switch starts it.';
    } else if (status && !status.libretranslate_ok) {
        notice.hidden = false;
        notice.className = 'verdict bad';
        notice.textContent =
            'The engine is running but the indexer cannot reach it yet. On a first start it is downloading language models, which takes several minutes; All logs shows how far it has got.';
        hint.textContent = '';
    } else if (status) {
        notice.hidden = true;
        hint.textContent = `Serving: ${status.languages.join(', ')}.`;
    } else {
        notice.hidden = true;
        hint.textContent =
            'The engine is running. The indexer is not, so it cannot be asked what is loaded or how much is cached.';
    }
}

$('translate-save').addEventListener('click', async () => {
    const error = $('translate-error');
    error.hidden = true;
    const languages = chosenLanguages();
    if (!languages.length) {
        error.hidden = false;
        error.textContent = 'Choose at least one language.';
        return;
    }
    // Saving restarts the engine to load the languages, downloading any it does
    // not have, so it earns the streaming overlay rather than a toast.
    await runAction({
        key: null,
        title: 'Updating translation languages',
        note: 'The engine restarts to load them, downloading any it does not already have. That can take a few minutes.',
        request: () => api('/api/kachat/translate', { method: 'PUT', body: { languages: languages.join(',') } }),
    });
    loadTranslate().catch(() => {});
});

let kachatTimer = null;
function setKachatPolling(active) {
    clearInterval(kachatTimer);
    kachatTimer = null;
    if (active) {
        refreshKachatPanel();
        kachatTimer = setInterval(noOverlap(refreshKachatPanel), 8000);
    }
}

// --- controls ---

$('kachat-bcast-channel').addEventListener('change', loadBroadcastRows);
$('kachat-bcast-refresh').addEventListener('click', loadKachatBroadcasts);

$('kachat-recent-refresh').addEventListener('click', loadKachatKaposts);
$('kachat-recent-pager').addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-recent-page]');
    if (!btn || btn.disabled) return;
    const page = Number(btn.dataset.recentPage);
    if (page && page !== kapostsPage.page) {
        loadRecentPage(page).catch((err) => toast(err.message, 'bad'));
    }
});

for (const [id, key, label] of [
    ['kachat-tg-kaposts', 'feature_kaposts', 'KaPosts'],
    ['kachat-tg-broadcasts', 'feature_broadcasts', 'Public chats'],
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
    const bar = $('kachat-export-progress');
    // Phase 1: the server assembles the whole store in memory before it sends a byte, so show an
    // indeterminate bar (no value) until the response starts arriving.
    if (bar) { bar.hidden = false; bar.removeAttribute('value'); }
    kResult('kachat-file-result', 'Preparing the export on the server (large stores take a moment)…');
    try {
        const res = await kachat('chat-export', { raw: true });
        // Phase 2: stream the download so we can report real progress.
        const total = Number(res.headers.get('content-length')) || 0;
        if (res.body && res.body.getReader) {
            const reader = res.body.getReader();
            const chunks = [];
            let received = 0;
            for (;;) {
                const { done, value } = await reader.read();
                if (done) break;
                chunks.push(value);
                received += value.length;
                if (total) {
                    const pct = Math.floor((received / total) * 100);
                    if (bar) bar.value = pct;
                    kResult('kachat-file-result', `Downloading… ${kBytes(received)} / ${kBytes(total)} (${pct}%)`);
                } else {
                    if (bar) bar.removeAttribute('value');
                    kResult('kachat-file-result', `Downloading… ${kBytes(received)}`);
                }
            }
            downloadBlob(new Blob(chunks), 'kachat-chat-store.bin');
            if (bar) bar.value = 100;
            kResult('kachat-file-result', `Exported ${kBytes(received)}.`);
        } else {
            // Streaming unsupported: fall back to a single blob read.
            const blob = await res.blob();
            downloadBlob(blob, 'kachat-chat-store.bin');
            kResult('kachat-file-result', `Exported ${kBytes(blob.size)}.`);
        }
    } catch (e) {
        kResult('kachat-file-result', e instanceof IndexerDown ? 'The indexer is not running.' : e.message, true);
    } finally {
        if (bar) setTimeout(() => { bar.hidden = true; bar.removeAttribute('value'); }, 2000);
    }
});

function downloadBlob(blob, filename) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.click();
    URL.revokeObjectURL(url);
}

$('kachat-import-file-btn').addEventListener('click', () => $('kachat-import-file').click());

$('kachat-import-file').addEventListener('change', async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    kResult('kachat-file-result', `Uploading ${file.name} (${kBytes(file.size)}).`);
    try {
        const res = await fetch(`${kachatBase()}chat-import-file`, { method: 'POST', body: file });
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
    if (!await askConfirm(`Delete every stored public chat in #${channel}?`)) return;
    try {
        const d = await kachat('broadcasts/delete', { method: 'POST', body: { channel } });
        kResult('kachat-bcast-del-result', `Deleted ${d.deleted} broadcasts from #${channel}.`);
    } catch (e) {
        kResult('kachat-bcast-del-result', e.message, true);
    }
});

$('kachat-purge-all-btn').addEventListener('click', async () => {
    if (!await askConfirm('Delete every stored public chat in every channel?\n\nThis cannot be undone here.')) return;
    try {
        const d = await kachat('broadcasts/delete', { method: 'POST', body: { all: true } });
        kResult('kachat-bcast-del-result', `Deleted ${d.deleted} broadcasts.`);
    } catch (e) {
        kResult('kachat-bcast-del-result', e.message, true);
    }
});

$('kachat-purge-chat-btn').addEventListener('click', async () => {
    if (!await askConfirm('Wipe every message, group, handshake and payment from the chat store?\n\nThis cannot be undone here.'))
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
    const button = event.target.closest('button[data-kachat-del-content], button[data-kachat-del-bcast]');
    if (!button) return;
    const d = button.dataset;

    try {
        if (d.kachatDelContent) {
            if (!await askConfirm('Delete this KaPosts item from the index?\n\nThis removes the indexer\'s stored copy only. It is still on chain, and a re-index would bring it back. This cannot be undone here.')) return;
            await kachat('kaposts/delete', { method: 'POST', body: { tx_id: d.kachatDelContent } });
            toast('Deleted.');
            loadKachatKaposts();
        } else if (d.kachatDelBcast) {
            if (!await askConfirm('Delete this public chat from the index?\n\nThis removes the indexer\'s stored copy only. It is still on chain, and a re-index would bring it back. This cannot be undone here.')) return;
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
        !await askConfirm(
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
    setUpdateStatus(status, 'checking', 'Checking GitHub…');
    try {
        const releases = await loadKassignerReleases({ force: true });
        const newest = releases.find((r) => !r.prerelease) ?? releases[0];
        const have = kassignerState?.release;
        if (!have) {
            setUpdateStatus(status, 'info', `${newest.tag} is the newest release. Nothing is downloaded here yet.`);
        } else if (have === newest.tag) {
            setUpdateStatus(status, 'current', `You have ${have}, which is the newest.`);
        } else {
            setUpdateStatus(status, 'available', `${newest.tag} is out, and you have ${have}.`);
        }
    } catch (e) {
        setUpdateStatus(status, 'error', e.message);
    }
});

$('kassigner-fetch').addEventListener('click', async () => {
    const tag = $('kassigner-release').value || null;
    await runAction({
        key: 'kassigner',
        title: tag ? `Fetching KasSigner ${tag}` : 'Fetching the newest KasSigner firmware',
        note: 'Downloaded from the release and checked against the hashes it publishes.',
        request: () => api('/api/kassigner', { method: 'PUT', body: { enabled: true, tag } }),
    });
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
    renderUnsafeRpcNotice();

    // Reflect whether the proxy is running before anything else: with it off,
    // adding a host would write config nothing is serving.
    const on = Boolean(r.enabled);
    const badge = $('proxy-state');
    badge.textContent = containerWord(r.container);
    badge.className = `tag ${!r.container?.exists ? 'off' : r.container.running ? 'ok' : ''}`;
    // The dot follows the container, not the saved setting: with the proxy
    // installed and stopped this used to stay green, and disagree with the
    // services poll writing the same dot from what docker says.
    setNavHealth('proxy', r.container?.running ? 'ok' : on ? 'bad' : 'off');

    // With the proxy off, the settings are not just unusable, they are
    // misleading: a saved host writes nginx config nothing is serving. So the
    // page says what to do rather than showing controls that cannot work.
    $('proxy-config').hidden = !on;

    // With nothing else on the page, a full-width card of two sentences is
    // mostly empty space; narrowed and centred it reads as the one thing there
    // is to do. It goes back to full width once the settings are under it.
    $('tab-proxy').classList.toggle('alone', !on);

    for (const id of ['proxy-reload', 'proxy-renew', 'dd-now', 'proxy-add']) {
        const button = $(id);
        button.disabled = !on;
        button.title = on ? '' : 'Turn the reverse proxy on first.';
    }

    renderProxyHosts();

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

async function loadPublish() {
    try {
        publishState = await api('/api/publish');
        if ($('shared-client-notice')) $('shared-client-notice').hidden = !publishState.sharedClientAddress;
        if (publishState.publicPorts) {
            const p = publishState.publicPorts;
            $('ports-http').value = p.http;
            $('ports-https').value = p.https;
            $('ports-bind-http').value = p.bindHttp;
            $('ports-bind-https').value = p.bindHttps;
            $('panel-port').value = p.panel;
            $('panel-port-state').textContent = `This panel answers on port ${p.panel}. The reverse proxy holds ${p.bindHttp} and ${p.bindHttps} on this machine.`;
            const lan = $('panel-lan');
            if (lan) {
                lan.checked = Boolean(p.panelLan);
                // Never offered without a password: the panel controls Docker.
                lan.disabled = !p.panelLan && !p.hasPassword;
                $('panel-lan-state').textContent = p.panelLan
                    ? `Other machines on your network can open it at this computer's address, port ${p.panel} (bound to ${p.panelBind}).`
                    : p.hasPassword
                      ? `Only this machine can open it (bound to ${p.panelBind}).`
                      : `Only this machine can open it. Set an admin password first to open it to your network.`;
            }
        }
    } catch {
        // The proxy card above already reports anything that is actually wrong.
        return;
    }
    renderPublishServices();
}

/** What a target kind reads as, for "in use by" and for taken-domain options. */
const serviceLabel = (kind) => publishState.services.find((s) => s.kind === kind)?.label ?? 'another proxy host';

/**
 * Every proxy host as it actually is, rather than as a service.
 *
 * Public addresses answers "what can this panel publish", which is the right
 * question for the apps it runs and the wrong one for anything it does not:
 * only a raw host can point at another machine on the network, and only this
 * list can show that one does.
 */
function renderProxyHosts() {
    const body = $('proxy-body');
    if (!body) return;

    if (!proxies.length) {
        body.innerHTML = '<tr><td colspan="4" class="muted">No proxy hosts yet.</td></tr>';
        return;
    }

    body.innerHTML = proxies
        .map((p) => {
            const path = (p.path ?? '/') === '/' ? '' : ` ${escapeHtml(p.path)}`;
            const target =
                p.target?.kind === 'custom'
                    ? `${escapeHtml(p.target.scheme ?? 'http')}://${escapeHtml(p.target.host ?? '?')}:${escapeHtml(String(p.target.port ?? '?'))}`
                    : escapeHtml(targetKinds[p.target?.kind]?.label ?? p.target?.kind ?? 'unknown');
            // A host that is switched off still holds its name, so say so
            // rather than let it look like the others.
            const off = p.enabled === false ? ' <span class="tag off">disabled</span>' : '';
            const https =
                p.ssl?.mode === 'letsencrypt'
                    ? p.certificate
                        ? '<span class="tag ok">certificate</span>'
                        : '<span class="tag">requested</span>'
                    : '<span class="tag off">plain http</span>';
            return `<tr>
                <td><strong>${escapeHtml(p.domain)}</strong>${path}${off}</td>
                <td>${target}</td>
                <td>${https}</td>
                <td>
                    <button type="button" class="ghost mini" data-edit-proxy="${escapeHtml(p.id)}">Edit</button>
                    <button type="button" class="ghost mini danger" data-del-proxy="${escapeHtml(p.id)}">Remove</button>
                </td>
            </tr>`;
        })
        .join('');
}

$('proxy-add').addEventListener('click', () => openProxyDialog(null));

$('proxy-body').addEventListener('click', async (event) => {
    const { editProxy, delProxy } = event.target.dataset ?? {};
    if (editProxy) return openProxyDialog(proxies.find((p) => p.id === editProxy));
    if (!delProxy) return;

    const proxy = proxies.find((p) => p.id === delProxy);
    // Removing a host takes a name off the internet, which is not a thing to do
    // on a mis-click. The certificate is deliberately left on disk: it is still
    // valid, and putting the name back should not mean asking for another.
    if (!await askConfirm(`Stop answering for ${proxy?.domain}?\n\nThe nginx configuration for it is removed. Its certificate is kept.`)) {
        return;
    }
    try {
        await api(`/api/proxies/${delProxy}`, { method: 'DELETE' });
        await loadProxies();
    } catch (e) {
        toast(e.message, 'bad');
    }
});

// What each network view offers to publish: the testnet view is the testnet indexer
// (plus this panel, which serves both); mainnet is everything else.
const publishableInView = (s) => (networkView === 'testnet' ? s.testnet || s.key === 'panel' : !s.testnet);

function renderPublishServices() {
    const { services, domains } = publishState;

    $('publish-body').innerHTML = services
        .filter(publishableInView)
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

/**
 * Asks Let's Encrypt for a name's certificate with the same progress screen and live log
 * as every other job (the issue runs as a panel job; DuckDNS names wait ~30 s on a TXT
 * record, so a bare toast read as nothing happening). Refreshes the lists afterwards.
 */
async function requestCertificate(proxyId, domain, body) {
    await runAction({
        key: `cert:${proxyId}`,
        title: `Certificate for ${domain}`,
        note: "Asking Let's Encrypt. A DuckDNS name is proven with a TXT record (no open ports); other names need port 80 to reach this machine.",
        request: () => api(`/api/proxies/${proxyId}/certificate`, { method: 'POST', body }),
    });
    await loadProxies().catch(() => {});
    await loadPublish().catch(() => {});
}

// Everything a published address needs is on its own row: set it up, retry the
// certificate, open the details, take it down.
$('publish-body').addEventListener('click', async (event) => {
    const { setup, unpublish, cert, options } = event.target.dataset ?? {};
    if (setup) return openSetup(setup);
    if (options) return openProxyDialog(proxies.find((p) => p.id === options));

    if (cert) {
        const proxy = proxies.find((p) => p.id === cert);
        await requestCertificate(proxy?.id ?? cert, proxy?.domain ?? 'this name', { email: proxy?.ssl?.email });
        return;
    }

    if (!unpublish) return;

    const service = publishState.services.find((s) => s.key === unpublish);
    if (!await askConfirm(`Stop publishing ${service?.label ?? unpublish} on ${service?.domain}?\n\nThe name stays on your list and the certificate is left alone.`)) {
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
        toast(
            r.jobId
                ? `Moving the proxy to ports ${r.bindHttp} and ${r.bindHttps}.`
                : `Addresses will use ${r.http === 80 ? 'the default http port' : `http port ${r.http}`} and ${r.https === 443 ? 'the default https port' : `https port ${r.https}`}.`,
        );
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

        // Where the name points, which is the question a subdomain raises and
        // the one thing here that is not about ports. A name under a DuckDNS
        // account is not registered anywhere: it either resolves because the
        // provider answers for names under yours, or it does not resolve at
        // all, and until a certificate request fails those look identical.
        if (r.dns) {
            rows.push(
                line(
                    r.dns.error ? false : r.dns.pointsHere,
                    r.dns.error
                        ? `${r.dns.domain} does not resolve: ${r.dns.error} Nothing can reach it by name until it does.`
                        : r.dns.pointsHere
                          // No addresses here: pointing at this connection means they are its own.
                          ? `${r.dns.domain} resolves to this connection's public address.`
                          : `${r.dns.domain} resolves to ${r.dns.addresses.join(', ')}, which is not this connection's public address.`,
                ),
            );
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
    bot: 'nothing it collected. Its settings, including the wallet key, stay in the stack directory and are kept',
    node: 'the entire synced blockchain. Tens of gigabytes, and days of syncing to get back',
    kassigner: 'the downloaded firmware and the record of what was verified. A device you have already flashed is unaffected',
    mining: "the bridge's own share and block records",
    proxy: 'nothing. Your domains and certificates live in the stack directory and are kept',
    translate: 'the downloaded language models, which are several gigabytes and have to be fetched again',
    'node-testnet': 'the synced testnet-10 chain. The mainnet node is not touched',
    'mining-testnet': "the testnet bridge's share and block records. Mainnet mining is not touched",
    'cpuminer-testnet': 'only the miner container. Your testnet rewards stay on the chain at your address. Mainnet mining is not touched',
    'kachat-testnet': 'the testnet indexed history and its Postgres database. The mainnet indexer and .kachat Domains are not touched',
    'kachat-domains':
        'the mainnet .kachat registry it indexed (its Postgres database) and the verified manifest it published. The registry tooling stays if testnet still uses it. .kachat names stop answering on mainnet until it is installed again. Testnet is not touched',
    'kachat-domains-testnet':
        'the testnet .kachat registry it indexed (its Postgres database) and the verified manifest it published. The registry tooling stays if mainnet still uses it. .kachat names stop answering on testnet until it is installed again. Mainnet is not touched',
};

async function loadServices() {
    try {
        serviceState = (await api('/api/services')).services ?? {};
    } catch {
        return;
    }
    for (const [key, state] of Object.entries(serviceState)) {
        // The *-testnet units have no sidebar row of their own; the shared
        // Kaspad/Mining/Indexer rows render them when the testnet view is on. Every
        // one of them, not just the switch-driven ones: the testnet stratum bridge
        // (mining-testnet) also lives on the Mining tab, and drawing its gate here put
        // "Stratum bridge (testnet-10) is not installed" over mainnet's Mining tab.
        if (TESTNET_UNIT_VALUES.has(key) || key.endsWith('-testnet')) continue;
        // Push has no container, so it gets no Install button or "stopped = red" treatment: just
        // the switch (on = master flag) and a dot that reads grey off, green on, amber on-but-no-keys.
        if (key === 'push') {
            const on = Boolean(state?.running);
            setNavSwitch('push', on);
            setNavHealth('push', !on ? 'absent' : state?.configured ? 'ok' : 'warn');
            continue;
        }
        renderServiceRow(key, state);
        renderInstallGate(key, state);
    }
    // The one service with no sidebar row, so renderServiceRow leaves it alone.
    renderTranslateRow(serviceState.translate);
    renderUninstallCards();
}

/**
 * The same Install-then-switch pair as a sidebar row, for the one service that
 * does not have one: the translation engine lives on the indexer's own tab.
 */
function renderTranslateRow(state) {
    const button = $('translate-install');
    const label = $('translate-switch-label');
    if (!button || !label) return;

    const installed = Boolean(state?.installed);
    button.hidden = installed;
    label.hidden = !installed;

    const input = navSwitch('translate');
    if (input && installed && input.dataset.busy !== '1') input.checked = Boolean(state.running);
}

/** The sidebar row: a button before it exists, a switch after. */
function renderServiceRow(key, state) {
    const input = navSwitch(key);
    if (!input) return;
    const label = input.closest('.switch');
    const row = label?.closest('.nav-row');
    if (!row) return;

    // In the testnet view, a shared row (node/mining/kachat) reflects and installs
    // its *-testnet unit instead. The testnet units carry the same `tab` as their
    // mainnet twin, so the health dot still resolves to the right light.
    const unitKey = effectiveService(key);
    if (unitKey !== key) state = serviceState[unitKey] ?? { installed: false, running: false, tab: state?.tab };

    let button = row.querySelector('[data-install]');
    if (!button) {
        button = document.createElement('button');
        button.className = 'nav-install';
        button.textContent = 'Install';
        row.appendChild(button);
    }
    button.dataset.install = unitKey;

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
    // In the testnet view the shared tabs gate on their *-testnet unit's install
    // state (and install it).
    const unitKey = effectiveService(key);
    if (unitKey !== key) state = serviceState[unitKey] ?? { installed: false, tab: state?.tab, label: state?.label };

    // The switch key and the tab name are not always the same word: the node's
    // switch is 'node' and its tab is 'kaspad'.
    const section = document.getElementById(`tab-${state?.tab ?? key}`);
    if (!section) return;

    const installed = Boolean(state?.installed);
    section.classList.toggle('not-installed', !installed);

    let gate = section.querySelector(':scope > .install-gate');
    if (installed) return gate?.remove();

    // Left alone while its install runs: the overlay in front of it has the
    // log, and rebuilding this would put a live Install button back underneath.
    if (pendingAction?.key === unitKey && gate) return;

    if (!gate) {
        gate = document.createElement('div');
        gate.className = 'install-gate';
        section.appendChild(gate);
    }
    // Already built and still saying the same thing. The poll comes round every
    // ten seconds and there is nothing here that changes in between. Keyed by
    // view too, so flipping Mainnet/Testnet rebuilds it for the other unit.
    if (gate.dataset.builtFor === `${unitKey}:${networkView}`) return;
    gate.dataset.builtFor = `${unitKey}:${networkView}`;

    const label = escapeHtml(state?.label ?? unitKey);
    gate.innerHTML = `
      <div class="install-gate-card">
        <h3>${label} is not installed</h3>
        <p class="muted">${
            state?.runnable === false
                ? 'Installing downloads the firmware and checks it against the hashes the release publishes.'
                : 'Installing builds its image and creates its container. It stays switched off afterwards -- the switch in the sidebar is what starts it. Everything behind this is what it will look like.'
        }</p>
        <button class="primary big" data-install="${escapeHtml(unitKey)}">Install ${label}</button>
      </div>`;
}

/**
 * Rebuilt only when something actually changed. These cards carry a checkbox
 * somebody may have just ticked, and the services poll comes round every ten
 * seconds; rewriting the markup underneath them would untick it.
 */
let uninstallSignature = null;

function renderUninstallCards() {
    const signature = `${networkView}|${Object.entries(serviceState)
        .map(([key, state]) => `${key}:${state?.installed ? 1 : 0}`)
        .join(',')}`;
    if (signature === uninstallSignature) return;
    uninstallSignature = signature;

    for (const card of document.querySelectorAll('.uninstall-card')) {
        // In the Testnet view the node / mining / indexer cards remove the testnet unit.
        const key = effectiveService(card.dataset.uninstall);
        const state = serviceState[key];
        const installed = Boolean(state?.installed);

        // The testnet node and miner share mainnet's images, so they never remove any; the
        // testnet indexer has its own image (KQS-008) and removes it like any service.
        const testnetUnit = TESTNET_UNIT_VALUES.has(key) && key !== 'kachat-testnet' && key !== 'kachat-domains-testnet';
        const removes = key.startsWith('kachat-domains')
            ? `Removes the ${networkView} .kachat Domains server (its containers and image) and, by default, its database. The registry tooling is shared by both networks and goes only when neither has it installed.`
            : testnetUnit
              ? 'Removes the testnet containers and, by default, their data. The images are shared with mainnet, so they are kept (Global settings → Clear cache frees them when nothing uses them).'
              : 'Removes the containers, the images built for it, and by default its data.';
        // One nginx serves both networks: there is no testnet-only proxy to remove.
        const sharedProxy =
            key === 'proxy' && networkView === 'testnet'
                ? `<div class="notice"><p><strong>Shared with mainnet.</strong> There is one proxy for both networks, so this removes the proxy mainnet uses too: every published mainnet and testnet domain stops answering until it is installed again. Your domains and certificates are kept.</p></div>`
                : '';
        card.innerHTML = `
      <h3>Uninstall ${escapeHtml(state?.label ?? key)}</h3>
      <p class="muted">
        ${removes}
        Everything else in the panel leaves all of that alone: stopping a service
        keeps it, and this is the only place that does not.
      </p>
      ${sharedProxy}
      <div class="notice">
        <p><strong>What goes:</strong> ${escapeHtml(UNINSTALL_COPY[key] ?? 'its data')}.</p>
        <p class="muted">Installing it again afterwards starts from nothing, and rebuilds.</p>
      </div>
      <label class="check">
        <input type="checkbox" data-keepdata="${key}"> Keep the data, remove only the containers and images
      </label>
      ${
          installed
              ? `<label class="stack">Type <code>${escapeHtml(key)}</code> to confirm
        <span class="row">
          <input data-uninstall-typed="${key}" placeholder="${escapeHtml(key)}" size="20" autocomplete="off" spellcheck="false">
          <button class="ghost danger" data-douninstall="${key}" disabled>Uninstall</button>
        </span>
      </label>`
              : `<div class="row">
        <button class="ghost danger" disabled>Not installed</button>
        <span class="muted">There is nothing here to remove.</span>
      </div>`
      }`;
    }
}

document.addEventListener('click', async (event) => {
    const key = event.target?.dataset?.install;
    if (!key) return;

    const label = serviceState[key]?.label ?? key;
    await queueAction({
        title: `Installing ${label}`,
        request: (headers) => api(`/api/services/${key}/install`, { method: 'POST', headers }),
    });
});

// The Uninstall button arms only once the name is typed exactly.
document.addEventListener('input', (event) => {
    const key = event.target?.dataset?.uninstallTyped;
    if (!key) return;
    const button = document.querySelector(`[data-douninstall="${key}"]`);
    if (button) button.disabled = event.target.value.trim() !== key;
});

document.addEventListener('click', async (event) => {
    const key = event.target?.dataset?.douninstall;
    if (!key) return;

    const state = serviceState[key];
    const keepData = document.querySelector(`[data-keepdata="${key}"]`)?.checked === true;

    // Typed rather than clicked. This is the one action in the panel that
    // deletes something a person cannot get back. Typed into the card, not a
    // prompt(): some browsers block or auto-dismiss dialogs, which made the
    // button silently do nothing.
    const typed = document.querySelector(`[data-uninstall-typed="${key}"]`)?.value.trim();
    if (typed !== key) return toast('Type the name exactly to confirm. Nothing was removed.');

    // Stopping partway would leave half of it behind, so once
    // it starts it runs to the end (it can still leave the queue while it waits).
    await queueAction({
        title: `Uninstalling ${state?.label ?? key}`,
        noCancel: true,
        request: (headers) => api(`/api/services/${key}/uninstall`, { method: 'POST', body: { confirm: key, keepData }, headers }),
    });
});

// ---------------------------------------------------------------- kachat bot ---

/**
 * The block notifier: a bot that messages you when this node finds a block.
 *
 * It is the first app here whose configuration includes a wallet key, so the
 * screen is built around that. The key goes one way. What comes back is whether
 * one is stored, never the value, so nothing on this tab is worth a screenshot
 * and leaving the page open in an office is not a mistake.
 */
/**
 * What the bot will actually send, with the placeholders filled in.
 *
 * Rendered here as well as on the server, from the same list of names, because
 * the alternative is a round trip on every keystroke -- and because the first
 * time somebody sees whether their message works should not be the first time
 * this node finds a block.
 */
function renderQr(el, text) {
    el.textContent = '';
    if (!text || typeof window.qrcode !== 'function') return;
    try {
        const qr = window.qrcode(0, 'M'); // type 0 = auto-size, medium correction
        qr.addData(text);
        qr.make();
        // An image, not inline SVG: night modes recolour inline SVG (white turns dark grey and
        // the code stops scanning) but leave images alone.
        const svg = qr.createSvgTag({ cellSize: 4, margin: 2, scalable: true });
        const img = document.createElement('img');
        img.alt = 'QR code';
        img.src = `data:image/svg+xml;base64,${btoa(svg)}`;
        el.replaceChildren(img);
    } catch {
        /* an address too long for a QR is not worth a broken tab */
    }
}

// --- KaChat bots: one square per kind (lib/bots.js on the server) ---

let botsState = null;
const botShort = (a) => (a && a.length > 26 ? `${a.slice(0, 16)}…${a.slice(-6)}` : a || '');
const STAGE_TEXT = {
    off: 'Off',
    awaiting_pairing: 'Starting',
    setup: 'Setting up in your KaChat chat',
    active: 'Running',
    paused: 'Paused',
    disabled: 'Paused',
};

async function loadBot({ fresh = false } = {}) {
    let app;
    let payout;
    try {
        [app, botsState, payout] = await Promise.all([api('/api/bot'), api(`/api/bots${fresh ? '?fresh=1' : ''}`), api('/api/bots/payout')]);
    } catch {
        return;
    }
    botsState.payout = payout.address;
    $('bot-payout-net').textContent = payout.network;
    if (document.activeElement !== $('bot-payout')) $('bot-payout').value = payout.address;
    $('bot-payout-note').textContent = payout.address
        ? 'Saved. Send to wallet on any bot sends its funds here.'
        : 'Not set yet.';
    const container = app.container;
    const asContainer = { exists: container?.installed, running: container?.running, status: container?.status };
    $('bot-state').textContent = containerWord(asContainer);
    $('bot-state').className = `tag ${!container?.installed ? 'off' : container.running ? 'ok' : ''}`;
    setNavHealth('bot', !container?.installed ? 'absent' : container.running ? 'ok' : 'bad');
    if (document.activeElement !== $('bot-network')) $('bot-network').value = app.app.network;
    if (document.activeElement !== $('bot-ref')) $('bot-ref').value = app.app.ref;
    $('bot-build').textContent = app.build?.sha
        ? `Built from ${String(app.build.sha).slice(0, 7)} on ${new Date(app.build.builtAt).toLocaleString()}`
        : 'Not built yet.';

    const notice = $('bot-notice');
    const problems = [...(app.blockers ?? [])];
    // The new bot program is not built yet: Rebuild is the next step, so it is always open.
    if (botsState.needsRebuild) $('bot-update').disabled = false;
    if (botsState.needsRebuild) problems.push('One step first: open Updates and click Rebuild. The new bots need the new bot program, which is not built on this machine yet.');
    if (container?.installed && !container.running && botsState.bots.length) problems.push('The bot is switched off, so your bots are not listening. Turn it on with its switch in the sidebar.');
    notice.hidden = !problems.length;
    notice.className = 'verdict bad';
    notice.textContent = problems.join(' ');
    renderBotGrid();
}

function renderBotGrid() {
    const d = botsState;
    const grid = $('bot-grid');
    if (!d) return;
    grid.innerHTML = d.catalog
        .map((kind) => {
            const mine = d.bots.filter((b) => b.type === kind.type);
            const body = mine.length
                ? mine.map((b) => botCard(b, d)).join('')
                : `<p class="muted">${escapeHtml(kind.description)}</p>
                   <div class="row"><button type="button" class="primary" data-bot-setup="${escapeHtml(kind.type)}" ${d.installed && !d.needsRebuild ? '' : 'disabled'}>Set up</button></div>
                   ${!d.installed ? '<p class="hint">Install the KaChat Bot first (sidebar).</p>' : d.needsRebuild ? '<p class="hint">Rebuild it first (Updates, Rebuild).</p>' : ''}`;
            // The balance it holds, next to its name (one bot per kind in practice).
            const bals = mine.map((b) => b.balanceKas).filter((v) => v != null);
            const bal = bals.length ? bals.reduce((a, v) => a + v, 0) : null;
            const tag = mine.length ? `<span class="tag bot-balance">${bal == null ? 'balance unknown' : `${bal.toFixed(bal < 1 ? 4 : 2)} KAS`}</span>` : '';
            return `<article class="card bot-square"><h3 class="bot-title">${escapeHtml(kind.title)} ${tag}</h3>${body}</article>`;
        })
        .join('');
    for (const el of grid.querySelectorAll('.bot-qr')) renderQr(el, el.dataset.address);
    renderBotReset();
}

/** Reset sub-tab: every bot, with Reset (wipe it) and New owner (keep its wallet). */
function renderBotReset() {
    const box = $('bot-reset-list');
    const list = botsState?.bots ?? [];
    if (!list.length) {
        box.innerHTML = '<p class="muted">No bots set up yet.</p>';
        return;
    }
    box.innerHTML = list
        .map(
            (b) => `
      <div class="bot-reset-row" data-bot="${escapeHtml(b.id)}">
        <div><strong>${escapeHtml(b.title)}</strong>
          <div class="muted"><code>${escapeHtml(botShort(b.address))}</code>${
              b.balanceKas != null ? `, holds ${b.balanceKas.toFixed(8)} KAS` : ''
          }</div></div>
        <div class="row">
          <button type="button" class="ghost mini" data-bot-resetsettings>Reset</button>
          <button type="button" class="ghost mini danger" data-bot-wipe>Remove</button>
        </div>
      </div>`,
        )
        .join('');
}

$('bot-reset-list')?.addEventListener('click', async (ev) => {
    const row = ev.target.closest('[data-bot]');
    if (!row) return;
    const id = row.dataset.bot;
    const b = botsState?.bots.find((x) => x.id === id);
    if (ev.target.closest('[data-bot-resetsettings]')) {
        const ok = await askConfirm(
            b?.type === 'faq'
                ? `Reset ${b.title}?\n\nIts counts (answers given, people today, each person's daily answers) and its list of unanswered questions start over. Its wallet and its KAS stay.`
                : `Reset ${b?.title ?? 'this bot'}?\n\nIt forgets everyone's setup: each person gets its first setup questions again the next time they message it. ` +
                      'Its wallet and its KAS stay.',
        );
        if (!ok) return;
        try {
            await api(`/api/bots/${id}/reset-settings`, { method: 'POST' });
        } catch (e) {
            await askConfirm(e.message);
        }
        return loadBot().catch(() => {});
    }
    if (ev.target.closest('[data-bot-wipe]')) {
        const holds = b?.balanceKas > 0 ? ` It still holds ${b.balanceKas.toFixed(8)} KAS.` : '';
        const ok = await askConfirm(
            `Remove ${b?.title ?? 'this bot'}?\n\nEverything is wiped: its wallet key, everyone's settings and its messages.${holds}\n\n` +
                'Any KAS left in its wallet is lost for good unless you have used Send to wallet or saved its wallet key first.',
        );
        if (!ok) return;
        try {
            await api(`/api/bots/${id}`, { method: 'DELETE', body: { confirm: id } });
        } catch (e) {
            await askConfirm(e.message);
        }
        return loadBot().catch(() => {});
    }
});

function botCard(b, d) {
    const st = b.status;
    const bal = b.balanceKas;
    const funded = st ? st.funded : bal != null && bal > 0.01;
    // Every bot is public: no owner, no pairing code, live as soon as it runs.
    const isFaq = b.type === 'faq';
    const stage = b.enabled === false ? 'off' : st?.stage || 'active';
    // Only once it has been funded: before that, step 1 already says to fund it.
    const low = funded && bal != null && bal < 0.25;
    return `
      <div class="bot-card" data-bot="${escapeHtml(b.id)}">
        <div class="node-head"><span class="tag ${stage === 'active' ? 'ok' : stage === 'paused' ? '' : 'warn'}">${escapeHtml(STAGE_TEXT[stage] || stage)}</span>
          <span class="row bot-head-actions">
          <button type="button" class="ghost mini" data-bot-act="refresh" title="Read its balance from the node now, and how many people use it">Refresh</button>
          <label class="switch mini bot-switch" title="Turn this bot on or off. Off keeps its wallet and everyone's settings.">
            <input type="checkbox" data-bot-toggle ${b.enabled === false ? '' : 'checked'} aria-label="Turn this bot on or off"><span class="track"></span>
          </label></span></div>
        ${st?.summary ? `<p><strong>${escapeHtml(st.summary)}</strong></p>` : ''}
        ${!funded ? '<p class="hint">Send it about 5 KAS to start: it pays for every message it sends.</p>' : ''}
        ${isFaq && st?.stats ? `<p class="muted">${st.stats.answered} answers given, ${st.stats.peopleToday} ${st.stats.peopleToday === 1 ? 'person' : 'people'} asked today.</p>` : ''}
        ${!isFaq && st?.stats ? `<p class="muted">${st.stats.active} ${st.stats.active === 1 ? 'person' : 'people'} set up${st.stats.people > st.stats.active ? `, ${st.stats.people - st.stats.active} still setting up` : ''}.</p>` : ''}
        <div class="bot-wallet-row">
          <div class="bot-wallet-qr bot-qr" data-address="${escapeHtml(b.address)}"></div>
          <div>
            <div class="row x4kas-copy"><code>${escapeHtml(b.address)}</code>
              <button type="button" class="ghost mini" data-copy="${escapeHtml(b.address)}">Copy</button></div>
            ${low ? '<p class="hint bad">Its balance is low: send it a few KAS so it can keep messaging you.</p>' : ''}
            ${st?.error ? `<p class="error">${escapeHtml(st.error)}</p>` : ''}
          </div>
        </div>
        <details class="bot-more"><summary>Messages and options</summary>
          ${isFaq ? `<p class="muted"><strong>Questions it had no answer for</strong>${
              st?.stats?.missed?.length
                  ? `</p><ul class="bot-msgs">${st.stats.missed.map((m) => `<li>${escapeHtml(m)}</li>`).join('')}</ul>`
                  : ': none yet.</p>'
          }` : ''}
          <div class="bot-history" data-history="${escapeHtml(b.id)}"><p class="muted">Loading...</p></div>
          <div class="row">
            <button type="button" class="ghost mini" data-bot-act="sweep">Send to wallet</button>
            <button type="button" class="ghost mini" data-bot-act="reveal">Reveal wallet key</button>
          </div>
          <div class="verdict" data-bot-key hidden></div>
        </details>
      </div>`;
}

$('bot-grid')?.addEventListener('click', async (ev) => {
    const setup = ev.target.closest('[data-bot-setup]')?.dataset.botSetup;
    if (setup) {
        ev.target.disabled = true;
        try {
            await api('/api/bots', { method: 'POST', body: { type: setup } });
        } catch (e) {
            await askConfirm(`Could not set it up: ${e.message}`);
        }
        return loadBot().catch(() => {});
    }
    const act = ev.target.closest('[data-bot-act]')?.dataset.botAct;
    const card = ev.target.closest('[data-bot]');
    if (!act || !card) return;
    const id = card.dataset.bot;
    if (act === 'refresh') {
        const btn = ev.target.closest('[data-bot-act]');
        btn.disabled = true;
        btn.textContent = 'Refreshing...';
        await loadBot({ fresh: true }).catch(() => {});
        // Re-rendered with the fresh numbers; if this square was kept, give its button back.
        if (btn.isConnected) {
            btn.disabled = false;
            btn.textContent = 'Refresh';
        }
        return;
    }
    if (act === 'reveal') {
        const r = await api(`/api/bots/${id}/reveal`, { method: 'POST' });
        const box = card.querySelector('[data-bot-key]');
        box.hidden = false;
        box.innerHTML = `Wallet key: <code>${escapeHtml(r.privateKeyHex)}</code> <button type="button" class="ghost mini" data-copy="${escapeHtml(r.privateKeyHex)}">Copy</button><br><span class="hint">Import it into any Kaspa wallet to move what is left. Anyone with it can spend this bot's KAS.</span>`;
        return;
    }
    if (act === 'sweep') {
        const to = botsState?.payout;
        if (!to) {
            await askConfirm('Set your wallet address first: Bot, Wallet.');
            return selectSubtab($('tab-bot'), 'bot-wallet');
        }
        const b = botsState.bots.find((x) => x.id === id);
        const amount = b?.balanceKas != null ? `${b.balanceKas.toFixed(8)} KAS` : 'everything';
        const ok = await askConfirm(
            `Send ${amount} from this bot to your wallet?\n\n${to}\n\nThe network fee comes out of it. The bot cannot message you again until you fund it again.`,
        );
        if (!ok) return;
        await runAction({
            key: null,
            title: 'Sending the bot\'s funds to your wallet',
            note: 'The bot sends everything in its wallet to your address. It takes a few seconds once it starts.',
            request: () => api(`/api/bots/${id}/sweep`, { method: 'POST', body: { confirm: id } }),
        });
        return loadBot().catch(() => {});
    }
    loadBot().catch(() => {});
});

// A bot's switch: off stops it listening and sending; its wallet and everyone's settings stay.
$('bot-grid')?.addEventListener('change', async (ev) => {
    const input = ev.target.closest('[data-bot-toggle]');
    if (!input) return;
    const id = input.closest('[data-bot]').dataset.bot;
    input.disabled = true;
    try {
        await api(`/api/bots/${id}/${input.checked ? 'resume' : 'pause'}`, { method: 'POST' });
    } catch (e) {
        input.checked = !input.checked;
        await askConfirm(e.message);
    }
    loadBot().catch(() => {});
});

// A bot's messages load when its details open.
$('bot-grid')?.addEventListener(
    'toggle',
    async (ev) => {
        const det = ev.target;
        if (!det.matches?.('details.bot-more') || !det.open) return;
        const box = det.querySelector('[data-history]');
        try {
            const r = await api(`/api/bots/${box.dataset.history}/history`);
            box.innerHTML = r.messages.length
                ? `<ul class="plain bot-msgs">${r.messages
                      .map(
                          (m) => `<li class="${m.dir}"><span class="muted">${m.ts ? escapeHtml(new Date(m.ts * 1000).toLocaleString()) : ''} ${
                              m.dir === 'in' ? 'You' : 'Bot'
                          }:</span> ${escapeHtml(m.text)}</li>`,
                      )
                      .join('')}</ul>`
                : '<p class="muted">No messages yet.</p>';
        } catch (e) {
            box.innerHTML = `<p class="error">${escapeHtml(e.message)}</p>`;
        }
    },
    true,
);

$('bot-payout-save')?.addEventListener('click', async () => {
    const note = $('bot-payout-note');
    try {
        await api('/api/bots/payout', { method: 'PUT', body: { address: $('bot-payout').value.trim() } });
        note.className = 'hint';
        note.textContent = 'Saved. Send to wallet on any bot sends its funds here.';
    } catch (e) {
        note.className = 'hint bad';
        note.textContent = e.message;
    }
});

// The branch the bot is built from, saved as soon as it changes (Updates, Check, Rebuild).
$('bot-ref')?.addEventListener('change', async () => {
    try {
        await api('/api/bot/field', { method: 'POST', body: { field: 'ref', value: $('bot-ref').value.trim() || 'main' } });
        $('bot-update-status').className = 'update-status';
        $('bot-update-status').textContent = 'Branch saved. Check for updates, then Rebuild.';
    } catch (e) {
        await askConfirm(e.message);
    }
    loadBot().catch(() => {});
});

$('bot-network')?.addEventListener('change', async () => {
    const value = $('bot-network').value;
    const ok = await askConfirm(
        `Run the bots on ${value}?\n\nEach bot's wallet belongs to one network, so bots set up on the other network stop working until you switch back.`,
    );
    if (!ok) return loadBot().catch(() => {});
    try {
        await api('/api/bot/field', { method: 'POST', body: { field: 'network', value } });
    } catch (e) {
        await askConfirm(e.message);
    }
    loadBot().catch(() => {});
});

$('bot-check').addEventListener('click', async () => {
    const notice = $('bot-update-status');
    setUpdateStatus(notice, 'checking', 'Checking GitHub…');
    try {
        const r = await api('/api/apps/bot/check');
        $('bot-update').disabled = !r.updateAvailable;
        if (r.neverBuilt) {
            setUpdateStatus(notice, 'info', `${r.repo}@${r.ref} is at ${r.shortSha}: "${r.message}". Nothing built yet, so install it first.`);
        } else if (r.builtUnknown) {
            setUpdateStatus(notice, 'available', `This is running an image from an earlier setup, so the panel cannot tell its version. Rebuild to move to the latest commit (${r.shortSha}) and start tracking updates.`);
        } else if (r.updateAvailable) {
            setUpdateStatus(notice, 'available', `Update available: ${r.shortSha}, "${r.message}". You are running ${String(r.builtSha).slice(0, 7)}.`);
        } else {
            setUpdateStatus(notice, 'current', `Up to date, running ${r.shortSha}, the newest commit on ${r.ref}.`);
        }
    } catch (e) {
        setUpdateStatus(notice, 'error', e.message);
    }
});

$('bot-update').addEventListener('click', async () => {
    if (!await askConfirm('Rebuild the bot from the newest commit?\n\nIt stops sending notifications while it rebuilds.')) return;
    await queueAction({
        title: 'Rebuilding KaChat Bot',
        request: (headers) => api('/api/apps/bot/update', { method: 'POST', headers }),
    });
});

// ------------------------------------------------------------ chess service ---

// Read-only view of the chess leaderboard the KaChat indexer replays from #chess-arena.
const chessShort = (addr) => {
    const s = String(addr ?? '');
    return s.length > 24 ? `${s.slice(0, 12)}…${s.slice(-6)}` : s;
};
const chessWhen = (ms) => {
    if (!ms) return '–';
    try {
        return new Date(Number(ms)).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
    } catch {
        return '–';
    }
};

async function loadChess() {
    const err = $('chess-error');
    err.hidden = true;
    try {
        renderChess(await api(`/api/chess${networkView === 'testnet' ? '?net=testnet' : ''}`));
    } catch (e) {
        err.textContent = e.message;
        err.hidden = false;
    }
}

function renderChess(data) {
    const state = $('chess-state');
    if (!data.installed) {
        state.textContent = 'not installed';
        state.className = 'tag off';
    } else if (!data.running) {
        state.textContent = 'stopped';
        state.className = 'tag off';
    } else {
        state.textContent = 'live';
        state.className = 'tag ok';
    }

    const err = $('chess-error');
    if (data.error) {
        err.textContent = data.error;
        err.hidden = false;
    } else {
        err.hidden = true;
    }

    // Two boards, sorted panel-side the way the app sorts each (§6). The server returns the raw
    // per-player breakdown; the phone (and here) re-sorts by the board it is showing.
    const players = data.leaderboard || [];
    const nameCell = (a) => `<td class="mono" title="${escapeHtml(a)}">${escapeHtml(chessShort(a))}</td>`;

    const duel = players
        .filter((p) => (p.duelWins || 0) + (p.duelLosses || 0) > 0)
        .sort(
            (a, b) =>
                (b.duelWins || 0) - (a.duelWins || 0) ||
                (a.duelLosses || 0) - (b.duelLosses || 0) ||
                (b.lastPlayedAt || 0) - (a.lastPlayedAt || 0),
        );
    const db = $('chess-duel-board');
    if (!duel.length) {
        db.innerHTML = '<p class="muted">No 1v1 games in the last 30 days yet.</p>';
    } else {
        db.innerHTML =
            '<table class="blocks"><thead><tr><th>#</th><th>Player</th><th>Wins</th><th>Losses</th><th>Last</th></tr></thead><tbody>' +
            duel
                .map(
                    (p, i) =>
                        `<tr><td>${i + 1}</td>${nameCell(p.address)}<td>${escapeHtml(fmtNum(p.duelWins))}</td><td>${escapeHtml(fmtNum(p.duelLosses))}</td><td>${escapeHtml(chessWhen(p.lastPlayedAt))}</td></tr>`,
                )
                .join('') +
            '</tbody></table>';
    }

    // Tournament board = whole tournaments only: won (champion) vs lost (knocked out).
    const tourney = players
        .filter((p) => (p.tournamentsWon || 0) + (p.tournamentsLost || 0) > 0)
        .sort(
            (a, b) =>
                (b.tournamentsWon || 0) - (a.tournamentsWon || 0) ||
                (a.tournamentsLost || 0) - (b.tournamentsLost || 0) ||
                (b.lastPlayedAt || 0) - (a.lastPlayedAt || 0),
        );
    const tb = $('chess-tournament-board');
    if (!tourney.length) {
        tb.innerHTML = '<p class="muted">No tournaments in the last 30 days yet.</p>';
    } else {
        tb.innerHTML =
            '<table class="blocks"><thead><tr><th>#</th><th>Player</th><th>Won</th><th>Lost</th><th>Last</th></tr></thead><tbody>' +
            tourney
                .map(
                    (p, i) =>
                        `<tr><td>${i + 1}</td>${nameCell(p.address)}<td>${escapeHtml(fmtNum(p.tournamentsWon))}</td><td>${escapeHtml(fmtNum(p.tournamentsLost))}</td><td>${escapeHtml(chessWhen(p.lastPlayedAt))}</td></tr>`,
                )
                .join('') +
            '</tbody></table>';
    }
}

$('chess-refresh').addEventListener('click', () => loadChess().catch(() => {}));

// ---------------------------------------------------------- address profiles ---

// Read-only stats on people stamping their socials to an address (kchat:1:profile:). Profiles
// belong to the address, not to a .kachat name, so this shows on both networks.
async function loadProfiles() {
    const err = $('profiles-error');
    err.hidden = true;
    try {
        renderProfiles(await api(`/api/profiles${networkView === 'testnet' ? '?net=testnet' : ''}`));
        // Keep the page on a refresh; start over when the network changed.
        await loadProfilesHistory(profilesHistory.net === networkView ? profilesHistory.page : 1);
    } catch (e) {
        err.textContent = e.message;
        err.hidden = false;
    }
}

function renderProfiles(data) {
    const state = $('profiles-state');
    const st = data.stats;
    if (!data.installed) {
        state.textContent = 'not installed';
        state.className = 'tag off';
    } else if (!data.running) {
        state.textContent = 'stopped';
        state.className = 'tag off';
    } else if (!st) {
        state.textContent = 'not following';
        state.className = 'tag warn';
    } else if (st.synced === false) {
        state.textContent = 'catching up';
        state.className = 'tag warn';
    } else {
        state.textContent = 'live';
        state.className = 'tag ok';
    }

    const err = $('profiles-error');
    err.textContent = data.error || '';
    err.hidden = !data.error;

    const num = (v) => (v == null ? '–' : fmtNum(v));
    $('profiles-total').textContent = num(st?.total);
    $('profiles-new24h').textContent = num(st?.new24h);
    $('profiles-new7d').textContent = num(st?.new7d);
    $('profiles-new30d').textContent = num(st?.new30d);
    $('profiles-saves7d').textContent = num(st?.saves7d);
    $('profiles-records').textContent = num(st?.records);

    const empty = (what) => `<p class="muted">${what}</p>`;
    const fields = $('profiles-fields');
    if (!st) {
        fields.innerHTML = empty('No data yet.');
    } else {
        const total = st.total || 0;
        const pct = (n) => (total ? ` <span class="muted">(${Math.round(((n || 0) * 100) / total)}%)</span>` : '');
        const rows = [
            ['Avatar', st.withAvatar],
            ['Banner', st.withBanner],
            ['Bio', st.withBio],
            ['Linktree', st.withLinktree],
            ['Primary .kachat name', st.withPrimaryName],
        ];
        fields.innerHTML =
            '<table class="blocks"><thead><tr><th>Field</th><th>Profiles</th></tr></thead><tbody>' +
            rows.map(([k, v]) => `<tr><td>${escapeHtml(k)}</td><td>${escapeHtml(num(v))}${pct(v)}</td></tr>`).join('') +
            '</tbody></table>';
    }

    // platforms: {avatar: {x: 3, …}, banner: {…}, bio: {…}} -> one row per platform.
    const plat = $('profiles-platforms');
    const p = st?.platforms || {};
    const names = [...new Set(['avatar', 'banner', 'bio'].flatMap((k) => Object.keys(p[k] || {})))];
    if (!names.length) {
        plat.innerHTML = empty(st ? 'No social links yet.' : 'No data yet.');
    } else {
        const used = (n) => ['avatar', 'banner', 'bio'].reduce((t, k) => t + ((p[k] || {})[n] || 0), 0);
        names.sort((a, b) => used(b) - used(a));
        const cell = (k, n) => `<td>${escapeHtml(num((p[k] || {})[n] || 0))}</td>`;
        plat.innerHTML =
            '<table class="blocks"><thead><tr><th>Platform</th><th>Avatar</th><th>Banner</th><th>Bio</th></tr></thead><tbody>' +
            names.map((n) => `<tr><td>${escapeHtml(n)}</td>${cell('avatar', n)}${cell('banner', n)}${cell('bio', n)}</tr>`).join('') +
            '</tbody></table>';
    }

}

// "Every profile save": the indexer's all-time /profiles/history, 25 a page, with the
// same windowed numbered pager as KaPosts' "Recently indexed".
let profilesHistory = { page: 1, total: 0, limit: 25, net: null };

async function loadProfilesHistory(page = 1) {
    const box = $('profiles-recent');
    const qs = new URLSearchParams({ page: String(page) });
    if (networkView === 'testnet') qs.set('net', 'testnet');
    const address = $('profiles-history-address').value.trim();
    if (address) qs.set('address', address);
    const r = await api(`/api/profiles/history?${qs}`);
    profilesHistory = { page: r.page || page, total: r.total || 0, limit: r.limit || 25, net: networkView };
    const empty = (what) => `<p class="muted">${escapeHtml(what)}</p>`;
    if (r.error) {
        box.innerHTML = empty(r.error);
    } else if (!r.items?.length) {
        box.innerHTML = empty(address ? 'This address has no profile saves.' : 'No profiles saved yet.');
    } else {
        // Links are shown as text, never fetched: the panel doesn't load anyone's pictures.
        const link = (u) => (u ? escapeHtml(String(u).replace(/^https:\/\//, '')) : '<span class="muted">–</span>');
        box.innerHTML =
            '<table class="blocks"><thead><tr><th>When</th><th>Address</th><th>Avatar</th><th>Banner</th><th>Bio</th><th>Linktree</th><th></th></tr></thead><tbody>' +
            r.items
                .map(
                    (x) =>
                        `<tr><td title="${escapeHtml(new Date(x.savedAt).toLocaleString())}">${escapeHtml(chessWhen(x.savedAt))}</td>` +
                        `<td class="mono"><a href="#" data-profiles-address="${escapeHtml(x.address)}" title="Show only ${escapeHtml(x.address)}">${escapeHtml(chessShort(x.address))}</a></td>` +
                        `<td>${link(x.avatar)}</td><td>${link(x.banner)}</td><td>${link(x.bio)}</td><td>${link(x.linktree)}</td>` +
                        `<td>${x.current ? '<span class="tag ok">current</span>' : '<span class="muted">replaced</span>'}</td></tr>`,
                )
                .join('') +
            '</tbody></table>';
    }
    renderProfilesPager();
}

function renderProfilesPager() {
    const pager = $('profiles-history-pager');
    const { page: cur, total, limit } = profilesHistory;
    if (!total) {
        pager.innerHTML = '';
        return;
    }
    const pages = Math.max(1, Math.ceil(total / limit));
    const want = new Set([1, pages, cur, cur - 1, cur - 2, cur + 1, cur + 2]);
    const shown = [...want].filter((n) => n >= 1 && n <= pages).sort((a, b) => a - b);
    const btn = (n, label, extra = '') =>
        `<button type="button" class="ghost mini" data-profiles-page="${n}" ${extra}>${label}</button>`;
    let html = btn(Math.max(1, cur - 1), '←', cur === 1 ? 'disabled' : '');
    let prev = 0;
    for (const n of shown) {
        if (n - prev > 1) html += '<span class="muted" style="padding:0 2px">…</span>';
        html += n === cur ? btn(n, String(n), 'aria-current="page" style="font-weight:700;text-decoration:underline"') : btn(n, String(n));
        prev = n;
    }
    html += btn(Math.min(pages, cur + 1), '→', cur === pages ? 'disabled' : '');
    html += `<span class="muted" style="margin-left:8px">${fmtNum(total)} save${total === 1 ? '' : 's'}</span>`;
    pager.innerHTML = html;
}

$('profiles-history-pager').addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-profiles-page]');
    if (!btn || btn.disabled) return;
    const page = Number(btn.dataset.profilesPage);
    if (page && page !== profilesHistory.page) loadProfilesHistory(page).catch((err) => toast(err.message, 'bad'));
});

// Clicking an address narrows the list to it; clearing the box shows everyone again.
$('profiles-recent').addEventListener('click', (e) => {
    const a = e.target.closest('[data-profiles-address]');
    if (!a) return;
    e.preventDefault();
    $('profiles-history-address').value = a.dataset.profilesAddress;
    loadProfilesHistory(1).catch((err) => toast(err.message, 'bad'));
});

let profilesFilterTimer = null;
$('profiles-history-address').addEventListener('input', () => {
    clearTimeout(profilesFilterTimer);
    profilesFilterTimer = setTimeout(() => loadProfilesHistory(1).catch((err) => toast(err.message, 'bad')), 400);
});

$('profiles-refresh').addEventListener('click', () => loadProfiles().catch(() => {}));

// ---------------------------------------------------------- automatic backup ---
let backupPoll = null;
function renderBackupStatus(s) {
    const el = $('backup-status');
    const bar = $('backup-progress');
    if (!el) return;
    // Progress bar: advance through the backup's stages (step/of); indeterminate if unknown.
    if (bar) {
        if (s && s.running) {
            bar.hidden = false;
            if (s.progress && s.progress.of) bar.value = Math.floor((s.progress.step / s.progress.of) * 100);
            else bar.removeAttribute('value');
        } else {
            bar.hidden = true;
            bar.removeAttribute('value');
        }
    }
    let msg;
    if (s && s.running)
        msg = s.progress ? `${s.progress.label} (step ${s.progress.step} of ${s.progress.of})` : 'Backup running…';
    else if (s && s.last && s.last.ok)
        msg = `Last backup ✓ ${new Date(s.last.at).toLocaleString()}: ${s.last.file}`;
    else if (s && s.last)
        msg = `Last backup ✗ ${new Date(s.last.at).toLocaleString()}: ${s.last.error || 'failed'}`;
    else msg = 'No backup has run yet.';
    el.textContent = msg;
    el.hidden = false;
    // Poll while a run is in progress so the bar advances and the status settles on its own.
    if (s && s.running && !backupPoll) {
        backupPoll = setInterval(async () => {
            try {
                const cur = await api('/api/kachat/backup');
                if (!cur.running) { clearInterval(backupPoll); backupPoll = null; }
                renderBackupStatus(cur);
            } catch { clearInterval(backupPoll); backupPoll = null; }
        }, 2500);
    }
}
// ---- Recover missed KaPosts (Indexer, Export / Import): the processor's reindex ----

/**
 * The processor walks the node's blocks on request and indexes the KaChat transactions it
 * finds (kachat-indexer reindex.rs); the admin API carries the request and its status. Polled
 * every few seconds while it runs, and only while this card is on screen.
 */
let reindexTimer = null;
// What the status last said and when it last changed: a "running" that stops changing is a
// walk the processor lost (a restart mid-way), and Retry asks again with force (IDX-037).
let reindexSeen = { key: '', at: 0 };
const REINDEX_STALE_MS = 90_000;

function renderReindex(v) {
    const s = v.status;
    const running = v.requested || s?.state === 'running';
    const key = `${v.requested}:${s?.state}:${s?.blocks}:${s?.queued}:${s?.started_at}`;
    if (key !== reindexSeen.key) reindexSeen = { key, at: Date.now() };
    const stale = running && Date.now() - reindexSeen.at > REINDEX_STALE_MS;
    $('kachat-reindex').disabled = running;
    $('kachat-reindex-retry').hidden = !stale;
    const state = $('kachat-reindex-state');
    if (v.requested && s?.state !== 'running') state.textContent = 'Asked for. The processor picks it up within a few seconds.';
    else if (s?.state === 'running') {
        state.textContent =
            `Running: ${fmtNum(s.blocks)} blocks walked, ${fmtNum(s.found)} KaChat transactions seen, ` +
            `${fmtNum(s.queued)} queued for indexing${s.oldest_ms ? `, from ${kTime(s.oldest_ms)} on` : ''}.`;
    } else state.textContent = '';
    if (stale) state.textContent += ` No progress for ${Math.round((Date.now() - reindexSeen.at) / 1000)}s: the processor may have restarted. Retry starts it again.`;
    const result = $('kachat-reindex-result');
    if (s && s.state !== 'running' && !v.requested) {
        result.hidden = false;
        result.className = `update-status ${s.state === 'done' ? 'current' : 'error'}`;
        result.textContent =
            s.state === 'done'
                ? `Done ${kTime(s.finished_at)}: ${fmtNum(s.blocks)} blocks from ${kTime(s.oldest_ms)} to ${kTime(s.newest_ms)}, ` +
                  `${fmtNum(s.found)} KaChat transactions seen, ${fmtNum(s.queued)} were missing and are indexed now.`
                : `Failed ${kTime(s.finished_at)} after ${fmtNum(s.blocks)} blocks: ${s.error || 'no reason given'}.`;
    } else result.hidden = true;
    return running;
}

async function loadReindex() {
    clearTimeout(reindexTimer);
    reindexTimer = null;
    if (!$('sub-kachat-transfer')?.classList.contains('active') || !$('tab-kachat')?.classList.contains('active')) return;
    try {
        if (renderReindex(await kachat('kaposts/reindex'))) reindexTimer = setTimeout(() => loadReindex().catch(() => {}), 3000);
    } catch (e) {
        $('kachat-reindex-state').textContent = e instanceof IndexerDown ? 'The indexer is not running.' : e.message;
    }
}

$('kachat-reindex-retry')?.addEventListener('click', async () => {
    try {
        renderReindex(await kachat('kaposts/reindex', { method: 'POST', body: { force: true } }));
        loadReindex().catch(() => {});
    } catch (e) {
        toast(e.message, 'bad');
    }
});

$('kachat-reindex')?.addEventListener('click', async () => {
    if (
        !(await askConfirm(
            "Reindex KaPosts from the node's oldest block?\n\n" +
                'The processor walks every block the node still holds and indexes the KaChat transactions it finds. ' +
                'Anything already indexed is skipped, and no notifications go out for old activity. ' +
                'It takes a while and runs inside the indexer, so you can leave this page.',
        ))
    ) {
        return;
    }
    try {
        renderReindex(await kachat('kaposts/reindex', { method: 'POST', body: {} }));
        loadReindex().catch(() => {});
    } catch (e) {
        toast(e.message, 'bad');
    }
});

async function loadBackup() {
    const s = await api('/api/kachat/backup');
    if ($('backup-enabled')) $('backup-enabled').checked = !!s.enabled;
    if ($('backup-dest')) $('backup-dest').value = s.dest || '';
    if ($('backup-keep')) $('backup-keep').value = s.keep || 14;
    renderBackupStatus(s);
}
$('backup-detect')?.addEventListener('click', async () => {
    const sel = $('backup-drive');
    sel.innerHTML = '<option value="">detecting…</option>';
    try {
        const { drives } = await api('/api/kachat/backup/drives');
        if (!drives.length) {
            sel.innerHTML = '<option value="">no external drives found, type a path below</option>';
            return;
        }
        sel.innerHTML =
            '<option value="">Pick a detected drive</option>' +
            drives
                .map((d) => `<option value="${escapeHtml(d.path)}">${escapeHtml(d.label)} (${escapeHtml(d.path)})</option>`)
                .join('');
    } catch (e) {
        sel.innerHTML = '<option value="">detection failed, type a path below</option>';
    }
});
$('backup-drive')?.addEventListener('change', () => {
    const p = $('backup-drive').value;
    if (p) $('backup-dest').value = p.replace(/\/+$/, '') + '/kachat-backups';
});
$('backup-save')?.addEventListener('click', async () => {
    try {
        const s = await api('/api/kachat/backup', {
            method: 'PUT',
            body: {
                enabled: $('backup-enabled').checked,
                dest: $('backup-dest').value.trim(),
                keep: Number($('backup-keep').value) || 14,
            },
        });
        renderBackupStatus(s);
    } catch (e) {
        const el = $('backup-status'); el.hidden = false; el.textContent = `Save failed: ${e.message}`;
    }
});
$('backup-run')?.addEventListener('click', async () => {
    const el = $('backup-status'); el.hidden = false;
    try {
        await api('/api/kachat/backup/run', { method: 'POST' });
        el.textContent = 'Backup started… (a full run can take a while)';
        renderBackupStatus({ running: true });
    } catch (e) {
        el.textContent = `Could not start backup: ${e.message}`;
    }
});
$('backup-restore')?.addEventListener('click', async () => {
    const p = $('backup-restore-path').value.trim();
    if (!p) return;
    if (!await askConfirm(`Restore OVERWRITES the current KaPosts database and re-imports the chat store from:\n${p}\n\nContinue?`)) return;
    const el = $('backup-status'); el.hidden = false; el.textContent = 'Restoring… do not close this page.';
    try {
        await api('/api/kachat/backup/restore', { method: 'POST', body: { path: p } });
        el.textContent = 'Restore complete.';
    } catch (e) {
        el.textContent = `Restore failed: ${e.message}`;
    }
});

// -------------------------------------------------------------------- push ---
// The Push Service panel: FCM (Android) + APNs (iPhone) credentials for the
// KaChat indexer. Loaded on arrival, saved through /api/push.
// --- .kachat names registry (testnet) ---

// --- .kachat Domains (installable registry tooling; Overview / Updates / Uninstall) ---

let kdState = null;

async function loadKachatDomains(indexerStatus = null) {
    const tag = $('kd-state');
    if (!tag) return;
    let d;
    try {
        d = await api(`/api/kachat-domains?net=${networkView}`);
    } catch {
        return;
    }
    kdState = d;
    const sm = d.summary;
    const short = (h) => (h ? `<code title="${escapeHtml(h)}">${escapeHtml(String(h).slice(0, 16))}…</code>` : '–');

    // Overview
    tag.textContent = !d.installed ? 'not installed' : d.running ? 'running' : 'stopped';
    tag.className = `tag ${!d.installed ? 'off' : d.running ? 'ok' : 'warn'}`;
    const rows = [];
    if (sm) {
        rows.push(
            ['Verified registry', `v${escapeHtml(String(sm.registryVersion))} ${short(sm.registryCovenantId)} (${escapeHtml(sm.network || '')})`],
            ['Genesis', short(sm.genesisTxid)],
            ['Verified manifest', short(sm.manifestSha256)],
        );
    }
    if (d.revision) rows.push(['Registry tooling', short(d.revision)]);
    if (d.serverBuilt) rows.push(['Server (KaChat-Indexer)', short(d.serverBuilt)]);
    $('kd-facts').innerHTML = rows.map(([k, v]) => `<div><dt>${k}</dt><dd>${v}</dd></div>`).join('');
    const note = $('kd-note');
    const live = indexerStatus?.manifestRegistryCovenantId;
    const where = networkView === 'testnet' ? 'testnet' : 'mainnet';
    const view = networkView === 'testnet' ? 'Testnet' : 'Mainnet';
    const push = d.indexerInstalled
        ? ` Name pushes go out through the ${where} KaChat Indexer's push service.`
        : ' No KaChat Indexer here, so it sends no name pushes (nothing else is missing).';
    if (!d.nodeInstalled) {
        note.textContent = `Install the ${where} Kaspad first (Kaspad, in this ${view} view). That node is all .kachat Domains needs: it runs its own names server and database, with no KaChat Indexer.`;
    } else if (sm && live && live.toLowerCase() !== String(sm.registryCovenantId).toLowerCase()) {
        note.textContent = `Warning: the server follows registry ${live.slice(0, 12)}…, not the verified ${String(sm.registryCovenantId).slice(0, 12)}…. Run Updates → Update to hand it over.`;
    } else if (!d.installed) {
        note.textContent =
            'Installing builds the registry tooling (once, shared by both networks) and the names server, which only compiles the names parts of KaChat-Indexer. It needs only the node.';
    } else if (!sm) {
        note.textContent = `Installed. There is no ${d.network} registry yet, so there is nothing to start. Updates → Update picks one up once kachat-domains publishes it.`;
    } else if (!d.running) {
        note.textContent = `Installed and stopped. Turn it on with its switch in the sidebar.${push}`;
    } else if (!d.nodeRunning) {
        note.textContent = `Running, but the ${where} Kaspad is stopped: the server waits for it.`;
    } else {
        note.textContent = `On: this machine serves the .kachat names, profiles and identity API for ${d.network}.${push}`;
    }

    // Updates
    $('kd-source').textContent = `${d.repo} @ ${d.ref}`;
    $('kd-installed').innerHTML = d.installed
        ? `tooling ${short(d.revision)}${d.serverBuilt ? ` · server ${short(d.serverBuilt)}` : ''}`
        : 'not installed';
    $('kd-check').disabled = !d.installed;
    if (!d.installed) {
        $('kd-update').disabled = true;
        $('kd-update-status').textContent = 'Install .kachat Domains first (Overview).';
    }

}

$('kd-check')?.addEventListener('click', async () => {
    const status = $('kd-update-status');
    status.textContent = 'Checking GitHub…';
    try {
        const r = await api('/api/kachat-domains/check');
        $('kd-latest').innerHTML =
            `tooling <code>${escapeHtml(r.latest.sha.slice(0, 12))}</code> ${escapeHtml(r.latest.message || '')}` +
            `<br>server <code>${escapeHtml(r.server.sha.slice(0, 12))}</code> ${escapeHtml(r.server.message || '')}`;
        $('kd-update').disabled = !r.updateAvailable;
        status.className = `update-status ${r.updateAvailable ? 'available' : 'current'}`;
        // Which half moved: the registry tooling, the names server's own code, or neither.
        // KaChat-Indexer commits that touch nothing the server is built from are not an update.
        const what = [r.toolingUpdate ? 'the registry tooling' : '', r.serverUpdate ? "the names server's code" : ''].filter(Boolean).join(' and ');
        status.textContent = r.updateAvailable
            ? `A newer version of ${what || '.kachat Domains'} is available.`
            : 'Up to date. New KaChat-Indexer commits that leave the names server untouched are not counted.';
    } catch (e) {
        status.className = 'update-status error';
        status.textContent = e.message;
    }
});

$('kd-update')?.addEventListener('click', async () => {
    await queueAction({
        title: 'Updating .kachat Domains',
        request: (headers) => api('/api/kachat-domains/update', { method: 'POST', headers }),
        onEnd: (job) => {
            if (job.status === 'succeeded') $('kd-update-status').textContent = 'Updated. Check again any time.';
            loadNames().catch(() => {});
        },
    });
    $('kd-update').disabled = true;
});

// ------------------------------------------------------ offer refund keeper ---

/**
 * .kachat Domains, Refunds: the offer refund keeper's switch and each network's last run. The
 * keeper itself runs in the manager every few hours (lib/refund-keeper.js); this only shows it.
 */
const keeperWhen = (ms) => (ms ? new Date(ms).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : 'never');

function renderKeeper(v) {
    $('keeper-enabled').checked = v.enabled;
    $('keeper-every').textContent = String(v.everyHours);
    const rows = [];
    const alerts = [];
    let tail = '';
    for (const [net, r] of Object.entries(v.nets)) {
        let result;
        if (r.running) result = 'running now…';
        else if (r.idle) result = `<span class="muted">${escapeHtml(r.idle)}</span>`;
        else if (r.ok === null) result = '<span class="muted">not run yet</span>';
        else if (r.ok) {
            const extra = [r.skipped ? `${r.skipped} skipped` : '', r.alreadySpent ? `${r.alreadySpent} already refunded elsewhere` : '', r.unreadable ? `${r.unreadable} could not be read` : ''].filter(Boolean).join(', ');
            result = `<span class="good">OK</span>, ${fmtNum(r.open)} open, ${fmtNum(r.due)} expired${extra ? `, ${escapeHtml(extra)}` : ''}`;
        } else result = `<span class="bad">failed</span>: ${escapeHtml(r.error || 'see the output')}`;
        if (r.fails >= 2) alerts.push(`${r.label}: failed ${r.fails} times in a row. Expired offers are not being refunded from this server.`);
        rows.push(
            `<tr><td>${escapeHtml(r.label)}</td><td>${escapeHtml(keeperWhen(r.lastAt))}</td><td>${result}</td>` +
                `<td>${r.ok === null ? '–' : fmtNum(r.refunded)}</td>` +
                `<td>${v.enabled && !r.idle ? escapeHtml(keeperWhen(r.nextAt)) : '–'}</td>` +
                `<td><button type="button" class="ghost" data-keeper-run="${net}" ${r.running || r.idle ? 'disabled' : ''}>Run now</button></td></tr>`,
        );
        if (r.tail?.length && (!tail || (r.lastAt ?? 0) > tail.at)) tail = { at: r.lastAt, text: `${r.label}, ${keeperWhen(r.lastAt)}\n\n${r.tail.join('\n')}` };
    }
    $('keeper-rows').innerHTML = rows.join('');
    $('keeper-alert').hidden = alerts.length === 0;
    $('keeper-alert').textContent = alerts.join(' ');
    $('keeper-tail').textContent = tail ? tail.text : 'Nothing yet.';
}

async function loadKeeper() {
    renderKeeper(await api('/api/kachat-domains/keeper'));
}

$('keeper-enabled')?.addEventListener('change', async (event) => {
    const on = event.target.checked;
    if (!on && !(await askConfirm('Turn the offer refund keeper off?\n\nExpired .kachat offers are then refunded only when their buyer opens their own app, or another server refunds them.'))) {
        event.target.checked = true;
        return;
    }
    try {
        renderKeeper(await api('/api/kachat-domains/keeper', { method: 'PUT', body: { enabled: on } }));
    } catch (e) {
        event.target.checked = !on;
        toast(e.message, 'bad');
    }
});

$('keeper-rows')?.addEventListener('click', async (event) => {
    const net = event.target.closest('[data-keeper-run]')?.dataset.keeperRun;
    if (!net) return;
    event.target.disabled = true;
    event.target.textContent = 'Running…';
    try {
        renderKeeper(await api('/api/kachat-domains/keeper/run', { method: 'POST', body: { net } }));
        toast('Refund keeper run finished.', 'good');
    } catch (e) {
        toast(e.message, 'bad');
        loadKeeper().catch(() => {});
    }
});

async function loadNames() {
    const setText = (id, v) => {
        const e = $(id);
        if (e) e.textContent = v;
    };
    const tag = $('names-state');
    const blank = () => {
        for (const id of ['names-network', 'names-covenant', 'names-genesis', 'names-daa', 'names-synced']) setText(id, '–');
    };
    try {
        const s = await api(`/api/names/status?net=${networkView}`);
        loadKachatDomains(s).catch(() => {});
        loadNamesStats().catch(() => {});
        if (!s || s.available === false) {
            if (tag) {
                tag.textContent = { off: 'no manifest', unreachable: 'indexer off' }[s?.reason] || 'not running';
                tag.className = 'tag off';
            }
            blank();
            setText('names-status-note', s?.message || 'The names module is not available yet.');
            return;
        }
        // A start block the node has pruned never comes back by itself
        // (kachat-indexer docs/KACHAT_NAMES_PRUNED_START.md).
        const pruned = s.error === 'start_block_pruned';
        if (tag) {
            tag.textContent = pruned ? 'stuck' : s.synced ? 'synced' : 'syncing';
            tag.className = `tag ${pruned ? 'bad' : s.synced ? 'ok' : 'warn'}`;
        }
        setText('names-network', s.network || (networkView === 'testnet' ? 'testnet-10' : 'mainnet'));
        // The indexer withholds registryCovenantId until synced (it is the apps'
        // switch to use it); the manifest's id comes through separately.
        setText('names-covenant', s.manifestRegistryCovenantId || s.registryCovenantId || '–');
        setText('names-genesis', s.genesisTxId || '–');
        setText('names-daa', s.indexedDaa != null ? fmtNum(s.indexedDaa) : '–');
        setText('names-synced', s.synced ? 'yes' : 'no');
        setText(
            'names-status-note',
            pruned
                ? `The follower cannot start: block ${String(s.startBlock || '').slice(0, 16)}… is older than this node keeps (about a day). Load a manifest the same day its genesis is sent, or run the node as an archival node. The apps are unaffected: they read the chain themselves.`
                : s.registryVersion
                  ? `Registry v${s.registryVersion}${
                        s.manifestPriceCovenantId ? `, price covenant ${s.manifestPriceCovenantId.slice(0, 12)}…` : ', fixed prices'
                    }.${
                        // The node had pruned the start block, so the indexer rebuilt the
                        // registry from the Kaspa REST API (kachat-indexer PRUNED_START.md §3).
                        s.bootstrappedAt
                            ? ` Rebuilt from the Kaspa REST API at DAA ${fmtNum(s.bootstrappedAt)}: offers made before then show up once they are accepted, declined or refunded.`
                            : ''
                    }`
                  : '',
        );
    } catch {
        if (tag) {
            tag.textContent = 'not running';
            tag.className = 'tag off';
        }
        blank();
        setText('names-status-note', 'The names module is not available yet.');
    }
}

/** The overview's Registry stats card: names, the market and activity, from /stats/names. */
async function loadNamesStats() {
    const box = $('kd-stats');
    if (!box) return;
    let d;
    try {
        d = await api(`/api/names/stats?net=${networkView}`);
    } catch {
        d = { available: false, message: 'Stats are not available right now.' };
    }
    if (!d.available) {
        box.innerHTML = '';
        $('kd-stats-note').textContent = d.message || '';
        $('kd-stats-when').textContent = '';
        return;
    }
    const kas = (sompi) => (sompi == null ? '–' : `${fmtNum(Math.round(Number(sompi) / 1e8 * 100) / 100)} KAS`);
    const a = d.activity || {};
    const act = (k) => a[k] || { total: 0, last24h: 0, last7d: 0 };
    const tile = (label, value, sub = '') =>
        `<div class="stat"><span>${escapeHtml(String(value))}</span><small>${escapeHtml(label)}</small>${
            sub ? `<small class="stat-sub">${escapeHtml(sub)}</small>` : ''
        }</div>`;
    const recent = (k) => `${fmtNum(act(k).last24h)} today, ${fmtNum(act(k).last7d)} this week`;
    box.innerHTML = [
        tile('Names registered', fmtNum(d.names.active), `${fmtNum(d.names.owners)} owners`),
        tile('In grace', fmtNum(d.names.grace), `${fmtNum(d.names.lapsed)} lapsed`),
        tile('For sale', fmtNum(d.market.listed), d.market.floorPrice ? `from ${kas(d.market.floorPrice)}` : 'none listed'),
        tile('Open offers', fmtNum(d.market.openOffers), `${kas(d.market.openOfferValue)} offered`),
        tile('Registrations', fmtNum(act('registrations').total), recent('registrations')),
        tile('Renewals', fmtNum(act('renewals').total), recent('renewals')),
        tile('Sales', fmtNum(act('sales').total), `${kas(d.salesVolume)} in fixed-price sales`),
        tile('Offers made', fmtNum(act('offers').total), recent('offers')),
        tile('Listings', fmtNum(act('listings').total), recent('listings')),
        tile('Transfers', fmtNum(act('transfers').total), recent('transfers')),
        // What .kachat activity paid miners: network fees plus the registry's prices (paid as fee).
        d.fees
            ? tile('Paid to miners', kas(d.fees.total), d.fees.pending
                ? `${kas(d.fees.last7d)} this week, ${fmtNum(d.fees.pending)} older transactions still being added`
                : `${kas(d.fees.last24h)} today, ${kas(d.fees.last7d)} this week`)
            : '',
    ].join('');
    $('kd-stats-note').textContent = '';
    $('kd-stats-when').textContent = d.updatedAt ? `as of ${new Date(d.updatedAt).toLocaleTimeString()}` : '';
}

$('names-refresh')?.addEventListener('click', () => { loadNames().catch(() => {}); loadNamesStats().catch(() => {}); });
async function loadPush() {
    loadWebPush().catch(() => {});
    let d;
    try {
        d = await api('/api/push');
    } catch {
        return;
    }
    // The tab is web push only now: the Android/iPhone key forms are gone from the panel (any
    // keys saved earlier stay on disk and the indexer still uses them). The on/off control is
    // the sidebar switch (data-service="push"); here we only reflect its state.
    const tag = $('push-state');
    const pushOn = Boolean(d.pushEnabled);
    tag.textContent = pushOn ? 'on' : 'off';
    tag.className = pushOn ? 'tag ok' : 'tag off';
    // Device census is its own call so a slow/absent indexer never blocks the settings form.
    loadPushStats().catch(() => {});
}

/** Render the indexer's device-registry census (GET /api/push/stats), degrading gracefully. */
async function loadPushStats() {
    const dl = $('push-stats');
    const note = $('push-stats-note');
    if (!dl) return;
    let d;
    try {
        d = await api('/api/push/stats');
    } catch {
        d = { available: false, reason: 'offline' };
    }
    if (!d.available) {
        dl.innerHTML = '';
        note.textContent =
            d.reason === 'unsupported'
                ? 'Update the indexer to enable the device census (GET /push/stats).'
                : 'The indexer is not reachable right now, so start it to see the device census.';
        return;
    }
    // Push is web only: just the browsers. Phones registered before stay in the indexer's
    // records but get nothing any more, and its other counts (VoIP, KaPosts, primary address)
    // are totals over every device, so they would mislead here.
    const rows = [['Browsers registered', d.by_platform?.web ?? 0]];
    dl.innerHTML = rows
        .map(([k, v]) => `<div><dt>${escapeHtml(String(k))}</dt><dd>${escapeHtml(String(v))}</dd></div>`)
        .join('');
    note.textContent =
        'A live count of the browsers registered with the indexer for web push notifications.';
}

// ---- Web Push (the installed web app): one VAPID key per network ----

function webpushState(r) {
    if (r.live === 'on') return `<span class="good">on</span>, key served to browsers`;
    if (r.live === 'pending') return 'key stored; the indexer serves it after its next restart or update';
    if (r.live === 'offline') return r.keySet ? 'key stored; the indexer is not running' : 'the indexer is not running';
    if (r.live === 'error') return '<span class="bad">the indexer answered with an error</span>';
    return 'off: no key yet';
}

async function loadWebPush() {
    const box = $('webpush-rows');
    if (!box) return;
    const d = await api('/api/push/webpush');
    box.innerHTML = Object.entries(d.nets)
        .map(
            ([net, r]) =>
                `<tr><td>${escapeHtml(net)}</td><td>${webpushState(r)}</td>` +
                `<td><button type="button" class="ghost" data-webpush-setup="${net}" data-rotate="${r.keySet ? '1' : ''}">${r.keySet ? 'Rotate key' : 'Set up'}</button></td></tr>`,
        )
        .join('');
}

$('webpush-rows')?.addEventListener('click', async (event) => {
    const btn = event.target.closest('[data-webpush-setup]');
    if (!btn) return;
    const net = btn.dataset.webpushSetup;
    const rotate = btn.dataset.rotate === '1';
    if (
        rotate &&
        !(await askConfirm(
            `Rotate the ${net} Web Push key?\n\nEvery browser subscribed on ${net} stops getting pushes until it notices the new key and signs up again, which its app does by itself within a day.`,
        ))
    ) {
        return;
    }
    btn.disabled = true;
    try {
        const r = await api('/api/push/webpush/setup', { method: 'POST', body: { net, rotate } });
        kResult('webpush-result', r.applied === 'next start' ? `The ${net} key is stored. The indexer is not running; it reads the key when it starts.` : `The ${net} key is stored. The indexer is restarting to read it (System, Update Queue).`, false);
    } catch (e) {
        kResult('webpush-result', e.message, true);
    } finally {
        btn.disabled = false;
        loadWebPush().catch(() => {});
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
    setupState = { key, step: 1, plan: null, mode: 'new', newKind: 'fresh', domain: null };

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

    // The name field starts empty on purpose. In the prefix flow it asks only
    // for the part that goes in front of a name you already have, so a default
    // there would be a name to delete rather than a head start.
    $('setup-token-note').hidden = !info.duckdns?.hasToken;
    $('setup-token').placeholder = info.duckdns?.hasToken ? 'unchanged' : 'from duckdns.org';
    // The address is masked until its eye button is pressed (screen-recording safe).
    $('setup-ip').innerHTML = info.publicIp
        ? `This connection looks like ${privateValue(info.publicIp)} ${revealButton()} from the outside. DuckDNS will point the name here.`
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
                ? `${serviceLabel(d.usedBy)} is at the root, so give this one a name in front of it instead`
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
            (() => {
                // Two ways to get a name of its own, kept apart because they are
                // different jobs. A prefix in front of a name you already have --
                // kqs.kachat.duckdns.org -- needs nothing created at duckdns.org
                // and reuses the account already kept pointed here. A fresh name
                // is a brand-new account for something unrelated. With no account
                // yet only the fresh one makes sense, so that is all that shows.
                const acct = setupState.plan?.duckdns?.subdomain;
                const rows = [];
                if (acct) {
                    rows.push(`<label class="domain-choice">
        <input type="radio" name="setup-domain" value="" data-newkind="prefix" checked>
        <span><strong>Give it a name of its own</strong><small>use <code>${escapeHtml(acct)}.duckdns.org</code> with a name in front, like <code>kqs.${escapeHtml(acct)}.duckdns.org</code>. Nothing to add at duckdns.org.</small></span>
      </label>`);
                }
                rows.push(`<label class="domain-choice">
        <input type="radio" name="setup-domain" value="" data-newkind="fresh"${acct ? '' : ' checked'}>
        <span><strong>${acct ? 'Add a fresh DuckDNS name' : 'Create a free DuckDNS name'}</strong><small>${
            acct ? 'a brand-new name for something else, like <code>othername.duckdns.org</code>' : 'free, and kept pointed here for you'
        }</small></span>
      </label>`);
                return rows.join('');
            })(),
        );
}

$('setup-domain-list').addEventListener('click', async (event) => {
    const id = event.target.dataset?.domainDel;
    if (!id) return;
    const record = publishState.domains.find((d) => d.id === id);
    if (!await askConfirm(`Remove ${record?.domain}?\n\nNothing is published on it, so this only takes the name off the list.`)) return;
    try {
        await api(`/api/domains/${id}`, { method: 'DELETE' });
        await loadPublish();
        renderDomainChoices();
    } catch (e) {
        toast(e.message, 'bad');
    }
});

/**
 * The full DuckDNS name being entered, minus the .duckdns.org suffix. The
 * prefix flow's field holds only the part in front, so the account it sits
 * under -- fixed by the choice made on the first step -- is added back here.
 */
function enteredName() {
    const field = $('setup-subdomain').value.trim().toLowerCase().replace(/\.duckdns\.org\.?$/, '');
    if (setupState.newKind === 'prefix') {
        const acct = setupState.plan?.duckdns?.subdomain || '';
        return field && acct ? `${field}.${acct}` : '';
    }
    return field;
}

/**
 * The token step earns its place only when there is no token yet. A name in
 * front of one you already have, or a fresh name under the same account, both
 * ride the token already saved -- asking for it again is a step with one
 * possible answer, "leave it blank".
 */
const needsToken = () => setupState.mode === 'new' && !setupState.plan?.duckdns?.hasToken;

/** The name this run will publish on, whichever way it was chosen. */
const setupDomain = () =>
    setupState.mode === 'existing' ? setupState.domain : `${enteredName()}.duckdns.org`;

function renderSetupStep() {
    const { step, plan } = setupState;
    for (const section of document.querySelectorAll('#setup-form .setup-step')) {
        section.hidden = Number(section.dataset.step) !== step;
    }
    $('setup-back').hidden = step === (publishState.domains.length ? 0 : 1);
    $('setup-next').hidden = step === 3;
    $('setup-run').hidden = step !== 3;

    // Step 1 wears two faces: a prefix in front of a name you have, which asks
    // for just that prefix against a fixed suffix, and a fresh DuckDNS name,
    // which is the old create-it-first walkthrough.
    if (step === 1) {
        const prefix = setupState.newKind === 'prefix';
        const acct = setupState.plan?.duckdns?.subdomain || '';
        $('setup-step1-head').textContent = prefix ? 'Name it' : 'Create a free DuckDNS name';
        $('setup-create-steps').hidden = prefix;
        $('setup-step1-hint').hidden = prefix;
        $('setup-name-label').textContent = prefix ? 'Name in front' : 'Your name';
        $('setup-subdomain').placeholder = prefix ? 'kqs' : 'yournode';
        $('setup-suffix').textContent = prefix ? `.${acct}.duckdns.org` : '.duckdns.org';
        $('setup-step1-intro').innerHTML = prefix
            ? `Put a name in front of <code>${escapeHtml(acct)}.duckdns.org</code>. Type only the part that goes in front: <code>kqs</code> publishes on <code>kqs.${escapeHtml(acct)}.duckdns.org</code>. There is nothing to create at duckdns.org: <code>${escapeHtml(acct)}</code> is the account, and it is already kept pointed here. The certificate is issued over port 80.`
            : 'DuckDNS gives you a name like <code>yournode.duckdns.org</code> and keeps it pointed at this machine even when your home connection changes address. It is free and needs no card.';
    }

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
        const picked = document.querySelector('input[name="setup-domain"]:checked');
        const chosen = picked?.value ?? '';
        if (chosen) {
            // A name already here needs nothing else: no name to enter, no token
            // to save, the certificate issued without a contact address.
            setupState.mode = 'existing';
            setupState.domain = chosen;
            setupState.step = 3;
            renderSetupStep();
            return;
        }
        // The two ways to a name of its own. Either starts from an empty field,
        // because the prefix flow asks only for the part in front and a default
        // there is just something to clear.
        setupState.mode = 'new';
        setupState.newKind = picked?.dataset.newkind === 'prefix' ? 'prefix' : 'fresh';
        setupState.domain = null;
        $('setup-subdomain').value = '';
        setupState.step = 1;
        renderSetupStep();
        return;
    }

    if (step === 1) {
        // A name under the one you created is allowed: kqs.kachat publishes on
        // kqs.kachat.duckdns.org. In the prefix flow the field is just the part
        // in front, so the account is added before the name is checked.
        const prefix = setupState.newKind === 'prefix';
        if (prefix && !$('setup-subdomain').value.trim()) {
            return toast('Type the part that goes in front, like kqs.', 'bad');
        }
        if (!/^[a-z0-9-]{1,63}(\.[a-z0-9-]{1,63}){0,3}$/.test(enteredName())) {
            return toast(
                prefix ? 'That is not a valid name to put in front.' : 'Enter the name you created at duckdns.org, optionally with a name in front of it.',
                'bad',
            );
        }
        // The token step only exists when there is no token yet.
        setupState.step = needsToken() ? 2 : 3;
        renderSetupStep();
        return;
    }

    if (step === 2) {
        if (!$('setup-token').value.trim() && !setupState.plan?.duckdns?.hasToken) {
            return toast('Paste the token from duckdns.org.', 'bad');
        }
        setupState.step = 3;
        renderSetupStep();
        return;
    }
});

$('setup-back').addEventListener('click', () => {
    const { step, mode } = setupState;
    // Retrace the path forward took: from the plan, back to the token step only
    // if it was shown, otherwise to the name; an existing name skipped both and
    // lands on the list it was chosen from.
    if (step === 3) {
        setupState.step = mode === 'existing' ? 0 : needsToken() ? 2 : 1;
    } else if (step === 2) {
        setupState.step = 1;
    } else {
        setupState.step = publishState.domains.length ? 0 : 1;
    }
    renderSetupStep();
});

$('setup-auth').addEventListener('change', (event) => {
    $('setup-auth-fields').hidden = !event.target.checked;
});

$('setup-run').addEventListener('click', async () => {
    const { key, mode, domain } = setupState;
    const body = {
        domain: mode === 'existing' ? domain : undefined,
        subdomain: mode === 'existing' ? undefined : enteredName(),
        token: $('setup-token').value.trim(),
        auth: $('setup-auth').checked
            ? { enabled: true, user: $('setup-auth-user').value.trim(), password: $('setup-auth-pass').value }
            : { enabled: false },
        allowlist: $('setup-allowlist').value,
    };

    if (key === 'kaspad' && unsafeRpcOn()) {
        if (!await confirmUnsafeRpc("Publish the node's RPC (wRPC Borsh) while unsafe RPC calls are on?")) return;
    }
    $('setup-run').disabled = true;
    try {
        const r = await api(`/api/setup/${key}`, { method: 'POST', body });
        $('setup-dialog').close();
        // The job console is where every long job in this panel reports, and
        // this one has more to say than a toast can hold.
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

// Same action as "Re-apply nginx config" above, given its own tab so it is easy
// to find after an update: rewrite every domain's vhost from the current code
// and reload nginx, which is what makes a generator change (new headers, new
// routing) reach the live domains.
$('proxy-restart-btn').addEventListener('click', async () => {
    const btn = $('proxy-restart-btn');
    const err = $('proxy-restart-error');
    err.hidden = true;
    btn.disabled = true;
    const was = btn.textContent;
    btn.textContent = 'Restarting…';
    try {
        await api('/api/proxy/reload', { method: 'POST' });
        toast('All domains restarted: nginx configuration rewritten and reloaded.', 'good');
    } catch (e) {
        err.textContent = e.message;
        err.hidden = false;
    } finally {
        btn.disabled = false;
        btn.textContent = was;
    }
});

$('proxy-renew').addEventListener('click', async () => {
    try {
        await api('/api/proxy/renew', { method: 'POST' });
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

    if (RPC_PROXY_KINDS.has(payload.target.kind) && payload.enabled && unsafeRpcOn()) {
        if (!await confirmUnsafeRpc(`Publish the node's RPC on ${payload.domain || 'this name'} while unsafe RPC calls are on?`)) return;
    }
    try {
        if (editingId) await api(`/api/proxies/${editingId}`, { method: 'PUT', body: { proxy: payload } });
        else await api('/api/proxies', { method: 'POST', body: { proxy: payload } });

        $('proxy-dialog').close();
        await loadProxies();
        toast('Proxy host saved.', 'good');

        // A brand new https host has no certificate yet; offer to fetch it now.
        const saved = proxies.find((p) => p.domain === payload.domain);
        if (saved && payload.ssl.mode === 'letsencrypt' && !saved.certificate) {
            if (await askConfirm(`Request a Let's Encrypt certificate for ${payload.domain} now?`)) {
                await requestCertificate(saved.id, payload.domain, { email: payload.ssl.email, staging: $('px-staging').checked });
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
        if (r.refused?.length) {
            toast(`Updated ${r.domains.join(', ')}. DuckDNS refused ${r.refused.join(', ')}: that name is likely on another duckdns.org account (different token).`, 'bad');
        } else {
            toast(`Updated ${r.domains.join(', ')}`, 'good');
        }
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


// None of these is a service, so their dots stay hollow rather than implying a
// state they cannot have.
setNavHealth('logs', 'none');
setNavHealth('queue', 'none');
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
        <button type="button" data-expand="${key}" title="Expand this one to full width" aria-label="Expand">⤢</button>
        <button type="button" class="tile-reset" data-clear="${key}" title="Clear this log">Reset</button>
        <button type="button" class="tile-close" data-close="${key}" title="Close the expanded view" aria-label="Close">✕</button>
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
        const up = containers.filter((c) => c.running !== false).length;
        // A stopped container still has a log worth reading -- usually the one
        // that says why it stopped -- so it keeps its tile and the count says
        // how many of them are actually running.
        $('logs-note').textContent = containers.length
            ? `${containers.length} container${containers.length === 1 ? '' : 's'}, ${up} running`
            : '';
        // The tiles are about to be replaced, so anything lifted over them is
        // gone too; leaving the scrim would dim the page with nothing on top.
        closeLogOverlay();
        // The panel's own jobs first: installs, certificates, restarts. It is
        // the log somebody is looking for after something went wrong, and it
        // exists whether or not any container does.
        grid.innerHTML =
            logTile(JOB_LOG_KEY, 'Panel jobs') +
            (containers.length
                ? containers.map((c) => logTile(c.key, c.label)).join('')
                : '<p class="empty-tile">Nothing is installed yet, so there are no container logs. The panel\'s own log is above.</p>');
        logBuffers.set(JOB_LOG_KEY, [...jobLog]);
        renderLogTile(JOB_LOG_KEY);
        for (const c of containers) {
            logBuffers.set(c.key, []);
            // The tile was just recreated, so its stored size needs reapplying.
            restoreLogSize(`tile:${c.key}`);
            const dot = document.querySelector(`[data-tiledot="${c.key}"]`);
            if (dot) dot.className = `dot ${c.running === false ? 'off' : 'ok'}`;
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
    const close = event.target.dataset?.close;
    if (close) {
        // The X closes the expanded overlay; clearing a log is the "Reset" button.
        closeLogOverlay();
    } else if (expand) {
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
/** What is waiting, now that there is no console head to put it in. */
let lastQueueNote = '';
function renderQueue(pending) {
    // Queued updates have their own page; this is for what waits behind an overlay.
    const list = (pending ?? []).filter((j) => !j.queued);
    const note = list.length ? `then: ${list.map((j) => j.name).join(', ')}` : '';
    // Only when it changes: this runs on every job event, and a toast repeating
    // itself is worse than no toast at all.
    if (note && note !== lastQueueNote) toast(note);
    lastQueueNote = note;
}

const refreshQueueSoon = debounce(async () => {
    try {
        const { job } = await api('/api/jobs/current');
        renderQueue(job?.pending);
    } catch {
        /* the console is cosmetic */
    }
}, 250);

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

/**
 * Everything the panel's own jobs have printed this session.
 *
 * Kept whether or not the logs tab is open, because the interesting moment for
 * a job log is usually after it has finished: something did not work and the
 * question is what it said. This is the panel's own log, sitting beside the
 * containers' logs, which is where somebody looks for it.
 */
const JOB_LOG_KEY = 'panel-jobs';
const jobLog = [];

function pushJobLine(line) {
    jobLog.push(line);
    if (jobLog.length > LOG_TILE_LINES) jobLog.splice(0, jobLog.length - LOG_TILE_LINES);

    const buf = logBuffers.get(JOB_LOG_KEY);
    if (!buf) return;
    buf.push(line);
    if (buf.length > LOG_TILE_LINES) buf.splice(0, buf.length - LOG_TILE_LINES);
    renderLogTile(JOB_LOG_KEY);
}

/**
 * A job that this page is not already watching -- because it was started before
 * the page loaded, or queued behind the one that just finished.
 *
 * Refreshing the browser during a half-hour rebuild used to lose it entirely:
 * the job carried on in the manager, the page came back with no overlay and an
 * Update button that looked ready, and pressing it queued a second rebuild
 * behind the first. The work is on the server and always was; only the window
 * onto it was tied to the page.
 */
function adoptRunningJob(job, note) {
    // Watching something of our own that has not finished. That one wins.
    if (pendingAction && !pendingAction.finished) return;
    // Closed by hand once already. The job stream re-sends its snapshot every
    // time it reconnects, and a dropped connection is not a reason to put an
    // overlay back over somebody who has read it and moved on.
    if (dismissedJobs.has(job.id)) return;
    if (pendingAction) closeAction();

    const action = openAction({ key: null, title: job.name, note });
    // Elapsed from when the job really started, not from when this page noticed.
    const began = Date.parse(job.startedAt ?? '');
    if (!Number.isNaN(began)) action.startedAt = began;

    // Replaying what it has printed also puts the progress bar where it belongs.
    for (const line of job.lines ?? []) actionAppend(line);
    adoptActionJob(job.id);
    tickElapsed();
}

function connectJobs() {
    jobStream?.close();
    jobStream = new EventSource('/api/jobs/stream');
    // A job already running when this page loaded: what it has printed so far
    // goes into the panel's log, so opening All logs shows it rather than
    // starting from the next line.
    jobStream.addEventListener('snapshot', (event) => {
        const job = JSON.parse(event.data);
        loadUpdateQueue();
        if (job.status !== 'running') return;
        for (const line of job.lines ?? []) pushJobLine(line);
        // Queued updates are watched on the Update Queue page, never in the overlay.
        if (job.queued) return;
        renderQueue(job.pending);
        adoptRunningJob(
            job,
            'This was already running when the page loaded. It runs in the manager, not in the browser, so refreshing or closing the tab never interrupted it.',
        );
    });
    jobStream.addEventListener('start', (event) => {
        const job = JSON.parse(event.data);
        loadUpdateQueue();
        pushJobLine(`\n> ${job.name}`);
        if (job.queued) {
            // The popup is the notice for a job this page just sent; a job started from
            // elsewhere (another browser, a reload) still gets a word.
            if (queuePeek.is(job.id)) queuePeek.state('running');
            else if (!pendingAction && !queueActionsInFlight) toast(`${job.name}: started (System, Update Queue)`);
            return;
        }
        renderQueue(job.pending);

        // The overlay is open on a job that has finished, and another was
        // waiting behind it. Follow that one rather than leaving it to run with
        // nothing on screen -- which is the same hole a refresh used to open.
        if (pendingAction?.finished) {
            return adoptRunningJob({ ...job, lines: [], startedAt: null }, 'This was queued behind the one that just finished.');
        }
        // Nothing pops up any more, so a job with no log of its own on screen
        // says once that it has started.
        if (!inlineJobHandles(job.name) && !pendingAction) toast(`${job.name}…`);
    });
    // Something was accepted but has not started. Saying so is the difference
    // between a queue and a click that appeared to do nothing.
    jobStream.addEventListener('queued', (event) => {
        const job = JSON.parse(event.data);
        loadUpdateQueue();
        // queueAction has already said where it went.
        if (job.queued) return;
        if (job.ahead === 0 && !job.running) return;
        const waiting = `Waiting for ${job.running ?? 'the job running now'} to finish first.`;
        // If this is the overlay's own job, it belongs in its log rather than
        // in a toast behind it. It has no id yet, so it goes in the same place
        // as any other line that arrived early.
        if (pendingAction) actionLine(job.id, waiting);
        else toast(`${job.name}: queued behind ${job.running ?? 'the job running now'}`);
        refreshQueueSoon();
    });
    jobStream.addEventListener('line', (event) => {
        const { line, jobId } = JSON.parse(event.data);
        pushJobLine(line);
        updateQueueLine(jobId, line);
        queuePeek.line(jobId, line);
        // The overlay shows the action it started; a tab watching its own job
        // shows that one. Everything is in All logs either way.
        actionLine(jobId, line);
        if (inlineJob) appendInline(line);
    });
    jobStream.addEventListener('end', (event) => {
        const job = JSON.parse(event.data);
        loadUpdateQueue();
        queuePeek.ended(job);
        settleQueueJob(job);
        if (!job.queued) renderQueue(job.pending);
        const wasOurs = pendingAction?.jobId === job.id;
        actionJobEnded(job);
        // Whether a service exists changes when a job finishes, and nothing
        // else tells the page that. Without this the Install overlay sat there
        // for up to ten seconds after the log had already said Done.
        loadServices().catch(() => {});

        // The overlay has already said how it went, in front of everything.
        if (wasOurs) {
            refreshStatus();
            return;
        }

        if (inlineJob) {
            appendInline(job.status === 'succeeded' ? '\n✓ Done.' : `\n✗ Failed: ${job.error}`);
            inlineJob.onEnd?.(job);
            inlineJob = null;
            refreshStatus();
            return;
        }
        toast(
            { succeeded: `${job.name}: done`, cancelled: `${job.name}: cancelled` }[job.status] ?? `${job.name}: failed`,
            { succeeded: 'good', cancelled: '' }[job.status] ?? 'bad',
        );
        refreshStatus();
        loadProxies();
        loadMining();
        loadApps();
        loadKassigner();
    });
}

// ------------------------------------------------------------- queue peek ---

/**
 * The small popup after an Update, Rebuild, Install or a switch: the job's name, whether it
 * started or is waiting, and its first log lines as they arrive. It hides itself five seconds
 * after the last thing it had to show (at most twelve in all), stays while the pointer is on
 * it, and opens the Update Queue when clicked. Not shown on the Update Queue page itself,
 * where the same is already on screen.
 */
const queuePeek = (() => {
    const PEEK_AFTER_MS = 5000;
    const PEEK_MAX_MS = 12_000;
    let jobId = null;
    let timer = null;
    let shownAt = 0;
    let hovering = false;
    const box = () => $('queue-peek');

    // Five seconds from the last thing it had to say, never past twelve from when it opened;
    // under the pointer it waits, a second at a time, and goes as soon as the pointer leaves.
    function arm() {
        clearTimeout(timer);
        const remaining = shownAt + PEEK_MAX_MS - Date.now();
        if (remaining <= 0) return hovering ? wait() : hide();
        timer = setTimeout(() => (hovering ? wait() : hide()), Math.min(PEEK_AFTER_MS, remaining));
    }
    function wait() {
        clearTimeout(timer);
        timer = setTimeout(() => (hovering ? wait() : hide()), 1000);
    }
    function hide() {
        clearTimeout(timer);
        timer = null;
        jobId = null;
        box()?.setAttribute('hidden', '');
    }
    function show(id, title, state) {
        const el = box();
        if (!el || $('tab-queue')?.classList.contains('active')) return;
        jobId = id;
        shownAt = Date.now();
        $('queue-peek-title').textContent = title;
        $('queue-peek-state').textContent = state;
        $('queue-peek-log').textContent = '';
        el.removeAttribute('hidden');
        arm();
    }
    const is = (id) => jobId !== null && jobId === id;
    function state(text) {
        if (!jobId) return;
        $('queue-peek-state').textContent = text;
        arm();
    }
    function line(id, text) {
        if (!is(id)) return;
        // Lines mean it runs, whatever the stream's start event said or when it came.
        const st = $('queue-peek-state');
        if (st.textContent === 'starting' || st.textContent.startsWith('waiting')) st.textContent = 'running';
        const log = $('queue-peek-log');
        log.textContent += `${text}\n`;
        log.scrollTop = log.scrollHeight;
        // Lines do not keep it open: a build logs for minutes, and this is a glance.
    }
    function ended(job) {
        if (!is(job.id)) return;
        state({ succeeded: 'done', cancelled: 'cancelled' }[job.status] ?? `failed: ${job.error ?? ''}`);
    }
    const el = box();
    el?.addEventListener('mouseenter', () => (hovering = true));
    el?.addEventListener('mouseleave', () => {
        hovering = false;
        arm();
    });
    el?.addEventListener('click', () => {
        hide();
        selectTab('queue');
    });
    return { show, is, state, line, ended, hide };
})();

// ------------------------------------------------------------ update queue ---

/**
 * System, Update Queue: what the manager is doing, one job at a time, and what
 * it will do next. The job running now shows its log as it arrives and how long
 * it has been going; the ones waiting can be taken out of the line; the last ten
 * finished keep their logs for when something went wrong.
 *
 * Every job is listed, not only updates: there is one line for all of them, and
 * a Restart asked for during a rebuild waits behind it like anything else.
 */
let updateQueue = { current: null, pending: [], history: [] };
let updateQueueTimer = null;
const updateQueueOpen = new Set();

function queueClock(ms) {
    const seconds = Math.max(0, Math.round(ms / 1000));
    if (seconds < 60) return `${seconds}s`;
    const minutes = Math.floor(seconds / 60);
    if (minutes < 60) return `${minutes}m ${String(seconds % 60).padStart(2, '0')}s`;
    return `${Math.floor(minutes / 60)}h ${String(minutes % 60).padStart(2, '0')}m`;
}

function queueSince(iso) {
    const t = Date.parse(iso ?? '');
    return Number.isNaN(t) ? null : t;
}

const loadUpdateQueue = debounce(async () => {
    try {
        updateQueue = await api('/api/jobs/queue');
    } catch {
        return;
    }
    for (const job of updateQueue.history ?? []) {
        if (queueEnds.has(job.id)) settleQueueJob(job);
    }
    renderUpdateQueue();
}, 200);

function renderUpdateQueueCount() {
    const count = (updateQueue.current ? 1 : 0) + updateQueue.pending.length;
    const badge = $('queue-count');
    if (badge) {
        badge.hidden = count === 0;
        badge.textContent = String(count);
    }
    setNavHealth('queue', updateQueue.current ? 'warn' : 'none');
}

function renderUpdateQueue() {
    renderUpdateQueueCount();
    if (!$('tab-queue')?.classList.contains('active')) return;

    const cur = updateQueue.current;
    $('queue-current-empty').hidden = Boolean(cur);
    $('queue-current').hidden = !cur;
    if (cur) {
        const card = $('queue-current');
        if (card.dataset.job !== cur.id) {
            card.dataset.job = cur.id;
            $('queue-current-name').textContent = cur.name;
            const log = $('queue-current-log');
            log.textContent = (cur.lines ?? []).join('\n') + '\n';
            log.scrollTop = log.scrollHeight;
            const cancel = $('queue-current-cancel');
            cancel.hidden = cur.noCancel === true;
            cancel.disabled = false;
            cancel.textContent = 'Cancel';
        }
        tickUpdateQueue();
    } else {
        $('queue-current').dataset.job = '';
    }

    const waiting = $('queue-pending');
    $('queue-pending-empty').hidden = updateQueue.pending.length > 0;
    waiting.innerHTML = updateQueue.pending
        .map(
            (j, i) =>
                `<li class="queue-row"><span class="queue-pos">${i + 1}</span>` +
                `<span class="queue-name">${escapeHtml(j.name)}</span>` +
                `<span class="muted queue-when" data-since="${escapeHtml(j.queuedAt ?? '')}"></span>` +
                `<button class="ghost" data-queue-cancel="${escapeHtml(j.id)}">Remove</button></li>`,
        )
        .join('');

    const done = $('queue-history');
    $('queue-history-empty').hidden = updateQueue.history.length > 0;
    done.innerHTML = updateQueue.history
        .map((j) => {
            const took = queueSince(j.finishedAt) && queueSince(j.startedAt) ? queueClock(queueSince(j.finishedAt) - queueSince(j.startedAt)) : '';
            const label = { succeeded: 'done', failed: 'failed', cancelled: 'cancelled' }[j.status] ?? j.status;
            const tone = { succeeded: 'good', failed: 'bad' }[j.status] ?? '';
            const when = queueSince(j.finishedAt) ? new Date(queueSince(j.finishedAt)).toLocaleString() : '';
            const open = updateQueueOpen.has(j.id);
            return (
                `<li class="queue-done"><button class="queue-done-head" data-queue-open="${escapeHtml(j.id)}">` +
                `<span class="queue-status ${tone}">${escapeHtml(label)}</span>` +
                `<span class="queue-name">${escapeHtml(j.name)}</span>` +
                `<span class="muted">${escapeHtml(took ? `took ${took}` : '')}</span>` +
                `<span class="muted">${escapeHtml(when)}</span></button>` +
                (open ? `<pre class="queue-log">${escapeHtml((j.lines ?? []).join('\n'))}</pre>` : '') +
                `</li>`
            );
        })
        .join('');
    tickUpdateQueue();
}

/** The clocks: how long the running job has been going, how long each waiting one has waited. */
function tickUpdateQueue() {
    const cur = updateQueue.current;
    const began = queueSince(cur?.startedAt);
    if (began) $('queue-current-elapsed').textContent = `Running for ${queueClock(Date.now() - began)}`;
    for (const node of document.querySelectorAll('#queue-pending [data-since]')) {
        const at = queueSince(node.dataset.since);
        node.textContent = at ? `waiting ${queueClock(Date.now() - at)}` : '';
    }
}

/** A line from the job stream, for the running job's log on the queue page. */
function updateQueueLine(jobId, line) {
    const cur = updateQueue.current;
    if (!cur || cur.id !== jobId) return;
    (cur.lines ??= []).push(line);
    if (cur.lines.length > 2000) cur.lines.shift();
    if (!$('tab-queue')?.classList.contains('active') || $('queue-current').dataset.job !== jobId) return;
    const log = $('queue-current-log');
    const atBottom = log.scrollHeight - log.scrollTop - log.clientHeight < 40;
    log.textContent += `${line}\n`;
    if (atBottom) log.scrollTop = log.scrollHeight;
}

function setUpdateQueueView(on) {
    clearInterval(updateQueueTimer);
    updateQueueTimer = null;
    if (!on) return;
    $('queue-current').dataset.job = '';
    loadUpdateQueue();
    updateQueueTimer = setInterval(() => {
        if (!$('tab-queue')?.classList.contains('active')) return setUpdateQueueView(false);
        tickUpdateQueue();
    }, 1000);
}

async function cancelQueuedJob(id, name, running) {
    const question = running
        ? `Cancel "${name}"?\n\nWhatever it has already done stays done: this stops it where it is rather than undoing it. A build keeps the parts it finished, so starting again does not start from the beginning.`
        : `Take "${name}" out of the queue?\n\nIt has not started, so nothing has changed yet.`;
    if (!(await askConfirm(question))) return false;
    try {
        await api(`/api/jobs/${id}/cancel`, { method: 'POST' });
        return true;
    } catch (e) {
        toast(e.message, 'bad');
        return false;
    } finally {
        loadUpdateQueue();
    }
}

$('queue-current-cancel')?.addEventListener('click', async () => {
    const cur = updateQueue.current;
    if (!cur) return;
    const button = $('queue-current-cancel');
    if (await cancelQueuedJob(cur.id, cur.name, true)) {
        button.disabled = true;
        button.textContent = 'Cancelling…';
    }
});

$('queue-pending')?.addEventListener('click', (event) => {
    const id = event.target.closest('[data-queue-cancel]')?.dataset.queueCancel;
    const job = updateQueue.pending.find((j) => j.id === id);
    if (job) cancelQueuedJob(job.id, job.name, false);
});

$('queue-history')?.addEventListener('click', (event) => {
    const id = event.target.closest('[data-queue-open]')?.dataset.queueOpen;
    if (!id) return;
    if (updateQueueOpen.has(id)) updateQueueOpen.delete(id);
    else updateQueueOpen.add(id);
    renderUpdateQueue();
});

// ------------------------------------------------------------------- boot ---

// Which services exist at all, which decides whether each row shows a button or
// a switch. Refreshed alongside the status poll so an install or an uninstall
// finishing is reflected without a reload.
// Ten seconds, not thirty: this is now the only thing that writes the switches,
// so how stale it is, is how stale they are.
// Only while the panel itself is on screen: before sign-in (or before the first password is
// set) every request answers 401, and polling would only bounce the auth screens around.
const loadServicesPoll = noOverlap(() => loadServices());
setInterval(() => {
    if (!$('app').classList.contains('hidden')) loadServicesPoll().catch(() => {});
}, 10_000);

api('/api/session')
    .then((s) => {
        if (s.panelVersion) $('version-badge').textContent = `v${s.panelVersion}`;
        panelAccess = { viaProxy: Boolean(s.viaProxy), directUrl: s.directUrl || '' };
        renderPasswordCard(!s.needsSetup);
        if (s.passwordUnusable) {
            // No password will be accepted, so say that rather than let someone
            // retype a correct one until they give up.
            const note = $('login-error');
            note.hidden = false;
            note.textContent =
                'The stored password cannot be read, so none will be accepted. It was truncated by an old bug in how the hash was saved. Clear ADMIN_PASSWORD_HASH in the .env file in your install directory, recreate the panel container, and set a new password.';
        }
        // A password is always required (KQS-001): with none set, the only thing
        // the panel shows is the screen to set one.
        needsSetup = Boolean(s.needsSetup);
        if (s.needsSetup) {
            showFirstRun();
        } else if (s.authenticated) {
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
        ? 'A password is required to open this panel. Change it below; it cannot be removed, because the panel controls Docker on this machine.'
        : 'No password is set yet.';
    $('password-current-row').hidden = !isSet;
    $('password-save').textContent = isSet ? 'Change it' : 'Set a password';
}

/**
 * Waits for the panel to go away and come back, then reloads. The restart is
 * done by a detached container a second or two after the request returns, so
 * "still answering" does not yet mean "finished".
 */
$('signout-all')?.addEventListener('click', async () => {
    if (!(await askConfirm('Sign out every browser that is signed in to this panel? This one stays signed in.'))) return;
    try {
        await api('/api/auth/signout-all', { method: 'POST' });
        kResult('signout-all-result', 'Every other session is signed out.', false);
    } catch (e) {
        kResult('signout-all-result', e.message, true);
    }
});

async function waitForPanelRestart(note, resultId = 'password-result') {
    const deadline = Date.now() + 120_000;
    let wentDown = false;
    kResult(resultId, note, false);

    while (Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 1500));
        try {
            const res = await fetch('/healthz', { cache: 'no-store' });
            if (res.ok && wentDown) return location.reload();
        } catch {
            wentDown = true;
        }
    }
    kResult(resultId, 'The panel has not come back. Check `docker logs kaspa-node-manager`.', true);
}

// Eye toggles on password fields: show what is being typed, then hide it again.
const EYE_OPEN =
    '<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M1 12s4-7 11-7 11 7 11 7-4 7-11 7S1 12 1 12z"/><circle cx="12" cy="12" r="3"/></svg>';
const EYE_SHUT =
    '<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17.94 17.94A10.94 10.94 0 0 1 12 19c-7 0-11-7-11-7a20.3 20.3 0 0 1 5.06-5.94"/><path d="M9.9 4.24A10.4 10.4 0 0 1 12 4c7 0 11 7 11 7a20.4 20.4 0 0 1-2.16 3.19"/><path d="M14.12 14.12a3 3 0 1 1-4.24-4.24"/><line x1="1" y1="1" x2="23" y2="23"/></svg>';
for (const btn of document.querySelectorAll('[data-pw-toggle]')) btn.innerHTML = EYE_OPEN;
document.addEventListener('click', (event) => {
    const btn = event.target.closest?.('[data-pw-toggle]');
    if (!btn) return;
    const input = document.getElementById(btn.dataset.pwToggle);
    if (!input) return;
    const show = input.type === 'password';
    input.type = show ? 'text' : 'password';
    btn.innerHTML = show ? EYE_SHUT : EYE_OPEN;
    const label = show ? 'Hide password' : 'Show password';
    btn.setAttribute('aria-label', label);
    btn.setAttribute('aria-pressed', show ? 'true' : 'false');
    btn.title = label;
});

// Hide every revealed password again once it has been used, so it is not left on screen.
function hidePasswords() {
    for (const btn of document.querySelectorAll('[data-pw-toggle]')) {
        const input = document.getElementById(btn.dataset.pwToggle);
        if (input) input.type = 'password';
        btn.innerHTML = EYE_OPEN;
        btn.setAttribute('aria-label', 'Show password');
        btn.setAttribute('aria-pressed', 'false');
        btn.title = 'Show password';
    }
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
        hidePasswords();
        // In force immediately (auth reads .env live) and the response refreshed
        // the session, so no restart to wait on.
        kResult('password-result', 'Password saved. It is in force now.', false);
        $('password-save').disabled = false;
    } catch (e) {
        toast(e.message, 'bad');
        $('password-save').disabled = false;
    }
});

$('panel-port-save').addEventListener('click', async () => {
    const port = Number($('panel-port').value);
    // The restart would kill the running job and lose the queue (KQS-033).
    if (await panelUpdateBlockedByQueue('Moving the panel to another port')) return;
    if (!await askConfirm(`Move this panel to port ${port}?\n\nIt restarts, and this page will follow it to the new address. Anything you have bookmarked stops working.`)) return;

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

$('panel-lan')?.addEventListener('change', async (event) => {
    const lan = event.target.checked;
    // The restart would kill the running job and lose the queue (KQS-033).
    if (await panelUpdateBlockedByQueue('Changing who can open the panel')) {
        event.target.checked = !lan;
        return;
    }
    const ok = await askConfirm(
        lan
            ? 'Let other machines on your network open this panel?\n\nThe panel restarts; the node and every app keep running (the Update Queue must be empty, since a restart would lose it). The panel speaks plain HTTP, so your password crosses the network unencrypted: only do this on a network you trust, and never on a server whose port faces the internet. For remote access use Proxy & domains (HTTPS) or an SSH tunnel.'
            : 'Limit the panel to this machine only?\n\nIt restarts. Afterwards it opens only at http://localhost on the server itself.',
    );
    if (!ok) {
        event.target.checked = !lan;
        return;
    }
    event.target.disabled = true;
    try {
        const r = await api('/api/panel/bind', { method: 'POST', body: { lan } });
        if (r.unchanged) return;
        const onThisMachine = ['localhost', '127.0.0.1', '::1', '[::1]'].includes(location.hostname);
        if (!lan && !onThisMachine) {
            // This address stops answering; the panel is now only on the server itself.
            kResult('panel-lan-result', 'Done. The panel now answers only on the server itself (http://localhost).', false);
            return;
        }
        await waitForPanelRestart('Restarting the panel with the new address…', 'panel-lan-result');
    } catch (e) {
        event.target.checked = !lan;
        toast(e.message, 'bad');
    } finally {
        event.target.disabled = false;
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
    // Update panel keeps you on the branch you are on (System > Experimental changes it).
    if (r.panelRef && $('global-ref') && !$('global-ref').dataset.touched) $('global-ref').value = r.panelRef;
    showPanelBranch(r.panelRef);
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
    const el = $('global-check-status');
    setUpdateStatus(el, 'checking', 'Checking…');
    try {
        const q = new URLSearchParams({ repo, ref });
        const r = await api(`/api/system/panel-latest?${q}`);
        const when = r.latest.date ? new Date(r.latest.date).toLocaleString() : 'unknown date';
        if (r.upToDate === true) {
            setUpdateStatus(el, 'current', `Up to date: ${ref} is at ${r.latest.shortSha}, ${when}.`);
        } else if (r.upToDate === false) {
            const behind = r.compare?.behind ? `, ${r.compare.behind} commit${r.compare.behind === 1 ? '' : 's'} ahead of yours` : '';
            setUpdateStatus(el, 'available', `Update available: ${r.latest.shortSha}${behind}. ${r.latest.message}`);
        } else {
            // No recorded sha, which is every install that has not used this
            // button yet. Saying "up to date" here would be a guess.
            setUpdateStatus(el, 'info', `${ref} is at ${r.latest.shortSha} (${when}). This install has no recorded commit, so there is nothing to compare it against yet.`);
        }
    } catch (e) {
        setUpdateStatus(el, 'error', e.message);
    } finally {
        button.disabled = false;
    }
});

/**
 * Updating the panel recreates the manager, which would stop the job running and lose
 * everything waiting in the Update Queue, so the manager refuses while it is not empty
 * (KQS-032). Asked first here, so the answer is "wait" with a way to the queue, not an error.
 * True when the queue is busy (and the person has been told).
 */
async function panelUpdateBlockedByQueue(what = 'Updating the panel') {
    let q;
    try {
        q = await api('/api/jobs/queue');
    } catch {
        return false; // the manager answers for itself if it is busy
    }
    const names = [...(q.current ? [q.current.name] : []), ...(q.pending ?? []).map((j) => j.name)];
    if (!names.length) return false;
    const open = await askConfirm(
        `Wait for the Update Queue first\n\n${what} restarts the panel, which would stop what is running and lose what is waiting:\n\n• ${names.join('\n• ')}\n\nOpen the Update Queue? Try again once it is empty.`,
    );
    if (open) selectTab('queue');
    return true;
}

$('global-update-btn').addEventListener('click', async () => {
    const button = $('global-update-btn');
    const repo = $('global-repo').value.trim();
    const ref = $('global-ref').value.trim();
    if (await panelUpdateBlockedByQueue()) return;
    if (!await askConfirm(`Update the panel from ${repo}@${ref}?\n\nIt will go offline for a minute or two while it rebuilds. The node keeps running.`)) return;

    button.disabled = true;
    try {
        // Baseline, so a previous failed update is not mistaken for this one's.
        const baseAt = await api('/api/system').then((s) => s.lastUpdate?.at ?? null).catch(() => null);
        await api('/api/system/panel-update', { method: 'POST', body: { repo, ref } });
        kResult('global-update-result', 'Rebuilding. Watch the log; this page reloads itself when the new panel is up.');
        showPanelUpdateOverlay(repo, ref, baseAt);
    } catch (e) {
        kResult('global-update-result', e.message, true);
        button.disabled = false;
    }
});

/**
 * The panel update is a detached sidecar, not a job, so it does not ride the
 * normal job overlay. This drives the same overlay box by hand: it streams the
 * sidecar's log live, then watches for the panel to drop out for the rebuild
 * and come back, at which point it reloads onto the new version. A build that
 * fails leaves the old panel running, which the status file reports, so that
 * path offers a way out instead of waiting forever.
 */
function showPanelUpdateOverlay(repo, ref, baseAt) {
    const log = $('action-log');
    const close = $('action-close');
    // A finished sentinel keeps the job-stream handlers out of this overlay and
    // lets the shared Close button work without the job machinery.
    pendingAction = { finished: true, jobId: null, resolve() {} };

    $('action-title').textContent = `Updating the panel from ${repo}@${ref}`;
    $('action-note').textContent =
        'The page drops out while it rebuilds, then reloads itself when the new panel is up. Your node keeps running.';
    log.textContent = '';
    $('action-spinner').hidden = false;
    $('action-cancel').hidden = true;
    close.hidden = true;
    close.disabled = true;
    $('action-bar').className = 'action-bar';
    $('action-bar-fill').style.width = '';
    $('action-overlay').hidden = false;

    const append = (line) => {
        const atBottom = log.scrollHeight - log.scrollTop - log.clientHeight < 40;
        log.textContent += `${line}\n`;
        if (atBottom) log.scrollTop = log.scrollHeight;
    };
    append('> Starting the update...');

    // Live output from the sidecar. It outlives this manager, so the stream just
    // goes quiet when the panel is replaced; healthz is what confirms the end.
    let stream = null;
    try {
        stream = new EventSource('/api/logs/stream?container=panel-update');
        stream.addEventListener('line', (ev) => {
            try {
                append(JSON.parse(ev.data).line);
            } catch {
                /* ignore a malformed frame */
            }
        });
        stream.onerror = () => {}; // expected the moment the panel restarts
    } catch {
        /* no live log; the healthz watch below still finishes the job */
    }

    const stopStream = () => {
        try {
            stream?.close();
        } catch {
            /* already closed */
        }
    };

    const finish = ({ failed, message } = {}) => {
        stopStream();
        if (message) append(message);
        $('action-spinner').hidden = true;
        $('action-bar').className = `action-bar${failed ? ' failed' : ''}`;
        $('action-bar-fill').style.width = '100%';
        close.hidden = false;
        close.disabled = false;
        close.focus();
        $('global-update-btn').disabled = false;
    };

    const deadline = Date.now() + 10 * 60_000;
    let wentDown = false;

    const tick = async () => {
        try {
            const res = await fetch('/healthz', { cache: 'no-store' });
            if (res.ok && wentDown) {
                append('\nThe new panel is up. Reloading...');
                stopStream();
                return location.reload();
            }
        } catch {
            wentDown = true;
        }

        // A failed build never takes the panel down, so the old one keeps
        // answering. Its result lands in the status file.
        if (!wentDown) {
            const last = await api('/api/system').then((s) => s.lastUpdate).catch(() => null);
            if (last && last.at !== baseAt && last.result === 'fail') {
                return finish({ failed: true, message: `\nThe update did not finish: ${last.error || 'the build failed. Your old panel is still running.'}` });
            }
        }

        if (Date.now() > deadline) {
            return finish({
                failed: true,
                message: '\nThe panel has not come back after ten minutes. The log above shows how far it got.',
            });
        }
        setTimeout(tick, 2500);
    };
    setTimeout(tick, 3000);
}

// Nothing else in the panel is guarded like this, because nothing else deletes
// the node, its chain data and the panel in one go.
const TEARDOWN_PHRASE = 'DELETE EVERYTHING';

$('global-teardown-confirm').addEventListener('input', (event) => {
    $('global-teardown-btn').disabled = event.target.value.trim() !== TEARDOWN_PHRASE;
});

$('global-teardown-btn').addEventListener('click', async () => {
    if (!await askConfirm('Remove the node, all its data and this panel?\n\nThis cannot be undone. Docker itself stays installed.')) return;

    $('global-teardown-btn').disabled = true;
    const job = await runAction({
        key: null,
        title: 'Removing everything',
        note:
            'Every container, image, volume and file this stack created, including this panel. ' +
            'It cannot be cancelled: half a teardown leaves a stack with nothing left to finish taking it apart.',
        cancellable: false,
        terminal: true,
        request: () => api('/api/system/teardown', { method: 'POST', body: { confirm: TEARDOWN_PHRASE } }),
    });
    // Only reached when it never started -- the phrase was wrong, or docker
    // refused to launch the container that does the removing.
    if (!job?.ok) $('global-teardown-btn').disabled = false;
});

// --- installable web app ---------------------------------------------------
// Register the network-first service worker (see public/sw.js) so the panel can
// be installed to the taskbar / home screen. Only works on a secure origin
// (https, or localhost), so a plain-http LAN visit simply skips it. Failure is
// never fatal to the panel.
if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => {
        navigator.serviceWorker.register('/sw.js').catch(() => {});
    });
}

// --- Global settings → Clear cache ---

const CACHE_TYPE_LABELS = {
    Images: 'Images',
    Containers: 'Containers (never removed here)',
    'Local Volumes': 'Volumes (never removed here)',
    'Build Cache': 'Build cache',
};

async function loadDiskCache() {
    const body = document.querySelector('#cache-usage tbody');
    body.innerHTML = '<tr><td colspan="4" class="muted">Reading…</td></tr>';
    try {
        const { rows } = await api('/api/system/disk-cache');
        body.innerHTML = rows
            .map(
                (r) =>
                    `<tr><td>${escapeHtml(CACHE_TYPE_LABELS[r.type] ?? r.type)}</td><td>${r.total}${r.active ? ` (${r.active} in use)` : ''}</td><td>${escapeHtml(r.size)}</td><td>${escapeHtml(r.reclaimable)}</td></tr>`,
            )
            .join('');
    } catch (e) {
        body.innerHTML = `<tr><td colspan="4" class="bad">${escapeHtml(e.message)}</td></tr>`;
    }
}

$('cache-refresh').addEventListener('click', () => loadDiskCache().catch(() => {}));

for (const button of document.querySelectorAll('[data-cache-clean]')) {
    button.addEventListener('click', async () => {
        const what = button.dataset.cacheClean;
        const title = button.textContent.trim();
        if (!await askConfirm(`${title}?\n\nVolumes, containers and images in use are kept. Unused images and build cache from other projects on this machine are cleared too.`)) return;
        await runAction({
            key: 'cache',
            title,
            note: 'Chain data, databases and running services are not touched.',
            request: () => api('/api/system/disk-cache/clean', { method: 'POST', body: { what } }),
        });
        loadDiskCache().catch(() => {});
    });
}

// --- Proxy & domains: this machine's LAN address beside the title ---

async function loadLanIp() {
    const code = $('topbar-lan-ip');
    const button = $('topbar-lan-copy');
    try {
        const { ip } = await api('/api/network/lan');
        code.textContent = ip ?? 'unknown';
        // The shared copy handler reads data-copy.
        if (ip) button.dataset.copy = ip;
        else delete button.dataset.copy;
        button.disabled = !ip;
    } catch {
        code.textContent = 'unknown';
        button.disabled = true;
    }
}

// --- .kachat → Rules: the rules of the registry contract that is running ---
//
// Fixed rules come from the contracts themselves (kachat-domains contracts/*.sil and
// docs/REGISTRY_V4.md); every number comes from the manifest the viewed network's indexer follows
// (/api/names/rules), so a redeployment changes this page by itself.

const kasOf = (sompi) => {
    const n = Number(sompi);
    if (!Number.isFinite(n)) return '–';
    const kas = n / 1e8;
    return `${kas.toLocaleString(undefined, { maximumFractionDigits: 8 })} KAS`;
};

function spanOf(ms) {
    const n = Number(ms);
    if (!Number.isFinite(n) || n <= 0) return '–';
    const units = [
        [365 * 86_400_000, 'year'],
        [86_400_000, 'day'],
        [3_600_000, 'hour'],
        [60_000, 'minute'],
        [1000, 'second'],
    ];
    for (const [size, word] of units) {
        if (n % size === 0 || n >= size * 2) {
            const v = Math.round((n / size) * 100) / 100;
            return `${v.toLocaleString()} ${word}${v === 1 ? '' : 's'}`;
        }
    }
    return `${n} ms`;
}

const TIER_LABELS = ['1 character', '2 characters', '3 characters', '4 characters', '5 or more characters'];
const TIER_KEYS = ['len1', 'len2', 'len3', 'len4', 'len5plus'];

/**
 * Registry v5 migrates its predecessor (kachat-domains docs/REGISTRY_V5.md): every name in the
 * old registry's snapshot can be imported with its owner and paid period, and new registrations
 * are refused until the import deadline.
 */
function migrationCard(r, p, short) {
    const mig = p.migration;
    if (!mig || !Number(mig.deadlineMs)) return '';
    const opens = new Date(Number(mig.deadlineMs));
    const open = Date.now() >= opens.getTime();
    const names = r.snapshot?.names;
    return `
      <article class="card span2 rules">
        <h3>Migration from the previous registry</h3>
        <ul class="plain">
          <li>This registry replaces registry ${short(mig.predecessorRegistryId)}. Contracts can't be upgraded, so a new
            version is a new registry that imports a snapshot of the old one${names != null ? ` (${escapeHtml(String(names))} name${names === 1 ? '' : 's'})` : ''}.</li>
          <li>An imported name keeps its owner and its paid period exactly as the snapshot recorded them. The contract checks
            each import against the snapshot's root (${short(mig.root)}), and only the name's owner or the migration sponsor can submit it.</li>
          <li>New registrations ${open ? 'opened' : 'open'} at <strong>${escapeHtml(opens.toLocaleString())}</strong>${open ? '' : '. Until then the contract refuses them, so every imported name is safe from being taken first'}.</li>
        </ul>
      </article>`;
}

async function loadNamesRules() {
    const box = $('names-rules');
    let r;
    try {
        r = await api(`/api/names/rules?net=${networkView}`);
    } catch (e) {
        box.innerHTML = `<p class="error">${escapeHtml(e.message)}</p>`;
        return;
    }
    const p = r.params || {};
    const period = spanOf(p.periodMs);
    const maxYears = Number(p.maxYears) || 0;
    const prices = p.prices || {};
    const hasTables = prices.register && prices.renew;
    const v = Number(r.registryVersion) || 2;
    const esc = escapeHtml;
    const short = (h) => (h ? `<code title="${esc(h)}">${esc(String(h).slice(0, 16))}…</code>` : '–');

    const priceRows = TIER_KEYS.map((k, i) => {
        if (hasTables) {
            return `<tr><td>${TIER_LABELS[i]}</td><td>${kasOf(prices.register[k])}</td><td>${kasOf(prices.renew[k])}</td></tr>`;
        }
        return `<tr><td>${TIER_LABELS[i]}</td><td colspan="2">${kasOf(prices[k])}</td></tr>`;
    }).join('');

    const commitSecs = Number(p.tCommit) ? Math.round(Number(p.tCommit) / 10) : null;
    box.innerHTML = `
      <article class="card span2 rules">
        <h3>The registry</h3>
        <p class="muted">
          These are the rules the .kachat contract enforces on chain. Nobody can change them, not even
          the deployer: a change means a new contract version and a new registry. The numbers below
          come from the manifest .kachat Domains verified against the contract source.
        </p>
        <dl class="kv vertical">
          <div><dt>Network</dt><dd>${esc(r.network || '–')}</dd></div>
          <div><dt>Contract version</dt><dd>registry v${v}${v >= 4 ? ' (fixed prices, no admin key)' : v === 3 ? ' (adjustable price record)' : ''}</dd></div>
          <div><dt>Registry id</dt><dd>${short(r.registryCovenantId)}</dd></div>
          <div><dt>Genesis transaction</dt><dd>${short(r.genesis?.txid)}</dd></div>
          ${Object.entries(r.templateHashes || {})
              .map(([k, h]) => `<div><dt>${esc(k.replace('Kachat', ''))} contract</dt><dd>${short(h)}</dd></div>`)
              .join('')}
        </dl>
      </article>

      <article class="card span2 rules">
        <h3>Names</h3>
        <ul class="plain">
          <li>A name is 1 to 32 characters: lowercase <code>a-z</code>, digits <code>0-9</code> and <code>-</code>, not starting or ending with <code>-</code>. It is used as <code>name.kachat</code>.</li>
          <li>Each name can have exactly one owner. This is enforced by the chain itself, not by any server.</li>
          <li>An owner is a KaChat (Kaspa) address. Every action by an owner needs that address's signature.</li>
          <li>Each registered name holds a <strong>${kasOf(p.bond)}</strong> deposit, returned when it is released or reclaimed.</li>
        </ul>
      </article>
${migrationCard(r, p, short)}

      <article class="card span2 rules">
        <h3>Prices (per ${esc(period)})</h3>
        <table class="blocks">
          <thead><tr><th>Name length</th>${hasTables ? '<th>Register (first period)</th><th>Renew / extend (each period)</th>' : '<th colspan="2">Price per period</th>'}</tr></thead>
          <tbody>${priceRows}</tbody>
        </table>
        <ul class="plain">
          ${
              hasTables
                  ? `<li>Registering for several periods costs the register price for the first and the renew price for each one after it, so registering for two periods never costs more than registering for one and extending.</li>`
                  : `<li>Registry v${v} reads its prices from an on-chain price record that an authority key can change; these are the genesis prices.</li>`
          }
          <li>The price goes to the Kaspa miners as part of the network fee. Nobody collects it: there is no treasury and no admin key${v >= 4 ? ', and no one can change these prices' : ''}.</li>
          <li>The network fee for the transaction itself is paid on top.</li>
        </ul>
      </article>

      <article class="card span2 rules">
        <h3>Registering</h3>
        <ul class="plain">
          <li><strong>Two steps, so nobody can steal a name you are about to register.</strong> First a hidden commitment is sent, which reveals neither the name nor the owner. Then the registration spends it.</li>
          <li>The commitment must be at least ${esc(String(p.tCommit ?? '–'))} DAA old before it can be used${commitSecs ? ` (about ${commitSecs} seconds at 10 blocks per second)` : ''}. A commitment that is never used can be cancelled and its KAS taken back.</li>
          <li>A name can be prepaid for 1 to ${maxYears || '–'} period${maxYears === 1 ? '' : 's'} of ${esc(period)}.</li>
          <li>Each registration splits a free range of the registry in two, so the same name can never be registered twice.</li>
        </ul>
      </article>

      <article class="card span2 rules">
        <h3>Keeping a name</h3>
        <ul class="plain">
          <li><strong>Extend:</strong> add periods to the current one at any time, as long as the name is never paid more than ${maxYears || '–'} period${maxYears === 1 ? '' : 's'} past the start of its current period.</li>
          <li><strong>Renew:</strong> once renewal opens, ${esc(spanOf(p.renewWindowMs))} before the name expires, start a new period from the old expiry date, so no time is lost or gained. This also works during the grace period, and even after it, until someone reclaims the name.</li>
          <li>Anyone can extend or renew a name, so names can be gifted time. It stays with its owner.</li>
        </ul>
      </article>

      <article class="card span2 rules">
        <h3>Expiry</h3>
        <ul class="plain">
          <li><strong>Active:</strong> until the paid period ends.</li>
          <li><strong>Grace period, ${esc(spanOf(p.graceMs))}:</strong> the name has expired but still belongs to its owner and still resolves to them. The owner can still renew it.</li>
          <li><strong>Lapsed:</strong> after the grace period, <em>anyone</em> can reclaim the name. That frees it for anyone to register, and the ${kasOf(p.bond)} deposit goes back to the last owner.</li>
          <li>The owner can also release a name at any time and take the deposit back.</li>
        </ul>
      </article>

      <article class="card span2 rules">
        <h3>Selling and transferring</h3>
        <ul class="plain">
          <li><strong>Transfer:</strong> the owner can give the name to any address. Any listing is cleared.</li>
          <li><strong>List:</strong> the owner sets an asking price, or 0 to take it off sale.</li>
          <li><strong>Buy:</strong> anyone can buy a listed name for its asking price. The contract pays the seller in the same transaction, so a payment can never count for two purchases.</li>
          <li>A sale or transfer keeps the name's paid period and expiry date.</li>
        </ul>
      </article>

      <article class="card span2 rules">
        <h3>Offers</h3>
        <ul class="plain">
          <li>Anyone can lock KAS as an offer on any name, listed or not. The offer is tied to the name and to its owner at that moment.</li>
          <li><strong>Accept:</strong> only that owner can accept, and only while the name is still theirs. The name goes to the buyer and the owner receives the offer, less at most ${kasOf(p.offerMaxFee)} of network fee.</li>
          <li><strong>Decline:</strong> the owner can send an offer back to the buyer at any time. If the name changes owner, every earlier offer can no longer be accepted.</li>
          <li><strong>Withdraw:</strong> the buyer can take their KAS back at any time.</li>
          <li><strong>Refund:</strong> once an offer's refund time has passed, anyone can send the KAS back to the buyer.</li>
        </ul>
      </article>

      <article class="card span2 rules">
        <h3>Safety</h3>
        <ul class="plain">
          <li>Every owner signature covers the whole transaction (SIGHASH_ALL), so a signed action can't be redirected.</li>
          <li>No name can be seized, frozen or moved without its owner, except reclaiming a name after its grace period, which returns the deposit to the last owner.</li>
          <li>Registry v${v}${v >= 4 ? ' has no admin or authority key of any kind' : ' has one admin power: the price authority key'}.</li>
        </ul>
      </article>`;
}

// --- System > Experimental: apps still being tested, each on its own branch ---

/** The sidebar badge says when this panel runs an experimental branch, not main. */
function showPanelBranch(ref) {
    const badge = $('version-badge');
    if (!badge || !ref) return;
    const base = badge.textContent.split(' · ')[0];
    badge.textContent = ref === 'main' ? base : `${base} · ${ref}`;
    badge.classList.toggle('warn', ref !== 'main');
    badge.title = ref === 'main' ? '' : `This panel runs the experimental branch "${ref}" (System > Experimental).`;
}

$('global-ref')?.addEventListener('input', () => {
    $('global-ref').dataset.touched = '1';
});

let expState = null;

async function loadExperimental(force = false) {
    const list = $('exp-list');
    let r;
    try {
        r = await api(`/api/system/experimental${force ? '?force=1' : ''}`);
    } catch (e) {
        list.innerHTML = `<p class="error">${escapeHtml(e.message)}</p>`;
        return;
    }
    expState = r;
    showPanelBranch(r.current);

    // This panel
    $('exp-current-text').innerHTML = r.experimental
        ? `This panel runs the experimental branch <code>${escapeHtml(r.current)}</code>${
              r.title ? ` (${escapeHtml(r.title)})` : ''
          }. Update panel (Global settings) keeps it on this branch.`
        : 'This panel runs <code>main</code>, the regular release everyone gets.';
    $('exp-leave').hidden = !r.experimental;
    const installed = r.apps.filter((a) => a.installed);
    $('exp-leave-apps').hidden = !installed.length;
    $('exp-leave-remove-row').hidden = !installed.length;
    $('exp-leave-keep-row').hidden = !installed.length;
    if (installed.length) {
        $('exp-leave-apps').innerHTML = `<p><strong>Only this branch can run ${installed
            .map((a) => escapeHtml(a.label))
            .join(', ')}.</strong> On main, ${installed.length === 1 ? 'it' : 'they'} would keep running with nothing in the panel to switch ${
            installed.length === 1 ? 'it' : 'them'
        } off or remove ${installed.length === 1 ? 'it' : 'them'}.</p>`;
    }

    // The branches
    if (r.error && !r.branches.length) {
        list.innerHTML = `<p class="error">${escapeHtml(r.error)}</p>`;
        return;
    }
    if (!r.branches.length) {
        list.innerHTML = '<p class="muted">Nothing is being tested right now.</p>';
        return;
    }
    list.innerHTML = r.branches
        .map((b) => {
            const here = b.branch === r.current;
            const fresh =
                b.behind == null
                    ? ''
                    : b.behind === 0
                      ? 'Up to date with main.'
                      : `${b.behind} change${b.behind === 1 ? '' : 's'} on main ${b.behind === 1 ? 'is' : 'are'} not in it yet.`;
            return `
          <div class="exp-item">
            <div class="node-head"><h4>${escapeHtml(b.title)}</h4>
              <span class="tag ${here ? 'ok' : ''}">${here ? 'running here' : escapeHtml(b.branch)}</span></div>
            <p class="muted">${escapeHtml(b.summary)}</p>
            <p class="hint">Branch <code>${escapeHtml(b.branch)}</code>${b.updatedAt ? `, updated ${escapeHtml(new Date(b.updatedAt).toLocaleString())}` : ''}. ${fresh}</p>
            ${here ? '' : `<div class="row"><button type="button" class="ghost" data-exp-try="${escapeHtml(b.branch)}">Try it</button></div>`}
          </div>`;
        })
        .join('');
}

$('exp-refresh')?.addEventListener('click', () => loadExperimental(true).catch(() => {}));

/** Rebuild the panel from a branch, with the same overlay as Update panel. */
async function switchPanelTo(ref) {
    const repo = 'KaspaSilver/Kaspa-Quick-Start';
    const baseAt = await api('/api/system').then((s) => s.lastUpdate?.at ?? null).catch(() => null);
    await api('/api/system/panel-update', { method: 'POST', body: { repo, ref } });
    showPanelUpdateOverlay(repo, ref, baseAt);
}

$('exp-list')?.addEventListener('click', async (ev) => {
    const ref = ev.target.closest('[data-exp-try]')?.dataset.expTry;
    if (!ref) return;
    const b = expState?.branches.find((x) => x.branch === ref);
    if (await panelUpdateBlockedByQueue()) return;
    const ok = await askConfirm(
        `Try "${b?.title ?? ref}"?\n\nThis rebuilds the panel from the branch ${ref}: the regular panel plus what is being tested. ` +
            'It is offline for a minute or two; the node and every app keep running. System > Experimental brings you back to main.',
    );
    if (!ok) return;
    try {
        await switchPanelTo(ref);
    } catch (e) {
        await askConfirm(`Could not start the update: ${e.message}`);
    }
});

$('exp-leave-btn')?.addEventListener('click', async () => {
    const r = expState;
    if (!r) return;
    const remove = !$('exp-leave-remove-row').hidden && $('exp-leave-remove').checked;
    const keepData = $('exp-leave-keep').checked;
    const apps = remove ? r.apps.filter((a) => a.installed) : [];
    const ok = await askConfirm(
        `Go back to main?${apps.length ? `\n\nFirst uninstall: ${apps.map((a) => a.label).join(', ')}${keepData ? ' (keeping their data)' : ''}.` : ''}\n\n` +
            'Then the panel rebuilds from main. It is offline for a minute or two; the node and every app keep running.',
    );
    if (!ok) return;
    if (await panelUpdateBlockedByQueue()) return;
    for (const a of apps) {
        // Before going back to main, whose panel cannot run it. If one did not happen (it
        // failed, or was taken out of the queue), stop here rather than leave main a panel
        // that cannot manage it (KQS-032).
        const job = await queueAction({
            title: `Uninstalling ${a.label}`,
            noCancel: true,
            request: (headers) => api(`/api/services/${a.key}/uninstall`, { method: 'POST', body: { keepData, confirm: a.key }, headers }),
        });
        if (!job?.ok) {
            await askConfirm(
                `Still on this branch\n\n${a.label} was not uninstalled (${job?.status === 'cancelled' ? 'it was taken out of the queue' : job?.error || 'it failed'}), and main's panel cannot manage it, so the panel was not switched. See System, Update Queue for its log, then try again.`,
            );
            return;
        }
    }
    try {
        await switchPanelTo('main');
    } catch (e) {
        await askConfirm(`Could not start the update: ${e.message}`);
    }
});

// --- x4kas: download it, and connect it to this node ---

function x4kasPlatform() {
    const ua = navigator.userAgent || '';
    const mac = /Macintosh|Mac OS X/.test(ua);
    if (mac) return 'macos-arm64'; // Intel Macs are listed too; Apple silicon is what ships now.
    if (/Windows/.test(ua)) return 'windows-x64';
    if (/Linux/.test(ua) && !/Android/.test(ua)) return /aarch64|arm64/i.test(ua) ? 'linux-arm64' : 'linux-x64';
    return null;
}

const x4kasCopyRow = (address) => `
    <div class="row x4kas-copy">
      <code>${escapeHtml(address)}</code>
      <button type="button" class="ghost mini" data-copy="${escapeHtml(address)}">Copy</button>
    </div>`;

let x4kasState = null;

async function loadX4kas(force = false) {
    let d;
    try {
        d = await api(`/api/x4kas${force ? '?force=1' : ''}`);
    } catch (e) {
        $('x4kas-downloads').innerHTML = `<p class="error">${escapeHtml(e.message)}</p>`;
        return;
    }
    const mine = x4kasPlatform();

    // 1. Download
    const r = d.release;
    if (!r || r.error) {
        $('x4kas-downloads').innerHTML = `<p class="error">${escapeHtml(r?.error || 'No release found.')}</p>
            <p><a href="https://github.com/${escapeHtml(d.repo)}/releases" target="_blank" rel="noopener">Releases on GitHub</a></p>`;
    } else {
        const sorted = [...r.downloads].sort((a, b) => (b.key === mine) - (a.key === mine));
        $('x4kas-downloads').innerHTML = `
          <p class="muted">Release <a href="${escapeHtml(r.url)}" target="_blank" rel="noopener">${escapeHtml(r.tag)}</a>${
              r.publishedAt ? `, ${escapeHtml(new Date(r.publishedAt).toLocaleDateString())}` : ''
          }. Each archive holds the app (x4kas) and its command-line tool (x4kas-cli).</p>
          <div class="x4kas-dls">${sorted
              .map(
                  (a) => `<a class="${a.key === mine ? 'primary' : 'ghost'} button" data-platform="${escapeHtml(a.key)}" href="${escapeHtml(a.url)}" rel="noopener">${escapeHtml(a.label)}${
                      a.key === mine ? ' (this computer)' : ''
                  }<small>${escapeHtml(a.name)}${a.size ? `, ${(a.size / 1e6).toFixed(0)} MB` : ''}</small></a>`,
              )
              .join('')}</div>
          ${r.checksums ? `<p class="hint">Checksums: <a href="${escapeHtml(r.checksums)}" rel="noopener">SHA256SUMS</a>.</p>` : ''}`;
    }
    $('x4kas-dl-hint').innerHTML =
        mine?.startsWith('macos')
            ? 'macOS: unpack it and drag <code>x4kas.app</code> to Applications. It is not notarized yet, so the first time, open it and then allow it under System Settings, Privacy &amp; Security, Open Anyway.'
            : mine?.startsWith('linux')
              ? 'Linux: needs X11 or Wayland, libxkbcommon and OpenSSL 3 (Ubuntu 22.04 or newer).'
              : mine === 'windows-x64'
                ? 'Windows: unzip it and run <code>x4kas.exe</code>. SmartScreen may ask first, because it is new.'
                : '';

    x4kasState = d;
    renderX4kasUpdates(d);

    // 2. Connect
    $('x4kas-network').textContent = d.network;
    const lanAddr = d.lan ? `ws://${d.lan}:${d.borsh.port}` : null;
    if (d.borsh.exposure === 'public' && lanAddr) {
        $('x4kas-lan').innerHTML = x4kasCopyRow(lanAddr);
    } else {
        $('x4kas-lan').innerHTML = `
          <p class="muted">${
              d.borsh.exposure === 'local'
                  ? 'The node answers wRPC Borsh on this machine only, so other computers cannot reach it yet.'
                  : 'The node does not publish its wRPC Borsh port yet, so other computers cannot reach it.'
          } Publishing it on the network makes <code>${escapeHtml(lanAddr || `ws://<this machine's IP>:${d.borsh.port}`)}</code> work from any
          computer on your network. It is not reachable from the internet unless your router forwards that port.</p>
          <div class="row"><button type="button" class="ghost" id="x4kas-open-borsh">Publish wRPC Borsh on the network</button></div>`;
        $('x4kas-open-borsh')?.addEventListener('click', async () => {
            const ok = await askConfirm(
                `Publish the node's wRPC Borsh port (${d.borsh.port}) on this machine's network address?\n\n` +
                    'Wallets and apps on your network can then connect to the node. The node restarts to pick it up (a few seconds).',
            );
            if (!ok) return;
            await runAction({
                key: 'node',
                title: 'Publishing wRPC Borsh',
                note: 'The node restarts with the port published on the network.',
                request: () => api('/api/ports/borsh', { method: 'POST', body: { public: true } }),
            });
            loadX4kas().catch(() => {});
        });
    }
    if (d.remote) {
        $('x4kas-remote').innerHTML =
            x4kasCopyRow(d.remote) +
            (d.remoteTls ? '' : '<p class="hint">This name has no certificate yet, so the connection is not encrypted. Get one under Proxy &amp; domains.</p>');
    } else {
        $('x4kas-remote').innerHTML = `
          <p class="muted">Put the Kaspa node on a domain (a free DuckDNS name works) and x4kas can connect from
          anywhere, encrypted (<code>wss://</code>). Proxy &amp; domains does it in a few steps.</p>
          <div class="row"><button type="button" class="ghost" id="x4kas-go-proxy">Open Proxy &amp; domains</button></div>`;
        $('x4kas-go-proxy')?.addEventListener('click', () => selectTab('proxy'));
    }
}

/** Updates: what was downloaded here, what is out, and the release notes. */
function renderX4kasUpdates(d) {
    const r = d.release && !d.release.error ? d.release : null;
    const last = d.lastDownload;
    $('x4kas-have').textContent = last ? `${last.tag}, on ${new Date(last.at).toLocaleDateString()}` : 'nothing from this panel yet';
    $('x4kas-latest').innerHTML = r
        ? `<a href="${escapeHtml(r.url)}" target="_blank" rel="noopener">${escapeHtml(r.tag)}</a>${
              r.publishedAt ? `, released ${escapeHtml(new Date(r.publishedAt).toLocaleDateString())}` : ''
          }${r.prerelease ? ' (pre-release)' : ''}`
        : escapeHtml(d.release?.error || '-');
    const status = $('x4kas-update-status');
    if (!r) {
        status.className = 'update-status error';
        status.textContent = d.release?.error || 'Could not read the releases.';
    } else if (!last) {
        status.className = 'update-status';
        status.textContent = `The latest is ${r.tag}. Download it under Get x4kas; this panel then tells you when a newer one is out.`;
    } else if (d.updateAvailable) {
        status.className = 'update-status available';
        status.textContent = `A newer x4kas is out: ${r.tag} (you have ${last.tag}).`;
    } else {
        status.className = 'update-status current';
        status.textContent = `Up to date: ${r.tag} is the latest release.`;
    }
    $('x4kas-get-latest').hidden = !(r && d.updateAvailable);
    $('x4kas-notes').textContent = r?.notes?.trim() || 'No release notes.';
    const btn = document.querySelector('#tab-x4kas [data-subtab="x4kas-updates"]');
    if (btn) btn.textContent = d.updateAvailable ? 'Updates (1)' : 'Updates';
}

$('x4kas-check')?.addEventListener('click', () => loadX4kas(true).catch(() => {}));
$('x4kas-get-latest')?.addEventListener('click', () => selectSubtab($('tab-x4kas'), 'x4kas-get'));

// A download link remembers the release, so Updates can say when a newer one is out.
$('x4kas-downloads')?.addEventListener('click', (ev) => {
    const a = ev.target.closest('a.button');
    const r = x4kasState?.release;
    if (!a || !r?.tag) return;
    api('/api/x4kas/downloaded', { method: 'POST', body: { tag: r.tag, platform: a.dataset.platform || '' } })
        .then((res) => {
            x4kasState.lastDownload = res.lastDownload;
            x4kasState.updateAvailable = false;
            renderX4kasUpdates(x4kasState);
        })
        .catch(() => {});
});
