// ===== SPOTLIGHT MULTI-SCREEN =====
// Spotlight segment ke andar N screens hote hain (seg.screens[]). Har screen
// 9:16 OUTPUT-frame ke normalized coords par hai:
//   - SPOT shapes (circle/square/star/heart/hexagon/diamond/ring):
//     center (x,y) + radius r (out-width fraction) + zoom — content = S2 video
//     ka S1-spotlight-base-box ka ZOOMED square crop.
//   - "vertical" screen: FULL-HEIGHT vertical (9:16) crop screen — S2 video ka
//     vertical region, width = w (out-width fraction), height auto = w*16/9.
// Screens preview (9:16) par interactive hain: drag = move, knob = resize.
// Delete / Duplicate / Add Screen panel se. Player-canvas par sirf ghost guide.
//
// LEGACY: purane bubble params (bubbleState/bubbleZoom/...) wale segments ko
// load par 1 screen mein convert kar dete hain — koi purana project toota nahi.

const SPOTLIGHT_OUT_W = 1080;
const SPOTLIGHT_OUT_H = 1920;
const SPOT_HANDLE_HIT = 16; // px — resize-knob ka hit radius
const SPOT_SHAPES = ["circle", "square", "star", "heart", "hexagon", "diamond", "ring"];

let spotDrag = null; // { seg, screenId, type: "move"|"resize", grabDx, grabDy }
let spotSelectedScreenId = null;

function spotGenId() {
    return "scr_" + Math.random().toString(36).slice(2, 10);
}

// ===== SHAPE PATHS (7 designs) =====
// Preview (canvas) isi geometry se clip/draw karta hai; export_engine.py ka
// spot_shape_mask() isi ka numpy-mirror hai — dono EXACT match hone chahiye.
function spotShapePath(ctx, style, cx, cy, r) {
    ctx.beginPath();
    switch (style) {
        case "square":
            ctx.rect(cx - r, cy - r, r * 2, r * 2);
            break;
        case "star": {
            const Ri = r * 0.42;
            for (let i = 0; i < 10; i++) {
                const ang = -Math.PI / 2 + i * Math.PI / 5;
                const rad = (i % 2 === 0) ? r : Ri;
                const x = cx + Math.cos(ang) * rad;
                const y = cy + Math.sin(ang) * rad;
                if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
            }
            ctx.closePath();
            break;
        }
        case "heart": {
            const K = r / 16;
            ctx.moveTo(cx, cy + 0.5 * K);
            ctx.bezierCurveTo(cx, cy - 2.5 * K, cx - 7 * K, cy - 12.5 * K, cx - 12 * K, cy - 9.5 * K);
            ctx.bezierCurveTo(cx - 16 * K, cy - 6.5 * K, cx - 14 * K, cy + 0.5 * K, cx - 8 * K, cy + 5.5 * K);
            ctx.bezierCurveTo(cx - 4.5 * K, cy + 9 * K, cx, cy + 11.5 * K, cx, cy + 12.5 * K);
            ctx.bezierCurveTo(cx, cy + 11.5 * K, cx + 4.5 * K, cy + 9 * K, cx + 8 * K, cy + 5.5 * K);
            ctx.bezierCurveTo(cx + 14 * K, cy + 0.5 * K, cx + 16 * K, cy - 6.5 * K, cx + 12 * K, cy - 9.5 * K);
            ctx.bezierCurveTo(cx + 7 * K, cy - 12.5 * K, cx, cy - 2.5 * K, cx, cy + 0.5 * K);
            ctx.closePath();
            break;
        }
        case "hexagon": {
            for (let i = 0; i < 6; i++) {
                const ang = -Math.PI / 2 + i * Math.PI / 3;
                const x = cx + Math.cos(ang) * r;
                const y = cy + Math.sin(ang) * r;
                if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
            }
            ctx.closePath();
            break;
        }
        case "diamond":
            ctx.moveTo(cx, cy - r);
            ctx.lineTo(cx + r * 0.7, cy);
            ctx.lineTo(cx, cy + r);
            ctx.lineTo(cx - r * 0.7, cy);
            ctx.closePath();
            break;
        case "ring":
        case "circle":
        default:
            ctx.arc(cx, cy, r, 0, Math.PI * 2);
            break;
    }
    ctx.closePath();
}

function findSpotlightSeg() {
    if (typeof virtualTime !== "undefined") {
        for (const s of segments) {
            if (s.mode === "spotlight" && virtualTime >= s.start && virtualTime < s.end) return s;
        }
    }
    if (typeof selectedSegmentId !== "undefined" && selectedSegmentId) {
        const sel = (typeof getSegmentById === "function") ? getSegmentById(selectedSegmentId) : null;
        if (sel && sel.mode === "spotlight") return sel;
    }
    return null;
}

function spotMainVideoEl() {
    // S2 SOURCE SYSTEM REMOVED (user ka model): "jo bhi cropping hogi wo 16:9
    // ki video par hogi" — screens MAIN video se crop hoti hain, koi alag S2
    // video element nahi.
    if (typeof getBaseVideoElement === "function") {
        const el = getBaseVideoElement();
        if (el) return el;
    }
    return (typeof mainPlayer !== "undefined") ? mainPlayer : null;
}

function spotlightNeedsSource() {
    // S2 hidden-video system khatam — main video hi source hai
    return false;
}

function isSpotlightActive() {
    return !!findSpotlightSeg();
}

// ===== SCREENS MODEL + LEGACY MIGRATION =====
function defaultScreen(x, y, r) {
    return {
        id: spotGenId(),
        kind: "spot",            // "spot" (shape) | "vertical" (full-height vertical crop)
        shape: "circle",         // spot shapes
        x, y, r,                 // center + radius (out-width fraction)
        w: 0.45,                 // vertical screen width (out-width fraction)
        srcX: x,                 // vertical: SOURCE-crop center (16:9 window par drag hota hai)
        zoom: 1.6,
        border: { color: "#ffffff", width: 8 },
        shadow: { enabled: true },
    };
}

