// Classic UI fork: "Import & Restore" (import a SillyTavern folder or backup ZIP) for the classic
// User Settings drawer. The functions below are copied unchanged from Homunculus's graphical shell
// (public/scripts/homunculus-tabs.js, which this fork does not load), together with the small helpers
// they use. Refresh this copy if Homunculus changes its importer.
import { fetchWithCsrfRetry } from './csrf-token-refresh.js';
import { refreshCsrfToken } from '../script.js';

const importerState = {
    refs: null,
    busy: false,
    report: null,
};

function getSillyTavernContext() {
    try {
        return globalThis.SillyTavern?.getContext?.() ?? null;
    } catch {
        return null;
    }
}

function createElement(tagName, { id = '', className = '', text = '', html = '', attrs = {} } = {}) {
    const element = document.createElement(tagName);
    if (id) {
        element.id = id;
    }
    if (className) {
        element.className = className;
    }
    if (text) {
        element.textContent = text;
    }
    if (html) {
        element.innerHTML = html;
    }
    for (const [key, value] of Object.entries(attrs)) {
        element.setAttribute(key, value);
    }
    return element;
}

function wait(ms) {
    return new Promise(resolve => window.setTimeout(resolve, ms));
}

function setButtonDisabled(button, disabled) {
    if (!(button instanceof HTMLElement)) {
        return;
    }
    button.toggleAttribute('disabled', Boolean(disabled));
    button.classList.toggle('is-disabled', Boolean(disabled));
}

function getRequestHeadersFromContext(context = getSillyTavernContext()) {
    if (typeof context?.getRequestHeaders === 'function') {
        return context.getRequestHeaders();
    }
    return { 'Content-Type': 'application/json' };
}

function getCsrfTokenFromHeaders(headers) {
    if (!headers || typeof headers !== 'object') {
        return '';
    }
    const token = String(headers['X-CSRF-Token'] ?? headers['x-csrf-token'] ?? '').trim();
    return !token || token === 'undefined' || token === 'null' ? '' : token;
}

async function waitForAuthorizedRequestHeaders(timeoutMs = 15000, context = getSillyTavernContext()) {
    const timeoutAt = Date.now() + timeoutMs;
    while (Date.now() < timeoutAt) {
        const headers = getRequestHeadersFromContext(context);
        if (getCsrfTokenFromHeaders(headers)) {
            return headers;
        }
        await wait(50);
    }
    return getRequestHeadersFromContext(context);
}

/* ---- copied from homunculus-tabs.js ---- */

function getImporterState() {
    return importerState;
}

function getImporterRefs() {
    return getImporterState().refs;
}

async function requestUserPrivateAction(endpoint, { body = {}, useFormData = false } = {}) {
    const buildRequest = async () => {
        const requestHeaders = await waitForAuthorizedRequestHeaders();
        const headers = useFormData
            ? (() => {
                const multipartHeaders = { ...requestHeaders };
                delete multipartHeaders['Content-Type'];
                delete multipartHeaders['content-type'];
                return multipartHeaders;
            })()
            : requestHeaders;

        return {
            method: 'POST',
            headers,
            body: useFormData ? body : JSON.stringify(body),
        };
    };

    const response = await fetchWithCsrfRetry(endpoint, buildRequest, { refreshCsrfToken });

    const text = await response.text();
    let data = null;

    try {
        data = text ? JSON.parse(text) : {};
    } catch {
        data = { message: text };
    }

    if (!response.ok) {
        throw new Error(data?.error || data?.message || text || `Request failed with status ${response.status}.`);
    }

    return data;
}

function setServerAdminPill(element, label, tone = 'neutral') {
    if (!(element instanceof HTMLElement)) {
        return;
    }

    element.textContent = label;
    element.dataset.tone = tone;
}

function setServerAdminMessage(element, message, tone = 'neutral') {
    if (!(element instanceof HTMLElement)) {
        return;
    }

    element.textContent = String(message ?? '').trim();
    element.dataset.tone = tone;
    element.hidden = !element.textContent;
}

