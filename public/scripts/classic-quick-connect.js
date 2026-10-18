// Classic UI fork: Quick Connection switcher.
//
// A link button in the message box opens a small menu: saved connection profiles on the left, the
// models of the chosen profile on the right. Picking a profile switches to it right away (the same
// thing as choosing it in API Connections -> Connection Profile). Picking a model sets it and saves
// it into that profile. Models can be pinned with a star so they stay on top.
//
// Profiles come from the Connection Manager extension (extension_settings.connectionManager) and
// are switched with its own /profile command, so nothing here duplicates its logic.

import { helpButton, closeHelp } from './classic-help.js';

const HELP_HTML = `
<p>Switch the AI connection without opening the API panel.</p>
<ul>
<li><b>Left column:</b> your saved <i>Connection Profiles</i>. Click one to use it now.</li>
<li><b>Right column:</b> the models of that connection. Click a model to use it. The choice is saved into the profile.</li>
<li><b>Star</b> a model to pin it to the top.</li>
<li>Type a model ID in the search box and press <b>Enter</b> to use a model that is not listed.</li>
<li><b>Refresh</b> reloads the model list from the provider.</li>
</ul>
<p>To create or edit profiles, use <b>API Connections &rarr; Connection Profile</b>, or the <b>Manage</b> button at the bottom.</p>`;

/** Where each API keeps its model control (mirrors getModelOptions in slash-commands.js). */
const MODEL_CONTROLS = [
    ['generic_model_textgenerationwebui', 'textgenerationwebui', 'generic'],
    ['custom_model_textgenerationwebui', 'textgenerationwebui', 'ooba'],
    ['model_togetherai_select', 'textgenerationwebui', 'togetherai'],
    ['openrouter_model', 'textgenerationwebui', 'openrouter'],
    ['model_infermaticai_select', 'textgenerationwebui', 'infermaticai'],
    ['model_dreamgen_select', 'textgenerationwebui', 'dreamgen'],
    ['mancer_model', 'textgenerationwebui', 'mancer'],
    ['vllm_model', 'textgenerationwebui', 'vllm'],
    ['aphrodite_model', 'textgenerationwebui', 'aphrodite'],
    ['ollama_model', 'textgenerationwebui', 'ollama'],
    ['tabby_model', 'textgenerationwebui', 'tabby'],
    ['llamacpp_model', 'textgenerationwebui', 'llamacpp'],
    ['featherless_model', 'textgenerationwebui', 'featherless'],
    ['openai_model_id', 'openai', 'openai'],
    ['openai_model_id', 'openai', 'openai_responses'],
    ['model_claude_select', 'openai', 'claude'],
    ['model_openrouter_select', 'openai', 'openrouter'],
    ['model_ai21_select', 'openai', 'ai21'],
    ['makersuite_model_id', 'openai', 'makersuite'],
    ['model_vertexai_select', 'openai', 'vertexai'],
    ['model_mistralai_select', 'openai', 'mistralai'],
    ['custom_model_id', 'openai', 'custom'],
    ['model_cohere_select', 'openai', 'cohere'],
    ['model_perplexity_select', 'openai', 'perplexity'],
    ['model_groq_select', 'openai', 'groq'],
    ['model_chutes_select', 'openai', 'chutes'],
    ['model_siliconflow_select', 'openai', 'siliconflow'],
    ['model_minimax_select', 'openai', 'minimax'],
    ['model_electronhub_select', 'openai', 'electronhub'],
    ['model_nanogpt_select', 'openai', 'nanogpt'],
    ['model_deepseek_select', 'openai', 'deepseek'],
    ['model_aimlapi_select', 'openai', 'aimlapi'],
    ['model_xai_select', 'openai', 'xai'],
    ['model_pollinations_select', 'openai', 'pollinations'],
    ['model_moonshot_select', 'openai', 'moonshot'],
    ['model_fireworks_select', 'openai', 'fireworks'],
    ['model_cometapi_select', 'openai', 'cometapi'],
    ['model_zai_select', 'openai', 'zai'],
    ['model_workers_ai_select', 'openai', 'workers_ai'],
    ['model_linkapi_select', 'openai', 'linkapi'],
    ['model_novel_select', 'novel', null],
    ['horde_model', 'koboldhorde', null],
];

const state = {
    open: false,
    /** Profile whose models are shown (not necessarily applied yet). */
    viewProfileId: null,
    busy: false,
    query: '',
    models: /** @type {{id:string,name:string}[]} */ ([]),
    currentModel: '',
    modelsMessage: '',
};

