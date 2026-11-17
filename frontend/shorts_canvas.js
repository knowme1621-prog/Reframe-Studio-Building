// ===== SHORTS CANVAS ENGINE (shorts_canvas.js) =====
// 16:9 video ko 9:16 (shorts) window me place karna:
//   Canvas 1 = background me SAME video blur hui (blur level adjustable)
//   Canvas 2 = background me solid COLOR (color picker)
// Video ka SIZE aur POSITION adjustable (sliders + preview par direct drag/resize
// — sab corners se). SIZE aur POSITION ki saved settings ALAG-ALAG save hoti hain
// (Save Size / Save Position) — Shorts Canvas ON hote hi dono auto-apply.
//
// Integration:
// - crop_editor.js drawPreview -> scApplyToPreview(...) (9:16 output canvas)
// - layers.js drawPreview wrapper -> scDrawOverlay(...) (edit handles)
// - persistence: persistTimelineState payload "shortsCanvas" + localStorage

/* eslint-disable no-redeclare */

// ===== STATE =====
const SC_DEFAULTS = {
    mode: "blur",        // "blur" (Canvas 1) | "color" (Canvas 2)
    blurLevel: 14,       // 0-30 (Canvas 1)
    bgColor: "#000000",  // (Canvas 2)
    size: 1.0,           // 0.3-1.0 — video box scale (fit-width = 1.0)
    posX: 0.5,           // 0-1 — video box center
    posY: 0.5,
    wS: 1.0,             // width-stretch (edge-handles se single-edge resize)
    hS: 1.0,             // height-stretch
};
const SC_STORAGE_KEY = "scSavedSettings_v2"; // v2: size/pos ALAG saved

let scCur = { ...SC_DEFAULTS };
let scSavedSize = null;          // { size } ya null
let scSavedPos = null;           // { posX, posY } ya null
let shortsOn = false;
let scDrag = null;

// Load par saved size/pos uthao — "Shorts Canvas active hote hi saved settings
// ke mutabiq video place ho jaye"
try {
    const raw = localStorage.getItem(SC_STORAGE_KEY);
    if (raw) {
        const p = JSON.parse(raw);
        if (p) {
            if (p.size) scSavedSize = { ...p.size };
            if (p.pos) scSavedPos = { ...p.pos };
            if (p.cur) scCur = { ...SC_DEFAULTS, ...p.cur };
            shortsOn = !!p.enabled;
        }
    }
} catch (e) { /* corrupt storage — ignore */ }

function _scClamp01(v) { return Math.max(0, Math.min(1, Number(v) || 0)); }
function _scMarkDirty() {
    try { if (typeof persistTimelineState === "function") persistTimelineState(); } catch (e) {}
}

// ===== PANEL UI =====

