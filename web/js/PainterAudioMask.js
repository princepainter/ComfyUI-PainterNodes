import { app } from "../../../scripts/app.js";

/* =====================================================================
PainterAudioMask - draw a 0..1 mask curve over an audio waveform.

- Upload an audio file to show its waveform.
- Draw a mask curve on top of the waveform:
    Curve mode : click empty space to add a control point, drag to move
                 it, double-click a point to delete it. Hold Shift while
                 dragging to snap the value to 0 / 0.5 / 1.
    Block mode : drag a rectangle to set a flat value across a time range.
- The mask value maps to the Y axis: top = 1.0 (regenerate), bottom = 0.0
  (keep). Matches MiniMax H3 `audio_denoise_mask` semantics.
- Confirm writes the control points (JSON) into the hidden `mask_points`
  widget; the Python node resamples them to 40 Hz.
===================================================================== */

const NODE_CLASS = "PainterAudioMask";

const PROP_FILENAME = "pam_filename";
const PROP_POINTS = "pam_points";

/* ----------------------------- layout ----------------------------- */
const NODE_WIDTH = 480;
const WAVEFORM_H = 90;
const CTRLROW_H = 30;
const STATUS_H = 24;
const GAP = 6;
const PAD_X = 10;
const PAD_Y = 6;

const CHROME = 54;

const CONTENT_MIN_H = WAVEFORM_H + CTRLROW_H + STATUS_H + GAP * 2 + PAD_Y * 2;
const DEFAULT_HEIGHT = CONTENT_MIN_H + CHROME;
const MIN_WIDTH = 340;
const MIN_HEIGHT = DEFAULT_HEIGHT;

const SIZE_SANITY_MAX = 4096;

const FRAME_RATE = 40; // MiniMax H3 audio latent frames per second

const REQUIRED_WIDGET_INDEX = {
    mask_points: 0,
    duration: 1,
};

/* ----------------------------- colors ----------------------------- */
const C = {
    wave: "#34d399",
    waveStrong: "#10b981",

    mask: "#ec4899",
    maskFill: "rgba(236, 72, 153, 0.20)",
    maskWeak: "rgba(236, 72, 153, 0.10)",

    point: "#ffffff",
    pointBorder: "#ec4899",

    textMuted: "rgba(255, 255, 255, 0.55)",
    text: "rgba(255, 255, 255, 0.92)",

    hover: "rgba(255, 255, 255, 0.10)",
    pill: "rgba(255, 255, 255, 0.05)",
    pillBorder: "rgba(255, 255, 255, 0.07)",

    blockPreview: "rgba(236, 72, 153, 0.35)",
};

const SVG = {
    upload: `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/></svg>`,
    play: `<svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><polygon points="6 4 20 12 6 20 6 4"/></svg>`,
    pause: `<svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="4" width="4" height="16"/><rect x="14" y="4" width="4" height="16"/></svg>`,
    check: `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>`,
    reset: `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="1 4 1 10 7 10"/><path d="M3.51 15a9 9 0 1 0 2.13-9.36L1 10"/></svg>`,
};

