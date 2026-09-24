import { app } from "../../../scripts/app.js";
import { api } from "../../../scripts/api.js";

/*
 * PainterVideoCombine2 — 前端
 *
 * 在节点第一行（images 行）上，水平居中放两个小图标按钮：
 *
 *   ⟳  同步预览：与右键菜单 "Sync preview" 完全一致 —— 工作区内所有 Painter
 *      预览视频回到起点重新播放，动图（gif/webp）刷新 src 重启动画。
 *   ⏸/▶ 同步暂停 / 继续播放：工作区内所有 Painter 预览视频一起暂停，
 *      再点一次一起继续播放。
 *
 * 设计要点：
 *   - 按钮是**真实 DOM**（不是 canvas 绘制），放在 #graph-canvas-container
 *     里的独立覆盖层上，因此 **Nodes 2.0（Vue 节点）模式下同样存在可用**。
 *   - **水平居中于节点**：节点放大/缩小、拖宽拖窄，按钮始终居中。
 *   - 尺寸随画布缩放同步（跟着 ds.scale），视觉上永远贴着节点。
 *   - 不新增任何 widget，节点尺寸与排版保持不变。
 *   - 位置由一个全局 rAF 循环维护；两种渲染模式分别取锚点：
 *       · Nodes 2.0：节点本身就是 DOM（.lg-node[data-node-id]），
 *         images 行是第一个 .lg-slot--input。
 *       · 传统渲染：用 node.pos / ds.offset / ds.scale 换算，行位置取
 *         getConnectionPos()（回退 input.boundingRect）。
 *
 * 其余一切（布局、widget、预览播放器、右键菜单）与原节点保持一致。
 * 原节点 PainterVideoCombine 不做任何改动。
 */

// 文案 / tooltip 用 Unicode 转义，避免任何服务端编码问题。
const TIP_SYNC = "\u540c\u6b65\u9884\u89c8";        // 同步预览
const TIP_PAUSE = "\u540c\u6b65\u6682\u505c";       // 同步暂停
const TIP_RESUME = "\u7ee7\u7eed\u540c\u6b65\u64ad\u653e"; // 继续同步播放

// 同步操作覆盖的节点类型（含老节点，方便一个工作流里混用）
const SYNC_NODE_TYPES = ["PainterVideoCombine", "PainterVideoCombine2"];

// 按钮尺寸（CSS px，未缩放）
const BTN_W = 22;
const BTN_H = 18;
const BTN_GAP = 4;
const ICON_SIZE = 13;

const LAYER_CLASS = "painter-sync-btn-layer";
const STYLE_ID = "painter-sync-btn-style";

const ICON_SYNC = `<svg width="${ICON_SIZE}" height="${ICON_SIZE}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12a9 9 0 1 1-3.2-6.9"/><polyline points="21 3 21 8.6 15.4 8.6"/></svg>`;

const ICON_PAUSE = `<svg width="${ICON_SIZE}" height="${ICON_SIZE}" viewBox="0 0 24 24" fill="currentColor"><rect x="6.4" y="5" width="3.7" height="14" rx="1.2"/><rect x="13.9" y="5" width="3.7" height="14" rx="1.2"/></svg>`;

const ICON_PLAY = `<svg width="${ICON_SIZE}" height="${ICON_SIZE}" viewBox="0 0 24 24" fill="currentColor"><path d="M8 5.2v13.6L19.2 12z"/></svg>`;

// 全局同步状态：工作区内所有预览节点共享
let syncPaused = false;

// ---------------------------------------------------------------------------
// 同步操作
// ---------------------------------------------------------------------------

function getGraph(node) {
    return node?.graph || app.canvas?.graph || app.graph;
}

function findMediaElement(node) {
    if (node.painter_media_element) return node.painter_media_element;
    if (!node.widgets) return null;
    for (const w of node.widgets) {
        const el = w.element;
        if (!el) continue;
        if (el.tagName === "VIDEO" || el.tagName === "IMG") return el;
        const m = el.querySelector?.("video, img");
        if (m) return m;
    }
    return null;
}

