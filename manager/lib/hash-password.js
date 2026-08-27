/**
 * Reads a password on stdin and prints the value for ADMIN_PASSWORD_HASH.
 *
 *   printf '%s' 'secret' | docker run --rm -i kaspa-one-click/manager:1 node lib/hash-password.js
 *
 * The installers use this so they never have to reimplement the hashing scheme,
 * and so the password is never passed as a command-line argument.
 */
import { hashPassword } from './auth.js';

let data = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
    data += chunk;
});
process.stdin.on('end', () => {
    // PowerShell's pipeline appends a newline; bash's printf does not. Trimming
    // one trailing line ending keeps both installers producing the same hash.
    process.stdout.write(hashPassword(data.replace(/\r?\n$/, '')));
});
