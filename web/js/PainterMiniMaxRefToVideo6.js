import { app } from "../../scripts/app.js";
/* ================================================================
PainterMiniMaxRefToVideo6.js  （基于 v3 的优化版）
优化点：
  1. 参考图上传框支持【直接拖拽图片文件】放入：
       - 拖到某个已有图片的槽位 → 替换该槽位
       - 拖到空槽位 / 上传区空白处 → 追加到末尾
       - 支持一次拖入多张（自动增行，上限 3 行 × 3 = 9 张）
  2. 去掉 width / height / length 三个输出端口（输入控件与端口保留）
  3. 快捷标识【前台显示 = 最终输出文本】，只保留配色高亮：
       @图片1 + 空格      → <Picture 1>
       【台词内容】+ 空格  → <d>[Chinese] 台词内容</d>   （不自动补句号）
       切镜2 + 空格       → [Shot 2] At 00:02.00
     这样可以直接在节点里框选复制出可复用的完整提示词。
  4. 新增 ⧉ 复制按钮：一键复制最终提示词到剪贴板。
  5. 粘贴 / 回填时能识别 <Picture N>、<d>…</d>、[Shot N] At MM:SS.ff
     以及旧格式 @图片N、【…】、切镜N，统一还原成彩色块。
================================================================ */
const NODE_CLASS = "PainterMiniMaxRefToVideo6";
const STYLE_ID = "mmr6-styles";
const PROMPT_DOC_PROP = "mmr_prompt_doc";
const WIDGET_STATE_PROP = "mmr_widget_values";
const NODE_SIZE_PROP = "mmr_node_size";
const REF_IMAGE_FILES_PROP = "mmr_ref_image_files";
const REF_ROWS_PROP = "mmr_ref_rows";
const DEFAULT_NODE_SIZE = [430, 660];
const DEFAULT_WIDGET_VALUES = {
    width: 1376,
    height: 768,
    length: 124,
    ref_max_size: 1536,
};
const DIALOGUE_CLASS = "mmr-dialogue-block";
const DIALOGUE_CONTENT_CLASS = "mmr-dlg-content";
const DIALOGUE_PREFIX_CLASS = "mmr-dlg-prefix";
const DIALOGUE_SUFFIX_CLASS = "mmr-dlg-suffix";
const DIALOGUE_CLOSE_CLASS = "mmr-dlg-close";
const SHOT_CHIP_CLASS = "mmr-shot-chip";
const SHOT_LABEL_CLASS = "mmr-shot-chip-label";
const MENTION_CHIP_CLASS = "mmr-mention-chip";
const CHIP_SELECTOR = `.${MENTION_CHIP_CLASS}, .${SHOT_CHIP_CLASS}`;
const CARET_SENTINEL = "\u200B";
const PROMPT_HISTORY_LIMIT = 80;
const SHOT_TRIGGER_RE = /切镜\s*(\d+(?:\.\d+)?)$/;
const FALLBACK_SHOT_RE = /切镜\s*(\d+(?:\.\d+)?)\s*[，,]?\s*/g;
const BRACKET_DIALOGUE_RE = /【([^】]*)】/g;
const MENTION_TRIGGER_RE = /@(图片|视频|音频)(\d+)$/;
/* 把「显示成最终输出文本」的整段提示词反解析回彩色块（粘贴 / 回填用）。
   分组顺序：
     1 <d>…</d> 正文 | 2/3 <Picture|Video|Audio N> | 4/5/6 [Shot N] At MM:SS.ff
     7 旧格式 切镜N   | 8 旧格式 【…】           | 9/10 旧格式 @图片N        */
const INLINE_TOKEN_RE = new RegExp(
    [
        "<d>([\\s\\S]*?)<\\/d>",
        "<(Picture|Video|Audio)\\s+(\\d+)>",
        "\\[Shot\\s+(\\d+)\\]\\s*At\\s+(\\d{1,2}):(\\d{2}(?:\\.\\d+)?)\\s*,?",
        "切镜\\s*(\\d+(?:\\.\\d+)?)",
        "【([^】]*)】",
        "@(图片|视频|音频)(\\d+)",
    ].join("|"),
    "gi"
);
const MENTION_TAG_MAP = {
    image: "Picture",
    video: "Video",
    audio: "Audio",
};
const MENTION_TAG_TO_TYPE = {
    picture: "image",
    video: "video",
    audio: "audio",
};
const KEYWORD_RULES = [
    {
        re: /不要背景音乐|无背景音乐|不要音乐|无音乐|无\sBGM|不要\sBGM/g,
        guard: /non_diegetic_music/i,
        replacement: "non_diegetic_music:\nN/A",
    },
    {
        re: /不要字幕|无字幕|不要出现字幕/g,
        guard: /no subtitles|无任何字幕/i,
        replacement: "画面严格保持干净，无任何字幕、屏幕文字、说明文字或水印。",
    },
];
const MENTION_TYPE_MAP = {
    "图片": "image",
    "视频": "video",
    "音频": "audio",
};
const MENTION_ICON_MAP = {
    image: "🖼",
    video: "🎞️",
    audio: "🔊",
};
const MENTION_LABEL_MAP = {
    image: "图片",
    video: "视频",
    audio: "音频",
};
const MENTION_MENU_CLASS = "mmr-mention-menu";
const MENTION_MENU_ITEM_CLASS = "mmr-mention-menu-item";
const MAX_REF_ROWS = 3;
const SLOTS_PER_ROW = 3;
const MAX_REF_SLOTS = MAX_REF_ROWS * SLOTS_PER_ROW;
let installed = false;
let patchedPrompt = false;
let activeMentionMenu = null;

/* ================================================================
与 Vue Nodes (Nodes 2.0) 兼容的通用工具
================================================================ */
function setWidgetOption(widget, key, value) {
    if (!widget) return;
    widget.options ||= {};
    if (value === undefined) delete widget.options[key];
    else widget.options[key] = value;
    if (widget._state?.options) {
        if (value === undefined) delete widget._state.options[key];
        else widget._state.options[key] = value;
    }
}

function isVueNodesMode() {
    return Boolean(globalThis.LiteGraph?.vueNodesMode);
}

function refreshVueNodeWidgets(node) {
    if (!Array.isArray(node?.widgets)) return;
    const widgets = [...node.widgets];
    try {
        if (isVueNodesMode()) node.widgets = [];
        node.widgets = widgets;
    } catch { /* 在某些前端 widgets 是只读 */ }
}

function refreshNodeWidgetDOM(node) {
    if (!node) return;
    node._widgetSlotsDirty = true;
    node.setDirtyCanvas?.(true, true);
    app.graph?.setDirtyCanvas?.(true, true);
}

const syncThrottleMap = new WeakMap();

/* ================================================================
工具函数
================================================================ */
function isTarget(node) {
    return String(
        node?.comfyClass ||
        node?.type ||
        node?.constructor?.nodeData?.name ||
        ""
    ) === NODE_CLASS;
}

function getWidget(node, name) {
    return node?.widgets?.find((w) => w?.name === name) || null;
}

function formatShotTime(totalSeconds) {
    const s = Number(totalSeconds);
    return `${s}秒切镜`;
}

function formatShotTimestamp(totalSeconds) {
    const s = Math.max(0, Number(totalSeconds) || 0);
    const minutes = Math.floor(s / 60);
    const seconds = s % 60;
    const mm = String(minutes).padStart(2, "0");
    const ss = seconds.toFixed(2).padStart(5, "0");
    return `${mm}:${ss}`;
}

/* 台词块包裹。v6：不再自动补句号 —— 用户输入什么就输出什么 */
function wrapDialogueTag(text) {
    const trimmed = String(text || "").trim();
    if (!trimmed) return "";
    if (/^\[[^\]]+\]/.test(trimmed)) return `<d>${trimmed}</d>`;
    return `<d>[Chinese] ${trimmed}</d>`;
}

function postProcessPromptText(text) {
    let result = String(text || "");
    result = result.replace(BRACKET_DIALOGUE_RE, (m, inner) => wrapDialogueTag(inner));
    for (const rule of KEYWORD_RULES) {
        if (rule.guard.test(result)) {
            result = result.replace(rule.re, "");
            continue;
        }
        let first = true;
        result = result.replace(rule.re, () => {
            const v = first ? rule.replacement : "";
            first = false;
            return v;
        });
    }
    return result;
}

function getSourceNode(targetNode, inputIndex) {
    const input = targetNode.inputs?.[inputIndex];
    if (!input) return null;
    const linkId = input.link;
    if (linkId == null) return null;
    const graph = targetNode.graph || app.graph;
    if (!graph) return null;
    if (graph.links instanceof Map) {
        const link = graph.links.get(linkId) || graph.links.get(String(linkId));
        if (link) {
            const originId = link.origin_id ?? link.originId ?? link.from_id ?? link.fromId;
            return graph.getNodeById?.(originId) || null;
        }
    }
    if (typeof graph.links === "object") {
        const link = graph.links[linkId] ?? graph.links[String(linkId)];
        if (link) {
            const originId = link.origin_id ?? link.originId ?? link.from_id ?? link.fromId;
            return graph.getNodeById?.(originId) || null;
        }
    }
    if (graph._links) {
        const link = graph._links[linkId] ?? graph._links[String(linkId)];
        if (link) {
            const originId = link.origin_id ?? link.originId ?? link.from_id ?? link.fromId;
            return graph.getNodeById?.(originId) || null;
        }
    }
    return null;
}

function getMediaPreview(sourceNode, type) {
    if (!sourceNode || type === "audio") return "";
    // 视频素材 = 图片序列，imgs[0] 即第一帧；图片同理
    if (sourceNode.imgs?.[0]?.src) return sourceNode.imgs[0].src;
    // 遍历源节点 widgets，找 img/video 元素（预览缩略图）
    for (const w of sourceNode.widgets || []) {
        const el = w?.element;
        const img = el?.matches?.("img") ? el : el?.querySelector?.("img");
        if (img?.src) return img.src;
        const video = el?.matches?.("video") ? el : el?.querySelector?.("video");
        if (type === "video" && video?.poster) return video.poster;
    }
    // 从 widget value 构造稳定 URL（图片类节点）
    const imgWidget = sourceNode.widgets?.find(w => w.name === "image" || w.name === "video" || w.name === "file");
    const filename = typeof imgWidget?.value === "object" ? imgWidget.value.filename : imgWidget?.value;
    if (filename) return `/view?filename=${encodeURIComponent(filename)}&type=input`;
    return "";
}

/* ================================================================
参考图上传区
================================================================ */
function getRefImageFiles(node) {
    const raw = node?.properties?.[REF_IMAGE_FILES_PROP];
    if (!raw) return [];
    try {
        const arr = JSON.parse(raw);
        return Array.isArray(arr) ? arr : [];
    } catch {
        return [];
    }
}

/* 通知 ComfyUI「这个节点有改动」，让 workflow 的持久化快照更新。

   ComfyUI 1.x 的「变更 → 持久化」链路是：
       ChangeTracker.checkState()          ← 唯一的变更检测入口
         → 比对 activeState，发现差异
           → updateModified() → dispatch 'graphChanged' 事件
               → useWorkflowPersistence  写 Draft 快照（刷新恢复的数据源）
               → useWorkflowAutoSave     写服务端 workflow 文件

   而 ChangeTracker 只在官方时机调 checkState()：keydown / keyup / mouseup /
   画布内点击 / 右键菜单关闭 等。事件顺序是 mouseup → click，我们的删除按钮
   逻辑跑在 click 里，所以官方那次检查永远早一步、看不到这次改动。

   注意 app.graph.change() 是无效的：新版 ComfyUI 里 graph.onChange 为
   undefined，graph.change() 不会派发任何东西，也就不会触发持久化。
   这正是「删掉参考图后刷新又复活」的根因 —— 上传后通常还会接着打字，
   打字触发的 keydown 顺带把状态存了，所以上传反而看起来是正常的。

   凡是改动持久化数据的地方都要调一次。 */
function notifyGraphChanged(node) {
    // 1) 首选：直接走官方变更检测入口
    try {
        const tracker = app?.extensionManager?.workflow?.activeWorkflow?.changeTracker;
        if (typeof tracker?.checkState === "function") {
            tracker.checkState();
            return;
        }
    } catch { /* ignore */ }

    // 2) 兜底：ChangeTracker.init() 把 checkState 挂在 window 的 mouseup 上，
    //    派发一个等价事件即可走到同一条链路（不依赖内部对象结构）
    try {
        window.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, cancelable: true }));
    } catch { /* ignore */ }

    // 3) 老版 ComfyUI 兼容
    try {
        (node?.graph || app?.graph)?.change?.();
    } catch { /* ignore */ }
}

function setRefImageFiles(node, files) {
    node.properties ||= {};
    const compacted = files.filter(f => f?.filename);
    const jsonStr = JSON.stringify(compacted);
    node.properties[REF_IMAGE_FILES_PROP] = jsonStr;
    node.__mediaDirty = true;
    // 同步更新 widget 值作为兜底（即使 patchGraphToPrompt 未触发也能传递数据）
    const widget = getWidget(node, "ref_image_files");
    if (widget) {
        widget.value = jsonStr;
        if (widget._state) widget._state.value = jsonStr;
    }
    notifyGraphChanged(node);
}

function getRefRows(node) {
    const rows = Number(node?.properties?.[REF_ROWS_PROP]);
    return Number.isFinite(rows) && rows >= 1 ? Math.min(MAX_REF_ROWS, rows) : 1;
}

function setRefRows(node, rows) {
    node.properties ||= {};
    node.properties[REF_ROWS_PROP] = Math.min(MAX_REF_ROWS, Math.max(1, rows));
    notifyGraphChanged(node);
}

function getRefImagePreviewUrl(fileInfo) {
    if (!fileInfo?.filename) return "";
    let url = `/view?filename=${encodeURIComponent(fileInfo.filename)}&type=${fileInfo.type || "input"}`;
    if (fileInfo.subfolder) url += `&subfolder=${encodeURIComponent(fileInfo.subfolder)}`;
    return url;
}

async function uploadRefImageFile(file) {
    const formData = new FormData();
    formData.append("image", file);
    formData.append("type", "input");
    formData.append("overwrite", "true");

    const response = await fetch("/upload/image", {
        method: "POST",
        body: formData,
    });
    if (!response.ok) throw new Error(`Upload failed: ${response.status}`);
    const data = await response.json();
    return {
        filename: data.name || data.filename || "",
        subfolder: data.subfolder || "",
        type: data.type || "input",
    };
}

/* ================================================================
v6：拖拽图片到上传框
================================================================ */
const DROP_ACTIVE_CLASS = "is-dragover";
const IMAGE_FILE_RE = /\.(png|jpe?g|webp|bmp|gif|tiff?|avif)$/i;

function isImageFile(file) {
    if (!file) return false;
    if (file.type?.startsWith("image/")) return true;
    return IMAGE_FILE_RE.test(String(file.name || ""));
}

/* dragover 阶段只有 types 可用，用它判断是不是"拖进来了文件" */
function hasFilePayload(dataTransfer) {
    const types = dataTransfer?.types;
    if (!types) return false;
    try {
        return Array.from(types).includes("Files");
    } catch {
        return false;
    }
}

function imageFilesFromDataTransfer(dataTransfer) {
    if (!dataTransfer) return [];
    const out = [];
    const list = dataTransfer.files;
    if (list && list.length) {
        for (const f of list) if (isImageFile(f)) out.push(f);
    }
    if (!out.length && dataTransfer.items?.length) {
        for (const item of dataTransfer.items) {
            if (item?.kind !== "file") continue;
            const f = item.getAsFile?.();
            if (isImageFile(f)) out.push(f);
        }
    }
    return out;
}

/* 把拖入/选中的图片写入参考图列表：
   startIndex 有值时从该槽位开始替换（多张则依次顺延），否则追加到末尾。 */
