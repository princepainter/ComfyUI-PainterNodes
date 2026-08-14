import { app } from "../../scripts/app.js";
/* ================================================================
PainterMiniMaxRefToVideo.js  (布局溢出修复 + 性能优化版)
修复：1. 复制粘贴/切换工作流后编辑器溢出节点边框
     2. 长时间使用页面卡顿、内存泄漏
     3. 数值连线生效逻辑保留
================================================================ */
const NODE_CLASS = "PainterMiniMaxRefToVideo";
const PROMPT_DOC_PROP = "mmr_prompt_doc";
const WIDGET_STATE_PROP = "mmr_widget_values";
const NODE_SIZE_PROP = "mmr_node_size";
const DEFAULT_NODE_SIZE = [430, 560];
const DEFAULT_WIDGET_VALUES = {
    width: 1376,
    height: 768,
    length: 124,
    ref_max_size: 1536,
};
const DIALOGUE_CLASS = "mmr-dialogue-block";
const SHOT_CHIP_CLASS = "mmr-shot-chip";
const MENTION_CHIP_CLASS = "mmr-mention-chip";
const CHIP_SELECTOR = `.${MENTION_CHIP_CLASS}, .${SHOT_CHIP_CLASS}`;
const CARET_SENTINEL = "\u200B";
const PROMPT_HISTORY_LIMIT = 80;
const SHOT_TRIGGER_RE = /切镜\s*(\d+(?:\.\d+)?)$/;
const FALLBACK_SHOT_RE = /切镜\s*(\d+(?:\.\d+)?)\s*[，,]?\s*/g;
const BRACKET_DIALOGUE_RE = /【([^】]*)】/g;
const MENTION_TRIGGER_RE = /@(图片|视频|音频)(\d+)$/;
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
const MENTION_TAG_MAP = {
    image: "Picture",
    video: "Video",
    audio: "Audio",
};
const MENTION_ICON_MAP = {
    image: "🖼",
    video: "🎞️",
    audio: "🔊",
};
const MENTION_MENU_CLASS = "mmr-mention-menu";
const MENTION_MENU_ITEM_CLASS = "mmr-mention-menu-item";
const SIZE_STORE_THROTTLE_MS = 500;
const SYNC_THROTTLE_MS = 200;
let installed = false;
let patchedPrompt = false;
let activeMentionMenu = null;
const sizeThrottleMap = new WeakMap();
const syncThrottleMap = new WeakMap();

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
    } catch { /* 部分前端 widgets 是只读 */ }
}

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

function wrapDialogueTag(text) {
    const trimmed = String(text || "").trim();
    if (!trimmed) return "";
    const withPunct = /[.?!。？!]$/.test(trimmed) ? trimmed : `${trimmed}。`;
    if (/^\[[^\]]+\]/.test(withPunct)) return `<d>${withPunct}</d>`;
    return `<d>[Chinese] ${withPunct}</d>`;
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