function ensureScreens(seg) {
    if (!seg.screens || !seg.screens.length) {
        // FIX: 0 screens after user-delete ab RESURRECT nahi hoti — spotlight
        // mode hi switch ho jata hai (deleteScreen me). Legacy bubbles hi yahan
        // migrate hote hain.
        if (seg.bubbleState) {
            seg.screens = [{
                ...defaultScreen(seg.bubbleState.x, seg.bubbleState.y, seg.bubbleState.r),
                id: spotGenId(),
                shape: seg.bubbleStyle && SPOT_SHAPES.includes(seg.bubbleStyle) ? seg.bubbleStyle : "circle",
                zoom: (seg.bubbleZoom !== undefined) ? seg.bubbleZoom : 1.6,
                border: seg.bubbleBorder || { color: "#ffffff", width: 8 },
                shadow: seg.bubbleShadow || { enabled: true },
            }];
        } else {
            seg.screens = [defaultScreen(0.5, 0.38, 0.17)];
        }
    }
    // migrate: srcX backfill — vertical screens ka source-crop ab 16:9 window
    // par drag hota hai (pehle output-x hi source tha, ab dono alag hain)
    seg.screens.forEach((scr) => {
        if (scr.srcX === undefined) scr.srcX = scr.x;
        if (scr.srcY === undefined) scr.srcY = 0.5;
        // SHAPE MODEL (user ka final): shape 16:9 par PLACE hoti hai (srcX/srcY/
        // srcR = crop-area selection) -> wahi shape-area usi shape mein 9:16 par
        // dikhta hai. srcW/srcR backfill defaults.
        if (scr.srcW === undefined) scr.srcW = 0.25;
        if (scr.srcR === undefined && scr.kind !== "vertical") scr.srcR = 0.15;
        // VERTICAL BORDER-LESS (user): vertical screens par koi border nahi
        if (scr.kind === "vertical" && scr.border && scr.border.width === undefined) scr.border.width = 0;
    });
    return seg.screens;
}

function getSelectedScreen(seg) {
    // FIX: pehle ensureScreens(seg) ka ARRAY yahan pass hota tha -> andar phir
    // ensureScreens chalte huye THROWAWAY screen banti thi (asli screen kabhi
    // update nahi hoti thi). Ab array ho to direct list, warna seg.
    const list = Array.isArray(seg) ? seg : ensureScreens(seg);
    let s = list.find((x) => x.id === spotSelectedScreenId);
    if (!s) { s = list[0]; spotSelectedScreenId = s.id; }
    return s;
}

// ===== S2 SOURCE (hidden video element) =====
// S2 ab UI mein koi ALAG row nahi hai — ye sirf SPOTLIGHT ka source hai.
// Stack-2 data auto-full ho jata hai: koi S2 clip na ho to poori video
// duplicate hoti hai (start=0, end=sourceDuration), extra disk-copy nahi.
function ensureSpotlightSource() {
    // NO-OP: S2 auto-duplicate system removed — screens main video se crop
    // hoti hain (koi stack-2 clip/element nahi banta)
}

// ===== ONE-CLICK SETUP =====
// '◎ Spotlight' button: active segment = spotlight mode (+ default screen).
function setupSpotlight() {
    if (typeof currentVideoRef === "undefined" || !currentVideoRef) { alert("Pehle video upload karo!"); return; }
    if (typeof pushHistory === "function") pushHistory();
    ensureSpotlightSource();

    let seg = (typeof getActiveSegment === "function") ? getActiveSegment() : null;
    if (!seg) {
        const t = typeof virtualTime !== "undefined" ? virtualTime : 0;
        seg = { id: (typeof genId === "function") ? genId() : spotGenId(), start: t, end: Math.min(sourceDuration, t + 5), mode: "single", modeBoxState: {}, muted: false, audioDetached: false };
        segments.push(seg);
        if (typeof selectOnly === "function") selectOnly("segment", seg.id);
    }
    seg.mode = "spotlight";
    ensureScreens(seg);
    spotSelectedScreenId = seg.screens[0].id;

    if (typeof renderAll === "function") renderAll();
    if (typeof persistTimelineState === "function") persistTimelineState();
}

// ===== DRAW (crop_editor renderLoop har frame call karta hai) =====
function drawSpotlightOverlay() {
    const panel = document.getElementById("spotlightCtrls");
    const active = isSpotlightActive();
    if (panel) panel.style.display = active ? "block" : "none";
    if (!active) return;
    if (typeof videoSeekGuard !== "undefined" && videoSeekGuard > 0) return;

    // FIX: ensureScreens() screens-ARRAY return karta hai (segment NAHI) —
    // pehle ye seg = array ho jata tha -> seg.screens undefined -> har-frame
    // crash -> POORA spotlight (draw/drag/panel) dead. Ab seg pehle lo:
    const seg = findSpotlightSeg();
    if (!seg) return;
    ensureScreens(seg);

    // S2 REMOVED: content MAIN video se aata hai
    const s2el = spotMainVideoEl();
    const hasS2 = !!(s2el && s2el.readyState >= 2 && s2el.videoWidth > 0);

    renderScreensList(seg);

    // Preview: vertical strips ke beech magnet-guide (jab snap ho raha ho)
    if (window.__spotSnapEdge != null) {
        previewCtx.save();
        previewCtx.strokeStyle = "rgba(143, 123, 255, 0.9)";
        previewCtx.lineWidth = 1.5;
        previewCtx.setLineDash([4, 4]);
        const sx = window.__spotSnapEdge * previewCanvas.width;
        previewCtx.beginPath(); previewCtx.moveTo(sx, 0); previewCtx.lineTo(sx, previewCanvas.height); previewCtx.stroke();
        previewCtx.restore();
    }

    // base box AB sirf LEGACY fallback hai — shape content ab scr.src* se aata hai
    const boxes = (typeof getSegmentBoxes === "function") ? getSegmentBoxes(seg, "spotlight") : null;
    const baseBox = (boxes && boxes[0]) ? boxes[0] : { x: 0.22, y: 0, w: 0.56, h: 1 };

    // ---------- PREVIEW CANVAS: SCREENS ----------
    seg.screens.forEach((scr, idx) => {
        const selected = scr.id === spotSelectedScreenId;
        if (scr.kind === "vertical") {
            drawVerticalScreen(scr, idx, selected, s2el, hasS2);
        } else {
            drawSpotScreen(scr, idx, selected, s2el, hasS2, baseBox, seg);
        }
        // NEW MODEL: vertical screen ka SOURCE-box 16:9 window par bhi dikhe
        // (wahan drag hota hai — ye crop REGION hai, 9:16 usi se bharta hai)
    });

    // ---------- PLAYER CANVAS (16:9) — SOURCE-PLACE WINDOW ----------
    // USER MODEL: 16:9 par DONO tarah ki screens place hoti hain:
    //   - vertical: portrait source-box (srcX/srcY/srcW)
    //   - shapes: SHAPE outline hi 16:9 par place/resize hoti hai (srcX/srcY/
    //     srcR) — jo area shape ke andar select hoga WAHI shape mein 9:16 par
    //     dikhega. 6-point resize handles (2 top + 2 center + 2 bottom).
    computeFitRect();
    if (fitRect.w > 0) {
        seg.screens.forEach((scr, vIdx) => {
            const sel = scr.id === spotSelectedScreenId;
            const stroke = sel ? "#2f7bff" : "rgba(47,123,255,0.55)";
            playerCtx.save();
            playerCtx.lineWidth = sel ? 2.5 : 1.5;
            playerCtx.strokeStyle = stroke;
            if (!sel) playerCtx.setLineDash([7, 6]);
            playerCtx.fillStyle = sel ? "#2f7bff" : "rgba(47,123,255,0.8)";
            playerCtx.font = "bold 12px Arial";
            if (scr.kind === "vertical") {
                const { x0, y0, w, h } = srcBoxPx(scr, fitRect);
                playerCtx.strokeRect(x0, y0, w, h);
                playerCtx.setLineDash([]);
                playerCtx.fillText("SRC " + (vIdx + 1), x0 + 5, y0 + 15);
            } else {
                const { cx, cy, r } = srcShapePx(scr, fitRect);
                spotShapePath(playerCtx, scr.shape, cx, cy, r);
                playerCtx.stroke();
                playerCtx.setLineDash([]);
                playerCtx.fillText("SRC " + (vIdx + 1), cx - r + 5, cy - r + 15);
            }
            playerCtx.setLineDash([]);
            // 6-point resize handles (sirf selected par)
            if (sel) {
                const pts = (scr.kind === "vertical") ? srcBoxHandlePoints(scr, fitRect) : srcShapeHandlePoints(scr, fitRect);
                playerCtx.fillStyle = "#2f7bff";
                pts.forEach((p) => {
                    playerCtx.beginPath();
                    playerCtx.arc(p.px, p.py, 5, 0, Math.PI * 2);
                    playerCtx.fill();
                });
            }
            playerCtx.restore();
        });
    }

    // ---------- PANEL SYNC ----------
    syncScreenControls(getSelectedScreen(seg));
}