async function addRefImages(node, files, startIndex = null) {
    if (!node || !files?.length) return false;
    const uploaded = [];
    for (const file of files) {
        try {
            uploaded.push(await uploadRefImageFile(file));
        } catch (err) {
            console.error("[MMR6] 参考图上传失败:", err);
        }
    }
    if (!uploaded.length) return false;

    const list = getRefImageFiles(node).filter((f) => f?.filename);
    if (startIndex != null && startIndex >= 0 && startIndex < list.length) {
        list.splice(startIndex, 1, ...uploaded);
    } else {
        list.push(...uploaded);
    }

    if (list.length > MAX_REF_SLOTS) {
        list.length = MAX_REF_SLOTS;
        alert(`参考图最多 ${MAX_REF_SLOTS} 张（${MAX_REF_ROWS} 行 × ${SLOTS_PER_ROW} 列），多出的图片已忽略。`);
    }

    const neededRows = Math.min(MAX_REF_ROWS, Math.max(1, Math.ceil(list.length / SLOTS_PER_ROW)));
    if (neededRows > getRefRows(node)) setRefRows(node, neededRows);

    setRefImageFiles(node, list);
    renderRefUploadArea(node);
    repairNodeLayout(node);
    return true;
}

/* 给一个元素挂上"接收图片文件"的拖放行为 */
const DROP_HIGHLIGHT_SELECTOR =
    `.mmr-ref-slot.${DROP_ACTIVE_CLASS}, .mmr-ref-upload-area.${DROP_ACTIVE_CLASS}`;

/* 清掉所有拖拽高亮。
   坑：drop 事件会被更内层的元素 stopPropagation，外层就收不到，
   高亮（淡蓝框）会一直留着直到刷新。所以统一在这里兜底清理。 */
function clearDropHighlights() {
    document.querySelectorAll?.(DROP_HIGHLIGHT_SELECTOR)?.forEach((el) => {
        el.classList.remove(DROP_ACTIVE_CLASS);
    });
}

/* 同一时刻只高亮一个投放目标，否则槽位和上传区会同时亮起 */
function highlightDropTarget(el) {
    document.querySelectorAll?.(DROP_HIGHLIGHT_SELECTOR)?.forEach((other) => {
        if (other !== el) other.classList.remove(DROP_ACTIVE_CLASS);
    });
    el.classList.add(DROP_ACTIVE_CLASS);
}

let dropCleanupInstalled = false;
function installGlobalDropCleanup() {
    if (dropCleanupInstalled) return;
    dropCleanupInstalled = true;
    const clear = () => clearDropHighlights();
    // 捕获阶段执行，早于元素自身的 drop 处理器 —— 清高亮不影响后续的文件处理
    window.addEventListener("drop", clear, true);
    window.addEventListener("dragend", clear, true);
    // 拖出窗口 / 按 Esc 取消拖拽时，dragleave 的 relatedTarget 为 null
    document.addEventListener("dragleave", (event) => {
        if (event.relatedTarget) return;
        clear();
    }, true);
}

function attachImageDropTarget(el, onFiles) {
    if (!el || el.__mmrDropBound) return;
    el.__mmrDropBound = true;

    el.addEventListener("dragover", (event) => {
        if (!hasFilePayload(event.dataTransfer)) return;
        event.preventDefault();
        event.stopPropagation();
        try { event.dataTransfer.dropEffect = "copy"; } catch { /* ignore */ }
        highlightDropTarget(el);
    });

    el.addEventListener("dragenter", (event) => {
        if (!hasFilePayload(event.dataTransfer)) return;
        event.preventDefault();
        event.stopPropagation();
        highlightDropTarget(el);
    });

    el.addEventListener("dragleave", (event) => {
        event.stopPropagation();
        // 在子元素之间移动时也会触发 dragleave，靠 relatedTarget 过滤掉
        if (event.relatedTarget && el.contains(event.relatedTarget)) return;
        el.classList.remove(DROP_ACTIVE_CLASS);
    });

    el.addEventListener("drop", (event) => {
        event.preventDefault();
        event.stopPropagation();
        event.stopImmediatePropagation?.();
        clearDropHighlights();
        const files = imageFilesFromDataTransfer(event.dataTransfer);
        if (!files.length) return;
        onFiles(files);
    });
}

function renderRefUploadArea(node) {
    const area = node.__mmrRefUploadArea;
    if (!area) return;

    const files = getRefImageFiles(node);
    const rows = getRefRows(node);
    const canAddRow = rows < MAX_REF_ROWS;
    const canRemoveRow = rows > 1;

    area.textContent = "";

    for (let row = 0; row < rows; row++) {
        const rowEl = document.createElement("div");
        rowEl.className = "mmr-ref-upload-row";

        for (let col = 0; col < SLOTS_PER_ROW; col++) {
            const slotIndex = row * SLOTS_PER_ROW + col;
            const fileInfo = files[slotIndex];
            const slot = createRefSlot(node, slotIndex, fileInfo);
            rowEl.append(slot);
        }

        area.append(rowEl);
    }

    const controls = document.createElement("div");
    controls.className = "mmr-ref-row-controls";

    const removeBtn = document.createElement("button");
    removeBtn.className = "mmr-ref-remove-row-btn";
    removeBtn.type = "button";
    removeBtn.textContent = "- 减少一行";
    removeBtn.disabled = !canRemoveRow;
    removeBtn.addEventListener("pointerdown", (e) => {
        e.preventDefault();
        e.stopPropagation();
    });
    removeBtn.addEventListener("click", (e) => {
        e.preventDefault();
        e.stopPropagation();
        const currentRows = getRefRows(node);
        if (currentRows > 1) {
            setRefRows(node, currentRows - 1);
            renderRefUploadArea(node);
            repairNodeLayout(node);
        }
    });
    controls.append(removeBtn);

    const addBtn = document.createElement("button");
    addBtn.className = "mmr-ref-add-row-btn";
    addBtn.type = "button";
    addBtn.textContent = "+ 再加一行";
    addBtn.disabled = !canAddRow;
    addBtn.addEventListener("pointerdown", (e) => {
        e.preventDefault();
        e.stopPropagation();
    });
    addBtn.addEventListener("click", (e) => {
        e.preventDefault();
        e.stopPropagation();
        const currentRows = getRefRows(node);
        if (currentRows < MAX_REF_ROWS) {
            setRefRows(node, currentRows + 1);
            renderRefUploadArea(node);
            repairNodeLayout(node);
        }
    });
    controls.append(addBtn);

    area.append(controls);
}

function createRefSlot(node, slotIndex, fileInfo) {
    const slot = document.createElement("div");
    slot.className = "mmr-ref-slot";
    slot.dataset.slotIndex = String(slotIndex);

    if (fileInfo?.filename) {
        slot.classList.add("has-image");
        const img = document.createElement("img");
        img.src = getRefImagePreviewUrl(fileInfo);
        img.alt = "";
        img.draggable = false;
        img.addEventListener("error", () => {
            slot.classList.remove("has-image");
            slot.textContent = "";
            const ph = document.createElement("span");
            ph.className = "mmr-ref-slot-placeholder";
            ph.textContent = "+";
            slot.append(ph);
        });
        slot.append(img);

        const removeBtn = document.createElement("button");
        removeBtn.className = "mmr-ref-slot-remove";
        removeBtn.type = "button";
        removeBtn.innerHTML = "&times;";
        removeBtn.title = "移除参考图";
        removeBtn.addEventListener("pointerdown", (e) => {
            e.preventDefault();
            e.stopPropagation();
        });
        removeBtn.addEventListener("click", (e) => {
            e.preventDefault();
            e.stopPropagation();
            const files = getRefImageFiles(node);
            files.splice(slotIndex, 1);
            setRefImageFiles(node, files);
            renderRefUploadArea(node);
            repairNodeLayout(node);
        });
        slot.append(removeBtn);
    } else {
        const ph = document.createElement("span");
        ph.className = "mmr-ref-slot-placeholder";
        ph.textContent = "+";
        slot.append(ph);
    }

    // v6：支持直接把图片文件拖到该槽位（已有图则替换，空槽位则追加）
    attachImageDropTarget(slot, (files) => {
        addRefImages(node, files, slotIndex);
    });

    slot.addEventListener("pointerdown", (e) => {
        if (e.target.closest(".mmr-ref-slot-remove")) return;
        e.preventDefault();
        e.stopPropagation();
    });

    slot.addEventListener("click", (e) => {
        if (e.target.closest(".mmr-ref-slot-remove")) return;
        e.preventDefault();
        e.stopPropagation();

        const fileInput = document.createElement("input");
        fileInput.type = "file";
        fileInput.accept = "image/*";
        fileInput.multiple = true;
        fileInput.style.display = "none";

        fileInput.addEventListener("change", async () => {
            const picked = Array.from(fileInput.files || []);
            fileInput.remove();
            if (!picked.length) return;
            await addRefImages(node, picked, slotIndex);
        });

        document.body.append(fileInput);
        fileInput.click();
    });

    return slot;
}

/* ================================================================
媒体列表（含上传参考图 + 外部视频/音频）
================================================================ */
function getConnectedMedia(node) {
    const media = { image: [], video: [], audio: [] };
    if (!node?.inputs) return media;

    if (node.__mediaCache && !node.__mediaDirty) {
        return node.__mediaCache;
    }

    // 上传的参考图（序号连续递增）
    const refFiles = getRefImageFiles(node);
    let imageOrdinal = 0;
    for (const fileInfo of refFiles) {
        if (!fileInfo?.filename) continue;
        imageOrdinal++;
        media.image.push({
            type: "image",
            ordinal: imageOrdinal,
            label: `图片${imageOrdinal}`,
            tag: `<Picture ${imageOrdinal}>`,
            token: `@图片${imageOrdinal}`,
            previewUrl: getRefImagePreviewUrl(fileInfo),
            sourceNode: null,
        });
    }

    // 外部连线的视频和音频（保持原有逻辑）
    node.inputs.forEach((input, index) => {
        if (input.link == null) return;
        const name = String(input.name || "");
        let match = name.match(/ref_video_(\d+)$/i) || name.match(/^video_(\d+)$/i);
        if (match) {
            const ordinal = parseInt(match[1], 10) + 1;
            media.video.push({
                type: "video",
                ordinal,
                label: `视频${ordinal}`,
                tag: `<Video ${ordinal}>`,
                token: `@视频${ordinal}`,
                sourceNode: getSourceNode(node, index),
            });
            return;
        }
        match = name.match(/ref_audio_(\d+)$/i) || name.match(/ref_video_audio_(\d+)$/i) || name.match(/^audio_(\d+)$/i);
        if (match) {
            const ordinal = parseInt(match[1], 10) + 1;
            const isVideoAudio = name.includes("video_audio");
            media.audio.push({
                type: "audio",
                ordinal,
                label: isVideoAudio ? `视频${ordinal}伴音` : `音频${ordinal}`,
                tag: `<Audio ${ordinal}>`,
                token: `@音频${ordinal}`,
                sourceNode: getSourceNode(node, index),
            });
        }
    });

    ["image", "video", "audio"].forEach(type => {
        media[type].sort((a, b) => a.ordinal - b.ordinal);
    });
    node.__mediaCache = media;
    node.__mediaDirty = false;
    return media;
}

/* ================================================================
节点尺寸持久化（修复版：即时写入，不丢尺寸）
================================================================ */
function writeNodeSize(node, size) {
    if (!node) return;
    const source = Array.isArray(size) || size?.length != null ? size : node.size;
    const w = Math.min(4000, Math.max(220, Math.round(Number(source?.[0]) || DEFAULT_NODE_SIZE[0])));
    const h = Math.min(4000, Math.max(120, Math.round(Number(source?.[1]) || DEFAULT_NODE_SIZE[1])));
    node.properties ||= {};
    node.properties[NODE_SIZE_PROP] = [w, h];
}

function applyNodeSizeNow(node, size) {
    if (!node || !Array.isArray(size) && size?.length == null) return;
    node.__mmrRestoringSize = true;
    try {
        const targetW = Math.max(220, Math.min(4000, Math.round(Number(size?.[0]) || DEFAULT_NODE_SIZE[0])));
        let targetH = Math.max(120, Math.min(4000, Math.round(Number(size?.[1]) || DEFAULT_NODE_SIZE[1])));
        // 若 savedSize 不够 fit 当前 widgets（含 DOM widget 高度），
        // 自动扩大到 computeSize()，避免 mmr_prompt_editor 等 DOM widget
        // 被节点 size 截断而视觉上"被盖住"。不缩小——保留用户的紧凑选择。
        try {
            const computed = node.computeSize?.(targetW);
            if (Array.isArray(computed) && computed[1] > targetH + 4) {
                targetH = Math.min(4000, Math.round(computed[1]));
            }
        } catch (_) {}
        node.setSize?.([targetW, targetH]);
        writeNodeSize(node, [targetW, targetH]);
        node._widgetSlotsDirty = true;
        node.setDirtyCanvas?.(true, true);
    } finally {
        setTimeout(() => { node.__mmrRestoringSize = false; }, 0);
    }
}

function repairNodeLayout(node) {
    if (!node || node.__mmrRemoved) return;
    const run = () => {
        if (node.__mmrRemoved) return;
        // 用两阶段尺寸设置让 LiteGraph 重新测量并通知所有 widgets
        const size = node.size;
        if (Array.isArray(size) && typeof node.setSize === "function") {
            try {
                node.setSize([size[0], Math.max(40, size[1] - 1)]);
                node.setSize([size[0], Math.max(40, size[1])]);
            } catch { /* */ }
        }
        refreshVueNodeWidgets(node);
        node._widgetSlotsDirty = true;
        node.setDirtyCanvas?.(true, true);
        app.graph?.setDirtyCanvas?.(true, true);
    };
    if (typeof requestAnimationFrame === "function") requestAnimationFrame(run);
    else setTimeout(run, 0);
}

/* ================================================================
光标 / 文本工具
================================================================ */
function makeCaretSentinel() {
    return document.createTextNode(CARET_SENTINEL);
}

function isCaretSentinelText(node) {
    return node?.nodeType === Node.TEXT_NODE && String(node.textContent || "").includes(CARET_SENTINEL);
}

function stripCaretSentinels(value) {
    return String(value ?? "").replaceAll(CARET_SENTINEL, "");
}

function appendTextWithBreaks(container, value) {
    String(value || "").split("\n").forEach((part, i) => {
        if (i) container.append(document.createElement("br"));
        if (part) container.append(document.createTextNode(part));
    });
}

function setCaretAtNode(node, offset = 0) {
    const sel = window.getSelection?.();
    if (!sel || !node) return;
    const range = document.createRange();
    range.setStart(node, offset);
    range.collapse(true);
    sel.removeAllRanges();
    sel.addRange(range);
}

function setCaretAtEndOfNode(node) {
    if (!node) return;
    const sel = window.getSelection?.();
    if (!sel) return;
    const range = document.createRange();
    let target = node;
    while (target?.lastChild) target = target.lastChild;
    if (target?.nodeType === Node.TEXT_NODE) {
        range.setStart(target, target.textContent.length);
    } else if (target?.parentNode && target !== node) {
        range.setStartAfter(target);
    } else {
        range.setStart(node, node.childNodes.length);
    }
    range.collapse(true);
    sel.removeAllRanges();
    sel.addRange(range);
}

