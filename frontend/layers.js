// ===== EFFECT-LAYERS ENGINE (layers.js) =====
// Timeline ki 4 NAYI layers: Captions / Transitions / Crop and Zoom (Pan&Zoom) /
// Color Grade — sab SPAN-based (jahan tak layer, wahan tak effect).
//
// Design-notes:
// - Har layer ka data timeline.js ke global arrays mein hai (captionSpans,
//   transitions, panZoomSpans, gradeSpans) — persist/save/undo/split/drag sab
//   existing engine use karta hai (editor_tools.js + timeline.js).
// - Render: renderEffectLayers() — timeline.js ka renderAll() ise call karta hai.
// - Captions: jab captions generate hon → full-span layer banti hai; split karne
//   par har piece ka apna style/position/size. Panel se change = PLAYHEAD wale
//   piece par apply hota hai (user choice).
// - Grade: purana GLOBAL grade load par ek full-span layer mein migrate hota hai
//   (user choice); Grade panel edits selected/playhead grade-span par lagte hain.
// - Pan&Zoom: 9:16 preview canvas ke andar resizable box; mode = static/in/out.
// - Transitions: 6 types, koi keyframing nahi; span ke andar clip-cut ho to
//   crossfade wahan smart-auto lagta hai.
// - Subtitles: media-bin ke neeche panel + SRT/TXT download (timestamps ke sath);
//   backend transcription cache reuse (dobara whisper nahi chalega).
//
// IMPORTANT: ye file crop_editor.js/color_grade.js/captions.js ke BAAD load hoti
// hai (index.html script order) — isliye yahan ke function-declarations unke
// globals ko override kar ke time-aware wrappers laga sakti hain.

/* eslint-disable no-redeclare */

// ===== SMALL UTILS =====
function _layersClamp01(v) { return Math.max(0, Math.min(1, v)); }

let __layersScratchCanvas = null;
let __layersSnapKey = null;
// PERF FIX (BUG 7): pehle HAR call par naya canvas banta tha — pz/trans
// apply har-frame chalte hain -> 60fps par GC/memory pressure -> lambi
// session me crash/freeze. Ab: EK shared scratch-canvas reuse + PARAM-KEY
// cache (jab tak canvas-dims + span-params + time-bucket same, wahi snapshot).
// SPAN-AWARE: pzSpanAt/trans ka active span bhi key me — span badle to turant
// naya snapshot.
function snapshotCanvas(canvas, spanChanged) {
    if (!__layersScratchCanvas) __layersScratchCanvas = document.createElement("canvas");
    const c = __layersScratchCanvas;
    const key = canvas.width + "x" + canvas.height + "|" + (typeof virtualTime === "number" ? Math.round(virtualTime * 30) : 0) + "|" + (spanChanged || "");
    if (key !== __layersSnapKey) {
        if (c.width !== canvas.width || c.height !== canvas.height) { c.width = canvas.width; c.height = canvas.height; }
        c.getContext("2d").drawImage(canvas, 0, 0);
        __layersSnapKey = key;
    }
    return c;
}
// naya draw-cycle shuru — snapshot cache invalidate (renderAll se pehle call)
function invalidateSnapshot() { __layersSnapKey = null; }

function _layersSameJson(a, b) {
    try { return JSON.stringify(a) === JSON.stringify(b); } catch (e) { return false; }
}

// ===== 1) ROW RENDERING =====

const TRANS_LABELS = {
    fadein: "Fade In", fadeout: "Fade Out", crossfade: "Crossfade",
    slideleft: "Slide Left", slideright: "Slide Right", zoomin: "Zoom In",
};

function _effectLayerDefs() {
    return [
        { kind: "captionSpan", arr: captionSpans, layerEl: captionSpansLayer, cls: "cap-span", label: () => "💬 captions" },
        { kind: "titleSpan", arr: (typeof titlesSpans !== "undefined") ? titlesSpans : [], layerEl: (typeof titlesSpansLayer !== "undefined") ? titlesSpansLayer : null, cls: "title-span", label: (s) => "🅣 " + (s.text || s.template || "title") },
        { kind: "transition", arr: transitions, layerEl: transitionSpansLayer, cls: "trans-span", label: (s) => "⇄ " + (TRANS_LABELS[s.type] || s.type) },
        { kind: "panZoom", arr: panZoomSpans, layerEl: pzSpansLayer, cls: "pz-span", label: (s) => "🔍 " + (s.mode === "in" ? "zoom-in" : s.mode === "out" ? "zoom-out" : "pan&zoom") },
        { kind: "gradeSpan", arr: gradeSpans, layerEl: gradeSpansLayer, cls: "grade-span", label: () => "🎨 grade" },
    ];
}

function renderEffectLayers() {
    if (typeof captionSpansLayer === "undefined" || !captionSpansLayer) return;
    _effectLayerDefs().forEach((def) => {
        if (!def.layerEl) return;
        def.layerEl.innerHTML = "";
        (def.arr || []).forEach((item) => {
            const el = document.createElement("div");
            el.className = "layer-span " + def.cls + ((typeof isSelected === "function" && isSelected(def.kind, item.id)) ? " selected" : "");
            el.style.left = `${item.start * pixelsPerSecond}px`;
            el.style.width = `${(item.end - item.start) * pixelsPerSecond}px`;
            el.dataset.id = item.id;
            el.innerHTML = `<span class="seg-label">${def.label(item)}</span>
                             <div class="seg-handle seg-handle-left" data-id="${item.id}"></div>
                             <div class="seg-handle seg-handle-right" data-id="${item.id}"></div>`;
            def.layerEl.appendChild(el);
        });
    });
    syncPanelsToSelection();
}

// Naye layers ke kinaron par bhi magnetic snap (timeline.js getSnapCandidates)
// — arrays yahan se juri hain.

// ===== 2) ROW INTERACTIONS (select / move / resize / create-drag) =====

function setupEffectRow(rowEl, kind, allowCreate) {
    if (!rowEl) return;
    rowEl.addEventListener("mousedown", (e) => {
        e.stopPropagation();
        pausePlayback();
        if (playPauseBtnEl) playPauseBtnEl.textContent = "▶";
        const target = e.target;

        // "＋" CREATE BUTTON (BUG 1 FIX): user ne click-drag-create band manga tha —
        // ab segment sirf BUTTON PRESS se banta hai (playhead se 2s)
        if (target.classList.contains("layer-add-btn")) {
            e.preventDefault();
            e.stopPropagation();
            const base = (typeof virtualTime === "number" && isFinite(virtualTime)) ? virtualTime : 0;
            createEffectSpan(kind, base, base + 2);
            return;
        }

        if (target.classList.contains("seg-handle-left") || target.classList.contains("seg-handle-right")) {
            const id = target.dataset.id;
            const it = getItemByKindId(kind, id);
            if (!it) return;
            if (e.ctrlKey) toggleSelectItem(kind, id); else selectOnly(kind, id);
            dragState = {
                kind,
                type: target.classList.contains("seg-handle-left") ? "resize-left" : "resize-right",
                id, origStart: it.start, origEnd: it.end,
            };
            renderAll();
            return;
        }

        const blockEl = target.closest(".layer-span");
        if (blockEl) {
            const id = blockEl.dataset.id;
            if (e.ctrlKey) {
                if (isSelected(kind, id) && selectedItems.length > 1) {
                    dragState = buildMoveDragState(e.clientX, kind, id);
                    dragState.pendingCtrlToggle = { kind, id };
                } else {
                    toggleSelectItem(kind, id);
                }
            } else {
                if (!isSelected(kind, id) || selectedItems.length <= 1) {
                    selectOnly(kind, id);
                }
                dragState = buildMoveDragState(e.clientX, kind, id);
            }
            renderAll();
            return;
        }

        // EMPTY AREA (BUG 1 FIX): drag-create BAND — sirf selection clear hota hai
        if (!e.ctrlKey) clearSelection();
        renderAll();
    });
}

