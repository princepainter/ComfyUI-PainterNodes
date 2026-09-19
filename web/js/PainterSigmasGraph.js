/*
 * PainterSigmasGraph - 前端界面
 * 改造自 Element_SigmaGraph_Curve (TWanSigmaGraph / Temult, MIT License)
 *
 * 与源节点的差异:
 *  - C（曲线模式）按钮 -> S（保存预设）按钮，点击弹出保存预设弹窗
 *  - 新增「预设」原生 combo 控件，样式与 steps / start_step 完全一致
 *  - 去掉 💾 按钮与 1~8 槽位标签
 *  - 曲线下方 sigmas 数值预览保持不变，并跟随「起始步数」截断
 */

import { app } from "/../scripts/app.js";
import { $el } from "/../scripts/ui.js";

const NODE_CLASS = "PainterSigmasGraph";
const GRAPH_DATA_NAME = "graph_data";
const STEPS_NAME = "steps";
const START_STEP_NAME = "start_step";
const PRESET_NAME = "preset";
const PRESET_LABEL = "预设";
const CANVAS_TYPE = "PAINTER_SIGMA_GRAPH_CANVAS";

const MIN_POINTS = 2;
/** 未选择预设时 combo 的取值（空字符串 = 框内只显示 label） */
const CUSTOM_VALUE = "";
const PRESETS_API = "/painter/sigmas_graph/presets";

const UNDO_LIMIT = 20;
// 最小尺寸与 Element_SigmaGraph 对齐（宽 240），高度再小一点（280 -> 250）
const MIN_NODE_WIDTH = 240;
const MIN_NODE_HEIGHT = 250;
const NON_WIDGET_HEIGHT = 150;
const MIN_WIDGET_HEIGHT = 170;
const GRAB_THRESHOLD = 0.08;
const POINT_RADIUS = 4;
const POINT_COLOR = "#1E88E5";
const CURVE_COLOR = "#fff";
const GUIDE_COLOR = "#444";
const BTN_TOP = "10px";


/* ------------------------------------------------------------------ *
 * 数学部分（与源节点保持一致）
 * ------------------------------------------------------------------ */

function linearInterpolate(x, points) {
    const sorted = points.slice().sort((a, b) => a.x - b.x);
    if (x <= sorted[0].x) return sorted[0].y;
    if (x >= sorted[sorted.length - 1].x) return sorted[sorted.length - 1].y;

    for (let i = 0; i < sorted.length - 1; i++) {
        const p0 = sorted[i];
        const p1 = sorted[i + 1];
        if (x >= p0.x && x <= p1.x) {
            const t = (x - p0.x) / (p1.x - p0.x);
            return p0.y + t * (p1.y - p0.y);
        }
    }
    return sorted[sorted.length - 1].y;
}

function formatValue(val) {
    if (Math.abs(val) < 1e-10) val = 0.0;
    if (Math.abs(val - 1.0) < 1e-10) val = 1.0;
    val = Math.max(0.0, Math.min(1.0, val));
    return Math.round(val * 10000000000) / 10000000000;
}

/**
 * 解析用户输入 / 粘贴的 sigmas 文本。
 * 支持逗号、空格、换行、分号、中括号等任意分隔，兼容科学计数法。
 * 解析不出 >= 1 个有限数时返回 null。
 */
function parseSigmasText(text) {
    if (typeof text !== "string") return null;
    const cleaned = text.replace(/[[\](){}<>]/g, " ");
    const nums = cleaned
        .split(/[^0-9eE.+-]+/)
        .map((s) => s.trim())
        .filter((s) => s && s !== "+" && s !== "-" && s !== "." && s !== "+." && s !== "-.")
        .map((s) => Number(s))
        .filter((n) => Number.isFinite(n));
    return nums.length ? nums : null;
}

/**
 * 与后端 calculate_sigmas 保持一致的严格递减修正：
 * 降序排序后，把相邻相等 / 逆序的值抬高 1e-5。
 * 这样预览显示的就是后端真正会输出的序列（所见即所得）。
 */
function enforceStrictlyDecreasing(values) {
    const arr = values.slice().sort((a, b) => b - a);
    for (let i = arr.length - 2; i >= 0; i--) {
        if (arr[i] <= arr[i + 1]) arr[i] = arr[i + 1] + 1e-5;
    }
    return arr;
}

/** 数值 -> 预览文本（最多 8 位小数，去掉尾随零） */
function formatSigmaText(values) {
    return values.map((v) => String(Number(v.toFixed(8)))).join(", ");
}

function calcLinearSigmas(points, steps) {
    steps = Math.max(1, steps | 0);
    const p = (points || []).slice().sort((a, b) => a.x - b.x);
    if (p.length < 2) return Array(steps + 1).fill(1.0);

    if (!p.some((pt) => Math.abs(pt.x) < 1e-6))
        p.unshift({ x: 0, y: Math.max(0.0, Math.min(1.0, p[0].y)) });
    if (!p.some((pt) => Math.abs(pt.x - 1) < 1e-6))
        p.push({ x: 1, y: Math.max(0.0, Math.min(1.0, p[p.length - 1].y)) });

    const out = [];
    for (let i = 0; i <= steps; i++) out.push(formatValue(linearInterpolate(i / steps, p)));
    return out;
}

