import { AsyncLocalStorage } from 'node:async_hooks';

/**
 * Which job the code currently running belongs to.
 *
 * Cancelling means killing the processes a job spawned, which means knowing
 * which ones those are. Threading a job id through every compose helper and
 * every call site would be a wide change to make one button work, and every
 * call site added later would silently not be cancellable.
 *
 * Async context does it instead: the runner runs the job's function inside
 * this store, and every process spawned underneath it -- however deep, across
 * however many awaits -- reads the same id. A `docker inspect` fired by the
 * status poll at the same moment is outside the store, has no id, and is not
 * something cancelling should ever kill.
 */
export const jobContext = new AsyncLocalStorage();