setupEffectRow(document.getElementById("trackCaptionLayer"), "captionSpan", false);
setupEffectRow(document.getElementById("trackTitlesLayer"), "titleSpan", false);
setupEffectRow(document.getElementById("trackTransitionsLayer"), "transition", false);
setupEffectRow(document.getElementById("trackPzLayer"), "panZoom", false);
setupEffectRow(document.getElementById("trackGradeLayer"), "gradeSpan", false);

// "＋" BUTTONS (BUG 1) — ye LABELS column me hain (track-rows ke bahar), isliye
// DOCUMENT-level handler (row-handlers in tak nahi pohanchte)
document.addEventListener("mousedown", (e) => {
    const btn = e.target.closest ? e.target.closest(".layer-add-btn") : null;
    if (!btn) return;
    e.preventDefault();
    e.stopPropagation();
    const kind = btn.dataset.layerKind;
    if (!kind || typeof createEffectSpan !== "function") return;
    if (typeof pausePlayback === "function") pausePlayback();
    if (typeof playPauseBtnEl !== "undefined" && playPauseBtnEl) playPauseBtnEl.textContent = "▶";
    const base = (typeof virtualTime === "number" && isFinite(virtualTime)) ? virtualTime : 0;
    createEffectSpan(kind, base, base + 2);
});

// mouseup-create: effect-kind spans (timeline.js ka create-branch effectKind
// ho to createEffectSpan() call karta hai)
function createEffectSpan(kind, start, end, opts) {
    // (BUG 1) fromDrag: purani drag-created chhoti spans ke liye 0.15 guard;
    // BUTTON creates ab hamesha full 2s banti hain (min-length guard skip)
    if (!(opts && opts.fromDrag) && end - start <= 0.15) return;
    if (end - start <= 0.05) return;
    pushHistory();
    let newId = null;
    if (kind === "transition") {
        newId = genId();
        transitions.push({ id: newId, start, end, type: "crossfade", duration: 0.6, intensity: 60 });
    } else if (kind === "panZoom") {
        newId = genId();
        // (USER FIX) default zoom ab 1.0 — box pehle screen ko BHAR deta hai
        // (sirf crop); zoom slider se manual zoom-in/out karo jitna chaho
        panZoomSpans.push({ id: newId, start, end, mode: "static", zoom: 1, box: { x: 0.2, y: 0.1, w: 0.6, h: 0.8 } });
    } else if (kind === "gradeSpan") {
        newId = genId();
        gradeSpans.push({ id: newId, start, end, grade: { ...CG_DEFAULTS } });
    } else if (kind === "titleSpan") {
        // TITLES: default heading-span — selected template + panel se text.
        // (GLITCH FIX) pehle tpText DOM-read + template/align invisible_state
        // thhi — ab opts renderer se (tpAddBtn) + align-preset/position ko
        // SPAN-CREATION par lock karte hain (baad me selection-sync of any kind
        // us position ko rewrite NAHI karega).
        newId = genId();
        const t = (typeof titlesDefaultSpanData === "function") ? titlesDefaultSpanData(start, end, (opts || {})) : {
            id: newId, start, end,
            template: (opts && opts.template) || (typeof titlesSelectedTemplate !== "undefined" ? titlesSelectedTemplate || "boldPop" : "boldPop"),
            text: (opts && opts.text) || "",
            align: (opts && opts.align) || "center",
            position: { x: 0.5, y: 0.22 },
            scale: 1.0,
        };
        t.id = newId;
        titlesSpans.push(t);
    } else if (kind === "captionSpan") {
        // CAPTIONS layer: playhead par 2s default caption-span (Select karke
        // panel se style/size/position change karo — pehle ye branch tha hi nahi
        // isliye "＋" button click par span hi nahi banta tha → panel size/position
        // changes kaam nahi kar pa rahe the (span-less globals hi bante rehte the).
        newId = genId();
        captionSpans.push({
            id: newId, start, end,
            style: currentCaptionStyle,
            position: { ...captionPosition },
            fontScale: captionFontScale,
            overrides: { ...captionOverrides },
            remember: captionRemember,
        });
    }
    if (newId && typeof selectOnly === "function") selectOnly(kind, newId);
    recalcTimelineDuration();
    renderAll();
    persistTimelineState();
}

// PanZoom span delete hua to drag/panel clear
function pzOnDeleted() {
    pzDrag = null;
    const panel = document.getElementById("pzPanel");
    if (panel) panel.style.display = "none";
}

// ===== 3) CAPTIONS LAYER =====

function capSpanAt(t) {
    for (const s of captionSpans) if (t >= s.start && t < s.end) return s;
    return null;
}

// Captions generate hone par full-span layer banao (agar pehle se nahi hai)
function syncCaptionLayerFromCues(contentEnd) {
    if (!captionCues || !captionCues.length) return;
    if (captionSpans.length) return; // already layer hai
    let end = contentEnd || 0;
    if (!end && typeof timelineContentEnd !== "undefined") end = timelineContentEnd;
    if (!end && typeof sourceDuration !== "undefined") end = sourceDuration;
    if (!end) return;
    // GUARD (BUG 9 family): timelineContentEnd kabhi NaN/undefined aa jaye to
    // span end=NaN — baad me sab span-lookups NaN par fail hoti thin. Ab
    // NaN ho to cues ka SABSE LAMBA end hi span-end bana lo (hamesha valid).
    if (typeof end !== "number" || !isFinite(end)) {
        end = 0;
        (captionCues || []).forEach((c) => { if (typeof c.end === "number" && isFinite(c.end)) end = Math.max(end, c.end); });
        if (!end) return;
    }
    captionSpans.push({
        id: genId(), start: 0, end,
        style: currentCaptionStyle,
        position: { ...captionPosition },
        fontScale: captionFontScale,
        overrides: { ...captionOverrides },
        remember: captionRemember,
    });
    if (typeof persistTimelineState === "function") persistTimelineState();
}

// playhead-span ke params → globals (panel wahi dikhaye)
// (USER FIX) SELECTED caption segment playhead-span se zyada priority — user
// layer ko split kar ke alag-alag segments me alag style lagata hai; segment
// select karte hi panel usi segment ka style/size dikhaye (warna pichle
// segment/playhead ka stale style-name dropdown me reh jata tha)
function capSelectedSpan() {
    if (typeof selectedItems === "undefined" || !selectedItems.length) return null;
    for (let i = selectedItems.length - 1; i >= 0; i--) {
        const s = selectedItems[i];
        if (s && s.kind === "captionSpan") return captionSpans.find((x) => x.id === s.id) || null;
    }
    return null;
}

