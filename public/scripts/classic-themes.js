// Classic UI fork: visual profiles ("temas"), individually switchable effects and the
// Personalização drawer (palette icon in the top bar).
//
// A profile is a small JSON file (format "classic-theme@1") that bundles three choices:
//   1. layout    - which interface shell to use ("classic" today; more can be added later);
//   2. visual    - CSS variables, fonts and an optional stylesheet;
//   3. effects   - which of the effects below start switched on.
// Built-in profiles live in public/classic-themes/<id>/theme.json (listed in index.json, which
// classic-ui/apply-classic.mjs regenerates). Profiles imported from the drawer are stored in the
// user's settings (extension_settings.classicThemes.custom). See classic-ui/TEMAS.md.
//
// Nothing here changes how SillyBunny works: with the "Clássico" profile (the default) no
// variables, stylesheets or effects are applied, so the page looks exactly as before.

const THEMES_BASE = 'classic-themes/';
const CACHE_KEY = 'ct-theme-cache-v1';
const SETTINGS_KEY = 'classicThemes';
const DEFAULT_PROFILE_ID = 'classico';
const FORMAT_PREFIX = 'classic-theme@1';
const MOTE_COUNT = 26;

/** Effects the engine knows. A profile can only switch these on or off (see TEMAS.md). */
export const EFFECTS = Object.freeze([
    { id: 'lantern', name: 'Lanterna', desc: 'Uma luz suave segue o mouse pela tela.' },
    { id: 'halo', name: 'Halo', desc: 'Anel de luz girando em volta do avatar da última resposta.' },
    { id: 'shine', name: 'Reflexo', desc: 'Um brilho atravessa cartões de personagem e botões quando você passa o mouse.' },
    { id: 'motes', name: 'Poeira de estrelas', desc: 'Partículas que piscam e sobem devagar no fundo.' },
    { id: 'aura', name: 'Aurora', desc: 'Nuvens de cor bem suaves se movendo atrás do chat.' },
    { id: 'blur', name: 'Entrada com desfoque', desc: 'A mensagem nova aparece saindo de um leve desfoque.' },
    { id: 'glow', name: 'Brilho nos botões', desc: 'Botões, ícones abertos e caixas marcadas ganham um contorno luminoso.' },
]);
const EFFECT_IDS = EFFECTS.map(effect => effect.id);

/** Interface shells. Only "classic" exists for now; the rest are shown as coming later. */
const LAYOUTS = Object.freeze([
    { id: 'classic', name: 'Clássico', desc: 'Ícones na barra de cima e gavetas por cima do chat. Igual ao SillyTavern.', available: true },
    { id: 'lanterna', name: 'Lanterna', desc: 'Barra lateral com nomes, painel de Agents ao lado e telas inteiras para personagens.', available: false },
]);

const DEFAULT_ACCENTS = ['#E18A24', '#E8C27A', '#B7A6FF', '#8AB8FF', '#67D4AE', '#F2A3B9'];
const INTENSITIES = [
    { value: 1, label: 'Suave' },
    { value: 2, label: 'Equilibrada' },
    { value: 3, label: 'Intensa' },
];

/** @type {Map<string, any>} */
const profiles = new Map();
let context = null;
let settings = null;
let appliedVariables = [];
let lanternFrame = 0;
let reducedMotionQuery = null;

/* ----------------------------------------------------------------------------------------- */
/* Helpers                                                                                     */
/* ----------------------------------------------------------------------------------------- */

function escapeHtml(value) {
    return String(value ?? '').replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', '\'': '&#39;' }[ch]));
}

function isSafeCssValue(value) {
    return typeof value === 'string' && value.length < 400 && !/[;{}<>]/.test(value);
}

