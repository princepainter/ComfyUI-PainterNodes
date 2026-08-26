import { app } from "../../../scripts/app.js";

/* =====================================================================
PainterAudioUpload - compact refined edition (v5)
- value widgets fully hidden, no dead space, compact default size
- RESIZE SAFE: never setSize from ResizeObserver callbacks (that caused
  the runaway "explosion"). While dragging we only relayout passively;
  the min-size floor is enforced ONCE on pointer-up when layout settled.
- waveform green / preview green / trimmed yellow
- double-click = reset selection, right-click = clear selection
- scale-compensated drag coordinates (mouse == selection box)
- waveform auto-grows when the node is dragged taller
- NEW: the old loop button is now a RESTORE button - one click clears
  all trim marks and writes trim_start=0 / trim_end=-1 (export = original)
===================================================================== */

const NODE_CLASS = "PainterAudioUpload";

const PROP_FILENAME = "pau_filename";
const PROP_TRIM_START = "pau_trim_start";
const PROP_TRIM_END = "pau_trim_end";

/* ----------------------------- layout ----------------------------- */
const NODE_WIDTH = 480;
const WAVEFORM_H = 30;
const CTRLROW_H = 30;
const GAP = 6;
const PAD_X = 10;
const PAD_Y = 6;

// 标题栏 + 输出("audio")行 的预留高度（仅用于初始默认尺寸估算）
const CHROME = 54;

const CONTENT_MIN_H = WAVEFORM_H + CTRLROW_H + GAP + PAD_Y * 2; // 78
const DEFAULT_HEIGHT = CONTENT_MIN_H + CHROME;                  // ~132
const MIN_WIDTH = 320;
const MIN_HEIGHT = DEFAULT_HEIGHT;

const SIZE_SANITY_MAX = 4096;

const REQUIRED_WIDGET_INDEX = {
    audio_filename: 0,
    trim_start: 1,
    trim_end: 2,
};

/* ----------------------------- colors ----------------------------- */
const C = {
    primary: "#34d399",
    primaryStrong: "#10b981",

    wave: "#34d399",

    selectionBg: "rgba(52, 211, 153, 0.18)",
    selectionBorder: "#34d399",

    trimmedBg: "rgba(250, 204, 21, 0.20)",
    trimmedBorder: "#facc15",
    trimmedLabelBg: "rgba(250, 204, 21, 0.18)",

    textMuted: "rgba(255, 255, 255, 0.55)",
    text: "rgba(255, 255, 255, 0.92)",

    record: "#f87171",
    recordBg: "rgba(248, 113, 113, 0.18)",

    hover: "rgba(255, 255, 255, 0.10)",
    pill: "rgba(255, 255, 255, 0.05)",
    pillBorder: "rgba(255, 255, 255, 0.07)",
};

const SVG = {
    upload: `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/></svg>`,
    mic: `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3z"/><path d="M19 10v2a7 7 0 0 1-14 0v-2"/><line x1="12" y1="19" x2="12" y2="22"/></svg>`,
    play: `<svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><polygon points="6 4 20 12 6 20 6 4"/></svg>`,
    pause: `<svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="4" width="4" height="16"/><rect x="14" y="4" width="4" height="16"/></svg>`,
    restore: `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="1 4 1 10 7 10"/><path d="M3.51 15a9 9 0 1 0 2.13-9.36L1 10"/></svg>`,
    speaker: `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5" fill="currentColor"/><path d="M19.07 4.93a10 10 0 0 1 0 14.14M15.54 8.46a5 5 0 0 1 0 7.07"/></svg>`,
    speakerMute: `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5" fill="currentColor"/><line x1="22" y1="9" x2="16" y2="15"/><line x1="16" y1="9" x2="22" y2="15"/></svg>`,
    cut: `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="6" cy="6" r="3"/><circle cx="6" cy="18" r="3"/><line x1="20" y1="4" x2="8.12" y2="15.88"/><line x1="14.47" y1="14.48" x2="20" y2="20"/><line x1="8.12" y1="8.12" x2="12" y2="12"/></svg>`,
    recording: `<svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor"><circle cx="12" cy="12" r="6"/></svg>`,
};

/* =====================================================================
Global "pointer up" hook: enforce the min-size floor only AFTER a drag
ends (layout settled). Never during the drag - that's what exploded.
===================================================================== */
const MIN_CHECK_NODES = new Set();
let globalPointerBound = false;

function bindGlobalPointer() {
    if (globalPointerBound) return;
    globalPointerBound = true;

    const settle = () => {
        setTimeout(() => {
            MIN_CHECK_NODES.forEach((n) => enforceMinSize(n));
        }, 0);
    };

    window.addEventListener("pointerup", settle, true);
    window.addEventListener("mouseup", settle, true);
}