function scSyncPanel() {
    const panel = document.getElementById("shortsPanel");
    if (!panel) return;
    const blurRow = document.getElementById("shortsBlurRow");
    const colorRow = document.getElementById("shortsColorRow");
    const modeBlur = document.getElementById("shortsModeBlur");
    const modeColor = document.getElementById("shortsModeColor");
    if (blurRow) blurRow.style.display = (scCur.mode === "blur") ? "flex" : "none";
    if (colorRow) colorRow.style.display = (scCur.mode === "color") ? "flex" : "none";
    if (modeBlur) modeBlur.classList.toggle("active", scCur.mode === "blur");
    if (modeColor) modeColor.classList.toggle("active", scCur.mode === "color");

    const blurEl = document.getElementById("shortsBlur");
    const blurVal = document.getElementById("shortsBlurVal");
    if (blurEl && document.activeElement !== blurEl) blurEl.value = scCur.blurLevel;
    if (blurVal) blurVal.textContent = scCur.blurLevel;
    const colorEl = document.getElementById("shortsColor");
    const colorVal = document.getElementById("shortsColorVal");
    if (colorEl && document.activeElement !== colorEl) colorEl.value = scCur.bgColor;
    if (colorVal) colorVal.textContent = scCur.bgColor;
    // EFFECTIVE digits: actual box se (size slider base dikhata tha — edge-stretch
    // ke baad user ko asli size/position ke numbers nazar nahi aate the)
    let sizePct = Math.round(scCur.size * 100);
    let hPct = sizePct;
    let xPct = Math.round(scCur.posX * 100);
    let yPct = Math.round(scCur.posY * 100);
    const pvC = document.getElementById("previewCanvas");
    if (pvC && pvC.width) {
        const eb = scBoxNormalized(pvC);
        sizePct = Math.round((eb.w / pvC.width) * 100);
        hPct = Math.round((eb.h / pvC.height) * 100);
        xPct = Math.round(((eb.x + eb.w / 2) / pvC.width) * 100);
        yPct = Math.round(((eb.y + eb.h / 2) / pvC.height) * 100);
    }
    // READOUT — EDITABLE inputs (number type karo + Enter = exact apply).
    // Jab tak user field me type kar raha hai, values overwrite NAHI karte.
    const roW = document.getElementById("scRoW");
    const roH = document.getElementById("scRoH");
    const roX = document.getElementById("scRoX");
    const roY = document.getElementById("scRoY");
    if (roW && document.activeElement !== roW) roW.value = sizePct;
    if (roH && document.activeElement !== roH) roH.value = hPct;
    if (roX && document.activeElement !== roX) roX.value = xPct;
    if (roY && document.activeElement !== roY) roY.value = yPct;
    const sizeEl = document.getElementById("shortsSize");
    const sizeVal = document.getElementById("shortsSizeVal");
    if (sizeEl && document.activeElement !== sizeEl) sizeEl.value = Math.max(30, Math.min(100, sizePct));
    if (sizeVal) sizeVal.textContent = sizePct + "%" + (scSavedSize ? " ●" : "");
    const pxEl = document.getElementById("shortsPosX");
    const pxVal = document.getElementById("shortsPosXVal");
    if (pxEl && document.activeElement !== pxEl) pxEl.value = xPct;
    if (pxVal) pxVal.textContent = xPct + "%";
    const pyEl = document.getElementById("shortsPosY");
    const pyVal = document.getElementById("shortsPosYVal");
    if (pyEl && document.activeElement !== pyEl) pyEl.value = yPct;
    if (pyVal) pyVal.textContent = yPct + "%" + (scSavedPos ? " ●" : "");

    const lbl = document.getElementById("shortsStateLabel");
    if (lbl) {
        const modeTxt = scCur.mode === "blur" ? "Canvas 1 · Blur" : "Canvas 2 · Color";
        const sv = [];
        if (scSavedSize) sv.push("size");
        if (scSavedPos) sv.push("pos");
        lbl.textContent = `(${modeTxt}${sv.length ? " · saved: " + sv.join("+") : ""})`;
    }
}

function scTogglePanel(force) {
    const panel = document.getElementById("shortsPanel");
    if (!panel) return;
    const show = (typeof force === "boolean") ? force : panel.style.display !== "block";
    panel.style.display = show ? "block" : "none";
    if (show) { scSetCollapsed(false); scSyncPanel(); }
}

// captions-panel jaisa collapse: sirf body fold, header bana rehta hai
function scSetCollapsed(collapsed) {
    const body = document.getElementById("shortsBody");
    const tog = document.getElementById("shortsCollapseBtn");
    if (body) body.style.display = collapsed ? "none" : "";
    if (tog) tog.textContent = collapsed ? "▸" : "▾";
}
function scToggleCollapse() {
    const body = document.getElementById("shortsBody");
    scSetCollapsed(!(body && body.style.display === "none"));
}

// Shorts Canvas ON hote hi media-bin EXPAND karo (warna panel column me
// dab jata tha / button chhup jata tha — user report)
function scEnsureBinExpanded() {
    try {
        const mediaBin = document.getElementById("mediaBin");
        if (!mediaBin) return;
        if (mediaBin.classList.contains("collapsed")) {
            mediaBin.classList.remove("collapsed");
            mediaBin.classList.add("expanded");
            const leftCol = document.querySelector(".left-column");
            if (leftCol) leftCol.classList.remove("bin-collapsed");
            const cp = document.getElementById("captionsPanel");
            const cpBody = document.getElementById("cpBody");
            const cpCollapse = document.getElementById("cpCollapse");
            if (cp) cp.classList.remove("cp-hidden");
            if (cpBody) cpBody.style.display = "";
            if (cpCollapse) cpCollapse.textContent = "▾";
        }
    } catch (e) {}
}

