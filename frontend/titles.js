// ===== TITLES LAYER (9:16 heading engine) — v2 =====
// Captions layer bilkul SEPARATE feature hai:
//  - Auto Captions poori video ke liye hai — wo AS-IS chalta rahega (captions.js
//    ko humne kuch nahi chheda; Auto Captions ka promise intact).
//  - Titles sirf 9:16 window par CHHOTE-SPAN HEADINGS ke liye hai. Span jitna,
//    title utna (koi poori-video overlay nahi).
//
// Data-model (timeline.js me titlesSpans = [] — waisa hi jaisa captionSpans):
//   titlesSpans : [{ id, start, end, template, text, align, position:{x,y}, scale }]
//   - template: 26 built-in animated heading templates har APNA style + anim
//   - text: manual heading-string, YA empty = caption-cue text us span me dikhaye
//   - align: "left" | "center" | "right" (title ko us x-position par anchor)
// Template engine (drawTitleOnCanvas) ka Python-mirror backend ke export_engine.py
// me hai — naya template add karte waqt dono update rakho (keys aur anims same).

const TITLE_TEMPLATES = {
    // ---- originals (10) ----
    boldPop:     { label: "Bold Pop",     fontWeight: "900", baseFontPx: 72, color: "#ffffff", accent: "#ffd42a", bg: null,      anim: "pop",       uppercase: true, shadow: true,  desc: "bada bold text, belly-pop in" },
    filmFade:    { label: "Film Fade",    fontWeight: "700", baseFontPx: 58, color: "#ffffff", accent: "#ffffff", bg: null,      anim: "fade",      uppercase: false, shadow: true,  desc: "classic film fade-in heading" },
    typewriter:  { label: "Typewriter",   fontWeight: "800", baseFontPx: 54, color: "#eaffff", accent: "#00e5ff", bg: null,      anim: "typewriter",uppercase: false, shadow: false, desc: "typing animation with caret" },
    boxIn:       { label: "Box In",       fontWeight: "900", baseFontPx: 60, color: "#111111", accent: "#ffd42a", bg: "#ffd42a", anim: "boxIn",     uppercase: true, shadow: false, desc: "highlight-box squeezes in behind text" },
    slideUp:     { label: "Slide Up",     fontWeight: "800", baseFontPx: 62, color: "#ffffff", accent: "#2fb8a6", bg: null,      anim: "slideUp",   uppercase: true, shadow: true,  desc: "heading slides up from below" },
    neonGlow:    { label: "Neon Title",   fontWeight: "800", baseFontPx: 64, color: "#eaffff", accent: "#00e5ff", bg: null,      anim: "neon",      uppercase: false, shadow: false, desc: "neon glow pulsing title" },
    bigPop:      { label: "Stamp In",     fontWeight: "900", baseFontPx: 76, color: "#ff2d55", accent: "#ffffff", bg: null,      anim: "stamp",     uppercase: true, shadow: false, desc: "rubber-stamp slam-down" },
    newsTicker:  { label: "News Ticker",  fontWeight: "700", baseFontPx: 46, color: "#111111", accent: "#ffffff", bg: "#ffffff", anim: "ticker",    uppercase: false, shadow: false, desc: "news-channel bottom bar" },
    greenScreen: { label: "Outline Grow", fontWeight: "900", baseFontPx: 66, color: "#00ff33", accent: "#000000", bg: null,      anim: "grow",      uppercase: true, shadow: false, desc: "outline text scaling up" },
    karaokeFill: { label: "Karaoke Line", fontWeight: "800", baseFontPx: 56, color: "#8a8a8a", accent: "#ffffff", bg: null,      anim: "karaoke",   uppercase: false, shadow: false,  desc: "text karaoke-fills as it plays" },
    // ---- captions-styles mirror (16 naye) — har caption-style ka title-look ----
    hormozi:     { label: "Hormozi",      fontWeight: "900", baseFontPx: 58, color: "#ffffff", accent: "#ffd42a", bg: "#ffd42a", anim: "boxIn",     uppercase: true, shadow: false, desc: "Yellow box + b/w — Hormozi caption look" },
    mrbeast:     { label: "MrBeast",      fontWeight: "900", baseFontPx: 56, color: "#ffffff", accent: "#00ff33", bg: null,      anim: "grow",      uppercase: true, shadow: false, desc: "green outline grow — MrBeast look" },
    tiktokPop:   { label: "TikTok Pop",   fontWeight: "900", baseFontPx: 54, color: "#ff2d55", accent: "#ffffff", bg: null,      anim: "pop",       uppercase: true, shadow: true,  desc: "hot-pink pop" },
    podcastBold: { label: "Podcast Bold", fontWeight: "800", baseFontPx: 50, color: "#ffffff", accent: "#e63946", bg: "#e63946", anim: "boxIn",     uppercase: true, shadow: false, desc: "red box + white text" },
    boldHighlight: { label: "Bold Highlight", fontWeight: "800", baseFontPx: 54, color: "#111111", accent: "#ffde59", bg: "#ffde59", anim: "boxIn",   uppercase: true, shadow: false, desc: "yellow line-box, black text" },
    viralYellow: { label: "Viral Yellow", fontWeight: "900", baseFontPx: 60, color: "#ffe600", accent: "#000000", bg: null,      anim: "grow",      uppercase: true, shadow: false, desc: "bright yellow outline pop" },
    karaokeWave: { label: "Karaoke Wave", fontWeight: "800", baseFontPx: 50, color: "rgba(255,255,255,0.45)", accent: "#00e5ff", bg: null, anim: "karaoke", uppercase: false, shadow: false, desc: "cyan sweep-fill karaoke" },
    softPastel:  { label: "Soft Pastel",  fontWeight: "600", baseFontPx: 46, color: "#ffd1dc", accent: "#ff8fab", bg: null,      anim: "fade",      uppercase: false, shadow: true,  desc: "soft pink fade heading" },
    retroWave:   { label: "Retro Wave",   fontWeight: "800", baseFontPx: 52, color: "#ff71ce", accent: "#01cdfe", bg: null,      anim: "neon",      uppercase: true, shadow: false, desc: "retro synthwave glow" },
    comicPop:    { label: "Comic Pop",    fontWeight: "900", baseFontPx: 56, color: "#ffffff", accent: "#ff2d55", bg: "#ffde00", anim: "boxIn",     uppercase: true, shadow: false, desc: "comic yellow box tilt" },
    gymBeast:    { label: "Gym Beast",    fontWeight: "900", baseFontPx: 62, color: "#ffffff", accent: "#ff3800", bg: "#111111", anim: "boxIn",     uppercase: true, shadow: true,   desc: "black box orange text, brutal" },
    luxuryGold:  { label: "Luxury Gold",  fontWeight: "800", baseFontPx: 52, color: "#d4af37", accent: "#fff8d8", bg: null,      anim: "neon",      uppercase: true, shadow: false,  desc: "gold glow title" },
    oceanBlue:   { label: "Ocean Blue",   fontWeight: "800", baseFontPx: 52, color: "#4cc9f0", accent: "#003049", bg: null,      anim: "slideUp",   uppercase: true, shadow: true,   desc: "deep blue slide-up heading" },
    fireRed:     { label: "Fire Red",     fontWeight: "900", baseFontPx: 58, color: "#ff4d00", accent: "#200000", bg: null,      anim: "stamp",     uppercase: true, shadow: false, desc: "fire stamp slam" },
    bubbleGum:   { label: "Bubble Gum",   fontWeight: "900", baseFontPx: 54, color: "#ffffff", accent: "#ff5da2", bg: "#ff5da2", anim: "boxIn",     uppercase: true, shadow: false, desc: "pink pill box" },
    monoGray:    { label: "Mono Gray",    fontWeight: "600", baseFontPx: 46, color: "#d0d0d0", accent: "#111111", bg: null,      anim: "fade",      uppercase: false, shadow: false,  desc: "editorial mono minimal" },
    bananaSplit: { label: "Banana Split", fontWeight: "900", baseFontPx: 56, color: "#111111", accent: "#ffe135", bg: "#ffe135", anim: "boxIn",     uppercase: true, shadow: false, desc: "yellow outline box, black text" },    whisperSmall: { label: "Whisper Small", fontWeight: "400", baseFontPx: 34, color: "#eeeeee", accent: "#ffffff", bg: null,    anim: "fade",      uppercase: false, shadow: true,  desc: "chhota quiet bottom heading" },
    // ===== "MY TITLES" (sample-video golden-glow look — myCaption mirror) =====
    myCaption1:   { label: "My Titles 1",   fontWeight: "900", baseFontPx: 60, color: "#ffe200", accent: "#ffd400", bg: null,      anim: "neon",      uppercase: false, shadow: false, desc: "bright-yellow glowing heading" },
    myCaption2:   { label: "My Titles 2",   fontWeight: "800", baseFontPx: 56, color: "rgba(255,255,255,0.45)", accent: "#ffdd00", bg: null, anim: "karaoke", uppercase: false, shadow: false, desc: "white karaoke fills into yellow" },
    myCaption3:   { label: "My Titles 3",   fontWeight: "900", baseFontPx: 62, color: "#ffe200", accent: "#ffd400", bg: null,      anim: "neon",      uppercase: false, shadow: false, desc: "big yellow glow heading" },
};
const TITLE_TEMPLATE_KEYS = Object.keys(TITLE_TEMPLATES);