app.registerExtension({
    name: "Painter.AudioUpload",

    async beforeRegisterNodeDef(nodeType, nodeData) {
        if (nodeData.name !== NODE_CLASS) return;

        const origOnNodeCreated = nodeType.prototype.onNodeCreated;
        nodeType.prototype.onNodeCreated = function () {
            const r = origOnNodeCreated?.apply(this, arguments);

            this.properties = this.properties || {};
            this.pau_state = this.pau_state || {};

            const hasSize =
                Array.isArray(this.size) &&
                this.size[0] >= MIN_WIDTH &&
                this.size[1] >= MIN_HEIGHT &&
                this.size[0] <= SIZE_SANITY_MAX &&
                this.size[1] <= SIZE_SANITY_MAX;
            if (!hasSize) {
                this.setSize([NODE_WIDTH, DEFAULT_HEIGHT]);
            }

            this.min_size = [MIN_WIDTH, MIN_HEIGHT];
            this.minSize = [MIN_WIDTH, MIN_HEIGHT];

            collapseWidget(this, "audio_filename");
            collapseWidget(this, "trim_start");
            collapseWidget(this, "trim_end");

            buildUI(this);
            this.pau_clear = () => clearAudio(this);

            return r;
        };

        const origGetExtraMenuOptions = nodeType.prototype.getExtraMenuOptions;
        nodeType.prototype.getExtraMenuOptions = function (_, options) {
            const r = origGetExtraMenuOptions?.apply(this, arguments);
            options = options || [];

            if (this.properties?.[PROP_FILENAME]) {
                options.push({
                    content: "Clear audio",
                    callback: () => this.pau_clear?.(),
                });
            }

            return r;
        };

        const origOnConfigure = nodeType.prototype.onConfigure;
        nodeType.prototype.onConfigure = function () {
            const r = origOnConfigure?.apply(this, arguments);

            this.properties = this.properties || {};

            const fnW = this.widgets?.find((w) => w.name === "audio_filename");
            const tsW = this.widgets?.find((w) => w.name === "trim_start");
            const teW = this.widgets?.find((w) => w.name === "trim_end");

            this.properties[PROP_FILENAME] = fnW?.value || "";
            this.properties[PROP_TRIM_START] = tsW?.value ?? 0;
            this.properties[PROP_TRIM_END] = teW?.value ?? -1;

            collapseWidget(this, "audio_filename");
            collapseWidget(this, "trim_start");
            collapseWidget(this, "trim_end");

            if (this.pau_built) {
                requestAnimationFrame(() => {
                    enforceMinSize(this);
                    passiveRelayout(this);
                });
                const fn = this.properties[PROP_FILENAME];
                if (fn) {
                    loadAndRender(this, fn).catch((err) =>
                        console.error("[PainterAudioUpload] restore failed:", err)
                    );
                } else {
                    renderEmpty(this);
                }
            } else {
                buildUI(this);
            }

            return r;
        };

        const origOnSerialize = nodeType.prototype.onSerialize;
        nodeType.prototype.onSerialize = function (o) {
            const r = origOnSerialize?.apply(this, arguments);

            o.properties = o.properties || {};
            o.properties[PROP_FILENAME] = this.properties?.[PROP_FILENAME] || "";
            o.properties[PROP_TRIM_START] = this.properties?.[PROP_TRIM_START] ?? 0;
            o.properties[PROP_TRIM_END] = this.properties?.[PROP_TRIM_END] ?? -1;

            return r;
        };

        // passive only: relayout, never resize
        const origOnResize = nodeType.prototype.onResize;
        nodeType.prototype.onResize = function (size) {
            const r = origOnResize?.apply(this, arguments);
            passiveRelayout(this);
            return r;
        };

        const origOnRemoved = nodeType.prototype.onRemoved;
        nodeType.prototype.onRemoved = function () {
            const r = origOnRemoved?.apply(this, arguments);

            MIN_CHECK_NODES.delete(this);

            stopPlayheadLoop(this);
            this.pau_cleanupPlayback?.();
            this.pau_cleanupInteraction?.();
            this.pau_resizeObserver?.disconnect?.();
            this.pau_wfRO?.disconnect?.();
            this.pau_wrapRO?.disconnect?.();

            if (this.pau_audioElement) {
                try { this.pau_audioElement.pause(); } catch (e) {}
                this.pau_audioElement = null;
            }

            return r;
        };
    },
});

/* =====================================================================
Hide value widgets completely.
===================================================================== */
function collapseWidget(node, name) {
    const w = node.widgets?.find((x) => x.name === name);
    if (!w) return;

    w.hidden = true;
    w.computeSize = () => [0, -4];

    const hideEl = () => {
        if (w.element) w.element.style.display = "none";
    };

    hideEl();
    requestAnimationFrame(hideEl);
    setTimeout(hideEl, 60);
}

/* =====================================================================
Size handling.
- passiveRelayout: safe to call at any time (RO callbacks, onResize).
  Only redraws; the only setSize allowed here is a sanity reset when the
  size is corrupt (NaN / absurdly large).
- enforceMinSize: called ONLY after pointer-up / after render. Snaps the
  node UP to the smallest size that shows all content; never fights an
  in-progress drag.
===================================================================== */
function sanitySize(node) {
    const s = node.size;
    if (
        !s ||
        !isFinite(s[0]) || !isFinite(s[1]) ||
        s[0] > SIZE_SANITY_MAX || s[1] > SIZE_SANITY_MAX
    ) {
        try { node.setSize([NODE_WIDTH, DEFAULT_HEIGHT]); } catch (e) {}
    }
}

function passiveRelayout(node) {
    sanitySize(node);
    relayoutWaveform(node);
    node.pau_paintOverlay?.();
}

function enforceMinSize(node) {
    const c = node.pau_container;
    if (!c || !node.size) return;

    sanitySize(node);

    const wrapper = node.pau_wrapper || c.parentElement;
    if (wrapper) node.pau_wrapper = wrapper;

    if (!wrapper || wrapper.clientWidth <= 10 || wrapper.clientHeight <= 10) return;

    // 节点尺寸 与 wrapper 尺寸 的差值（标题栏/边距），自动校准
    const dw = Math.max(0, (node.size[0] || 0) - wrapper.clientWidth);
    const dh = Math.max(0, (node.size[1] || 0) - wrapper.clientHeight);

    // 内容真正需要的最小尺寸
    const needW = (node.pau_controls?.scrollWidth || 300) + PAD_X * 2;
    const needH = CONTENT_MIN_H;

    const targetW = Math.min(SIZE_SANITY_MAX, Math.max(MIN_WIDTH, Math.round(needW + dw)));
    const targetH = Math.min(SIZE_SANITY_MAX, Math.max(MIN_HEIGHT, Math.round(needH + dh)));

    // 只在"比最小值还小"时向上钳回；绝不向下压
    if (node.size[0] < targetW - 1 || node.size[1] < targetH - 1) {
        try {
            node.setSize([
                Math.max(node.size[0], targetW),
                Math.max(node.size[1], targetH),
            ]);
        } catch (e) {}
    }

    passiveRelayout(node);
}