function capLoadPlayheadSpanToGlobals() {
    if (!captionSpans.length || typeof virtualTime === "undefined") return;
    const span = capSelectedSpan() || capSpanAt(virtualTime);
    if (!span) return;
    currentCaptionStyle = span.style || currentCaptionStyle;
    captionPosition = { ...(span.position || captionPosition) };
    captionFontScale = (span.fontScale != null) ? span.fontScale : captionFontScale;
    captionOverrides = { ...(span.overrides || {}) };
    captionRemember = (span.remember !== undefined) ? span.remember : captionRemember;
}

// ---- OVERRIDE: captions.js ka drawCaptionsOnCanvas — per-span params ke sath ----
// NOTE (HOISTING-TRAP): function-declaration se re-declare KARTE to hoisted shadow
// original ko replace kar deta aur __orig capture khud ko pakar leta (infinite
// recursion). Isliye CAPTURE + ASSIGNMENT pattern — originals pehle pakro, phir
// global name par wrapper assign karo.
const __origDrawCaptionsOnCanvas = (typeof drawCaptionsOnCanvas === "function") ? drawCaptionsOnCanvas : null;

var drawCaptionsOnCanvas = function (ctx, rectX, rectY, rectW, rectH, refHeightPx, isPreview) {
    if (!__origDrawCaptionsOnCanvas) return;
    if (!captionSpans.length || typeof virtualTime === "undefined") {
        __origDrawCaptionsOnCanvas(ctx, rectX, rectY, rectW, rectH, refHeightPx, isPreview);
        return;
    }
    const p = capEffectiveParamsAt(virtualTime);
    const save = {
        style: currentCaptionStyle, position: captionPosition,
        fontScale: captionFontScale, overrides: captionOverrides,
    };
    currentCaptionStyle = p.style;
    captionPosition = { x: p.position.x, y: p.position.y };
    captionFontScale = p.fontScale;
    captionOverrides = p.overrides || {};
    try {
        __origDrawCaptionsOnCanvas(ctx, rectX, rectY, rectW, rectH, refHeightPx, isPreview);
    } finally {
        currentCaptionStyle = save.style;
        captionPosition = save.position;
        captionFontScale = save.fontScale;
        captionOverrides = save.overrides;
    }
}

function capEffectiveParamsAt(t) {
    const span = capSpanAt(t);
    if (!span) {
        return {
            style: currentCaptionStyle, position: captionPosition,
            fontScale: captionFontScale, overrides: captionOverrides, fromSpan: false,
        };
    }
    return {
        style: span.style || currentCaptionStyle,
        position: span.position || captionPosition,
        fontScale: (span.fontScale != null) ? span.fontScale : captionFontScale,
        overrides: span.overrides || {},
        fromSpan: true,
    };
}

// ---- OVERRIDE: captions panel — playhead-piece editing (user choice) ----
const __origBuildCaptionsPanel = (typeof buildCaptionsPanel === "function") ? buildCaptionsPanel : null;

var buildCaptionsPanel = function () {
    if (!__origBuildCaptionsPanel) return;
    capLoadPlayheadSpanToGlobals(); // panel controls playhead-span ki values dikhayen
    __origBuildCaptionsPanel();
};

const __origPersistCaptions = (typeof persistCaptionsIfRemembered === "function") ? persistCaptionsIfRemembered : null;

var persistCaptionsIfRemembered = function () {
    // panel se koi bhi edit → SELECTED segment me copy (warna playhead-span)
    if (captionSpans.length && typeof virtualTime !== "undefined") {
        const span = capSelectedSpan() || capSpanAt(virtualTime);
        if (span) {
            span.style = currentCaptionStyle;
            span.position = { ...captionPosition };
            span.fontScale = captionFontScale;
            span.overrides = { ...captionOverrides };
            span.remember = captionRemember;
            if (typeof renderEffectLayers === "function") renderEffectLayers();
        }
    }
    if (__origPersistCaptions) __origPersistCaptions();
}

// generateCaptions ke baad layer sync (wrapper — original captions.js ka hai)
const __origGenerateCaptions = (typeof generateCaptions === "function") ? generateCaptions : null;
if (__origGenerateCaptions) {
    // function-declaration override (window property)
    generateCaptions = async function () {
        const __focus = (typeof document !== "undefined") ? document.activeElement : null;
        try { await __origGenerateCaptions(); } finally {
            // FOCUS FIX (BUG 9 ka blank-crash): captions.js alert() focus dialog
            // par chhod deta tha — phir Space/A/D dialog-button par jaate the
            // (aage-peeche samajh kar Space dabata rehta = screen par kuch nahi
            // hota + keybinding-parser crash -> poora app "hang" jaisa).
            try { if (__focus && typeof __focus.focus === "function") __focus.focus(); else if (typeof document !== "undefined" && document.body) document.body.focus(); } catch (e0) {}
        }
        try { syncCaptionLayerFromCues(); if (typeof renderAll === "function") renderAll(); } catch (e) { console.warn("caption layer sync:", e); }
    };
}

// ===== 4) COLOR GRADE LAYER =====

function gradeSpanAt(t) {
    for (const s of gradeSpans) if (t >= s.start && t < s.end) return s;
    return null;
}

// Grade panel ka edit-target: selected gradeSpan, warna playhead-span, warna global
function cgTargetSpan() {
    if (typeof selectedItems !== "undefined" && selectedItems.length) {
        for (let i = selectedItems.length - 1; i >= 0; i--) {
            if (selectedItems[i].kind === "gradeSpan") {
                const it = gradeSpans.find((g) => g.id === selectedItems[i].id);
                if (it) return it;
            }
        }
    }
    if (typeof virtualTime !== "undefined") return gradeSpanAt(virtualTime);
    return null;
}

// kis time par kaunsa grade effective hai (span > global)
function cgEffectiveGrade(t) {
    const tt = (t !== undefined && t !== null) ? t : (typeof virtualTime !== "undefined" ? virtualTime : undefined);
    if (typeof tt === "number" && isFinite(tt)) {
        const span = gradeSpanAt(tt);
        if (span) return span.grade || CG_DEFAULTS;
        // (USER FIX) Layer-workflow: grade-layers exist hain to unke BAHAR koi
        // grade NAHI lagta. Purana global-fallback yahan panel-ke last-edited
        // colorGrade (preset click se bhara hua) poore video par jala deta tha
        // — yehi reported bug tha. Global fallback sirf purane legacy saves ke
        // liye: jab koi grade-span hi na ho.
        if (gradeSpans && gradeSpans.length) return CG_DEFAULTS;
    }
    return (typeof colorGrade !== "undefined") ? colorGrade : CG_DEFAULTS;
}

// temp-swap wrappers: color_grade.js ke functions effective-grade ke sath chalein
// (CAPTURE + ASSIGNMENT — hoisting-trap se bachne ke liye, upar note dekho)
const __origCgCanvasFilter = (typeof cgCanvasFilter === "function") ? cgCanvasFilter : null;
var cgCanvasFilter = function () {
    if (!__origCgCanvasFilter) return "none";
    const eff = cgEffectiveGrade(typeof virtualTime !== "undefined" ? virtualTime : 0);
    const saved = colorGrade;
    colorGrade = (eff && typeof eff === "object") ? { ...eff } : { ...CG_DEFAULTS };
    try { return __origCgCanvasFilter(); } finally { colorGrade = saved; }
}