function editorText(editor) {
    let result = "";
    const visit = (node) => {
        if (!node) return;
        if (node.nodeType === Node.TEXT_NODE) {
            result += String(node.textContent || "").replaceAll(CARET_SENTINEL, "");
            return;
        }
        if (node.nodeType !== Node.ELEMENT_NODE) return;
        if (
            node.classList?.contains(MENTION_CHIP_CLASS) ||
            node.classList?.contains(SHOT_CHIP_CLASS)
        ) {
            result += node.dataset.token || "";
            return;
        }
        if (node.tagName === "BR") {
            result += "\n";
            return;
        }
        const block = ["DIV", "P"].includes(node.tagName);
        if (block && result && !result.endsWith("\n")) result += "\n";
        for (const child of node.childNodes || []) visit(child);
    };
    for (const child of editor.childNodes || []) visit(child);
    return result;
}

function insertPlainText(editor, text) {
    if (document.execCommand?.("insertText", false, text)) return;
    const sel = window.getSelection?.();
    if (!sel || !sel.rangeCount) return;
    const range = sel.getRangeAt(0);
    range.deleteContents();
    const node = document.createTextNode(text);
    range.insertNode(node);
    range.setStartAfter(node);
    range.collapse(true);
    sel.removeAllRanges();
    sel.addRange(range);
}

function insertEditorLineBreak(editor) {
    const sel = window.getSelection?.();
    if (!sel || !sel.rangeCount) return false;
    const range = sel.getRangeAt(0);
    if (!editor.contains(range.commonAncestorContainer)) return false;
    range.deleteContents();
    const br = document.createElement("br");
    const marker = document.createTextNode(CARET_SENTINEL);
    const frag = document.createDocumentFragment();
    frag.append(br, marker);
    range.insertNode(frag);
    const caret = document.createRange();
    caret.setStart(marker, marker.textContent.length);
    caret.collapse(true);
    sel.removeAllRanges();
    sel.addRange(caret);
    return true;
}

/* ================================================================
台词块
================================================================ */
function isDialogueBlock(node) {
    return node?.nodeType === Node.ELEMENT_NODE && node.classList?.contains(DIALOGUE_CLASS);
}

/* ---- 台词块：结构 = 不可编辑的 <d>[Chinese] + 可编辑正文 + 不可编辑 </d>
   这样 DOM 里真实存在的就是最终输出文本，框选复制拿到的就是 <d>[Chinese] 台词</d>，
   同时正文仍然可以直接编辑。
   v6：不再自动补句号 —— 显示与输出都严格等于用户输入的内容。 ---- */
function dialogueDisplayParts(rawText) {
    const trimmed = String(rawText || "").trim();
    const hasLangTag = trimmed ? /^\[[^\]]+\]/.test(trimmed) : false;
    return {
        prefix: hasLangTag ? "<d>" : "<d>[Chinese] ",
        suffix: "</d>",
    };
}

function dialogueContentEl(block) {
    return block?.querySelector?.(`.${DIALOGUE_CONTENT_CLASS}`) || null;
}

function makeDialogueBlock(value = "") {
    const block = document.createElement("span");
    block.className = DIALOGUE_CLASS;
    block.spellcheck = false;
    block.dataset.dialogue = "true";
    // 外层不可编辑，只有正文子节点可编辑，避免光标跑到 <d> 标签外面
    block.contentEditable = "false";

    const prefix = document.createElement("span");
    prefix.className = DIALOGUE_PREFIX_CLASS;
    prefix.contentEditable = "false";

    const content = document.createElement("span");
    content.className = DIALOGUE_CONTENT_CLASS;
    content.contentEditable = "true";
    content.spellcheck = false;
    appendTextWithBreaks(content, value);
    if (!String(value || "")) content.append(makeCaretSentinel());

    const suffix = document.createElement("span");
    suffix.className = DIALOGUE_SUFFIX_CLASS;
    suffix.contentEditable = "false";

    const close = document.createElement("span");
    close.className = DIALOGUE_CLOSE_CLASS;
    close.contentEditable = "false";

    block.append(prefix, content, suffix, close);
    refreshDialogueBlockChrome(block);
    return block;
}

/* 只取可编辑正文，忽略 <d>[Chinese] / </d> 这些装饰文本 */
function dialogueBlockText(block) {
    const content = dialogueContentEl(block);
    return editorText(content || block);
}

/* 让装饰部分与最终输出保持一致（语言标记判断；v6 不补句号） */
function refreshDialogueBlockChrome(block) {
    if (!block) return;
    const content = dialogueContentEl(block);
    if (!content) return;
    const prefix = block.querySelector(`.${DIALOGUE_PREFIX_CLASS}`);
    const suffix = block.querySelector(`.${DIALOGUE_SUFFIX_CLASS}`);
    const parts = dialogueDisplayParts(editorText(content));
    if (prefix && prefix.textContent !== parts.prefix) prefix.textContent = parts.prefix;
    if (suffix && suffix.textContent !== parts.suffix) suffix.textContent = parts.suffix;
}

function refreshAllDialogueChrome(editor) {
    const blocks = editor?.querySelectorAll?.(`.${DIALOGUE_CLASS}`) || [];
    for (const block of blocks) refreshDialogueBlockChrome(block);
}

/* 把光标放到台词块正文里（空块时放到哨兵符后） */
function setCaretAtDialogueContentEnd(block) {
    const content = dialogueContentEl(block);
    if (!content) return;
    setCaretAtEndOfNode(content);
}

function dialogueBlockAtSelection(editor) {
    const sel = window.getSelection?.();
    if (!sel || !sel.rangeCount) return null;
    const container = sel.getRangeAt(0).startContainer;
    const element = container.nodeType === Node.ELEMENT_NODE ? container : container.parentElement;
    const block = element?.closest?.(`.${DIALOGUE_CLASS}`);
    return block && editor.contains(block) ? block : null;
}

function dialogueBoundary(block, side) {
    if (!block?.parentNode) return null;
    const sibling = side === "before" ? block.previousSibling : block.nextSibling;
    if (isCaretSentinelText(sibling)) return sibling;
    const marker = makeCaretSentinel();
    block.parentNode.insertBefore(marker, side === "before" ? block : block.nextSibling);
    return marker;
}

function exitDialogueBlock(node, editor, block) {
    const marker = dialogueBoundary(block, "after");
    if (!marker) return false;
    const text = String(marker.textContent || "");
    const idx = text.indexOf(CARET_SENTINEL);
    editor.focus({ preventScroll: true });
    setCaretAtNode(marker, idx >= 0 ? idx + CARET_SENTINEL.length : text.length);
    return true;
}

function insertDialogueBlockAtSelection(node, editor) {
    const sel = window.getSelection?.();
    if (!sel || !sel.rangeCount || !editor) return false;
    const range = sel.getRangeAt(0);
    if (!editor.contains(range.commonAncestorContainer)) return false;
    if (dialogueBlockAtSelection(editor)) return false;
    range.deleteContents();
    const before = makeCaretSentinel();
    const block = makeDialogueBlock("");
    const after = makeCaretSentinel();
    const frag = document.createDocumentFragment();
    frag.append(before, block, after);
    range.insertNode(frag);
    editor.focus({ preventScroll: true });
    setCaretAtDialogueContentEnd(block);
    return true;
}

function removeDialogueBlock(block) {
    if (!block?.parentNode) return false;
    const parent = block.parentNode;
    const before = block.previousSibling;
    const after = block.nextSibling;
    let marker = isCaretSentinelText(before) ? before : null;
    if (!marker) {
        marker = makeCaretSentinel();
        parent.insertBefore(marker, block);
    }
    block.remove();
    if (after !== marker && isOnlyCaretSentinelText(after)) after.remove();
    setCaretAtNode(marker, marker.textContent.length);
    return true;
}

function convertBracketsAtCaret(node, editor) {
    const sel = window.getSelection?.();
    if (!sel || !sel.rangeCount || !sel.isCollapsed) return false;
    const caret = sel.getRangeAt(0);
    const container = caret.startContainer;
    if (container.nodeType !== Node.TEXT_NODE || !editor.contains(container)) return false;
    if (container.parentElement?.closest?.(`.${DIALOGUE_CLASS}`)) return false;
    const textBefore = container.textContent.slice(0, caret.startOffset);
    const match = textBefore.match(/【([^】]*)】$/);
    if (!match) return false;
    const content = match[1];
    const startOffset = caret.startOffset - match[0].length;
    container.deleteData(startOffset, match[0].length);
    const range = document.createRange();
    range.setStart(container, startOffset);
    range.collapse(true);
    const before = makeCaretSentinel();
    const block = makeDialogueBlock(content);
    const after = makeCaretSentinel();
    const frag = document.createDocumentFragment();
    frag.append(before, block, after);
    range.insertNode(frag);
    setCaretAtNode(after, after.textContent.length);
    refreshEditorDecorations(editor);
    syncPromptFromEditor(node);
    pushPromptHistory(node);
    return true;
}

function convertLooseBrackets(node, editor) {
    const sel = window.getSelection?.();
    if (!sel || !sel.rangeCount || !sel.isCollapsed) return;
    const caret = sel.getRangeAt(0);
    const container = caret.startContainer;
    if (container.nodeType !== Node.TEXT_NODE || !editor.contains(container)) return;
    const insideDialogue = container.parentElement?.closest?.(`.${DIALOGUE_CLASS}`);
    const before = container.textContent.slice(0, caret.startOffset);
    if (insideDialogue && before.endsWith("】")) {
        container.deleteData(caret.startOffset - 1, 1);
        exitDialogueBlock(node, editor, insideDialogue);
        syncPromptFromEditor(node);
    }
}

/* ================================================================
切镜块
================================================================ */
/* 切镜块的显示文本 = 最终输出文本：[Shot 2] At 00:02.00,
   序号与 buildRuntimePrompt 的规则完全一致：第 k 个切镜 → [Shot k+1]。
   末尾逗号是 h3 格式里时间戳与后续描述的固定分隔符，一并显示，
   这样框选复制出来的文本与真正发给后端的文本逐字相同。 */
function shotChipText(shotIndex, seconds) {
    return `[Shot ${shotIndex}] At ${formatShotTimestamp(seconds)},`;
}

function makeShotChip(secondsValue) {
    const seconds = Number(secondsValue) || 0;
    const chip = document.createElement("span");
    chip.className = SHOT_CHIP_CLASS;
    chip.contentEditable = "false";
    chip.dataset.seconds = String(seconds);
    chip.dataset.token = `切镜${seconds}`;
    const label = document.createElement("span");
    label.className = SHOT_LABEL_CLASS;
    label.textContent = shotChipText(2, seconds);
    chip.append(label);
    chip.title = `切镜 ${seconds} 秒 → ${shotChipText(2, seconds)}`;
    chip.addEventListener("pointerdown", (event) => {
        event.preventDefault();
        event.stopPropagation();
        const sel = window.getSelection?.();
        if (!sel) return;
        const range = document.createRange();
        const rect = chip.getBoundingClientRect();
        const before = event.clientX < rect.left + rect.width / 2;
        if (before) range.setStartBefore(chip);
        else range.setStartAfter(chip);
        range.collapse(true);
        sel.removeAllRanges();
        sel.addRange(range);
    });
    return chip;
}

function getShotTriggerRange(editor) {
    const sel = window.getSelection?.();
    if (!sel || !sel.rangeCount || !sel.isCollapsed) return null;
    const caret = sel.getRangeAt(0);
    const container = caret.startContainer;
    if (container.nodeType !== Node.TEXT_NODE || !editor.contains(container)) return null;
    if (container.parentElement?.closest?.(`.${DIALOGUE_CLASS}`)) return null;
    const before = container.textContent.slice(0, caret.startOffset);
    const match = before.match(SHOT_TRIGGER_RE);
    if (!match) return null;
    const range = document.createRange();
    range.setStart(container, caret.startOffset - match[0].length);
    range.setEnd(container, caret.startOffset);
    return { range, seconds: Number(match[1]) };
}

function validateShotChips(editor) {
    const chips = editor?.querySelectorAll?.(`.${SHOT_CHIP_CLASS}`) || [];
    let previous = -Infinity;
    let shotIndex = 1;
    for (const chip of chips) {
        shotIndex += 1;
        const seconds = Number(chip.dataset.seconds);
        chip.classList.toggle("is-warning", Number.isFinite(seconds) && seconds <= previous);
        if (Number.isFinite(seconds)) previous = seconds;
        // 显示文本与最终输出保持一致（序号按出现顺序推导）
        const text = shotChipText(shotIndex, seconds);
        const label = chip.querySelector(`.${SHOT_LABEL_CLASS}`);
        const target = label || chip;
        if (target.textContent !== text) target.textContent = text;
        chip.dataset.shotIndex = String(shotIndex);
        chip.title = `切镜 ${seconds} 秒 → ${text}`;
    }
}

/* 输入 / 增删块后立即刷新所有块的显示（不等 200ms 节流） */
function refreshEditorDecorations(editor) {
    if (!editor) return;
    validateShotChips(editor);
    refreshAllDialogueChrome(editor);
}

/* ================================================================
引用块
================================================================ */
function isMentionChip(node) {
    return (
        node?.nodeType === Node.ELEMENT_NODE &&
        (node.classList?.contains(MENTION_CHIP_CLASS) || node.classList?.contains(SHOT_CHIP_CLASS))
    );
}

/* 引用块的显示文本 = 最终输出文本：<Picture 1> / <Video 1> / <Audio 1> */
function mentionTagText(option) {
    const prefix = MENTION_TAG_MAP[option?.type] || "Picture";
    const ordinal = Number(option?.ordinal) || 0;
    return `<${prefix} ${ordinal}>`;
}

function makeMentionChip(option) {
    const chip = document.createElement("span");
    chip.className = MENTION_CHIP_CLASS;
    chip.contentEditable = "false";
    chip.dataset.token = option.token || option.tag || "";
    chip.dataset.label = option.label || "";
    chip.dataset.ordinal = String(option.ordinal || "");
    chip.dataset.mediaType = option.type || "image";
    const text = mentionTagText(option);
    const label = document.createElement("span");
    label.className = "mmr-mention-chip-label";
    label.textContent = text;
    chip.append(label);
    // 悬停提示保留原始输入形式，便于对照是第几张参考图
    chip.title = option.label ? `${text}  ←  ${option.token || option.label}` : text;
    chip.addEventListener("pointerdown", (event) => {
        event.preventDefault();
        event.stopPropagation();
        const sel = window.getSelection?.();
        if (!sel) return;
        const range = document.createRange();
        const rect = chip.getBoundingClientRect();
        const before = event.clientX < rect.left + rect.width / 2;
        if (before) range.setStartBefore(chip);
        else range.setStartAfter(chip);
        range.collapse(true);
        sel.removeAllRanges();
        sel.addRange(range);
    });
    return chip;
}

function convertMentionAtCaret(node, editor) {
    const sel = window.getSelection?.();
    if (!sel || !sel.rangeCount || !sel.isCollapsed) return false;
    const caret = sel.getRangeAt(0);
    const container = caret.startContainer;
    if (container.nodeType !== Node.TEXT_NODE || !editor.contains(container)) return false;
    if (container.parentElement?.closest?.(`.${DIALOGUE_CLASS}`)) return false;
    const textBefore = container.textContent.slice(0, caret.startOffset);
    const match = textBefore.match(MENTION_TRIGGER_RE);
    if (!match) return false;
    const type = MENTION_TYPE_MAP[match[1]];
    const ordinal = parseInt(match[2], 10);
    const tag = `<${MENTION_TAG_MAP[type]} ${ordinal}>`;
    const token = `@${match[1]}${match[2]}`;
    const startOffset = caret.startOffset - match[0].length;
    const media = getConnectedMedia(node);
    const matched = media[type]?.find(item => item.ordinal === ordinal);
    container.deleteData(startOffset, match[0].length);
    const range = document.createRange();
    range.setStart(container, startOffset);
    range.collapse(true);
    const before = makeCaretSentinel();
    const chip = makeMentionChip({
        type,
        ordinal,
        tag,
        token,
        label: `${match[1]}${match[2]}`,
        sourceNode: matched?.sourceNode,
        previewUrl: matched?.previewUrl,
    });
    const after = makeCaretSentinel();
    const frag = document.createDocumentFragment();
    frag.append(before, chip, after);
    range.insertNode(frag);
    setCaretAtNode(after, after.textContent.length);
    refreshEditorDecorations(editor);
    syncPromptFromEditor(node);
    pushPromptHistory(node);
    return true;
}