function wireShortsCanvas() {
    const toggleBtn = document.getElementById("shortsToggleBtn");
    if (toggleBtn) {
        toggleBtn.addEventListener("click", () => {
            shortsOn = !shortsOn;
            toggleBtn.classList.toggle("active", shortsOn);
            if (shortsOn) {
                // SAVED SETTINGS AUTO-APPLY (size aur pos alag-alag)
                if (scSavedSize) scCur.size = scSavedSize.size;
                if (scSavedPos) { scCur.posX = scSavedPos.posX; scCur.posY = scSavedPos.posY; }
                scEnsureBinExpanded();
                scTogglePanel(true);
            } else {
                scTogglePanel(false);
            }
            _scMarkDirty();
            scSyncPanel();
        });
        toggleBtn.classList.toggle("active", shortsOn);
    }
    const closeBtn = document.getElementById("shortsCloseBtn");
    if (closeBtn) closeBtn.addEventListener("click", () => scTogglePanel(false));

    // DROPDOWN-STYLE (captions menu jaisa): header collapse button — body fold
    // hota hai magar panel (slim header) media-bin me visible rehta hai; menu
    // kabhi "direct close" nahi hota jab tak Shorts Canvas ON hai
    const collapseBtn = document.getElementById("shortsCollapseBtn");
    if (collapseBtn) collapseBtn.addEventListener("click", () => scToggleCollapse());
    const headerEl = document.getElementById("shortsPanel");
    const header = headerEl ? headerEl.querySelector(".shorts-header") : null;
    if (header) header.addEventListener("click", (e) => {
        if (e.target === collapseBtn) return; // button ka apna handler
        scToggleCollapse();
    });

    const modeBlur = document.getElementById("shortsModeBlur");
    const modeColor = document.getElementById("shortsModeColor");
    if (modeBlur) modeBlur.addEventListener("click", () => { scCur.mode = "blur"; scSyncPanel(); _scMarkDirty(); });
    if (modeColor) modeColor.addEventListener("click", () => { scCur.mode = "color"; scSyncPanel(); _scMarkDirty(); });

    const bind = (id, fn) => {
        const el = document.getElementById(id);
        if (el) el.addEventListener("input", () => { fn(el); _scMarkDirty(); });
    };
    bind("shortsBlur", (el) => { scCur.blurLevel = parseInt(el.value, 10) || 0; const v = document.getElementById("shortsBlurVal"); if (v) v.textContent = scCur.blurLevel; });
    bind("shortsColor", (el) => { scCur.bgColor = el.value; const v = document.getElementById("shortsColorVal"); if (v) v.textContent = el.value; });
    bind("shortsSize", (el) => { scCur.size = parseInt(el.value, 10) / 100; scCur.wS = 1; scCur.hS = 1; const v = document.getElementById("shortsSizeVal"); if (v) v.textContent = el.value + "%" + (scSavedSize ? " ●" : ""); });
    bind("shortsPosX", (el) => { scCur.posX = parseInt(el.value, 10) / 100; const v = document.getElementById("shortsPosXVal"); if (v) v.textContent = el.value + "%"; });
    bind("shortsPosY", (el) => { scCur.posY = parseInt(el.value, 10) / 100; const v = document.getElementById("shortsPosYVal"); if (v) v.textContent = el.value + "%" + (scSavedPos ? " ●" : ""); });

    // ALAG-ALAG SAVE (user requirement): 1 size k liye, 1 position k liye
    // READOUT inputs: manually type karo → exact size/position apply
    const applyReadout = () => {
        const pvC2 = document.getElementById("previewCanvas");
        if (!pvC2 || !pvC2.width) return;
        const base = scBaseBox(pvC2);
        const W = pvC2.width, H = pvC2.height;
        const w = document.getElementById("scRoW");
        const h = document.getElementById("scRoH");
        const x = document.getElementById("scRoX");
        const y = document.getElementById("scRoY");
        if (w && w.value !== "") {
            const effW = (Math.max(5, Math.min(100, parseFloat(w.value) || 100)) / 100) * W;
            scCur.wS = Math.max(0.05, Math.min(4, effW / base.bw0));
        }
        if (h && h.value !== "") {
            const effH = (Math.max(5, Math.min(100, parseFloat(h.value) || 100)) / 100) * H;
            scCur.hS = Math.max(0.05, Math.min(4, effH / base.bh0));
        }
        if (x && x.value !== "") scCur.posX = _scClamp01((parseFloat(x.value) || 50) / 100);
        if (y && y.value !== "") scCur.posY = _scClamp01((parseFloat(y.value) || 50) / 100);
        _scMarkDirty();
        scSyncPanel();
    };
    ["scRoW", "scRoH", "scRoX", "scRoY"].forEach((id) => {
        const el = document.getElementById(id);
        if (!el) return;
        el.addEventListener("change", applyReadout);
        el.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); applyReadout(); el.blur(); } });
    });

    const saveSizeBtn = document.getElementById("shortsSaveSizeBtn");
    if (saveSizeBtn) saveSizeBtn.addEventListener("click", () => {
        scSavedSize = { size: scCur.size };
        _scStoreSaved();
        scSyncPanel();
    });
    const savePosBtn = document.getElementById("shortsSavePosBtn");
    if (savePosBtn) savePosBtn.addEventListener("click", () => {
        scSavedPos = { posX: scCur.posX, posY: scCur.posY };
        _scStoreSaved();
        scSyncPanel();
    });
    const resetBtn = document.getElementById("shortsResetBtn");
    if (resetBtn) resetBtn.addEventListener("click", () => {
        const mode = scCur.mode; // mode rehne do — sirf size/pos default
        scCur = { ...SC_DEFAULTS, mode };
        scSavedSize = null;
        scSavedPos = null;
        try { localStorage.removeItem(SC_STORAGE_KEY); } catch (e) {}
        scSyncPanel();
        _scMarkDirty();
    });

    scSyncPanel();
}