// align presets (title anchor-x + text-align) — drag X position override ho sakti hai
const TITLE_ALIGN_PRESETS = {
    left:   { x: 0.12 },   // anchor 12% (padding-safe)
    center: { x: 0.5 },
    right:  { x: 0.88 },
};
const TITLE_DEFAULT_POSITION = { x: 0.5, y: 0.22 }; // BASE default

// Auto-captions transcript se aaye cues — TitlesPanel inhe text-source ke temp
// store karo (timeline.js persist me bhi jaate hain; manual text override hota hai)
let titlesCues = [];      // [{start, end, text}] — SOURCE-time (captions wala hi)
let titlesSelectedTemplate = "boldPop";
let titlesPanelOpen = false;

function titleTemplateAt(t) {
    if (typeof titlesSpans === "undefined") return null;
    for (const s of titlesSpans) if (t >= s.start && t < s.end) return s;
    return null;
}

function _titleTextForCue(t, span) {
    if (span && span.text && String(span.text).trim()) return String(span.text).trim();
    if (typeof titlesCues !== "undefined" && titlesCues.length) {
        const srcT = window.__activeSourceTime;
        const cue = (srcT != null) ? titlesCues.find((c) => srcT >= c.start && srcT < c.end) : null;
        if (cue && cue.words && cue.words.length) {
            return cue.words.map((w) => (w.text || "")).join(" ").replace(/\s+/g, " ").trim();
        }
        if (cue && typeof cue.text === "string") return cue.text.trim();
    }
    return "";
}