/* ================================================================
@ 提及选择菜单
================================================================ */
function getMentionRange(editor) {
    const sel = window.getSelection?.();
    if (!sel || !sel.rangeCount || !sel.isCollapsed) return null;
    const caret = sel.getRangeAt(0);
    if (!editor.contains(caret.startContainer)) return null;
    if (caret.startContainer.parentElement?.closest?.(`.${DIALOGUE_CLASS}`)) return null;
    if (caret.startContainer.parentElement?.closest?.(`.${MENTION_CHIP_CLASS}`)) return null;
    const container = caret.startContainer;
    if (container.nodeType !== Node.TEXT_NODE) return null;
    const before = container.textContent.slice(0, caret.startOffset);
    const match = before.match(/@([^@\n]*)$/);
    if (!match) return null;
    const range = document.createRange();
    range.setStart(container, caret.startOffset - match[0].length);
    range.setEnd(container, caret.startOffset);
    return { range, query: match[1].toLowerCase() };
}

function closeMentionMenu() {
    activeMentionMenu?.element?.remove();
    activeMentionMenu = null;
}

function updateMenuActiveState(menu) {
    const items = menu.element.querySelectorAll(`.${MENTION_MENU_ITEM_CLASS}`);
    items.forEach((el, i) => el.classList.toggle("is-active", i === menu.activeIndex));
    items[menu.activeIndex]?.scrollIntoView?.({ block: "nearest" });
}

function renderMentionMenu(menu, options) {
    const { element } = menu;
    element.textContent = "";
    if (!options.length) {
        const empty = document.createElement("div");
        empty.className = "mmr-mention-menu-empty";
        empty.textContent = "暂无已连接素材";
        element.append(empty);
        return;
    }
    options.forEach((item, index) => {
        const el = document.createElement("div");
        el.className = `${MENTION_MENU_ITEM_CLASS} ${index === menu.activeIndex ? "is-active" : ""}`;
        const icon = document.createElement("span");
        icon.className = "mmr-mention-menu-icon mmr-menu-thumb";
        const preview = item.previewUrl || getMediaPreview(item.sourceNode, item.type);
        if (preview && item.type !== "audio") {
            const img = document.createElement("img");
            img.src = preview;
            img.alt = "";
            icon.append(img);
        } else {
            icon.textContent = MENTION_ICON_MAP[item.type] || "🖼";
        }
        const text = document.createElement("span");
        text.className = "mmr-mention-menu-text";
        text.textContent = item.label;
        el.append(icon, text);
        el.addEventListener("pointerdown", (e) => {
            e.preventDefault();
            e.stopPropagation();
            insertMentionFromMenu(item);
        });
        el.addEventListener("pointerenter", () => {
            menu.activeIndex = index;
            updateMenuActiveState(menu);
        });
        element.append(el);
    });
}

function positionMentionMenu(element, editor) {
    const sel = window.getSelection?.();
    const caretRect = sel?.rangeCount ? sel.getRangeAt(0).getBoundingClientRect() : null;
    const editorRect = editor.getBoundingClientRect();
    const rect = caretRect && (caretRect.width || caretRect.height) ? caretRect : editorRect;
    element.style.visibility = "hidden";
    element.style.display = "block";
    const menuW = element.offsetWidth || 220;
    const menuH = Math.min(300, element.offsetHeight);
    let left = rect.left;
    let top = rect.bottom + 4;
    if (left + menuW > window.innerWidth - 8) left = window.innerWidth - menuW - 8;
    if (top + menuH > window.innerHeight - 8) top = Math.max(8, rect.top - menuH - 4);
    element.style.left = `${Math.max(8, left)}px`;
    element.style.top = `${Math.max(8, top)}px`;
    element.style.visibility = "visible";
}

function openOrUpdateMentionMenu(node, editor) {
    const mention = getMentionRange(editor);
    if (!mention) {
        closeMentionMenu();
        return false;
    }
    const media = getConnectedMedia(node);
    const allOptions = [...media.image, ...media.video, ...media.audio];
    const filtered = allOptions.filter(opt =>
        !mention.query || opt.label.toLowerCase().includes(mention.query)
    );
    if (!filtered.length) {
        closeMentionMenu();
        return false;
    }
    if (!activeMentionMenu) {
        const element = document.createElement("div");
        element.className = MENTION_MENU_CLASS;
        document.body.append(element);
        activeMentionMenu = { element, node, editor, activeIndex: 0, options: filtered };
    }
    activeMentionMenu.options = filtered;
    activeMentionMenu.activeIndex = Math.min(activeMentionMenu.activeIndex, filtered.length - 1);
    renderMentionMenu(activeMentionMenu, filtered);
    requestAnimationFrame(() => {
        if (activeMentionMenu) positionMentionMenu(activeMentionMenu.element, editor);
    });
    return true;
}

function insertMentionFromMenu(option) {
    if (!activeMentionMenu) return;
    const { node, editor } = activeMentionMenu;
    const mention = getMentionRange(editor);
    if (!mention) return;
    mention.range.deleteContents();
    const before = makeCaretSentinel();
    const chip = makeMentionChip(option);
    const after = makeCaretSentinel();
    const frag = document.createDocumentFragment();
    frag.append(before, chip, after);
    mention.range.insertNode(frag);
    setCaretAtNode(after, after.textContent.length);
    closeMentionMenu();
    syncPromptFromEditor(node);
    pushPromptHistory(node);
    editor.focus();
}

function handleMentionMenuKeydown(node, editor, event) {
    if (!activeMentionMenu || activeMentionMenu.node !== node) return false;
    const menu = activeMentionMenu;
    if (event.key === "Escape") {
        closeMentionMenu();
        return true;
    }
    if (event.key === "ArrowDown") {
        menu.activeIndex = (menu.activeIndex + 1) % menu.options.length;
        updateMenuActiveState(menu);
        return true;
    }
    if (event.key === "ArrowUp") {
        menu.activeIndex = (menu.activeIndex - 1 + menu.options.length) % menu.options.length;
        updateMenuActiveState(menu);
        return true;
    }
    if (event.key === "Enter" || event.key === "Tab") {
        const option = menu.options[menu.activeIndex];
        if (option) insertMentionFromMenu(option);
        return Boolean(option);
    }
    return false;
}

/* ================================================================
序列化 / 反序列化
================================================================ */
function serializeEditorDoc(editor) {
    const parts = [];
    const pushText = (text) => {
        const value = String(text ?? "").replaceAll(CARET_SENTINEL, "");
        if (!value) return;
        const last = parts.length ? parts[parts.length - 1] : null;
        if (last?.type === "text") last.text += value;
        else parts.push({ type: "text", text: value });
    };
    const visit = (item) => {
        if (!item) return;
        if (item.nodeType === Node.TEXT_NODE) {
            pushText(item.textContent);
            return;
        }
        if (item.nodeType !== Node.ELEMENT_NODE) return;
        if (isDialogueBlock(item)) {
            parts.push({ type: "dialogue", text: dialogueBlockText(item) });
            return;
        }
        if (item.classList?.contains(SHOT_CHIP_CLASS)) {
            parts.push({ type: "shot", seconds: Number(item.dataset.seconds) || 0 });
            return;
        }
        if (item.classList?.contains(MENTION_CHIP_CLASS)) {
            parts.push({
                type: "mention",
                token: item.dataset.token || "",
                label: item.dataset.label || "",
                ordinal: Number(item.dataset.ordinal) || null,
                mediaType: item.dataset.mediaType || "image",
            });
            return;
        }
        if (item.tagName === "BR") {
            pushText("\n");
            return;
        }
        const block = ["DIV", "P"].includes(item.tagName);
        const last = parts.length ? parts[parts.length - 1] : null;
        if (block && parts.length && !(last?.type === "text" && last.text.endsWith("\n"))) {
            pushText("\n");
        }
        for (const child of item.childNodes || []) visit(child);
    };
    for (const child of editor.childNodes || []) visit(child);
    return {
        version: 1,
        // text 直接等于「最终发给后端的提示词」，保证前台显示 / 复制 / 输出三者一致
        text: postProcessPromptText(partsToRuntimeText(parts)),
        parts,
    };
}

/* 把编辑器解析出的 parts 还原成最终提示词文本。
   buildRuntimePrompt（真正发给后端）与 serializeEditorDoc（前台保存/显示）共用同一份逻辑，
   这是「前台显示 = 实际输出」的保证。 */
function partsToRuntimeText(parts) {
    let shotIndex = 1;
    const emitShot = (seconds) => {
        shotIndex += 1;
        return `[Shot ${shotIndex}] At ${formatShotTimestamp(seconds)},`;
    };
    return (Array.isArray(parts) ? parts : []).map((part) => {
        if (part?.type === "dialogue") return wrapDialogueTag(part.text);
        if (part?.type === "shot") return emitShot(Number(part.seconds) || 0);
        if (part?.type === "mention") {
            const prefix = MENTION_TAG_MAP[part.mediaType] || "Picture";
            return `<${prefix} ${Number(part.ordinal) || 0}>`;
        }
        return String(part?.text || "").replace(FALLBACK_SHOT_RE, (m, s) => emitShot(Number(s)));
    }).join("");
}

function appendDialogueBlock(container, value = "") {
    container.append(makeCaretSentinel(), makeDialogueBlock(value), makeCaretSentinel());
}

/* 把一段「最终提示词文本」反解析成彩色块。
   既认新格式（<Picture 1> / <d>…</d> / [Shot 2] At 00:02.00），
   也认旧格式（@图片1 / 【…】 / 切镜2），保证粘贴与老工作流都能还原成彩色块。 */
function appendPromptTextWithBlocks(container, value) {
    const source = String(value || "");
    const re = new RegExp(INLINE_TOKEN_RE.source, "gi");
    let cursor = 0;
    let match;
    while ((match = re.exec(source))) {
        if (match.index > cursor) {
            appendTextWithBreaks(container, source.slice(cursor, match.index));
        }
        const full = match[0];
        const [, dialogue, tagName, tagOrdinal, shotNo, shotMin, shotSec,
            legacyShot, legacyDialogue, cnType, cnOrdinal] = match;
        if (dialogue !== undefined) {
            appendDialogueBlock(container, dialogue);
        } else if (tagName !== undefined) {
            const type = MENTION_TAG_TO_TYPE[String(tagName).toLowerCase()] || "image";
            const ordinal = parseInt(tagOrdinal, 10);
            container.append(makeCaretSentinel(), makeMentionChip({
                type,
                ordinal,
                token: `@${MENTION_LABEL_MAP[type]}${ordinal}`,
                label: `${MENTION_LABEL_MAP[type]}${ordinal}`,
            }), makeCaretSentinel());
        } else if (shotNo !== undefined) {
            const seconds = Number(shotMin) * 60 + Number(shotSec);
            container.append(makeCaretSentinel(), makeShotChip(seconds), makeCaretSentinel());
        } else if (legacyShot !== undefined) {
            container.append(makeCaretSentinel(), makeShotChip(Number(legacyShot)), makeCaretSentinel());
        } else if (legacyDialogue !== undefined) {
            appendDialogueBlock(container, legacyDialogue);
        } else if (cnType !== undefined) {
            const type = MENTION_TYPE_MAP[cnType] || "image";
            const ordinal = parseInt(cnOrdinal, 10);
            container.append(makeCaretSentinel(), makeMentionChip({
                type,
                ordinal,
                token: `@${cnType}${cnOrdinal}`,
                label: `${cnType}${cnOrdinal}`,
            }), makeCaretSentinel());
        }
        cursor = match.index + full.length;
        if (!full.length) re.lastIndex += 1; // 防御空匹配死循环
    }
    appendTextWithBreaks(container, source.slice(cursor));
}

function renderEditorFromNode(node, force = false) {
    const editor = node?.__mmrEditor;
    const widget = getWidget(node, "prompt");
    if (!editor || !widget || (document.activeElement === editor && !force)) return;
    const doc = node.properties?.[PROMPT_DOC_PROP];
    editor.textContent = "";
    if (!Array.isArray(doc?.parts)) {
        appendPromptTextWithBlocks(editor, String(widget.value || ""));
        refreshEditorDecorations(editor);
        return;
    }
    // 预先获取媒体列表（含上传参考图缩略图 URL 与外部连线源节点），
    // 用于在重建 chip 时恢复缩略图（否则刷新后缩略图会丢失变成 emoji）。
    const media = getConnectedMedia(node);
    for (const part of doc.parts) {
        if (part?.type === "dialogue") {
            appendDialogueBlock(editor, String(part.text || ""));
            continue;
        }
        if (part?.type === "shot") {
            editor.append(makeCaretSentinel(), makeShotChip(Number(part.seconds) || 0), makeCaretSentinel());
            continue;
        }
        if (part?.type === "mention") {
            const mediaType = part.mediaType || "image";
            const ordinal = Number(part.ordinal);
            const matched = media[mediaType]?.find(item => item.ordinal === ordinal);
            editor.append(makeCaretSentinel(), makeMentionChip({
                type: mediaType,
                ordinal,
                tag: part.token || "",
                token: part.token || "",
                label: part.label || "",
                sourceNode: matched?.sourceNode,
                previewUrl: matched?.previewUrl,
            }), makeCaretSentinel());
            continue;
        }
        appendTextWithBreaks(editor, part?.text || "");
    }
    refreshEditorDecorations(editor);
}

// 延迟刷新缩略图：刷新页面后源节点（图片序列/视频）的 imgs 是异步加载的，
// 首次渲染时可能还没就绪。分多档延迟重渲染，等 imgs 加载完后恢复第一帧缩略图。
function scheduleThumbnailRefresh(node, delays = [250, 800, 1600]) {
    if (!node || node.__mmrRemoved) return;
    for (const delay of delays) {
        setTimeout(() => {
            if (node.__mmrRemoved) return;
            if (document.activeElement === node.__mmrEditor) return;
            renderEditorFromNode(node, true);
        }, delay);
    }
}

function syncPromptFromEditor(node, markDirty = true) {
    const editor = node?.__mmrEditor;
    const widget = getWidget(node, "prompt");
    if (!editor || !widget || node.__mmrEditorSyncing) return;
    if (syncThrottleMap.has(node)) {
        clearTimeout(syncThrottleMap.get(node));
    }
    const timer = setTimeout(() => {
        if (!node || node.__mmrRemoved) return;
        node.__mmrEditorSyncing = true;
        try {
            const doc = serializeEditorDoc(editor);
            widget.value = doc.text;
            if (widget._state) widget._state.value = doc.text;
            node.properties ||= {};
            node.properties[PROMPT_DOC_PROP] = doc;
            refreshEditorDecorations(editor);
            if (markDirty) {
                node.setDirtyCanvas?.(true, false);
                app.graph?.setDirtyCanvas?.(true, false);
                app.graph?.change?.();
            }
        } finally {
            node.__mmrEditorSyncing = false;
            syncThrottleMap.delete(node);
        }
    }, 200);
    syncThrottleMap.set(node, timer);
}

function syncPromptFromEditorImmediate(node, markDirty = true) {
    const editor = node?.__mmrEditor;
    const widget = getWidget(node, "prompt");
    if (!editor || !widget) return;
    node.__mmrEditorSyncing = true;
    try {
        const doc = serializeEditorDoc(editor);
        widget.value = doc.text;
        if (widget._state) widget._state.value = doc.text;
        node.properties ||= {};
        node.properties[PROMPT_DOC_PROP] = doc;
        refreshEditorDecorations(editor);
        if (markDirty) {
            node.setDirtyCanvas?.(true, false);
            app.graph?.setDirtyCanvas?.(true, false);
        }
    } finally {
        node.__mmrEditorSyncing = false;
    }
}

