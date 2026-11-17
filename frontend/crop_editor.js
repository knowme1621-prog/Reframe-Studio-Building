
const OUTPUT_W = 1080;
const OUTPUT_H = 1920;

const LAYOUT_MODES = {
    single:     { label: "Single",     boxes: [{ slot: { x: 0, y: 0, w: 1, h: 1 } }] },
    centered:   { label: "Centered",   boxes: [{ slot: { x: 0, y: 0, w: 1, h: 1 } }] },
    dual:       { label: "Dual",       boxes: [{ slot: { x: 0, y: 0, w: 1, h: 0.5 } }, { slot: { x: 0, y: 0.5, w: 1, h: 0.5 } }] },
    trio:       { label: "Trio",       boxes: [{ slot: { x: 0, y: 0, w: 1, h: 1/3 } }, { slot: { x: 0, y: 1/3, w: 1, h: 1/3 } }, { slot: { x: 0, y: 2/3, w: 1, h: 1/3 } }] },
    spotlight:  { label: "Spotlight",  boxes: [{ slot: { x: 0, y: 0, w: 1, h: 1 } }] },  // MULTISCREEN: screens overlay par (spotlight.js) — base crop FULL-frame
    horizontal: { label: "Horizontal", boxes: [] },
};

let videoNaturalW = 0, videoNaturalH = 0;
let activeVideoEl = null;
let metadataHandler = null;
let resizeObserver = null;

let fitRect = { x: 0, y: 0, w: 0, h: 0 };
let cropDragState = null; // { seg, boxIndex, type, origBox }

const playerCanvas = document.getElementById("playerCanvas");
const playerCtx = playerCanvas.getContext("2d");
const previewCanvas = document.getElementById("previewCanvas");
const previewCtx = previewCanvas.getContext("2d");
const modeTabsEl = document.getElementById("modeTabs");

function computeDefaultBox(targetAspect, slot, isPiP) {
    if (isPiP) {
        const boxWnorm = 0.35;
        const physW = boxWnorm * videoNaturalW;
        const physH = physW / targetAspect;
        let boxHnorm = physH / videoNaturalH;
        if (boxHnorm > 1) boxHnorm = 1;
        return {
            x: Math.max(0, 1 - boxWnorm - 0.03),
            y: 0.03,
            w: boxWnorm,
            h: boxHnorm,
        };
    }

    let boxW = targetAspect * (videoNaturalH / videoNaturalW);
    let boxH = 1;
    if (boxW > 1) {
        boxW = 1;
        boxH = videoNaturalW / (targetAspect * videoNaturalH);
    }

    const slotCenter = slot.y + slot.h / 2;
    let y = slotCenter - boxH / 2;
    y = Math.max(0, Math.min(y, 1 - boxH));

    return {
        x: (1 - boxW) / 2,
        y: y,
        w: boxW,
        h: boxH,
    };
}

// Har SEGMENT apna "modeBoxState" khud rakhta hai — global nahi.
function getSegmentBoxes(seg, mode) {
    if (!seg.modeBoxState) seg.modeBoxState = {};
    if (seg.modeBoxState[mode]) return seg.modeBoxState[mode];

    const config = LAYOUT_MODES[mode];
    const boxes = config.boxes.map((b) => {
        const targetAspect = (b.slot.w * OUTPUT_W) / (b.slot.h * OUTPUT_H);
        const box = computeDefaultBox(targetAspect, b.slot, !!b.isPiP);
        box.slot = b.slot;
        box.isPiP = !!b.isPiP;
        return box;
    });
    seg.modeBoxState[mode] = boxes;
    return boxes;
}

function applyVideoMetadata(videoEl) {
    videoNaturalW = videoEl.videoWidth;
    videoNaturalH = videoEl.videoHeight;
}