function drawTitleOnCanvas(ctx, rectX, rectY, rectW, rectH, refHeightPx, isPreview) {
    if (typeof titlesSpans === "undefined" || !titlesSpans.length) return;
    const t = (typeof virtualTime === "number") ? virtualTime : 0;
    const span = titleTemplateAt(t);
    if (!span) return;

    const tpl = TITLE_TEMPLATES[span.template || "boldPop"] || TITLE_TEMPLATES.boldPop;
    let text = _titleTextForCue(t, span);
    if (!text) return;

    const scale = rectH / (refHeightPx || 1080);
    const fontSize = Math.max(12, tpl.baseFontPx * scale * (span.scale || 1.0));
    const label = tpl.uppercase ? text.toUpperCase() : text;
    const align = span.align || "center";

    const dur = Math.max(0.01, span.end - span.start);
    const prog = Math.max(0, Math.min(1, (t - span.start) / dur));
    const easeOut = (p) => 1 - Math.pow(1 - Math.min(1, Math.max(0, p)), 3);

    // ALIGN → anchor-x resolve: manual position-x override hota hai warna preset
    let ax;
    if (span.position && span.position.x != null) ax = span.position.x;
    else ax = (TITLE_ALIGN_PRESETS[align] || TITLE_ALIGN_PRESETS.center).x;
    const px = rectX + rectW * ax;
    const py = rectY + rectH * ((span.position && span.position.y != null) ? span.position.y : 0.22);
    const cx = px, cy = py;

    ctx.save();
    ctx.textAlign = align;
    ctx.textBaseline = "middle";
    ctx.font = `${tpl.fontWeight} ${fontSize}px Arial, sans-serif`;

    // ---- multi-line support (manual \n me splits) ----
    const lines = label.split("\n");
    const lineH = fontSize * 1.22;
    ctx.lineWidth = Math.max(1, 4 * scale);
    ctx.strokeStyle = tpl.accent || "#000";

    // ---- per-template transform pre-state ----
    let drawScale = 1, dy = 0, rot = 0, alpha = 1;
    const anim = tpl.anim || "pop";
    if (anim === "pop")      { const p = easeOut(prog * 4); drawScale = 0.6 + 0.4 * p; dy = (1 - p) * 40 * scale; }
    else if (anim === "fade"){ alpha = Math.min(1, prog * 2.2); }
    else if (anim === "typewriter"){ /* chars slicing per-line below */ }
    else if (anim === "boxIn"){ const p = easeOut(prog * 2.6); ctx._boxSx = p; }
    else if (anim === "slideUp"){ const p = easeOut(prog * 2.2); dy = (1 - p) * 90 * scale; alpha = Math.min(1, prog * 3); }
    else if (anim === "neon"){ alpha = 0.85 + 0.15 * Math.sin(prog * Math.PI * 4); }
    else if (anim === "stamp"){ const p = easeOut(prog * 3); drawScale = 2.4 - 1.4 * p; alpha = Math.min(1, prog * 4); }
    else if (anim === "ticker"){ /* bar below; text slides within */ }
    else if (anim === "grow"){ const p = easeOut(prog * 3.5); drawScale = 0.3 + 0.7 * p; alpha = Math.min(1, prog * 2.4); }
    else if (anim === "karaoke"){ /* fill revealed via clip below */ }

    // ---- ticker bar special: bottom-edge bar across full width ----
    if (anim === "ticker") {
        const barH = fontSize * 2.0;
        const barY = rectY + rectH * ((span.position && span.position.y != null) ? span.position.y : 0.85);
        const off = Math.max(0, 1 - easeOut(prog * 2.2)) * rectW;
        ctx.fillStyle = tpl.bg || "#fff";
        ctx.fillRect(rectX - off, barY - barH / 2, rectW + off, barH);
        ctx.textAlign = "left";
        ctx.save();
        ctx.beginPath();
        ctx.rect(rectX, barY - barH / 2, rectW, barH);
        ctx.clip();
        ctx.fillStyle = tpl.color || "#111";
        const tw = ctx.measureText(label).width;
        const tx = rectX + off / 2 + Math.max(0, rectW * 0.05 - off * 0.4);
        ctx.fillText(label, tx, barY);
        ctx.restore();
        ctx.restore();
        if (isPreview) {
            window.__titleBBox = { x: rectX, y: barY - barH / 2, w: rectW, h: barH };
        }
        return;
    }

    ctx.globalAlpha = alpha;
    ctx.translate(cx + 0, cy + dy);
    if (rot) ctx.rotate(rot);
    if (drawScale !== 1) ctx.scale(drawScale, drawScale);

    // ---- bg-box (boxIn) — text ke peeche highlight box squeeze-in ----
    if (anim === "boxIn") {
        const sx = (ctx._boxSx != null) ? ctx._boxSx : 1;
        const fullW = ctx.measureText(lines.length ? lines.reduce((a, b) => (a.length > b.length ? a : b)) : "").width;
        const padX = 18 * scale, padY = 12 * scale;
        const boxCenterX = (align === "left") ? fullW / 2 : (align === "right") ? -fullW / 2 : 0;
        const bw = (fullW + padX * 2) * sx, bh = lineH * lines.length + padY;
        ctx.fillStyle = tpl.bg || "#ffd42a";
        ctx.fillRect(boxCenterX - bw / 2, -bh / 2, bw, bh);
    }

    // ---- per-line (multi-line + typewriter + karaoke) ----
    const totalChars = Math.max(1, label.length);
    let startY = -((lines.length - 1) * lineH) / 2;
    let charsUsed = 0;
    lines.forEach((ln, li) => {
        const y = startY + li * lineH;
        let txtToDraw = ln;
        if (anim === "typewriter") {
            const shown = Math.floor(prog * totalChars + 0.5);
            const lineStart = charsUsed;
            charsUsed += ln.length + 1;
            const n = Math.max(0, Math.min(ln.length, shown - lineStart));
            txtToDraw = ln.slice(0, n);
        }
        if (txtToDraw.length === 0 && anim === "typewriter") return;

        if (tpl.shadow) {
            ctx.shadowColor = "rgba(0,0,0,0.85)";
            ctx.shadowBlur = Math.max(2, 14 * scale);
        } else {
            ctx.shadowColor = "transparent";
            ctx.shadowBlur = 0;
        }
        if (anim === "neon") { ctx.shadowColor = tpl.accent; ctx.shadowBlur = 22 * scale; }
        if (anim === "grow") {
            ctx.strokeStyle = tpl.accent || "#000";
            ctx.strokeText(txtToDraw, 0, y);
        }
        ctx.fillStyle = tpl.color || "#fff";
        ctx.fillText(txtToDraw, 0, y);

        if (anim === "karaoke") {
            // revealed-by-progress accent text (clip se sweep fill) —
            // align-aware clip-x (left/center/right)
            const wLine = ctx.measureText(txtToDraw).width;
            let clipX0;
            if (align === "left") clipX0 = 0;
            else if (align === "right") clipX0 = -wLine;
            else clipX0 = -wLine / 2;
            ctx.save();
            ctx.beginPath();
            ctx.rect(clipX0, y - lineH / 2, Math.max(0, wLine * prog), lineH);
            ctx.clip();
            ctx.fillStyle = tpl.accent || "#fff";
            ctx.fillText(txtToDraw, 0, y);
            ctx.restore();
        }
    });

    // ---- typewriter caret ----
    if (anim === "typewriter") {
        const n = Math.floor(prog * totalChars + 0.5);
        let li = 0, rem = n;
        while (li < lines.length - 1 && rem > lines[li].length) { rem -= lines[li].length + 1; li++; }
        const curLine = lines[li] || "";
        const frozen = Math.max(0, Math.min(curLine.length, rem));
        const widthSoFar = ctx.measureText(curLine.slice(0, frozen)).width;
        const caretY = startY + li * lineH;
        let caretX;
        if (align === "left") caretX = widthSoFar + 3 * scale;
        else if (align === "right") caretX = -widthSoFar - 3 * scale;
        else caretX = widthSoFar / 2 + 3 * scale;
        if (Math.floor(t * 3) % 2 === 0) {
            ctx.fillStyle = tpl.accent || "#fff";
            ctx.fillRect(caretX, caretY - fontSize * 0.42, fontSize * 0.08, fontSize * 0.85);
        }
    }

    ctx.restore();
    if (isPreview) {
        window.__titleBBox = null;
    }
}

