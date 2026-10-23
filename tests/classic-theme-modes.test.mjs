import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const source = readFileSync(path.join(root, 'public/scripts/classic-themes.js'), 'utf8');
const raw = JSON.parse(readFileSync(path.join(root, 'public/classic-themes/night-transit/theme.json'), 'utf8'));
const css = readFileSync(path.join(root, 'public/classic-themes/night-transit/theme.css'), 'utf8');

function setup() {
    const nodes = new Map();
    const values = new Map();
    const cache = new Map();
    const classes = new Set(['existing-class']);
    const handlers = {};
    const rootNode = { dataset: {}, innerHTML: '', closest: () => null, addEventListener: (name, fn) => { handlers[name] = fn; }, querySelector: () => ({ focus() {} }) };
    nodes.set('ct_personalize', rootNode);
    const createElement = () => ({ style: { setProperty() {} }, setAttribute(name, value) { this[name] = value; }, getAttribute(name) { return this[name]; }, remove() { nodes.delete(this.id); }, click() {}, before() {} });
    const store = { classicThemes: { active: 'night-transit', perProfile: {}, custom: [] } };
    let downloaded;
    class TestURL extends URL {
        static createObjectURL(blob) { downloaded = blob; return 'blob:test'; }
        static revokeObjectURL() {}
    }
    const sandbox = vm.createContext({
        URL: TestURL, Blob, console, setTimeout: () => 0,
        location: { origin: 'http://localhost:4444' },
        localStorage: { getItem: key => cache.get(key) ?? null, setItem: (key, value) => cache.set(key, value) },
        CustomEvent: class { constructor(type, options) { this.type = type; this.detail = options.detail; } },
        document: {
            readyState: 'loading', baseURI: 'http://localhost:4444/', addEventListener() {}, removeEventListener() {}, dispatchEvent() {},
            getElementById: id => nodes.get(id), querySelector: () => null, createElement,
            head: { append: node => nodes.set(node.id, node) },
            body: { classList: { [Symbol.iterator]: () => classes.values(), add: (...items) => items.forEach(x => classes.add(x)), remove: x => classes.delete(x) },
                style: { setProperty: (key, value) => values.set(key, value), removeProperty: key => values.delete(key) }, prepend: node => nodes.set(node.id, node) },
        },
        fetch: async () => ({ ok: true, text: async () => css }),
    });
    vm.runInContext(source.replace(/^export /gm, '') + '\n globalThis.testApi = { normalizeProfile, prefsFor, updatePrefs, resolve, applyActive, renderPanel, bindPanel, exportActive, importFile, profiles, setContext(value) { context = value; } };', sandbox);
    const api = sandbox.testApi;
    api.setContext({ extensionSettings: store, saveSettingsDebounced() {} });
    const profile = api.normalizeProfile(raw, { baseUrl: 'http://localhost:4444/classic-themes/night-transit/', builtIn: true });
    api.profiles.set(profile.id, profile);
    api.profiles.set('classico', api.normalizeProfile({ format: 'classic-theme@1', id: 'classico', name: 'Classic' }, { builtIn: true }));
    api.bindPanel();
    const click = (action, value, id) => handlers.click({ target: { closest() { return this; }, matches: () => false, dataset: { action, value, id }, getAttribute: () => null } });
    return { api, profile, store: store.classicThemes, values, classes, cache, rootNode, click, download: () => downloaded };
}

test('one profile switches palette, keeps layout, font and effects, and caches the selected mode', () => {
    const t = setup();
    t.api.applyActive();
    assert.equal(t.values.get('--ct-accent'), '#F2B544');
    t.click('font', '1');
    t.api.updatePrefs(t.profile, { effects: { ...t.api.prefsFor(t.profile).effects, glow: true }, intensity: 3 });
    t.click('mode', 'light');
    assert.equal(t.store.active, 'night-transit');
    assert.equal(t.values.get('--SmartThemeBodyColor'), '#20282C');
    assert.equal(t.values.get('--ct-accent'), '#174E88');
    assert.match(t.values.get('--ct-story-font'), /Geist/);
    assert.ok(t.classes.has('ct-fx-glow'));
    assert.ok(t.classes.has('ct-k3'));
    assert.ok(t.classes.has('ct-layout-lanterna'));
    assert.ok(t.classes.has('ct-appearance-light'));
    assert.ok(!t.classes.has('ct-appearance-dark'));
    assert.ok(JSON.parse(t.cache.get('ct-theme-cache-v1')).classes.includes('ct-appearance-light'));
    assert.match(t.rootNode.innerHTML, /aria-pressed="true" data-action="mode" data-value="light"/);
    const reloaded = setup();
    reloaded.store.perProfile = JSON.parse(JSON.stringify(t.store.perProfile));
    reloaded.api.applyActive();
    assert.equal(reloaded.values.get('--SmartThemeBodyColor'), '#20282C');
    assert.match(reloaded.values.get('--ct-story-font'), /Geist/);
    t.click('mode', 'dark');
    assert.equal(t.values.get('--ct-accent'), '#F2B544');
});