/* =====================================================================
Global pointer-up hook (min-size floor after drag, never during).
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
    name: "Painter.AudioMask",

    async beforeRegisterNodeDef(nodeType, nodeData) {
        if (nodeData.name !== NODE_CLASS) return;

        const origOnNodeCreated = nodeType.prototype.onNodeCreated;
        nodeType.prototype.onNodeCreated = function () {
            const r = origOnNodeCreated?.apply(this, arguments);

            this.properties = this.properties || {};
            this.pam_state = this.pam_state || {};
            this.pam_points = this.pam_points || [];

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

            collapseWidget(this, "mask_points");
            collapseWidget(this, "duration");

            buildUI(this);
            this.pam_clear = () => clearAudio(this);

            return r;
        };

        const origGetExtraMenuOptions = nodeType.prototype.getExtraMenuOptions;
        nodeType.prototype.getExtraMenuOptions = function (_, options) {
            const r = origGetExtraMenuOptions?.apply(this, arguments);
            options = options || [];

            if (this.properties?.[PROP_FILENAME]) {
                options.push({
                    content: "Clear audio",
                    callback: () => this.pam_clear?.(),
                });
            }
            if (this.pam_points?.length) {
                options.push({
                    content: "Clear mask",
                    callback: () => {
                        this.pam_points = [];
                        syncMaskWidget(this);
                        drawMask(this);
                        markGraphDirty(this);
                    },
                });
            }

            return r;
        };

        const origOnConfigure = nodeType.prototype.onConfigure;
        nodeType.prototype.onConfigure = function () {
            const r = origOnConfigure?.apply(this, arguments);

            this.properties = this.properties || {};

            const mpW = this.widgets?.find((w) => w.name === "mask_points");
            const duW = this.widgets?.find((w) => w.name === "duration");

            // Filename lives only in properties (frontend-only; the backend
            // node has no audio_filename widget).
            const fnW = this.widgets?.find((w) => w.name === "audio_filename");
            if (fnW && !this.properties[PROP_FILENAME]) {
                this.properties[PROP_FILENAME] = fnW.value || "";
            }

            const savedPoints = mpW?.value ?? this.properties[PROP_POINTS];
            if (typeof savedPoints === "string" && savedPoints.trim()) {
                try {
                    this.pam_points = JSON.parse(savedPoints);
                } catch (e) {
                    this.pam_points = [];
                }
            } else if (Array.isArray(savedPoints)) {
                this.pam_points = savedPoints;
            } else {
                this.pam_points = [];
            }

            this.pam_duration = duW?.value ?? 10.0;

            collapseWidget(this, "mask_points");
            collapseWidget(this, "duration");

            if (this.pam_built) {
                requestAnimationFrame(() => {
                    enforceMinSize(this);
                    passiveRelayout(this);
                });
                const fn = this.properties[PROP_FILENAME];
                if (fn) {
                    loadAndRender(this, fn).catch((err) =>
                        console.error("[PainterAudioMask] restore failed:", err)
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
            o.properties[PROP_POINTS] = JSON.stringify(this.pam_points || []);

            return r;
        };

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
            this.pam_cleanupPlayback?.();
            this.pam_cleanupInteraction?.();
            this.pam_resizeObserver?.disconnect?.();
            this.pam_wfRO?.disconnect?.();
            this.pam_wrapRO?.disconnect?.();

            if (this.pam_audioElement) {
                try { this.pam_audioElement.pause(); } catch (e) {}
                this.pam_audioElement = null;
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
Size handling (resize-safe, mirror PainterAudioUpload).
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
    drawMask(node);
}

function enforceMinSize(node) {
    const c = node.pam_container;
    if (!c || !node.size) return;

    sanitySize(node);

    const wrapper = node.pam_wrapper || c.parentElement;
    if (wrapper) node.pam_wrapper = wrapper;

    if (!wrapper || wrapper.clientWidth <= 10 || wrapper.clientHeight <= 10) return;

    const dw = Math.max(0, (node.size[0] || 0) - wrapper.clientWidth);
    const dh = Math.max(0, (node.size[1] || 0) - wrapper.clientHeight);

    const needW = (node.pam_controls?.scrollWidth || 300) + PAD_X * 2;
    const needH = CONTENT_MIN_H;

    const targetW = Math.min(SIZE_SANITY_MAX, Math.max(MIN_WIDTH, Math.round(needW + dw)));
    const targetH = Math.min(SIZE_SANITY_MAX, Math.max(MIN_HEIGHT, Math.round(needH + dh)));

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
    const c = node.pam_container;
    if (!c) return;

    let tries = 0;
    const tryAttach = () => {
        const wrapper = c.parentElement;

        if (!wrapper && tries++ < 120) {
            requestAnimationFrame(tryAttach);
            return;
        }
        if (!wrapper) return;

        node.pam_wrapper = wrapper;

        if (!node.pam_wrapRO && window.ResizeObserver) {
            node.pam_wrapRO = new ResizeObserver(() => passiveRelayout(node));
            node.pam_wrapRO.observe(wrapper);
        }

        passiveRelayout(node);
    };

    tryAttach();
}

/* =====================================================================
Build DOM widget.
===================================================================== */
function buildUI(node) {
    if (node.pam_built) return;
    node.pam_built = true;

    bindGlobalPointer();
    MIN_CHECK_NODES.add(node);

    const container = document.createElement("div");
    container.className = "pam-container";
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

    node.addDOMWidget("pam_ui", "audio_ui", container, {
        serialize: false,
        hideOnZoom: false,
    });

    node.pam_container = container;

    const body = document.createElement("div");
    body.className = "pam-body";
    container.appendChild(body);

    const controls = buildControlsRow(node);
    container.appendChild(controls);

    const status = buildStatusRow(node);
    container.appendChild(status);

    node.pam_body = body;
    node.pam_controls = controls;
    node.pam_status = status;

    if (window.ResizeObserver) {
        node.pam_resizeObserver = new ResizeObserver(() => passiveRelayout(node));
        node.pam_resizeObserver.observe(container);
    }

    attachWrapperRO(node);

    const fn = node.properties?.[PROP_FILENAME];
    if (fn) {
        loadAndRender(node, fn).catch((err) =>
            console.error("[PainterAudioMask] initial load failed:", err)
        );
    } else {
        renderEmpty(node);
    }
}

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