// vertical screen = FULL-HEIGHT strip (user ka V1 + V1-dup layout):
// x = strip center (adjustable), y = FIXED 0.5, height = poori 9:16 output.
// Content = S2 video ka full-height portrait window (strip-aspect-correct),
// jiska center scr.x par hai — strip drag karo to crop window bhi chalti hai.
function stripRect(scr) {
    const w = scr.w * previewCanvas.width;
    const cx = scr.x * previewCanvas.width;
    return { x0: cx - w / 2, y0: 0, w, h: previewCanvas.height, cx };
}

function drawVerticalScreen(scr, idx, selected, s2el, hasS2) {
    const R = stripRect(scr);
    const cy = previewCanvas.height / 2;

    // content: MAIN video ka source-crop (scr.srcX/srcY = 16:9 window par jo
    // area select hua hai) — 9:16 strip usi se bharta hai
    if (hasS2) {
        const srcW = s2el.videoWidth, srcH = s2el.videoHeight;
        // SOURCE-CROP (user ka model): 16:9 video par jo portrait area select
        // hua (center scr.srcX/srcY) — wahi 9:16 strip ko full fill karta hai.
        // Aspect-correct fill: crop-AR (px) = strip-AR (px).
        const stripAR = R.w / previewCanvas.height;          // w_px/h_px
        let cW = scr.srcW || 0.25;                            // crop width (source-frac)
        let cH = cW * (srcW / srcH) / stripAR;                // aspect-correct height
        if (cH > 1) { cH = 1; cW = cH * stripAR * (srcH / srcW); }
        const cxs = Math.max(0, Math.min(scr.srcX - cW / 2, 1 - cW));
        const cys = Math.max(0, Math.min((scr.srcY || 0.5) - cH / 2, 1 - cH));
        previewCtx.save();
        try {
            previewCtx.drawImage(s2el, cxs * srcW, cys * srcH, cW * srcW, cH * srcH, R.x0, R.y0, R.w, R.h);
        } catch (e) { /* frame ready nahi */ }
        previewCtx.restore();
        // BORDER-LESS (user): vertical screen par koi white border nahi
    } else {
        previewCtx.save();
        previewCtx.fillStyle = "rgba(20,20,28,0.85)";
        previewCtx.fillRect(R.x0, R.y0, R.w, R.h);
        previewCtx.strokeStyle = "#ff6b6b";
        previewCtx.setLineDash([6, 4]);
        previewCtx.strokeRect(R.x0, R.y0, R.w, R.h);
        previewCtx.setLineDash([]);
        previewCtx.fillStyle = "#ff6b6b";
        previewCtx.font = "bold 11px Arial";
        previewCtx.textAlign = "center";
        previewCtx.fillText("V" + (idx + 1) + " — video loading...", R.cx, cy);
        previewCtx.textAlign = "left";
        previewCtx.restore();
    }

    // selection chrome + 6-point resize handles (2 top + 2 center + 2 bottom)
    if (selected) {
        previewCtx.save();
        previewCtx.lineWidth = 2;
        previewCtx.setLineDash([5, 4]);
        previewCtx.strokeStyle = "#ffb020";
        previewCtx.strokeRect(R.x0 - 3, R.y0 + 3, R.w + 6, R.h - 6);
        previewCtx.setLineDash([]);
        previewCtx.fillStyle = "#ffb020";
        outStripHandlePoints(scr).forEach((p) => {
            previewCtx.beginPath();
            previewCtx.arc(p.px, p.py, 5, 0, Math.PI * 2);
            previewCtx.fill();
        });
        previewCtx.restore();
    }
}