function collectPreviewNodes(node) {
    const all = getGraph(node)?._nodes || [];
    return all.filter((n) => SYNC_NODE_TYPES.includes(n.type));
}

function refreshAll(node) {
    for (const n of collectPreviewNodes(node)) {
        n.setDirtyCanvas?.(true, true);
    }
}

/** 与右键菜单 "Sync preview" 一致：全部回起点重播 / 动图重启动画 */
function syncPreviewAll(node) {
    for (const n of collectPreviewNodes(node)) {
        const m = n.painter_media_element || findMediaElement(n);
        if (!m) continue;
        if (m.tagName === "IMG") {
            const src = m.src;
            const sep = src && src.indexOf("?") >= 0 ? "&" : "?";
            m.src = (src || "") + sep + "_ts=" + Date.now();
        } else {
            try {
                m.pause();
                m.currentTime = 0;
                m.load();
                const p = m.play();
                if (p && typeof p.catch === "function") p.catch(() => {});
            } catch (e) {
                // best-effort; some browsers may briefly reject autoplay
            }
        }
    }
    // 手动同步预览 = 重新开始播放，状态回到「播放中」
    if (syncPaused) {
        syncPaused = false;
        applyPauseVisual();
        refreshAll(node);
    }
}

/** 全部暂停 <-> 全部继续播放 */
function syncTogglePause(node) {
    syncPaused = !syncPaused;

    for (const n of collectPreviewNodes(node)) {
        const m = n.painter_media_element || findMediaElement(n);
        if (!m || m.tagName !== "VIDEO") continue; // 动图无法暂停，跳过
        try {
            if (syncPaused) {
                m.pause();
            } else {
                const p = m.play();
                if (p && typeof p.catch === "function") p.catch(() => {});
            }
        } catch (e) {
            // best-effort
        }
    }

    applyPauseVisual();
    refreshAll(node);
    return syncPaused;
}

/** 把暂停状态反映到所有新节点的按钮图标上 */
function applyPauseVisual() {
    for (const n of collectPreviewNodes(null)) {
        if (n.type !== "PainterVideoCombine2") continue;
        const b = n.painter_btn_pause;
        if (!b) continue;
        b.innerHTML = syncPaused ? ICON_PLAY : ICON_PAUSE;
        b.title = syncPaused ? TIP_RESUME : TIP_PAUSE;
        b.classList.toggle("painter-sync-btn--on", syncPaused);
    }
}

// ---------------------------------------------------------------------------
// 按钮（DOM 覆盖层，Nodes 2.0 与传统渲染通用）
// ---------------------------------------------------------------------------

function ensureStyle() {
    if (document.getElementById(STYLE_ID)) return;
    const s = document.createElement("style");
    s.id = STYLE_ID;
    s.textContent = `
        .painter-sync-btns { position: absolute; left: 0; top: 0; display: flex; gap: ${BTN_GAP}px;
                             transform-origin: 0 0; pointer-events: none; }
        .painter-sync-btn { width: ${BTN_W}px; height: ${BTN_H}px; box-sizing: border-box;
                            display: flex; align-items: center; justify-content: center;
                            background: #2a2a2a; border: 1px solid #5c5c5c; border-radius: 4px;
                            color: #e0e0e0; cursor: pointer; pointer-events: auto;
                            user-select: none; -webkit-user-select: none; }
        .painter-sync-btn:hover { background: #3c3c3c; border-color: #8a8a8a; }
        .painter-sync-btn:active { background: #4a4a4a; }
        .painter-sync-btn--on { background: #8c1f1f; border-color: #e35b5b; color: #ffffff; }
        .painter-sync-btn--on:hover { background: #a32323; border-color: #ff6b6b; }
    `;
    document.head.appendChild(s);
}