function getConnectedMedia(node) {
    const media = { image: [], video: [], audio: [] };
    if (!node?.inputs) return media;
    if (node.__mediaCache && !node.__mediaDirty) {
        return node.__mediaCache;
    }
    node.inputs.forEach((input, index) => {
        if (input.link == null) return;
        const name = String(input.name || "");
        let match = name.match(/ref_image_(\d+)$/i) || name.match(/^image_(\d+)$/i);
        if (match) {
            const ordinal = parseInt(match[1], 10) + 1;
            media.image.push({
                type: "image",
                ordinal,
                label: `图片${ordinal}`,
                tag: `<Picture ${ordinal}>`,
                token: `@图片${ordinal}`,
                sourceNode: getSourceNode(node, index),
            });
            return;
        }
        match = name.match(/ref_video_(\d+)$/i) || name.match(/^video_(\d+)$/i);
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

function throttledStoreNodeSize(node, size) {
    if (!node || sizeThrottleMap.has(node)) return;
    sizeThrottleMap.set(node, true);
    setTimeout(() => {
        if (!node || node.__mmrRemoved) return;
        writeNodeSize(node, size);
        node.setDirtyCanvas?.(true, false);
        sizeThrottleMap.delete(node);
    }, SIZE_STORE_THROTTLE_MS);
}

// 对齐H3的节点布局修复机制，解决复制粘贴后尺寸异常
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

function makeDialogueBlock(value = "") {
    const block = document.createElement("span");
    block.className = DIALOGUE_CLASS;
    block.spellcheck = false;
    block.dataset.dialogue = "true";
    appendTextWithBreaks(block, value);
    if (!String(value || "")) block.append(makeCaretSentinel());
    return block;
}

function dialogueBlockText(block) {
    return editorText(block);
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
    setCaretAtEndOfNode(block);
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
function makeShotChip(secondsValue) {
    const seconds = Number(secondsValue) || 0;
    const chip = document.createElement("span");
    chip.className = SHOT_CHIP_CLASS;
    chip.contentEditable = "false";
    chip.dataset.seconds = String(seconds);
    chip.dataset.token = `切镜${seconds}`;
    const icon = document.createElement("span");
    icon.className = "mmr-chip-icon";
    icon.textContent = "✂";
    const label = document.createElement("span");
    label.className = "mmr-shot-chip-label";
    label.textContent = formatShotTime(seconds);
    chip.append(icon, label);
    chip.title = `切镜 → [Shot N] At ${formatShotTime(seconds)}`;
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
    for (const chip of chips) {
        const seconds = Number(chip.dataset.seconds);
        chip.classList.toggle("is-warning", Number.isFinite(seconds) && seconds <= previous);
        if (Number.isFinite(seconds)) previous = seconds;
    }
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

function makeMentionChip(option) {
    const chip = document.createElement("span");
    chip.className = MENTION_CHIP_CLASS;
    chip.contentEditable = "false";
    chip.dataset.token = option.token || option.tag || "";
    chip.dataset.label = option.label || "";
    chip.dataset.ordinal = String(option.ordinal || "");
    chip.dataset.mediaType = option.type || "image";
    chip.title = option.tag || "";
    const icon = document.createElement("span");
    icon.className = "mmr-chip-icon mmr-chip-thumb";
    const previewUrl = option.previewUrl || getMediaPreview(option.sourceNode, option.type);
    if (previewUrl && option.type !== "audio") {
        const img = document.createElement("img");
        img.src = previewUrl;
        img.alt = "";
        img.draggable = false;
        img.addEventListener("error", () => {
            img.remove();
            icon.textContent = MENTION_ICON_MAP[option.type] || "🖼";
        });
        icon.append(img);
    } else {
        icon.textContent = MENTION_ICON_MAP[option.type] || "🖼";
    }
    const label = document.createElement("span");
    label.className = "mmr-mention-chip-label";
    label.textContent = `@${option.label || ""}`;
    chip.append(icon, label);
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
        const preview = getMediaPreview(item.sourceNode, item.type);
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
        text: parts.map((p) => {
            if (p.type === "mention") return p.token;
            if (p.type === "dialogue") return `<d>${p.text}</d>`;
            if (p.type === "shot") return `切镜${p.seconds}`;
            return p.text;
        }).join(""),
        parts,
    };
}

function appendDialogueBlock(container, value = "") {
    container.append(makeCaretSentinel(), makeDialogueBlock(value), makeCaretSentinel());
}

function appendPromptTextWithDialogueBlocks(container, value) {
    const source = String(value || "");
    const pattern = /<d>([\s\S]*?)<\/d>/gi;
    let cursor = 0;
    let match;
    while ((match = pattern.exec(source))) {
        if (match.index > cursor) {
            appendTextWithBreaks(container, source.slice(cursor, match.index));
        }
        appendDialogueBlock(container, match[1]);
        cursor = match.index + match[0].length;
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
        appendPromptTextWithDialogueBlocks(editor, String(widget.value || ""));
        return;
    }
    // 预先获取媒体列表（含外部连线源节点），用于重建 chip 时恢复缩略图
    // （否则刷新后缩略图会丢失变成 emoji）。
    const media = getConnectedMedia(node);
    for (const part of doc.parts) {
        if (part?.type === "dialogue") {
            appendDialogueBlock(editor, String(part.text || ""));
            continue;
        }
        if (part?.type === "shot") {
            editor.append(makeShotChip(Number(part.seconds) || 0));
            continue;
        }
        if (part?.type === "mention") {
            const mediaType = part.mediaType || "image";
            const ordinal = Number(part.ordinal);
            const matched = media[mediaType]?.find(item => item.ordinal === ordinal);
            editor.append(makeMentionChip({
                type: mediaType,
                ordinal,
                tag: part.token || "",
                token: part.token || "",
                label: part.label || "",
                sourceNode: matched?.sourceNode,
                previewUrl: matched?.previewUrl,
            }));
            continue;
        }
        appendTextWithBreaks(editor, part?.text || "");
    }
    validateShotChips(editor);
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
            validateShotChips(editor);
            if (markDirty) {
                // 仅重绘当前节点，不触发全画布重绘
                node.setDirtyCanvas?.(true, false);
                app.graph?.setDirtyCanvas?.(true, false);
                app.graph?.change?.();
            }
        } finally {
            node.__mmrEditorSyncing = false;
            syncThrottleMap.delete(node);
        }
    }, SYNC_THROTTLE_MS);
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
        validateShotChips(editor);
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
    let shotIndex = 1;
    const emitShot = (seconds) => {
        shotIndex += 1;
        return `[Shot ${shotIndex}] At ${formatShotTimestamp(seconds)},`;
    };
    const pieces = doc.parts.map((part) => {
        if (part?.type === "dialogue") return wrapDialogueTag(part.text);
        if (part?.type === "shot") return emitShot(Number(part.seconds) || 0);
        if (part?.type === "mention") {
            const prefix = MENTION_TAG_MAP[part.mediaType] || "Picture";
            return `<${prefix} ${part.ordinal}>`;
        }
        return String(part?.text || "").replace(FALLBACK_SHOT_RE, (m, s) => emitShot(Number(s)));
    });
    return postProcessPromptText(pieces.join(""));
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
    const SPECIAL = /【[^】]*】|切镜\s*\d+(?:\.\d+)?|@(?:图片|视频|音频)\d+/g;
    let lastIndex = 0;
    let match;
    while ((match = SPECIAL.exec(value))) {
        if (match.index > lastIndex) {
            appendPastedText(fragment, value.slice(lastIndex, match.index));
        }
        const token = match[0];
        fragment.append(document.createTextNode(CARET_SENTINEL));
        if (token.startsWith("【")) {
            fragment.append(makeDialogueBlock(token.slice(1, -1)));
        } else if (token.startsWith("@")) {
            const m = token.match(/@(图片|视频|音频)(\d+)/);
            if (m) {
                const type = MENTION_TYPE_MAP[m[1]];
                const ordinal = parseInt(m[2], 10);
                const tag = `<${MENTION_TAG_MAP[type]} ${ordinal}>`;
                fragment.append(makeMentionChip({ type, ordinal, tag, token, label: `${m[1]}${m[2]}` }));
            }
        } else {
            const numeric = token.match(/\d+(?:\.\d+)?/);
            fragment.append(makeShotChip(Number(numeric ? numeric[0] : 0)));
        }
        fragment.append(document.createTextNode(CARET_SENTINEL));
        lastIndex = match.index + token.length;
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
        node.setSize?.(size);
        writeNodeSize(node, size);
        node._widgetSlotsDirty = true;
        node.setDirtyCanvas?.(true, true);
    } finally {
        setTimeout(() => { node.__mmrRestoringSize = false; }, 0);
    }
}

function instrumentWidgets(node) {
    if (!node?.widgets) return;
    for (const w of node.widgets || []) {
        if (!w || !w.name) continue;
        if (w.name === "mmr_prompt_editor") continue;
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
编辑器创建
================================================================ */
// 隐藏原始prompt文本框
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

    const wrap = document.createElement("div");
    wrap.className = "mmr-prompt-editor-wrap";
    wrap.style.minHeight = "0px";

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
            syncPromptFromEditor(node);
            pushPromptHistory(node);
        } else if (event.key === "Delete" && deleteChipNearCaret(editor, node, "forward")) {
            event.preventDefault();
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
    node.__mmrEditor = editor;
    node.__mmrEditorWrap = wrap;

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

    // 确保DOM控件在prompt控件之后
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
    app.graphToPrompt = async function graphToPromptWithMMREditor() {
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

            // 提示词有连线则保留上游，无连线使用编辑器构建结果
            const promptInput = node.inputs?.find(inp => inp.name === "prompt");
            if (promptInput?.link == null) {
                promptNode.inputs.prompt = buildRuntimePrompt(node);
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
样式
================================================================ */
function installStyles() {
    const style = document.createElement("style");
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
    min-width: 0;
    min-height: 0;
    max-width: 100%;
    max-height: 100%;
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
    color: #d4f5dd;
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
.mmr-dialogue-block::before {
    content: "💬 ";
    font-size: 0.9em;
    opacity: 0.75;
}
.mmr-dialogue-block:focus {
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
    user-select: none;
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
    user-select: none;
    cursor: default;
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
        instrumentWidgets(this);

        const node = this;
        // 尺寸恢复策略：
        // 1) properties[NODE_SIZE_PROP] 存在（configure 时恢复的 properties）→ 加载的节点，恢复保存尺寸
        // 2) __mmrConfigured 为 true → onConfigure 已接管恢复
        // 3) 两者皆无 → 新添加的节点，使用默认尺寸
        // 这确保即使 onConfigure 钩子因版本差异未被调用，也能正确恢复用户手动调整过的尺寸
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

        const incomingState = info?.properties?.[WIDGET_STATE_PROP] ?? this.properties?.[WIDGET_STATE_PROP];
        const incomingSize = info?.properties?.[NODE_SIZE_PROP] ?? this.properties?.[NODE_SIZE_PROP] ?? (Array.isArray(info?.size) ? info.size : null);
        const result = originalConfigure?.apply(this, arguments);

        this.properties ||= {};
        if (incomingState) this.properties[WIDGET_STATE_PROP] = incomingState;
        if (incomingSize) this.properties[NODE_SIZE_PROP] = incomingSize;
        if (info?.properties?.[PROMPT_DOC_PROP]) {
            this.properties[PROMPT_DOC_PROP] = info.properties[PROMPT_DOC_PROP];
        }

        ensurePromptEditor(this);
        restoreWidgetState(this, incomingState);
        renderEditorFromNode(this);
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
        }
        return result;
    };

    const originalRemoved = nodeType.prototype.onRemoved;
    nodeType.prototype.onRemoved = function onRemovedMMR() {
        this.__mmrRemoved = true;
        if (activeMentionMenu?.node === this) closeMentionMenu();

        // 清理所有定时器
        if (this.__mmrEditorRetryTimer) {
            clearTimeout(this.__mmrEditorRetryTimer);
            this.__mmrEditorRetryTimer = null;
        }
        if (syncThrottleMap.has(this)) {
            clearTimeout(syncThrottleMap.get(this));
            syncThrottleMap.delete(this);
        }
        sizeThrottleMap.delete(this);

        // 清理DOM
        this.__mmrEditorWrap?.remove?.();
        this.__mmrEditor = null;
        this.__mmrEditorWrap = null;
        this.__mmrDomWidget = null;

        // 清理状态
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

    const originalOnResize = nodeType.prototype.onResize;
    nodeType.prototype.onResize = function onResizeMMR(size) {
        const result = originalOnResize?.apply(this, arguments);
        if (!this.__mmrRestoringSize) {
            throttledStoreNodeSize(this, size || this.size);
        }
        // 触发 widgets 重排（特别是 Vue Nodes 模式需要）
        refreshVueNodeWidgets(this);
        return result;
    };

    const originalMouseUp = nodeType.prototype.onMouseUp;
    nodeType.prototype.onMouseUp = function onMouseUpMMR(event) {
        const result = originalMouseUp?.apply(this, arguments);
        throttledStoreNodeSize(this, this.size);
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

        // 数值端口连线变化时清理持久化缓存
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
    name: "PainterMiniMaxRefToVideo",
    setup() {
        if (installed) return;
        installed = true;
        patchGraphToPrompt();
        installStyles();

        // 全局点击关闭提及菜单
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