const __origCgTemp = (typeof cgApplyTemperatureOverlay === "function") ? cgApplyTemperatureOverlay : null;
var cgApplyTemperatureOverlay = function (ctx, w, h) {
    if (!__origCgTemp) return;
    const eff = cgEffectiveGrade(typeof virtualTime !== "undefined" ? virtualTime : 0);
    const saved = colorGrade;
    colorGrade = (eff && typeof eff === "object") ? { ...eff } : { ...CG_DEFAULTS };
    try { __origCgTemp(ctx, w, h); } finally { colorGrade = saved; }
}

const __origCgVig = (typeof cgApplyVignette === "function") ? cgApplyVignette : null;
var cgApplyVignette = function (ctx, w, h) {
    if (!__origCgVig) return;
    const eff = cgEffectiveGrade(typeof virtualTime !== "undefined" ? virtualTime : 0);
    const saved = colorGrade;
    colorGrade = (eff && typeof eff === "object") ? { ...eff } : { ...CG_DEFAULTS };
    try { __origCgVig(ctx, w, h); } finally { colorGrade = saved; }
}

// Grade panel edits → target span (selected/playhead)
function wireGradePanelToSpans() {
    const keys = ["brightness", "contrast", "saturation", "temperature", "sharpen", "vignette"];
    const copyToSpan = () => {
        const span = cgTargetSpan();
        if (span) {
            span.grade = { ...colorGrade };
            if (typeof persistTimelineState === "function") persistTimelineState();
        }
    };
    keys.forEach((k) => {
        const el = document.getElementById("cg_" + k);
        if (el) el.addEventListener("input", copyToSpan);
    });
    document.querySelectorAll(".cg-preset-btn").forEach((b) => b.addEventListener("click", copyToSpan));
    const rb = document.getElementById("cgResetBtn");
    if (rb) rb.addEventListener("click", copyToSpan);
}
if (typeof document !== "undefined" && document.getElementById("cg_brightness")) {
    wireGradePanelToSpans();
}

// panel header ka target-label: "layer span" ya "poori video"
function cgUpdateTargetLabel() {
    const el = document.getElementById("cgTargetLabel");
    if (!el) return;
    const span = (typeof cgTargetSpan === "function") ? cgTargetSpan() : null;
    el.textContent = span ? "— layer span" : "— poori video";
}

// (USER FIX) 🎨 topbar button ab LAYER-WORKFLOW follow karta hai:
// - agar selected/playhead grade-span hai → wahi select kar ke panel khulao
// - agar KOI span nahi → content-END tak FULL-SPAN layer ban kar select ho
//   ("puri video par color + koi layer nahi banti" wala masla khatam — ab
//   har grade ek layer-span mein rehta hai, global fallback sirf purane saves)
(function wireCgToggleSpanWorkflow() {
    const btn = document.getElementById("cgToggleBtn");
    if (!btn) return;
    btn.addEventListener("click", () => {
        try {
            const panel = document.getElementById("cgPanel");
            const isOpenNow = panel && panel.style.display === "block";
            if (!isOpenNow) { // color_grade.js ka toggle pehle chala = user CLOS kar raha hai
                if (panel) delete panel.dataset.autoForSpan;
                return;
            }
            let target = null;
            if (typeof selectedItems !== "undefined" && selectedItems.length) {
                const last = selectedItems[selectedItems.length - 1];
                if (last.kind === "gradeSpan") target = gradeSpans.find((g) => g.id === last.id) || null;
            }
            if (!target && typeof virtualTime !== "undefined") target = gradeSpanAt(virtualTime);
            if (!target) {
                let end = (typeof timelineContentEnd === "number" && isFinite(timelineContentEnd) && timelineContentEnd > 0) ? timelineContentEnd : 0;
                if (!end && typeof sourceDuration !== "undefined" && isFinite(sourceDuration)) end = sourceDuration;
                if (!end || end <= 0) end = 2;
                if (typeof pushHistory === "function") pushHistory();
                const nid = genId();
                gradeSpans.push({ id: nid, start: 0, end, grade: { ...CG_DEFAULTS } });
                target = gradeSpans[gradeSpans.length - 1];
                if (typeof selectOnly === "function") selectOnly("gradeSpan", nid);
                if (typeof recalcTimelineDuration === "function") recalcTimelineDuration();
                if (typeof renderAll === "function") renderAll();
                persistTimelineState();
            } else if (typeof selectOnly === "function") {
                selectOnly("gradeSpan", target.id);
                if (typeof renderAll === "function") renderAll();
            }
            if (panel) {
                panel.style.display = "block";
                panel.dataset.autoForSpan = "1";
            }
            if (target && typeof colorGrade !== "undefined" && !_layersSameJson(target.grade, colorGrade)) {
                colorGrade = { ...target.grade };
                if (typeof cgSyncUI === "function") cgSyncUI();
            }
            cgUpdateTargetLabel();
        } catch (e) { console.warn("cg toggle span-workflow:", e); }
    });
})();

// ===== 5) CROP AND ZOOM (PAN & ZOOM) =====

function pzSpanAt(t) {
    if (typeof t !== "number") return null;
    for (const s of panZoomSpans) if (t >= s.start && t < s.end) return s;
    return null;
}

function pzEditSpan() {
    if (typeof selectedItems !== "undefined" && selectedItems.length) {
        for (let i = selectedItems.length - 1; i >= 0; i--) {
            if (selectedItems[i].kind === "panZoom") {
                const it = panZoomSpans.find((s) => s.id === selectedItems[i].id);
                if (it) return it;
            }
        }
    }
    return (typeof virtualTime !== "undefined") ? pzSpanAt(virtualTime) : null;
}

function pzZoomAt(span, t) {
    const z = Math.max(1, span.zoom || 1);
    if (span.mode === "in" || span.mode === "out") {
        const dur = Math.max(0.01, span.end - span.start);
        const p = _layersClamp01((t - span.start) / dur);
        const e = p * p * (3 - 2 * p); // smoothstep ease
        return span.mode === "in" ? (1 + (z - 1) * e) : (z - (z - 1) * e);
    }
    return z;
}

// 9:16 output ke andar crop-region (normalized) — zoom jitna zyada, region utna chhota
function pzRegionAt(span, t) {
    const z = pzZoomAt(span, t);
    const b = span.box || { x: 0, y: 0, w: 1, h: 1 };
    let w = Math.min(1, b.w / z);
    let h = Math.min(1, b.h / z);
    const cx = b.x + b.w / 2;
    const cy = b.y + b.h / 2;
    const x = Math.max(0, Math.min(cx - w / 2, 1 - w));
    const y = Math.max(0, Math.min(cy - h / 2, 1 - h));
    return { x, y, w, h };
}