function drawSpotScreen(scr, idx, selected, s2el, hasS2, baseBox, seg) {
    const cx = scr.x * previewCanvas.width;
    const cy = scr.y * previewCanvas.height;
    const r = scr.r * previewCanvas.width;
    const isRing = scr.shape === "ring";

    if (hasS2 && !isRing) {
        // USER MODEL (final): shape 16:9 par PLACE hui thi (srcX/srcY/srcR) —
        // jo area shape ke andar select hua WAHI shape mein 9:16 par dikhta hai.
        // (base-box zoom legacy fallback hai — sirf jab srcR set hi na ho)
        const srcW = videoNaturalW || s2el.videoWidth, srcH = videoNaturalH || s2el.videoHeight;
        let sqX, sqY, side;
        if (scr.srcR !== undefined) {
            // PLAYER par circle = center (srcX, srcY) + radius srcR (width-frac);
            // fitRect aspect-fit hai isliye video-px me radius isotropic =
            // srcR*srcW. Sample-square = usi circle ka bounding square.
            // (Purani formula me Y-offset me OUT_W/OUT_H = 9/16 ka ghalat
            // factor tha — 9:16 content select-kiya-hua area nahi dikhata tha)
            const R = scr.srcR || 0.15;
            side = Math.min(2 * R * srcW, srcW, srcH);
            sqX = scr.srcX * srcW - side / 2;
            sqY = ((scr.srcY != null) ? scr.srcY : 0.5) * srcH - side / 2;
            sqX = Math.max(0, Math.min(sqX, srcW - side));
            sqY = Math.max(0, Math.min(sqY, srcH - side));
        } else {
            const zoom = Math.max(1, scr.zoom || 1.6);
            const zw = baseBox.w / zoom, zh = baseBox.h / zoom;
            const zx = baseBox.x + baseBox.w / 2 - zw / 2;
            const zy = baseBox.y + baseBox.h / 2 - zh / 2;
            side = Math.min(zw * srcW, zh * srcH);
            sqX = Math.max(0, Math.min(zx * srcW + (zw * srcW - side) / 2, srcW - side));
            sqY = Math.max(0, Math.min(zy * srcH + (zh * srcH - side) / 2, srcH - side));
        }

        // shadow
        if (scr.shadow && scr.shadow.enabled) {
            previewCtx.save();
            previewCtx.shadowColor = "rgba(0,0,0,0.5)";
            previewCtx.shadowBlur = 16;
            previewCtx.shadowOffsetY = 6;
            previewCtx.fillStyle = "rgba(0,0,0,0.01)";
            spotShapePath(previewCtx, scr.shape, cx, cy + 0.5, r);
            previewCtx.fill();
            previewCtx.restore();
        }
        // content
        previewCtx.save();
        spotShapePath(previewCtx, scr.shape, cx, cy, r);
        previewCtx.clip();
        try {
            previewCtx.drawImage(s2el, sqX, sqY, side, side, cx - r, cy - r, r * 2, r * 2);
        } catch (e) { /* frame ready nahi */ }
        previewCtx.restore();
        // border
        // border — ZERO bhi valid value hai (0 || 8 falsy bug: 0 par 8px draw
        // hota tha — user 0 set karta tha phir bhi border dikhta tha)
        const bw = (scr.border && scr.border.width != null) ? Number(scr.border.width) : 8;
        if (bw > 0) {
            previewCtx.save();
            previewCtx.lineWidth = bw;
            previewCtx.strokeStyle = (scr.border && scr.border.color) || "#ffffff";
            spotShapePath(previewCtx, scr.shape, cx, cy, r);
            previewCtx.stroke();
            previewCtx.restore();
        }
    } else if (!isRing) {
        previewCtx.save();
        previewCtx.fillStyle = "rgba(20,20,28,0.85)";
        spotShapePath(previewCtx, scr.shape, cx, cy, r);
        previewCtx.fill();
        previewCtx.strokeStyle = "#ff6b6b";
        previewCtx.setLineDash([6, 4]);
        previewCtx.stroke();
        previewCtx.setLineDash([]);
        previewCtx.fillStyle = "#ff6b6b";
        previewCtx.font = "bold 11px Arial";
        previewCtx.textAlign = "center";
        previewCtx.fillText("video loading...", cx, cy);
        previewCtx.textAlign = "left";
        previewCtx.restore();
    }

    // selection chrome + resize knob (45°)
    if (selected) {
        previewCtx.save();
        previewCtx.lineWidth = isRing ? 3 : 2;
        previewCtx.setLineDash(isRing ? [8, 6] : [4, 4]);
        previewCtx.strokeStyle = isRing ? "#00e5ff" : "rgba(255, 176, 32, 0.9)";
        spotShapePath(previewCtx, scr.shape, cx, cy, r * 1.06);
        previewCtx.stroke();
        previewCtx.setLineDash([]);
        const kx = cx + r * 0.7071, ky = cy + r * 0.7071;
        previewCtx.fillStyle = "#ffb020";
        previewCtx.beginPath();
        previewCtx.arc(kx, ky, 5, 0, Math.PI * 2);
        previewCtx.fill();
        previewCtx.restore();
    } else {
        // non-selected spot shapes: halka number tag (screen identify karne ke liye)
        previewCtx.save();
        previewCtx.fillStyle = "rgba(255,176,32,0.9)";
        previewCtx.beginPath();
        previewCtx.arc(cx, cy - (scr.r * previewCanvas.width) - 10, 8, 0, Math.PI * 2);
        previewCtx.fill();
        previewCtx.fillStyle = "#1a1a24";
        previewCtx.font = "bold 9px Arial";
        previewCtx.textAlign = "center";
        previewCtx.fillText(String(idx + 1), cx, cy - (scr.r * previewCanvas.width) - 7);
        previewCtx.textAlign = "left";
        previewCtx.restore();
    }
}

// ===== SCREENS LIST PANEL =====
function renderScreensList(seg) {
    const listEl = document.getElementById("spScreenList");
    if (!listEl || !seg || !seg.screens) return;
    const key = seg.id + ":" + seg.screens.map((s) => s.id).join(",");
    if (listEl.dataset.key === key) return;
    listEl.dataset.key = key;
    listEl.innerHTML = "";
    seg.screens.forEach((scr, i) => {
        const row = document.createElement("div");
        row.className = "sp-screen-row" + (scr.id === spotSelectedScreenId ? " selected" : "");
        const icon = scr.kind === "vertical" ? "▤" : ({ circle: "●", square: "■", star: "★", heart: "♥", hexagon: "⬡", diamond: "◆", ring: "◌" }[scr.shape] || "●");
        row.innerHTML = `<span class="sp-screen-ic">${icon}</span><span class="sp-screen-name">Screen ${i + 1}${scr.kind === "vertical" ? " (Vertical)" : ""}</span>`;
        row.addEventListener("click", () => { spotSelectedScreenId = scr.id; listEl.dataset.key = null; });
        const del = document.createElement("button");
        del.className = "sp-screen-del";
        del.title = "Screen delete";
        del.textContent = "✕";
        del.addEventListener("click", (e) => { e.stopPropagation(); deleteScreen(seg, scr.id); });
        row.appendChild(del);
        listEl.appendChild(row);
    });
    const empty = document.createElement("div");
    empty.className = "sp-screen-empty";
    empty.textContent = seg.screens.length ? "" : "Koi screen nahi — Add Screen dabao";
    listEl.appendChild(empty);
}

function addScreen(kind) {
    const seg = findSpotlightSeg();
    if (!seg) return;
    ensureScreens(seg);
    const last = seg.screens[seg.screens.length - 1];
    const scr = defaultScreen(
        last ? Math.min(0.92, last.x + 0.18) : 0.5,
        last ? Math.min(0.85, last.y + 0.12) : 0.38,
        last ? last.r : 0.17
    );
    // 16:9 SOURCE-PLACE defaults (user model): shape 16:9 par center-place
    scr.srcX = 0.5; scr.srcY = 0.5; scr.srcR = 0.15;
    if (kind === "vertical") {
        scr.kind = "vertical";
        scr.w = 0.45;
        scr.x = 0.5; scr.y = 0.5;
        // source-crop (16:9 window par): default center portrait area
        scr.srcX = 0.5; scr.srcY = 0.5; scr.srcW = 0.25;
        scr.border = { color: "#ffffff", width: 0 }; // BORDER-LESS (user)
    }
    seg.screens.push(scr);
    spotSelectedScreenId = scr.id;
    if (typeof persistTimelineState === "function") persistTimelineState();
}