function updateSillyTavernImportInteractivity() {
    const state = getImporterState();
    const refs = getImporterRefs();

    if (!refs) {
        return;
    }

    setButtonDisabled(refs.folderButton, state.busy);
    setButtonDisabled(refs.syncButton, state.busy);
    setButtonDisabled(refs.zipButton, state.busy);

    if (refs.pathInput instanceof HTMLInputElement) {
        refs.pathInput.disabled = state.busy;
    }
}

function setSillyTavernImportBusy(isBusy) {
    getImporterState().busy = Boolean(isBusy);
    updateSillyTavernImportInteractivity();
}

function getExtensionSyncStatusTone(status) {
    if (status === 'failed') {
        return 'danger';
    }

    if (status === 'warning') {
        return 'warn';
    }

    return 'good';
}

function getExtensionSyncStatusLabel(status) {
    if (status === 'failed') {
        return 'Failed';
    }

    if (status === 'warning') {
        return 'Needs Attention';
    }

    return 'Ready';
}

function getExtensionSyncCheckSummary(result) {
    const checks = [];
    const manifestFound = result?.checks?.manifestFound === true;
    const manifestValid = result?.checks?.manifestValid === true;
    const jsEntry = typeof result?.checks?.jsEntry === 'string' ? result.checks.jsEntry.trim() : '';
    const jsEntryExists = result?.checks?.jsEntryExists === true;
    const gitMetadataSkipped = result?.checks?.gitMetadataSkipped === true;

    checks.push(!manifestFound
        ? 'manifest missing'
        : manifestValid
            ? 'manifest OK'
            : 'manifest invalid');
    checks.push(jsEntry
        ? jsEntryExists
            ? `JS entry: ${jsEntry}`
            : `JS missing: ${jsEntry}`
        : 'no JS entry');

    if (gitMetadataSkipped) {
        checks.push('git metadata skipped');
    }

    return checks.join(' · ');
}

