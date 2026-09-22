import { app } from "../../../scripts/app.js";

const AR_LANDSCAPE = "16:9 (Widescreen)";
const AR_PORTRAIT = "9:16 (Portrait)";

const RES_LANDSCAPE = [
    "512*288",
    "800*448",
    "960*544",
    "1024*576",
    "1280*736",
    "1376*768",
    "1536*864",
    "1600*896",
    "1920*1088",
];

const RES_PORTRAIT = RES_LANDSCAPE.map((item) => {
    const parts = item.split("*");
    return parts[1] + "*" + parts[0];
});

const DEFAULT_FOR = {
    [AR_LANDSCAPE]: "1376*768",
    [AR_PORTRAIT]: "768*1376",
};

const DURATION_STEP = 1;

const VERSION = "v1.3 (H3 size settings, 9 resolutions, 1s step, decimal display)";

function listsFor(aspectRatio) {
    return aspectRatio === AR_PORTRAIT ? RES_PORTRAIT.slice() : RES_LANDSCAPE.slice();
}

function indexOf(value) {
    let i = RES_LANDSCAPE.indexOf(value);
    if (i >= 0) return i;
    return RES_PORTRAIT.indexOf(value);
}

function flipValue(value) {
    const i = indexOf(value);
    if (i < 0) return null;
    return value === RES_LANDSCAPE[i] ? RES_PORTRAIT[i] : RES_LANDSCAPE[i];
}

function applyComboValues(widget, values) {
    if (!widget.options) widget.options = {};
    widget.options.values = values.slice();
    if (Array.isArray(widget.values)) widget.values = values.slice();
    if (widget.inputEl && "options" in widget.inputEl) {
        widget.inputEl.options = values.slice();
    }
}

function findWidget(node, name) {
    return node.widgets?.find((w) => w.name === name);
}

function syncResolution(node, widget) {
    if (node.painterSizeSyncing) return;
    node.painterSizeSyncing = true;
    try {
        const aspectWidget = findWidget(node, "aspect_ratio");
        if (!aspectWidget) return;

        const list = listsFor(aspectWidget.value);
        applyComboValues(widget, list);

        if (!list.includes(widget.value)) {
            const flipped = flipValue(widget.value);
            const fallback = DEFAULT_FOR[aspectWidget.value] || list[0];
            widget.value = flipped && list.includes(flipped) ? flipped : fallback;
        }
        app.graph?.setDirtyCanvas(true, true);
    } finally {
        node.painterSizeSyncing = false;
    }
}

/* Spinner arrows move by 1 second, but a typed value like 5.1 / 5.3 must survive as is.
   step2 pins the arrow step to 1, precision keeps the decimals visible on the canvas. */
function loosenDuration(widget) {
    if (!widget) return;
    const options = widget.options || (widget.options = {});
    options.step = DURATION_STEP;
    options.step2 = DURATION_STEP;
    options.round = false;
    options.precision = 1;
}

app.registerExtension({
    name: "Painter.SizeSettings",
    async beforeRegisterNodeDef(nodeType, nodeData) {
        if (nodeData.name !== "PainterSizeSettings") return;

        console.log("[Painter.H3SizeSettings] " + VERSION + " loaded");

        const onNodeCreated = nodeType.prototype.onNodeCreated;
        nodeType.prototype.onNodeCreated = function () {
            onNodeCreated?.apply(this, arguments);

            const aspectWidget = findWidget(this, "aspect_ratio");
            const resolutionWidget = findWidget(this, "resolution");
            if (!aspectWidget || !resolutionWidget) return;

            const node = this;

            loosenDuration(findWidget(this, "duration"));

            const previousCallback = aspectWidget.callback;
            aspectWidget.callback = function (value, ...rest) {
                const result = previousCallback ? previousCallback.apply(this, [value, ...rest]) : undefined;
                syncResolution(node, resolutionWidget);
                return result;
            };

            const previousWidgetChanged = this.onWidgetChanged;
            this.onWidgetChanged = function (name, value, oldValue, widget) {
                previousWidgetChanged?.apply(this, arguments);
                if (name === "aspect_ratio") syncResolution(node, resolutionWidget);
            };

            syncResolution(this, resolutionWidget);
        };

        const onConfigure = nodeType.prototype.onConfigure;
        nodeType.prototype.onConfigure = function (info) {
            onConfigure?.apply(this, arguments);
            const resolutionWidget = findWidget(this, "resolution");
            if (!resolutionWidget) return;
            loosenDuration(findWidget(this, "duration"));
            syncResolution(this, resolutionWidget);
        };
    },
});