// preview-canvas par zoom apply (compose ke BAAD, captions se PEHLE —
// crop_editor.js drawPreview se call hota hai)
function pzApplyToCanvas(canvas, ctx, t) {
    // NaN/undefined time par koi span nahi — warna pzSpanAt loop me t>=s.start
    // false dega (theek) magar snapshot key NaN ban sakta tha
    if (typeof t !== "number" || !isFinite(t)) return;
    const span = pzSpanAt(t);
    if (!span || !canvas || !ctx) return;
    const W = canvas.width, H = canvas.height;
    const r = pzRegionAt(span, t);
    if (r.w >= 0.999 && r.h >= 0.999 && (r.x <= 0.001) && (r.y <= 0.001)) return;
    const tmp = snapshotCanvas(canvas, "pz:" + span.id);
    ctx.fillStyle = "#000";
    ctx.fillRect(0, 0, W, H);
    ctx.drawImage(tmp, r.x * W, r.y * H, r.w * W, r.h * H, 0, 0, W, H);
    // (HANG FIX) pehle yahan HAR FRAME par pzOnDeleted() chal raha tha —
    // 60fps par panel style write + pzDrag null = DOM thrash + panel foran
    // chhup jata tha. Cleanup sirf delete-flow (editor_tools pzOnDeleted) me.
}

// box overlay (editing handles) — preview par
function pzDrawOverlay() {
    const span = pzEditSpan();
    if (!span || typeof previewCtx === "undefined" || !previewCtx) return;
    const b = span.box || { x: 0, y: 0, w: 1, h: 1 };
    const W = previewCanvas.width, H = previewCanvas.height;
    previewCtx.save();
    previewCtx.strokeStyle = "#66d9ff";
    previewCtx.lineWidth = 2;
    previewCtx.setLineDash([6, 4]);
    previewCtx.strokeRect(b.x * W, b.y * H, b.w * W, b.h * H);
    previewCtx.setLineDash([]);
    const hs = 9;
    [[b.x, b.y], [b.x + b.w, b.y], [b.x, b.y + b.h], [b.x + b.w, b.y + b.h]].forEach(([hx, hy]) => {
        previewCtx.fillStyle = "#66d9ff";
        previewCtx.fillRect(hx * W - hs / 2, hy * H - hs / 2, hs, hs);
    });
    previewCtx.fillStyle = "#66d9ff";
    previewCtx.font = "bold 11px Arial";
    previewCtx.fillText("Pan & Zoom", b.x * W + 4, Math.max(12, b.y * H - 6));
    previewCtx.restore();
}

// ---- box drag/resize (capture-phase: caption-drag se priority) ----
let pzDrag = null;

document.addEventListener("mousedown", (e) => {
    if (e.target !== previewCanvas) return;
    const span = pzEditSpan();
    if (!span) return;
    // (FIX) click CAPTION ke bbox ke andar hai to CAPTION drag ko jeetne do —
    // pz capture-handler caption ke move/resize drags chura raha tha (pz span
    // selected/active hone par). Caption priority — pz baad mein check hoga.
    try {
        if (typeof inCaptionBBox === "function" && window.__captionBBox) {
            const r2 = previewCanvas.getBoundingClientRect();
            const cpx = (e.clientX - r2.left) * (previewCanvas.width / r2.width);
            const cpy = (e.clientY - r2.top) * (previewCanvas.height / r2.height);
            if (inCaptionBBox({ x: cpx, y: cpy })) return;
        }
    } catch (err) {}
    const rect = previewCanvas.getBoundingClientRect();
    if (!rect.width || !rect.height) return;
    const px = (e.clientX - rect.left) / rect.width;
    const py = (e.clientY - rect.top) / rect.height;
    const b = span.box || { x: 0, y: 0, w: 1, h: 1 };
    const tol = 0.035;
    const corners = { tl: [b.x, b.y], tr: [b.x + b.w, b.y], bl: [b.x, b.y + b.h], br: [b.x + b.w, b.y + b.h] };
    let corner = null;
    for (const k in corners) {
        const [cx2, cy2] = corners[k];
        if (Math.abs(px - cx2) < tol && Math.abs(py - cy2) < tol) { corner = k; break; }
    }
    if (corner) {
        pzDrag = { span, type: "resize-" + corner, startPx: px, startPy: py, orig: { ...b } };
        e.stopPropagation();
        e.preventDefault();
        return;
    }
    if (px >= b.x && px <= b.x + b.w && py >= b.y && py <= b.y + b.h) {
        pzDrag = { span, type: "move", startPx: px, startPy: py, orig: { ...b } };
        e.stopPropagation();
        e.preventDefault();
    }
}, true);

document.addEventListener("mousemove", (e) => {
    if (!pzDrag) return;
    const rect = previewCanvas.getBoundingClientRect();
    let px = (e.clientX - rect.left) / rect.width;
    let py = (e.clientY - rect.top) / rect.height;
    px = _layersClamp01(px);
    py = _layersClamp01(py);
    const b = pzDrag.span.box;
    if (pzDrag.type === "move") {
        b.x = Math.max(0, Math.min(1 - b.w, pzDrag.orig.x + (px - pzDrag.startPx)));
        b.y = Math.max(0, Math.min(1 - b.h, pzDrag.orig.y + (py - pzDrag.startPy)));
    } else {
        const anchorKey = pzDrag.type.slice(7); // "resize-" ke baad: "tl"/"tr"/"bl"/"br"
        const anchors = {
            tl: [pzDrag.orig.x + pzDrag.orig.w, pzDrag.orig.y + pzDrag.orig.h],
            tr: [pzDrag.orig.x, pzDrag.orig.y + pzDrag.orig.h],
            bl: [pzDrag.orig.x + pzDrag.orig.w, pzDrag.orig.y],
            br: [pzDrag.orig.x, pzDrag.orig.y],
        };
        const [ax, ay] = anchors[anchorKey];
        let x1 = Math.min(ax, px), x2 = Math.max(ax, px);
        let y1 = Math.min(ay, py), y2 = Math.max(ay, py);
        if (x2 - x1 < 0.05) x2 = x1 + 0.05;
        if (y2 - y1 < 0.05) y2 = y1 + 0.05;
        if (x2 > 1) { x2 = 1; x1 = Math.min(x1, x2 - 0.05); }
        if (y2 > 1) { y2 = 1; y1 = Math.min(y1, y2 - 0.05); }
        b.x = x1; b.y = y1; b.w = x2 - x1; b.h = y2 - y1;
    }
    // (HANG FIX) renderAll() yahan PER-MOUSEMOVE full-DOM rebuild kar raha tha.
    // Preview renderLoop 60fps par khud redraw karta hai (box span par live hai)
    // isliye yahan DOM render ki zaroorat nahi — sirf persist mouseup par.
});

document.addEventListener("mouseup", () => {
    if (pzDrag) {
        pzDrag = null;
        if (typeof persistTimelineState === "function") persistTimelineState();
    }
});

// ===== 6) TRANSITIONS =====

function findActiveTransition(t) {
    if (typeof t !== "number") return null;
    for (const tr of transitions) if (t >= tr.start && t < tr.end) return tr;
    return null;
}

// span ke andar video clip-boundary (end == next.start) — crossfade ke liye
function findBoundaryInSpan(tr) {
    const mid = (tr.start + tr.end) / 2;
    let best = null;
    for (const c of videoClips) {
        const nxt = videoClips.find((x) => Math.abs(x.start - c.end) < 0.02);
        if (!nxt) continue;
        const b = c.end;
        if (b > tr.start && b < tr.end) {
            if (best === null || Math.abs(b - mid) < Math.abs(best - mid)) best = b;
        }
    }
    return best;
}