function attachWrapperRO(node) {
    const c = node.pau_container;
    if (!c) return;

    let tries = 0;
    const tryAttach = () => {
        const wrapper = c.parentElement;

        if (!wrapper && tries++ < 120) {
            requestAnimationFrame(tryAttach);
            return;
        }
        if (!wrapper) return;

        node.pau_wrapper = wrapper;

        if (!node.pau_wrapRO && window.ResizeObserver) {
            node.pau_wrapRO = new ResizeObserver(() => passiveRelayout(node));
            node.pau_wrapRO.observe(wrapper);
        }

        passiveRelayout(node);
    };

    tryAttach();
}

/* =====================================================================
Build DOM widget.
===================================================================== */
function buildUI(node) {
    if (node.pau_built) return;
    node.pau_built = true;

    bindGlobalPointer();
    MIN_CHECK_NODES.add(node);

    const container = document.createElement("div");
    container.className = "pau-container";
    container.style.cssText = `
        width: 100%;
        height: 100%;
        min-height: ${CONTENT_MIN_H}px;
        box-sizing: border-box;
        display: flex;
        flex-direction: column;
        justify-content: center;
        align-items: stretch;
        gap: ${GAP}px;
        padding: ${PAD_Y}px ${PAD_X}px;
        background: transparent;
        border: none;
        border-radius: 8px;
        overflow: hidden;
        user-select: none;
        -webkit-user-select: none;
        color: ${C.text};
        font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
        position: relative;
    `;

    node.addDOMWidget("pau_ui", "audio_ui", container, {
        serialize: false,
        hideOnZoom: false,
    });

    node.pau_container = container;

    const body = document.createElement("div");
    body.className = "pau-body";
    container.appendChild(body);

    const controls = buildControlsRow(node);
    container.appendChild(controls);

    node.pau_body = body;
    node.pau_controls = controls;

    if (window.ResizeObserver) {
        node.pau_resizeObserver = new ResizeObserver(() => passiveRelayout(node));
        node.pau_resizeObserver.observe(container);
    }

    attachWrapperRO(node);

    const fn = node.properties?.[PROP_FILENAME];
    if (fn) {
        loadAndRender(node, fn).catch((err) =>
            console.error("[PainterAudioUpload] initial load failed:", err)
        );
    } else {
        renderEmpty(node);
    }
}

/* =====================================================================
Controls row.
===================================================================== */
function pillStyle() {
    return `
        display: flex;
        align-items: center;
        gap: 2px;
        background: ${C.pill};
        border: 1px solid ${C.pillBorder};
        border-radius: 9px;
        padding: 2px 4px;
        flex: 0 0 auto;
    `;
}

function iconBtnStyle(color) {
    return `
        background: transparent;
        border: none;
        cursor: pointer;
        color: ${color};
        padding: 3px 5px;
        display: flex;
        align-items: center;
        justify-content: center;
        border-radius: 6px;
        transition: background 0.15s, color 0.15s;
        flex: 0 0 auto;
    `;
}

function mkIconBtn(icon, title, color) {
    const btn = document.createElement("button");
    btn.innerHTML = icon;
    btn.title = title;
    btn.style.cssText = iconBtnStyle(color || C.text);

    btn.onmouseenter = () => (btn.style.background = C.hover);
    btn.onmouseleave = () => (btn.style.background = "transparent");

    return btn;
}

function buildControlsRow(node) {
    const row = document.createElement("div");
    row.className = "pau-controls";
    row.style.cssText = `
        display: flex;
        align-items: center;
        justify-content: center;
        flex-wrap: nowrap;
        gap: 8px;
        width: 100%;
        height: ${CTRLROW_H}px;
        padding: 0 2px;
        box-sizing: border-box;
        background: transparent;
        overflow: hidden;
        flex: 0 0 auto;
    `;

    const tCur = document.createElement("span");
    tCur.style.cssText = `
        font-size: 10px;
        color: ${C.textMuted};
        font-variant-numeric: tabular-nums;
        min-width: 28px;
        display: none;
        flex: 0 0 auto;
    `;
    tCur.textContent = "0:00";

    const tDur = document.createElement("span");
    tDur.style.cssText = `
        font-size: 10px;
        color: ${C.textMuted};
        font-variant-numeric: tabular-nums;
        min-width: 28px;
        text-align: right;
        display: none;
        flex: 0 0 auto;
    `;
    tDur.textContent = "0:00";

    const playGroup = document.createElement("div");
    playGroup.style.cssText = pillStyle();
    playGroup.style.display = "none";

    const speakerBtn = mkIconBtn(SVG.speaker, "Mute", C.text);
    const playBtn = mkIconBtn(SVG.play, "Play / Pause", C.text);
    const restoreBtn = mkIconBtn(SVG.restore, "Restore original (clear all trims)", C.text);
    const cutBtn = mkIconBtn(SVG.cut, "Confirm trim", C.text);

    [speakerBtn, playBtn, restoreBtn, cutBtn].forEach((b) => playGroup.appendChild(b));

    const fileGroup = document.createElement("div");
    fileGroup.style.cssText = pillStyle();

    const uploadBtn = mkIconBtn(SVG.upload, "Upload audio", C.primary);
    const micBtn = mkIconBtn(SVG.mic, "Record from microphone", C.primary);

    micBtn.onmouseleave = () => {
        if (!(node.pau_recorder && node.pau_recorder.state === "recording")) {
            micBtn.style.background = "transparent";
        }
    };

    fileGroup.appendChild(uploadBtn);
    fileGroup.appendChild(micBtn);

    row.appendChild(tCur);
    row.appendChild(playGroup);
    row.appendChild(fileGroup);
    row.appendChild(tDur);

    node.pau_refs = node.pau_refs || {};
    Object.assign(node.pau_refs, {
        tCur,
        tDur,
        playGroup,
        fileGroup,
        speakerBtn,
        playBtn,
        restoreBtn,
        cutBtn,
        uploadBtn,
        micBtn,
    });

    setupControls(node);

    return row;
}