function duplicateScreen() {
    const seg = findSpotlightSeg();
    if (!seg) return;
    ensureScreens(seg);
    const src = getSelectedScreen(seg);
    const copy = JSON.parse(JSON.stringify(src));
    copy.id = spotGenId();
    copy.x = Math.min(0.95, copy.x + 0.12);
    copy.y = Math.min(0.92, copy.y + 0.08);
    // V1+V1Dup (user): duplicate SAME source-area share kare — srcX/srcY/srcW
    // aur vertical-dup mein 16:9 box sath chalta hai (ya khud drag karo)
    if (src.kind === "vertical") copy.srcX = src.srcX, copy.srcY = src.srcY, copy.srcW = src.srcW;
    seg.screens.push(copy);
    spotSelectedScreenId = copy.id;
    if (typeof persistTimelineState === "function") persistTimelineState();
}

function deleteScreen(seg, screenId) {
    ensureScreens(seg);
    seg.screens = seg.screens.filter((s) => s.id !== screenId);
    if (spotSelectedScreenId === screenId) spotSelectedScreenId = seg.screens.length ? seg.screens[0].id : null;
    // FIX (user bug): AAKHRI screen delete karne par drawSpotlightOverlay ke
    // har-frame ensureScreens() TURANT nayi default screen bana deta tha —
    // isliye "Screen 1 delete nahi hoti, background me kaam karti rehti hai".
    // Ab: 0 screens = spotlight OFF (segment single-mode par wapas — duration
    ///barabar bache, dobara Spotlight button dabao to fresh screen banti hai).
    if (!seg.screens.length) {
        seg.mode = "single";
        spotSelectedScreenId = null;
        if (typeof renderAll === "function") { try { renderAll(); } catch (e) {} }
    }
    if (typeof persistTimelineState === "function") persistTimelineState();
}

// ===== MOUSE: 16:9 SOURCE-box drag/resize (playerCanvas) + 9:16 screen drag/resize (previewCanvas) =====
function screenGeometry(scr) {
    return {
        cx: scr.x * previewCanvas.width,
        cy: (scr.kind === "vertical") ? previewCanvas.height / 2 : scr.y * previewCanvas.height,
        r: scr.r * previewCanvas.width,
        w: scr.w * previewCanvas.width,
        h: (scr.kind === "vertical") ? previewCanvas.height : 0,
    };
}

// vertical screen ka source-box geometry (player/16:9 canvas px)
function srcBoxGeometry(scr) {
    const srcW = (spotMainVideoEl() && spotMainVideoEl().videoWidth) || 1280;
    const srcH = (spotMainVideoEl() && spotMainVideoEl().videoHeight) || 720;
    const stripAR = (scr.w * SPOTLIGHT_OUT_W) / SPOTLIGHT_OUT_H;
    let cW = scr.srcW || 0.25;
    let cH = cW * (srcW / srcH) / stripAR;
    if (cH > 1) { cH = 1; cW = cH * stripAR * (srcH / srcW); }
    return { cW, cH };
}

// PLAYER canvas (16:9): SOURCE-PLACE (vertical box + SHAPES dono) —
// capture-phase (crop-editor ke handler se pehle). Move + 6-point resize.
playerCanvas.addEventListener("mousedown", (e) => {
    if (!isSpotlightActive()) return;
    const seg = findSpotlightSeg();
    if (!seg) return;
    ensureScreens(seg);
    computeFitRect();
    if (!fitRect.w) return;
    const rect = playerCanvas.getBoundingClientRect();
    if (!rect.width || !rect.height) return; // collapsed/hidden player guard
    const mx = (e.clientX - rect.left) * (playerCanvas.width / rect.width);
    const my = (e.clientY - rect.top) * (playerCanvas.height / rect.height);
    const nx = (mx - fitRect.x) / fitRect.w;
    const ny = (my - fitRect.y) / fitRect.h;
    const HIT = 9 / fitRect.w; // ~9px normalized hit-radius

    // handles PEHLE (6-point), phir body hit
    for (const scr of seg.screens) {
        const pts = (scr.kind === "vertical") ? srcBoxHandlePoints(scr, fitRect) : srcShapeHandlePoints(scr, fitRect);
        for (const p of pts) {
            const pxN = (p.px - fitRect.x) / fitRect.w;
            const pyN = (p.py - fitRect.y) / fitRect.h;
            if (Math.hypot(nx - pxN, ny - pyN) <= HIT) {
                spotSelectedScreenId = scr.id;
                window.__spotSrcDrag = { scr, type: "resize", handle: p.key, orig: JSON.parse(JSON.stringify(scr)) };
                e.stopPropagation();
                e.preventDefault();
                return;
            }
        }
    }
    for (const scr of seg.screens) {
        let inside = false;
        if (scr.kind === "vertical") {
            const { cW, cH } = srcBoxGeometry(scr);
            inside = Math.abs(nx - scr.srcX) <= cW / 2 && Math.abs(ny - (scr.srcY || 0.5)) <= cH / 2;
        } else {
            const r = scr.srcR || 0.15;
            inside = Math.hypot(nx - scr.srcX, ny - (scr.srcY || 0.5)) <= r;
        }
        if (inside) {
            spotSelectedScreenId = scr.id;
            window.__spotSrcDrag = { scr, type: "move", grabDx: nx - scr.srcX, grabDy: ny - (scr.srcY || 0.5) };
            e.stopPropagation();
            e.preventDefault();
            return;
        }
    }
}, true); // capture: crop-editor ke handler se PEHLE

