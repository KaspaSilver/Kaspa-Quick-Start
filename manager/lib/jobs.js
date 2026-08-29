import { EventEmitter } from 'node:events';

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
            .then(() => fn(log))
            .then(
                (result) => {
                    job.status = 'succeeded';
                    job.result = result ?? null;
                },
                (err) => {
                    job.status = 'failed';
                    job.error = err?.message || String(err);
                    log(`! ${job.error}`);
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

    snapshot() {
        if (!this.current) return null;
        const { id, name, status, startedAt, finishedAt, error, lines } = this.current;
        return { id, name, status, startedAt, finishedAt, error, lines: lines.slice(-400), pending: this.pending };
    }
}

export const jobs = new JobRunner();
