/**
 * Composition root for the File Preview app. It wires host services, file-type handlers, and specialized controllers together without owning feature logic inline.
 */
import { App } from '@modelcontextprotocol/ext-apps';
import { createCompactRowShellController } from '../../shared/tool-shell.js';
import { createWidgetStateStorage } from '../../shared/widget-state.js';
import { renderCompactRow } from '../../shared/compact-row.js';
import { connectWithSharedHostContext } from '../../shared/host-context.js';
import { createUiEventTracker } from '../../shared/ui-event-tracker.js';
import { attachDirectoryHandlers } from './directory-controller.js';
import { buildDocumentLayout } from './document-layout.js';
import { getDocumentFullscreenAvailability, parseReadRange, stripReadStatusLine } from './document-workspace.js';
import { getFileTypeCapabilities, renderPayloadBody } from './file-type-handlers.js';
import { buildOpenInEditorCommand, buildOpenInFolderCommand, renderMarkdownEditorAppIcon } from './host/external-actions.js';
import { attachSelectionContext } from './host/selection-context.js';
import { createMarkdownController } from './markdown/controller.js';
import { createConflictDialogController, renderConflictDialogMarkup, } from './markdown/conflict-dialog.js';
import { attachPanelActions } from './panel-actions.js';
import { extractRenderPayload, extractToolText, getFileExtensionForAnalytics, isLikelyUrl, isPreviewStructuredContent } from './payload-utils.js';
let isExpanded = false;
let hideSummaryRow = false;
let previewShownFired = false;
let onRender;
let trackUiEvent;
let conflictDialogController;
let rpcCallTool;
let rpcUpdateContext;
let openExternalLink;
let requestDisplayMode;
let shellController;
let currentPayload;
let currentHtmlMode = 'rendered';
let currentHostContext;
let rerenderCurrent;
let syncPayload;
let persistPayload;
let localPayloadOverride;
let hostPayload;
let inlinePayloadBeforeFullscreen;
let directoryBackPayload;
let selectionAbortController = null;
const markdownEditorAppCache = new Map();
function getTelemetryToolName(payload) {
    return typeof payload?.sourceTool === 'string' ? payload.sourceTool : 'read_file';
}
async function callToolIfReady(name, args) {
    return rpcCallTool ? rpcCallTool(name, args) : undefined;
}
function getAvailableDisplayModes() {
    const rawModes = currentHostContext?.availableDisplayModes;
    if (!Array.isArray(rawModes)) {
        return [];
    }
    return rawModes.filter((mode) => typeof mode === 'string');
}
function getCurrentDisplayMode() {
    return typeof currentHostContext?.displayMode === 'string'
        ? currentHostContext.displayMode
        : null;
}
function storePayloadOverride(payload) {
    localPayloadOverride = payload;
    currentPayload = payload;
    persistPayload?.(payload);
}
function getEffectiveIncomingPayload(payload) {
    if (!localPayloadOverride) {
        return payload;
    }
    if (localPayloadOverride.filePath !== payload.filePath) {
        localPayloadOverride = undefined;
        return payload;
    }
    const incomingContent = stripReadStatusLine(payload.content);
    const overriddenContent = stripReadStatusLine(localPayloadOverride.content);
    if (incomingContent === overriddenContent) {
        return payload;
    }
    return localPayloadOverride;
}
function updateSaveStatusDOM(label, statusClass) {
    const existing = document.querySelector('.panel-save-status');
    if (label) {
        if (existing) {
            existing.textContent = label;
            existing.className = `panel-save-status panel-save-status--${statusClass}`;
        }
        else {
            const actions = document.querySelector('.panel-topbar-actions');
            if (actions) {
                const span = document.createElement('span');
                span.className = `panel-save-status panel-save-status--${statusClass}`;
                span.textContent = label;
                actions.prepend(span);
            }
        }
    }
    else if (existing) {
        existing.remove();
    }
}
const markdownController = createMarkdownController({
    callTool: callToolIfReady,
    openExternalLink: async (url) => (openExternalLink ? openExternalLink(url) : undefined),
    requestDisplayMode: async (mode) => (requestDisplayMode ? requestDisplayMode(mode) : undefined),
    getAvailableDisplayModes,
    getCurrentDisplayMode,
    getCurrentPayload: () => currentPayload,
    setExpanded: (expanded) => {
        isExpanded = expanded;
    },
    syncPayload: (payload) => syncPayload?.(payload),
    storePayloadOverride,
    rerender: () => {
        rerenderCurrent?.();
    },
    updateSaveStatus: updateSaveStatusDOM,
    trackUiEvent: (event, params) => trackUiEvent?.(event, params),
    showConflictDialog: (options) => {
        if (conflictDialogController) {
            conflictDialogController.open(options);
            return;
        }
        // Dialog not yet initialized (would only happen if the save failure
        // somehow fires before bootstrapApp). Fall back to the cancel callback
        // so the editor still shows its inline note instead of silently no-op'ing.
        console.warn('[file-preview] conflictDialogController not ready; firing onCancel fallback');
        options.onCancel?.();
    },
});
/**
 * Check if a payload needs its file content to be read.
 * Tool results from edit_block/write_file include structuredContent but
 * their text is a success message, not file content. Detect this by
 * checking for the absence of the read status line that read_file always includes.
 * URL payloads are fetched remotely by read_file(isUrl:true); we can't
 * re-fetch them from here (no isUrl flag on the refresh path), so skip.
 */