function initCropEditor(videoEl) {
    if (activeVideoEl && metadataHandler) {
        activeVideoEl.removeEventListener("loadedmetadata", metadataHandler);
    }
    if (resizeObserver) {
        resizeObserver.disconnect();
    }

    activeVideoEl = videoEl;
    videoNaturalW = 0;
    videoNaturalH = 0;

    metadataHandler = () => applyVideoMetadata(videoEl);
    videoEl.addEventListener("loadedmetadata", metadataHandler);

    if (videoEl.readyState >= 1 && videoEl.videoWidth > 0) {
        applyVideoMetadata(videoEl);
    }

    resizeObserver = new ResizeObserver(() => resizeCanvas());
    resizeObserver.observe(playerCanvas.parentElement);
    resizeCanvas();

    requestAnimationFrame(renderLoop);
}

function resizeCanvas() {
    const rect = playerCanvas.parentElement.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return;
    playerCanvas.width = Math.round(rect.width);
    playerCanvas.height = Math.round(rect.height);
}

function computeFitRect() {
    if (!videoNaturalW || !playerCanvas.width) {
        fitRect = { x: 0, y: 0, w: playerCanvas.width, h: playerCanvas.height };
        return;
    }
    const videoAspect = videoNaturalW / videoNaturalH;
    const canvasAspect = playerCanvas.width / playerCanvas.height;

    let w, h;
    if (videoAspect > canvasAspect) {
        w = playerCanvas.width;
        h = w / videoAspect;
    } else {
        h = playerCanvas.height;
        w = h * videoAspect;
    }
    fitRect = {
        x: (playerCanvas.width - w) / 2,
        y: (playerCanvas.height - h) / 2,
        w: w,
        h: h,
    };
}

// ===== MODE TABS =====
function handleModeTabClick(mode) {
    const seg = (typeof getActiveSegment === "function") ? getActiveSegment() : null;
    if (!seg) return; // koi active segment nahi -> tabs disabled
    seg.mode = mode;
    if (typeof persistTimelineState === "function") persistTimelineState();
    // renderAll (sirf renderSegments nahi) — selected segment S2 stack ka ho sakta hai
    if (typeof renderAll === "function") renderAll();
}

function renderModeTabs() {
    modeTabsEl.innerHTML = "";
    Object.keys(LAYOUT_MODES).forEach((mode) => {
        const btn = document.createElement("button");
        btn.className = "mode-tab";
        btn.textContent = LAYOUT_MODES[mode].label;
        btn.dataset.mode = mode;
        btn.addEventListener("click", () => handleModeTabClick(mode));
        modeTabsEl.appendChild(btn);
    });
}

// Har frame par mode-tabs ki "active"/"disabled" state update karta hai
function updateModeTabsUI() {
    const seg = (typeof getActiveSegment === "function") ? getActiveSegment() : null;
    modeTabsEl.classList.toggle("disabled", !seg);
    document.querySelectorAll(".mode-tab").forEach((btn) => {
        btn.classList.toggle("active", !!seg && btn.dataset.mode === seg.mode);
    });
}