/** @type {HTMLElement|null} */ let menu = null;
/** @type {HTMLElement|null} */ let button = null;

const ctx = () => {
    try {
        return globalThis.SillyTavern?.getContext?.();
    } catch {
        return null; // the app is still starting
    }
};

function settings() {
    const ext = ctx()?.extensionSettings;
    if (!ext) return { pinned: {} };
    ext.classicQuickConnect ??= { pinned: {} };
    ext.classicQuickConnect.pinned ??= {};
    return ext.classicQuickConnect;
}

function cm() {
    const ext = ctx()?.extensionSettings?.connectionManager;
    return {
        profiles: Array.isArray(ext?.profiles) ? ext.profiles : [],
        folders: Array.isArray(ext?.folders) ? ext.folders : [],
        selected: ext?.selectedProfile ?? null,
    };
}

function esc(value) {
    return String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', '\'': '&#39;' }[c]));
}

async function run(command) {
    const context = ctx();
    if (!context?.executeSlashCommandsWithOptions) throw new Error('Slash commands are not ready yet.');
    const result = await context.executeSlashCommandsWithOptions(command, { handleParserErrors: true, handleExecutionErrors: true, source: 'classic-quick-connect' });
    return result?.pipe;
}

function quoteArg(value) {
    return `"${String(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

/** Reads the model control of the API that is active right now. */
async function readActiveModels() {
    const context = ctx();
    let subType = null;
    if (context?.mainApi === 'openai') {
        const { oai_settings } = await import('./openai.js');
        subType = oai_settings?.chat_completion_source ?? null;
    } else if (context?.mainApi === 'textgenerationwebui') {
        const { textgenerationwebui_settings } = await import('./textgen-settings.js');
        subType = textgenerationwebui_settings?.type ?? null;
    }
    const entry = MODEL_CONTROLS.find(([, api, type]) => api === context?.mainApi && (type === null || type === subType));
    const control = entry ? document.getElementById(entry[0]) : null;
    if (!control) return { supported: false, models: [], current: '' };

    /** @type {{id:string,name:string}[]} */
    let models = [];
    let current = '';
    if (control instanceof HTMLSelectElement) {
        current = control.value;
        models = Array.from(control.options)
            .filter(option => option.value && !option.disabled)
            .map(option => ({ id: option.value, name: option.textContent?.trim() || option.value }));
    } else if (control instanceof HTMLInputElement) {
        current = control.value;
        const list = control.list instanceof HTMLDataListElement ? Array.from(control.list.options) : [];
        models = list.map(option => ({ id: option.value, name: option.label || option.value }));
        // Custom (OpenAI-compatible) endpoints keep the fetched list in a separate select.
        const customSelect = control.id === 'custom_model_id' ? document.getElementById('model_custom_select') : null;
        if (customSelect instanceof HTMLSelectElement) {
            models.push(...Array.from(customSelect.options).filter(o => o.value).map(o => ({ id: o.value, name: o.textContent?.trim() || o.value })));
        }
        if (current && !models.some(m => m.id === current)) models.unshift({ id: current, name: current });
    }
    const seen = new Set();
    models = models.filter(m => (seen.has(m.id) ? false : (seen.add(m.id), true)));
    return { supported: true, models, current };
}

async function loadModels({ waitForList = false } = {}) {
    const deadline = Date.now() + (waitForList ? 6000 : 0);
    let result = await readActiveModels();
    while (waitForList && result.supported && result.models.length === 0 && Date.now() < deadline) {
        await new Promise(resolve => setTimeout(resolve, 400));
        result = await readActiveModels();
    }
    state.models = result.models;
    state.currentModel = result.current;
    state.modelsMessage = result.supported
        ? (result.models.length ? '' : 'No model list from this provider. Type a model ID above and press Enter.')
        : 'This API has no model list here. Change the model in the API panel.';
}

async function pickProfile(profileId) {
    const profile = cm().profiles.find(p => p.id === profileId);
    if (!profile || state.busy) return;
    state.viewProfileId = profileId;
    state.query = '';
    state.busy = true;
    state.models = [];
    state.modelsMessage = 'Connecting...';
    render();
    try {
        if (cm().selected !== profileId) {
            await run(`/profile await=true timeout=8000 ${quoteArg(profile.name)}`);
        }
        await loadModels({ waitForList: true });
    } catch (error) {
        console.error('[Quick Connection] Failed to switch profile', error);
        toastr.error(String(error?.message ?? error), 'Quick Connection');
    } finally {
        state.busy = false;
        render();
        position();
        refreshButton();
    }
}

async function pickModel(modelId) {
    const id = String(modelId ?? '').trim();
    if (!id || state.busy) return;
    state.busy = true;
    render();
    try {
        await run(`/model quiet=true ${quoteArg(id)}`);
        if (cm().selected) await run('/profile-update');
        state.currentModel = id;
        toastr.success(id, 'Model changed', { timeOut: 1800 });
        close();
    } catch (error) {
        console.error('[Quick Connection] Failed to set model', error);
        toastr.error(String(error?.message ?? error), 'Quick Connection');
    } finally {
        state.busy = false;
        if (state.open) render();
        refreshButton();
    }
}

async function refreshModels() {
    if (state.busy) return;
    state.busy = true;
    state.modelsMessage = 'Reloading the model list...';
    render();
    try {
        const context = ctx();
        const connectButton = context?.mainApi === 'openai'
            ? document.getElementById('api_button_openai')
            : context?.mainApi === 'textgenerationwebui' ? document.getElementById('api_button_textgenerationwebui') : null;
        connectButton?.click();
        await new Promise(resolve => setTimeout(resolve, 600));
        await loadModels({ waitForList: true });
    } finally {
        state.busy = false;
        render();
    }
}

function togglePin(modelId) {
    const key = state.viewProfileId ?? '_none';
    const pinned = settings().pinned;
    const list = new Set(pinned[key] ?? []);
    list.has(modelId) ? list.delete(modelId) : list.add(modelId);
    pinned[key] = [...list];
    ctx()?.saveSettingsDebounced?.();
    render();
}

function profileSubtitle(profile) {
    const parts = [profile.api, profile.model].filter(Boolean);
    return parts.join(' · ');
}

function renderProfiles() {
    const { profiles, folders, selected } = cm();
    if (!profiles.length) {
        return '<div class="ct-qc-empty">No saved profiles yet.<br>Open <b>API Connections</b>, connect, then save a <i>Connection Profile</i>.</div>';
    }
    const sorted = profiles.slice().sort((a, b) => (Number(Boolean(b.fav)) - Number(Boolean(a.fav))) || String(a.name).localeCompare(String(b.name)));
    const groups = new Map();
    groups.set(null, []);
    for (const folder of folders.slice().sort((a, b) => String(a.name).localeCompare(String(b.name)))) groups.set(folder.id, []);
    for (const profile of sorted) {
        const key = groups.has(profile.folderId) ? profile.folderId : null;
        groups.get(key).push(profile);
    }
    let html = '';
    for (const [folderId, items] of groups) {
        if (!items.length) continue;
        if (folderId) {
            const folder = folders.find(f => f.id === folderId);
            html += `<div class="ct-qc-folder"><i class="fa-solid fa-folder"></i>${esc(folder?.name)}</div>`;
        }
        for (const profile of items) {
            const classes = ['ct-qc-profile'];
            if (profile.id === selected) classes.push('is-active');
            if (profile.id === state.viewProfileId) classes.push('is-viewing');
            html += `<button type="button" class="${classes.join(' ')}" data-profile="${esc(profile.id)}">
                <span class="ct-qc-name">${profile.fav ? '<i class="fa-solid fa-star ct-qc-fav"></i>' : ''}${esc(profile.name)}</span>
                <span class="ct-qc-sub">${esc(profileSubtitle(profile))}</span>
                ${profile.id === selected ? '<i class="fa-solid fa-check ct-qc-check" title="In use"></i>' : ''}
            </button>`;
        }
    }
    return html;
}

function renderModels() {
    if (!state.viewProfileId) {
        return '<div class="ct-qc-empty">Pick a connection to see its models.</div>';
    }
    const pinnedIds = settings().pinned[state.viewProfileId] ?? [];
    const query = state.query.trim().toLowerCase();
    const matches = (m) => !query || m.id.toLowerCase().includes(query) || m.name.toLowerCase().includes(query);
    const known = new Map(state.models.map(m => [m.id, m]));
    const pinned = pinnedIds.map(id => known.get(id) ?? { id, name: id }).filter(matches);
    const rest = state.models.filter(m => !pinnedIds.includes(m.id)).filter(matches);
    const row = (m, isPinned) => `<div class="ct-qc-model${m.id === state.currentModel ? ' is-active' : ''}" data-model="${esc(m.id)}" role="button" tabindex="0">
        <span class="ct-qc-name" title="${esc(m.id)}">${esc(m.name)}</span>
        ${m.id === state.currentModel ? '<i class="fa-solid fa-check ct-qc-check"></i>' : ''}
        <button type="button" class="ct-qc-pin${isPinned ? ' is-pinned' : ''}" data-pin="${esc(m.id)}" title="${isPinned ? 'Unpin' : 'Pin to top'}"><i class="fa-${isPinned ? 'solid' : 'regular'} fa-star"></i></button>
    </div>`;
    let html = '';
    if (pinned.length) html += `<div class="ct-qc-folder"><i class="fa-solid fa-thumbtack"></i>Pinned</div>${pinned.map(m => row(m, true)).join('')}`;
    if (rest.length) html += `${pinned.length ? '<div class="ct-qc-folder"><i class="fa-solid fa-list"></i>All models</div>' : ''}${rest.map(m => row(m, false)).join('')}`;
    if (query && !known.has(state.query.trim())) {
        html += `<div class="ct-qc-model ct-qc-custom" data-model="${esc(state.query.trim())}" role="button" tabindex="0"><span class="ct-qc-name">Use "${esc(state.query.trim())}"</span></div>`;
    }
    if (!html) html = `<div class="ct-qc-empty">${esc(state.modelsMessage || 'No models match.')}</div>`;
    else if (state.modelsMessage) html = `<div class="ct-qc-note">${esc(state.modelsMessage)}</div>${html}`;
    return html;
}

function render() {
    if (!menu) return;
    const profile = cm().profiles.find(p => p.id === state.viewProfileId);
    const searchHadFocus = document.activeElement?.classList?.contains('ct-qc-search');
    const caret = /** @type {HTMLInputElement|null} */ (menu.querySelector('.ct-qc-search'))?.selectionStart ?? null;
    menu.querySelector('.ct-qc-profiles-list').innerHTML = renderProfiles();
    menu.querySelector('.ct-qc-models-title').textContent = profile ? `Models · ${profile.name}` : 'Models';
    menu.querySelector('.ct-qc-models-list').innerHTML = renderModels();
    const search = /** @type {HTMLInputElement} */ (menu.querySelector('.ct-qc-search'));
    search.disabled = !state.viewProfileId;
    if (search.value !== state.query) search.value = state.query;
    menu.classList.toggle('is-busy', state.busy);
    if (searchHadFocus) {
        search.focus();
        if (caret !== null) search.setSelectionRange(caret, caret);
    }
}

function buildMenu() {
    menu = document.createElement('div');
    menu.id = 'ct-quick-connect';
    menu.className = 'ct-qc-menu';
    menu.setAttribute('role', 'dialog');
    menu.innerHTML = `
        <div class="ct-qc-head">
            <span class="ct-qc-title"><i class="fa-solid fa-link"></i>Quick Connection</span>
            <span class="ct-qc-head-actions"></span>
        </div>
        <div class="ct-qc-body">
            <div class="ct-qc-col ct-qc-profiles">
                <div class="ct-qc-col-title">Connections</div>
                <div class="ct-qc-profiles-list ct-qc-scroll"></div>
            </div>
            <div class="ct-qc-col ct-qc-models">
                <div class="ct-qc-col-title ct-qc-models-title">Models</div>
                <div class="ct-qc-searchrow">
                    <input class="ct-qc-search text_pole" type="search" placeholder="Search or type a model ID..." autocomplete="off">
                    <button type="button" class="ct-qc-refresh" title="Reload the model list"><i class="fa-solid fa-rotate"></i></button>
                </div>
                <div class="ct-qc-models-list ct-qc-scroll"></div>
            </div>
        </div>
        <div class="ct-qc-foot">
            <span>Model changes are saved to the selected profile.</span>
            <button type="button" class="ct-qc-manage"><i class="fa-solid fa-plug"></i>Manage</button>
        </div>`;
    menu.querySelector('.ct-qc-head-actions').append(helpButton('Quick Connection', HELP_HTML));
    const closeButton = document.createElement('button');
    closeButton.type = 'button';
    closeButton.className = 'ct-qc-close';
    closeButton.title = 'Close';
    closeButton.innerHTML = '<i class="fa-solid fa-xmark"></i>';
    closeButton.addEventListener('click', close);
    menu.querySelector('.ct-qc-head-actions').append(closeButton);

    menu.addEventListener('click', (event) => {
        const target = /** @type {HTMLElement} */ (event.target);
        const pin = target.closest('[data-pin]');
        if (pin) {
            event.stopPropagation();
            togglePin(pin.getAttribute('data-pin'));
            return;
        }
        const profile = target.closest('[data-profile]');
        if (profile) return void pickProfile(profile.getAttribute('data-profile'));
        const model = target.closest('[data-model]');
        if (model) return void pickModel(model.getAttribute('data-model'));
        if (target.closest('.ct-qc-refresh')) return void refreshModels();
        if (target.closest('.ct-qc-manage')) {
            close();
            const toggle = document.querySelector('#sys-settings-button .drawer-toggle');
            /** @type {HTMLElement|null} */ (toggle)?.click();
        }
    });
    menu.addEventListener('keydown', (event) => {
        const target = /** @type {HTMLElement} */ (event.target);
        if (event.key === 'Enter' && target.matches('[data-model]')) {
            event.preventDefault();
            void pickModel(target.getAttribute('data-model'));
        }
    });
    const search = /** @type {HTMLInputElement} */ (menu.querySelector('.ct-qc-search'));
    search.addEventListener('input', () => {
        state.query = search.value;
        render();
    });
    search.addEventListener('keydown', (event) => {
        if (event.key !== 'Enter') return;
        event.preventDefault();
        const typed = search.value.trim();
        if (!typed) return;
        const query = typed.toLowerCase();
        const exact = state.models.find(m => m.id.toLowerCase() === query || m.name.toLowerCase() === query);
        const filtered = state.models.filter(m => m.id.toLowerCase().includes(query) || m.name.toLowerCase().includes(query));
        void pickModel(exact?.id ?? (filtered.length === 1 ? filtered[0].id : typed));
    });
    document.body.append(menu);
}

function position() {
    if (!menu || !button) return;
    const form = document.getElementById('send_form') ?? button;
    const rect = form.getBoundingClientRect();
    const width = Math.min(720, window.innerWidth - 16);
    menu.style.width = `${width}px`;
    const left = Math.max(8, Math.min(rect.left, window.innerWidth - width - 8));
    menu.style.left = `${left}px`;
    // Measured from the top: on narrow screens SillyTavern transforms <html>, so "bottom" would be wrong.
    const height = menu.offsetHeight || 420;
    menu.style.top = `${Math.max(8, rect.top - height - 8)}px`;
}

async function open() {
    if (!menu) buildMenu();
    state.open = true;
    state.query = '';
    state.viewProfileId = cm().selected;
    menu.classList.add('is-open');
    button?.classList.add('is-active');
    state.models = [];
    state.modelsMessage = state.viewProfileId ? 'Loading models...' : '';
    render();
    position();
    if (state.viewProfileId) {
        await loadModels();
        render();
    }
    /** @type {HTMLElement|null} */ (menu.querySelector(state.viewProfileId ? '.ct-qc-search' : '.ct-qc-profile'))?.focus();
}

function close() {
    state.open = false;
    menu?.classList.remove('is-open');
    button?.classList.remove('is-active');
    closeHelp();
}

function refreshButton() {
    if (!button) return;
    const { profiles, selected } = cm();
    const profile = profiles.find(p => p.id === selected);
    button.title = profile ? `Connection: ${profile.name}${profile.model ? ` (${profile.model})` : ''}` : 'Quick Connection: switch connection and model';
}

function buildButton() {
    if (document.getElementById('ct-quick-connect-button')) return;
    const holder = document.getElementById('leftSendForm');
    if (!holder) return;
    button = document.createElement('div');
    button.id = 'ct-quick-connect-button';
    button.className = 'fa-solid fa-link interactable';
    button.tabIndex = 0;
    button.setAttribute('role', 'button');
    button.addEventListener('click', (event) => {
        event.stopPropagation();
        state.open ? close() : void open();
    });
    button.addEventListener('keydown', (event) => {
        if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault();
            state.open ? close() : void open();
        }
    });
    holder.append(button);
    refreshButton();
}

function init() {
    buildButton();
    document.addEventListener('pointerdown', (event) => {
        if (!state.open) return;
        const target = /** @type {HTMLElement} */ (event.target);
        if (menu?.contains(target) || button?.contains(target) || target.closest('.ct-help-card, #toast-container')) return;
        close();
    });
    document.addEventListener('keydown', (event) => {
        if (event.key === 'Escape' && state.open) close();
    });
    window.addEventListener('resize', () => state.open && position());
    const wait = window.setInterval(() => {
        const context = ctx();
        if (!context?.eventSource || !context?.event_types) return;
        window.clearInterval(wait);
        buildButton();
        const { eventSource, event_types } = context;
        for (const type of [event_types.APP_READY, event_types.CONNECTION_PROFILE_LOADED, event_types.SETTINGS_UPDATED]) {
            if (type) eventSource.on(type, refreshButton);
        }
    }, 100);
}

if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init, { once: true });
} else {
    init();
}

globalThis.SillyBunnyClassicQuickConnect = { open, close };