// preview par transition effect apply (current-frame approximation — export
// mein real crossfade hota hai)
function transApplyToCanvas(canvas, ctx, t) {
    const tr = findActiveTransition(t);
    if (!tr || !canvas || !ctx) return;
    const dur = tr.duration || 0.6;
    const k = (tr.intensity || 60) / 100;
    const W = canvas.width, H = canvas.height;

    if (tr.type === "fadein") {
        const p = _layersClamp01((t - tr.start) / dur);
        if (p < 1) {
            ctx.fillStyle = `rgba(0,0,0,${((1 - p) * k).toFixed(3)})`;
            ctx.fillRect(0, 0, W, H);
        }
    } else if (tr.type === "fadeout") {
        const p = _layersClamp01((tr.end - t) / dur);
        if (p < 1) {
            ctx.fillStyle = `rgba(0,0,0,${((1 - p) * k).toFixed(3)})`;
            ctx.fillRect(0, 0, W, H);
        }
    } else if (tr.type === "crossfade") {
        const b = findBoundaryInSpan(tr);
        if (b !== null) {
            const a = _layersClamp01((t - (b - dur / 2)) / dur);
            // preview approximation: dip-through-dark (export mein A+B blend hai)
            ctx.fillStyle = `rgba(0,0,0,${(Math.sin(a * Math.PI) * 0.85 * k).toFixed(3)})`;
            ctx.fillRect(0, 0, W, H);
        }
    } else if (tr.type === "slideleft" || tr.type === "slideright" || tr.type === "zoomin") {
        const p = _layersClamp01((t - tr.start) / dur);
        if (p < 1) {
            const tmp = snapshotCanvas(canvas, "trans:" + tr.id);
            ctx.fillStyle = "#000";
            ctx.fillRect(0, 0, W, H);
            if (tr.type === "slideleft") {
                const off = (1 - p) * W * k;
                ctx.drawImage(tmp, -off, 0);
            } else if (tr.type === "slideright") {
                const off = (1 - p) * W * k;
                ctx.drawImage(tmp, off, 0);
            } else {
                const s = 1 + (1 - p) * 0.5 * k;
                const dw = W * s, dh = H * s;
                ctx.drawImage(tmp, (W - dw) / 2, (H - dh) / 2, dw, dh);
            }
        }
    }
}

// ===== 7) PANELS SYNC (selection ke hisaab se show/hide + values load) =====

function hideEffectPanels() {
    const tp = document.getElementById("transPanel");
    const pp = document.getElementById("pzPanel");
    if (tp) tp.style.display = "none";
    if (pp) pp.style.display = "none";
    const ttl = document.getElementById("titlesPanel");
    // (TITLES) titlesPanel auto-hide hota hai — selected title-span nahi ho to
    // (sirf panel-data show karo OPEN button se band);
}

function syncPanelsToSelection() {
    if (typeof selectedItems === "undefined") return;
    const sel = selectedItems[selectedItems.length - 1] || null;

    // ---- TRANSITIONS PANEL ----
    const tp = document.getElementById("transPanel");
    if (tp) {
        const tr = (sel && sel.kind === "transition") ? transitions.find((x) => x.id === sel.id) : null;
        if (tr) {
            tp.style.display = "block";
            // (NEW) type-grid highlight + target label (media-bin gallery panel)
            const tl = document.getElementById("transTargetLabel");
            if (tl) tl.textContent = `(${tr.start.toFixed(1)}s – ${tr.end.toFixed(1)}s)`;
            document.querySelectorAll(".trans-type-btn").forEach((b) => {
                b.classList.toggle("active", b.dataset.type === (tr.type || "crossfade"));
            });
            const typeEl = document.getElementById("transType");
            const durEl = document.getElementById("transDuration");
            const durVal = document.getElementById("transDurationVal");
            const intEl = document.getElementById("transIntensity");
            const intVal = document.getElementById("transIntensityVal");
            if (typeEl && document.activeElement !== typeEl) typeEl.value = tr.type || "crossfade";
            if (durEl && document.activeElement !== durEl) {
                durEl.value = tr.duration != null ? tr.duration : 0.6;
                if (durVal) durVal.textContent = (tr.duration != null ? tr.duration : 0.6) + "s";
            }
            if (intEl && document.activeElement !== intEl) {
                intEl.value = tr.intensity != null ? tr.intensity : 60;
                if (intVal) intVal.textContent = (tr.intensity != null ? tr.intensity : 60) + "%";
            }
        } else {
            tp.style.display = "none";
        }
    }

    // ---- TITLES PANEL sync (selected title-span → template/text values) ----
    // (USER FIX) title-span select karne par Titles panel AUTO-OPEN ho — pehle
    // sirf rebuild-hot-ho-state tha (panel pe se khula nahi to kuch nahi dikhta); 
    // ab jaise grade-panel wala auto-open pattern hai: open + values load. 
    // input-focus-loss guard: har render par sirf tab rebuild jis span ki id nai. 
    if (sel && sel.kind === "titleSpan") {
        const ts = (typeof titlesSpans !== "undefined") ? titlesSpans.find((s) => s.id === sel.id) : null;
        const wrap2 = document.getElementById("titlesPanel");
        if (ts && wrap2 && typeof buildTitlesPanel === "function") {
            if (wrap2.style.display !== "block") wrap2.style.display = "block";
            wrap2.dataset.autoForSpan = "1";
            if (__ttlPanelSyncId !== ts.id) {
                __ttlPanelSyncId = ts.id;
                if (typeof titlesPanelOpen !== "undefined") titlesPanelOpen = true; // button active-hover ke liye
                buildTitlesPanel();
            }
        }
    } else if (typeof __ttlPanelSyncId !== "undefined" && __ttlPanelSyncId) {
        __ttlPanelSyncId = null;
        // deselect → auto-open kiya hua panel band karo (user ne manually open 
        // kiya ho to rehne do — dataset se pata chal jata hai)
        const wrap2 = document.getElementById("titlesPanel");
        if (wrap2 && wrap2.dataset.autoForSpan === "1") {
            wrap2.style.display = "none";
            delete wrap2.dataset.autoForSpan;
            if (typeof titlesPanelOpen !== "undefined") titlesPanelOpen = false;
        }
    }

    // ---- PAN & ZOOM PANEL ----
    const pp = document.getElementById("pzPanel");
    if (pp) {
        const pz = (sel && sel.kind === "panZoom") ? panZoomSpans.find((x) => x.id === sel.id) : null;
        if (pz) {
            pp.style.display = "block";
            document.querySelectorAll(".pz-mode-btn").forEach((btn) => {
                btn.classList.toggle("active", btn.dataset.pzmode === (pz.mode || "static"));
            });
            // (NEW) zoom slider ko span ki value se sync (manual zoom control)
            const zz = document.getElementById("pzZoom");
            const zv = document.getElementById("pzZoomVal");
            if (zz && document.activeElement !== zz) {
                const z = (pz.zoom != null) ? pz.zoom : 1;
                zz.value = z;
                if (zv) zv.textContent = z.toFixed(2) + "x";
            }
        } else {
            pp.style.display = "none";
        }
    }

    // ---- GRADE PANEL panel-values ko selected span se sync ----
    // (USER FIX) gradeSpan select hote hi cgPanel AUTO-OPEN ho — pehle panel
    // kabhi khulta hi nahi tha (sirf topbar button se), isliye "options nahi
    // aate" + "kuch change nahi hota" lagta tha. Deselect par auto-hide.
    const cgPanel = document.getElementById("cgPanel");
    if (sel && sel.kind === "gradeSpan") {
        const span = gradeSpans.find((g) => g.id === sel.id);
        if (span) {
            if (cgPanel) {
                if (cgPanel.style.display !== "block") cgPanel.style.display = "block";
                cgPanel.dataset.autoForSpan = "1";
            }
            if (typeof colorGrade !== "undefined" && !_layersSameJson(span.grade, colorGrade)) {
                colorGrade = { ...span.grade };
                if (typeof cgSyncUI === "function") cgSyncUI();
            }
        }
    } else if (cgPanel && cgPanel.dataset.autoForSpan === "1") {
        cgPanel.style.display = "none";
        delete cgPanel.dataset.autoForSpan;
    }
    if (typeof cgUpdateTargetLabel === "function") cgUpdateTargetLabel();

    // ---- CAPTIONS PANEL: selected segment ke values se sync ----
    // (USER FIX) caption segment select → panel usi segment ka style/size/colors
    // dikhaye (multi-split layers me har segment ki apni style hoti hai).
    // Guard: sirf jab SELECTED SPAN BADLE — har render par rebuild se input
    // focus toot jata.
    if (sel && sel.kind === "captionSpan") {
        const cs = captionSpans.find((x) => x.id === sel.id);
        if (cs && __capPanelSyncId !== cs.id) {
            __capPanelSyncId = cs.id;
            if (typeof buildCaptionsPanel === "function") buildCaptionsPanel();
        }
    } else if (__capPanelSyncId) {
        // deselect → panel wapas playhead-span ke values par
        __capPanelSyncId = null;
        if (typeof buildCaptionsPanel === "function") buildCaptionsPanel();
    }
}
let __capPanelSyncId = null;
let __ttlPanelSyncId = null;