/* =====================================================================
Empty state.
===================================================================== */
function renderEmpty(node) {
    const body = node.pau_body;
    const controls = node.pau_controls;
    const container = node.pau_container;

    if (!body || !controls || !container) return;

    body.innerHTML = "";
    body.style.display = "none";

    controls.style.display = "flex";
    controls.style.justifyContent = "center";
    container.style.justifyContent = "center";

    container.ondragover = (e) => e.preventDefault();
    container.ondragleave = () => {};
    container.ondrop = async (e) => {
        e.preventDefault();
        const file = e.dataTransfer?.files?.[0];

        if (file && file.type.startsWith("audio/")) {
            try {
                await handleFile(node, file);
            } catch (err) {
                console.error(err);
                alert("Upload failed: " + err.message);
            }
        } else if (file) {
            alert("Please drop an audio file.");
        }
    };

    showFileControlsOnly(node);
    stopPlayheadLoop(node);

    requestAnimationFrame(() => {
        enforceMinSize(node);
        passiveRelayout(node);
    });
}

function showFileControlsOnly(node) {
    const refs = node.pau_refs;
    if (!refs) return;

    refs.tCur.style.display = "none";
    refs.tDur.style.display = "none";
    refs.playGroup.style.display = "none";
    refs.fileGroup.style.display = "flex";
}

function showLoadedControls(node) {
    const refs = node.pau_refs;
    if (!refs) return;

    refs.tCur.style.display = "inline-block";
    refs.tDur.style.display = "inline-block";
    refs.playGroup.style.display = "flex";
    refs.fileGroup.style.display = "flex";

    node.pau_controls.style.justifyContent = "space-between";

    updateTrimVisuals(node);
}

function triggerUpload(node) {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = "audio/*";
    input.style.display = "none";

    input.onchange = async (e) => {
        const file = e.target.files?.[0];
        if (!file) return;

        try {
            await handleFile(node, file);
        } catch (err) {
            console.error(err);
            alert("Upload failed: " + err.message);
        }
    };

    document.body.appendChild(input);
    input.click();

    setTimeout(() => document.body.removeChild(input), 0);
}

async function handleFile(node, file) {
    let filename = file.name || "audio.wav";

    if (!/\.[a-z0-9]+$/i.test(filename)) {
        filename += ".wav";
    }

    const formData = new FormData();
    formData.append("image", file, filename);
    formData.append("type", "input");
    formData.append("overwrite", "true");

    const response = await fetch("/upload/image", {
        method: "POST",
        body: formData,
    });

    if (!response.ok) {
        throw new Error("HTTP " + response.status);
    }

    const data = await response.json();
    const savedName = data.name || data.filename || filename;

    setRequiredWidget(node, "audio_filename", savedName);
    setRequiredWidget(node, "trim_start", 0.0);
    setRequiredWidget(node, "trim_end", -1.0);

    node.properties[PROP_FILENAME] = savedName;
    node.properties[PROP_TRIM_START] = 0.0;
    node.properties[PROP_TRIM_END] = -1.0;

    markGraphDirty(node);

    await loadAndRender(node, savedName);
}

function setRequiredWidget(node, name, value) {
    if (!node.widgets || !node.widgets.length) return false;

    const named = node.widgets.find((w) => w && w.name === name);
    if (named) {
        named.value = value;
        return true;
    }

    const idx = REQUIRED_WIDGET_INDEX[name];
    if (idx !== undefined && node.widgets[idx]) {
        node.widgets[idx].value = value;
        return true;
    }

    if (name === "trim_start" || name === "trim_end") {
        const numbers = node.widgets.filter(
            (w) => w && (w.type === "number" || w.type === "FLOAT" || w.type === "float")
        );
        const which = name === "trim_start" ? 0 : 1;

        if (numbers[which]) {
            numbers[which].value = value;
            return true;
        }
    }

    return false;
}

function getRequiredWidgetValue(node, name) {
    const w = node.widgets?.find((w) => w.name === name);
    return w?.value;
}

function markGraphDirty(node) {
    try { node.setDirtyCanvas?.(true, true); } catch (e) {}
    try { app.graph?.setDirtyCanvas?.(true, true); } catch (e) {}
}

