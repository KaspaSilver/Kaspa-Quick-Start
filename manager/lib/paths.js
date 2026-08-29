import fs from 'node:fs';
import path from 'node:path';

// STACK_LOCAL is where the stack directory is mounted *inside* this container.
// STACK_HOST is the same directory as the Docker daemon sees it. They differ,
// and mixing them up is the easiest way to break this stack: compose file
// arguments and `docker run -v` sources must always use the host path, while
// plain file reads/writes must always use the local path.
export const STACK_LOCAL = process.env.STACK_LOCAL || '/stack';
export const STACK_HOST = process.env.STACK_DIR || STACK_LOCAL;

export const CONF_DIR = path.join(STACK_LOCAL, 'conf');
export const PROXY_DIR = path.join(STACK_LOCAL, 'proxy');
export const NGINX_CONF_D = path.join(PROXY_DIR, 'conf.d');
export const NGINX_SNIPPETS = path.join(PROXY_DIR, 'snippets');
export const LETSENCRYPT_DIR = path.join(PROXY_DIR, 'letsencrypt');
export const WEBROOT_DIR = path.join(PROXY_DIR, 'webroot');

export const COMPOSE_FILE = path.join(STACK_LOCAL, 'docker-compose.yml');
export const PORTS_OVERRIDE = path.join(CONF_DIR, 'ports.yml');
export const ENV_FILE = path.join(STACK_LOCAL, '.env');

export const NODE_CONFIG_FILE = path.join(CONF_DIR, 'node.json');
export const MANAGER_CONFIG_FILE = path.join(CONF_DIR, 'manager.json');
export const PROXIES_FILE = path.join(CONF_DIR, 'proxies.json');
// The domains someone has pointed at this machine, whether or not anything is
// published on them yet. Kept apart from proxies.json because a domain outlives
// the service behind it: you add the name once and then decide, and change your
// mind about, what answers on it.
export const DOMAINS_FILE = path.join(CONF_DIR, 'domains.json');
export const KASPAD_ARGS_FILE = path.join(CONF_DIR, 'kaspad.args');

// The host-side equivalents, for `docker run -v` and compose `-f`.
export const hostPath = (...parts) => path.posix.join(STACK_HOST.replace(/\\/g, '/'), ...parts);

export function ensureDirs() {
    for (const dir of [CONF_DIR, PROXY_DIR, NGINX_CONF_D, NGINX_SNIPPETS, LETSENCRYPT_DIR, WEBROOT_DIR]) {
        fs.mkdirSync(dir, { recursive: true });
    }
}