function modeBtnStyle(active) {
    return `
        background: ${active ? C.maskFill : "transparent"};
        border: 1px solid ${active ? C.mask : C.pillBorder};
        color: ${active ? C.mask : C.textMuted};
        cursor: pointer;
        padding: 2px 10px;
        border-radius: 7px;
        font-size: 11px;
        font-family: inherit;
        transition: background 0.15s, color 0.15s, border-color 0.15s;
        flex: 0 0 auto;
    `;
}

function buildControlsRow(node) {
    const row = document.createElement("div");
    row.className = "pam-controls";
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

    const playBtn = mkIconBtn(SVG.play, "Play / Pause", C.text);
    const uploadBtn = mkIconBtn(SVG.upload, "Upload audio", C.wave);

    const curveBtn = document.createElement("button");
    curveBtn.textContent = "Curve";
    curveBtn.title = "Add / drag control points (Shift = snap 0 / 0.5 / 1)";

    const blockBtn = document.createElement("button");
    blockBtn.textContent = "Block";
    blockBtn.title = "Drag a rectangle to set a flat mask value";

    const resetBtn = mkIconBtn(SVG.reset, "Clear mask", C.text);
    const confirmBtn = mkIconBtn(SVG.check, "Confirm mask", C.waveStrong);

    row.appendChild(uploadBtn);
    row.appendChild(playBtn);
    row.appendChild(curveBtn);
    row.appendChild(blockBtn);
    row.appendChild(resetBtn);
    row.appendChild(confirmBtn);

    node.pam_refs = node.pam_refs || {};
    Object.assign(node.pam_refs, {
        playBtn,
        uploadBtn,
        curveBtn,
        blockBtn,
        resetBtn,
        confirmBtn,
    });

    node.pam_mode = node.pam_mode || "curve";

    function refreshModeButtons() {
        curveBtn.style.cssText = modeBtnStyle(node.pam_mode === "curve");
        blockBtn.style.cssText = modeBtnStyle(node.pam_mode === "block");
    }

    curveBtn.onclick = (e) => {
        e.stopPropagation();
        node.pam_mode = "curve";
        refreshModeButtons();
    };
    blockBtn.onclick = (e) => {
        e.stopPropagation();
        node.pam_mode = "block";
        refreshModeButtons();
    };

    playBtn.onclick = (e) => {
        e.stopPropagation();
        const audio = node.pam_audioElement;
        if (!audio) return;
        if (audio.paused) audio.play().catch(() => {});
        else audio.pause();
    };

    uploadBtn.onclick = (e) => {
        e.stopPropagation();
        triggerUpload(node);
    };

    resetBtn.onclick = (e) => {
        e.stopPropagation();
        node.pam_points = [];
        syncMaskWidget(node);
        drawMask(node);
        markGraphDirty(node);
    };

    confirmBtn.onclick = (e) => {
        e.stopPropagation();
        confirmMask(node);
    };

    refreshModeButtons();

    return row;
}