function ensureLayer() {
    const host = document.getElementById("graph-canvas-container")
        || app.canvas?.canvas?.parentElement;
    if (!host) return null;
    let layer = host.querySelector(":scope > ." + LAYER_CLASS);
    if (!layer) {
        layer = document.createElement("div");
        layer.className = LAYER_CLASS;
        layer.style.cssText = "position:absolute;left:0;top:0;width:100%;height:100%;" +
                              "pointer-events:none;z-index:5;overflow:hidden;";
        host.appendChild(layer);
    }
    return layer;
}

function makeButton(icon, title, isToggle, onClick) {
    const b = document.createElement("div");
    b.className = "painter-sync-btn" + (isToggle ? " painter-sync-btn--toggle" : "");
    b.title = title;
    b.innerHTML = icon;
    const eat = (e) => { e.stopPropagation(); };
    b.addEventListener("pointerdown", eat, true);
    b.addEventListener("mousedown", eat, true);
    b.addEventListener("click", (e) => {
        e.stopPropagation();
        e.preventDefault();
        try { onClick(); } catch (err) { /* ignore */ }
    });
    return b;
}

function ensureWrap(node) {
    const cur = node.painter_btn_wrap;
    if (cur && cur.isConnected && cur.parentElement?.classList?.contains(LAYER_CLASS)) return cur;

    const layer = ensureLayer();
    if (!layer) return null;

    const wrap = document.createElement("div");
    wrap.className = "painter-sync-btns";

    const b1 = makeButton(ICON_SYNC, TIP_SYNC, false, () => syncPreviewAll(node));
    const b2 = makeButton(syncPaused ? ICON_PLAY : ICON_PAUSE, syncPaused ? TIP_RESUME : TIP_PAUSE, true,
                          () => syncTogglePause(node));
    if (syncPaused) b2.classList.add("painter-sync-btn--on");

    wrap.appendChild(b1);
    wrap.appendChild(b2);
    layer.appendChild(wrap);

    node.painter_btn_wrap = wrap;
    node.painter_btn_pause = b2;
    node.painter_btn_main = b1;
    return wrap;
}

/** images 行在节点局部坐标里的中心 y（传统渲染用） */
function getFirstRowCenterY(node) {
    // 1) 绘制后记录的 input slot 矩形中心
    const br = node.inputs?.[0]?.boundingRect;
    if (br && Number.isFinite(br[1]) && Number.isFinite(br[3]) && br[3] > 0) {
        const ly = br[1] + br[3] / 2 - node.pos[1];
        if (ly > 0 && ly < 400) return ly;
    }
    // 2) LiteGraph 官方 API（返回 slot 中心点，graph 空间）
    try {
        if (typeof node.getConnectionPos === "function") {
            const out = [0, 0];
            const p = node.getConnectionPos(true, 0, out);
            if (p && Number.isFinite(p[1])) {
                const ly = p[1] - node.pos[1];
                if (ly > 0 && ly < 400) return ly;
            }
        }
    } catch (e) {
        // fall through
    }
    // 3) 兜底：从第一个 widget 行往上推一行（slot 20 + 间距 12）
    const firstWidget = node.widgets?.find((w) => w.name !== "painter_preview");
    if (firstWidget && Number.isFinite(firstWidget.y)) {
        const ly = firstWidget.y - 32;
        if (ly > 0) return ly;
    }
    return null;
}

/**
 * 返回节点在覆盖层坐标系里的锚点：
 *   { x, y, w, rowCenterY, scale }
 * 两种渲染模式分别取不同来源。
 */
