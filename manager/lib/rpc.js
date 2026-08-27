/**
 * Minimal client for kaspad's wRPC JSON endpoint.
 *
 * The wire format comes from workflow-rpc's JSON protocol:
 *   request  {"id": <n>, "method": "getInfo", "params": {...}}
 *   response {"id": <n>, "method": "getInfo", "params": {...}}
 *            {"id": <n>, "method": "getInfo", "error": {code, message, data}}
 * Method names are the camelCase form of the RpcApiOps variants, and payloads
 * are the plain serde representation of the Rpc*Request / Rpc*Response types.
 *
 * Uses the global WebSocket shipped with Node 22 so the manager stays
 * dependency free.
 */

const CONNECT_TIMEOUT_MS = 6000;
const CALL_TIMEOUT_MS = 8000;

export class RpcError extends Error {
    constructor(message) {
        super(message);
        this.name = 'RpcError';
    }
}

class WrpcClient {
    #url = null;
    #socket = null;
    #connecting = null;
    #nextId = 1;
    #pending = new Map();

    setUrl(url) {
        if (url === this.#url) return;
        this.#url = url;
        this.#teardown(new RpcError('rpc endpoint changed'));
    }

    #teardown(reason) {
        const socket = this.#socket;
        this.#socket = null;
        this.#connecting = null;
        for (const { reject, timer } of this.#pending.values()) {
            clearTimeout(timer);
            reject(reason);
        }
        this.#pending.clear();
        try {
            socket?.close();
        } catch {
            /* already closing */
        }
    }

    #connect() {
        if (this.#socket?.readyState === WebSocket.OPEN) return Promise.resolve(this.#socket);
        if (this.#connecting) return this.#connecting;

        this.#connecting = new Promise((resolve, reject) => {
            let socket;
            try {
                socket = new WebSocket(this.#url);
            } catch (err) {
                this.#connecting = null;
                reject(new RpcError(`cannot open ${this.#url}: ${err.message}`));
                return;
            }

            const timer = setTimeout(() => {
                try {
                    socket.close();
                } catch {
                    /* noop */
                }
                this.#connecting = null;
                reject(new RpcError(`timed out connecting to ${this.#url}`));
            }, CONNECT_TIMEOUT_MS);

            socket.addEventListener('open', () => {
                clearTimeout(timer);
                this.#socket = socket;
                this.#connecting = null;
                resolve(socket);
            });

            socket.addEventListener('message', (event) => {
                let msg;
                try {
                    msg = JSON.parse(typeof event.data === 'string' ? event.data : event.data.toString());
                } catch {
                    return;
                }
                // Notifications arrive without an id; we do not subscribe to any.
                if (msg.id === undefined || msg.id === null) return;
                const entry = this.#pending.get(msg.id);
                if (!entry) return;
                this.#pending.delete(msg.id);
                clearTimeout(entry.timer);
                if (msg.error) entry.reject(new RpcError(msg.error.message || JSON.stringify(msg.error)));
                else entry.resolve(msg.params ?? {});
            });

            socket.addEventListener('error', () => {
                clearTimeout(timer);
                if (this.#connecting) {
                    this.#connecting = null;
                    reject(new RpcError(`websocket error talking to ${this.#url}`));
                }
            });

            socket.addEventListener('close', () => {
                clearTimeout(timer);
                this.#teardown(new RpcError('rpc connection closed'));
            });
        });

        return this.#connecting;
    }

    async call(method, params = {}, timeoutMs = CALL_TIMEOUT_MS) {
        if (!this.#url) throw new RpcError('rpc endpoint not configured');
        const socket = await this.#connect();
        const id = this.#nextId++;

        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                this.#pending.delete(id);
                reject(new RpcError(`rpc call ${method} timed out`));
            }, timeoutMs);
            this.#pending.set(id, { resolve, reject, timer });
            try {
                socket.send(JSON.stringify({ id, method, params }));
            } catch (err) {
                clearTimeout(timer);
                this.#pending.delete(id);
                reject(new RpcError(`failed to send ${method}: ${err.message}`));
            }
        });
    }

    close() {
        this.#teardown(new RpcError('client closed'));
    }
}

export const rpc = new WrpcClient();

/**
 * Collects everything the dashboard shows in one shot. Each call is optional --
 * a node that is still opening its database answers nothing, and the UI should
 * show "starting" rather than an error page.
 */
export async function nodeSnapshot() {
    const out = { reachable: false, info: null, dag: null, sync: null, peers: null, error: null };
    try {
        out.info = await rpc.call('getInfo', {});
        out.reachable = true;
    } catch (err) {
        out.error = err.message;
        return out;
    }
    const optional = [
        ['dag', 'getBlockDagInfo'],
        ['sync', 'getSyncStatus'],
        ['peers', 'getConnectedPeerInfo'],
    ];
    await Promise.all(
        optional.map(async ([key, method]) => {
            try {
                out[key] = await rpc.call(method, {});
            } catch {
                out[key] = null;
            }
        }),
    );
    return out;
}