function renderSillyTavernExtensionSyncReport(reportData = null) {
    const refs = getImporterRefs();
    const report = refs?.report;
    const summary = refs?.reportSummary;
    const help = refs?.reportHelp;
    const list = refs?.reportList;
    const state = getImporterState();

    state.report = reportData;

    if (!(report instanceof HTMLElement) || !(summary instanceof HTMLElement) || !(help instanceof HTMLElement) || !(list instanceof HTMLElement)) {
        return;
    }

    if (!reportData || !Array.isArray(reportData.results) || reportData.results.length === 0) {
        report.hidden = true;
        summary.textContent = '';
        help.textContent = '';
        list.replaceChildren();
        return;
    }

    const results = reportData.results;
    const readyCount = Number(reportData.readyCount ?? 0) || 0;
    const warningCount = Number(reportData.warningCount ?? 0) || 0;
    const failedCount = Number(reportData.failedCount ?? 0) || 0;
    const syncedCount = readyCount + warningCount;
    const needsAttention = warningCount + failedCount > 0;
    const gitMetadataSkippedCount = Number(reportData.gitMetadataSkippedCount ?? 0)
        || results.filter(result => result?.checks?.gitMetadataSkipped === true).length;

    summary.textContent = reportData.message
        || `Synced ${syncedCount} of ${results.length} third-party extensions.`;
    help.textContent = needsAttention
        ? `If an extension still misbehaves after a reload, contact purachina with the extension name and the report below.${gitMetadataSkippedCount > 0 ? ` Git metadata was skipped on ${gitMetadataSkippedCount} extension${gitMetadataSkippedCount === 1 ? '' : 's'} to avoid permission issues, so built-in update tooling may need a reinstall later.` : ''}`
        : gitMetadataSkippedCount > 0
            ? `Reload when you are ready to activate the synced extensions. Git metadata was skipped on ${gitMetadataSkippedCount} extension${gitMetadataSkippedCount === 1 ? '' : 's'} to avoid permission issues, so built-in update tooling may need a reinstall later.`
            : 'Reload when you are ready to activate the synced extensions.';

    const items = results.map(result => {
        const card = createElement('article', { className: `sb-import-report-item is-${result?.status || 'warning'}` });
        const header = createElement('div', { className: 'sb-import-report-item-header' });
        const titleGroup = createElement('div', { className: 'sb-import-report-item-title' });
        const title = createElement('strong', { text: result?.displayName || result?.name || 'Unknown extension' });
        const metaParts = [];

        if (result?.version) {
            metaParts.push(`v${result.version}`);
        }

        if (result?.author) {
            metaParts.push(result.author);
        }

        const meta = createElement('small', {
            className: 'sb-import-report-item-meta',
            text: metaParts.join(' • '),
        });
        const pill = createElement('span', { className: 'sb-server-pill' });

        setServerAdminPill(pill, getExtensionSyncStatusLabel(result?.status), getExtensionSyncStatusTone(result?.status));
        titleGroup.append(title);

        if (metaParts.length > 0) {
            titleGroup.append(meta);
        }

        header.append(titleGroup, pill);

        const body = createElement('div', { className: 'sb-import-report-item-body' });
        const copiedFiles = Number(result?.copiedFiles ?? 0) || 0;
        const statusLine = createElement('p', {
            className: 'sb-import-report-item-copy',
            text: result?.status === 'failed'
                ? (result?.error || 'This extension could not be synced.')
                : `Copied ${copiedFiles} file${copiedFiles === 1 ? '' : 's'} into ${result?.name || 'extension'}.`,
        });
        const checksLine = createElement('p', {
            className: 'sb-import-report-item-checks',
            text: getExtensionSyncCheckSummary(result),
        });

        body.append(statusLine, checksLine);

        if (Array.isArray(result?.warnings) && result.warnings.length > 0) {
            const warningList = createElement('ul', { className: 'sb-import-report-warnings' });

            for (const warning of result.warnings) {
                warningList.appendChild(createElement('li', { text: warning }));
            }

            body.appendChild(warningList);
        }

        card.append(header, body);
        return card;
    });

    list.replaceChildren(...items);
    report.hidden = false;
}

function logSillyTavernExtensionSyncReport(reportData) {
    if (!reportData || !Array.isArray(reportData.results)) {
        return;
    }

    console.groupCollapsed(`[Homunculus] Third-party extension sync report (${reportData.results.length})`);
    console.table(reportData.results.map(result => ({
        name: result?.name || '',
        displayName: result?.displayName || '',
        status: result?.status || '',
        copiedFiles: Number(result?.copiedFiles ?? 0) || 0,
        manifestFound: result?.checks?.manifestFound === true,
        manifestValid: result?.checks?.manifestValid === true,
        jsEntry: result?.checks?.jsEntry || '',
        jsEntryExists: result?.checks?.jsEntryExists === true,
        gitMetadataSkipped: result?.checks?.gitMetadataSkipped === true,
        warningCount: Array.isArray(result?.warnings) ? result.warnings.length : 0,
        error: result?.error || '',
    })));
    console.groupEnd();
}