function computeSplineCoefficients(points) {
    const n = points.length - 1;
    if (n < 1) return [];

    const x = points.map(p => p.x);
    const y = points.map(p => p.y);
    const h = [];
    for (let i = 0; i < n; i++) h.push(x[i + 1] - x[i]);

    const A = Array(n + 1).fill().map(() => Array(n + 1).fill(0));
    const b = Array(n + 1).fill(0);

    A[0][0] = 1;
    A[n][n] = 1;

    for (let i = 1; i < n; i++) {
        A[i][i - 1] = h[i - 1];
        A[i][i] = 2 * (h[i - 1] + h[i]);
        A[i][i + 1] = h[i];
        b[i] = 3 * ((y[i + 1] - y[i]) / h[i] - (y[i] - y[i - 1]) / h[i - 1]);
    }

    const cPrime = Array(n + 1).fill(0);
    const dPrime = Array(n + 1).fill(0);
    const M = Array(n + 1).fill(0);

    cPrime[0] = A[0][1] / A[0][0];
    dPrime[0] = b[0] / A[0][0];

    for (let i = 1; i <= n; i++) {
        const denom = A[i][i] - A[i][i - 1] * cPrime[i - 1];
        if (i < n) cPrime[i] = A[i][i + 1] / denom;
        dPrime[i] = (b[i] - A[i][i - 1] * dPrime[i - 1]) / denom;
    }

    M[n] = dPrime[n];
    for (let i = n - 1; i >= 0; i--) M[i] = dPrime[i] - cPrime[i] * M[i + 1];

    const coeffs = [];
    for (let i = 0; i < n; i++) {
        const a = y[i];
        const b_coef = (y[i + 1] - y[i]) / h[i] - h[i] * (2 * M[i] + M[i + 1]) / 3;
        const c = M[i];
        const d = (M[i + 1] - M[i]) / (3 * h[i]);
        coeffs.push({ a, b: b_coef, c, d, x0: x[i], x1: x[i + 1] });
    }
    return coeffs;
}

function evaluateSpline(x, coeffs) {
    for (let coeff of coeffs) {
        if (x >= coeff.x0 && x <= coeff.x1) {
            const dx = x - coeff.x0;
            const val = coeff.a + coeff.b * dx + coeff.c * dx * dx + coeff.d * dx * dx * dx;
            return Math.max(0.0, Math.min(1.0, val));
        }
    }
    if (coeffs.length === 0) return 0;
    if (x < coeffs[0].x0) return Math.max(0.0, Math.min(1.0, coeffs[0].a));

    const last = coeffs[coeffs.length - 1];
    const lastVal = last.a + last.b * (last.x1 - last.x0) +
                    last.c * (last.x1 - last.x0) ** 2 + last.d * (last.x1 - last.x0) ** 3;
    return Math.max(0.0, Math.min(1.0, lastVal));
}

function calcSmoothSigmas(points, steps) {
    steps = Math.max(1, steps | 0);
    const p = (points || []).slice().sort((a, b) => a.x - b.x);
    if (p.length < 2) return Array(steps + 1).fill(1.0);

    if (!p.some((pt) => Math.abs(pt.x) < 1e-6))
        p.unshift({ x: 0, y: Math.max(0.0, Math.min(1.0, p[0].y)) });
    if (!p.some((pt) => Math.abs(pt.x - 1) < 1e-6))
        p.push({ x: 1, y: Math.max(0.0, Math.min(1.0, p[p.length - 1].y)) });

    const coeffs = computeSplineCoefficients(p);
    const out = [];
    for (let i = 0; i <= steps; i++) out.push(formatValue(evaluateSpline(i / steps, coeffs)));
    return out;
}

function strToPts(str) {
    try {
        const parsed = JSON.parse(str);
        let arr = parsed;
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed) && parsed.points) {
            arr = parsed.points;
        }
        if (Array.isArray(arr) &&
            arr.every((o) => typeof o.x === "number" && typeof o.y === "number")) {
            return arr.map(p => ({ x: p.x, y: Math.max(0.0, Math.min(1.0, p.y)) }));
        }
    } catch { /* ignore */ }

    const nums = str.split(/[^0-9.+-]+/).map(parseFloat).filter((n) => !isNaN(n));
    if (nums.length < 2) {
        const y = nums[0] || 1;
        return [
            { x: 0, y: Math.max(0.0, Math.min(1.0, y)) },
            { x: 1, y: Math.max(0.0, Math.min(1.0, nums[0] != null ? y : 0)) }
        ];
    }
    return nums.map((y, i) => ({ x: i / (nums.length - 1), y: formatValue(y) }));
}


/* ------------------------------------------------------------------ *
 * 预设存取
 * ------------------------------------------------------------------ */

let _presetsCache = null;
let _presetsPromise = null;

async function fetchPresets(force = false) {
    if (_presetsCache && !force) return _presetsCache;
    if (_presetsPromise && !force) return _presetsPromise;

    _presetsPromise = (async () => {
        try {
            const res = await fetch(PRESETS_API);
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            const data = await res.json();
            _presetsCache = Array.isArray(data?.presets) ? data.presets : [];
        } catch (e) {
            console.error("[PainterSigmasGraph] 读取预设失败", e);
            _presetsCache = _presetsCache || [];
        } finally {
            _presetsPromise = null;
        }
        return _presetsCache;
    })();

    return _presetsPromise;
}

async function postPreset(body) {
    const res = await fetch(PRESETS_API, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body)
    });
    const data = await res.json();
    if (!res.ok || data?.status !== "success") {
        throw new Error(data?.message || `HTTP ${res.status}`);
    }
    _presetsCache = Array.isArray(data.presets) ? data.presets : [];
    return _presetsCache;
}