document.addEventListener("mousemove", (e) => {
    const d = window.__spotSrcDrag;
    if (!d) return;
    computeFitRect();
    const rect = playerCanvas.getBoundingClientRect();
    if (!rect.width || !rect.height) return; // collapsed player — drag skip
    const mx = (e.clientX - rect.left) * (playerCanvas.width / rect.width);
    const my = (e.clientY - rect.top) * (playerCanvas.height / rect.height);
    const nx = Math.max(0, Math.min(1, (mx - fitRect.x) / fitRect.w));
    const ny = Math.max(0, Math.min(1, (my - fitRect.y) / fitRect.h));
    const scr = d.scr;
    if (d.type === "move") {
        let halfW;
        if (scr.kind === "vertical") {
            const { cW } = srcBoxGeometry(scr);
            halfW = cW / 2;
        } else {
            halfW = (scr.srcR || 0.15);
        }
        scr.srcX = Math.max(halfW, Math.min(1 - halfW, nx - d.grabDx));
        scr.srcY = Math.max(0, Math.min(1, ny - d.grabDy));
        // MAGNETIC SOURCE SNAP (user join-request ka dusra hissa): jab do
        // vertical screens ka 16:9 source-box edges Touch karte hain, unhe
        // snap kar do — 9:16 output me strips naturally flush join hoti hain.
        if (scr.kind === "vertical") {
            const SNAPS = 12 / fitRect.w;
            const tTargets = [0, 1];
            for (const o of seg.screens) {
                if (o.id === scr.id || o.kind !== "vertical") continue;
                tTargets.push(o.srcX - (o.srcW || 0.25) / 2, o.srcX + (o.srcW || 0.25) / 2);
            }
            const myL2 = scr.srcX - halfW, myR2 = scr.srcX + halfW;
            let bBest = null, bBestD = SNAPS;
            for (const t of tTargets) {
                const dL = Math.abs(myL2 - t), dR = Math.abs(myR2 - t);
                if (dL < bBestD) { bBestD = dL; bBest = t + halfW; }
                if (dR < bBestD) { bBestD = dR; bBest = t - halfW; }
            }
            if (bBest != null) scr.srcX = Math.max(halfW, Math.min(1 - halfW, bBest));
        }
    } else {
        // 6-POINT RESIZE: drag hue point ka opposite-edge FIXED rehta hai
        const o = d.orig;
        const k = d.handle;
        const fromLeft = k[1] === "L";      // L handle => RIGHT edge fixed
        const oHalf = (scr.kind === "vertical") ? (o.srcW || 0.25) / 2 : (o.srcR || 0.15);
        const fixedEdge = fromLeft ? (o.srcX + oHalf) : (o.srcX - oHalf);
        const dxN = Math.abs(nx - fixedEdge);
        if (scr.kind === "vertical") {
            // box handles edges PAR hain => newWidth = distance to fixed edge
            scr.srcW = Math.max(0.06, Math.min(1.5, dxN));
            scr.srcX = fromLeft ? Math.min(1, nx + scr.srcW / 2) : Math.max(0, nx - scr.srcW / 2);
            // T/B handles: crop-window upar/neeche bhi move hoti hai
            if (k[0] === "T" || k[0] === "B") {
                const oNy = Math.max(0, Math.min(1, o.srcY));
                scr.srcY = Math.max(0, Math.min(1, o.srcY + (ny - oNy)));
            }
        } else {
            // shape corner handles r*0.5 par hain (CL/CR r par) => / (1 + K)
            const K = (k === "CL" || k === "CR") ? 1 : 0.5;
            scr.srcR = Math.max(0.04, Math.min(0.8, dxN / (1 + K)));
            scr.srcX = fromLeft ? Math.min(1, nx + scr.srcR) : Math.max(0, nx - scr.srcR);
            scr.srcY = Math.max(0, Math.min(1, o.srcY + (ny - Math.max(0, Math.min(1, o.srcY))) * ((k === "CL" || k === "CR") ? 0 : 1)));
        }
    }
    e.preventDefault();
});

document.addEventListener("mouseup", () => {
    if (window.__spotSrcDrag) {
        window.__spotSrcDrag = null;
        if (typeof persistTimelineState === "function") persistTimelineState();
    }
});

// ===== 16:9 SOURCE-PLACE GEOMETRY (6-point model) =====
// Vertical: portrait source-box (center srcX/srcY, width srcW — aspect strip
// ke sath locked). Shape: circle-ish region (center srcX/srcY, radius srcR).
// Dono 16:9 player ke video-area (fitRect) ke normalized coords mein hain.
function srcBoxPx(scr, fr) {
    const srcW = (spotMainVideoEl() && spotMainVideoEl().videoWidth) || 1280;
    const srcH = (spotMainVideoEl() && spotMainVideoEl().videoHeight) || 720;
    const stripAR = (scr.w * SPOTLIGHT_OUT_W) / SPOTLIGHT_OUT_H;
    let cW = scr.srcW || 0.25;
    let cH = cW * (srcW / srcH) / stripAR;
    if (cH > 1) { cH = 1; cW = cH * stripAR * (srcH / srcW); }
    const bw = cW * fr.w, bh = cH * fr.h;
    return { x0: fr.x + scr.srcX * fr.w - bw / 2, y0: fr.y + (scr.srcY || 0.5) * fr.h - bh / 2, w: bw, h: bh };
}

function srcShapePx(scr, fr) {
    return {
        cx: fr.x + scr.srcX * fr.w,
        cy: fr.y + (scr.srcY || 0.5) * fr.h,
        r: (scr.srcR || 0.15) * fr.w,
    };
}

// 6 resize points: 2 TOP (L/R) + 2 CENTER (L/R) + 2 BOTTOM (L/R)
function srcBoxHandlePoints(scr, fr) {
    const { x0, y0, w, h } = srcBoxPx(scr, fr);
    return [
        { px: x0, py: y0, key: "TL" }, { px: x0 + w, py: y0, key: "TR" },
        { px: x0, py: y0 + h / 2, key: "CL" }, { px: x0 + w, py: y0 + h / 2, key: "CR" },
        { px: x0, py: y0 + h, key: "BL" }, { px: x0 + w, py: y0 + h, key: "BR" },
    ];
}

function srcShapeHandlePoints(scr, fr) {
    const { cx, cy, r } = srcShapePx(scr, fr);
    const K = 0.5;
    return [
        { px: cx - r * K, py: cy - r * 0.866, key: "TL" }, { px: cx + r * K, py: cy - r * 0.866, key: "TR" },
        { px: cx - r, py: cy, key: "CL" }, { px: cx + r, py: cy, key: "CR" },
        { px: cx - r * K, py: cy + r * 0.866, key: "BL" }, { px: cx + r * K, py: cy + r * 0.866, key: "BR" },
    ];
}

// 9:16 preview ke 6 resize points (vertical strip par)
function outStripHandlePoints(scr) {
    const R = stripRect(scr);
    return [
        { px: R.x0, py: 0, key: "TL" }, { px: R.x0 + R.w, py: 0, key: "TR" },
        { px: R.x0, py: previewCanvas.height / 2, key: "CL" }, { px: R.x0 + R.w, py: previewCanvas.height / 2, key: "CR" },
        { px: R.x0, py: previewCanvas.height, key: "BL" }, { px: R.x0 + R.w, py: previewCanvas.height, key: "BR" },
    ];
}

// shape ka 6-point radius: us point ka current radius (resize ke liye)
function spotShapeRadiusAt(scr, key) {
    const r = scr.r * previewCanvas.width;
    const { cx, cy } = (() => ({ cx: scr.x * previewCanvas.width, cy: scr.y * previewCanvas.height }))();
    const K = { TL: 0.5, TR: 0.5, CL: 1, CR: 1, BL: 0.5, BR: 0.5 }[key] || 1;
    const ys = { TL: 0.866, TR: 0.866, CL: 0, CR: 0, BL: 0.866, BR: 0.866 }[key] || 0;
    return { cx, cy, px: cx + (key[1] === "L" ? -1 : 1) * r * K, py: cy + r * ys * (key[0] === "B" ? 1 : key[0] === "T" ? -1 : 0), K };
}