function buildStatusRow(node) {
    const row = document.createElement("div");
    row.className = "pam-status";
    row.style.cssText = `
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 10px;
        width: 100%;
        height: ${STATUS_H}px;
        padding: 0 2px;
        box-sizing: border-box;
        background: transparent;
        flex: 0 0 auto;
        font-size: 11px;
        color: ${C.textMuted};
        font-variant-numeric: tabular-nums;
    `;

    const durWrap = document.createElement("span");
    durWrap.style.cssText = "display: flex; align-items: center; gap: 4px; flex: 0 0 auto;";
    const durLabel = document.createElement("span");
    durLabel.textContent = "Duration";
    const durInput = document.createElement("input");
    durInput.type = "number";
    durInput.min = "0.1";
    durInput.max = "1000";
    durInput.step = "0.1";
    durInput.value = node.pam_duration ?? 10.0;
    durInput.style.cssText = `
        width: 52px;
        background: ${C.pill};
        border: 1px solid ${C.pillBorder};
        color: ${C.text};
        border-radius: 6px;
        padding: 2px 4px;
        font-size: 11px;
        font-family: inherit;
        text-align: right;
    `;
    const durSuffix = document.createElement("span");
    durSuffix.textContent = "s";
    durWrap.appendChild(durLabel);
    durWrap.appendChild(durInput);
    durWrap.appendChild(durSuffix);

    const info = document.createElement("span");
    info.style.cssText = "flex: 0 0 auto;";
    info.textContent = "0 points · 0 frames";

    const hint = document.createElement("span");
    hint.style.cssText = `
        flex: 1 1 auto;
        text-align: right;
        overflow: hidden;
        white-space: nowrap;
        text-overflow: ellipsis;
    `;
    hint.textContent = "top = regenerate · bottom = keep";

    row.appendChild(durWrap);
    row.appendChild(info);
    row.appendChild(hint);

    node.pam_refs = node.pam_refs || {};
    node.pam_refs.durInput = durInput;
    node.pam_refs.info = info;

    durInput.onchange = () => {
        let v = parseFloat(durInput.value);
        if (!isFinite(v) || v <= 0) v = 0.1;
        v = Math.min(1000, Math.max(0.1, v));
        durInput.value = v;
        node.pam_duration = v;
        setRequiredWidget(node, "duration", v);
        updateStatus(node);
        drawMask(node);
        markGraphDirty(node);
    };

    updateStatus(node);

    return row;
}

function updateStatus(node) {
    const refs = node.pam_refs;
    if (!refs?.info) return;
    const n = node.pam_points?.length || 0;
    const frames = Math.max(1, Math.round((node.pam_duration || 0) * FRAME_RATE));
    refs.info.textContent = `${n} point${n === 1 ? "" : "s"} · ${frames} frames`;
}

/* =====================================================================
Empty state.
===================================================================== */
function renderEmpty(node) {
    const body = node.pam_body;
    const controls = node.pam_controls;
    const container = node.pam_container;
    const status = node.pam_status;

    if (!body || !controls || !container) return;

    body.innerHTML = "";
    body.style.display = "none";
    if (status) status.style.display = "none";

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

    stopPlayheadLoop(node);

    requestAnimationFrame(() => {
        enforceMinSize(node);
        passiveRelayout(node);
    });
}