function needsContentRead(payload) {
    if (payload.fileType === 'directory' || payload.fileType === 'image' || payload.fileType === 'unsupported') {
        return false;
    }
    if (/^https?:\/\//i.test(payload.filePath)) {
        return false;
    }
    return !parseReadRange(payload.content);
}
async function readAndResolvePayload(payload, onReady) {
    try {
        const freshPayload = await markdownController.readPayload(payload.filePath);
        if (freshPayload) {
            onReady({
                ...freshPayload,
                sourceTool: payload.sourceTool ?? freshPayload.sourceTool,
            });
            if (freshPayload.fileType === 'markdown') {
                void markdownController.refreshFromDisk(freshPayload);
            }
            return;
        }
    }
    catch {
        // Fall through to original payload.
    }
    onReady(payload);
}
function renderStatusState(container, message) {
    container.innerHTML = `
      <main class="shell">
        ${renderCompactRow({ label: message, variant: 'status', interactive: false })}
      </main>
    `;
    document.body.classList.add('dc-ready');
}
function renderLoadingState(container) {
    container.innerHTML = `
      <main class="shell">
        ${renderCompactRow({ label: 'Preparing preview…', variant: 'loading', interactive: false })}
      </main>
    `;
    document.body.classList.add('dc-ready');
}
export function renderApp(container, payload, htmlMode = 'rendered', expandedState = false) {
    isExpanded = expandedState;
    currentHtmlMode = htmlMode;
    shellController?.dispose();
    shellController = undefined;
    if (!payload || payload.fileType !== 'markdown') {
        markdownController.clear();
    }
    else {
        markdownController.disposeHandles();
    }
    if (!payload) {
        selectionAbortController?.abort();
        selectionAbortController = null;
        currentPayload = undefined;
        renderStatusState(container, 'No preview available for this response.');
        onRender?.();
        return;
    }
    currentPayload = payload;
    const capabilities = getFileTypeCapabilities(payload);
    if (!capabilities.supportsPreview && hideSummaryRow) {
        isExpanded = false;
    }
    const range = parseReadRange(payload.content);
    const body = renderPayloadBody({
        payload,
        htmlMode,
        startLine: range?.fromLine ?? 1,
        markdownController,
    });
    const markdownWorkspace = payload.fileType === 'markdown' ? markdownController.getState(payload) : undefined;
    const fileExtension = getFileExtensionForAnalytics(payload.filePath);
    const isFullscreen = getCurrentDisplayMode() === 'fullscreen';
    const canGoFullscreen = !isFullscreen && getDocumentFullscreenAvailability({
        availableDisplayModes: getAvailableDisplayModes(),
    }).canFullscreen;
    if (payload.fileType === 'markdown' && payload.defaultEditorName) {
        markdownEditorAppCache.set(payload.filePath, {
            appName: payload.defaultEditorName,
            appPath: payload.defaultEditorPath,
        });
    }
    const defaultMarkdownEditor = payload.fileType === 'markdown'
        ? markdownEditorAppCache.get(payload.filePath)
        : undefined;
    const layout = buildDocumentLayout({
        payload,
        body,
        capabilities,
        fileExtension,
        htmlMode,
        currentDisplayMode: getCurrentDisplayMode(),
        isExpanded,
        hideSummaryRow,
        markdownWorkspace,
        canGoFullscreen,
        isMarkdownUndoAvailable: markdownWorkspace ? markdownController.isUndoAvailable(markdownWorkspace) : false,
        defaultMarkdownEditorName: defaultMarkdownEditor?.appName,
        markdownEditorAppIcon: renderMarkdownEditorAppIcon(),
        hasDirectoryBackButton: Boolean(directoryBackPayload),
    });
    container.innerHTML = layout.html;
    document.body.classList.add('dc-ready');
    attachPanelActions({
        container,
        payload,
        htmlMode,
        getIsExpanded: () => isExpanded,
        callTool: callToolIfReady,
        trackUiEvent,
        getFileExtensionForAnalytics,
        buildOpenInFolderCommand: (filePath) => buildOpenInFolderCommand(filePath, isLikelyUrl),
        buildOpenInEditorCommand: (filePath) => buildOpenInEditorCommand(filePath, isLikelyUrl, markdownEditorAppCache),
        render: (nextPayload, nextHtmlMode = 'rendered', nextExpanded = isExpanded) => {
            renderApp(container, nextPayload, nextHtmlMode, nextExpanded);
        },
        updateSaveStatus: updateSaveStatusDOM,
        markdownController,
    });
    if (payload.fileType === 'markdown') {
        markdownController.attachHandlers(payload);
    }
    selectionAbortController = attachSelectionContext({
        payload,
        isMarkdownEditing: payload.fileType === 'markdown' && !!markdownWorkspace,
        updateContext: rpcUpdateContext,
        trackUiEvent,
        getFileExtensionForAnalytics,
        previousAbortController: selectionAbortController,
    });
    if (payload.fileType === 'directory') {
        attachDirectoryHandlers({
            container,
            callTool: callToolIfReady,
            buildOpenInFolderCommand: (filePath) => buildOpenInFolderCommand(filePath, isLikelyUrl),
            onOpenPayload: (nextPayload) => {
                directoryBackPayload = payload;
                renderApp(container, nextPayload, 'rendered', true);
            },
        });
    }
    const backBtn = document.getElementById('dir-back');
    if (backBtn && directoryBackPayload) {
        const savedPayload = directoryBackPayload;
        backBtn.addEventListener('click', () => {
            directoryBackPayload = undefined;
            renderApp(container, savedPayload, 'rendered', true);
        });
    }
    if (payload.fileType === 'directory') {
        directoryBackPayload = undefined;
    }
    const compactRow = document.getElementById('compact-toggle');
    shellController = createCompactRowShellController({
        shell: document.getElementById('tool-shell'),
        compactRow,
        initialExpanded: layout.effectiveExpanded,
        onToggle: (expanded) => {
            isExpanded = expanded;
            trackUiEvent?.(expanded ? 'expand' : 'collapse', {
                file_type: payload.fileType,
                file_extension: fileExtension,
            });
        },
        onScrollAfterExpand: () => {
            trackUiEvent?.('scroll_after_expand', {
                file_type: payload.fileType,
                file_extension: fileExtension,
            });
        },
        onRender,
    });
    onRender?.();
    if (!previewShownFired) {
        previewShownFired = true;
        trackUiEvent?.('preview_shown', {
            file_type: payload.fileType,
            file_extension: fileExtension,
        });
    }
}
export function bootstrapApp() {
    const container = document.getElementById('app');
    if (!container) {
        return;
    }
    renderLoadingState(container);
    // Mount the conflict dialog once at body level. It's position: fixed and
    // must live outside the app container so that re-renders of the document
    // body never wipe it while it's open.
    if (!document.getElementById('md-conflict-modal')) {
        const dialogHost = document.createElement('div');
        dialogHost.innerHTML = renderConflictDialogMarkup();
        const dialogRoot = dialogHost.firstElementChild;
        if (dialogRoot) {
            document.body.appendChild(dialogRoot);
        }
    }
    conflictDialogController = createConflictDialogController({ container: document });
    const app = new App({ name: 'Desktop Commander File Preview', version: '1.0.0' }, { updateModelContext: { text: {} } }, { autoResize: true });
    const chrome = {
        expanded: isExpanded,
        hideSummaryRow,
    };
    const syncChromeState = () => {
        isExpanded = chrome.expanded;
        hideSummaryRow = chrome.hideSummaryRow;
    };
    const widgetState = createWidgetStateStorage((value) => isPreviewStructuredContent(value) && typeof value.content === 'string');
    const renderAndSync = (payload) => {
        if (payload) {
            widgetState.write(payload);
        }
        renderApp(container, payload, 'rendered', isExpanded);
    };
    const syncFromPersistedWidgetState = () => {
        const persistedPayload = widgetState.read();
        if (!persistedPayload) {
            return;
        }
        if (currentPayload
            && currentPayload.filePath === persistedPayload.filePath
            && stripReadStatusLine(currentPayload.content) === stripReadStatusLine(persistedPayload.content)) {
            return;
        }
        renderAndSync(persistedPayload);
    };
    syncPayload = renderAndSync;
    persistPayload = (payload) => {
        widgetState.write(payload);
    };
    rerenderCurrent = () => {
        renderApp(container, currentPayload, currentHtmlMode, isExpanded);
    };
    let pendingCachedPayload;
    let initialStateResolved = false;
    const resolveInitialState = (payload, message) => {
        if (initialStateResolved) {
            return;
        }
        initialStateResolved = true;
        if (payload) {
            hostPayload = payload;
            renderAndSync(payload);
            if (payload.fileType === 'markdown' && getCurrentDisplayMode() === 'fullscreen') {
                void markdownController.requestEditMode(payload);
            }
            if (payload.fileType === 'markdown') {
                void markdownController.refreshFromDisk(payload);
            }
            return;
        }
        renderStatusState(container, message ?? 'No preview available for this response.');
        onRender?.();
    };
    onRender = () => { };
    rpcCallTool = (name, args) => (app.callServerTool({ name, arguments: args }));
    rpcUpdateContext = (text) => {
        const params = text
            ? { content: [{ type: 'text', text }] }
            : { content: [] };
        app.updateModelContext(params).catch(() => {
            // Host may not support updateModelContext.
        });
    };
    openExternalLink = async (url) => {
        const result = await app.openLink({ url });
        return result.isError !== true;
    };
    requestDisplayMode = async (mode) => {
        const result = await app.requestDisplayMode({ mode });
        return typeof result.mode === 'string' ? result.mode : null;
    };
    const filePreviewUiEvent = createUiEventTracker((name, args) => app.callServerTool({ name, arguments: args }), {
        component: 'file_preview',
    });
    trackUiEvent = (event, params = {}) => filePreviewUiEvent(event, {
        tool_name: getTelemetryToolName(currentPayload ?? hostPayload),
        ...params,
    });
    app.ontoolinput = (params) => {
        const requestedPath = typeof params.arguments?.path === 'string' ? params.arguments.path : undefined;
        if (!initialStateResolved
            && pendingCachedPayload
            && requestedPath
            && pendingCachedPayload.filePath === requestedPath) {
            const cached = pendingCachedPayload;
            pendingCachedPayload = undefined;
            resolveInitialState(cached);
            return;
        }
        renderLoadingState(container);
        onRender?.();
    };
    app.ontoolresult = (result) => {
        pendingCachedPayload = undefined;
        const payload = extractRenderPayload(result);
        const message = extractToolText(result);
        if (!initialStateResolved) {
            if (payload) {
                if (needsContentRead(payload)) {
                    void readAndResolvePayload(payload, (p) => resolveInitialState(getEffectiveIncomingPayload(p)));
                    return;
                }
                resolveInitialState(getEffectiveIncomingPayload(payload));
                return;
            }
            if (message) {
                resolveInitialState(undefined, message);
            }
            return;
        }
        if (payload) {
            if (needsContentRead(payload)) {
                renderLoadingState(container);
                void readAndResolvePayload(payload, (p) => renderAndSync(getEffectiveIncomingPayload(p)));
            }
            else {
                renderAndSync(getEffectiveIncomingPayload(payload));
            }
        }
        else if (message) {
            renderStatusState(container, message);
            onRender?.();
        }
    };
    app.ontoolcancelled = (params) => {
        resolveInitialState(undefined, params.reason ?? 'Tool was cancelled.');
    };
    const handleVisibilitySync = () => {
        if (document.visibilityState === 'visible') {
            syncFromPersistedWidgetState();
        }
    };
    const handleFocusSync = () => {
        // Only sync cross-tab state if the page was hidden (tab switch).
        // Simple focus changes within the same page should not trigger a re-render
        // as it destroys the active editor.
        if (document.visibilityState !== 'visible') {
            syncFromPersistedWidgetState();
        }
    };
    const teardown = () => {
        shellController?.dispose();
        shellController = undefined;
        markdownController.disposeHandles();
        selectionAbortController?.abort();
        selectionAbortController = null;
        document.removeEventListener('visibilitychange', handleVisibilitySync);
        window.removeEventListener('focus', handleFocusSync);
    };
    document.addEventListener('visibilitychange', handleVisibilitySync);
    window.addEventListener('focus', handleFocusSync);
    app.onteardown = async () => {
        teardown();
        return {};
    };
    void connectWithSharedHostContext({
        app,
        chrome,
        onContextApplied: () => {
            const previousDisplayMode = getCurrentDisplayMode();
            syncChromeState();
            currentHostContext = app.getHostContext();
            const nextDisplayMode = getCurrentDisplayMode();
            const displayModeChanged = previousDisplayMode !== nextDisplayMode;
            // Clicking a display-mode button blurs the editor first, and the
            // editor's onBlur handler already persists dirty drafts, so there
            // is nothing additional to save here.
            if (previousDisplayMode === 'fullscreen'
                && nextDisplayMode === 'inline'
                && currentPayload?.fileType === 'markdown') {
                isExpanded = true;
                chrome.expanded = true;
                const restorePayload = inlinePayloadBeforeFullscreen ?? hostPayload;
                const restoreWasPartial = restorePayload ? parseReadRange(restorePayload.content)?.isPartial === true : false;
                if (restoreWasPartial && restorePayload) {
                    localPayloadOverride = restorePayload;
                    currentPayload = restorePayload;
                    widgetState.write(restorePayload);
                    void markdownController.handleInlineExitFromFullscreen(restorePayload).then((freshPayload) => {
                        if (freshPayload) {
                            currentPayload = freshPayload;
                            localPayloadOverride = freshPayload;
                            widgetState.write(freshPayload);
                            rerenderCurrent?.();
                        }
                    });
                }
                else {
                    void markdownController.handleInlineExitFromFullscreen();
                }
                inlinePayloadBeforeFullscreen = undefined;
            }
            if (previousDisplayMode !== 'fullscreen'
                && nextDisplayMode === 'fullscreen'
                && currentPayload?.fileType === 'markdown') {
                inlinePayloadBeforeFullscreen = currentPayload;
                if (parseReadRange(currentPayload.content)?.isPartial) {
                    void markdownController.requestEditMode(currentPayload);
                }
            }
            if (initialStateResolved && displayModeChanged) {
                rerenderCurrent?.();
            }
        },
        onConnected: () => {
            currentHostContext = app.getHostContext();
            pendingCachedPayload = widgetState.read() ?? undefined;
        },
    }).catch(() => {
        renderStatusState(container, 'Failed to connect to host.');
        onRender?.();
    });
    window.addEventListener('beforeunload', () => {
        teardown();
    }, { once: true });
}