// ===== PREVIEW-OVERLAY: selected title span par dashed box (sirf PREVIEW canvas)
function titlesDrawOverlay() {
    if (typeof previewCtx === "undefined" || !previewCtx) return;
    if (typeof titlesSpans === "undefined" || !titlesSpans.length) return;
    if (typeof selectedItems === "undefined" || !selectedItems.length) return;
    let span = null;
    for (let i = selectedItems.length - 1; i >= 0; i--) {
        if (selectedItems[i].kind === "titleSpan") {
            span = titlesSpans.find((s) => s.id === selectedItems[i].id);
            break;
        }
    }
    if (!span) return;
    const rect = document.getElementById("previewCanvas");
    if (!rect) return;
    const W = rect.width, H = rect.height;
    let ax;
    if (span.position && span.position.x != null) ax = span.position.x;
    else ax = (TITLE_ALIGN_PRESETS[span.align || "center"] || TITLE_ALIGN_PRESETS.center).x;
    const px = ax * W;
    const py = (span.position && span.position.y != null ? span.position.y : 0.22) * H;
    previewCtx.save();
    previewCtx.strokeStyle = "#ff7ab8";
    previewCtx.lineWidth = 1.5;
    previewCtx.setLineDash([5, 4]);
    const bw = Math.max(60, W * 0.5), bh = Math.max(28, H * 0.08);
    previewCtx.strokeRect(px - bw / 2, py - bh / 2, bw, bh);
    previewCtx.fillStyle = "#ffd42a";
    previewCtx.fillRect(px - bw / 2 - 4, py - bh / 2 - 4, 8, 8);
    previewCtx.restore();
}

