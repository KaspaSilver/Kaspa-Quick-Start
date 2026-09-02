import { EventEmitter } from 'node:events';
import { jobContext } from './jobcontext.js';
import { killJob } from './dockerctl.js';

/**
 * Runs the long operations the UI kicks off -- image builds, certificate
 * issuance, stack restarts -- one at a time, in the order they were asked for.
 *
 * One at a time is not a limitation to remove: these all end in `docker compose
 * up`, and two of them racing produces a container state nobody asked for. But
 * refusing the second was the wrong way to enforce it. Switching on three apps
 * meant waiting out a Rust build before being allowed to ask for the next one,
 * with a "Busy" error for trying -- and the only thing wrong with asking was
 * the timing, which a queue knows how to fix.
 */
class JobRunner extends EventEmitter {
    current = null;
    queue = [];
    history = [];
    #seq = 0;

    get busy() {
        return this.current !== null && this.current.status === 'running';
    }

    /** Everything asked for and not yet finished, in the order it will run. */
    get pending() {
        return this.queue.map(({ job }) => ({ id: job.id, name: job.name, status: job.status }));
    }

    start(name, fn) {
        const job = {
            // Two clicks in the same millisecond used to collide, which nothing
            // noticed while only one job could exist at a time.
            id: `${Date.now().toString(36)}-${(this.#seq += 1).toString(36)}`,
            name,
            status: 'queued',
            startedAt: null,
            finishedAt: null,
            lines: [],
            error: null,
        };

        this.queue.push({ job, fn });
        this.emit('queued', { ...job, ahead: this.queue.length - 1, running: this.current?.name ?? null });
        this.#drain();
        return job;
    }

    /**
     * Starts the next job if nothing is running. Called when one is added and
     * again when one finishes, so the queue empties itself.
     */
    #drain() {
        if (this.busy) return;
        const next = this.queue.shift();
        if (!next) return;

        const { job, fn } = next;
        job.status = 'running';
        job.startedAt = new Date().toISOString();
        this.current = job;

        const log = (line) => {
            const text = String(line).replace(/\r/g, '').trimEnd();
            if (!text) return;
            job.lines.push(text);
            if (job.lines.length > 2000) job.lines.shift();
            this.emit('line', { jobId: job.id, line: text });
        };

        log(`> ${job.name}`);
        this.emit('start', job);

        Promise.resolve()
            .then(() => jobContext.run({ id: job.id }, () => fn(log)))
            .then(
                (result) => {
                    // A cancelled job can still finish cleanly: killing docker
                    // compose halfway through `up` leaves it having done part
                    // of the work and exiting 0. What was asked for is what
                    // this reports.
                    job.status = job.cancelled ? 'cancelled' : 'succeeded';
                    job.result = result ?? null;
                },
                (err) => {
                    // The error from a killed process describes the killing,
                    // not a fault. Somebody pressed cancel; say that.
                    job.status = job.cancelled ? 'cancelled' : 'failed';
                    job.error = job.cancelled ? 'Cancelled.' : err?.message || String(err);
                    log(job.cancelled ? '! Cancelled.' : `! ${job.error}`);
                },
            )
            .finally(() => {
                job.finishedAt = new Date().toISOString();
                this.emit('end', job);
                this.history.unshift({ ...job, lines: job.lines.slice(-200) });
                this.history = this.history.slice(0, 10);
                // Whatever is next starts now, not when somebody asks again.
                this.#drain();
            });
    }

    /**
     * Stops a job, whether it has started or not.
     *
     * A queued one simply never runs. A running one has its processes killed,
     * and what it had already done stays done: a half-finished build keeps its
     * layers, a half-finished uninstall does not put back what it removed. The
     * panel says so before asking.
     */
    cancel(id) {
        const queued = this.queue.findIndex(({ job }) => job.id === id);
        if (queued !== -1) {
            const [{ job }] = this.queue.splice(queued, 1);
            job.status = 'cancelled';
            job.error = 'Cancelled before it started.';
            job.finishedAt = new Date().toISOString();
            this.emit('end', { ...job, pending: this.pending });
            return { cancelled: true, started: false };
        }

        if (this.current?.id !== id || this.current.status !== 'running') {
            return { cancelled: false, reason: 'That job is not running.' };
        }

        // Marked first: whichever way the function ends after its processes
        // die, the end handler has to know this was asked for.
        this.current.cancelled = true;
        this.emit('line', { jobId: id, line: 'Cancelling. Docker is being asked to stop.' });
        this.current.lines.push('Cancelling. Docker is being asked to stop.');
        const killed = killJob(id);
        if (!killed) {
            this.emit('line', {
                jobId: id,
                line: 'Nothing was running to stop, so this ends as soon as the step in progress returns.',
            });
        }
        return { cancelled: true, started: true, killed };
    }

    snapshot() {
        if (!this.current) return null;
        const { id, name, status, startedAt, finishedAt, error, lines } = this.current;
        return { id, name, status, startedAt, finishedAt, error, lines: lines.slice(-400), pending: this.pending };
    }
}

export const jobs = new JobRunner();