function computeAnchor(node, layer) {
    const layerRect = layer.getBoundingClientRect();

    // --- Nodes 2.0：节点本身就是 DOM ---
    let el = null;
    try {
        el = document.querySelector(`.lg-node[data-node-id="${node.id}"]`);
    } catch (e) {
        el = null;
    }
    if (el) {
        const r = el.getBoundingClientRect();
        if (r.width > 1 && r.height > 1) {
            const slot = el.querySelector(".lg-slot--input");
            const sr = slot ? slot.getBoundingClientRect() : null;
            // slot 中心相对节点顶部约 15.3%（248px 宽时是 38px）
            const rowCenterY = sr
                ? sr.top + sr.height / 2 - layerRect.top
                : r.top - layerRect.top + r.width * 0.153;
            return {
                x: r.left - layerRect.left,
                y: r.top - layerRect.top,
                w: r.width,
                rowCenterY,
                scale: app.canvas?.ds?.scale ?? 1,
            };
        }
    }

    // --- 传统 canvas 渲染 ---
    const cvs = app.canvas?.canvas;
    if (!cvs) return null;
    const rowLy = getFirstRowCenterY(node);
    if (rowLy == null) return null;
    const ds = app.canvas.ds || { scale: 1, offset: [0, 0] };
    const cRect = cvs.getBoundingClientRect();
    const x = cRect.left - layerRect.left + (node.pos[0] + ds.offset[0]) * ds.scale;
    const y = cRect.top - layerRect.top + (node.pos[1] + ds.offset[1]) * ds.scale;
    return {
        x,
        y,
        w: node.size[0] * ds.scale,
        rowCenterY: y + rowLy * ds.scale,
        scale: ds.scale,
    };
}

function updateWrap(node) {
    const wrap = ensureWrap(node);
    if (!wrap) return;

    const layer = wrap.parentElement;
    const a = layer ? computeAnchor(node, layer) : null;
    if (!a) {
        if (wrap.style.display !== "none") wrap.style.display = "none";
        return;
    }

    const s = Number.isFinite(a.scale) && a.scale > 0 ? a.scale : 1;
    const totalW = BTN_W * 2 + BTN_GAP;
    const left = a.x + a.w / 2 - (totalW * s) / 2;   // 水平居中于节点
    const top = a.rowCenterY - (BTN_H * s) / 2;      // 垂直居中于 images 行

    const key = `${left.toFixed(1)}|${top.toFixed(1)}|${s.toFixed(3)}`;
    if (wrap.__posKey !== key) {
        wrap.__posKey = key;
        wrap.style.transform = `translate(${left}px, ${top}px) scale(${s})`;
    }
    if (wrap.style.display !== "flex") wrap.style.display = "flex";
}

let tickerStarted = false;
function startTicker() {
    if (tickerStarted) return;
    tickerStarted = true;
    const loop = () => {
        try {
            const graph = app.graph || app.canvas?.graph;
            for (const n of (graph?._nodes || [])) {
                if (n.type === "PainterVideoCombine2") updateWrap(n);
            }
        } catch (e) {
            // 任何绘制异常都不能影响画布
        }
        requestAnimationFrame(loop);
    };
    requestAnimationFrame(loop);
}

// ---------------------------------------------------------------------------