async function handleSillyTavernFolderImport() {
    const refs = getImporterRefs();

    if (!refs?.pathInput || getImporterState().busy) {
        return;
    }

    const sourcePath = refs.pathInput.value.trim();

    if (!sourcePath) {
        setServerAdminMessage(refs.note, 'Paste the path to your SillyTavern folder or user data folder first.', 'warn');
        toastr.warning('Paste a SillyTavern folder path first.', 'Import SillyTavern');
        refs.pathInput.focus({ preventScroll: true });
        return;
    }

    const confirmed = window.confirm(`Import data from this folder into the current Homunculus account?\n\n${sourcePath}\n\nFiles with the same name will be replaced, and the page will reload when the import finishes.`);
    if (!confirmed) {
        return;
    }

    setSillyTavernImportBusy(true);
    renderSillyTavernExtensionSyncReport(null);
    setServerAdminMessage(refs.note, 'Importing folder data… This may take a moment for larger libraries.');

    try {
        const result = await requestUserPrivateAction('/api/users/import-sillytavern/folder', {
            body: { sourcePath },
        });

        setServerAdminMessage(refs.note, result?.message || 'Folder import finished. Reloading…', 'good');
        toastr.success(result?.message || 'Folder import finished. Reloading…', 'Import SillyTavern');
        await wait(700);
        location.reload();
    } catch (error) {
        console.error('Failed to import SillyTavern folder.', error);
        setServerAdminMessage(refs.note, error.message || 'Failed to import from that folder path.', 'danger');
        toastr.error(error.message || 'Failed to import from that folder path.', 'Import SillyTavern');
    } finally {
        setSillyTavernImportBusy(false);
    }
}

async function handleSillyTavernExtensionSync() {
    const refs = getImporterRefs();

    if (!refs?.pathInput || getImporterState().busy) {
        return;
    }

    const sourcePath = refs.pathInput.value.trim();

    if (!sourcePath) {
        setServerAdminMessage(refs.note, 'Paste the path to your existing SillyTavern folder before syncing extensions.', 'warn');
        toastr.warning('Paste a SillyTavern folder path first.', 'Sync Extensions');
        refs.pathInput.focus({ preventScroll: true });
        return;
    }

    const confirmed = window.confirm(`Sync third-party extensions from this SillyTavern folder into the current Homunculus account?\n\n${sourcePath}\n\nMatching extension folders will be replaced. Homunculus will show a detailed report instead of reloading immediately.`);
    if (!confirmed) {
        return;
    }

    setSillyTavernImportBusy(true);
    renderSillyTavernExtensionSyncReport(null);
    setServerAdminMessage(refs.note, 'Syncing third-party extensions… Homunculus will validate each one and show a report when it finishes.');

    try {
        const result = await requestUserPrivateAction('/api/users/import-sillytavern/extensions', {
            body: { sourcePath },
        });
        const warningCount = Number(result?.warningCount ?? 0) || 0;
        const failedCount = Number(result?.failedCount ?? 0) || 0;
        const needsAttention = warningCount + failedCount > 0;
        const gitMetadataSkippedCount = Number(result?.gitMetadataSkippedCount ?? 0) || 0;
        const message = needsAttention
            ? `${result?.message || 'Extension sync finished with warnings.'} If something still looks broken after a reload, contact purachina with the report below.`
            : `${result?.message || 'Extension sync finished.'} Reload when you are ready to activate the synced extensions.${gitMetadataSkippedCount > 0 ? ` Git metadata was skipped on ${gitMetadataSkippedCount} extension${gitMetadataSkippedCount === 1 ? '' : 's'} to avoid permission issues, so built-in update tooling may need a reinstall later.` : ''}`;
        const tone = failedCount > 0 ? 'danger' : warningCount > 0 ? 'warn' : 'good';

        renderSillyTavernExtensionSyncReport(result);
        logSillyTavernExtensionSyncReport(result);
        setServerAdminMessage(refs.note, message, tone);

        if (failedCount > 0) {
            toastr.error(result?.message || 'Some extensions could not be synced.', 'Sync Extensions');
        } else if (warningCount > 0) {
            toastr.warning(result?.message || 'Extension sync finished with warnings.', 'Sync Extensions');
        } else {
            toastr.success(result?.message || 'Extension sync finished.', 'Sync Extensions');
        }
    } catch (error) {
        console.error('Failed to sync SillyTavern third-party extensions.', error);
        setServerAdminMessage(refs.note, error.message || 'Failed to sync third-party extensions from that folder.', 'danger');
        toastr.error(error.message || 'Failed to sync third-party extensions from that folder.', 'Sync Extensions');
    } finally {
        setSillyTavernImportBusy(false);
    }
}