// ===== MAIN CANVAS DRAW =====
function drawPlayerCanvas() {
    playerCtx.fillStyle = "#000";
    playerCtx.fillRect(0, 0, playerCanvas.width, playerCanvas.height);

    if (!activeVideoEl || !videoNaturalW) return;

    // NAYA: agar timeline engine keh raha hai ke is waqt koi video-clip active nahi
    // (delete ho chuki / gap hai), to canvas blank hi rehne do — video frame mat khincho.
    if (typeof window.__activeVideoClipForCanvas !== "undefined" && !window.__activeVideoClipForCanvas) return;

    // NAYA (glitch-fix): playback ke dauran seek chal rahi ho (clip boundary par
    // cut) to purane clip ka stale frame 1-2 frames ke liye mat dikhao — yahi
    // stale frame "same part bar bar play" wala visual glitch banata tha.
    if (typeof videoSeekGuard !== "undefined" && videoSeekGuard > 0) return;

    computeFitRect();
    // COLOR GRADE: canvas filter (brightness/contrast/saturate) + temp/vignette
    // overlays (color_grade.js helpers) — Before/After hold par grade bypass
    if (typeof cgCanvasFilter === "function") playerCtx.filter = cgCanvasFilter();
    playerCtx.drawImage(activeVideoEl, fitRect.x, fitRect.y, fitRect.w, fitRect.h);
    playerCtx.filter = "none";
    if (typeof cgApplyTemperatureOverlay === "function") cgApplyTemperatureOverlay(playerCtx, playerCanvas.width, playerCanvas.height);
    if (typeof cgApplyVignette === "function") cgApplyVignette(playerCtx, playerCanvas.width, playerCanvas.height);

    const seg = (typeof getActiveSegment === "function") ? getActiveSegment() : null;
    if (!seg || seg.mode === "horizontal") {
        // koi box nahi is case mein, lekin caption phir bhi dikhna chahiye
        // isPreview=false: ye player-canvas hai, drag/resize yahan nahi hoti
        if (typeof drawCaptionsOnCanvas === "function") drawCaptionsOnCanvas(playerCtx, fitRect.x, fitRect.y, fitRect.w, fitRect.h, 1080, false);
        return;
    }

    const boxes = getSegmentBoxes(seg, seg.mode);

    playerCtx.save();
    playerCtx.beginPath();
    playerCtx.rect(fitRect.x, fitRect.y, fitRect.w, fitRect.h);
    playerCtx.clip();
    playerCtx.fillStyle = "rgba(0,0,0,0.45)";
    playerCtx.fillRect(fitRect.x, fitRect.y, fitRect.w, fitRect.h);
    playerCtx.restore();

    boxes.forEach((box, idx) => {
        const px = fitRect.x + box.x * fitRect.w;
        const py = fitRect.y + box.y * fitRect.h;
        const pw = box.w * fitRect.w;
        const ph = box.h * fitRect.h;

        playerCtx.drawImage(
            activeVideoEl,
            box.x * videoNaturalW, box.y * videoNaturalH,
            box.w * videoNaturalW, box.h * videoNaturalH,
            px, py, pw, ph
        );

        playerCtx.strokeStyle = box.isPiP ? "#ffb020" : "#0d6efd";
        playerCtx.lineWidth = 2;
        playerCtx.strokeRect(px, py, pw, ph);

        playerCtx.fillStyle = box.isPiP ? "#ffb020" : "#0d6efd";
        playerCtx.font = "bold 14px Arial";
        playerCtx.fillText(`${idx + 1}`, px + 6, py + 18);

        const handleSize = 10;
        playerCtx.fillRect(px + pw - handleSize / 2, py + ph - handleSize / 2, handleSize, handleSize);
    });

    // isPreview=false: player-canvas, sirf dikhana hai, drag yahan nahi hoti
    if (typeof drawCaptionsOnCanvas === "function") drawCaptionsOnCanvas(playerCtx, fitRect.x, fitRect.y, fitRect.w, fitRect.h, 1080, false);
}

function getNormalizedPos(e) {
    const rect = playerCanvas.getBoundingClientRect();
    const canvasX = e.clientX - rect.left;
    const canvasY = e.clientY - rect.top;
    return {
        x: (canvasX - fitRect.x) / fitRect.w,
        y: (canvasY - fitRect.y) / fitRect.h,
    };
}