function _scStoreSaved() {
    try {
        const out = { enabled: shortsOn, cur: scCur };
        if (scSavedSize) out.size = scSavedSize;
        if (scSavedPos) out.pos = scSavedPos;
        localStorage.setItem(SC_STORAGE_KEY, JSON.stringify(out));
    } catch (e) {}
}

// ===== PREVIEW DRAG/RESIZE =====
// CAPTURE-phase (shorts_canvas.js layers.js se PEHLE load hota hai, isliye iska
// document-capture listener pz ke capture-handler se pehle chalta hai) — jab
// shorts-box pakra jaye to stopImmediatePropagation se pz-drag ko roko, warna
// active pz-span shorts drag chura leta tha (user report: size/position change
// nahi ho rahi thi).
function scSetupCanvasDrag() {
    const previewCanvas = document.getElementById("previewCanvas");
    if (!previewCanvas) return;

    document.addEventListener("mousedown", (e) => {
        if (!shortsOn || e.target !== previewCanvas) return;
        // caption-drag priority (caption bbox ke andar click = caption jeete)
        try {
            if (typeof inCaptionBBox === "function" && window.__captionBBox) {
                const r0 = previewCanvas.getBoundingClientRect();
                const cpx0 = (e.clientX - r0.left) * (previewCanvas.width / r0.width);
                const cpy0 = (e.clientY - r0.top) * (previewCanvas.height / r0.height);
                if (inCaptionBBox({ x: cpx0, y: cpy0 })) return;
            }
        } catch (err) {}
        const rect = previewCanvas.getBoundingClientRect();
        if (!rect.width || !rect.height) return;
        // CANVAS-PIXEL coords (box bhi canvas-px me hai — normalized me compare
        // karna hi wo bug tha jis se drag kabhi hit hi nahi hota tha)
        const px = ((e.clientX - rect.left) / rect.width) * previewCanvas.width;
        const py = ((e.clientY - rect.top) / rect.height) * previewCanvas.height;
        const b = scBoxNormalized(previewCanvas);
        const tolX = 0.06 * previewCanvas.width;   // aasan corner-grab
        const tolY = 0.06 * previewCanvas.height;
        const corners = { tl: [b.x, b.y], tr: [b.x + b.w, b.y], bl: [b.x, b.y + b.h], br: [b.x + b.w, b.y + b.h] };
        let corner = null;
        for (const k in corners) {
            const [cx, cy] = corners[k];
            if (Math.abs(px - cx) < tolX && Math.abs(py - cy) < tolY) { corner = k; break; }
        }
        // EDGE-CENTER handles: tc/bc = sirf height, lc/rc = sirf width (single-edge)
        const edges = { tc: [b.x + b.w / 2, b.y], bc: [b.x + b.w / 2, b.y + b.h], lc: [b.x, b.y + b.h / 2], rc: [b.x + b.w, b.y + b.h / 2] };
        let edge = null;
        if (!corner) {
            for (const k in edges) {
                const [ex, ey] = edges[k];
                if (Math.abs(px - ex) < tolX && Math.abs(py - ey) < tolY) { edge = k; break; }
            }
        }
        if (corner) {
            scDrag = { type: "resize-" + corner, startPx: px, startPy: py, orig: { ...b } };
            e.stopImmediatePropagation();
            e.preventDefault();
        } else if (edge) {
            scDrag = { type: "edge-" + edge, orig: { ...b } };
            e.stopImmediatePropagation();
            e.preventDefault();
        } else if (px >= b.x && px <= b.x + b.w && py >= b.y && py <= b.y + b.h) {
            scDrag = { type: "move", startPx: px, startPy: py, orig: { ...b } };
            e.stopImmediatePropagation();
            e.preventDefault();
        }
    }, true);

    document.addEventListener("mousemove", (e) => {
        if (!scDrag) return;
        const rect = previewCanvas.getBoundingClientRect();
        if (!rect.width || !rect.height) return;
        const W = previewCanvas.width, H = previewCanvas.height;
        const px = ((e.clientX - rect.left) / rect.width) * W;
        const py = ((e.clientY - rect.top) / rect.height) * H;
        const va = scVideoAspect();
        const o = scDrag.orig;
        if (scDrag.type === "move") {
            const dx = px - scDrag.startPx;
            const dy = py - scDrag.startPy;
            scCur.posX = _scClamp01((o.x + o.w / 2 + dx) / W);
            scCur.posY = _scClamp01((o.y + o.h / 2 + dy) / H);
        } else if (scDrag.type.startsWith("edge-")) {
            // SINGLE-EDGE resize: sirf pakri hui edge move karti hai, doosri
            // edge + doosri dimension ki position FIX rehti hai.
            const base = scBaseBox(previewCanvas);
            if (scDrag.type === "edge-tc" || scDrag.type === "edge-bc") {
                // top/bottom-center: sirf HEIGHT (top edge upar = lambi, niche = chhoti)
                let ny, nh;
                if (scDrag.type === "edge-tc") { ny = Math.max(0, Math.min(py, o.y + o.h - 20)); nh = o.y + o.h - ny; }
                else { ny = o.y; nh = Math.max(20, Math.min(py, H) - o.y); }
                nh = Math.min(nh, H);
                scCur.hS = Math.max(0.05, nh / base.bh0);
                scCur.posY = _scClamp01((ny + nh / 2) / H);
            } else {
                // left/right-center: sirf WIDTH
                let nx, nw;
                if (scDrag.type === "edge-lc") { nx = Math.max(0, Math.min(px, o.x + o.w - 20)); nw = o.x + o.w - nx; }
                else { nx = o.x; nw = Math.max(20, Math.min(px, W) - o.x); }
                nw = Math.min(nw, W);
                scCur.wS = Math.max(0.05, nw / base.bw0);
                scCur.posX = _scClamp01((nx + nw / 2) / W);
            }
        } else {
            // resize: grabbed corner ko cursor tak kheencho — video-aspect
            // bachao, doosra corner anchor rehta hai (sab canvas-px me)
            const anchor = (scDrag.type === "resize-tl") ? [o.x + o.w, o.y + o.h]
                : (scDrag.type === "resize-tr") ? [o.x, o.y + o.h]
                : (scDrag.type === "resize-bl") ? [o.x + o.w, o.y]
                : [o.x, o.y];
            let nw = Math.max(0.12 * W, Math.abs(px - anchor[0]));
            let nh = nw / va;
            if (nh > H) { nh = H; nw = nh * va; }
            let nx = (scDrag.type === "resize-tr" || scDrag.type === "resize-br") ? anchor[0] : anchor[0] - nw;
            let ny = (scDrag.type === "resize-bl" || scDrag.type === "resize-br") ? anchor[1] : anchor[1] - nh;
            nx = Math.max(0, Math.min(nx, W - nw));
            ny = Math.max(0, Math.min(ny, H - nh));
            // CORNER = proportional (poora box eik sath) — stretch reset
            scCur.wS = 1; scCur.hS = 1;
            scCur.size = Math.max(0.3, Math.min(1, nw / W));
            scCur.posX = _scClamp01((nx + nw / 2) / W);
            scCur.posY = _scClamp01((ny + nh / 2) / H);
        }
        scSyncPanel();
    });

    document.addEventListener("mouseup", () => {
        if (!scDrag) return;
        scDrag = null;
        _scMarkDirty();
        _scStoreSaved();
    });
}