/* =====================================================================
Loaded state.
===================================================================== */
async function loadAndRender(node, filename) {
    const url =
        "/view?filename=" +
        encodeURIComponent(filename) +
        "&type=input&t=" +
        Date.now();

    const resp = await fetch(url);
    if (!resp.ok) throw new Error("Cannot fetch " + filename);

    const arrayBuf = await resp.arrayBuffer();

    const AC = window.AudioContext || window.webkitAudioContext;
    const audioCtx = new AC();

    let audioBuf;
    try {
        audioBuf = await audioCtx.decodeAudioData(arrayBuf.slice(0));
    } finally {
        try { audioCtx.close(); } catch (e) {}
    }

    if (node.pau_cleanupPlayback) node.pau_cleanupPlayback();
    if (node.pau_cleanupInteraction) node.pau_cleanupInteraction();
    if (node.pau_wfRO) {
        try { node.pau_wfRO.disconnect(); } catch (e) {}
        node.pau_wfRO = null;
    }
    stopPlayheadLoop(node);

    if (node.pau_audioElement) {
        try { node.pau_audioElement.pause(); } catch (e) {}
        node.pau_audioElement.src = "";
    }

    const audio = new Audio();
    audio.src = url;
    audio.preload = "auto";
    audio.loop = false;

    node.pau_audioElement = audio;
    node.pau_audioBuffer = audioBuf;
    node.pau_duration = audioBuf.duration;

    node.pau_state = {
        selection: null,
        trimmed: false,
        isMuted: false,
    };

    renderLoaded(node);
}

function renderLoaded(node) {
    const body = node.pau_body;
    const controls = node.pau_controls;
    const container = node.pau_container;

    if (!body || !controls || !container) return;

    container.ondragover = null;
    container.ondragleave = null;
    container.ondrop = null;

    body.innerHTML = "";
    body.style.cssText = `
        display: flex;
        width: 100%;
        padding: 0;
        margin: 0;
        background: transparent;
        flex: 1 1 auto;
        min-height: ${WAVEFORM_H}px;
    `;

    controls.style.display = "flex";
    container.style.justifyContent = "center";

    const wfContainer = document.createElement("div");
    wfContainer.style.cssText = `
        position: relative;
        flex: 1 1 auto;
        min-height: ${WAVEFORM_H}px;
        width: 100%;
        box-sizing: border-box;
        background: rgba(255,255,255,0.045);
        outline: 1px solid rgba(255,255,255,0.06);
        outline-offset: -1px;
        border-radius: 8px;
        overflow: hidden;
        cursor: crosshair;
        touch-action: none;
    `;

    const canvas = document.createElement("canvas");
    canvas.style.cssText = "width: 100%; height: 100%; display: block;";
    wfContainer.appendChild(canvas);

    const selOverlay = document.createElement("div");
    selOverlay.style.cssText = `
        position: absolute;
        top: 0;
        bottom: 0;
        left: 0;
        width: 0;
        display: none;
        pointer-events: none;
        box-sizing: border-box;
        border: none;
        transition: background 0.2s, box-shadow 0.2s;
    `;
    wfContainer.appendChild(selOverlay);

    const selLabel = document.createElement("div");
    selLabel.textContent = "0.0s";
    selLabel.style.cssText = `
        position: absolute;
        top: 2px;
        transform: translateX(-50%);
        background: rgba(52, 211, 153, 0.20);
        color: ${C.primary};
        font-size: 9px;
        font-weight: 500;
        padding: 1px 6px;
        border-radius: 8px;
        border: 1px solid ${C.selectionBorder};
        display: none;
        pointer-events: none;
        white-space: nowrap;
        font-variant-numeric: tabular-nums;
        transition: background 0.2s, color 0.2s, border-color 0.2s;
        z-index: 2;
    `;
    wfContainer.appendChild(selLabel);

    const playhead = document.createElement("div");
    playhead.style.cssText = `
        position: absolute;
        top: 0;
        bottom: 0;
        width: 2px;
        background: ${C.primaryStrong};
        box-shadow: 0 0 6px ${C.primary};
        display: none;
        pointer-events: none;
        left: 0;
        will-change: left;
        z-index: 1;
    `;
    wfContainer.appendChild(playhead);

    body.appendChild(wfContainer);

    const refs = node.pau_refs;
    refs.wfContainer = wfContainer;
    refs.canvas = canvas;
    refs.selOverlay = selOverlay;
    refs.selLabel = selLabel;
    refs.playhead = playhead;

    if (refs.tDur) refs.tDur.textContent = formatTime(node.pau_duration);

    showLoadedControls(node);
    setupWaveformInteraction(node);
    setupPlayback(node);
    startPlayheadLoop(node);

    if (node.pau_wfRO) {
        try { node.pau_wfRO.disconnect(); } catch (e) {}
        node.pau_wfRO = null;
    }
    if (window.ResizeObserver) {
        node.pau_wfRO = new ResizeObserver(() => {
            relayoutWaveform(node);
            node.pau_paintOverlay?.();
        });
        node.pau_wfRO.observe(wfContainer);
    }

    requestAnimationFrame(() => {
        enforceMinSize(node);
        relayoutWaveform(node);
        node.pau_paintOverlay?.();
    });
}

function relayoutWaveform(node) {
    const refs = node.pau_refs;
    const wf = refs?.wfContainer;
    const canvas = refs?.canvas;

    if (!wf || !canvas || !node.pau_audioBuffer) return;

    const dpr = window.devicePixelRatio || 1;
    const w = Math.max(60, Math.round(wf.clientWidth * dpr));
    const h = Math.max(24, Math.round(wf.clientHeight * dpr));

    if (canvas.width !== w || canvas.height !== h) {
        canvas.width = w;
        canvas.height = h;
        drawWaveform(canvas, node.pau_audioBuffer);
    }
}