async function handleSillyTavernZipImport(file) {
    const refs = getImporterRefs();

    if (!(file instanceof File) || getImporterState().busy || !refs) {
        return;
    }

    const confirmed = window.confirm(`Import this SillyTavern backup ZIP into the current Homunculus account?\n\n${file.name}\n\nFiles with the same name will be replaced, and the page will reload when the import finishes.`);
    if (!confirmed) {
        if (refs.zipFileInput instanceof HTMLInputElement) {
            refs.zipFileInput.value = '';
        }

        return;
    }

    const formData = new FormData();
    formData.append('avatar', file, file.name);

    setSillyTavernImportBusy(true);
    renderSillyTavernExtensionSyncReport(null);
    setServerAdminMessage(refs.note, 'Importing backup ZIP… This may take a moment for larger libraries.');

    try {
        const result = await requestUserPrivateAction('/api/users/import-sillytavern/zip', {
            body: formData,
            useFormData: true,
        });

        setServerAdminMessage(refs.note, result?.message || 'Backup ZIP imported. Reloading…', 'good');
        toastr.success(result?.message || 'Backup ZIP imported. Reloading…', 'Import SillyTavern');
        await wait(700);
        location.reload();
    } catch (error) {
        console.error('Failed to import SillyTavern backup ZIP.', error);
        setServerAdminMessage(refs.note, error.message || 'Failed to import that backup ZIP.', 'danger');
        toastr.error(error.message || 'Failed to import that backup ZIP.', 'Import SillyTavern');
    } finally {
        if (refs.zipFileInput instanceof HTMLInputElement) {
            refs.zipFileInput.value = '';
        }

        setSillyTavernImportBusy(false);
    }
}