test('explicit accent survives mode changes, uses readable ink, and reset restores defaults', () => {
    const t = setup();
    t.click('accent', '#F2B544');
    t.click('mode', 'light');
    assert.equal(t.values.get('--ct-accent'), '#F2B544');
    assert.equal(t.values.get('--ct-accent-ink'), '#000000');
    assert.match(t.rootNode.innerHTML, /data-value="#F2B544"/);
    t.click('reset');
    assert.equal(t.api.prefsFor(t.profile).mode, 'dark');
    t.click('mode', 'light');
    assert.equal(t.values.get('--ct-accent'), '#174E88');
    assert.equal(t.values.get('--ct-accent-ink'), '#FFFFFF');
});

test('Classic removes mode classes, variables, fonts and stylesheet; reselecting restores Light', () => {
    const t = setup();
    t.click('mode', 'light');
    t.click('pick', undefined, 'classico');
    assert.ok(!t.classes.has('ct-appearance-light'));
    assert.ok(t.classes.has('existing-class'));
    assert.ok(!t.values.has('--nt-canvas'));
    assert.ok(!t.values.has('--SmartThemeBodyColor'));
    assert.doesNotMatch(t.rootNode.innerHTML, /data-action="mode"/);
    t.click('pick', undefined, 'night-transit');
    assert.equal(t.values.get('--nt-canvas'), '#ECEEEB');
});

test('legacy profile preferences and invalid modes fall back safely', () => {
    const t = setup();
    const legacy = t.api.normalizeProfile({ format: 'classic-theme@1', id: 'legacy', name: 'Legacy', accents: ['#abcdef'] });
    t.store.perProfile.legacy = { accent: '#123456', intensity: 1 };
    assert.equal(t.api.prefsFor(legacy).accent, '#123456');
    assert.equal(t.api.prefsFor(legacy).mode, null);
    t.store.perProfile['night-transit'] = { mode: 'invalid' };
    assert.equal(t.api.prefsFor(t.profile).mode, 'dark');
    t.click('mode', 'invalid');
    assert.equal(t.store.perProfile['night-transit'].mode, 'invalid');
    const dirty = t.api.normalizeProfile({ ...raw, defaultMode: 'bogus', modes: { light: { variables: { '--valid': '#fff', '--bad': 'red; color:black', 'color': 'red' }, accents: ['url(evil)', '#123456'] }, evil: { variables: {} } } });
    assert.equal(dirty.defaultMode, 'light');
    assert.deepEqual(JSON.parse(JSON.stringify(dirty.modes)), { light: { variables: { '--valid': '#fff' }, accents: ['#123456'] } });
});

test('export/import retains both modes and selected Light with correctly scoped imported CSS', async () => {
    const t = setup();
    t.click('mode', 'light');
    await t.api.exportActive();
    const exported = JSON.parse(await t.download().text());
    assert.equal(exported.defaultMode, 'light');
    assert.ok(exported.modes.dark && exported.modes.light);
    await t.api.importFile({ text: async () => JSON.stringify(exported) });
    assert.equal(t.store.active, 'night-transit-imported');
    assert.equal(t.values.get('--nt-canvas'), '#ECEEEB');
    const imported = t.api.profiles.get(t.store.active);
    assert.match(imported.css, /body\.ct-theme-night-transit-imported/);
    assert.doesNotMatch(imported.css, /body\.ct-theme-night-transit(?!-imported)/);
    t.click('mode', 'dark');
    assert.equal(t.values.get('--nt-canvas'), '#15191D');
});