/* ------------------------------------------------------------------ *
 * 保存预设弹窗
 * ------------------------------------------------------------------ */

function showSaveDialog(defaultName, existsNames) {
    return new Promise((resolve) => {
        const overlay = $el("div", {
            style: {
                position: "fixed", left: "0", top: "0", right: "0", bottom: "0",
                background: "rgba(0,0,0,0.55)", zIndex: "100000",
                display: "flex", alignItems: "center", justifyContent: "center"
            }
        });

        const panel = $el("div", {
            style: {
                background: "#252525", border: "1px solid #555", borderRadius: "8px",
                padding: "14px 16px", minWidth: "280px",
                boxShadow: "0 10px 30px rgba(0,0,0,0.6)",
                fontFamily: "sans-serif", color: "#e6e6e6"
            }
        });

        panel.appendChild($el("div", {
            textContent: "保存为预设",
            style: { fontSize: "14px", fontWeight: "bold", marginBottom: "10px" }
        }));

        const input = $el("input", {
            type: "text",
            value: defaultName || "",
            placeholder: "输入预设名称…",
            style: {
                width: "100%", height: "30px", boxSizing: "border-box",
                background: "#1a1a1a", color: "#eee", fontSize: "13px",
                border: "1px solid #555", borderRadius: "4px", padding: "0 8px",
                outline: "none"
            }
        });
        panel.appendChild(input);

        const hint = $el("div", {
            textContent: " ",
            style: {
                fontSize: "11px", color: "#ffb74d", height: "16px",
                lineHeight: "16px", marginTop: "4px"
            }
        });
        panel.appendChild(hint);

        const btnRow = $el("div", {
            style: { display: "flex", gap: "8px", justifyContent: "flex-end", marginTop: "8px" }
        });

        const cancelBtn = $el("button", {
            textContent: "取消",
            style: {
                minWidth: "64px", height: "28px", cursor: "pointer",
                background: "#3a3a3a", color: "#ddd", fontSize: "13px",
                border: "1px solid #555", borderRadius: "4px"
            }
        });

        const okBtn = $el("button", {
            textContent: "保存",
            style: {
                minWidth: "64px", height: "28px", cursor: "pointer",
                background: "#1E88E5", color: "#fff", fontSize: "13px",
                border: "1px solid #1E88E5", borderRadius: "4px", fontWeight: "bold"
            }
        });

        btnRow.appendChild(cancelBtn);
        btnRow.appendChild(okBtn);
        panel.appendChild(btnRow);
        overlay.appendChild(panel);

        function close(value) {
            document.removeEventListener("keydown", onKey, true);
            overlay.remove();
            resolve(value);
        }

        function commit() {
            const name = (input.value || "").trim();
            if (!name) {
                hint.textContent = "预设名称不能为空";
                input.focus();
                return;
            }
            close(name);
        }

        function onKey(e) {
            if (e.key === "Escape") { e.stopPropagation(); close(null); }
            else if (e.key === "Enter") { e.stopPropagation(); commit(); }
        }

        okBtn.onclick = commit;
        cancelBtn.onclick = () => close(null);
        overlay.addEventListener("mousedown", (e) => { if (e.target === overlay) close(null); });
        document.addEventListener("keydown", onKey, true);

        input.addEventListener("input", () => {
            const v = (input.value || "").trim();
            hint.textContent = (v && existsNames?.includes(v)) ? "已存在同名预设，保存将覆盖" : " ";
        });

        document.body.appendChild(overlay);
        setTimeout(() => { input.focus(); input.select(); }, 0);
    });
}


/* ------------------------------------------------------------------ *
 * 节点初始化
 * ------------------------------------------------------------------ */