// ===== DRAG-MOVE positions (preview canvas par — caption-drag jaisa) =====
document.addEventListener("mousedown", (e) => {
    if (e.target !== (typeof previewCanvas !== "undefined" ? previewCanvas : null)) return;
    if (typeof selectedItems === "undefined") return;
    let span = null;
    for (let i = selectedItems.length - 1; i >= 0; i--) {
        if (selectedItems[i].kind === "titleSpan") {
            span = (titlesSpans || []).find((s) => s.id === selectedItems[i].id);
            break;
        }
    }
    if (!span) return;
    const r = previewCanvas.getBoundingClientRect();
    const px = (e.clientX - r.left) / r.width;
    const py = (e.clientY - r.top) / r.height;
    let ox;
    if (span.position && span.position.x != null) ox = span.position.x;
    else ox = (TITLE_ALIGN_PRESETS[span.align || "center"] || TITLE_ALIGN_PRESETS.center).x;
    const oy = (span.position && span.position.y != null ? span.position.y : 0.22);
    if (Math.abs(px - ox) < 0.2 && Math.abs(py - oy) < 0.15) {
        window.__titleDrag = { span, startX: px, startY: py, origX: ox, origY: oy };
        e.stopPropagation();
    }
});
document.addEventListener("mousemove", (e) => {
    if (!window.__titleDrag) return;
    const r = previewCanvas.getBoundingClientRect();
    const px = (e.clientX - r.left) / r.width;
    const py = (e.clientY - r.top) / r.height;
    const s = window.__titleDrag.span;
    s.position = {
        x: Math.max(0.04, Math.min(0.96, window.__titleDrag.origX + (px - window.__titleDrag.startX))),
        y: Math.max(0.04, Math.min(0.96, window.__titleDrag.origY + (py - window.__titleDrag.startY))),
    };
});
document.addEventListener("mouseup", () => {
    if (window.__titleDrag) {
        window.__titleDrag = null;
        if (typeof persistTimelineState === "function") persistTimelineState();
    }
});

// ===== TIMELINE-LAYER SPECIFIC CALLBACKS (timeline.js generic engine) =====