function spotHitScreen(seg, mx, my) {
    // selected pehle (topmost draw order ke sath consistent)
    const order = [...seg.screens].sort((a, b) => (a.id === spotSelectedScreenId ? -1 : 0) - (b.id === spotSelectedScreenId ? -1 : 0));
    for (const scr of order) {
        const { cx, cy, r, w, h } = screenGeometry(scr);
        if (scr.kind === "vertical") {
            if (mx >= cx - w / 2 - 6 && mx <= cx + w / 2 + 14 && my >= 0 && my <= previewCanvas.height) return scr;
        } else {
            const dx = mx - cx, dy = my - cy;
            let inside;
            switch (scr.shape) {
                case "square": inside = Math.abs(dx) <= r && Math.abs(dy) <= r; break;
                case "diamond": inside = (Math.abs(dx) / (r * 0.7) + Math.abs(dy) / r) <= 1; break;
                case "hexagon": inside = Math.abs(dx) <= 0.866 * r && Math.abs(dy) <= r * (1 - Math.abs(dx) / (1.732 * r)); break;
                default: inside = Math.hypot(dx, dy) <= r; break;
            }
            if (inside) return scr;
        }
    }
    return null;
}

function spotlightHandleMouseDown(e) {
    if (!isSpotlightActive()) return false;
    const seg = findSpotlightSeg();
    if (!seg) return false;
    ensureScreens(seg);
    const rect = previewCanvas.getBoundingClientRect();
    const scaleX = previewCanvas.width / rect.width;
    const scaleY = previewCanvas.height / rect.height;
    const mx = (e.clientX - rect.left) * scaleX;
    const my = (e.clientY - rect.top) * scaleY;

    // resize handles pehle: vertical = 6-point, shapes = 45° knob
    for (const scr of seg.screens) {
        const g = screenGeometry(scr);
        if (scr.kind === "vertical") {
            // 6-POINT (user): 2 top + 2 center + 2 bottom (left/right edges)
            for (const p of outStripHandlePoints(scr)) {
                if (Math.hypot(mx - p.px, my - p.py) <= SPOT_HANDLE_HIT) {
                    spotDrag = { seg, screenId: scr.id, type: "resize", handle: p.key };
                    spotSelectedScreenId = scr.id;
                    e.stopPropagation();
                    return true;
                }
            }
        } else {
            const kx = g.cx + g.r * 0.7071, ky = g.cy + g.r * 0.7071;
            if (Math.hypot(mx - kx, my - ky) <= SPOT_HANDLE_HIT) {
                spotDrag = { seg, screenId: scr.id, type: "resize" };
                spotSelectedScreenId = scr.id;
                e.stopPropagation();
                return true;
            }
        }
    }
    const scr = spotHitScreen(seg, mx, my);
    if (scr) {
        spotSelectedScreenId = scr.id;
        spotDrag = { seg, screenId: scr.id, type: "move", grabDx: (mx - scr.x * previewCanvas.width) / previewCanvas.width, grabDy: (my - scr.y * previewCanvas.height) / previewCanvas.height };
        e.stopPropagation();
        return true;
    }
    return false;
}

previewCanvas.addEventListener("mousedown", (e) => {
    spotlightHandleMouseDown(e);
});

document.addEventListener("mousemove", (e) => {
    if (!spotDrag) return;
    const seg = spotDrag.seg;
    if (!getSegmentById(seg.id)) { spotDrag = null; return; } // segment delete ho gaya
    const scr = seg.screens.find((s) => s.id === spotDrag.screenId);
    if (!scr) { spotDrag = null; return; }
    const rect = previewCanvas.getBoundingClientRect();
    const scaleX = previewCanvas.width / rect.width;
    const scaleY = previewCanvas.height / rect.height;
    const mx = (e.clientX - rect.left) * scaleX;
    const my = (e.clientY - rect.top) * scaleY;

    if (spotDrag.type === "move") {
        let nx = mx / previewCanvas.width - spotDrag.grabDx;
        let ny = my / previewCanvas.height - spotDrag.grabDy;
        if (scr.kind === "vertical") {
            // strip: sirf horizontal move (height poori fixed hai), y locked 0.5
            const halfW = scr.w / 2;
            nx = Math.max(halfW, Math.min(1 - halfW, nx));
            ny = 0.5;
            // MAGNETIC SNAP (user): strips ki edges doosri vertical strips ke
            // edges par SACPAK jitne hain (12px) — side-by-side flush join.
            const SNAP = 12 / previewCanvas.width;
            const targets = [0, 1]; // canvas edges bhi snap hote hain
            for (const o of seg.screens) {
                if (o.id === scr.id || o.kind !== "vertical") continue;
                targets.push(o.x - o.w / 2, o.x + o.w / 2);
            }
            const myL = nx - halfW, myR = nx + halfW;
            let best = null, bestD = SNAP, bestEdge = null;
            for (const t of targets) {
                const dL = Math.abs(myL - t), dR = Math.abs(myR - t);
                if (dL < bestD) { bestD = dL; best = t + halfW; bestEdge = t; }
                if (dR < bestD) { bestD = dR; best = t - halfW; bestEdge = t; }
            }
            if (best != null) {
                nx = Math.max(halfW, Math.min(1 - halfW, best));
                window.__spotSnapEdge = bestEdge; // draw par purple guide line
            } else {
                window.__spotSnapEdge = null;
            }
        } else {
            const rr = scr.r;
            const rH = rr * SPOTLIGHT_OUT_W / SPOTLIGHT_OUT_H;
            nx = Math.max(rr, Math.min(1 - rr, nx));
            ny = Math.max(rH, Math.min(1 - rH, ny));
        }
        scr.x = nx;
        scr.y = ny;
    } else if (spotDrag.type === "resize") {
        const g = screenGeometry(scr);
        if (scr.kind === "vertical") {
            // 6-POINT RESIZE: opposite-edge FIXED, dragged-edge mouse ko follow
            const o = spotDrag.orig || (spotDrag.orig = { w: scr.w, x: scr.x });
            const k = spotDrag.handle || "CR";
            const fromLeft = k[1] === "L";
            const fixedEdge = fromLeft ? (o.x + o.w / 2) : (o.x - o.w / 2);
            const fixedEdgePx = fixedEdge * previewCanvas.width;
            const newW = Math.max(0.06, Math.min(1, Math.abs(mx - fixedEdgePx) / previewCanvas.width));
            scr.w = newW;
            scr.x = fromLeft ? Math.min(1, mx / previewCanvas.width + newW / 2) : Math.max(0, mx / previewCanvas.width - newW / 2);
        } else {
            const dist = Math.hypot(mx - g.cx, my - g.cy) / previewCanvas.width;
            scr.r = Math.max(0.05, Math.min(0.45, dist));
        }
    }
});

document.addEventListener("mouseup", () => {
    if (spotDrag) {
        spotDrag = null;
        window.__spotSnapEdge = null;
        if (typeof persistTimelineState === "function") persistTimelineState();
    }
});