app.registerExtension({
    name: "Painter.VideoCombine2",
    async beforeRegisterNodeDef(nodeType, nodeData) {
        if (nodeData.name !== "PainterVideoCombine2") return;

        ensureStyle();
        startTicker();

        const SIDE_MARGIN = 15;
        const BOTTOM_MARGIN = 20;

        const onDrawForeground = nodeType.prototype.onDrawForeground;
        nodeType.prototype.onDrawForeground = function (ctx) {
            onDrawForeground?.apply(this, arguments);
            if (this.progress > 0 && this.progress < 1) {
                ctx.save();
                ctx.fillStyle = "#FFD700";
                ctx.fillRect(0, -2, this.size[0] * this.progress, 4);
                ctx.restore();
            }
        };

        const onRemoved = nodeType.prototype.onRemoved;
        nodeType.prototype.onRemoved = function () {
            try {
                this.painter_btn_wrap?.remove();
            } catch (e) {
                // ignore
            }
            this.painter_btn_wrap = null;
            this.painter_btn_pause = null;
            this.painter_btn_main = null;
            onRemoved?.apply(this, arguments);
        };

        function getHeaderAndWidgetHeight(node) {
            let height = 24;
            if (node.widgets) {
                for (const w of node.widgets) {
                    if (w.name !== "painter_preview" && w.type !== "hidden") {
                        height += (w.computeSize ? w.computeSize(node.size[0])[1] : 20) + 18;
                    }
                }
            }
            return height;
        }

        function getPreviewWidget(node) {
            return node.widgets?.find(w => w.name === "painter_preview");
        }

        function getPreviewTop(node) {
            const widget = getPreviewWidget(node);
            if (widget) {
                if (typeof widget.y === "number" && widget.y > 0) return widget.y;
                if (typeof widget.last_y === "number" && widget.last_y > 0) return widget.last_y;
            }
            return getHeaderAndWidgetHeight(node);
        }

        function getFormatValue(node) {
            const w = node.widgets?.find((w) => w.name === "format");
            return w?.value || "video/h264-mp4";
        }

        const getExtraMenuOptions = nodeType.prototype.getExtraMenuOptions;
        nodeType.prototype.getExtraMenuOptions = function (_, options) {
            getExtraMenuOptions?.apply(this, arguments);
            const media = findMediaElement(this);
            const isVideo = media?.tagName === "VIDEO";
            const newOptions = [];

            newOptions.push({
                content: "Save preview",
                callback: () => {
                    const params = this.properties["painter_output_cache"];
                    if (params) {
                        const url = api.apiURL(`/view?filename=${params.filename}&subfolder=${params.subfolder}&type=${params.type}`);
                        const a = document.createElement("a");
                        a.href = url; a.download = params.filename;
                        document.body.appendChild(a); a.click(); document.body.removeChild(a);
                    }
                }
            });

            newOptions.push({
                content: (isVideo && media?.paused) ? "Resume preview" : "Pause preview",
                callback: () => {
                    if (isVideo && media) media.paused ? media.play() : media.pause();
                }
            });

            newOptions.push({
                content: "Sync preview",
                callback: () => syncPreviewAll(this)
            });

            if (options.length > 0) newOptions.push(null);
            options.unshift(...newOptions);
        };

        nodeType.prototype.onResize = function (size) {
            if (this.painter_aspect) {
                const top = getPreviewTop(this);
                const targetVideoHeight = (size[0] - SIDE_MARGIN * 2) / this.painter_aspect;
                const totalHeight = Math.ceil(top + targetVideoHeight + BOTTOM_MARGIN);

                if (Math.abs(size[1] - totalHeight) > 0.5) {
                    size[1] = totalHeight;
                }
            }

            const widget = getPreviewWidget(this);
            if (widget?.element) {
                widget.element.style.width = "100%";
                widget.element.style.left = "0px";
                const contentH = size[1] - getPreviewTop(this) - BOTTOM_MARGIN;
                widget.element.style.height = `${Math.max(0, contentH)}px`;
            }
        };

        nodeType.prototype.onExecuted = function (message) {
            if (message?.painter_output) {
                this.properties["painter_output_cache"] = message.painter_output[0];
                updateVideoPreview(this, message.painter_output[0]);
            }
        };

        nodeType.prototype.onConfigure = function () {
            if (this.properties?.["painter_output_cache"]) {
                updateVideoPreview(this, this.properties["painter_output_cache"]);
            }
        };

        function formatTime(seconds) {
            if (isNaN(seconds)) return "0:00";
            const m = Math.floor(seconds / 60);
            const s = Math.floor(seconds % 60);
            return `${m}:${s.toString().padStart(2, '0')}`;
        }

        function createCustomControls(video, container) {
            const controls = document.createElement("div");
            controls.className = "painter-video-controls";
            controls.style.cssText = `
                position: absolute;
                bottom: 0;
                left: 0;
                right: 0;
                padding: 8px 10px 6px 10px;
                background: linear-gradient(transparent, rgba(0,0,0,0.75));
                color: #fff;
                font-family: sans-serif;
                font-size: 12px;
                opacity: 0;
                transition: opacity 0.25s ease;
                display: flex;
                flex-direction: column;
                gap: 6px;
                pointer-events: none;
                z-index: 10;
                user-select: none;
            `;

            // Progress bar container
            const progressContainer = document.createElement("div");
            progressContainer.style.cssText = `
                width: 100%;
                height: 4px;
                background: rgba(255,255,255,0.3);
                border-radius: 2px;
                cursor: pointer;
                position: relative;
                pointer-events: auto;
                overflow: hidden;
            `;

            const progressBar = document.createElement("div");
            progressBar.style.cssText = `
                height: 100%;
                background: #FFD700;
                border-radius: 2px;
                width: 0%;
                transition: width 0.1s linear;
            `;

            const progressHover = document.createElement("div");
            progressHover.style.cssText = `
                position: absolute;
                top: 0;
                left: 0;
                height: 100%;
                background: rgba(255,215,0,0.3);
                width: 0%;
                pointer-events: none;
                display: none;
            `;

            progressContainer.appendChild(progressBar);
            progressContainer.appendChild(progressHover);

            // Bottom row: play button + time + duration
            const bottomRow = document.createElement("div");
            bottomRow.style.cssText = `
                display: flex;
                align-items: center;
                gap: 10px;
                pointer-events: auto;
            `;

            const playBtn = document.createElement("button");
            playBtn.innerHTML = "▶";
            playBtn.style.cssText = `
                background: transparent;
                border: none;
                color: #fff;
                cursor: pointer;
                font-size: 14px;
                width: 20px;
                height: 20px;
                display: flex;
                align-items: center;
                justify-content: center;
                padding: 0;
                line-height: 1;
            `;

            const timeDisplay = document.createElement("span");
            timeDisplay.style.cssText = `
                font-size: 11px;
                color: rgba(255,255,255,0.9);
                min-width: 70px;
                white-space: nowrap;
            `;
            timeDisplay.textContent = "0:00 / 0:00";

            bottomRow.appendChild(playBtn);
            bottomRow.appendChild(timeDisplay);

            controls.appendChild(progressContainer);
            controls.appendChild(bottomRow);
            container.appendChild(controls);

            // Hover logic for container
            container.addEventListener("mouseenter", () => {
                controls.style.opacity = "1";
            });
            container.addEventListener("mouseleave", () => {
                controls.style.opacity = "0";
            });

            // Play/Pause toggle
            playBtn.addEventListener("click", (e) => {
                e.stopPropagation();
                if (video.paused) {
                    video.play();
                } else {
                    video.pause();
                }
            });

            // Update play button icon
            video.addEventListener("play", () => {
                playBtn.innerHTML = "⏸";
            });
            video.addEventListener("pause", () => {
                playBtn.innerHTML = "▶";
            });

            // Progress update
            video.addEventListener("timeupdate", () => {
                if (video.duration) {
                    const pct = (video.currentTime / video.duration) * 100;
                    progressBar.style.width = pct + "%";
                    timeDisplay.textContent = `${formatTime(video.currentTime)} / ${formatTime(video.duration)}`;
                }
            });

            video.addEventListener("loadedmetadata", () => {
                timeDisplay.textContent = `${formatTime(video.currentTime)} / ${formatTime(video.duration)}`;
            });

            // Seek on click
            let isDragging = false;

            progressContainer.addEventListener("mousedown", (e) => {
                isDragging = true;
                seek(e);
            });

            document.addEventListener("mousemove", (e) => {
                if (isDragging) {
                    const rect = progressContainer.getBoundingClientRect();
                    const x = Math.max(0, Math.min(e.clientX - rect.left, rect.width));
                    const pct = x / rect.width;
                    progressHover.style.width = (pct * 100) + "%";
                    progressHover.style.display = "block";
                }
            });

            document.addEventListener("mouseup", () => {
                if (isDragging) {
                    isDragging = false;
                    progressHover.style.display = "none";
                }
            });

            function seek(e) {
                const rect = progressContainer.getBoundingClientRect();
                const x = Math.max(0, Math.min(e.clientX - rect.left, rect.width));
                const pct = x / rect.width;
                if (video.duration) {
                    video.currentTime = pct * video.duration;
                }
            }

            progressContainer.addEventListener("click", (e) => {
                e.stopPropagation();
                seek(e);
            });

            progressContainer.addEventListener("mousemove", (e) => {
                const rect = progressContainer.getBoundingClientRect();
                const x = Math.max(0, Math.min(e.clientX - rect.left, rect.width));
                const pct = x / rect.width;
                progressHover.style.width = (pct * 100) + "%";
                progressHover.style.display = "block";
            });

            progressContainer.addEventListener("mouseleave", () => {
                if (!isDragging) {
                    progressHover.style.display = "none";
                }
            });
        }

        function updateVideoPreview(node, data) {
            let widget = getPreviewWidget(node);

            if (!widget) {
                const element = document.createElement("div");
                element.style.display = "flex";
                element.style.justifyContent = "center";
                element.style.alignItems = "center";
                element.style.padding = "0px";
                element.style.margin = "0px";
                element.style.overflow = "hidden";
                element.style.boxSizing = "border-box";
                element.style.position = "relative";

                widget = node.addDOMWidget("painter_preview", "preview", element, {
                    serialize: false, hideOnZoom: false
                });
            }

            const url = api.apiURL(`/view?filename=${data.filename}&subfolder=${data.subfolder}&type=${data.type}`);
            const format = getFormatValue(node);
            const isAnimatedImage = typeof format === "string" && format.split("/")[0] === "image";
            widget.element.innerHTML = "";

            const triggerCtx = (e) => {
                e.preventDefault(); e.stopPropagation();
                if (app.canvas.processContextMenu) app.canvas.processContextMenu(node, e);
                else app.canvas._mousedown_callback(e);
                return false;
            };

            if (isAnimatedImage) {
                // Animated images (gif/webp) are not playable in <video>;
                // use <img> and let the browser animate natively.
                const img = document.createElement("img");
                img.src = url;
                img.style.width = "100%";
                img.style.height = "100%";
                img.style.objectFit = "cover";
                img.style.display = "block";

                img.addEventListener('contextmenu', triggerCtx, true);
                img.addEventListener('pointerdown', (e) => { if (e.button === 2) triggerCtx(e); }, true);

                img.onload = () => {
                    if (img.naturalWidth && img.naturalHeight) {
                        node.painter_aspect = img.naturalWidth / img.naturalHeight;
                        const applyResize = () => {
                            node.onResize(node.size);
                            node.setDirtyCanvas(true, true);
                        };
                        applyResize();
                        setTimeout(applyResize, 60);
                        setTimeout(applyResize, 250);
                    }
                };

                widget.element.appendChild(img);
                node.painter_media_element = img;
                node.painter_media_kind = "img";
            } else {
                // Video: keep the existing custom-controls behavior unchanged.
                const video = document.createElement("video");
                video.src = url;
                video.controls = false;
                video.loop = true;
                video.autoplay = true;
                video.muted = true;
                video.preload = "metadata";

                video.style.width = "100%";
                video.style.height = "100%";
                video.style.objectFit = "cover";
                video.style.display = "block";

                video.addEventListener('contextmenu', triggerCtx, true);
                video.addEventListener('pointerdown', (e) => { if (e.button === 2) triggerCtx(e); }, true);

                video.addEventListener('mouseenter', () => { video.muted = false; });
                video.addEventListener('mouseleave', () => { video.muted = true; });

                video.onloadedmetadata = () => {
                    if (video.videoWidth && video.videoHeight) {
                        node.painter_aspect = video.videoWidth / video.videoHeight;
                        const applyResize = () => {
                            node.onResize(node.size);
                            node.setDirtyCanvas(true, true);
                        };
                        applyResize();
                        setTimeout(applyResize, 60);
                        setTimeout(applyResize, 250);
                    }
                };

                widget.element.appendChild(video);

                // Create custom controls overlay
                createCustomControls(video, widget.element);

                node.painter_media_element = video;
                node.painter_media_kind = "video";
            }
        }
    }
});