function titlesDefaultSpanData(start, end, opts) {
    const base = (typeof virtualTime === "number" && isFinite(virtualTime)) ? virtualTime : 0;
    const align = (opts && opts.align) || titlesAlign || "center";
    // align-preset X span-creation par LOCK (glitch fix: position bad men sync se
    // rewrite nahi hogi; user drag karke override kar sakta hai)
    const presetX = (TITLE_ALIGN_PRESETS[align] || TITLE_ALIGN_PRESETS.center).x;
    const baseY = (titlesPendingPosY != null) ? titlesPendingPosY : TITLE_DEFAULT_POSITION.y;
    const baseScale = (titlesPendingScale != null) ? titlesPendingScale : 1.0;
    return {
        id: (typeof genId === "function") ? genId() : ("ttl_" + Math.random().toString(36).slice(2, 9)),
        start: (start != null) ? start : base,
        end: (end != null) ? end : base + 3,
        template: (opts && opts.template) || titlesSelectedTemplate || "boldPop",
        text: (opts && opts.text) || "",
        align: align,
        position: { x: presetX, y: baseY },
        scale: baseScale,
    };
}

// ===== PANEL (left media-bin ke neeche dropdown-window) =====
function buildTitlesPanel() {
    const wrap = document.getElementById("titlesPanel");
    if (!wrap) return;
    wrap.dataset.autoForSpan = "1";  // (TITLES FIX): mark auto-open state
    const hasCues = (typeof captionCues !== "undefined" && captionCues.length);
    const active = _titlesTargetSpan();
    wrap.innerHTML = `
        <div class="cp-header">
            <span class="cp-title">🅣 Titles <span id="tpStateLabel" class="cg-target-label"></span></span>
            <span class="cp-toggle" id="tpCollapse">▾</span>
        </div>
        <div class="cp-body" id="tpBody">
            <div class="tp-template-grid" id="tpTemplateGrid">
                ${TITLE_TEMPLATE_KEYS.map((k) => `
                    <button class="tp-template-btn ${(active && active.template === k) || (!active && titlesSelectedTemplate === k) ? "active" : ""}" data-tpl="${k}" title="${TITLE_TEMPLATES[k].label} — ${TITLE_TEMPLATES[k].desc}">
                        ${TITLE_TEMPLATES[k].label}
                    </button>`).join("")}
            </div>
            <div class="tp-align-row" style="display:flex;gap:6px;margin-top:8px">
                <button class="tp-align-btn cg-mini-btn ${((active && (active.align || "center")) === "left") ? "active" : ""}" data-align="left" style="flex:1">Left</button>
                <button class="tp-align-btn cg-mini-btn ${((active && (active.align || "center")) === "center") ? "active" : ""}" data-align="center" style="flex:1">Center</button>
                <button class="tp-align-btn cg-mini-btn ${((active && (active.align || "center")) === "right") ? "active" : ""}" data-align="right" style="flex:1">Right</button>
            </div>
            <label class="cp-label" style="margin-top:8px">Title text <span class="cp-hint">(khali = caption-cue text use hoga)</span></label>
            <input type="text" id="tpText" class="tp-text-input" placeholder="Heading text (khaali = captions-cue line)..." value="${active && active.text ? String(active.text).replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;") : ""}" />
            <div class="tp-row" style="display:flex;gap:8px;margin-top:8px">
                <label style="flex:1;font-size:11px;color:#b9a7ff">Size<input type="range" id="tpScale" min="0.4" max="2.5" step="0.05" value="${active && active.scale != null ? active.scale : (titlesPendingScale != null ? titlesPendingScale : 1)}" style="width:100%"/></label>
                <label style="flex:1;font-size:11px;color:#b9a7ff">PosY<input type="range" id="tpPosY" min="0.05" max="0.95" step="0.01" value="${active && active.position && active.position.y != null ? active.position.y : (titlesPendingPosY != null ? titlesPendingPosY : 0.22)}" style="width:100%"/></label>
            </div>
            <div class="tp-actions" style="display:flex;gap:6px;margin-top:8px">
                <button id="tpAddBtn" class="cg-mini-btn" style="flex:1">＋ Title add karo (playhead par)</button>
            </div>
            <div class="tp-actions" style="display:flex;gap:6px;margin-top:6px">
                <button id="tpFromCuesBtn" class="cg-mini-btn" style="flex:1" ${hasCues ? "" : "disabled title=\"Pehle Auto Captions generate karo\""}>💬 Auto Captions se titles banao</button>
            </div>
            <div class="cp-hint-line" id="tpHint">Template par click karo — SELECTED / playhead-title ka style badal jayega. Span ko timeline par drag/resize kar sakte ho.</div>
        </div>
    `;

    // ---- align-buttons: span.align set + position.x preset par place karo ----
    document.querySelectorAll(".tp-align-btn").forEach((b) => {
        b.addEventListener("click", () => {
            const span = _titlesTargetSpan();
            const align = b.dataset.align;
            titlesAlign = align;
            document.querySelectorAll(".tp-align-btn").forEach((x) => x.classList.toggle("active", x === b));
            if (span) {
                span.align = align;
                span.position = { x: (TITLE_ALIGN_PRESETS[align] || TITLE_ALIGN_PRESETS.center).x, y: (span.position && span.position.y != null ? span.position.y : TITLE_DEFAULT_POSITION.y) };
                if (typeof persistTimelineState === "function") persistTimelineState();
                document.getElementById("tpStateLabel").textContent = `(align ${align})`;
            }
        });
    });

    // ---- template-buttons: selected / playhead-span par apply karo ----
    document.querySelectorAll(".tp-template-btn").forEach((b) => {
        b.addEventListener("click", () => {
            titlesSelectedTemplate = b.dataset.tpl;
            document.querySelectorAll(".tp-template-btn").forEach((x) => x.classList.toggle("active", x === b));
            const span = _titlesTargetSpan();
            if (span) {
                span.template = titlesSelectedTemplate;
                if (typeof persistTimelineState === "function") persistTimelineState();
                document.getElementById("tpStateLabel").textContent = `(updated ${span.template})`;
            }
        });
    });

    // ---- text input: selected / playhead-span par live-update ----
    const textEl = document.getElementById("tpText");
    if (textEl) textEl.addEventListener("input", () => {
        const span = _titlesTargetSpan();
        if (span) {
            span.text = textEl.value;
            if (typeof persistTimelineState === "function") persistTimelineState();
        }
    });

    // ---- size / posY sliders: target-span par LIVE update (fix: listeners missing the) ----
    const scaleEl = document.getElementById("tpScale");
    if (scaleEl) scaleEl.addEventListener("input", () => {
        const v = parseFloat(scaleEl.value);
        const span = _titlesTargetSpan();
        if (span) {
            span.scale = v;
            const lb = document.getElementById("tpStateLabel");
            if (lb) lb.textContent = `(size ${v.toFixed(2)})`;
        } else {
            titlesPendingScale = v; // koi span nahi -> agle title ke liye default
        }
        if (typeof persistTimelineState === "function") persistTimelineState();
    });
    const posEl = document.getElementById("tpPosY");
    if (posEl) posEl.addEventListener("input", () => {
        const v = parseFloat(posEl.value);
        const span = _titlesTargetSpan();
        if (span) {
            // x preserve — slider sirf Y change karta hai (x align/drag se aata hai)
            span.position = { x: (span.position && span.position.x != null) ? span.position.x : (TITLE_ALIGN_PRESETS[span.align || titlesAlign] || TITLE_ALIGN_PRESETS.center).x, y: v };
            const lb = document.getElementById("tpStateLabel");
            if (lb) lb.textContent = `(posY ${(v * 100).toFixed(0)}%)`;
        } else {
            titlesPendingPosY = v; // koi span nahi -> agle title ke liye default
        }
        if (typeof persistTimelineState === "function") persistTimelineState();
    });

    // ---- add-button ----
    const addB = document.getElementById("tpAddBtn");
    if (addB) addB.addEventListener("click", () => {
        if (typeof createEffectSpan !== "function") return;
        if (typeof pausePlayback === "function") pausePlayback();
        if (typeof playPauseBtnEl !== "undefined" && playPauseBtnEl) playPauseBtnEl.textContent = "▶";
        const base = (typeof virtualTime === "number" && isFinite(virtualTime)) ? virtualTime : 0;
        const seededText = document.getElementById("tpText") ? document.getElementById("tpText").value : "";
        createEffectSpan("titleSpan", base, base + 3, { template: titlesSelectedTemplate, align: titlesAlign, text: seededText });
    });

    // ---- auto-captions→titles converter ----
    const fromCues = document.getElementById("tpFromCuesBtn");
    if (fromCues) fromCues.addEventListener("click", () => titlesBuildFromCaptionCues());

    // ---- collapse ----
    const tog = document.getElementById("tpCollapse");
    if (tog) tog.addEventListener("click", () => {
        const body = document.getElementById("tpBody");
        body.style.display = body.style.display === "none" ? "" : "none";
        tog.textContent = body.style.display === "none" ? "▸" : "▾";
    });
}

