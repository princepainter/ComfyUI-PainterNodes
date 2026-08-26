import { app } from "../../../scripts/app.js";
import { api } from "../../../scripts/api.js";

app.registerExtension({
    name: "Painter.VideoCombine",
    async beforeRegisterNodeDef(nodeType, nodeData) {
        if (nodeData.name !== "PainterVideoCombine") return;

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
                callback: () => {
                    // Sync playback across EVERY PainterVideoCombine node in the workflow.
                    // - <video>: rewind to start, replay.
                    // - <img>  (animated gif/webp): cache-bust the src so the animation restarts.
                    const graph = this.graph || app.canvas?.graph || app.graph;
                    const allNodes = graph?._nodes || [];
                    for (const n of allNodes) {
                        if (n.type !== "PainterVideoCombine") continue;
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
                }
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