// ===== CONTROLS PANEL =====
function syncScreenControls(scr) {
    if (!scr) return;
    const isV = scr.kind === "vertical";
    const zoomRow = document.getElementById("spZoomRow");
    const styleRow = document.getElementById("spStyleRow");
    const borderRow = document.getElementById("spBorderRow");
    if (zoomRow) zoomRow.style.display = isV ? "none" : "";
    if (styleRow) styleRow.style.display = isV ? "none" : "";
    // BORDER-LESS vertical: border controls sirf shapes par
    if (borderRow) borderRow.style.display = isV ? "none" : "";

    const zoomEl = document.getElementById("spZoom");
    const sizeEl = document.getElementById("spSize");
    const zv = document.getElementById("spZoomVal");
    const sz = document.getElementById("spSizeVal");
    if (zoomEl && document.activeElement !== zoomEl) zoomEl.value = scr.zoom;
    if (sizeEl && document.activeElement !== sizeEl) sizeEl.value = isV ? scr.w : scr.r;
    if (zv) zv.textContent = (scr.zoom || 1.6).toFixed(2) + "x";
    if (sz) sz.textContent = Math.round((isV ? scr.w : scr.r) * 100) + "%";
    document.querySelectorAll(".sp-style-btn").forEach((b) => {
        b.classList.toggle("active", b.dataset.style === scr.shape);
    });
    const bwEl = document.getElementById("spBorderW");
    const bcolEl = document.getElementById("spBorderColor");
    const shEl = document.getElementById("spShadow");
    if (bwEl && document.activeElement !== bwEl) bwEl.value = (scr.border && scr.border.width !== undefined) ? scr.border.width : 8;
    if (bcolEl) bcolEl.value = (scr.border && scr.border.color) || "#ffffff";
    if (shEl) shEl.checked = !!(scr.shadow && scr.shadow.enabled);
    const bv2 = document.getElementById("spBorderWVal");
    if (bv2 && document.activeElement !== bwEl) bv2.textContent = ((scr.border && scr.border.width != null) ? Number(scr.border.width) : 8) + "px";
    const vertCb = document.getElementById("spVertical");
    if (vertCb) vertCb.checked = isV;
}

function initSpotlightUI() {
    const btn = document.getElementById("spotlightBtn");
    if (btn) btn.addEventListener("click", setupSpotlight);

    const zoomEl = document.getElementById("spZoom");
    const sizeEl = document.getElementById("spSize");
    if (zoomEl) {
        zoomEl.addEventListener("input", () => {
            const seg = findSpotlightSeg();
            if (!seg) return;
            const scr = getSelectedScreen(seg);
            if (scr.kind === "vertical") return;
            scr.zoom = parseFloat(zoomEl.value);
            const zv = document.getElementById("spZoomVal");
            if (zv) zv.textContent = scr.zoom.toFixed(2) + "x";
        });
        zoomEl.addEventListener("change", () => { if (typeof persistTimelineState === "function") persistTimelineState(); });
    }
    if (sizeEl) {
        sizeEl.addEventListener("input", () => {
            const seg = findSpotlightSeg();
            if (!seg) return;
            const scr = getSelectedScreen(seg);
            const v = parseFloat(sizeEl.value);
            if (scr.kind === "vertical") scr.w = v; else scr.r = v;
            const sz = document.getElementById("spSizeVal");
            if (sz) sz.textContent = Math.round(v * 100) + "%";
        });
        sizeEl.addEventListener("change", () => { if (typeof persistTimelineState === "function") persistTimelineState(); });
    }
    document.querySelectorAll(".sp-style-btn").forEach((b) => {
        b.addEventListener("click", () => {
            const seg = findSpotlightSeg();
            if (!seg) return;
            const scr = getSelectedScreen(seg);
            if (scr.kind === "vertical") return;
            scr.shape = b.dataset.style;
            if (typeof persistTimelineState === "function") persistTimelineState();
        });
    });

    const bwEl = document.getElementById("spBorderW");
    const bcolEl = document.getElementById("spBorderColor");
    const shEl = document.getElementById("spShadow");
    if (bwEl) {
        bwEl.addEventListener("input", () => {
            const seg = findSpotlightSeg();
            if (!seg) return;
            const scr = getSelectedScreen(seg);
            scr.border.width = parseFloat(bwEl.value);
            const bv = document.getElementById("spBorderWVal");
            if (bv) bv.textContent = bwEl.value + "px";
        });
        bwEl.addEventListener("change", () => { if (typeof persistTimelineState === "function") persistTimelineState(); });
    }
    if (bcolEl) {
        bcolEl.addEventListener("input", () => {
            const seg = findSpotlightSeg();
            if (!seg) return;
            const scr = getSelectedScreen(seg);
            scr.border.color = bcolEl.value;
        });
        bcolEl.addEventListener("change", () => { if (typeof persistTimelineState === "function") persistTimelineState(); });
    }
    if (shEl) {
        shEl.addEventListener("change", () => {
            const seg = findSpotlightSeg();
            if (!seg) return;
            const scr = getSelectedScreen(seg);
            scr.shadow.enabled = shEl.checked;
            if (typeof persistTimelineState === "function") persistTimelineState();
        });
    }
    const vertCb = document.getElementById("spVertical");
    if (vertCb) {
        vertCb.addEventListener("change", () => {
            const seg = findSpotlightSeg();
            if (!seg) return;
            const scr = getSelectedScreen(seg);
            if (vertCb.checked) {
                scr.kind = "vertical";
                scr.w = Math.max(0.12, Math.min(0.6, scr.r * 2));
                scr.y = 0.5; // strip: y fixed (height = poori output)
                scr.border = { color: (scr.border && scr.border.color) || "#ffffff", width: 0 }; // border-less
            } else {
                scr.kind = "spot";
                scr.shape = "square";
                scr.r = Math.max(0.05, scr.w / 2);
                if (scr.srcR === undefined) scr.srcR = 0.15;
            }
            if (typeof persistTimelineState === "function") persistTimelineState();
        });
    }
    const addSpot = document.getElementById("spAddSpot");
    if (addSpot) addSpot.addEventListener("click", () => addScreen("spot"));
    const addVert = document.getElementById("spAddVertical");
    if (addVert) addVert.addEventListener("click", () => addScreen("vertical"));
    const dupBtn = document.getElementById("spDupScreen");
    if (dupBtn) dupBtn.addEventListener("click", duplicateScreen);
    const delBtn = document.getElementById("spDelScreen");
    if (delBtn) {
        delBtn.addEventListener("click", () => {
            const seg = findSpotlightSeg();
            if (!seg) return;
            ensureScreens(seg);
            const scr = getSelectedScreen(seg);
            deleteScreen(seg, scr.id);
        });
    }
}

initSpotlightUI();