/* ================================================================
buildRuntimePrompt
================================================================ */
function buildRuntimePrompt(node) {
    const promptWidget = getWidget(node, "prompt");
    const fallback = String(promptWidget?.value || "");
    const doc = node?.properties?.[PROMPT_DOC_PROP];
    if (!Array.isArray(doc?.parts)) return postProcessPromptText(fallback);
    // 与前台显示共用 partsToRuntimeText —— 看到什么就发什么
    return postProcessPromptText(partsToRuntimeText(doc.parts));
}

/* ================================================================
撤销 / 重做
================================================================ */
function clonePromptDoc(doc) {
    const source = doc && typeof doc === "object" ? doc : {};
    return {
        version: 1,
        text: String(source.text || ""),
        parts: Array.isArray(source.parts) ? source.parts.map((p) => ({ ...p })) : [],
    };
}

function promptDocKey(doc) {
    return JSON.stringify(clonePromptDoc(doc));
}

function ensurePromptHistory(node) {
    const editor = node?.__mmrEditor;
    if (!editor) return null;
    if (node.__mmrPromptHistory) return node.__mmrPromptHistory;
    const doc = clonePromptDoc(serializeEditorDoc(editor));
    node.__mmrPromptHistory = {
        undo: [{ doc }],
        redo: [],
        lastKey: promptDocKey(doc),
        applying: false,
    };
    return node.__mmrPromptHistory;
}

function resetPromptHistory(node) {
    node.__mmrPromptHistory = null;
    ensurePromptHistory(node);
}

function pushPromptHistory(node) {
    const history = ensurePromptHistory(node);
    const editor = node?.__mmrEditor;
    if (!history || !editor || history.applying) return;
    const doc = clonePromptDoc(serializeEditorDoc(editor));
    const key = promptDocKey(doc);
    if (key === history.lastKey) return;
    history.undo.push({ doc });
    if (history.undo.length > PROMPT_HISTORY_LIMIT) history.undo.shift();
    history.redo = [];
    history.lastKey = key;
}

function isPromptUndoRedoEvent(event) {
    if (!(event?.ctrlKey || event?.metaKey)) return false;
    const key = String(event.key || "").toLowerCase();
    const code = String(event.code || "");
    return key === "z" || key === "y" || code === "KeyZ" || code === "KeyY";
}

function setEditorCaretAtEnd(editor) {
    if (!editor) return;
    const sel = window.getSelection?.();
    if (!sel) return;
    const range = document.createRange();
    range.selectNodeContents(editor);
    range.collapse(false);
    sel.removeAllRanges();
    sel.addRange(range);
}

function applyPromptHistoryEntry(node, entry) {
    const history = node?.__mmrPromptHistory;
    const editor = node?.__mmrEditor;
    const widget = getWidget(node, "prompt");
    if (!history || !editor || !entry?.doc || !widget) return false;
    history.applying = true;
    try {
        const doc = clonePromptDoc(entry.doc);
        node.properties ||= {};
        node.properties[PROMPT_DOC_PROP] = doc;
        widget.value = doc.text;
        if (widget._state) widget._state.value = doc.text;
        renderEditorFromNode(node, true);
        syncPromptFromEditorImmediate(node, false);
        history.lastKey = promptDocKey(doc);
    } finally {
        history.applying = false;
    }
    closeMentionMenu();
    editor.focus();
    setEditorCaretAtEnd(editor);
    return true;
}

function handlePromptHistoryKeydown(node, event) {
    if (!isPromptUndoRedoEvent(event)) return false;
    event.preventDefault?.();
    event.stopPropagation?.();
    event.stopImmediatePropagation?.();
    const history = ensurePromptHistory(node);
    if (!history) return true;
    const key = String(event.key || "").toLowerCase();
    const isRedo = key === "y" || String(event.code || "") === "KeyY" || (key === "z" && event.shiftKey);
    if (isRedo) {
        const entry = history.redo.pop();
        if (!entry) return true;
        history.undo.push(entry);
        applyPromptHistoryEntry(node, entry);
        return true;
    }
    if (history.undo.length <= 1) return true;
    const current = history.undo.pop();
    if (current) history.redo.push(current);
    applyPromptHistoryEntry(node, history.undo[history.undo.length - 1]);
    return true;
}

/* ================================================================
粘贴处理
================================================================ */
function appendPastedText(fragment, text) {
    String(text || "").split("\n").forEach((part, i) => {
        if (i) fragment.append(document.createElement("br"));
        if (part) fragment.append(document.createTextNode(part));
    });
}

function insertTextWithMentionChips(node, editor, text) {
    const sel = window.getSelection?.();
    if (!sel || !sel.rangeCount || !editor.contains(sel.anchorNode)) return false;
    const range = sel.getRangeAt(0);
    const value = String(text || "");
    if (!value) return false;
    range.deleteContents();
    const fragment = document.createDocumentFragment();
    // 与 appendPromptTextWithBlocks 同一套识别规则：
    // 新格式 <Picture 1> / <d>…</d> / [Shot 2] At 00:02.00，旧格式 @图片1 / 【…】 / 切镜2
    const re = new RegExp(INLINE_TOKEN_RE.source, "gi");
    let lastIndex = 0;
    let match;
    while ((match = re.exec(value))) {
        if (match.index > lastIndex) {
            appendPastedText(fragment, value.slice(lastIndex, match.index));
        }
        const full = match[0];
        const [, dialogue, tagName, tagOrdinal, shotNo, shotMin, shotSec,
            legacyShot, legacyDialogue, cnType, cnOrdinal] = match;
        fragment.append(document.createTextNode(CARET_SENTINEL));
        if (dialogue !== undefined) {
            fragment.append(makeDialogueBlock(dialogue));
        } else if (tagName !== undefined) {
            const type = MENTION_TAG_TO_TYPE[String(tagName).toLowerCase()] || "image";
            const ordinal = parseInt(tagOrdinal, 10);
            fragment.append(makeMentionChip({
                type,
                ordinal,
                token: `@${MENTION_LABEL_MAP[type]}${ordinal}`,
                label: `${MENTION_LABEL_MAP[type]}${ordinal}`,
            }));
        } else if (shotNo !== undefined) {
            fragment.append(makeShotChip(Number(shotMin) * 60 + Number(shotSec)));
        } else if (legacyShot !== undefined) {
            fragment.append(makeShotChip(Number(legacyShot)));
        } else if (legacyDialogue !== undefined) {
            fragment.append(makeDialogueBlock(legacyDialogue));
        } else if (cnType !== undefined) {
            const type = MENTION_TYPE_MAP[cnType] || "image";
            const ordinal = parseInt(cnOrdinal, 10);
            fragment.append(makeMentionChip({
                type,
                ordinal,
                token: `@${cnType}${cnOrdinal}`,
                label: `${cnType}${cnOrdinal}`,
            }));
        }
        fragment.append(document.createTextNode(CARET_SENTINEL));
        lastIndex = match.index + full.length;
        if (!full.length) re.lastIndex += 1;
    }
    if (lastIndex < value.length) {
        appendPastedText(fragment, value.slice(lastIndex));
    }
    const caretMarker = document.createTextNode(CARET_SENTINEL);
    fragment.append(caretMarker);
    range.insertNode(fragment);
    const caret = document.createRange();
    caret.setStart(caretMarker, caretMarker.textContent.length);
    caret.collapse(true);
    sel.removeAllRanges();
    sel.addRange(caret);
    refreshEditorDecorations(editor);
    return true;
}

/* ================================================================
删除处理
================================================================ */
function removeChip(chip, direction = "backward") {
    if (!chip?.parentNode) return null;
    const marker = makeCaretSentinel();
    chip.parentNode.insertBefore(marker, direction === "backward" ? chip : chip.nextSibling);
    chip.remove();
    return marker;
}

function deleteChipNearCaret(editor, node, direction) {
    const sel = window.getSelection?.();
    if (!sel || !sel.rangeCount || !sel.isCollapsed) return false;
    const range = sel.getRangeAt(0);
    const editorNode = range.startContainer;
    if (!editor.contains(editorNode)) return false;
    const directChip =
        editorNode.nodeType === Node.ELEMENT_NODE
            ? editorNode.closest?.(CHIP_SELECTOR)
            : editorNode.parentElement?.closest?.(CHIP_SELECTOR);
    if (directChip && editor.contains(directChip)) {
        const marker = removeChip(directChip, direction);
        setCaretAtNode(marker, marker.textContent.length);
        return true;
    }
    return false;
}

function backspaceDialogueBoundary(editor, node) {
    const sel = window.getSelection?.();
    if (!sel || !sel.rangeCount || !sel.isCollapsed) return false;
    const activeBlock = dialogueBlockAtSelection(editor);
    if (activeBlock) {
        if (!dialogueBlockText(activeBlock)) {
            const removed = removeDialogueBlock(activeBlock);
            return removed;
        }
        return false;
    }
    return false;
}

/* ================================================================
Widget / Node 尺寸持久化
================================================================ */
function cloneWidgetValue(value) {
    if (value == null) return value;
    const t = typeof value;
    if (t === "number" || t === "string" || t === "boolean") return value;
    if (t !== "object") return undefined;
    try {
        return JSON.parse(JSON.stringify(value));
    } catch {
        return undefined;
    }
}

function captureWidgetState(node) {
    if (!node) return;
    node.properties ||= {};
    const values = {};
    for (const w of node.widgets || []) {
        if (!w || !w.name) continue;
        if (w.name === "mmr_prompt_editor") continue;
        if (w.name === "ref_image_files") continue;
        if (w.serialize === false) continue;
        const v = cloneWidgetValue(w.value);
        if (typeof v !== "undefined") values[w.name] = v;
    }
    node.properties[WIDGET_STATE_PROP] = values;
}

function restoreWidgetState(node, stateArg = null) {
    const state = stateArg || node?.properties?.[WIDGET_STATE_PROP];
    if (!node || !state || typeof state !== "object") return false;
    for (const w of node.widgets || []) {
        if (!w || !w.name) continue;
        if (w.name === "mmr_prompt_editor") continue;
        if (w.name === "ref_image_files") continue;
        if (!(w.name in state)) continue;
        const value = cloneWidgetValue(state[w.name]);
        if (typeof value === "undefined") continue;
        try {
            w.value = value;
            if (w._state) w._state.value = value;
        } catch {
            // ignore
        }
    }
    node.setDirtyCanvas?.(true, false);
    return true;
}

function instrumentWidgets(node) {
    if (!node?.widgets) return;
    for (const w of node.widgets || []) {
        if (!w || !w.name) continue;
        if (w.name === "mmr_prompt_editor") continue;
        if (w.name === "ref_image_files") continue;
        if (w.__mmrInstrumented) continue;
        w.__mmrInstrumented = true;
        const originalCallback = w.callback;
        w.callback = function (...args) {
            const result = originalCallback?.apply(this, args);
            setTimeout(() => {
                try {
                    captureWidgetState(node);
                    node.setDirtyCanvas?.(true, false);
                } catch { /* ignore */ }
            }, 0);
            return result;
        };
    }
}

function applyNodeDataDefaults(nodeData) {
    try {
        const required = nodeData?.input?.required;
        if (!required) return;
        const setDefault = (name, value) => {
            const item = required[name];
            if (Array.isArray(item) && item[1] && typeof item[1] === "object") {
                item[1].default = value;
                return;
            }
            if (item && typeof item === "object" && !Array.isArray(item)) {
                item.default = value;
            }
        };
        setDefault("width", DEFAULT_WIDGET_VALUES.width);
        setDefault("height", DEFAULT_WIDGET_VALUES.height);
        setDefault("length", DEFAULT_WIDGET_VALUES.length);
        setDefault("ref_max_size", DEFAULT_WIDGET_VALUES.ref_max_size);
    } catch { /* ignore */ }
}

/* ================================================================
隐藏 ref_image_files 控件和端口
================================================================ */
function hideRefImageFilesWidget(node) {
    const w = getWidget(node, "ref_image_files");
    if (w && !w.__mmrHidden) {
        w.__mmrHidden = true;
        w.hidden = true;
        w.computeSize = () => [0, -4];
        setWidgetOption(w, "hidden", true);
        setWidgetOption(w, "canvasOnly", true);
        // 不设置 serialize=false，确保 widget 值仍能被 ComfyUI 包含在 prompt 中
        if (w.inputEl) w.inputEl.style.cssText += "display:none;";
        if (w.element) w.element.style.cssText += "display:none;";
    }
    const idx = node.inputs?.findIndex(inp => inp.name === "ref_image_files");
    if (idx != null && idx >= 0) {
        node.removeInput(idx);
    }
}

function showRefImageFilesWidget(widget) {
    if (!widget?.__mmrHidden) return;
    widget.hidden = false;
    setWidgetOption(widget, "hidden", false);
    setWidgetOption(widget, "canvasOnly", false);
    widget.__mmrHidden = false;
}

/* ================================================================
编辑器创建
================================================================ */
/* 框选复制时剔除零宽哨兵符（光标定位用的不可见字符），
   保证从节点里直接 Ctrl+C 拿到的就是可复用的干净提示词。 */
function handleEditorCopy(editor, event) {
    const sel = window.getSelection?.();
    if (!sel || sel.isCollapsed || !sel.rangeCount) return false;
    // 注意：整段框选时 anchorNode 就是 editor 本身，而 contains() 不含自身
    const inEditor = (n) => n === editor || Boolean(editor.contains?.(n));
    if (!inEditor(sel.anchorNode) && !inEditor(sel.focusNode)) return false;
    const text = stripCaretSentinels(sel.toString());
    try {
        event.clipboardData?.setData("text/plain", text);
        event.preventDefault();
        return true;
    } catch {
        return false; // 无法写剪贴板时退回浏览器默认行为
    }
}

function hideOriginalPromptWidget(widget) {
    if (!widget) return;
    if (!widget.__mmrPromptHidden) {
        widget.__mmrPromptHidden = true;
        widget.__mmrOriginalType = widget.type;
        widget.__mmrOriginalComputeSize = widget.computeSize;
    }
    widget.hidden = true;
    setWidgetOption(widget, "hidden", true);
    setWidgetOption(widget, "canvasOnly", true);
    widget.type = "text";
    widget.computeSize = () => [0, -4];
    if (widget.inputEl) widget.inputEl.style.cssText += "display:none;";
    if (widget.element) widget.element.style.cssText += "display:none;";
}

function restoreOriginalPromptWidget(widget) {
    if (!widget?.__mmrPromptHidden) return;
    widget.type = widget.__mmrOriginalType || "text";
    widget.computeSize = widget.__mmrOriginalComputeSize || (() => [220, 120]);
    widget.hidden = false;
    setWidgetOption(widget, "hidden", false);
    setWidgetOption(widget, "canvasOnly", false);
    widget.__mmrPromptHidden = false;
}