/* =====================================================================
Upload.
===================================================================== */
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
    if (!/\.[a-z0-9]+$/i.test(filename)) filename += ".wav";

    const formData = new FormData();
    formData.append("image", file, filename);
    formData.append("type", "input");
    formData.append("overwrite", "true");

    const response = await fetch("/upload/image", {
        method: "POST",
        body: formData,
    });
    if (!response.ok) throw new Error("HTTP " + response.status);

    const data = await response.json();
    const savedName = data.name || data.filename || filename;

    node.properties[PROP_FILENAME] = savedName;

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

    return false;
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
        "/view?filename=" + encodeURIComponent(filename) + "&type=input&t=" + Date.now();

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

    if (node.pam_cleanupPlayback) node.pam_cleanupPlayback();
    if (node.pam_cleanupInteraction) node.pam_cleanupInteraction();
    if (node.pam_wfRO) {
        try { node.pam_wfRO.disconnect(); } catch (e) {}
        node.pam_wfRO = null;
    }
    stopPlayheadLoop(node);

    if (node.pam_audioElement) {
        try { node.pam_audioElement.pause(); } catch (e) {}
        node.pam_audioElement.src = "";
    }

    const audio = new Audio();
    audio.src = url;
    audio.preload = "auto";
    audio.loop = false;

    node.pam_audioElement = audio;
    node.pam_audioBuffer = audioBuf;

    // Auto-set duration from the uploaded audio.
    node.pam_duration = Math.max(0.1, Math.round(audioBuf.duration * 10) / 10);
    setRequiredWidget(node, "duration", node.pam_duration);

    renderLoaded(node);
}

function renderLoaded(node) {
    const body = node.pam_body;
    const controls = node.pam_controls;
    const container = node.pam_container;
    const status = node.pam_status;

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
    if (status) status.style.display = "flex";
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
    canvas.style.cssText = "width: 100%; height: 100%; display: block; position: absolute; top: 0; left: 0;";
    wfContainer.appendChild(canvas);

    const maskCanvas = document.createElement("canvas");
    maskCanvas.style.cssText =
        "width: 100%; height: 100%; display: block; position: absolute; top: 0; left: 0; pointer-events: none;";
    wfContainer.appendChild(maskCanvas);

    const playhead = document.createElement("div");
    playhead.style.cssText = `
        position: absolute;
        top: 0;
        bottom: 0;
        width: 2px;
        background: ${C.waveStrong};
        box-shadow: 0 0 6px ${C.wave};
        display: none;
        pointer-events: none;
        left: 0;
        will-change: left;
        z-index: 1;
    `;
    wfContainer.appendChild(playhead);

    body.appendChild(wfContainer);

    const refs = node.pam_refs;
    refs.wfContainer = wfContainer;
    refs.canvas = canvas;
    refs.maskCanvas = maskCanvas;
    refs.playhead = playhead;

    if (refs.durInput) refs.durInput.value = node.pam_duration;

    setupWaveformInteraction(node);
    setupPlayback(node);
    startPlayheadLoop(node);
    updateStatus(node);

    if (node.pam_wfRO) {
        try { node.pam_wfRO.disconnect(); } catch (e) {}
        node.pam_wfRO = null;
    }
    if (window.ResizeObserver) {
        node.pam_wfRO = new ResizeObserver(() => {
            relayoutWaveform(node);
            drawMask(node);
        });
        node.pam_wfRO.observe(wfContainer);
    }

    requestAnimationFrame(() => {
        enforceMinSize(node);
        relayoutWaveform(node);
        drawMask(node);
    });
}