// ===== GEOMETRY =====

function scVideoAspect() {
    const v = document.getElementById("mainPlayer");
    return (v && v.videoWidth && v.videoHeight) ? (v.videoWidth / v.videoHeight) : (16 / 9);
}

// size-derived ASPECT-LOCKED base box (stretch iske UPAR multiply hota hai)
function scBaseBox(canvas) {
    const W = canvas.width, H = canvas.height;
    const va = scVideoAspect();
    const target = W / H;
    let bw0, bh0;
    if (va > target) { bw0 = W * scCur.size; bh0 = bw0 / va; }
    else { bh0 = H * scCur.size; bw0 = bh0 * va; }
    return { bw0: Math.max(20, Math.min(bw0, W)), bh0: Math.max(20, Math.min(bh0, H)) };
}

// video box — CANVAS-PIXEL space (0..W, 0..H); wS/hS = edge-handle stretch
function scBoxNormalized(canvas) {
    const W = canvas.width, H = canvas.height;
    const base = scBaseBox(canvas);
    const bw = Math.max(20, Math.min(base.bw0 * (scCur.wS || 1), W));
    const bh = Math.max(20, Math.min(base.bh0 * (scCur.hS || 1), H));
    const cx = _scClamp01(scCur.posX) * W;
    const cy = _scClamp01(scCur.posY) * H;
    let x = cx - bw / 2;
    let y = cy - bh / 2;
    x = Math.max(0, Math.min(x, W - bw));
    y = Math.max(0, Math.min(y, H - bh));
    return { x, y, w: bw, h: bh };
}

