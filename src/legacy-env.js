// Homunculus: environment variables used to be named SILLYBUNNY_*. Copy any old
// name to its HOMUNCULUS_* equivalent (without overriding a new name that is set)
// so old launch scripts, user setups and a supervisor still running pre-rename
// code keep working. Imported first by server.js.
const LEGACY_PREFIX = 'SILLYBUNNY_';
const PREFIX = 'HOMUNCULUS_';

for (const [name, value] of Object.entries(process.env)) {
    if (!name.startsWith(LEGACY_PREFIX) || value === undefined) {
        continue;
    }
    const newName = PREFIX + name.slice(LEGACY_PREFIX.length);
    if (process.env[newName] === undefined) {
        process.env[newName] = value;
    }
}