function drawWaveform(canvas, audioBuf) {
    const ctx = canvas.getContext("2d");
    const w = canvas.width;
    const h = canvas.height;

    ctx.clearRect(0, 0, w, h);

    const numCh = audioBuf.numberOfChannels;
    const len = audioBuf.length;
    if (!len) return;

    const samplesPerPixel = Math.max(1, Math.floor(len / w));
    const mid = h / 2;

    ctx.fillStyle = C.wave;

    for (let x = 0; x < w; x++) {
        const start = x * samplesPerPixel;
        const end = Math.min(len, start + samplesPerPixel);

        let min = 1.0;
        let max = -1.0;

        for (let c = 0; c < numCh; c++) {
            const data = audioBuf.getChannelData(c);
            for (let i = start; i < end; i++) {
                const v = data[i];
                if (v < min) min = v;
                if (v > max) max = v;
            }
        }

        const y1 = mid - max * (mid - 1);
        const y2 = mid - min * (mid - 1);

        ctx.fillRect(x, y1, 1, Math.max(1, y2 - y1));
    }

    ctx.fillStyle = "rgba(255,255,255,0.18)";
    ctx.fillRect(0, mid, w, 1);
}

/* =====================================================================
Waveform interaction (scale-compensated).
===================================================================== */
function setupWaveformInteraction(node) {
    if (node.pau_cleanupInteraction) node.pau_cleanupInteraction();

    const refs = node.pau_refs;
    const container = refs.wfContainer;
    const overlay = refs.selOverlay;
    const label = refs.selLabel;
    const audio = node.pau_audioElement;
    const state = node.pau_state;

    let dragging = null;
    let dragAnchor = 0;
    let downX = 0;
    let moved = false;

    const getMetrics = () => {
        const rect = container.getBoundingClientRect();
        const localW = container.clientWidth || rect.width || 1;
        const scale = rect.width ? rect.width / localW : 1;
        return { rect, localW, scale: scale || 1 };
    };

    const posToTime = (e) => {
        const { rect, localW, scale } = getMetrics();
        const x = Math.max(0, Math.min((e.clientX - rect.left) / scale, localW));
        const t = node.pau_duration > 0 ? (x / localW) * node.pau_duration : 0;
        return { x, t };
    };

    const onPointerDown = (e) => {
        if (e.button !== 0) return;

        e.preventDefault();
        e.stopPropagation();

        try { container.setPointerCapture(e.pointerId); } catch (err) {}

        const p = posToTime(e);
        downX = p.x;
        moved = false;
        dragging = null;

        if (state.selection && node.pau_duration > 0) {
            const { localW } = getMetrics();
            const sl = (state.selection.start / node.pau_duration) * localW;
            const sr = (state.selection.end / node.pau_duration) * localW;

            if (Math.abs(p.x - sl) <= 6) { dragging = "left"; return; }
            if (Math.abs(p.x - sr) <= 6) { dragging = "right"; return; }
        }

        audio.currentTime = p.t;
    };

    const onPointerMove = (e) => {
        if (!(e.buttons & 1)) return;

        const p = posToTime(e);

        if (!dragging) {
            if (!moved && Math.abs(p.x - downX) > 3) {
                moved = true;
                dragging = "new";
                dragAnchor = (downX / (getMetrics().localW || 1)) * node.pau_duration;

                state.selection = { start: dragAnchor, end: dragAnchor };
                state.trimmed = false;
                updateTrimVisuals(node);
                paintOverlay();
            } else {
                return;
            }
        }

        if (!state.selection) state.selection = { start: p.t, end: p.t };

        if (dragging === "new") {
            state.selection.start = Math.min(dragAnchor, p.t);
            state.selection.end = Math.max(dragAnchor, p.t);
        } else if (dragging === "left") {
            state.selection.start = Math.min(p.t, state.selection.end - 0.05);
        } else if (dragging === "right") {
            state.selection.end = Math.max(p.t, state.selection.start + 0.05);
        }

        state.trimmed = false;
        updateTrimVisuals(node);
        paintOverlay();
    };

    const endDrag = (e) => {
        dragging = null;
        try { container.releasePointerCapture(e.pointerId); } catch (err) {}
    };

    const clearSelection = () => {
        state.selection = null;
        state.trimmed = false;
        updateTrimVisuals(node);
        paintOverlay();
    };

    const onDblClick = (e) => {
        e.preventDefault();
        e.stopPropagation();
        clearSelection();
    };

    const onContextMenu = (e) => {
        e.preventDefault();
        e.stopPropagation();
        clearSelection();
    };

    container.addEventListener("pointerdown", onPointerDown);
    container.addEventListener("pointermove", onPointerMove);
    container.addEventListener("pointerup", endDrag);
    container.addEventListener("pointercancel", endDrag);
    container.addEventListener("dblclick", onDblClick);
    container.addEventListener("contextmenu", onContextMenu);
    container.addEventListener("dragstart", (e) => e.preventDefault());

    node.pau_cleanupInteraction = () => {
        container.removeEventListener("pointerdown", onPointerDown);
        container.removeEventListener("pointermove", onPointerMove);
        container.removeEventListener("pointerup", endDrag);
        container.removeEventListener("pointercancel", endDrag);
        container.removeEventListener("dblclick", onDblClick);
        container.removeEventListener("contextmenu", onContextMenu);
    };

    function paintOverlay() {
        if (!state.selection || node.pau_duration <= 0) {
            overlay.style.display = "none";
            label.style.display = "none";
            updateTrimVisuals(node);
            return;
        }

        const { localW } = getMetrics();

        const sl = (state.selection.start / node.pau_duration) * localW;
        const sr = (state.selection.end / node.pau_duration) * localW;

        overlay.style.left = `${sl}px`;
        overlay.style.width = `${Math.max(0, sr - sl)}px`;
        overlay.style.display = "block";

        const trimmed = !!state.trimmed;

        overlay.style.background = trimmed ? C.trimmedBg : C.selectionBg;
        overlay.style.boxShadow = `inset 0 0 0 2px ${trimmed ? C.trimmedBorder : C.selectionBorder}`;

        label.style.background = trimmed ? C.trimmedLabelBg : "rgba(52, 211, 153, 0.20)";
        label.style.color = trimmed ? C.trimmedBorder : C.primary;
        label.style.borderColor = trimmed ? C.trimmedBorder : C.selectionBorder;

        const dur = state.selection.end - state.selection.start;
        label.textContent = dur.toFixed(1) + "s";

        const cx = (sl + sr) / 2;
        const half = 22;
        label.style.left = `${Math.max(half, Math.min(cx, localW - half))}px`;
        label.style.display = "block";

        updateTrimVisuals(node);
    }

    node.pau_paintOverlay = paintOverlay;
    paintOverlay();
}