// ===== RENDER — PREVIEW canvas (9:16 OUTPUT) =====
// (PLAYER canvas source-monitor rehta hai — shorts composition sirf 9:16
// output-preview par, wahi final result hai)
// returns true agar isne frame compose kar diya (caller caption/transform usi par
// chalaye), false agar shorts OFF (caller apna letterbox compose kare)

function scApplyToPreview(canvas, ctx, videoEl, vw, vh) {
    if (!shortsOn || !canvas || !ctx) return false;
    const W = canvas.width, H = canvas.height;
    // BACKGROUND — poori 9:16 window
    if (scCur.mode === "blur") {
        const lvl = Math.max(0, Number(scCur.blurLevel) || 0);
        if (lvl > 0) {
            const sigma = lvl * (W / 1080) * 1.2;
            ctx.save();
            ctx.filter = `blur(${sigma.toFixed(1)}px)`;
            // OVERSCAN: blur-filter ke edges transparent hote hain (kernel bahar
            // sample karta hai) — thoda bara draw karke falloff canvas se bahar
            // rakho, warna edges par niche wala content jhalakta hai.
            const pad = sigma * 2.5;
            ctx.drawImage(videoEl, 0, 0, vw, vh, -pad, -pad, W + pad * 2, H + pad * 2);
            ctx.restore();
        }
    } else {
        ctx.fillStyle = scCur.bgColor || "#000000";
        ctx.fillRect(0, 0, W, H);
    }
    // FOREGROUND — adjustable video box (aspect preserve)
    const b = scBoxNormalized(canvas);
    ctx.drawImage(videoEl, 0, 0, vw, vh, b.x, b.y, b.w, b.h);
    return true;
}