function wireEffectPanels() {
    // ---- transitions panel ----
    const tp = document.getElementById("transPanel");
    if (tp) {
        const closeBtn = document.getElementById("transCloseBtn");
        if (closeBtn) closeBtn.addEventListener("click", () => { tp.style.display = "none"; });
        const typeEl = document.getElementById("transType");
        const durEl = document.getElementById("transDuration");
        const intEl = document.getElementById("transIntensity");
        const commit = () => {
            if (typeof selectedItems === "undefined" || !selectedItems.length) return;
            const sel = selectedItems[selectedItems.length - 1];
            if (sel.kind !== "transition") return;
            const tr = transitions.find((x) => x.id === sel.id);
            if (!tr) return;
            if (typeEl) tr.type = typeEl.value;
            if (durEl) tr.duration = parseFloat(durEl.value);
            if (intEl) tr.intensity = parseFloat(intEl.value);
            if (typeof renderAll === "function") renderAll();
            persistTimelineState();
        };
        // (NEW) TYPE-GALLERY: har type-button click = selected transition span ka
        // type badlo (select-dropdown ki jagah — user ko visual options chahiye)
        document.querySelectorAll(".trans-type-btn").forEach((b) => {
            b.addEventListener("click", () => {
                if (typeof selectedItems === "undefined" || !selectedItems.length) return;
                const sel = selectedItems[selectedItems.length - 1];
                if (sel.kind !== "transition") return;
                const tr = transitions.find((x) => x.id === sel.id);
                if (!tr) return;
                tr.type = b.dataset.type;
                document.querySelectorAll(".trans-type-btn").forEach((x) => x.classList.toggle("active", x === b));
                if (typeof renderAll === "function") renderAll();
                persistTimelineState();
            });
        });
        // (NEW) panel ke andar bhi "+" — playhead par foran naya transition span
        const addBtn = document.getElementById("transAddBtn");
        if (addBtn) addBtn.addEventListener("click", () => {
            if (typeof createEffectSpan !== "function") return;
            if (typeof pausePlayback === "function") pausePlayback();
            if (typeof playPauseBtnEl !== "undefined" && playPauseBtnEl) playPauseBtnEl.textContent = "▶";
            const base = (typeof virtualTime === "number" && isFinite(virtualTime)) ? virtualTime : 0;
            createEffectSpan("transition", base, base + 2);
        });
        if (typeEl) typeEl.addEventListener("change", commit);
        if (durEl) durEl.addEventListener("input", () => {
            const v = document.getElementById("transDurationVal");
            if (v) v.textContent = parseFloat(durEl.value).toFixed(1) + "s";
            commit();
        });
        if (intEl) intEl.addEventListener("input", () => {
            const v = document.getElementById("transIntensityVal");
            if (v) v.textContent = durEl && false ? "" : parseInt(intEl.value, 10) + "%";
            commit();
        });
    }

    // ---- pz panel ----
    const pp = document.getElementById("pzPanel");
    if (pp) {
        const closeBtn = document.getElementById("pzCloseBtn");
        if (closeBtn) closeBtn.addEventListener("click", () => { pp.style.display = "none"; });
        document.querySelectorAll(".pz-mode-btn").forEach((btn) => {
            btn.addEventListener("click", () => {
                if (typeof selectedItems === "undefined" || !selectedItems.length) return;
                const sel = selectedItems[selectedItems.length - 1];
                if (sel.kind !== "panZoom") return;
                const pz = panZoomSpans.find((x) => x.id === sel.id);
                if (!pz) return;
                pz.mode = btn.dataset.pzmode;
                document.querySelectorAll(".pz-mode-btn").forEach((b) => b.classList.toggle("active", b === btn));
                if (typeof renderAll === "function") renderAll();
                persistTimelineState();
            });
        });
        const delBtn = document.getElementById("pzDeleteBtn");
        if (delBtn) delBtn.addEventListener("click", () => {
            if (typeof deleteSelected === "function") deleteSelected();
        });
        // (NEW) MANUAL ZOOM SLIDER — box ke andar zoom amount user khud set kare
        const pzZoomEl = document.getElementById("pzZoom");
        if (pzZoomEl) pzZoomEl.addEventListener("input", () => {
            if (typeof selectedItems === "undefined" || !selectedItems.length) return;
            const sel = selectedItems[selectedItems.length - 1];
            if (sel.kind !== "panZoom") return;
            const pz = panZoomSpans.find((x) => x.id === sel.id);
            if (!pz) return;
            pz.zoom = parseFloat(pzZoomEl.value);
            const zv = document.getElementById("pzZoomVal");
            if (zv) zv.textContent = pz.zoom.toFixed(2) + "x";
            if (typeof invalidateSnapshot === "function") invalidateSnapshot();
            persistTimelineState();
        });
    }
}
wireEffectPanels();