/* =====================================================================
Playback + playhead.
===================================================================== */
function setupPlayback(node) {
    if (node.pau_cleanupPlayback) node.pau_cleanupPlayback();

    const audio = node.pau_audioElement;
    const playBtn = node.pau_refs.playBtn;

    const onPlay = () => { if (playBtn) playBtn.innerHTML = SVG.pause; };
    const onPause = () => { if (playBtn) playBtn.innerHTML = SVG.play; };

    audio.addEventListener("play", onPlay);
    audio.addEventListener("pause", onPause);

    node.pau_cleanupPlayback = () => {
        audio.removeEventListener("play", onPlay);
        audio.removeEventListener("pause", onPause);
    };
}

function startPlayheadLoop(node) {
    stopPlayheadLoop(node);

    const tick = () => {
        if (!node.pau_refs || !node.pau_audioElement) return;

        const refs = node.pau_refs;
        const audio = node.pau_audioElement;
        const state = node.pau_state || {};

        const t = audio.currentTime || 0;

        // 播放限制在选区内：到选区末端自动暂停
        if (state.selection && !audio.paused && t >= state.selection.end - 0.01) {
            audio.pause();
            audio.currentTime = state.selection.end;
        }

        if (refs.tCur) refs.tCur.textContent = formatTime(t);

        const playhead = refs.playhead;
        if (playhead && playhead.parentElement) {
            const w = playhead.parentElement.clientWidth || 1;
            const frac = node.pau_duration > 0 ? t / node.pau_duration : 0;

            playhead.style.left = `${frac * w}px`;
            playhead.style.display = audio.paused && t === 0 ? "none" : "block";
        }

        node.pau_rafId = requestAnimationFrame(tick);
    };

    node.pau_rafId = requestAnimationFrame(tick);
}

function stopPlayheadLoop(node) {
    if (node.pau_rafId) {
        cancelAnimationFrame(node.pau_rafId);
        node.pau_rafId = 0;
    }
}

/* =====================================================================
Control wiring.
NEW: restoreBtn = one click -> clear all trim marks, export original.
===================================================================== */
function setupControls(node) {
    const refs = node.pau_refs;
    if (!refs) return;

    const { speakerBtn, playBtn, restoreBtn, cutBtn, uploadBtn, micBtn } = refs;

    speakerBtn.onclick = (e) => {
        e.stopPropagation();

        const audio = node.pau_audioElement;
        if (!audio) return;

        audio.muted = !audio.muted;

        const state = node.pau_state;
        if (state) state.isMuted = audio.muted;

        speakerBtn.innerHTML = audio.muted ? SVG.speakerMute : SVG.speaker;
    };

    playBtn.onclick = (e) => {
        e.stopPropagation();

        const audio = node.pau_audioElement;
        if (!audio) return;

        const state = node.pau_state;

        if (audio.paused) {
            if (state && state.selection) {
                const cur = audio.currentTime || 0;

                if (cur < state.selection.start || cur >= state.selection.end) {
                    audio.currentTime = state.selection.start;
                }
            }

            audio.play().catch(() => {});
        } else {
            audio.pause();
        }
    };

    restoreBtn.onclick = (e) => {
        e.stopPropagation();
        restoreOriginal(node);
    };

    cutBtn.onclick = (e) => {
        e.stopPropagation();

        const state = node.pau_state;
        if (!state) return;

        if (!state.selection) {
            state.selection = { start: 0, end: node.pau_duration || 0 };
        }

        const ts = Number(state.selection.start.toFixed(3));
        const te = Number(state.selection.end.toFixed(3));

        const ok1 = setRequiredWidget(node, "trim_start", ts);
        const ok2 = setRequiredWidget(node, "trim_end", te);

        node.properties[PROP_TRIM_START] = ts;
        node.properties[PROP_TRIM_END] = te;

        markGraphDirty(node);

        try { app.graph?.afterChange?.(); } catch (e) {}

        state.trimmed = true;

        if (node.pau_paintOverlay) node.pau_paintOverlay();
        updateTrimVisuals(node);

        if (!ok1 || !ok2) {
            alert("Failed to save trim values to widgets.");
        }
    };

    uploadBtn.onclick = (e) => {
        e.stopPropagation();
        triggerUpload(node);
    };

    micBtn.onclick = (e) => {
        e.stopPropagation();
        toggleRecord(node, micBtn);
    };
}

/* one click = remove every trim operation/mark, export = original audio */
function restoreOriginal(node) {
    const state = node.pau_state;
    if (state) {
        state.selection = null;
        state.trimmed = false;
    }

    setRequiredWidget(node, "trim_start", 0.0);
    setRequiredWidget(node, "trim_end", -1.0);

    node.properties[PROP_TRIM_START] = 0.0;
    node.properties[PROP_TRIM_END] = -1.0;

    markGraphDirty(node);

    try { app.graph?.afterChange?.(); } catch (e) {}

    node.pau_paintOverlay?.();
    updateTrimVisuals(node);

    console.log("[PainterAudioUpload] restored original: trim cleared (0 / -1)");
}