function ensurePromptEditor(node) {
    if (node.__mmrEditor) return;
    if (typeof document === "undefined" || typeof node.addDOMWidget !== "function") return;
    const widget = getWidget(node, "prompt");
    if (!widget) {
        if (!node.__mmrEditorRetry) {
            node.__mmrEditorRetry = true;
            const timer = setTimeout(() => {
                if (node.__mmrRemoved) return;
                node.__mmrEditorRetry = false;
                ensurePromptEditor(node);
            }, 0);
            node.__mmrEditorRetryTimer = timer;
        }
        return;
    }
    hideOriginalPromptWidget(widget);
    hideRefImageFilesWidget(node);

    const wrap = document.createElement("div");
    wrap.className = "mmr-prompt-editor-wrap";
    wrap.style.minHeight = "0px";

    // --- 参考图上传区（在提示词编辑器上方） ---
    const refArea = document.createElement("div");
    refArea.className = "mmr-ref-upload-area";
    node.__mmrRefUploadArea = refArea;
    refArea.addEventListener("pointerdown", (event) => {
        event.stopPropagation();
    });
    // v6：拖到上传区空白处 → 追加到末尾（拖到具体槽位由槽位自己处理并已阻止冒泡）
    attachImageDropTarget(refArea, (files) => {
        addRefImages(node, files, null);
    });
    wrap.append(refArea);

    // --- 提示词编辑器 ---
    const editor = document.createElement("div");
    editor.className = "comfy-multiline-input mmr-prompt-editor";
    editor.contentEditable = "true";
    editor.__mmrPromptNode = node;
    editor.tabIndex = 0;
    editor.setAttribute("role", "textbox");
    editor.setAttribute("aria-label", "prompt");
    editor.dataset.placeholder = "【】台词 | 切镜3.5 | 输入 @ 选择已连接素材";
    editor.spellcheck = false;

    editor.addEventListener("beforeinput", (event) => {
        if (node.__mmrDialogueHashHandled) {
            node.__mmrDialogueHashHandled = false;
            event.preventDefault();
            event.stopPropagation();
            event.stopImmediatePropagation?.();
            return;
        }
        if (event.inputType === "insertText" && event.data === "#") {
            if (insertDialogueBlockAtSelection(node, editor)) {
                event.preventDefault();
                event.stopPropagation();
                event.stopImmediatePropagation?.();
                syncPromptFromEditor(node);
                pushPromptHistory(node);
                return;
            }
        }
        if (event.inputType === "insertText" && event.data === "】") {
            const activeBlock = dialogueBlockAtSelection(editor);
            if (activeBlock) {
                event.preventDefault();
                event.stopPropagation();
                event.stopImmediatePropagation?.();
                exitDialogueBlock(node, editor, activeBlock);
                syncPromptFromEditor(node);
                pushPromptHistory(node);
                return;
            }
        }
    });

    editor.addEventListener("input", (event) => {
        // 立即刷新切镜序号 / 台词块装饰，保证前台显示实时等于最终输出
        refreshEditorDecorations(editor);
        syncPromptFromEditor(node);
        if (event?.isComposing || event?.inputType === "insertCompositionText" || node.__mmrPromptComposing) {
            return;
        }
        convertLooseBrackets(node, editor);
        pushPromptHistory(node);
        openOrUpdateMentionMenu(node, editor);
    });

    editor.addEventListener("compositionstart", () => {
        node.__mmrPromptComposing = true;
    });

    editor.addEventListener("compositionend", () => {
        node.__mmrPromptComposing = false;
        refreshEditorDecorations(editor);
        syncPromptFromEditorImmediate(node);
        pushPromptHistory(node);
        openOrUpdateMentionMenu(node, editor);
    });

    editor.addEventListener(
        "keydown",
        (event) => {
            if (isPromptUndoRedoEvent(event)) {
                handlePromptHistoryKeydown(node, event);
            }
        },
        true
    );

    editor.addEventListener("keydown", (event) => {
        if (handleMentionMenuKeydown(node, editor, event)) {
            event.preventDefault();
            event.stopPropagation();
            return;
        }
        if ((event.key === " " || event.key === "Enter") && !node.__mmrPromptComposing) {
            if (convertBracketsAtCaret(node, editor)) {
                event.preventDefault();
                event.stopPropagation();
                return;
            }
            if (convertMentionAtCaret(node, editor)) {
                event.preventDefault();
                event.stopPropagation();
                return;
            }
        }
        if (
            (event.key === " " || event.key === "Enter") &&
            !node.__mmrPromptComposing &&
            !dialogueBlockAtSelection(editor)
        ) {
            const trigger = getShotTriggerRange(editor);
            if (trigger) {
                event.preventDefault();
                event.stopPropagation();
                trigger.range.deleteContents();
                const before = document.createTextNode(CARET_SENTINEL);
                const chip = makeShotChip(trigger.seconds);
                const after = document.createTextNode(CARET_SENTINEL);
                const frag = document.createDocumentFragment();
                frag.append(before, chip, after);
                trigger.range.insertNode(frag);
                const sel = window.getSelection?.();
                if (sel) {
                    const caret = document.createRange();
                    caret.setStart(after, after.textContent.length);
                    caret.collapse(true);
                    sel.removeAllRanges();
                    sel.addRange(caret);
                }
                if (event.key === " ") insertPlainText(editor, " ");
                else insertEditorLineBreak(editor);
                refreshEditorDecorations(editor);
                syncPromptFromEditor(node);
                pushPromptHistory(node);
                return;
            }
        }
        if (
            event.key === "#" &&
            !event.ctrlKey &&
            !event.metaKey &&
            !event.altKey &&
            insertDialogueBlockAtSelection(node, editor)
        ) {
            event.preventDefault();
            event.stopPropagation();
            node.__mmrDialogueHashHandled = true;
            setTimeout(() => { node.__mmrDialogueHashHandled = false; }, 0);
            refreshEditorDecorations(editor);
            syncPromptFromEditor(node);
            pushPromptHistory(node);
            return;
        }
        const dialogue = dialogueBlockAtSelection(editor);
        if (event.key === "Enter" && dialogue && !event.shiftKey) {
            event.preventDefault();
            event.stopPropagation();
            exitDialogueBlock(node, editor, dialogue);
            syncPromptFromEditor(node);
            pushPromptHistory(node);
            return;
        }
        if (event.key === "Enter" && dialogue && event.shiftKey && insertEditorLineBreak(editor)) {
            event.preventDefault();
            event.stopPropagation();
            syncPromptFromEditor(node);
            pushPromptHistory(node);
            return;
        }
        if (
            event.key === "Backspace" &&
            (backspaceDialogueBoundary(editor, node) || deleteChipNearCaret(editor, node, "backward"))
        ) {
            event.preventDefault();
            refreshEditorDecorations(editor);
            syncPromptFromEditor(node);
            pushPromptHistory(node);
        } else if (event.key === "Delete" && deleteChipNearCaret(editor, node, "forward")) {
            event.preventDefault();
            refreshEditorDecorations(editor);
            syncPromptFromEditor(node);
            pushPromptHistory(node);
        } else if (event.key === "Enter" && insertEditorLineBreak(editor)) {
            event.preventDefault();
            syncPromptFromEditor(node);
            pushPromptHistory(node);
        }
        event.stopPropagation();
    });

    editor.addEventListener("paste", (event) => {
        event.preventDefault();
        event.stopPropagation();
        event.stopImmediatePropagation?.();
        insertTextWithMentionChips(node, editor, event.clipboardData?.getData("text/plain") || "");
        syncPromptFromEditor(node);
        pushPromptHistory(node);
    });

    // 框选复制时把零宽哨兵符（光标定位用的不可见字符）剔除干净，
    // 保证从节点里直接 Ctrl+C 拿到的就是可复用的完整提示词。
    editor.addEventListener("copy", (event) => handleEditorCopy(editor, event));

    editor.addEventListener("blur", () => {
        syncPromptFromEditorImmediate(node);
        setTimeout(() => {
            if (!activeMentionMenu?.element?.matches?.(":hover")) closeMentionMenu();
        }, 150);
    });

    wrap.addEventListener("pointerdown", (event) => {
        event.stopPropagation();
    });

    wrap.append(editor);

    // ============ v3: prompt optimizer toolbar ( ✦ optimize, </> view original ) ============
    const optStatus = document.createElement("div");
    optStatus.className = "mmr3-opt-status";
    optStatus.style.display = "none";
    const optStatusSpinner = document.createElement("span");
    optStatusSpinner.className = "mmr3-opt-status-spinner";
    const optStatusText = document.createElement("span");
    optStatusText.className = "mmr3-opt-status-text";
    optStatus.append(optStatusSpinner, optStatusText);
    wrap.append(optStatus);

    const optTools = document.createElement("div");
    optTools.className = "mmr3-opt-tools";

    const optimizeBtn = document.createElement("button");
    optimizeBtn.type = "button";
    optimizeBtn.className = "mmr3-opt-btn mmr3-opt-optimize";
    optimizeBtn.textContent = "\u2726";
    optimizeBtn.title = "\u63d0\u793a\u8bcd\u4f18\u5316\uff08\u8c03\u7528\u672c\u5730 Ollama\uff09";
    optimizeBtn.addEventListener("pointerdown", (e) => { e.preventDefault(); e.stopPropagation(); });
    optimizeBtn.addEventListener("click", (e) => {
        e.preventDefault();
        e.stopPropagation();
        optimizePromptFromEditor(node);
    });

    const viewBtn = document.createElement("button");
    viewBtn.type = "button";
    viewBtn.className = "mmr3-opt-btn mmr3-opt-view";
    viewBtn.innerHTML = "\u25A3";
    viewBtn.title = "\u663e\u793a\u539f\u59cb\u63d0\u793a\u8bcd";
    viewBtn.addEventListener("pointerdown", (e) => { e.preventDefault(); e.stopPropagation(); });
    viewBtn.addEventListener("click", (e) => {
        e.preventDefault();
        e.stopPropagation();
        toggleOriginalView(node);
    });

    // v6: 一键复制最终提示词（与发给后端的文本逐字一致）
    const copyBtn = document.createElement("button");
    copyBtn.type = "button";
    copyBtn.className = "mmr3-opt-btn mmr6-opt-copy";
    copyBtn.textContent = "\u29C9";
    copyBtn.title = "复制最终提示词（与输出完全一致）";
    copyBtn.addEventListener("pointerdown", (e) => { e.preventDefault(); e.stopPropagation(); });
    copyBtn.addEventListener("click", (e) => {
        e.preventDefault();
        e.stopPropagation();
        copyPromptFromEditor(node);
    });

    optTools.append(optimizeBtn, viewBtn, copyBtn);
    wrap.append(optTools);

    node.__mmrOptStatus = optStatus;
    node.__mmrOptStatusText = optStatusText;
    node.__mmrOptimizeBtn = optimizeBtn;
    node.__mmrViewBtn = viewBtn;
    node.__mmrCopyBtn = copyBtn;
    node.__mmrViewOriginal = false;

    setupOptWidgetVisibility(node);

    node.__mmrEditor = editor;
    node.__mmrEditorWrap = wrap;

    renderRefUploadArea(node);
    renderEditorFromNode(node);
    resetPromptHistory(node);

    const domWidget = node.addDOMWidget("mmr_prompt_editor", "mmr_prompt_editor", wrap, {
        getValue: () => String(getWidget(node, "prompt")?.value || ""),
        setValue: (value) => {
            const promptWidget = getWidget(node, "prompt");
            if (promptWidget) promptWidget.value = String(value || "");
            renderEditorFromNode(node);
        },
        margin: 10,
        serialize: false,
        getMinHeight: () => 50,
        afterResize: () => {
            node._widgetSlotsDirty = true;
            node.setDirtyCanvas?.(true, true);
        },
        onDraw: () => {
            // 仅触发重绘，让 LiteGraph 自己同步 wrap 尺寸，不再用 !important 强制干预
            node.setDirtyCanvas?.(true, false);
        }
    });

    if (!domWidget) {
        wrap.remove();
        node.__mmrEditor = null;
        node.__mmrEditorWrap = null;
        return;
    }

    node.__mmrDomWidget = domWidget;
    domWidget.serialize = false;
    domWidget.skip_serialize = true;
    setWidgetOption(domWidget, "serialize", false);
    setWidgetOption(domWidget, "canvasOnly", false);

    const domIndex = node.widgets?.findIndex((w) => w === domWidget) ?? -1;
    const promptIndex = node.widgets?.findIndex((w) => w === widget) ?? -1;
    if (domIndex >= 0 && promptIndex >= 0 && domIndex !== promptIndex + 1) {
        node.widgets.splice(domIndex, 1);
        const nextPromptIndex = node.widgets.findIndex((w) => w === widget);
        node.widgets.splice(nextPromptIndex + 1, 0, domWidget);
    }

    instrumentWidgets(node);
    refreshVueNodeWidgets(node);
    node._widgetSlotsDirty = true;
    node.setDirtyCanvas?.(true, true);
    app.graph?.setDirtyCanvas?.(true, true);
}

/* ================================================================
graphToPrompt 补丁
================================================================ */
function patchGraphToPrompt() {
    if (patchedPrompt || typeof app.graphToPrompt !== "function") return;
    patchedPrompt = true;
    const original = app.graphToPrompt;
    app.graphToPrompt = async function graphToPromptWithMMREditor2() {
        const promptData = await original.apply(this, arguments);
        const output = promptData?.output || {};
        const nodes = app.graph?._nodes || [];
        for (let i = 0, len = nodes.length; i < len; i++) {
            const node = nodes[i];
            if (!isTarget(node)) continue;
            const promptNode = output[String(node.id)];
            if (!promptNode) continue;
            promptNode.inputs ||= {};

            if (node.__mmrEditor) syncPromptFromEditorImmediate(node, false);
            captureWidgetState(node);
            writeNodeSize(node, node.size);

            // 注入上传的参考图文件列表
            const refFiles = getRefImageFiles(node);
            const refFilesJson = JSON.stringify(refFiles.filter(f => f?.filename));
            promptNode.inputs.ref_image_files = refFilesJson;

            // 提示词有连线则保留上游，无连线使用编辑器构建结果
            const promptInput = node.inputs?.find(inp => inp.name === "prompt");
            if (promptInput?.link == null) {
                const builtPrompt = buildRuntimePrompt(node);
                promptNode.inputs.prompt = builtPrompt;
            }

            // 数值端口有连线则保留上游，无连线回退面板值
            const numKeys = ["width", "height", "length", "ref_max_size"];
            for (const key of numKeys) {
                const inputDef = node.inputs?.find(inp => inp.name === key);
                if (inputDef?.link != null) continue;
                const widget = getWidget(node, key);
                if (widget && typeof widget.value !== "undefined") {
                    promptNode.inputs[key] = widget.value;
                }
            }
        }
        return promptData;
    };
}

/* ================================================================
v3: 提示词优化（Ollama HTTP）+ 显示原始提示词
================================================================ */
const OPT_WIDGET_NAMES = ["opt_model", "opt_api_url", "opt_max_length", "opt_template"];

function setupOptWidgetVisibility(node) {
    const sw = getWidget(node, "enable_prompt_optimize");
    const enabled = !!(sw && sw.value);
    // 开关语义：只控制「是否显示提示词优化选项」。
    // ✦ 优化按钮与 </> 按钮始终可用，不依赖此开关。
    if (sw) {
        sw.label = "显示提示词优化选项";
        const tip =
            "开启：显示下方优化选项（模型 / 接口 / 最大长度 / 模板）。\n" +
            "关闭：隐藏下方选项保持节点简洁。\n" +
            "提示词优化始终可用——直接点击提示词编辑器右下角的 ✦ 按钮即可，无需先打开本开关。";
        if (sw.options) sw.options.tooltip = tip;
    }
    // 用三件套彻底隐藏 widget（与 hideRefImageFilesWidget / hideOriginalPromptWidget 一致）：
    //   1) w.hidden = true
    //   2) options.hidden = true  (LiteGraph 部分渲染路径读 options.hidden)
    //   3) w.computeSize = () => [0, -4]  (强制高度为 0，否则布局仍占位)
    node.__mmrOptOrigState ||= {};
    const origState = node.__mmrOptOrigState;
    for (const name of OPT_WIDGET_NAMES) {
        const w = getWidget(node, name);
        if (!w) continue;
        // 首次记录原始状态（用于恢复显示）
        if (!(name in origState)) {
            origState[name] = {
                hidden: !!w.hidden,
                computeSize: w.computeSize,
            };
        }
        if (!enabled) {
            w.hidden = true;
            setWidgetOption(w, "hidden", true);
            setWidgetOption(w, "canvasOnly", true);
            w.computeSize = () => [0, -4];
        } else {
            const o = origState[name] || { hidden: false, computeSize: null };
            w.hidden = !!o.hidden;
            setWidgetOption(w, "hidden", !!o.hidden);
            setWidgetOption(w, "canvasOnly", false);
            if (o.computeSize) {
                w.computeSize = o.computeSize;
            } else {
                delete w.computeSize;
            }
        }
    }
    if (sw && !sw.__mmrV3CallbackInstalled) {
        sw.__mmrV3CallbackInstalled = true;
        const orig = sw.callback;
        sw.callback = function () {
            const r = orig ? orig.apply(this, arguments) : undefined;
            setupOptWidgetVisibility(node);
            try {
                app.graph?.setDirtyCanvas?.(true, true);
                node.computeSize?.();
            } catch (_) {}
            return r;
        };
    }
    // ✦ / ▣ 按钮始终可用，不再受开关影响
    if (node.__mmrOptimizeBtn) {
        node.__mmrOptimizeBtn.disabled = false;
        node.__mmrOptimizeBtn.title = "提示词优化（调用本地 Ollama）";
    }
    if (node.__mmrViewBtn) {
        node.__mmrViewBtn.disabled = false;
    }
}