let titlesAlign = "center";
// pending defaults: koi target-span na ho to sliders inhe set karte hain
// (agle naye title par yahi size/pos apply hoti hai)
let titlesPendingScale = 1.0;
let titlesPendingPosY = null; // null = TITLE_DEFAULT_POSITION.y

function _titlesTargetSpan() {
    if (typeof selectedItems !== "undefined" && selectedItems.length) {
        for (let i = selectedItems.length - 1; i >= 0; i--) {
            if (selectedItems[i].kind === "titleSpan") {
                const it = (titlesSpans || []).find((s) => s.id === selectedItems[i].id);
                if (it) return it;
            }
        }
    }
    if (typeof virtualTime === "number") return titleTemplateAt(virtualTime);
    return null;
}

// ===== AUTO-CAPTIONS→TITLES (caption-cues REUSE — whisper dobara nahi challega) =====
// Timeline-time mapping: caption-cues SOURCE-time me hote hain; timeline par
// video-clip mapping (sourceStart + offset) apply kar ke is span ko TIMELINE
// position par banaya jata hai — bilkul captions-render wahi source-time-map
// use karta hai, isliye title-text us span ke ANDAR hi dikhega (frame-proof).
function titlesBuildFromCaptionCues() {
    if (typeof captionCues === "undefined" || !captionCues.length) {
        alert("Pehle Auto Captions generate karo — titles usi transcript se bante hain.");
        return;
    }
    if (typeof pushHistory === "function") pushHistory();
    // SOURCE→TIMELINE map helper (videoClips ke sourceStart/offset/speed se)
    function _srcToTimeline(srcT) {
        const clips = (typeof videoClips !== "undefined") ? videoClips : [];
        for (const c of clips) {
            const speed = c.speed || 1;
            const sT = c.sourceStart, eT = (c.sourceEnd != null) ? c.sourceEnd : sT + (c.end - c.start) * speed;
            if (srcT >= sT && srcT <= eT) return c.start + (srcT - sT) / speed;
        }
        return srcT; // fallback as-is (no-clip edge)
    }
    titlesSpans.length = 0;
    (captionCues || []).forEach((c) => {
        const tlStart = _srcToTimeline(c.start);
        const tlEnd = _srcToTimeline(Math.max(c.end, c.start + 0.2));
        let wtxt = "";
        if (c.words && c.words.length) wtxt = c.words.map((w) => (w.text || "")).join(" ").replace(/\s+/g, " ").trim();
        else if (typeof c.text === "string") wtxt = c.text.trim();
        titlesSpans.push({
            id: (typeof genId === "function") ? genId() : ("ttl" + Math.random().toString(36)),
            start: tlStart, end: Math.max(tlEnd, tlStart + 0.2),
            template: titlesSelectedTemplate || "boldPop",
            align: titlesAlign || "center",
            text: wtxt,             // word-join (cue-word text — backend cues "text" key nahi rakhte!)
            position: { x: TITLE_ALIGN_PRESETS[titlesAlign] ? TITLE_ALIGN_PRESETS[titlesAlign].x : TITLE_DEFAULT_POSITION.x, y: TITLE_DEFAULT_POSITION.y },
            scale: 1.0,
        });
    });
    titlesCues = (captionCues || []).slice(); // mirrors captions to use in title drawing
    if (typeof recalcTimelineDuration === "function") recalcTimelineDuration();
    if (typeof renderAll === "function") renderAll();
    if (typeof invalidateSnapshot === "function") invalidateSnapshot();
    if (typeof persistTimelineState === "function") persistTimelineState();
    // Panel refresh (agar open hai)
    const wrap = document.getElementById("titlesPanel");
    if (wrap && (wrap.style.display === "block" || titlesPanelOpen)) buildTitlesPanel();
    const el = document.getElementById("tpHint");
    if (el) el.textContent = `${titlesSpans.length} titles captions-transcript se ban gaye — har cue = ek heading-span.`;
}

// ===== TITLES BUTTON (timeline control me) toggle =====
function toggleTitlesPanel() {
    const wrap = document.getElementById("titlesPanel");
    if (!wrap) return;
    titlesPanelOpen = !titlesPanelOpen;
    wrap.style.display = titlesPanelOpen ? "block" : "none";
    if (titlesPanelOpen) buildTitlesPanel();
}

// media-bin collapse par titles panel bhi fold (app.js pattern — subtitles wala)
function wireTitlesBtn() {
    const btn = document.getElementById("titlesToggleBtn");
    if (!btn) return;
    btn.addEventListener("click", toggleTitlesPanel);
    const syncBtn = () => { btn.classList.toggle("active", !!titlesPanelOpen); };
    btn.addEventListener("click", () => setTimeout(syncBtn, 0));
    syncBtn();
}
wireTitlesBtn();