// edit-overlay (panel khula ho to handles dikhao — layers.js wrapper se call)
function scDrawOverlay(ctx) {
    if (!shortsOn || !ctx) return;
    const panel = document.getElementById("shortsPanel");
    if (!panel || panel.style.display !== "block") return;
    const canvas = ctx.canvas;
    const b = scBoxNormalized(canvas);
    ctx.save();
    ctx.strokeStyle = "#2fd07a";
    ctx.lineWidth = 2;
    ctx.strokeRect(b.x, b.y, b.w, b.h);
    ctx.fillStyle = "#2fd07a";
    const hs = 9;
    // 4 CORNERS (poora box proportional) + 4 EDGE-CENTERS (single-edge stretch)
    [[b.x, b.y], [b.x + b.w, b.y], [b.x, b.y + b.h], [b.x + b.w, b.y + b.h]].forEach(([hx, hy]) => {
        ctx.fillRect(hx - hs / 2, hy - hs / 2, hs, hs);
    });
    const er = 5;
    [[b.x + b.w / 2, b.y], [b.x + b.w / 2, b.y + b.h], [b.x, b.y + b.h / 2], [b.x + b.w, b.y + b.h / 2]].forEach(([hx, hy]) => {
        ctx.beginPath();
        ctx.arc(hx, hy, er, 0, Math.PI * 2);
        ctx.fill();
    });
    ctx.restore();
}

// ===== PERSISTENCE (timeline state ke sath) =====

function scPersistPayload() {
    if (!shortsOn) return null;
    return JSON.parse(JSON.stringify({
        enabled: true, mode: scCur.mode, blurLevel: scCur.blurLevel, bgColor: scCur.bgColor,
        size: scCur.size, posX: scCur.posX, posY: scCur.posY, wS: scCur.wS, hS: scCur.hS,
        savedSize: scSavedSize, savedPos: scSavedPos,
    }));
}

function scLoadFromState(sc) {
    if (!sc || typeof sc !== "object") return;
    shortsOn = !!sc.enabled;
    if (sc.mode) scCur.mode = sc.mode;
    if (sc.blurLevel != null) scCur.blurLevel = sc.blurLevel;
    if (sc.bgColor) scCur.bgColor = sc.bgColor;
    if (sc.size != null) scCur.size = sc.size;
    if (sc.posX != null) scCur.posX = sc.posX;
    if (sc.posY != null) scCur.posY = sc.posY;
    if (sc.wS != null) scCur.wS = sc.wS;
    if (sc.hS != null) scCur.hS = sc.hS;
    // saved size/pos alag-alag restore (per-project)
    if (sc.savedSize && sc.savedSize.size != null) scSavedSize = { size: sc.savedSize.size };
    if (sc.savedPos && sc.savedPos.posX != null) scSavedPos = { posX: sc.savedPos.posX, posY: sc.savedPos.posY };
    const toggleBtn = document.getElementById("shortsToggleBtn");
    if (toggleBtn) toggleBtn.classList.toggle("active", shortsOn);
    scSyncPanel();
}

// ===== INIT =====
try { wireShortsCanvas(); } catch (e) { console.warn("shorts canvas wire:", e); }
try { scSetupCanvasDrag(); } catch (e) { console.warn("shorts canvas drag:", e); }