function setOptBusy(node, busy, text) {
    const status = node.__mmrOptStatus;
    const textEl = node.__mmrOptStatusText;
    const btn = node.__mmrOptimizeBtn;
    if (!status || !textEl) return;
    status.style.display = busy ? "flex" : "none";
    textEl.textContent = text || "";
    if (btn) btn.disabled = busy;
}

/* ================================================================
v6: 复制最终提示词
================================================================ */
async function copyTextToClipboard(text) {
    try {
        if (navigator.clipboard?.writeText) {
            await navigator.clipboard.writeText(text);
            return true;
        }
    } catch { /* 非 localhost/HTTPS 时会被浏览器拒绝，走下面的降级方案 */ }
    try {
        const ta = document.createElement("textarea");
        ta.value = text;
        ta.setAttribute("readonly", "");
        ta.style.position = "fixed";
        ta.style.top = "0";
        ta.style.left = "-9999px";
        ta.style.opacity = "0";
        document.body.append(ta);
        ta.select();
        ta.setSelectionRange(0, text.length);
        const ok = document.execCommand?.("copy");
        ta.remove();
        return !!ok;
    } catch {
        return false;
    }
}

function flashCopyButton(node, ok) {
    const btn = node?.__mmrCopyBtn;
    if (!btn) return;
    btn.textContent = ok ? "\u2713" : "\u2717";
    btn.classList.toggle("is-ok", !!ok);
    btn.classList.toggle("is-fail", !ok);
    clearTimeout(node.__mmrCopyFlashTimer);
    node.__mmrCopyFlashTimer = setTimeout(() => {
        btn.textContent = "\u29C9";
        btn.classList.remove("is-ok", "is-fail");
    }, 1200);
}

async function copyPromptFromEditor(node) {
    if (!node || node.__mmrRemoved) return;
    if (node.__mmrEditor) syncPromptFromEditorImmediate(node, false);
    const text = buildRuntimePrompt(node);
    if (!text.trim()) {
        alert("提示词为空，请先输入内容");
        return;
    }
    const ok = await copyTextToClipboard(text);
    flashCopyButton(node, ok);
    if (!ok) alert("复制失败：浏览器拒绝了剪贴板访问，请手动在编辑器里框选复制。");
}

function getOptRefImageFiles(node) {
    const raw = node?.properties?.["mmr_ref_image_files"];
    if (typeof raw === "string") {
        try { return JSON.parse(raw); } catch (_) { return []; }
    }
    if (Array.isArray(raw)) return raw;
    return [];
}

async function optimizePromptFromEditor(node) {
    if (!node || node.__mmrRemoved) return;
    if (node.__mmrOptimizing) return;
    node.__mmrOptimizing = true;
    const promptWidget = getWidget(node, "prompt");
    if (!promptWidget) {
        node.__mmrOptimizing = false;
        return;
    }

    syncPromptFromEditorImmediate(node, false);
    const currentPrompt = String(promptWidget.value || "").trim();
    if (!currentPrompt) {
        alert("提示词为空，请先输入内容");
        node.__mmrOptimizing = false;
        return;
    }

    // "原始"语义：本次（=上一次）优化前用户手写的内容。
    // 每次优化都覆盖保存，所以用户连续生不同视频时，</> 始终显示"上一次优化前的最新手写"。
    node.properties ||= {};
    node.properties["mmr3_original_prompt"] = currentPrompt;

    const api_url = String(getWidget(node, "opt_api_url")?.value || "http://127.0.0.1:11434").trim();
    const model = String(getWidget(node, "opt_model")?.value || "qwen3.8-27b:latest").trim();
    const max_length = parseInt(getWidget(node, "opt_max_length")?.value || "1024", 10) || 1024;
    const template = String(getWidget(node, "opt_template")?.value || "").trim();
    const images = getOptRefImageFiles(node).filter(f => f && f.filename);
    const external_summary = collectExternalMediaSummary(node);

    setOptBusy(node, true, "正在优化...");
    try {
        const resp = await fetch("/painter/optimize_prompt6", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                prompt: currentPrompt,
                images,
                model,
                api_url,
                max_length,
                template,
                external_media_summary: external_summary,
            }),
        });
        const data = await resp.json().catch(() => ({}));
        if (!resp.ok || !data || data.ok !== true) {
            throw new Error((data && data.error) || `HTTP ${resp.status}`);
        }
        const optimized = String(data.prompt || "").trim();
        if (!optimized) throw new Error("返回内容为空");

        promptWidget.value = optimized;
        if (promptWidget._state) promptWidget._state.value = optimized;
        // mmr3_original_prompt 不再覆盖（已在入口处保存了"本次优化前的文本"）
        if (Array.isArray(node.properties?.["mmr_prompt_doc"]?.parts)) {
            delete node.properties["mmr_prompt_doc"];
        }
        node.__mmrViewOriginal = false;
        if (node.__mmrViewBtn) node.__mmrViewBtn.classList.remove("is-active");
        renderEditorFromNode(node, true);
        setOptBusy(node, false, "优化完成");
        setTimeout(() => setOptBusy(node, false, ""), 1500);
    } catch (exc) {
        setOptBusy(node, false, "");
        const msg = (exc && exc.message) || String(exc);
        alert("提示词优化失败：" + msg);
    } finally {
        node.__mmrOptimizing = false;
    }
}

function toggleOriginalView(node) {
    const promptWidget = getWidget(node, "prompt");
    if (!promptWidget) return;
    node.properties ||= {};
    const original = node.properties["mmr3_original_prompt"];
    if (original === undefined || original === null) {
        alert("尚未进行过优化，无原始提示词可切换");
        return;
    }
    const showing = !!node.__mmrViewOriginal;
    if (!showing) {
        // 进入「显示原始」：先存一份当前 widget 文本（最新优化结果）以便恢复
        syncPromptFromEditorImmediate(node, false);
        node.properties["mmr3_view_backup"] = String(promptWidget.value || "");
        promptWidget.value = String(original);
        node.__mmrViewOriginal = true;
        node.__mmrViewBtn?.classList.add("is-active");
    } else {
        const backup = node.properties["mmr3_view_backup"];
        promptWidget.value = String(backup !== undefined ? backup : original);
        node.__mmrViewOriginal = false;
        node.__mmrViewBtn?.classList.remove("is-active");
    }
    if (promptWidget._state) promptWidget._state.value = promptWidget.value;
    if (Array.isArray(node.properties?.["mmr_prompt_doc"]?.parts)) {
        delete node.properties["mmr_prompt_doc"];
    }
    renderEditorFromNode(node, true);
}

function collectExternalMediaSummary(node) {
    if (!node || !Array.isArray(node.inputs)) return "";
    const lines = [];
    for (const inp of node.inputs) {
        if (!inp || inp.link == null) continue;
        const name = String(inp.name || "");
        const type = inp.type;
        const srcNode = app.graph?.getNodeById?.(inp.link.origin_id);
        const srcTitle = (srcNode && (srcNode.type || srcNode.title)) || "external node";
        if (name.startsWith("ref_video_") && type === "IMAGE") {
            const idx = name.replace(/^ref_video_/, "");
            lines.push(`外部参考视频 #${idx}（来源：${srcTitle}）`);
        } else if (name.startsWith("ref_video_audio_") && type === "AUDIO") {
            const idx = name.replace(/^ref_video_audio_/, "");
            lines.push(`外部视频音轨 #${idx}（来源：${srcTitle}）`);
        } else if (name.startsWith("ref_audio_") && type === "AUDIO") {
            const idx = name.replace(/^ref_audio_/, "");
            lines.push(`外部参考音频 #${idx}（来源：${srcTitle}）`);
        }
    }
    if (!lines.length) return "";
    return "外部已连线参考媒体（这些媒体本身未发送给 qwen，但请在重写时考虑它们的内容）：\n" + lines.join("\n");
}

/* ================================================================
样式
================================================================ */
function installStyles() {
    if (document.getElementById(STYLE_ID)) return;
    const style = document.createElement("style");
    style.id = STYLE_ID;
    style.textContent = `
.mmr-prompt-editor-wrap {
    position: relative;
    display: flex;
    flex-direction: column;
    width: 100%;
    height: 100%;
    min-width: 0;
    min-height: 0;
    max-width: 100%;
    max-height: 100%;
    box-sizing: border-box;
    padding: 0;
    border: 0;
    overflow: hidden;
    pointer-events: auto;
    z-index: 0;
}
.mmr-prompt-editor {
    --mmr-text-size: 12px;
    display: block;
    width: 100%;
    flex: 1;
    min-height: 0;
    max-width: 100%;
    box-sizing: border-box;
    padding: 4px;
    overflow-y: auto;
    overflow-x: hidden;
    overscroll-behavior: contain;
    white-space: pre-wrap;
    overflow-wrap: anywhere;
    border: 0;
    outline: none;
    resize: none;
    background-color: #222;
    color: #ddd;
    caret-color: #ddd;
    font-family: Consolas, "Courier New", monospace;
    font-size: var(--mmr-text-size);
    font-weight: 400;
    line-height: 1.4;
    letter-spacing: 0;
}
.mmr-prompt-editor:empty::before {
    content: attr(data-placeholder);
    color: rgba(255,255,255,.35);
    pointer-events: none;
}
.mmr-dialogue-block {
    display: inline;
    margin: 0 1px;
    padding: 2px 5px;
    vertical-align: 1px;
    border-radius: 4px;
    background: rgba(80, 200, 120, .16);
    color: #7fd39a;
    box-shadow: inset 0 0 0 1px rgba(80, 200, 120, .3);
    font-family: Consolas, "Courier New", monospace;
    font-size: var(--mmr-text-size);
    line-height: calc(1em + 6px);
    white-space: pre-wrap;
    user-select: text;
    cursor: text;
    outline: none;
    -webkit-box-decoration-break: clone;
    box-decoration-break: clone;
}
/* v6：去掉 💬 伪元素 —— 伪元素不参与复制，会破坏"前台显示 = 输出文本"。
   这条同时覆盖 v3 样式表里残留的同名规则。 */
.mmr-dialogue-block::before,
.mmr-dialogue-block::after {
    content: none !important;
}
/* <d>[Chinese] 与 </d> 这些装饰部分用暗绿色 */
.mmr-dlg-prefix,
.mmr-dlg-suffix,
.mmr-dlg-close {
    color: #6fcf97;
    user-select: text;
}
/* 可编辑的正文用亮色，一眼看出哪一段能改 */
.mmr-dlg-content {
    color: #eafff1;
    caret-color: #eafff1;
    outline: none;
}
.mmr-dialogue-block:focus-within {
    background: rgba(80, 200, 120, .22);
    box-shadow: inset 0 0 0 1px rgba(80, 200, 120, .42);
}
.mmr-shot-chip {
    display: inline;
    margin: 0 2px;
    padding: 2px 6px;
    vertical-align: 1px;
    border-radius: 4px;
    background: rgba(90, 169, 240, .16);
    color: #9ccaff;
    box-shadow: inset 0 0 0 1px rgba(90, 169, 240, .38);
    font-family: Consolas, monospace;
    font-size: var(--mmr-text-size);
    line-height: calc(1em + 6px);
    white-space: nowrap;
    /* v6：改成可选中，否则框选整段提示词时 chip 文本会被跳过、复制不出来 */
    user-select: text;
    cursor: default;
}
.mmr-shot-chip.is-warning {
    background: rgba(255,110,110,.14);
    color: #ffb4a8;
    box-shadow: inset 0 0 0 1px rgba(255,110,110,.55);
}
.mmr-mention-chip {
    display: inline;
    margin: 0 2px;
    padding: 2px 6px;
    vertical-align: 1px;
    border-radius: 4px;
    background: rgba(255, 178, 102, .18);
    color: #ffd9a8;
    box-shadow: inset 0 0 0 1px rgba(255, 178, 102, .4);
    font-family: Consolas, monospace;
    font-size: var(--mmr-text-size);
    line-height: calc(1em + 6px);
    white-space: nowrap;
    /* v6：改成可选中，保证整段框选复制时能拿到 <Picture 1> 这类文本 */
    user-select: text;
    cursor: default;
}
.mmr-shot-chip-label,
.mmr-mention-chip-label {
    user-select: text;
}
.mmr-chip-icon {
    display: inline-block;
    margin-right: 3px;
    font-size: 0.9em;
    opacity: 0.8;
    vertical-align: middle;
}
.mmr-chip-thumb {
    width: 14px;
    height: 14px;
    padding: 0;
    border-radius: 2px;
    overflow: hidden;
    line-height: 14px;
    text-align: center;
    background: rgba(0,0,0,.2);
}
.mmr-chip-thumb img {
    width: 100%;
    height: 100%;
    object-fit: cover;
    display: block;
    margin: 0;
    padding: 0;
}
.mmr-mention-menu {
    position: fixed !important;
    z-index: 99999 !important;
    width: 220px;
    max-height: 300px;
    overflow-y: auto;
    padding: 4px;
    border-radius: 6px;
    background: #1e1e1e !important;
    border: 1px solid rgba(255,255,255,0.2) !important;
    box-shadow: 0 12px 40px rgba(0,0,0,0.6) !important;
    color: #ddd !important;
    font-family: Consolas, "Courier New", monospace;
    font-size: 12px !important;
    display: block !important;
    box-sizing: border-box;
}
.mmr-mention-menu-item {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 6px 8px;
    border-radius: 4px;
    cursor: pointer;
    box-sizing: border-box;
}
.mmr-mention-menu-item.is-active,
.mmr-mention-menu-item:hover {
    background: rgba(255, 178, 102, 0.25) !important;
    color: #fff !important;
}
.mmr-mention-menu-icon {
    width: 20px;
    height: 20px;
    display: flex;
    align-items: center;
    justify-content: center;
    font-size: 14px;
    flex-shrink: 0;
}
.mmr-menu-thumb {
    padding: 0;
    border-radius: 3px;
    overflow: hidden;
    background: rgba(0,0,0,.3);
}
.mmr-menu-thumb img {
    width: 100%;
    height: 100%;
    object-fit: cover;
    display: block;
}
.mmr-mention-menu-text {
    flex: 1;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
}
.mmr-mention-menu-empty {
    padding: 12px;
    text-align: center;
    color: rgba(255,255,255,0.4);
    font-size: 12px;
}
/* === 参考图上传区 === */
.mmr-ref-upload-area {
    flex-shrink: 0;
    padding: 6px 0 4px;
    display: flex;
    flex-direction: column;
    gap: 6px;
    background: rgba(0,0,0,0.15);
    border-bottom: 1px solid rgba(255,255,255,0.06);
}
.mmr-ref-upload-row {
    display: flex;
    gap: 6px;
}
.mmr-ref-slot {
    flex: 1 1 0;
    aspect-ratio: 16 / 9;
    border: 1px dashed rgba(255,255,255,0.15);
    border-radius: 6px;
    background: rgba(0,0,0,0.25);
    cursor: pointer;
    position: relative;
    overflow: hidden;
    display: flex;
    align-items: center;
    justify-content: center;
    transition: border-color 0.15s, background 0.15s;
}
.mmr-ref-slot:hover {
    border-color: rgba(255,255,255,0.35);
    background: rgba(0,0,0,0.35);
}
.mmr-ref-slot.has-image {
    border-style: solid;
    border-color: rgba(255,255,255,0.1);
}
.mmr-ref-slot.has-image:hover {
    border-color: rgba(255,255,255,0.3);
}
/* v6：拖拽图片悬停时的高亮 */
.mmr-ref-upload-area.is-dragover {
    background: rgba(90, 169, 240, 0.12);
    box-shadow: inset 0 0 0 1px rgba(90, 169, 240, 0.45);
}
.mmr-ref-slot.is-dragover {
    border-style: solid;
    border-color: #6cb6ff;
    background: rgba(90, 169, 240, 0.22);
    box-shadow: 0 0 0 2px rgba(90, 169, 240, 0.25);
}
.mmr-ref-slot img {
    width: 100%;
    height: 100%;
    object-fit: cover;
    display: block;
    pointer-events: none;
}
.mmr-ref-slot-placeholder {
    color: rgba(255,255,255,0.25);
    font-size: 28px;
    font-weight: 300;
    pointer-events: none;
    user-select: none;
}
.mmr-ref-slot-remove {
    position: absolute;
    top: 3px;
    right: 3px;
    width: 18px;
    height: 18px;
    border-radius: 50%;
    background: rgba(220, 40, 40, 0.6);
    color: #fff;
    border: none;
    cursor: pointer;
    display: flex;
    align-items: center;
    justify-content: center;
    font-size: 13px;
    line-height: 1;
    padding: 0;
    z-index: 2;
    transition: background 0.15s;
    backdrop-filter: blur(2px);
}
.mmr-ref-slot-remove:hover {
    background: rgba(220, 40, 40, 0.85);
}
.mmr-ref-add-row-btn {
    padding: 3px 16px;
    border: 1px dashed rgba(255,255,255,0.15);
    border-radius: 4px;
    background: transparent;
    color: rgba(255,255,255,0.4);
    cursor: pointer;
    font-size: 11px;
    font-family: Consolas, "Courier New", monospace;
    transition: all 0.15s;
}
.mmr-ref-add-row-btn:hover:not(:disabled) {
    border-color: rgba(255,255,255,0.35);
    color: rgba(255,255,255,0.7);
}
.mmr-ref-add-row-btn:disabled {
    opacity: 0.25;
    cursor: not-allowed;
}
.mmr-ref-row-controls {
    display: flex;
    justify-content: center;
    gap: 8px;
    padding-top: 2px;
}
.mmr-ref-remove-row-btn {
    padding: 3px 16px;
    border: 1px dashed rgba(255,255,255,0.15);
    border-radius: 4px;
    background: transparent;
    color: rgba(255,255,255,0.4);
    cursor: pointer;
    font-size: 11px;
    font-family: Consolas, "Courier New", monospace;
    transition: all 0.15s;
}
.mmr-ref-remove-row-btn:hover:not(:disabled) {
    border-color: rgba(255,255,255,0.35);
    color: rgba(255,255,255,0.7);
}
.mmr-ref-remove-row-btn:disabled {
    opacity: 0.25;
    cursor: not-allowed;
}
.mmr3-opt-status {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 6px 10px;
    margin-top: 6px;
    background: rgba(255, 178, 102, 0.12);
    border: 1px solid rgba(255, 178, 102, 0.35);
    border-radius: 6px;
    font-size: 12px;
    color: #ffd9a8;
    font-family: Consolas, "Courier New", monospace;
}
.mmr3-opt-status-spinner {
    width: 12px;
    height: 12px;
    border: 2px solid rgba(255, 178, 102, 0.35);
    border-top-color: #ffd9a8;
    border-radius: 50%;
    animation: mmr3-opt-spin 0.8s linear infinite;
    flex: 0 0 12px;
}
.mmr3-opt-status-text {
    flex: 1;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
}
@keyframes mmr3-opt-spin {
    to { transform: rotate(360deg); }
}
.mmr3-opt-tools {
    display: flex;
    justify-content: flex-end;
    gap: 6px;
    padding-top: 4px;
}
.mmr3-opt-btn {
    padding: 2px 10px;
    border: 1px solid rgba(255,255,255,0.15);
    border-radius: 4px;
    background: transparent;
    color: rgba(255,255,255,0.55);
    cursor: pointer;
    font-size: 13px;
    font-family: Consolas, "Courier New", monospace;
    transition: all 0.15s;
    min-width: 28px;
}
.mmr3-opt-btn:hover:not(:disabled) {
    border-color: rgba(255,255,255,0.4);
    color: rgba(255,255,255,0.85);
    background: rgba(255,255,255,0.05);
}
.mmr3-opt-btn:disabled {
    opacity: 0.3;
    cursor: not-allowed;
}
.mmr3-opt-optimize.is-busy {
    color: #ffd9a8;
    border-color: rgba(255, 178, 102, 0.5);
    background: rgba(255, 178, 102, 0.08);
}
.mmr3-opt-view.is-active {
    color: #9ccaff;
    border-color: rgba(90, 169, 240, 0.55);
    background: rgba(90, 169, 240, 0.12);
}
/* v6：复制按钮 */
.mmr6-opt-copy.is-ok {
    color: #8ee6a6;
    border-color: rgba(80, 200, 120, 0.6);
    background: rgba(80, 200, 120, 0.12);
}
.mmr6-opt-copy.is-fail {
    color: #ffb4a8;
    border-color: rgba(255, 110, 110, 0.6);
    background: rgba(255, 110, 110, 0.12);
}
`;
    document.head.append(style);
}

