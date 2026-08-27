import { EventEmitter } from 'node:events';

/**
 * A single-slot job runner for the long operations the UI kicks off (image
 * builds, certificate issuance, stack restarts). Only one runs at a time --
 * these all end in `docker compose up`, and letting two race would produce a
 * container state nobody asked for.
 */
class JobRunner extends EventEmitter {
    current = null;
    history = [];

    get busy() {
        return this.current !== null && this.current.status === 'running';
    }

    start(name, fn) {
        if (this.busy) throw new Error(`Busy: "${this.current.name}" is still running.`);

        const job = {
            id: `${Date.now().toString(36)}`,
            name,
            status: 'running',
            startedAt: new Date().toISOString(),
            finishedAt: null,
            lines: [],
            error: null,
        };
        this.current = job;

        const log = (line) => {
            const text = String(line).replace(/\r/g, '').trimEnd();
            if (!text) return;
            job.lines.push(text);
            if (job.lines.length > 2000) job.lines.shift();
            this.emit('line', { jobId: job.id, line: text });
        };

        log(`> ${name}`);
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
            });

        return job;
    }

    snapshot() {
        if (!this.current) return null;
        const { id, name, status, startedAt, finishedAt, error, lines } = this.current;
        return { id, name, status, startedAt, finishedAt, error, lines: lines.slice(-400) };
    }
}

export const jobs = new JobRunner();
