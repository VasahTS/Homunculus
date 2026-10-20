// Classic UI fork: the Vault (reusable scenarios and NPCs).
// Each item is one JSON file in data/<user>/homunculus-vault/<kind>/<id>.json.

import fs from 'node:fs';
import path from 'node:path';

import express from 'express';
import sanitize from 'sanitize-filename';

import { tryWriteFileSync } from '../util.js';

export const router = express.Router();

const KINDS = new Set(['scenarios', 'npcs', 'setups']);
const MAX_ITEM_BYTES = 20 * 1024 * 1024;

function kindDir(request) {
    const kind = String(request.body?.kind ?? '');
    if (!KINDS.has(kind)) return null;
    const dir = path.join(request.user.directories.root, 'homunculus-vault', kind);
    fs.mkdirSync(dir, { recursive: true });
    return dir;
}

function fileFor(dir, id) {
    const name = sanitize(String(id ?? '').trim());
    if (!name || name !== String(id).trim()) return null;
    return path.join(dir, `${name}.json`);
}

router.post('/list', (request, response) => {
    const dir = kindDir(request);
    if (!dir) return response.sendStatus(400);
    const items = [];
    for (const file of fs.readdirSync(dir)) {
        if (!file.endsWith('.json')) continue;
        try {
            const item = JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8'));
            if (item && typeof item === 'object') items.push(item);
        } catch (error) {
            console.warn(`[Vault] Skipped unreadable file ${file}:`, error?.message ?? error);
        }
    }
    return response.send(items);
});

router.post('/save', (request, response) => {
    const dir = kindDir(request);
    const item = request.body?.item;
    if (!dir || !item || typeof item !== 'object') return response.sendStatus(400);
    const file = fileFor(dir, item.id);
    if (!file) return response.status(400).send({ error: 'Invalid id' });
    const text = JSON.stringify(item, null, 2);
    if (Buffer.byteLength(text) > MAX_ITEM_BYTES) return response.status(413).send({ error: 'Item is too large' });
    tryWriteFileSync(file, text);
    return response.send({ ok: true });
});

router.post('/delete', (request, response) => {
    const dir = kindDir(request);
    if (!dir) return response.sendStatus(400);
    const file = fileFor(dir, request.body?.id);
    if (!file) return response.status(400).send({ error: 'Invalid id' });
    if (fs.existsSync(file)) fs.unlinkSync(file);
    return response.send({ ok: true });
});