function setup(node) {
    if (node._painterSigmaSetupDone) return;
    node._painterSigmaSetupDone = true;

    if (node.properties === undefined) node.properties = {};

    const savedSize = node.properties?._ui_size;
    if (savedSize && Array.isArray(savedSize) && savedSize.length === 2) {
        node.size = [
            Math.max(MIN_NODE_WIDTH, Number(savedSize[0]) || MIN_NODE_WIDTH),
            Math.max(MIN_NODE_HEIGHT, Number(savedSize[1]) || MIN_NODE_HEIGHT)
        ];
    } else if (!node.size || node.size[0] < MIN_NODE_WIDTH || node.size[1] < MIN_NODE_HEIGHT) {
        node.size = [MIN_NODE_WIDTH, MIN_NODE_HEIGHT];
    }

    node.minSize = [MIN_NODE_WIDTH, MIN_NODE_HEIGHT];

    // 隐藏 graph_data 文本框（只作为曲线数据载体），并去掉可能生成的输入口
    const hideWidgetAndSlot = (widgetName) => {
        const w = node.widgets?.find(x => x.name === widgetName);
        if (w) {
            w.type = "hidden";
            w.hidden = true;
            w.computeSize = () => [0, 0];
            w.draw = () => {};
            if (w.inputEl) {
                w.inputEl.style.display = "none";
                if (w.inputEl.parentElement) w.inputEl.parentElement.style.display = "none";
            }
        }
        if (node.inputs) {
            const idx = node.inputs.findIndex(i => i.name === widgetName);
            if (idx !== -1) node.removeInput(idx);
        }
    };
    hideWidgetAndSlot(GRAPH_DATA_NAME);

    const gw = node.widgets?.find((w) => w.name === GRAPH_DATA_NAME);
    if (!gw) return;
    const ta = gw.element;
    if (ta) {
        ta.style.minHeight = "0px";
        ta.style.height = "0px";
        ta.style.padding = "0px";
        ta.style.border = "none";
        ta.style.overflow = "hidden";
        ta.style.position = "absolute";
        ta.style.visibility = "hidden";
    }

    const stepsWidget = node.widgets.find((w) => w.name === STEPS_NAME);
    const startStepWidget = node.widgets.find((w) => w.name === START_STEP_NAME);

    let initialPts = null;
    if (gw.value && gw.value.trim() !== "") {
        try { initialPts = strToPts(gw.value); } catch { initialPts = null; }
    }
    if (!initialPts || initialPts.length === 0) {
        initialPts = [{ x: 0, y: 1 }, { x: 1, y: 0 }];
        const defaultJson = JSON.stringify({ points: initialPts, mode: "curve" });
        ta.value = defaultJson;
        gw.value = defaultJson;
    } else {
        ta.value = JSON.stringify(initialPts);
    }

    /* ---------------- 曲线 + 数值预览（DOM 区域） ---------------- */

    const wrap = $el("div", {
        style: {
            width: "100%", height: "100%", position: "relative",
            display: "flex", flexDirection: "column", overflow: "hidden",
            boxSizing: "border-box"
        }
    });

    const canvas = $el("canvas", {
        style: {
            width: "100%", flex: "1 1 0", minHeight: "0px",
            background: "#282828", border: "1px solid #555",
            borderRadius: "4px", cursor: "crosshair"
        }
    });
    wrap.appendChild(canvas);

    const preview = $el("textarea", {
        placeholder: "Sigmas…（可直接编辑 / 粘贴）",
        spellcheck: false,
        title: "可直接编辑：输入或粘贴一串 sigmas 数值（逗号 / 空格 / 换行分隔均可），"
             + "按 Enter 或点开别处即可应用，曲线会按这些数值重新绘制；\n"
             + "反过来拖动曲线，这里也会同步更新。\n"
             + "粘贴 n 个数值时「步数」会自动变成 n-1；「起始步数」仍会截掉前面的若干项。",
        style: {
            width: "100%", height: "55px", fontFamily: "monospace",
            background: "#181818", color: "#ccc",
            border: "1px solid #555", borderRadius: "4px",
            boxSizing: "border-box", padding: "4px", resize: "none",
            marginTop: "4px", flexShrink: "0"
        }
    });
    wrap.appendChild(preview);

    /** 数值框正在编辑时不让 draw() 覆盖用户输入 */
    let previewEditing = false;
    let previewDebounce = null;
    /** 上一次由 draw() 写入的文本，用于判断用户是否改过内容 */
    let lastDrawnText = "";

    const domWidget = node.addDOMWidget(CANVAS_TYPE, "custom", wrap, {
        serialize: true,
        hideOnZoom: false
    });

    // 新版前端：DOM widget 由外层 .dom-widget 容器撑满「节点剩余高度」，
    // 千万不要给 domWidget.computeSize 返回固定高度，否则容器被钉死，
    // 拖动节点放大后底部会留一大块空白。这里只让 wrap 填满容器即可。
    const isNewFrontend =
        !!document.querySelector("#vue-app") ||
        !!document.querySelector("comfy-app") ||
        !!document.querySelector(".comfy-vue") ||
        !!(window.comfyAPI && window.comfyAPI.vue) ||
        !!wrap.parentElement?.classList?.contains("dom-widget");

    const origComputeSize = node.computeSize;
    node.computeSize = function (out) {
        let size = origComputeSize
            ? origComputeSize.apply(this, arguments)
            : [MIN_NODE_WIDTH, MIN_NODE_HEIGHT];
        size[0] = Math.max(MIN_NODE_WIDTH, size[0]);
        size[1] = Math.max(MIN_NODE_HEIGHT, size[1]);
        return size;
    };

    const origOnResize = node.onResize;
    node.onResize = function (size) {
        if (origOnResize) origOnResize.apply(this, arguments);

        const w = Math.max(MIN_NODE_WIDTH, Number(size?.[0] ?? this.size?.[0]) || MIN_NODE_WIDTH);
        const h = Math.max(MIN_NODE_HEIGHT, Number(size?.[1] ?? this.size?.[1]) || MIN_NODE_HEIGHT);

        this.size[0] = w;
        this.size[1] = h;
        if (size) { size[0] = w; size[1] = h; }

        if (isNewFrontend) {
            wrap.style.height = "100%";
        } else if (wrap) {
            wrap.style.height = Math.max(MIN_WIDGET_HEIGHT, h - NON_WIDGET_HEIGHT) + "px";
        }
        this.properties = this.properties || {};
        this.properties._ui_size = [w, h];

        if (node._sigmaDraw) node._sigmaDraw();
        if (app.graph) app.graph.setDirtyCanvas(true, true);
    };

    /* ---------------- 曲线上的按钮：S 保存 / R 重置 ---------------- */

    // 三个圆钮压在曲线右上角，常态半透明让曲线透出来，鼠标移上去再变实
    const BTN_BASE_OPACITY = "0.66";
    const hoverable = (btn, base) => {
        btn.addEventListener("mouseenter", () => { btn.style.opacity = "1"; });
        btn.addEventListener("mouseleave", () => {
            btn.style.opacity = typeof base === "function" ? base() : base;
        });
    };

    const btnStyle = (extra) => Object.assign({
        position: "absolute", top: BTN_TOP,
        width: "22px", height: "22px", borderRadius: "50%",
        border: "1px solid #555", color: "#fff",
        cursor: "pointer", zIndex: "10", fontWeight: "bold", fontSize: "12px",
        padding: "0", lineHeight: "1",
        opacity: BTN_BASE_OPACITY, transition: "opacity .15s"
    }, extra);

    const saveBtn = $el("button", {
        textContent: "S",
        title: "保存当前设置为预设（右键可删除当前预设）",
        style: btnStyle({ right: "30px", background: "#1E88E5" })
    });
    wrap.appendChild(saveBtn);

    const delBtn = $el("button", {
        textContent: "D",
        title: "删除当前选中的预设（先在「预设」下拉框里选一个）",
        style: btnStyle({ right: "56px", background: "#C62828", opacity: "0.4" })
    });
    wrap.appendChild(delBtn);

    const resetBtn = $el("button", {
        textContent: "R",
        title: "重置曲线为默认状态",
        style: btnStyle({ right: "4px", background: "#505050" })
    });
    wrap.appendChild(resetBtn);

    hoverable(saveBtn, BTN_BASE_OPACITY);
    hoverable(resetBtn, BTN_BASE_OPACITY);

    /* ---------------- 预设下拉（原生 combo，样式与上面两个框一致） ---------------- */

    let presetNames = [];
    let selectedPreset = (node.properties && node.properties._preset) || CUSTOM_VALUE;
    let suppressPresetReset = false;

    const presetWidget = node.addWidget(
        "combo",
        PRESET_NAME,
        CUSTOM_VALUE,
        (value) => onPresetChange(value),
        { values: [CUSTOM_VALUE] }
    );
    presetWidget.label = PRESET_LABEL;

    // combo 默认会被追加到列表末尾（DOM widget 之后），挪到 DOM widget 之前
    if (domWidget) {
        const domIdx = node.widgets.indexOf(domWidget);
        const myIdx = node.widgets.indexOf(presetWidget);
        if (domIdx !== -1 && myIdx !== -1 && myIdx > domIdx) {
            node.widgets.splice(myIdx, 1);
            node.widgets.splice(domIdx, 0, presetWidget);
        }
    }

    /** 没选中预设时把 D 按钮置灰，避免误点（按内部状态判断，比读 combo 的 value 可靠） */
    let delBtnActive = false;
    function updateDelBtnState() {
        const cur = presetWidget.value || selectedPreset;
        delBtnActive = !!cur && cur !== CUSTOM_VALUE && presetNames.includes(cur);
        delBtn.style.opacity = delBtnActive ? BTN_BASE_OPACITY : "0.4";
        delBtn.style.cursor = delBtnActive ? "pointer" : "not-allowed";
    }
    hoverable(delBtn, () => (delBtnActive ? BTN_BASE_OPACITY : "0.4"));

    function rebuildPresetOptions() {
        presetNames = (_presetsCache || []).map((p) => p.name);
        presetWidget.options = presetWidget.options || {};
        presetWidget.options.values = [CUSTOM_VALUE, ...presetNames];

        const valid = selectedPreset !== CUSTOM_VALUE && presetNames.includes(selectedPreset);
        presetWidget.value = valid ? selectedPreset : CUSTOM_VALUE;
        node.properties._preset = presetWidget.value;

        updateDelBtnState();
        node.setDirtyCanvas(true, true);
        if (app.graph) app.graph.setDirtyCanvas(true, true);
    }

    function selectPreset(name) {
        selectedPreset = name || CUSTOM_VALUE;
        node.properties._preset = selectedPreset;
        presetWidget.value = presetNames.includes(selectedPreset) ? selectedPreset : CUSTOM_VALUE;
        updateDelBtnState();
        node.setDirtyCanvas(true, true);
        if (app.graph) app.graph.setDirtyCanvas(true, true);
    }

    function markCustom() {
        if (suppressPresetReset) return;
        if (presetWidget.value !== CUSTOM_VALUE) selectPreset(CUSTOM_VALUE);
    }

    function onPresetChange(value) {
        selectedPreset = value || CUSTOM_VALUE;
        node.properties._preset = selectedPreset;
        updateDelBtnState();

        if (selectedPreset === CUSTOM_VALUE) {
            node.setDirtyCanvas(true, true);
            return;
        }
        const preset = (_presetsCache || []).find((p) => p.name === selectedPreset);
        if (preset) applyPreset(preset);
    }

    /* ---------------- 曲线数据 ---------------- */

    let undoStack = [];
    function pushUndo(state) {
        undoStack.unshift(state);
        if (undoStack.length > UNDO_LIMIT) undoStack.pop();
    }

    function applyPoints(pts, opts) {
        opts = opts || {};
        if (!opts.noUndo) pushUndo(gw.value);

        // exactX: sigmas 反推而来的点必须保留 x 的全精度，
        // 否则 x = i/(n-1) 被舍入后，采样点与控制点会差出 1e-5 量级。
        const clean = pts.map((p) => ({
            x: opts.exactX
                ? Math.max(0, Math.min(1, p.x))
                : Math.round(p.x * 100000) / 100000,
            y: formatValue(p.y)
        }));

        const jsonStr = JSON.stringify({ points: clean, mode: "curve" });
        gw.value = jsonStr;
        ta.value = jsonStr;
        draw(clean);
        markCustom();
    }

    node._applyPoints = applyPoints;

    /* ---------------- sigmas 数值 -> 曲线（反向同步） ---------------- */

    /**
     * 把一串 sigmas 数值转成等距控制点并写入 graph_data。
     * 因为 steps 同步设为 n-1，后端采样点 i/(n-1) 会精确落在每个控制点上，
     * 所以「粘贴进去什么，后端就输出什么」（差异仅为 clamp 与递减修正）。
     */
    function applySigmas(values, noUndo) {
        if (!Array.isArray(values) || values.length < MIN_POINTS) return false;
        const n = values.length;

        const pts = values.map((v, i) => ({
            x: i / (n - 1),
            y: Math.max(0, Math.min(1, v))
        }));

        const newSteps = Math.max(1, Math.min(1000, n - 1));
        if (stepsWidget) stepsWidget.value = newSteps;

        // 步数变小后，起始步数若越界就收进合法范围，免得看到空序列
        if (startStepWidget && (startStepWidget.value | 0) > newSteps - 1) {
            startStepWidget.value = Math.max(0, newSteps - 1);
        }

        applyPoints(pts, { exactX: true, noUndo: !!noUndo });
        node.setDirtyCanvas(true, true);
        if (app.graph) app.graph.setDirtyCanvas(true, true);
        return true;
    }

    /** 从底部数值框读取并应用；解析失败返回 false（调用方可据此恢复显示） */
    function applySigmasFromPreview(noUndo) {
        const nums = parseSigmasText(preview.value);
        if (!nums || nums.length < MIN_POINTS) return false;
        return applySigmas(nums, noUndo);
    }

    /* ---------------- 绘制 + 数值预览 ---------------- */

    const ctx = canvas.getContext("2d");

    function currentSteps() {
        return Math.max(1, (stepsWidget?.value | 0) || 1);
    }

    function currentStartStep() {
        const steps = currentSteps();
        const raw = startStepWidget ? (startStepWidget.value | 0) : 0;
        return Math.max(0, Math.min(steps - 1, raw));
    }

    function draw(overridePts) {
        const pts = overridePts || strToPts(gw.value);
        const dpr = window.devicePixelRatio || 1;
        const w = canvas.clientWidth, h = canvas.clientHeight;
        canvas.width = w * dpr;
        canvas.height = h * dpr;
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        ctx.clearRect(0, 0, w, h);

        ctx.strokeStyle = GUIDE_COLOR;
        ctx.lineWidth = 0.5;
        ctx.beginPath();
        for (let i = 1; i < 10; i++) {
            const x = (i * w) / 10, y = (i * h) / 10;
            ctx.moveTo(x, 0); ctx.lineTo(x, h);
            ctx.moveTo(0, y); ctx.lineTo(w, y);
        }
        ctx.stroke();

        if (pts.length >= 2) {
            ctx.strokeStyle = CURVE_COLOR;
            ctx.lineWidth = 1.5;
            ctx.lineCap = "round";
            ctx.lineJoin = "round";
            ctx.beginPath();

            const coeffs = computeSplineCoefficients(pts);
            const drawSteps = Math.max(w * 2, 200);
            for (let i = 0; i <= drawSteps; i++) {
                const t = i / drawSteps;
                const y = evaluateSpline(t, coeffs);
                const px = t * w;
                const py = (1 - Math.max(0.0, Math.min(1.0, y))) * h;
                if (i === 0) ctx.moveTo(px, py);
                else ctx.lineTo(px, py);
            }
            ctx.stroke();

            pts.forEach((p) => {
                const px = p.x * w;
                const py = (1 - Math.max(0.0, Math.min(1.0, p.y))) * h;
                ctx.fillStyle = POINT_COLOR;
                ctx.beginPath();
                ctx.arc(px, py, POINT_RADIUS, 0, 2 * Math.PI);
                ctx.fill();
            });
        }

        const steps = currentSteps();
        const startStep = currentStartStep();
        let sigmaValues = calcSmoothSigmas(pts, steps);
        sigmaValues = enforceStrictlyDecreasing(sigmaValues);
        if (startStep > 0) sigmaValues = sigmaValues.slice(startStep);

        if (!previewEditing) {
            preview.value = formatSigmaText(sigmaValues);
            lastDrawnText = preview.value;
        }
    }

    node._sigmaDraw = draw;

    /* ---------------- 预设载入 / 保存 ---------------- */

    async function loadPresetsAndRefresh() {
        await fetchPresets();
        rebuildPresetOptions();
    }

    function applyPreset(preset) {
        if (!preset || typeof preset !== "object") return;

        suppressPresetReset = true;
        try {
            const pts = strToPts(preset.points);
            if (pts && pts.length >= MIN_POINTS) applyPoints(pts);

            if (stepsWidget && typeof preset.steps === "number") {
                stepsWidget.value = Math.max(1, Math.min(1000, preset.steps | 0));
            }
            if (startStepWidget && typeof preset.start_step === "number") {
                startStepWidget.value = Math.max(0, preset.start_step | 0);
            }
        } finally {
            suppressPresetReset = false;
        }

        draw();
        node.setDirtyCanvas(true, true);
        if (app.graph) app.graph.setDirtyCanvas(true, true);
    }

    saveBtn.onclick = async () => {
        const defaultName = presetWidget.value === CUSTOM_VALUE ? "" : presetWidget.value;
        const name = await showSaveDialog(defaultName, presetNames);
        if (!name) return;

        const preset = {
            points: gw.value,
            curveMode: true,
            steps: currentSteps(),
            start_step: currentStartStep()
        };

        try {
            await postPreset({ action: "save", name, preset });
        } catch (e) {
            console.error("[PainterSigmasGraph] 保存预设失败", e);
            alert(`保存预设失败：${e.message || e}`);
            return;
        }

        rebuildPresetOptions();
        selectPreset(name);
    };

    /** 删除指定预设；成功返回 true */
    async function deletePresetByName(name) {
        if (!name || name === CUSTOM_VALUE) {
            alert("请先在「预设」下拉框中选择要删除的预设");
            return false;
        }
        if (!window.confirm(`删除预设「${name}」？此操作不可撤销。`)) return false;

        try {
            await postPreset({ action: "delete", name });
        } catch (err) {
            console.error("[PainterSigmasGraph] 删除预设失败", err);
            alert(`删除预设失败：${err.message || err}`);
            return false;
        }
        rebuildPresetOptions();
        selectPreset(CUSTOM_VALUE);
        return true;
    }

    delBtn.onclick = () => { deletePresetByName(presetWidget.value); };

    // 右键 S 按钮：快捷删除当前预设（保留原有习惯）
    saveBtn.oncontextmenu = (e) => {
        e.preventDefault();
        deletePresetByName(presetWidget.value);
    };

    /* ---------------- 交互 ---------------- */

    let debounce;
    ta.addEventListener("input", () => {
        clearTimeout(debounce);
        debounce = setTimeout(() => {
            if (ta.value.trim()) draw(strToPts(ta.value));
        }, 200);
    });
    ta.addEventListener("blur", () => {
        if (ta.value.trim()) applyPoints(strToPts(ta.value));
    });
    ta.addEventListener("keydown", (e) => {
        if ((e.ctrlKey || e.metaKey) && e.key === "z" && undoStack.length) {
            e.preventDefault();
            const prev = undoStack.shift();
            gw.value = prev;
            ta.value = prev;
            draw(strToPts(prev));
        }
    });

    /* ---------------- 底部数值框：手动编辑 / 粘贴 ---------------- */

    preview.addEventListener("focus", () => {
        previewEditing = true;
    });

    preview.addEventListener("input", () => {
        previewEditing = true;
        clearTimeout(previewDebounce);
        previewDebounce = setTimeout(() => { applySigmasFromPreview(true); }, 300);
    });

    preview.addEventListener("blur", () => {
        previewEditing = false;
        clearTimeout(previewDebounce);
        // 内容没被改过（只是点了下框）就直接跳过，避免白记一次撤销
        if (preview.value === lastDrawnText) return;
        // 解析失败（或不足两个值）时恢复为曲线当前的数值显示
        if (!applySigmasFromPreview(false)) draw();
    });

    preview.addEventListener("keydown", (e) => {
        if (e.key === "Enter" && !e.shiftKey) {
            e.preventDefault();
            preview.blur();
            return;
        }
        // 内容没被改过时，Ctrl+Z 用来撤销曲线操作；改过则交给浏览器原生撤销
        if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "z"
            && preview.value === lastDrawnText && undoStack.length) {
            e.preventDefault();
            const prev = undoStack.shift();
            const pts = strToPts(prev);
            if (pts && pts.length >= MIN_POINTS) {
                previewEditing = false;
                applyPoints(pts, { noUndo: true });
            }
        }
    });

    resetBtn.onclick = () => {
        applyPoints([{ x: 0, y: 1 }, { x: 1, y: 0 }]);
    };

    let dragIdx = -1;

    canvas.onpointerdown = (e) => {
        // 数值框还在编辑中：这一下点击只用来提交编辑，绝不能顺手在曲线上插个点
        // ——否则刚粘贴的 sigmas 会因为多出一个控制点被 spline 重采样，数值漂移。
        if (document.activeElement === preview) {
            preview.blur();
            e.preventDefault();
            return;
        }

        const rect = canvas.getBoundingClientRect();
        const x = (e.clientX - rect.left) / rect.width;
        const y = 1 - (e.clientY - rect.top) / rect.height;
        let pts = strToPts(gw.value);

        if (e.button === 2) {
            const idx = pts.findIndex(p => Math.hypot(p.x - x, p.y - y) < GRAB_THRESHOLD);
            if (idx > 0 && idx < pts.length - 1 && pts.length > MIN_POINTS) {
                pushUndo(gw.value);
                pts.splice(idx, 1);
                applyPoints(pts);
            }
            e.preventDefault();
            return;
        }

        if (e.button === 0) {
            const existingIdx = pts.findIndex(p => Math.hypot(p.x - x, p.y - y) < GRAB_THRESHOLD);

            if (existingIdx >= 0) {
                dragIdx = existingIdx;
            } else {
                pushUndo(gw.value);

                let insertIdx = pts.findIndex(p => p.x > x);
                if (insertIdx === -1) insertIdx = pts.length;

                const leftPt = pts[insertIdx - 1] || pts[0];
                const rightPt = pts[insertIdx] || pts[pts.length - 1];
                if (Math.abs(rightPt.x - leftPt.x) < 0.01) return;

                const coeffs = computeSplineCoefficients(pts);
                const newY = evaluateSpline(x, coeffs);
                const newX = Math.max(leftPt.x + 0.005, Math.min(rightPt.x - 0.005, x));

                pts.splice(insertIdx, 0, {
                    x: newX,
                    y: formatValue(Math.min(1, Math.max(0, newY)))
                });
                applyPoints(pts);
                dragIdx = insertIdx;
            }

            if (dragIdx >= 0) e.target.setPointerCapture(e.pointerId);
            e.preventDefault();
        }
    };

    canvas.onpointermove = (e) => {
        const rect = canvas.getBoundingClientRect();
        const x = (e.clientX - rect.left) / rect.width;
        const y = 1 - (e.clientY - rect.top) / rect.height;
        const pts = strToPts(gw.value);

        if (dragIdx >= 0) {
            const ny = Math.min(1, Math.max(0, y));
            if (dragIdx === 0) {
                pts[dragIdx] = { x: 0, y: ny };
            } else if (dragIdx === pts.length - 1) {
                pts[dragIdx] = { x: 1, y: ny };
            } else {
                const minX = pts[dragIdx - 1].x + 0.005;
                const maxX = pts[dragIdx + 1].x - 0.005;
                pts[dragIdx] = { x: Math.min(maxX, Math.max(minX, x)), y: ny };
            }
            applyPoints(pts);
        }

        const over = pts.some(p => Math.hypot(p.x - x, p.y - y) < GRAB_THRESHOLD);
        canvas.style.cursor = dragIdx >= 0 || over ? "pointer" : "crosshair";
    };

    canvas.onpointerup = (e) => {
        if (dragIdx >= 0) {
            e.target.releasePointerCapture(e.pointerId);
            dragIdx = -1;
        }
    };

    canvas.oncontextmenu = (e) => e.preventDefault();

    if (stepsWidget) stepsWidget.callback = () => { draw(); markCustom(); };
    if (startStepWidget) startStepWidget.callback = () => { draw(); markCustom(); };

    /* ---------------- 工作流加载时从 widget 重新同步 ---------------- */

    function syncFromWidgets() {
        if (presetWidget.value && presetWidget.value !== CUSTOM_VALUE) {
            selectedPreset = presetWidget.value;
            node.properties._preset = selectedPreset;
        }
        if (!gw.value || !String(gw.value).trim()) return;
        const pts = strToPts(gw.value);
        if (!pts || pts.length < MIN_POINTS) return;

        ta.value = gw.value;
        suppressPresetReset = true;
        try { applyPoints(pts); } finally { suppressPresetReset = false; }
        rebuildPresetOptions();
    }

    /* ---------------- 序列化 ---------------- */

    const origSerialize = node.onSerialize;
    node.onSerialize = function (o) {
        if (origSerialize) origSerialize.apply(this, arguments);
        this.properties = this.properties || {};
        this.properties._ui_size = [this.size?.[0] || MIN_NODE_WIDTH, this.size?.[1] || MIN_NODE_HEIGHT];
        this.properties._preset = presetWidget.value || CUSTOM_VALUE;
    };

    const origConfigure = node.onConfigure;
    node.onConfigure = function (o) {
        if (origConfigure) origConfigure.apply(this, arguments);

        const savedSize = this.properties?._ui_size || o?.properties?._ui_size;
        if (Array.isArray(savedSize) && savedSize.length === 2) {
            this.size = [
                Math.max(MIN_NODE_WIDTH, Number(savedSize[0]) || MIN_NODE_WIDTH),
                Math.max(MIN_NODE_HEIGHT, Number(savedSize[1]) || MIN_NODE_HEIGHT)
            ];
        }
        this.minSize = [MIN_NODE_WIDTH, MIN_NODE_HEIGHT];

        if (this.properties?._preset) selectedPreset = this.properties._preset;
        syncFromWidgets();
        rebuildPresetOptions();
    };

    /* ---------------- 启动 ---------------- */

    rebuildPresetOptions();
    loadPresetsAndRefresh();

    suppressPresetReset = true;
    try { applyPoints(strToPts(ta.value)); } finally { suppressPresetReset = false; }
    draw();

    new ResizeObserver(() => draw()).observe(canvas);

    // widget 值可能在 onNodeCreated 之后才恢复，补一次同步
    setTimeout(syncFromWidgets, 0);
    setTimeout(syncFromWidgets, 150);
}


app.registerExtension({
    name: "PainterSigmasGraph.widget",
    beforeRegisterNodeDef(nt, nd) {
        if (nd.name !== NODE_CLASS) return;

        try {
            if (nd?.input?.required?.graph_data) {
                nd.input.required.graph_data[1] = {
                    ...(nd.input.required.graph_data[1] || {}),
                    hidden: true,
                    forceInput: false
                };
            }
        } catch (e) {
            console.warn("[PainterSigmasGraph] nodeData hide patch failed:", e);
        }

        const origConfigure = nt.prototype.onConfigure;
        nt.prototype.onConfigure = function (info) {
            origConfigure?.apply(this, arguments);
            setup(this);
        };

        const origNodeCreated = nt.prototype.onNodeCreated;
        nt.prototype.onNodeCreated = function () {
            origNodeCreated?.apply(this, arguments);
            if (!this.properties) this.properties = {};
            setup(this);
        };
    }
});

if (app.on) {
    app.on("nodeAdded", (n) => { if (n.type === NODE_CLASS) setup(n); });
} else {
    setInterval(() => {
        (app.graph?._nodes || []).forEach((n) => {
            if (n.type === NODE_CLASS) setup(n);
        });
    }, 100);
}