// ===== 8) DRAW WRAPPERS (preview par pz/trans overlay order theek karne ke liye) =====
// NOTE: pz/trans ka FRAME-transform crop_editor.js ke drawPreview ke andar se
// (captions se pehle) call hota hai — pzApplyToCanvas/transApplyToCanvas.
// Ye wrapper sirf BOX-OVERLAY (editing handles) draw karta hai.
const __origDrawPreview = (typeof drawPreview === "function") ? drawPreview : null;
if (__origDrawPreview) {
    drawPreview = function () {        __origDrawPreview();
        try {
            if (typeof pzDrawOverlay === "function") pzDrawOverlay();
        } catch (e) { console.warn("pz overlay error:", e); }
        // SHORTS CANVAS: edit-handles overlay (sab se upar — sirf panel khula ho)
        try {
            if (typeof scDrawOverlay === "function") scDrawOverlay(previewCtx);
        } catch (e) { console.warn("shorts overlay error:", e); }
    };
}

// ===== 9) INIT MIGRATION (purane saves → naye layers) =====
function migrateEffectLayers(stateData) {
    // (a) purana GLOBAL color grade → full-span grade layer (user choice)
    try {
        const g = stateData.colorGrade;
        const hasGrade = g && Object.keys(g).some((k) => (g[k] || 0) !== 0);
        if (hasGrade && (!gradeSpans || gradeSpans.length === 0)) {
            let end = 0;
            (stateData.videoClips || []).forEach((c) => { end = Math.max(end, c.end || 0); });
            (stateData.audioLanes || []).forEach((c) => { end = Math.max(end, c.end || 0); });
            if (end > 0) {
                gradeSpans = [{ id: genId(), start: 0, end, grade: { ...g } }];
                // global grade reset (ab layer-based hai)
                if (typeof colorGrade !== "undefined") {
                    Object.keys(colorGrade).forEach((k) => { colorGrade[k] = 0; });
                    if (typeof cgSyncUI === "function") cgSyncUI();
                }
            }
        }
    } catch (e) { console.warn("grade migrate:", e); }

    // (b) captions cues bina layer ke → auto full-span captions layer
    try {
        if ((stateData.captionCues || []).length && captionSpans.length === 0) {
            let end = 0;
            (stateData.videoClips || []).forEach((c) => { end = Math.max(end, c.end || 0); });
            syncCaptionLayerFromCues(end);
        }
    } catch (e) { console.warn("captions migrate:", e); }
}

// ===== 10) SUBTITLES PANEL (SRT / TXT download) =====

let subtitleCues = [];
let subPanelGenerated = false;

function subFmtSrt(t) {
    const h = Math.floor(t / 3600);
    const m = Math.floor((t % 3600) / 60);
    const s = Math.floor(t % 60);
    const ms = Math.round((t - Math.floor(t)) * 1000);
    return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")},${String(ms).padStart(3, "0")}`;
}

function subFmtShort(t) {
    const m = Math.floor(t / 60);
    const s = Math.floor(t % 60);
    return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

function renderSubtitlesList(cached) {
    const list = document.getElementById("subList");
    const hint = document.getElementById("subHint");
    if (!list) return;
    list.innerHTML = "";
    subtitleCues.forEach((c) => {
        const row = document.createElement("div");
        row.className = "sub-cue";
        const time = document.createElement("span");
        time.className = "sub-cue-time";
        time.textContent = `[${subFmtShort(c.start)} → ${subFmtShort(c.end)}]`;
        const txt = document.createElement("span");
        txt.textContent = c.text;
        row.appendChild(time);
        row.appendChild(txt);
        list.appendChild(row);
    });
    if (hint) {
        hint.textContent = subtitleCues.length
            ? (cached ? `⚡ Transcription CACHE se load hua (${subtitleCues.length} lines) — whisper dobara nahi chala.`
                      : `${subtitleCues.length} subtitle lines generated — agli dafa same video par cache se load hoga.`)
            : "Koi subtitle nahi mili — video mein clear audio honi chahiye.";
    }
}

async function generateSubtitles() {
    if (!currentVideoRef) return;
    const btn = document.getElementById("generateSubtitlesBtn");
    const label = btn ? btn.querySelector(".tool-label") : null;
    const original = label ? label.textContent : null;
    if (btn) btn.disabled = true;
    if (label) label.textContent = "Making…";

    try {
        const res = await fetch(`/video/${currentVideoRef.saved_name}/generate_subtitles`, { method: "POST" });
        const data = await res.json();
        if (data.error) { alert("Subtitles failed: " + data.error); return; }

        subtitleCues = (data.cues || []).map((c) => ({ start: c.start, end: c.end, text: c.text }));
        subPanelGenerated = true;

        const panel = document.getElementById("subtitlesPanel");
        if (panel) {
            panel.style.display = "block";
            const body = document.getElementById("subBody");
            const tog = document.getElementById("subCollapse");
            if (body) body.style.display = "";
            if (tog) tog.textContent = "▾";
        }
        renderSubtitlesList(!!data.cached);
    } catch (err) {
        alert("Subtitles error: " + err);
    } finally {
        if (btn) btn.disabled = false;
        if (label && original) label.textContent = original;
    }
}

// FIX: WebView2 (pywebview) native window mein blob-download (a.click) kaam
// nahi karta — video-export mein bhi isi liye Explorer-reveal pattern hai.
// Ab SRT/TXT bhi backend se exports/ folder mein file bana kar Explorer mein
// REVEAL hoti hai (folder khul kar file select hoti hai).
async function downloadSubtitlesFile(kind) {
    if (!subtitleCues.length) { alert("Pehle Subtitles generate karo."); return; }
    if (!currentVideoRef) return;
    try {
        const res = await fetch(`/video/${currentVideoRef.saved_name}/export_subtitles/${kind}`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ original_name: currentVideoRef.original_name || "" }),
        });
        const data = await res.json();
        if (data.error) { alert("Download fail: " + data.error); return; }
    } catch (err) {
        alert("Download error: " + err);
    }
}

function wireSubtitlesPanel() {
    const btn = document.getElementById("generateSubtitlesBtn");
    if (btn) btn.addEventListener("click", generateSubtitles);

    const srtBtn = document.getElementById("subDownloadSrt");
    if (srtBtn) srtBtn.addEventListener("click", () => downloadSubtitlesFile("srt"));
    const txtBtn = document.getElementById("subDownloadTxt");
    if (txtBtn) txtBtn.addEventListener("click", () => downloadSubtitlesFile("txt"));

    // collapse toggle
    const header = document.querySelector("#subtitlesPanel .sub-header");
    if (header) {
        header.addEventListener("click", () => {
            const body = document.getElementById("subBody");
            const tog = document.getElementById("subCollapse");
            if (body) body.style.display = body.style.display === "none" ? "" : "none";
            if (tog) tog.textContent = (body && body.style.display === "none") ? "▸" : "▾";
        });
    }

    // media-bin collapse par subtitles panel bhi fold (app.js wala pattern)
    const mediaBin = document.getElementById("mediaBin");
    if (mediaBin) {
        mediaBin.addEventListener("click", () => {
            setTimeout(() => {
                const panel = document.getElementById("subtitlesPanel");
                if (!panel) return;
                if (mediaBin.classList.contains("collapsed")) panel.style.display = "none";
                else if (subPanelGenerated) panel.style.display = "block";
            }, 0);
        });
    }
}
wireSubtitlesPanel();