function injectSillyTavernImportCard() {
    const importOutlet = document.getElementById('sb-import-tools-outlet');
    const themeBlock = document.getElementById('UI-presets-block');
    const cardHost = importOutlet instanceof HTMLElement
        ? importOutlet
        : themeBlock;
    if (!(cardHost instanceof HTMLElement)) {
        return;
    }

    const existingCard = document.getElementById('sb-import-card');
    if (existingCard instanceof HTMLElement) {
        if (cardHost.firstElementChild !== existingCard) {
            cardHost.prepend(existingCard);
        }

        return;
    }

    const card = createElement('section', { id: 'sb-import-card', className: 'sb-admin-card sb-import-card' });
    const header = createElement('div', { className: 'sb-admin-card-header' });
    const copy = createElement('div', { className: 'sb-admin-card-copy' });
    const title = createElement('strong', { text: 'Import Your SillyTavern Setup' });
    const description = createElement('p', { text: 'Bring over characters, chats, presets, themes, extensions, and account settings from an existing SillyTavern folder or backup ZIP without touching the filesystem manually.' });
    const badge = createElement('span', { className: 'sb-server-pill', text: 'Easy Import' });
    copy.append(title, description);
    header.append(copy, badge);

    const hintRow = createElement('div', { className: 'sb-import-hints' });
    for (const label of ['Characters', 'Chats', 'Presets', 'Themes', 'Extensions']) {
        hintRow.appendChild(createElement('span', { className: 'sb-import-chip', text: label }));
    }

    const grid = createElement('div', { className: 'sb-import-grid' });
    const folderPane = createElement('div', { className: 'sb-import-pane' });
    const folderTitle = createElement('strong', { text: 'Import From Folder Path' });
    const folderBody = createElement('p', { text: 'Paste the path to your SillyTavern install, its `data` folder, or the specific user folder you want to import. Use the full import for everything, or sync just your third-party extensions with a detailed report.' });
    const pathRow = createElement('div', { className: 'sb-import-path-row' });
    const actionRow = createElement('div', { className: 'sb-import-action-row' });
    const pathInput = createElement('input', {
        id: 'sb-import-path-input',
        className: 'text_pole sb-import-path-input',
        attrs: {
            type: 'text',
            placeholder: '/path/to/SillyTavern',
            'aria-label': 'SillyTavern folder path',
            autocomplete: 'off',
            spellcheck: 'false',
            title: 'You can paste a full SillyTavern install path, its data folder, or a specific user folder.',
        },
    });
    const folderButton = createElement('button', {
        className: 'menu_button menu_button_icon sb-server-action menu_button_primary',
        attrs: { type: 'button' },
        html: '<i class="fa-solid fa-folder-open" aria-hidden="true"></i><span>Import Folder</span>',
    });
    const syncButton = createElement('button', {
        className: 'menu_button menu_button_icon sb-server-action',
        attrs: { type: 'button' },
        html: '<i class="fa-solid fa-puzzle-piece" aria-hidden="true"></i><span>Sync Extensions</span>',
    });
    pathRow.append(pathInput);
    actionRow.append(folderButton, syncButton);
    folderPane.append(folderTitle, folderBody, pathRow, actionRow);

    const zipPane = createElement('div', { className: 'sb-import-pane' });
    const zipTitle = createElement('strong', { text: 'Import From Backup ZIP' });
    const zipBody = createElement('p', { text: 'Use the backup ZIP that SillyTavern exports. Pick the file here and Homunculus will import it into this account.' });
    const zipButton = createElement('button', {
        className: 'menu_button menu_button_icon sb-server-action menu_button_primary',
        attrs: { type: 'button' },
        html: '<i class="fa-solid fa-file-zipper" aria-hidden="true"></i><span>Import Backup ZIP</span>',
    });
    const zipFileInput = createElement('input', {
        id: 'sb-import-zip-input',
        className: 'sb-import-file-input',
        attrs: {
            type: 'file',
            accept: '.zip,application/zip,application/x-zip-compressed',
            'aria-label': 'Choose a SillyTavern backup ZIP',
        },
    });
    const zipFileName = createElement('small', { className: 'sb-import-file-name', text: 'No ZIP selected yet.' });
    zipPane.append(zipTitle, zipBody, zipButton, zipFileInput, zipFileName);

    const note = createElement('div', {
        className: 'sb-server-note sb-import-note',
        text: 'Full imports replace matching files and reload automatically. Extension sync replaces matching third-party extension folders, then shows a report so you can review it before reloading.',
    });
    const report = createElement('section', {
        className: 'sb-import-report',
        attrs: { 'aria-live': 'polite' },
    });
    const reportHeader = createElement('div', { className: 'sb-import-report-header' });
    const reportTitle = createElement('strong', { text: 'Third-Party Extension Sync Report' });
    const reportSummary = createElement('p', { className: 'sb-import-report-summary' });
    const reportHelp = createElement('p', { className: 'sb-import-report-help' });
    const reportList = createElement('div', { className: 'sb-import-report-list' });

    reportHeader.append(reportTitle);
    report.append(reportHeader, reportSummary, reportHelp, reportList);
    report.hidden = true;

    grid.append(folderPane, zipPane);
    card.append(header, hintRow, grid, note, report);
    cardHost.prepend(card);

    getImporterState().refs = {
        card,
        pathInput,
        folderButton,
        syncButton,
        zipButton,
        zipFileInput,
        zipFileName,
        note,
        report,
        reportSummary,
        reportHelp,
        reportList,
    };

    folderButton.addEventListener('click', handleSillyTavernFolderImport);
    syncButton.addEventListener('click', handleSillyTavernExtensionSync);
    pathInput.addEventListener('keydown', event => {
        if (event.key === 'Enter') {
            event.preventDefault();
            void handleSillyTavernFolderImport();
        }
    });

    zipButton.addEventListener('click', () => zipFileInput.click());
    zipFileInput.addEventListener('change', () => {
        const [file] = Array.from(zipFileInput.files ?? []);
        zipFileName.textContent = file?.name || 'No ZIP selected yet.';

        if (file) {
            void handleSillyTavernZipImport(file);
        }
    });

    updateSillyTavernImportInteractivity();
}


export { injectSillyTavernImportCard };