function relayoutWaveform(node) {
    const refs = node.pam_refs;
    const wf = refs?.wfContainer;
    const canvas = refs?.canvas;

    if (!wf || !canvas || !node.pam_audioBuffer) return;

    const dpr = window.devicePixelRatio || 1;
    const w = Math.max(60, Math.round(wf.clientWidth * dpr));
    const h = Math.max(24, Math.round(wf.clientHeight * dpr));

    if (canvas.width !== w || canvas.height !== h) {
        canvas.width = w;
        canvas.height = h;
        drawWaveform(canvas, node.pam_audioBuffer);
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
Mask drawing (overlay canvas).
===================================================================== */
function drawMask(node) {
    const refs = node.pam_refs;
    const canvas = refs?.maskCanvas;
    const wf = refs?.wfContainer;

    if (!canvas || !wf) return;

    const dpr = window.devicePixelRatio || 1;
    const w = Math.max(60, Math.round(wf.clientWidth * dpr));
    const h = Math.max(24, Math.round(wf.clientHeight * dpr));

    if (canvas.width !== w || canvas.height !== h) {
        canvas.width = w;
        canvas.height = h;
    }

    const ctx = canvas.getContext("2d");
    ctx.clearRect(0, 0, w, h);

    const dur = node.pam_duration || 1;
    const points = (node.pam_points || []).slice().sort((a, b) => a.t - b.t);

    if (points.length === 0) return;

    const sx = (t) => (t / dur) * w;
    const sy = (v) => (1 - Math.min(1, Math.max(0, v))) * h;

    // Fill area under the curve down to the bottom (v = 0).
    ctx.beginPath();
    ctx.moveTo(sx(points[0].t), h);
    ctx.lineTo(sx(points[0].t), sy(points[0].v));
    for (let i = 1; i < points.length; i++) {
        ctx.lineTo(sx(points[i].t), sy(points[i].v));
    }
    ctx.lineTo(sx(points[points.length - 1].t), h);
    ctx.closePath();
    ctx.fillStyle = C.maskFill;
    ctx.fill();

    // The curve itself.
    ctx.beginPath();
    ctx.moveTo(sx(points[0].t), sy(points[0].v));
    for (let i = 1; i < points.length; i++) {
        ctx.lineTo(sx(points[i].t), sy(points[i].v));
    }
    ctx.strokeStyle = C.mask;
    ctx.lineWidth = 2.5;
    ctx.lineJoin = "round";
    ctx.lineCap = "round";
    ctx.stroke();

    // Control point handles.
    for (let i = 0; i < points.length; i++) {
        const x = sx(points[i].t);
        const y = sy(points[i].v);
        ctx.beginPath();
        ctx.arc(x, y, 5, 0, Math.PI * 2);
        ctx.fillStyle = C.point;
        ctx.fill();
        ctx.strokeStyle = C.pointBorder;
        ctx.lineWidth = 2;
        ctx.stroke();
    }
}

/* =====================================================================
Interaction: curve points + block rectangles.
===================================================================== */
function setupWaveformInteraction(node) {
    if (node.pam_cleanupInteraction) node.pam_cleanupInteraction();

    const refs = node.pam_refs;
    const container = refs.wfContainer;
    const audio = node.pam_audioElement;

    let drag = null; // { kind: "point", index } | { kind: "block", anchorT, anchorV, t, v }

    const getMetrics = () => {
        const rect = container.getBoundingClientRect();
        const localW = container.clientWidth || rect.width || 1;
        const localH = container.clientHeight || rect.height || 1;
        const scaleX = rect.width ? rect.width / localW : 1;
        const scaleY = rect.height ? rect.height / localH : 1;
        return { rect, localW, localH, scaleX: scaleX || 1, scaleY: scaleY || 1 };
    };

    const posToPoint = (e) => {
        const { rect, localW, localH, scaleX, scaleY } = getMetrics();
        const x = Math.max(0, Math.min((e.clientX - rect.left) / scaleX, localW));
        const y = Math.max(0, Math.min((e.clientY - rect.top) / scaleY, localH));
        const dur = node.pam_duration || 1;
        const t = (x / localW) * dur;
        const v = 1 - y / localH;
        return { x, y, t, v };
    };

    const hitTest = (e) => {
        const { rect, localW, localH, scaleX, scaleY } = getMetrics();
        const px = (e.clientX - rect.left) / scaleX;
        const py = (e.clientY - rect.top) / scaleY;
        const dur = node.pam_duration || 1;
        const points = node.pam_points || [];

        let best = -1;
        let bestDist = 8;

        for (let i = 0; i < points.length; i++) {
            const cx = (points[i].t / dur) * localW;
            const cy = (1 - points[i].v) * localH;
            const d = Math.hypot(px - cx, py - cy);
            if (d < bestDist) {
                bestDist = d;
                best = i;
            }
        }

        return best;
    };

    const onPointerDown = (e) => {
        if (e.button !== 0) return;

        e.preventDefault();
        e.stopPropagation();

        try { container.setPointerCapture(e.pointerId); } catch (err) {}

        const p = posToPoint(e);

        if (node.pam_mode === "curve") {
            const hit = hitTest(e);
            if (hit >= 0) {
                drag = { kind: "point", index: hit };
            } else {
                const idx = node.pam_points.length;
                node.pam_points.push({ t: p.t, v: p.v });
                drag = { kind: "point", index: idx };
                drawMask(node);
            }
        } else {
            // block mode
            drag = { kind: "block", anchorT: p.t, anchorV: p.v, t: p.t, v: p.v };
        }
    };

    const onPointerMove = (e) => {
        if (!(e.buttons & 1)) return;

        const p = posToPoint(e);

        if (!drag) return;

        if (drag.kind === "point") {
            let v = p.v;
            if (e.shiftKey) {
                // snap to 0 / 0.5 / 1
                if (v < 0.25) v = 0;
                else if (v < 0.75) v = 0.5;
                else v = 1;
            }
            node.pam_points[drag.index] = { t: p.t, v };
            drawMask(node);
        } else if (drag.kind === "block") {
            drag.t = p.t;
            drag.v = p.v;
            drawBlockPreview(node, drag);
        }
    };

    const endDrag = (e) => {
        if (drag) {
            if (drag.kind === "block") {
                commitBlock(node, drag);
            }
            syncMaskWidget(node);
            markGraphDirty(node);
            drawMask(node);
            updateStatus(node);
        }
        drag = null;
        try { container.releasePointerCapture(e.pointerId); } catch (err) {}
    };

    const onDblClick = (e) => {
        e.preventDefault();
        e.stopPropagation();

        if (node.pam_mode !== "curve") return;

        const hit = hitTest(e);
        if (hit >= 0) {
            node.pam_points.splice(hit, 1);
            syncMaskWidget(node);
            drawMask(node);
            updateStatus(node);
        }
    };

    const onContextMenu = (e) => {
        e.preventDefault();
        e.stopPropagation();
        node.pam_points = [];
        syncMaskWidget(node);
        drawMask(node);
        updateStatus(node);
    };

    container.addEventListener("pointerdown", onPointerDown);
    container.addEventListener("pointermove", onPointerMove);
    container.addEventListener("pointerup", endDrag);
    container.addEventListener("pointercancel", endDrag);
    container.addEventListener("dblclick", onDblClick);
    container.addEventListener("contextmenu", onContextMenu);
    container.addEventListener("dragstart", (e) => e.preventDefault());

    node.pam_cleanupInteraction = () => {
        container.removeEventListener("pointerdown", onPointerDown);
        container.removeEventListener("pointermove", onPointerMove);
        container.removeEventListener("pointerup", endDrag);
        container.removeEventListener("pointercancel", endDrag);
        container.removeEventListener("dblclick", onDblClick);
        container.removeEventListener("contextmenu", onContextMenu);
    };
}

function drawBlockPreview(node, drag) {
    drawMask(node);

    const refs = node.pam_refs;
    const canvas = refs?.maskCanvas;
    const wf = refs?.wfContainer;
    if (!canvas || !wf) return;

    const ctx = canvas.getContext("2d");
    const dpr = window.devicePixelRatio || 1;
    const w = canvas.width;
    const h = canvas.height;
    const dur = node.pam_duration || 1;

    const x0 = (Math.min(drag.anchorT, drag.t) / dur) * w;
    const x1 = (Math.max(drag.anchorT, drag.t) / dur) * w;
    const y = (1 - Math.min(1, Math.max(0, drag.v))) * h;

    ctx.fillStyle = C.blockPreview;
    ctx.fillRect(x0, 0, Math.max(1, x1 - x0), y);

    ctx.strokeStyle = C.mask;
    ctx.lineWidth = 1;
    ctx.setLineDash([4, 3]);
    ctx.strokeRect(x0, 0, Math.max(1, x1 - x0), h);
    ctx.setLineDash([]);
}

function commitBlock(node, drag) {
    const t0 = Math.min(drag.anchorT, drag.t);
    const t1 = Math.max(drag.anchorT, drag.t);
    const v = Math.min(1, Math.max(0, drag.v));

    if (t1 - t0 < 0.01) return;

    // Remove points inside the range, then add the two platform edges.
    node.pam_points = (node.pam_points || []).filter(
        (p) => p.t <= t0 || p.t >= t1
    );
    node.pam_points.push({ t: t0, v });
    node.pam_points.push({ t: t1, v });
    node.pam_points.sort((a, b) => a.t - b.t);
}

function syncMaskWidget(node) {
    setRequiredWidget(node, "mask_points", JSON.stringify(node.pam_points || []));
}

function confirmMask(node) {
    syncMaskWidget(node);
    markGraphDirty(node);
    try { app.graph?.afterChange?.(); } catch (e) {}
    updateStatus(node);
    drawMask(node);
}

/* =====================================================================
Playback + playhead.
===================================================================== */
function setupPlayback(node) {
    if (node.pam_cleanupPlayback) node.pam_cleanupPlayback();

    const audio = node.pam_audioElement;
    const playBtn = node.pam_refs?.playBtn;

    const onPlay = () => { if (playBtn) playBtn.innerHTML = SVG.pause; };
    const onPause = () => { if (playBtn) playBtn.innerHTML = SVG.play; };

    audio.addEventListener("play", onPlay);
    audio.addEventListener("pause", onPause);

    node.pam_cleanupPlayback = () => {
        audio.removeEventListener("play", onPlay);
        audio.removeEventListener("pause", onPause);
    };
}

function startPlayheadLoop(node) {
    stopPlayheadLoop(node);

    const tick = () => {
        if (!node.pam_refs || !node.pam_audioElement) return;

        const refs = node.pam_refs;
        const audio = node.pam_audioElement;
        const t = audio.currentTime || 0;

        const playhead = refs.playhead;
        if (playhead && playhead.parentElement) {
            const w = playhead.parentElement.clientWidth || 1;
            const frac = node.pam_duration > 0 ? t / node.pam_duration : 0;
            playhead.style.left = `${frac * w}px`;
            playhead.style.display = audio.paused && t === 0 ? "none" : "block";
        }

        node.pam_rafId = requestAnimationFrame(tick);
    };

    node.pam_rafId = requestAnimationFrame(tick);
}

function stopPlayheadLoop(node) {
    if (node.pam_rafId) {
        cancelAnimationFrame(node.pam_rafId);
        node.pam_rafId = 0;
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
    node.pam_points = [];

    if (node.pam_cleanupPlayback) node.pam_cleanupPlayback();
    if (node.pam_cleanupInteraction) node.pam_cleanupInteraction();
    if (node.pam_wfRO) {
        try { node.pam_wfRO.disconnect(); } catch (e) {}
        node.pam_wfRO = null;
    }

    stopPlayheadLoop(node);

    if (node.pam_audioElement) {
        try { node.pam_audioElement.pause(); } catch (e) {}
        node.pam_audioElement.src = "";
        node.pam_audioElement = null;
    }

    node.pam_audioBuffer = null;

    markGraphDirty(node);
    renderEmpty(node);
}