/* ================================================================
节点安装
================================================================ */
function installNode(nodeType, nodeData) {
    if (nodeData?.name !== NODE_CLASS) return;
    applyNodeDataDefaults(nodeData);
    if (nodeType.prototype.__mmrNodeInstalled) return;
    nodeType.prototype.__mmrNodeInstalled = true;

    const originalCreated = nodeType.prototype.onNodeCreated;
    nodeType.prototype.onNodeCreated = function onNodeCreatedMMR() {
        const result = originalCreated?.apply(this, arguments);
        this.properties ||= {};
        this.__mediaDirty = true;
        ensurePromptEditor(this);
        hideRefImageFilesWidget(this);
        instrumentWidgets(this);

        const node = this;
        // 尺寸恢复策略：
        // 1) properties[NODE_SIZE_PROP] 存在（configure 时恢复的 properties）→ 加载的节点，恢复保存尺寸
        // 2) __mmrConfigured 为 true → onConfigure 已接管恢复
        // 3) 两者皆无 → 新添加的节点，使用默认尺寸
        requestAnimationFrame(() => {
            if (node.__mmrRemoved) return;
            const savedSize = node.properties?.[NODE_SIZE_PROP];
            const hasSavedSize = Array.isArray(savedSize) && savedSize.length >= 2;
            if (hasSavedSize) {
                applyNodeSizeNow(node, savedSize);
            } else if (!node.__mmrConfigured) {
                applyNodeSizeNow(node, DEFAULT_NODE_SIZE);
            }
            repairNodeLayout(node);
            refreshVueNodeWidgets(node);
            // 延迟恢复缩略图（等待源节点 imgs 异步加载）
            scheduleThumbnailRefresh(node);
            // 第二轮修复，确保 widget 布局稳定
            requestAnimationFrame(() => {
                if (node.__mmrRemoved) return;
                repairNodeLayout(node);
            });
        });
        return result;
    };

    const originalConfigure = nodeType.prototype.onConfigure;
    nodeType.prototype.onConfigure = function onConfigureMMR(info) {
        this.__mmrConfigured = true;
        this.__mediaDirty = true;
        this.properties ||= {};

        const incomingState = info?.properties?.[WIDGET_STATE_PROP];
        const incomingSize = info?.properties?.[NODE_SIZE_PROP] ?? (Array.isArray(info?.size) ? info.size : null);
        const incomingRefFiles = info?.properties?.[REF_IMAGE_FILES_PROP];
        const incomingRefRows = info?.properties?.[REF_ROWS_PROP];
        const result = originalConfigure?.apply(this, arguments);

        this.properties ||= {};
        if (incomingState) this.properties[WIDGET_STATE_PROP] = incomingState;
        if (incomingSize) this.properties[NODE_SIZE_PROP] = incomingSize;
        if (incomingRefFiles) this.properties[REF_IMAGE_FILES_PROP] = incomingRefFiles;
        if (incomingRefRows != null) this.properties[REF_ROWS_PROP] = incomingRefRows;
        if (info?.properties?.[PROMPT_DOC_PROP]) {
            this.properties[PROMPT_DOC_PROP] = info.properties[PROMPT_DOC_PROP];
        }

        ensurePromptEditor(this);
        hideRefImageFilesWidget(this);
        restoreWidgetState(this, incomingState);
        // ensurePromptEditor 在 __mmrEditor 已存在时会早返回，
        // 这里显式跑一次 setupOptWidgetVisibility，确保开关状态恢复后
        // opt_* 控件的显隐能跟随 sw.value（onNodeCreated 时默认 true，
        // 若工作流存的是 false，opt_* 必须立刻隐藏）。
        setupOptWidgetVisibility(this);
        renderEditorFromNode(this);
        renderRefUploadArea(this);
        resetPromptHistory(this);
        instrumentWidgets(this);

        const node = this;
        // 恢复已保存的尺寸
        requestAnimationFrame(() => {
            if (node.__mmrRemoved) return;
            if (incomingSize) applyNodeSizeNow(node, incomingSize);
            repairNodeLayout(node);
            refreshVueNodeWidgets(node);
            // 延迟恢复缩略图（等待源节点 imgs 异步加载）
            scheduleThumbnailRefresh(node);
            // 延迟二次修复
            setTimeout(() => {
                if (node.__mmrRemoved) return;
                if (incomingSize) applyNodeSizeNow(node, incomingSize);
                repairNodeLayout(node);
            }, 200);
        });
        return result;
    };

    const originalSerialize = nodeType.prototype.onSerialize;
    nodeType.prototype.onSerialize = function onSerializeMMR(info) {
        if (this.__mmrEditor) syncPromptFromEditorImmediate(this, false);
        captureWidgetState(this);
        writeNodeSize(this, this.size);
        const result = originalSerialize?.apply(this, arguments);
        if (info) {
            info.properties ||= {};
            if (this.properties?.[PROMPT_DOC_PROP]) info.properties[PROMPT_DOC_PROP] = this.properties[PROMPT_DOC_PROP];
            if (this.properties?.[WIDGET_STATE_PROP]) info.properties[WIDGET_STATE_PROP] = this.properties[WIDGET_STATE_PROP];
            if (this.properties?.[NODE_SIZE_PROP]) info.properties[NODE_SIZE_PROP] = this.properties[NODE_SIZE_PROP];
            if (this.properties?.[REF_IMAGE_FILES_PROP]) info.properties[REF_IMAGE_FILES_PROP] = this.properties[REF_IMAGE_FILES_PROP];
            if (this.properties?.[REF_ROWS_PROP] != null) info.properties[REF_ROWS_PROP] = this.properties[REF_ROWS_PROP];
        }
        return result;
    };

    const originalRemoved = nodeType.prototype.onRemoved;
    nodeType.prototype.onRemoved = function onRemovedMMR() {
        this.__mmrRemoved = true;
        if (activeMentionMenu?.node === this) closeMentionMenu();

        if (this.__mmrEditorRetryTimer) {
            clearTimeout(this.__mmrEditorRetryTimer);
            this.__mmrEditorRetryTimer = null;
        }
        if (syncThrottleMap.has(this)) {
            clearTimeout(syncThrottleMap.get(this));
            syncThrottleMap.delete(this);
        }
        if (this.__mmrCopyFlashTimer) {
            clearTimeout(this.__mmrCopyFlashTimer);
            this.__mmrCopyFlashTimer = null;
        }
        this.__mmrCopyBtn = null;

        this.__mmrEditorWrap?.remove?.();
        this.__mmrEditor = null;
        this.__mmrEditorWrap = null;
        this.__mmrDomWidget = null;
        this.__mmrRefUploadArea = null;

        this.__mmrPromptHistory = null;
        this.__mmrPromptComposing = false;
        this.__mmrDialogueHashHandled = false;
        this.__mediaCache = null;
        this.__mediaDirty = false;

        return originalRemoved?.apply(this, arguments);
    };

    const originalOnAdded = nodeType.prototype.onAdded;
    nodeType.prototype.onAdded = function onAddedMMR(graph) {
        const result = originalOnAdded?.apply(this, arguments);
        repairNodeLayout(this);
        return result;
    };

    // === 尺寸持久化修复：即时写入，不再使用节流 ===
    const originalOnResize = nodeType.prototype.onResize;
    nodeType.prototype.onResize = function onResizeMMR(size) {
        const result = originalOnResize?.apply(this, arguments);
        if (!this.__mmrRestoringSize) {
            writeNodeSize(this, size || this.size);
        }
        // 触发 widgets 重排（特别是 Vue Nodes 模式需要）
        refreshVueNodeWidgets(this);
        return result;
    };

    const originalMouseUp = nodeType.prototype.onMouseUp;
    nodeType.prototype.onMouseUp = function onMouseUpMMR(event) {
        const result = originalMouseUp?.apply(this, arguments);
        if (!this.__mmrRestoringSize) {
            writeNodeSize(this, this.size);
        }
        return result;
    };

    // 注意：LiteGraph 的标准连线变化钩子是 onConnectionsChange（单数），
    // 之前误写成 onConnectionsChanged（复数）导致连线后媒体缓存从不失效。
    const originalConnectionsChange = nodeType.prototype.onConnectionsChange;
    nodeType.prototype.onConnectionsChange = function onConnectionsChangeMMR(...args) {
        const result = originalConnectionsChange?.apply(this, args);
        this.__mediaDirty = true;
        this.__mediaCache = null;
        instrumentWidgets(this);

        const numKeys = ["width", "height", "length", "ref_max_size"];
        const state = this.properties?.[WIDGET_STATE_PROP];
        if (state) {
            for (const key of numKeys) {
                const inputDef = this.inputs?.find(inp => inp.name === key);
                if (inputDef?.link != null) {
                    delete state[key];
                }
            }
        }
        captureWidgetState(this);
        repairNodeLayout(this);

        if (this.__mmrEditor && document.activeElement === this.__mmrEditor) {
            openOrUpdateMentionMenu(this, this.__mmrEditor);
        }
        return result;
    };
}

/* ================================================================
扩展注册
================================================================ */
app.registerExtension({
    name: "PainterMiniMaxRefToVideo6",
    setup() {
        if (installed) return;
        installed = true;
        patchGraphToPrompt();
        installStyles();
        installGlobalDropCleanup();

        document.addEventListener("pointerdown", (event) => {
            if (!activeMentionMenu) return;
            if (activeMentionMenu.element.contains(event.target)) return;
            if (activeMentionMenu.editor.contains(event.target)) return;
            closeMentionMenu();
        }, true);
    },
    beforeRegisterNodeDef(nodeType, nodeData) {
        installNode(nodeType, nodeData);
    },
});