// NOTE: spotlight-bubble interaction PREVIEW canvas par rehti hai (spotlight.js
// khud apna mousedown listener lagati hai) — player canvas par sirf ghost guide
// draw hota hai (drawSpotlightOverlay), isliye yahan koi integration nahi.
playerCanvas.addEventListener("mousedown", (e) => {
    const seg = (typeof getActiveSegment === "function") ? getActiveSegment() : null;
    if (!seg || seg.mode === "horizontal") return; // disabled jab koi segment active nahi

    const boxes = getSegmentBoxes(seg, seg.mode);
    const rect = playerCanvas.getBoundingClientRect();
    const canvasX = e.clientX - rect.left;
    const canvasY = e.clientY - rect.top;

    // NAYA: resize-handle ka hit-test ab PIXEL-space mein hai (fitRect ke
    // percentage se nahi) — pehle 0.02 (2%) normalized tolerance thi jo
    // window/video size ke hisaab se kabhi bohat chhoti ho jati thi, isliye
    // corner-drag miss ho kar box "move" jaisa behave karta tha. Ab hit-zone
    // hamesha ek fixed, visually-drawn-handle se bara pixel-radius hai, aur
    // SAB boxes ke handles pehle check hote hain (move-check se pehle).
    const HANDLE_HIT_RADIUS = 14; // px — 10px wale drawn handle se thoda bara, aasan grab

    for (let i = boxes.length - 1; i >= 0; i--) {
        const box = boxes[i];
        const px = fitRect.x + box.x * fitRect.w;
        const py = fitRect.y + box.y * fitRect.h;
        const pw = box.w * fitRect.w;
        const ph = box.h * fitRect.h;
        const handlePx = px + pw, handlePy = py + ph;

        if (Math.abs(canvasX - handlePx) <= HANDLE_HIT_RADIUS && Math.abs(canvasY - handlePy) <= HANDLE_HIT_RADIUS) {
            cropDragState = { seg, boxIndex: i, type: "resize", origBox: { ...box } };
            return;
        }
    }

    const pos = getNormalizedPos(e);
    for (let i = boxes.length - 1; i >= 0; i--) {
        const box = boxes[i];
        if (pos.x >= box.x && pos.x <= box.x + box.w && pos.y >= box.y && pos.y <= box.y + box.h) {
            cropDragState = { seg, boxIndex: i, type: "move", startX: pos.x, startY: pos.y, origBox: { ...box } };
            return;
        }
    }
});

document.addEventListener("mousemove", (e) => {
    if (!cropDragState) return;
    const boxes = getSegmentBoxes(cropDragState.seg, cropDragState.seg.mode);
    const box = boxes[cropDragState.boxIndex];
    const pos = getNormalizedPos(e);

    if (cropDragState.type === "move") {
        const dx = pos.x - cropDragState.startX;
        const dy = pos.y - cropDragState.startY;
        let newX = cropDragState.origBox.x + dx;
        let newY = cropDragState.origBox.y + dy;
        newX = Math.max(0, Math.min(newX, 1 - box.w));
        newY = Math.max(0, Math.min(newY, 1 - box.h));
        box.x = newX;
        box.y = newY;
    } else if (cropDragState.type === "resize") {
        const aspect = cropDragState.origBox.w / cropDragState.origBox.h;
        let newW = Math.max(0.05, pos.x - box.x);
        let newH = newW / aspect;

        if (box.y + newH > 1) {
            newH = 1 - box.y;
            newW = newH * aspect;
        }
        if (box.x + newW > 1) {
            newW = 1 - box.x;
            newH = newW / aspect;
        }
        box.w = newW;
        box.h = newH;
    }
});

document.addEventListener("mouseup", () => {
    if (cropDragState) {
        if (typeof persistTimelineState === "function") persistTimelineState();
    }
    cropDragState = null;
});