function updateTrimVisuals(node) {
    const refs = node.pau_refs;
    const state = node.pau_state;

    if (!refs?.cutBtn) return;

    const trimmed = !!(state && state.trimmed);

    refs.cutBtn.style.color = trimmed ? C.trimmedBorder : C.text;
    refs.cutBtn.title = trimmed ? "Trim confirmed" : "Confirm trim";
}

/* =====================================================================
Recording.
===================================================================== */
async function toggleRecord(node, micBtn) {
    if (node.pau_recorder && node.pau_recorder.state === "recording") {
        node.pau_recorder.stop();

        micBtn.innerHTML = SVG.mic;
        micBtn.style.color = C.primary;
        micBtn.style.background = "transparent";

        return;
    }

    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
        alert("This browser does not support audio recording.");
        return;
    }

    let stream;

    try {
        stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch (err) {
        alert("Microphone access denied or not available: " + err.message);
        return;
    }

    const recorder = new MediaRecorder(stream);
    const chunks = [];

    recorder.ondataavailable = (e) => {
        if (e.data && e.data.size) chunks.push(e.data);
    };

    recorder.onstop = async () => {
        stream.getTracks().forEach((t) => t.stop());

        micBtn.innerHTML = SVG.mic;
        micBtn.style.color = C.primary;
        micBtn.style.background = "transparent";

        try {
            const blob = new Blob(chunks, {
                type: recorder.mimeType || "audio/webm",
            });

            const wav = await blobToWav(blob);

            const file = new File([wav], "painter_recording_" + Date.now() + ".wav", {
                type: "audio/wav",
            });

            await handleFile(node, file);
        } catch (err) {
            console.error(err);
            alert("Recording failed: " + err.message);
        }

        node.pau_recorder = null;
    };

    recorder.start();
    node.pau_recorder = recorder;

    micBtn.innerHTML = SVG.recording;
    micBtn.style.color = C.record;
    micBtn.style.background = C.recordBg;
}

async function blobToWav(blob) {
    const arrayBuf = await blob.arrayBuffer();

    const AC = window.AudioContext || window.webkitAudioContext;
    const ctx = new AC();

    let audioBuf;

    try {
        audioBuf = await ctx.decodeAudioData(arrayBuf.slice(0));
    } finally {
        try { ctx.close(); } catch (e) {}
    }

    return encodeWav(audioBuf);
}

function encodeWav(audioBuf) {
    const numCh = audioBuf.numberOfChannels;
    const sr = audioBuf.sampleRate;
    const len = audioBuf.length;

    const bytesPerSample = 2;
    const dataSize = len * numCh * bytesPerSample;

    const buffer = new ArrayBuffer(44 + dataSize);
    const view = new DataView(buffer);

    writeStr(view, 0, "RIFF");
    view.setUint32(4, 36 + dataSize, true);
    writeStr(view, 8, "WAVE");
    writeStr(view, 12, "fmt ");
    view.setUint32(16, 16, true);
    view.setUint16(20, 1, true);
    view.setUint16(22, numCh, true);
    view.setUint32(24, sr, true);
    view.setUint32(28, sr * numCh * bytesPerSample, true);
    view.setUint16(32, numCh * bytesPerSample, true);
    view.setUint16(34, 16, true);
    writeStr(view, 36, "data");
    view.setUint32(40, dataSize, true);

    const channels = [];
    for (let c = 0; c < numCh; c++) channels.push(audioBuf.getChannelData(c));

    let off = 44;

    for (let i = 0; i < len; i++) {
        for (let c = 0; c < numCh; c++) {
            let s = Math.max(-1, Math.min(1, channels[c][i]));
            s = s < 0 ? s * 0x8000 : s * 0x7fff;

            view.setInt16(off, s | 0, true);
            off += 2;
        }
    }

    return new Blob([buffer], { type: "audio/wav" });
}

function writeStr(view, off, str) {
    for (let i = 0; i < str.length; i++) {
        view.setUint8(off + i, str.charCodeAt(i));
    }
}

/* =====================================================================
Clear (right-click menu on node).
===================================================================== */
function clearAudio(node) {
    if (!node.properties?.[PROP_FILENAME]) return;

    const ok = confirm("Clear the loaded audio?");
    if (!ok) return;

    node.properties[PROP_FILENAME] = "";
    node.properties[PROP_TRIM_START] = 0;
    node.properties[PROP_TRIM_END] = -1;

    setRequiredWidget(node, "audio_filename", "");
    setRequiredWidget(node, "trim_start", 0.0);
    setRequiredWidget(node, "trim_end", -1.0);

    if (node.pau_cleanupPlayback) node.pau_cleanupPlayback();
    if (node.pau_cleanupInteraction) node.pau_cleanupInteraction();
    if (node.pau_wfRO) {
        try { node.pau_wfRO.disconnect(); } catch (e) {}
        node.pau_wfRO = null;
    }

    stopPlayheadLoop(node);

    if (node.pau_audioElement) {
        try { node.pau_audioElement.pause(); } catch (e) {}
        node.pau_audioElement.src = "";
        node.pau_audioElement = null;
    }

    node.pau_audioBuffer = null;
    node.pau_duration = 0;

    node.pau_state = {
        selection: null,
        trimmed: false,
        isMuted: false,
    };

    markGraphDirty(node);
    renderEmpty(node);
}

function formatTime(s) {
    if (!isFinite(s) || s < 0) s = 0;

    const m = Math.floor(s / 60);
    const sec = Math.floor(s % 60);

    return m + ":" + sec.toString().padStart(2, "0");
}