function isSafeColor(value) {
    return typeof value === 'string' && /^(#[0-9a-f]{3,8}|rgba?\([\d\s.,%]+\)|hsla?\([\d\s.,%deg]+\))$/i.test(value.trim());
}

function slugify(value) {
    return String(value ?? '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '')
        .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48);
}

function readCache() {
    try {
        return JSON.parse(localStorage.getItem(CACHE_KEY) || 'null');
    } catch {
        return null;
    }
}

function writeCache(resolved) {
    try {
        localStorage.setItem(CACHE_KEY, JSON.stringify(resolved));
    } catch { /* storage full or unavailable: the page still works, it just applies a bit later */ }
}

/**
 * Checks a profile and returns a clean copy, or throws with a message in Portuguese.
 * @param {any} raw Parsed theme.json
 * @param {{ baseUrl?: string, version?: string, builtIn?: boolean }} [origin]
 */
export function normalizeProfile(raw, origin = {}) {
    if (!raw || typeof raw !== 'object') {
        throw new Error('O arquivo não é um perfil válido.');
    }
    if (typeof raw.format !== 'string' || !raw.format.startsWith(FORMAT_PREFIX)) {
        throw new Error(`Campo "format" precisa ser "${FORMAT_PREFIX}".`);
    }
    const id = slugify(raw.id);
    if (!id) {
        throw new Error('Campo "id" está vazio ou inválido (use letras minúsculas, números e hífen).');
    }
    if (typeof raw.name !== 'string' || !raw.name.trim()) {
        throw new Error('Campo "name" está vazio.');
    }

    const variables = {};
    for (const [key, value] of Object.entries(raw.variables ?? {})) {
        if (/^--[A-Za-z0-9_-]+$/.test(key) && isSafeCssValue(String(value))) {
            variables[key] = String(value);
        }
    }

    const effects = {};
    for (const effectId of EFFECT_IDS) {
        effects[effectId] = Boolean(raw.effects?.[effectId]);
    }

    const resolveUrl = (path) => {
        if (typeof path !== 'string' || !path) return null;
        if (/^(data:|https?:)/i.test(path)) return path;
        if (!origin.baseUrl) return null;
        const url = new URL(path, origin.baseUrl);
        if (origin.version) url.searchParams.set('v', origin.version);
        return url.pathname + url.search;
    };

    const fonts = (Array.isArray(raw.fonts) ? raw.fonts : [])
        .map(font => ({
            family: String(font?.family ?? '').replace(/["\\;{}<>]/g, '').trim(),
            src: resolveUrl(font?.src),
            weight: /^[\d ]+$/.test(String(font?.weight ?? '400')) ? String(font?.weight ?? '400') : '400',
            style: font?.style === 'italic' ? 'italic' : 'normal',
        }))
        .filter(font => font.family && font.src);

    const accents = (Array.isArray(raw.accents) ? raw.accents : []).filter(isSafeColor).slice(0, 8);
    const storyFonts = (Array.isArray(raw.storyFonts) ? raw.storyFonts : [])
        .filter(item => item && typeof item.label === 'string' && isSafeCssValue(item.value))
        .slice(0, 5)
        .map(item => ({ label: item.label.slice(0, 24), value: item.value }));

    const preview = raw.preview && typeof raw.preview === 'object' ? raw.preview : {};
    const layout = LAYOUTS.some(item => item.id === raw.layout) ? raw.layout : 'classic';

    return {
        format: FORMAT_PREFIX,
        id,
        name: raw.name.trim().slice(0, 40),
        description: String(raw.description ?? '').slice(0, 240),
        author: String(raw.author ?? '').slice(0, 60),
        version: String(raw.version ?? '1.0.0').slice(0, 20),
        layout,
        preview: {
            background: isSafeColor(preview.background) ? preview.background : '#1b1b1e',
            text: isSafeColor(preview.text) ? preview.text : '#dcdcd2',
            displayFont: isSafeCssValue(preview.displayFont) ? preview.displayFont : 'inherit',
            colors: (Array.isArray(preview.colors) ? preview.colors : []).filter(isSafeColor).slice(0, 5),
            orb: Boolean(preview.orb),
        },
        variables,
        fonts,
        stylesheet: resolveUrl(raw.stylesheet),
        css: typeof raw.css === 'string' ? raw.css.slice(0, 200_000) : '',
        accents,
        storyFonts,
        effects,
        builtIn: Boolean(origin.builtIn),
    };
}

/* ----------------------------------------------------------------------------------------- */
/* Settings                                                                                    */
/* ----------------------------------------------------------------------------------------- */

function getSettings() {
    if (settings) return settings;
    const store = context?.extensionSettings;
    if (!store) return null;
    store[SETTINGS_KEY] ??= {};
    settings = store[SETTINGS_KEY];
    settings.active ??= DEFAULT_PROFILE_ID;
    settings.reduceMotion ??= true;
    settings.perProfile ??= {};
    settings.custom ??= [];
    return settings;
}

function saveSettings() {
    context?.saveSettingsDebounced?.();
}

function defaultPrefs(profile) {
    return {
        effects: { ...profile.effects },
        intensity: 2,
        accent: profile.accents[0] ?? DEFAULT_ACCENTS[0],
        storyFont: profile.storyFonts.length ? 0 : -1,
    };
}

function prefsFor(profile) {
    const stored = getSettings()?.perProfile?.[profile.id];
    const base = defaultPrefs(profile);
    if (!stored) return base;
    return {
        effects: { ...base.effects, ...(stored.effects ?? {}) },
        intensity: [1, 2, 3].includes(stored.intensity) ? stored.intensity : base.intensity,
        accent: isSafeColor(stored.accent) ? stored.accent : base.accent,
        storyFont: Number.isInteger(stored.storyFont) && stored.storyFont < profile.storyFonts.length ? stored.storyFont : base.storyFont,
    };
}

function updatePrefs(profile, change) {
    const store = getSettings();
    if (!store) return;
    store.perProfile[profile.id] = { ...prefsFor(profile), ...change };
    saveSettings();
}

/* ----------------------------------------------------------------------------------------- */
/* Applying a profile                                                                          */
/* ----------------------------------------------------------------------------------------- */

function resolve(profile, prefs, reduceMotion) {
    const effects = EFFECT_IDS.filter(effectId => prefs.effects[effectId]);
    const variables = { ...profile.variables, '--ct-accent': prefs.accent };
    if (prefs.storyFont >= 0 && profile.storyFonts[prefs.storyFont]) {
        variables['--ct-story-font'] = profile.storyFonts[prefs.storyFont].value;
    }
    const fontsCss = profile.fonts.map(font => `@font-face{font-family:"${font.family}";src:url("${font.src}") format("woff2");font-weight:${font.weight};font-style:${font.style};font-display:swap;}`).join('\n');
    return {
        id: profile.id,
        classes: [`ct-theme-${profile.id}`, `ct-k${prefs.intensity}`, ...effects.map(effectId => `ct-fx-${effectId}`), ...(reduceMotion ? ['ct-rm'] : [])],
        variables,
        fontsCss,
        stylesheet: profile.stylesheet,
        css: profile.css,
        hasEffects: effects.length > 0,
        lantern: effects.includes('lantern'),
    };
}

function setStyleTag(id, text) {
    let tag = document.getElementById(id);
    if (!text) {
        tag?.remove();
        return;
    }
    if (!tag) {
        tag = document.createElement('style');
        tag.id = id;
        document.head.append(tag);
    }
    if (tag.textContent !== text) tag.textContent = text;
}

function setStylesheet(href) {
    let link = /** @type {HTMLLinkElement|null} */ (document.getElementById('ct-theme-stylesheet'));
    if (!href) {
        link?.remove();
        return;
    }
    if (!link) {
        link = document.createElement('link');
        link.id = 'ct-theme-stylesheet';
        link.rel = 'stylesheet';
        // After every other stylesheet so theme rules win, but user.css (custom CSS) still loads last.
        const userCss = document.querySelector('link[href^="css/user.css"]');
        if (userCss) userCss.before(link); else document.head.append(link);
    }
    if (link.getAttribute('href') !== href) link.setAttribute('href', href);
}

function ensureFxLayer() {
    let layer = document.getElementById('ct-fx-layer');
    if (layer || !document.body) return layer;
    layer = document.createElement('div');
    layer.id = 'ct-fx-layer';
    layer.setAttribute('aria-hidden', 'true');
    const motes = Array.from({ length: MOTE_COUNT }, (_, i) => {
        const x = (i * 37 + 11) % 100;
        const y = (i * 53 + 7) % 100;
        return `<span style="left:${x}%;top:${y}%;--d:${3 + (i % 5)}s;--f:${14 + (i % 7) * 3}s;--dl:-${i % 9}s"></span>`;
    }).join('');
    layer.innerHTML = `<div class="ct-aura"><i></i><i></i><i></i></div><div class="ct-motes">${motes}</div><div class="ct-lantern"></div>`;
    const background = document.getElementById('bg1');
    if (background) background.after(layer); else document.body.prepend(layer);
    return layer;
}

function onPointerMove(event) {
    if (lanternFrame) return;
    const { clientX, clientY } = event;
    lanternFrame = requestAnimationFrame(() => {
        lanternFrame = 0;
        const layer = document.getElementById('ct-fx-layer');
        layer?.style.setProperty('--ct-mx', `${clientX}px`);
        layer?.style.setProperty('--ct-my', `${clientY}px`);
    });
}

function applyResolved(resolved) {
    const body = document.body;
    if (!body || !resolved) return;

    for (const cls of [...body.classList]) {
        if (/^ct-(theme-|fx-|k\d|rm$)/.test(cls)) body.classList.remove(cls);
    }
    body.classList.add(...resolved.classes);

    for (const name of appliedVariables) body.style.removeProperty(name);
    appliedVariables = [];
    for (const [name, value] of Object.entries(resolved.variables ?? {})) {
        body.style.setProperty(name, value);
        appliedVariables.push(name);
    }

    setStyleTag('ct-theme-fonts', resolved.fontsCss);
    setStylesheet(resolved.stylesheet);
    setStyleTag('ct-theme-inline', resolved.css);

    if (resolved.hasEffects) ensureFxLayer();
    document.removeEventListener('pointermove', onPointerMove);
    if (resolved.lantern) document.addEventListener('pointermove', onPointerMove, { passive: true });
}

function shouldReduceMotion() {
    return Boolean(getSettings()?.reduceMotion ?? true) && Boolean(reducedMotionQuery?.matches);
}

function activeProfile() {
    const id = getSettings()?.active ?? DEFAULT_PROFILE_ID;
    return profiles.get(id) ?? profiles.get(DEFAULT_PROFILE_ID) ?? [...profiles.values()][0];
}

function applyActive() {
    const profile = activeProfile();
    if (!profile) return;
    const resolved = resolve(profile, prefsFor(profile), shouldReduceMotion());
    applyResolved(resolved);
    writeCache(resolved);
}

/* ----------------------------------------------------------------------------------------- */
/* Loading profiles                                                                            */
/* ----------------------------------------------------------------------------------------- */

async function loadBuiltInProfiles() {
    let index = { themes: [] };
    try {
        const response = await fetch(`${THEMES_BASE}index.json`, { cache: 'no-cache' });
        if (response.ok) index = await response.json();
    } catch (error) {
        console.warn('[Classic Themes] Could not read classic-themes/index.json', error);
    }
    const entries = Array.isArray(index.themes) ? index.themes : [];
    await Promise.all(entries.map(async (entry) => {
        try {
            const folder = slugify(entry.id);
            if (!folder) return;
            const baseUrl = new URL(`${THEMES_BASE}${folder}/`, document.baseURI).href;
            const query = entry.v ? `?v=${encodeURIComponent(entry.v)}` : '';
            const response = await fetch(`${THEMES_BASE}${folder}/theme.json${query}`, { cache: 'no-cache' });
            if (!response.ok) throw new Error(`HTTP ${response.status}`);
            const profile = normalizeProfile(await response.json(), { baseUrl, version: entry.v, builtIn: true });
            profiles.set(profile.id, profile);
        } catch (error) {
            console.warn(`[Classic Themes] Skipped theme "${entry?.id}":`, error);
        }
    }));
    // The default must always exist, even if its folder is missing.
    if (!profiles.has(DEFAULT_PROFILE_ID)) {
        profiles.set(DEFAULT_PROFILE_ID, normalizeProfile({ format: FORMAT_PREFIX, id: DEFAULT_PROFILE_ID, name: 'Clássico', description: 'O visual de sempre.' }, { builtIn: true }));
    }
}

function loadCustomProfiles() {
    for (const raw of getSettings()?.custom ?? []) {
        try {
            const profile = normalizeProfile(raw);
            if (!profiles.has(profile.id) || !profiles.get(profile.id).builtIn) profiles.set(profile.id, profile);
        } catch (error) {
            console.warn('[Classic Themes] Skipped an imported profile:', error);
        }
    }
}

/* ----------------------------------------------------------------------------------------- */
/* The Personalização drawer                                                                    */
/* ----------------------------------------------------------------------------------------- */

function profileCard(profile, isActive) {
    const p = profile.preview;
    const dots = p.colors.map(color => `<i style="background:${color}"></i>`).join('');
    const stars = p.orb ? '<span class="ct-th-star" style="left:22%;top:26%"></span><span class="ct-th-star" style="left:48%;top:14%"></span><span class="ct-th-star" style="left:64%;top:48%"></span><span class="ct-th-star" style="left:14%;top:58%"></span><span class="ct-th-orb"></span>' : '';
    const layoutName = LAYOUTS.find(item => item.id === profile.layout)?.name ?? 'Clássico';
    const effectCount = EFFECT_IDS.filter(effectId => profile.effects[effectId]).length;
    const meta = `Layout ${layoutName} · ${effectCount ? `${effectCount} efeito${effectCount > 1 ? 's' : ''}` : 'sem efeitos'}${profile.builtIn ? '' : ' · importado'}`;
    return `
        <div class="ct-card-wrap">
            <button type="button" class="ct-card${isActive ? ' is-active' : ''}" role="radio" aria-checked="${isActive}" data-action="pick" data-id="${escapeHtml(profile.id)}">
                <span class="ct-thumb" style="background:${p.background};color:${p.text}" aria-hidden="true">
                    ${stars}
                    <span class="ct-th-aa" style="font-family:${escapeHtml(p.displayFont)}">Aa</span>
                    <span class="ct-th-dots">${dots}</span>
                </span>
                <span class="ct-card-body">
                    <span class="ct-card-name">${escapeHtml(profile.name)}${isActive ? '<span class="ct-badge">Em uso</span>' : ''}</span>
                    <span class="ct-card-desc">${escapeHtml(profile.description)}</span>
                    <span class="ct-card-meta">${escapeHtml(meta)}</span>
                </span>
            </button>
            ${profile.builtIn ? '' : `<button type="button" class="ct-card-del" data-action="delete" data-id="${escapeHtml(profile.id)}" title="Remover perfil importado" aria-label="Remover ${escapeHtml(profile.name)}"><i class="fa-solid fa-xmark"></i></button>`}
        </div>`;
}

function layoutCard(layout, isActive) {
    const wire = layout.id === 'classic'
        ? '<span class="ct-w-top"><i></i><i></i><i></i><i></i><i></i><i></i><i></i></span><span class="ct-w-chat ct-w-chat-top"><b></b><b style="width:70%"></b><b style="width:86%"></b></span>'
        : '<span class="ct-w-rail"><i></i><i></i><i></i><i></i></span><span class="ct-w-chat"><b></b><b style="width:70%"></b><b style="width:86%"></b></span><span class="ct-w-side"><b></b><b></b><b></b></span>';
    const badge = isActive ? '<span class="ct-badge">Em uso</span>' : (layout.available ? '' : '<span class="ct-badge ct-badge-soft">Em breve</span>');
    return `
        <button type="button" class="ct-card ct-layout${isActive ? ' is-active' : ''}" role="radio" aria-checked="${isActive}" ${layout.available ? '' : 'aria-disabled="true"'} data-action="layout" data-id="${layout.id}">
            <span class="ct-wire" aria-hidden="true">${wire}</span>
            <span class="ct-card-body">
                <span class="ct-card-name">${escapeHtml(layout.name)}${badge}</span>
                <span class="ct-card-desc">${escapeHtml(layout.desc)}</span>
            </span>
        </button>`;
}

const DEMOS = {
    lantern: '<span class="ct-d-lantern"></span>',
    halo: '<span class="ct-d-ring"></span><i class="ct-d-core"></i>',
    shine: '<span class="ct-d-card"></span>',
    motes: '<span class="ct-d-dot" style="left:18%;top:30%"></span><span class="ct-d-dot" style="left:52%;top:62%;animation-delay:-.7s"></span><span class="ct-d-dot" style="left:76%;top:24%;animation-delay:-1.3s"></span><span class="ct-d-dot" style="left:34%;top:74%;animation-delay:-.4s"></span>',
    aura: '<span class="ct-d-blob"></span><span class="ct-d-blob ct-d-blob2"></span>',
    blur: '<span class="ct-d-txt">“Olá…”</span>',
    glow: '<span class="ct-d-btn"></span>',
};

function renderPanel() {
    const root = document.getElementById('ct_personalize');
    const store = getSettings();
    if (!root || !store) return;
    const profile = activeProfile();
    const prefs = prefsFor(profile);
    const onCount = EFFECT_IDS.filter(effectId => prefs.effects[effectId]).length;
    const allOn = onCount === EFFECT_IDS.length;
    const accents = profile.accents.length ? profile.accents : DEFAULT_ACCENTS;
    const scroller = root.closest('.drawer-content');
    const scrollTop = scroller?.scrollTop ?? 0;

    const sortedProfiles = [...profiles.values()].sort((a, b) => (a.id === DEFAULT_PROFILE_ID ? -1 : b.id === DEFAULT_PROFILE_ID ? 1 : Number(b.builtIn) - Number(a.builtIn) || a.name.localeCompare(b.name)));

    root.innerHTML = `
        <div class="ct-head">
            <h3 class="margin0">Personalização</h3>
            <div class="ct-head-actions">
                <button type="button" class="menu_button ct-btn" data-action="import"><i class="fa-solid fa-file-import"></i><span>Importar perfil</span></button>
                <button type="button" class="menu_button ct-btn" data-action="export"><i class="fa-solid fa-file-export"></i><span>Exportar</span></button>
                <input type="file" id="ct_import_file" accept=".json,application/json" hidden>
            </div>
        </div>
        <p class="ct-lead">Escolha um perfil visual e ajuste o que quiser. As mudanças aparecem na hora.</p>

        <section class="ct-section" aria-labelledby="ct_h_profiles">
            <h4 class="ct-h" id="ct_h_profiles">Perfil visual</h4>
            <p class="ct-sub">Cada perfil traz suas próprias cores, fontes e efeitos.</p>
            <div class="ct-grid" role="radiogroup" aria-labelledby="ct_h_profiles">
                ${sortedProfiles.map(item => profileCard(item, item.id === profile.id)).join('')}
            </div>
        </section>

        <section class="ct-section" aria-labelledby="ct_h_layout">
            <h4 class="ct-h" id="ct_h_layout">Layout</h4>
            <p class="ct-sub">Onde ficam os menus. Chats, personagens e Agents são os mesmos em qualquer layout.</p>
            <div class="ct-grid ct-grid-2" role="radiogroup" aria-labelledby="ct_h_layout">
                ${LAYOUTS.map(layout => layoutCard(layout, layout.id === 'classic')).join('')}
            </div>
        </section>

        <div class="ct-columns">
            <section class="ct-section ct-box" aria-labelledby="ct_h_fx">
                <div class="ct-box-head">
                    <div>
                        <h4 class="ct-h" id="ct_h_fx">Efeitos</h4>
                        <p class="ct-sub">${onCount} de ${EFFECT_IDS.length} ligados. Ligue só os que quiser.</p>
                    </div>
                    <label class="ct-switch-wrap" title="Ligar ou desligar todos">
                        <span class="ct-sr">Todos os efeitos</span>
                        <input type="checkbox" role="switch" class="ct-switch" data-action="fx-all" ${allOn ? 'checked' : ''}>
                    </label>
                </div>
                ${EFFECTS.map(effect => `
                    <label class="ct-row${prefs.effects[effect.id] ? '' : ' is-off'}">
                        <span class="ct-demo" aria-hidden="true">${DEMOS[effect.id]}</span>
                        <span class="ct-row-text"><b>${escapeHtml(effect.name)}</b><small>${escapeHtml(effect.desc)}</small></span>
                        <input type="checkbox" role="switch" class="ct-switch" data-action="fx" data-fx="${effect.id}" ${prefs.effects[effect.id] ? 'checked' : ''}>
                    </label>`).join('')}
                <div class="ct-field">
                    <span class="ct-label" id="ct_l_int">Intensidade</span>
                    <div class="ct-seg" role="group" aria-labelledby="ct_l_int">
                        ${INTENSITIES.map(item => `<button type="button" class="ct-seg-btn${prefs.intensity === item.value ? ' is-on' : ''}" aria-pressed="${prefs.intensity === item.value}" data-action="intensity" data-value="${item.value}">${item.label}</button>`).join('')}
                    </div>
                </div>
                <label class="ct-row ct-row-plain">
                    <span class="ct-row-text"><b>Respeitar “reduzir movimento”</b><small>Se o Windows pedir menos animação, os efeitos param sozinhos.</small></span>
                    <input type="checkbox" role="switch" class="ct-switch" data-action="reduce" ${store.reduceMotion ? 'checked' : ''}>
                </label>
            </section>

            <section class="ct-section ct-box" aria-labelledby="ct_h_tweaks">
                <h4 class="ct-h" id="ct_h_tweaks">Ajustes do perfil</h4>
                <p class="ct-sub">Valem só para “${escapeHtml(profile.name)}”.</p>
                <div class="ct-field">
                    <span class="ct-label" id="ct_l_acc">${profile.accents.length ? 'Cor de destaque' : 'Cor dos efeitos'}</span>
                    <div class="ct-swatches" role="radiogroup" aria-labelledby="ct_l_acc">
                        ${accents.map(color => `<button type="button" class="ct-swatch${prefs.accent.toLowerCase() === color.toLowerCase() ? ' is-on' : ''}" role="radio" aria-checked="${prefs.accent.toLowerCase() === color.toLowerCase()}" aria-label="${color}" title="${color}" style="background:${color};color:${color}" data-action="accent" data-value="${color}"></button>`).join('')}
                    </div>
                </div>
                ${profile.storyFonts.length ? `
                <div class="ct-field">
                    <span class="ct-label" id="ct_l_font">Fonte da história</span>
                    <div class="ct-seg" role="group" aria-labelledby="ct_l_font">
                        ${profile.storyFonts.map((font, i) => `<button type="button" class="ct-seg-btn${prefs.storyFont === i ? ' is-on' : ''}" aria-pressed="${prefs.storyFont === i}" style="font-family:${escapeHtml(font.value)}" data-action="font" data-value="${i}">${escapeHtml(font.label)}</button>`).join('')}
                    </div>
                </div>` : `<p class="ct-sub">Este perfil usa as cores e fontes do tema escolhido em <b>User Settings › UI Theme</b>.</p>`}
                <button type="button" class="menu_button ct-btn ct-reset" data-action="reset"><i class="fa-solid fa-rotate-left"></i><span>Restaurar padrão do perfil</span></button>
            </section>
        </div>`;

    if (scroller) scroller.scrollTop = scrollTop;
}

function notify(type, message) {
    const toast = globalThis.toastr;
    if (toast?.[type]) toast[type](message); else console.log(`[Classic Themes] ${message}`);
}

async function exportActive() {
    const profile = activeProfile();
    const out = {
        format: FORMAT_PREFIX,
        id: profile.id,
        name: profile.name,
        description: profile.description,
        author: profile.author,
        version: profile.version,
        layout: profile.layout,
        preview: profile.preview,
        variables: profile.variables,
        fonts: profile.fonts.map(font => ({ ...font, src: font.src.startsWith('/') ? new URL(font.src, location.origin).href : font.src })),
        accents: profile.accents,
        storyFonts: profile.storyFonts,
        effects: prefsFor(profile).effects,
        css: profile.css,
    };
    if (profile.stylesheet) {
        try {
            const response = await fetch(profile.stylesheet);
            if (response.ok) out.css = `${await response.text()}\n${profile.css ?? ''}`.trim();
        } catch { /* keep inline css only */ }
    }
    const blob = new Blob([JSON.stringify(out, null, 2)], { type: 'application/json' });
    const link = document.createElement('a');
    link.href = URL.createObjectURL(blob);
    link.download = `${profile.id}.json`;
    link.click();
    setTimeout(() => URL.revokeObjectURL(link.href), 1000);
}

async function importFile(file) {
    const store = getSettings();
    if (!file || !store) return;
    try {
        const raw = JSON.parse(await file.text());
        const profile = normalizeProfile(raw);
        if (profiles.get(profile.id)?.builtIn) {
            raw.id = `${profile.id}-importado`;
        }
        const clean = normalizeProfile(raw);
        const stored = { ...raw, id: clean.id };
        store.custom = store.custom.filter(item => slugify(item.id) !== clean.id).concat([stored]);
        profiles.set(clean.id, clean);
        store.active = clean.id;
        saveSettings();
        applyActive();
        renderPanel();
        notify('success', `Perfil “${clean.name}” importado.`);
    } catch (error) {
        notify('error', `Não consegui importar: ${error.message}`);
    }
}

function bindPanel() {
    const root = document.getElementById('ct_personalize');
    if (!root || root.dataset.bound) return;
    root.dataset.bound = 'true';

    root.addEventListener('click', (event) => {
        const target = /** @type {HTMLElement} */ (event.target).closest('[data-action]');
        if (!target || target.matches('input')) return;
        const store = getSettings();
        const profile = activeProfile();
        if (!store || !profile) return;
        const action = target.dataset.action;

        if (action === 'pick') {
            store.active = target.dataset.id;
            saveSettings();
        } else if (action === 'layout') {
            if (target.getAttribute('aria-disabled') === 'true') {
                notify('info', 'O layout Lanterna vem numa próxima etapa. Por enquanto só o Clássico está pronto.');
            }
            return;
        } else if (action === 'intensity') {
            updatePrefs(profile, { intensity: Number(target.dataset.value) });
        } else if (action === 'accent') {
            updatePrefs(profile, { accent: target.dataset.value });
        } else if (action === 'font') {
            updatePrefs(profile, { storyFont: Number(target.dataset.value) });
        } else if (action === 'reset') {
            delete store.perProfile[profile.id];
            saveSettings();
        } else if (action === 'delete') {
            const id = target.dataset.id;
            store.custom = store.custom.filter(item => slugify(item.id) !== id);
            delete store.perProfile[id];
            profiles.delete(id);
            if (store.active === id) store.active = DEFAULT_PROFILE_ID;
            saveSettings();
        } else if (action === 'import') {
            root.querySelector('#ct_import_file')?.click();
            return;
        } else if (action === 'export') {
            void exportActive();
            return;
        } else {
            return;
        }
        applyActive();
        renderPanel();
    });

    root.addEventListener('change', (event) => {
        const input = /** @type {HTMLInputElement} */ (event.target);
        const store = getSettings();
        const profile = activeProfile();
        if (!store || !profile) return;
        if (input.id === 'ct_import_file') {
            void importFile(input.files?.[0]);
            input.value = '';
            return;
        }
        const action = input.dataset.action;
        if (action === 'fx') {
            const prefs = prefsFor(profile);
            updatePrefs(profile, { effects: { ...prefs.effects, [input.dataset.fx]: input.checked } });
        } else if (action === 'fx-all') {
            updatePrefs(profile, { effects: Object.fromEntries(EFFECT_IDS.map(effectId => [effectId, input.checked])) });
        } else if (action === 'reduce') {
            store.reduceMotion = input.checked;
            saveSettings();
        } else {
            return;
        }
        applyActive();
        renderPanel();
    });
}

/* ----------------------------------------------------------------------------------------- */
/* Start-up                                                                                    */
/* ----------------------------------------------------------------------------------------- */

let started = false;
async function start() {
    if (started || !getSettings()) return;
    started = true;
    await loadBuiltInProfiles();
    loadCustomProfiles();
    applyActive();
    bindPanel();
    renderPanel();
}

function bindAppEvents() {
    try {
        context = globalThis.SillyTavern?.getContext?.() ?? null;
    } catch {
        return false; // script.js is still initializing
    }
    if (!context?.eventSource || !context?.event_types) {
        context = null;
        return false;
    }
    const { eventSource, event_types } = context;
    eventSource.on(event_types.EXTENSION_SETTINGS_LOADED, () => void start());
    eventSource.on(event_types.APP_READY, () => void start());
    return true;
}

function init() {
    reducedMotionQuery = window.matchMedia?.('(prefers-reduced-motion: reduce)') ?? null;
    reducedMotionQuery?.addEventListener?.('change', () => { if (started) applyActive(); });
    // Paint the last used profile right away (before settings load) to avoid a flash of the default look.
    applyResolved(readCache());
    if (!bindAppEvents()) {
        const timer = window.setInterval(() => {
            if (bindAppEvents()) window.clearInterval(timer);
        }, 100);
    }
}

if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init, { once: true });
} else {
    init();
}

globalThis.SillyBunnyClassicThemes = { EFFECTS, LAYOUTS, normalizeProfile, profiles, applyActive };