// ===== PREVIEW (9:16) =====
function drawPreview() {
    previewCtx.fillStyle = "#000";
    previewCtx.fillRect(0, 0, previewCanvas.width, previewCanvas.height);

    if (!activeVideoEl || !videoNaturalW) return;

    // NAYA: yahan bhi wahi guard — deleted/gap region par preview bhi blank rahe.
    if (typeof window.__activeVideoClipForCanvas !== "undefined" && !window.__activeVideoClipForCanvas) return;

    // seek-guard: player-canvas wala hi rule (stale frame = glitch)
    if (typeof videoSeekGuard !== "undefined" && videoSeekGuard > 0) return;

    const seg = (typeof getActiveSegment === "function") ? getActiveSegment() : null;

    const scaleX = previewCanvas.width / OUTPUT_W;
    const scaleY = previewCanvas.height / OUTPUT_H;

    // FIX: koi active segment na ho, ya mode "horizontal" ho — dono cases mein
    // poori video letterboxed dikhao (as-it-is), black/blank NAHI.
    if (!seg || seg.mode === "horizontal") {
        // SHORTS CANVAS (naya): ON ho to poori 9:16 composition yahin bana do —
        // bg blur/color + adjustable video box. Caller (caption/transforms) isi
        // composed frame par kaam karega.
        try {
            if (typeof scApplyToPreview === "function" && scApplyToPreview(previewCanvas, previewCtx, activeVideoEl, videoNaturalW, videoNaturalH)) {
                if (typeof drawCaptionsOnCanvas === "function") drawCaptionsOnCanvas(previewCtx, 0, 0, previewCanvas.width, previewCanvas.height, OUTPUT_H, true);
                try { if (typeof transApplyToCanvas === "function") transApplyToCanvas(previewCanvas, previewCtx, virtualTime); } catch (err) {}
                try { if (typeof pzApplyToCanvas === "function") pzApplyToCanvas(previewCanvas, previewCtx, virtualTime); } catch (err) {}
                return;
            }
        } catch (err) { console.warn("shorts canvas compose:", err); }
        const videoAspect = videoNaturalW / videoNaturalH;
        const canvasAspect = previewCanvas.width / previewCanvas.height;
        let dw, dh, dx, dy;
        if (videoAspect > canvasAspect) {
            dw = previewCanvas.width;
            dh = dw / videoAspect;
        } else {
            dh = previewCanvas.height;
            dw = dh * videoAspect;
        }
        dx = (previewCanvas.width - dw) / 2;
        dy = (previewCanvas.height - dh) / 2;
        // COLOR GRADE: filter + temp/vignette overlays (final 9:16 output bhi graded)
        if (typeof cgCanvasFilter === "function") previewCtx.filter = cgCanvasFilter();
        previewCtx.drawImage(activeVideoEl, 0, 0, videoNaturalW, videoNaturalH, dx, dy, dw, dh);
        previewCtx.filter = "none";
        if (typeof cgApplyTemperatureOverlay === "function") cgApplyTemperatureOverlay(previewCtx, previewCanvas.width, previewCanvas.height);
        if (typeof cgApplyVignette === "function") cgApplyVignette(previewCtx, previewCanvas.width, previewCanvas.height);
        // isPreview=true: ye asal 9:16 output hai, yahi par drag/resize hoti hai
        if (typeof drawCaptionsOnCanvas === "function") drawCaptionsOnCanvas(previewCtx, 0, 0, previewCanvas.width, previewCanvas.height, OUTPUT_H, true);
        // TITLES LAYER (9:16 headings — caption-cues text-source; captions ke baad,
        // panz/trans-transforms se PEHLE: title-grade-relevant nahi hai)
        try { if (typeof drawTitleOnCanvas === "function") drawTitleOnCanvas(previewCtx, 0, 0, previewCanvas.width, previewCanvas.height, OUTPUT_H, true); } catch (err) {}
        try { if (typeof titlesDrawOverlay === "function") titlesDrawOverlay(); } catch (err) {}
        // NAYE LAYERS: Pan&Zoom + Transition frame-transform (grade/captions ke BAAD — output-window ke andar)
        try { if (typeof transApplyToCanvas === "function") transApplyToCanvas(previewCanvas, previewCtx, virtualTime); } catch (err) {}
        try { if (typeof pzApplyToCanvas === "function") pzApplyToCanvas(previewCanvas, previewCtx, virtualTime); } catch (err) {}
        return;
    }

    // SHORTS CANVAS (naya): segment-mode par bhi shorts composition priority —
    // preview = final 9:16 output, shorts ON ho to wahi compose hota hai.
    try {
        if (typeof scApplyToPreview === "function" && scApplyToPreview(previewCanvas, previewCtx, activeVideoEl, videoNaturalW, videoNaturalH)) {
            if (typeof drawCaptionsOnCanvas === "function") drawCaptionsOnCanvas(previewCtx, 0, 0, previewCanvas.width, previewCanvas.height, OUTPUT_H, true);
            // TITLES (shorts compose path)
            try { if (typeof drawTitleOnCanvas === "function") drawTitleOnCanvas(previewCtx, 0, 0, previewCanvas.width, previewCanvas.height, OUTPUT_H, true); } catch (err) {}
            try { if (typeof titlesDrawOverlay === "function") titlesDrawOverlay(); } catch (err) {}
            try { if (typeof transApplyToCanvas === "function") transApplyToCanvas(previewCanvas, previewCtx, virtualTime); } catch (err) {}
            try { if (typeof pzApplyToCanvas === "function") pzApplyToCanvas(previewCanvas, previewCtx, virtualTime); } catch (err) {}
            return;
        }
    } catch (err) { console.warn("shorts canvas compose:", err); }

    const boxes = getSegmentBoxes(seg, seg.mode);
    if (typeof cgCanvasFilter === "function") previewCtx.filter = cgCanvasFilter();
    boxes.forEach((box) => {
        const sx = box.x * videoNaturalW, sy = box.y * videoNaturalH;
        const sw = box.w * videoNaturalW, sh = box.h * videoNaturalH;
        const dx = box.slot.x * OUTPUT_W * scaleX, dy = box.slot.y * OUTPUT_H * scaleY;
        const dw = box.slot.w * OUTPUT_W * scaleX, dh = box.slot.h * OUTPUT_H * scaleY;
        previewCtx.drawImage(activeVideoEl, sx, sy, sw, sh, dx, dy, dw, dh);
    });
    previewCtx.filter = "none";
    if (typeof cgApplyTemperatureOverlay === "function") cgApplyTemperatureOverlay(previewCtx, previewCanvas.width, previewCanvas.height);
    if (typeof cgApplyVignette === "function") cgApplyVignette(previewCtx, previewCanvas.width, previewCanvas.height);
    // caption poore 9:16 frame par fixed rehta hai — kisi ek box/slot se tied nahi
    // isPreview=true: ye asal 9:16 output hai, yahi par drag/resize hoti hai
    if (typeof drawCaptionsOnCanvas === "function") drawCaptionsOnCanvas(previewCtx, 0, 0, previewCanvas.width, previewCanvas.height, OUTPUT_H, true);
    // TITLES LAYER (segment-mode path — layer pattern shorts/no-seg jaise hi)
    try { if (typeof drawTitleOnCanvas === "function") drawTitleOnCanvas(previewCtx, 0, 0, previewCanvas.width, previewCanvas.height, OUTPUT_H, true); } catch (err) {}
    try { if (typeof titlesDrawOverlay === "function") titlesDrawOverlay(); } catch (err) {}
    // NAYE LAYERS: Pan&Zoom + Transition frame-transform (grade/captions ke BAAD — output-window ke andar)
    try { if (typeof transApplyToCanvas === "function") transApplyToCanvas(previewCanvas, previewCtx, virtualTime); } catch (err) {}
    try { if (typeof pzApplyToCanvas === "function") pzApplyToCanvas(previewCanvas, previewCtx, virtualTime); } catch (err) {}
}

// CRITICAL FIX: render loop ab exception-proof hai. Pehle agar drawPlayerCanvas/
// drawPreview/updateModeTabsUI mein KOI bhi error aati (halke caption cue ke
// words missing hona, segment ka mode undefined hona, waghera) to neeche wala
// requestAnimationFrame KABHI nahi chalta tha -> loop hamesha ke liye mar jata
// tha -> dono canvas blank/frozen aur playhead akela chalta rehta. Ab har step
// apne try/catch mein hai — error par sirf wo frame skip hota hai, loop chalta
// rehta hai aur agli frame par khud theek ho jata hai.
function renderLoop() {
    try { drawPlayerCanvas(); } catch (err) { console.warn("drawPlayerCanvas error (skipped frame):", err); }
    try { drawPreview(); } catch (err) { console.warn("drawPreview error (skipped frame):", err); }
    try { updateModeTabsUI(); } catch (err) { console.warn("updateModeTabsUI error:", err); }
    try { if (typeof drawSpotlightOverlay === "function") drawSpotlightOverlay(); } catch (err) { console.warn("spotlight overlay error (skipped frame):", err); }
    requestAnimationFrame(renderLoop);
}

renderModeTabs();
