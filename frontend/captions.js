// ===== AUTO CAPTIONS =====
// Data (captionCues) SOURCE-time mein hai (backend jo deta hai). Render
// waqt hum current active-clip ke `sourceStart+offset` (window.__activeSourceTime,
// timeline.js set karta hai) use karte hain — isse agar video edited/trimmed ho
// chuki ho, ya us waqt koi clip active hi na ho (delete/gap), caption khud sahi
// jagah dikhega ya bilkul nahi dikhega.
//
// NAYA: styles ab 26 hain aur HAR EK ka APNA unique animation + color-
// highlighting hai (koi do styles ek jaise nahi). Animation primitives:
//   box (Hormozi), pop (MrBeast), rotPop (TikTok), glowPulse (Neon),
//   doubleBox (Podcast), lineBox (Bold Highlight), stamp (Big Pop),
//   fill (Karaoke Fill), underline (Minimal), none (Classic), popBounce
//   (Viral Yellow), boxBounce (Green Screen), glowSwap (Retro Wave), boxTilt
//   (Comic), shake (Gym Beast), tickerBar (News), fillSweep (Karaoke Wave),
//   underlineFloat (Soft Pastel), rgbCycle (Gaming RGB), slide (Ocean),
//   flash (Fire), boxRounded (Bubble Gum), strike (Mono Gray), outlineBox
//   (Banana Split), squash (Whisper Small).
// Backend (export_engine.py) ka draw_captions isi ka Python mirror hai —
// styles add/change karo to DONO taraf update karna hai.
// User ke paas COLOR overrides (text/active/highlight), size slider, "remember
// my settings" checkbox aur "reset to default" button bhi hain.

let captionCues = [];              // [{start, end, words:[{text,start,end}]}] — SOURCE time
let captionsEnabled = true;
let currentCaptionStyle = "hormozi";

// User ke color/size overrides — null = style ka apna default use karo
// DYNAMIC: ab har style ke APNE color-fields override ho sakte hain (jitne
// colors style me hain utne pickers panel me aate hain). Keys style ke property
// names hain (color/activeColor/highlightBg/glow/accentColor/neonPalette/...).
// Array fields (accentColors/neonPalette) per-swatch pickers hain.
let captionOverrides = { color: null, activeColor: null, highlightBg: null };
let captionRemember = true;        // "Remember my settings" checkbox

// ===== PER-STYLE COLOR FIELDS (dynamically panel me pickers banate hain) =====
// har entry: styleProp -> {label, list} — list=true to multi-swatch picker
// (array field). Jo fields HAAN style me mojood hain wohi pickers dikhengi —
// naya style banaye to sirf ye entry (agar custom label chahiye) add hoti hai.
const CAPTION_COLOR_FIELDS = [
    { prop: "color",       label: "Text",      list: false },
    { prop: "activeColor", label: "Active",   list: false },
    { prop: "highlightBg", label: "Highlight", list: false },
    { prop: "outline",      label: "Outline",   list: false },
    { prop: "glow",         label: "Glow",      list: false },
    { prop: "accentColor", label: "Keyword",   list: false },
    { prop: "accentColors", label: "Accent",    list: true, shortLabel: (n) => "Accent " + n },
    { prop: "neonPalette",  label: "Neon",      list: true, shortLabel: (n) => "Neon " + n },
];

// style object ke liye saare color-picker fields return karta hai (sirf wo jo
// style me mojood hain) — panel build + generic override resolve dono ise
// use karte hain.
function getStyleColorFields(styleObj) {
    return CAPTION_COLOR_FIELDS.filter((f) => {
        const v = styleObj[f.prop];
        if (f.list) return Array.isArray(v) && v.length > 0;
        return typeof v === "string" && v && (v.startsWith("#") || v.startsWith("rgb"));
    });
}

// ===== Position + Size (draggable/resizable — sirf 9:16 preview canvas par) =====
let captionPosition = { x: 0.5, y: 0.86 };  // normalized center-x, baseline-y (0-1)
let captionFontScale = 1.0;                  // size slider (0.4x - 3x)
let captionDragState = null;                 // { type: "move"|"resize", ... }
window.__captionBBox = null;                 // preview-canvas bbox (hit-testing ke liye)

// Har style sirf ek CONFIG hai — naya style banane ka matlab hai yahan
// ek naya entry add karna, kahin aur kuch chhedne ki zaroorat nahi.
const CAPTION_STYLES = {
    hormozi: {
        label: "Hormozi Style",
        fontWeight: "900",
        baseFontPx: 58,
        color: "#ffffff",
        activeColor: "#111111",
        highlightBg: "#ffd42a",
        outline: "#000000",
        animation: "box",
        uppercase: true,
    },
    mrbeast: {
        label: "MrBeast Style",
        fontWeight: "900",
        baseFontPx: 56,
        color: "#ffffff",
        activeColor: "#00ff33",
        highlightBg: null,
        outline: "#000000",
        outlineWidth: 5,
        animation: "pop",
        uppercase: true,
    },
    tiktokPop: {
        label: "TikTok Pop",
        fontWeight: "900",
        baseFontPx: 54,
        color: "#ffffff",
        activeColor: "#ff2d55",
        highlightBg: null,
        outline: "#000000",
        animation: "rotPop",   // active word alternate tilt + pop (left/right)
        uppercase: true,
    },
    neonGlow: {
        label: "Neon Glow",
        fontWeight: "800",
        baseFontPx: 52,
        color: "#eaffff",
        activeColor: "#00e5ff",
        highlightBg: null,
        outline: "#1b5e7a",
        glow: "#00e5ff",          // active word par neon shadow-glow
        animation: "glowPulse",   // glow ki intensity word-duration mein pulse
        uppercase: true,
    },
    podcastBold: {
        label: "Podcast Bold",
        fontWeight: "800",
        baseFontPx: 50,
        color: "#ffffff",
        activeColor: "#ffffff",
        highlightBg: "#e63946",
        outline: "#000000",
        animation: "doubleBox",  // red box + uske bahar white border
        uppercase: true,
    },
    boldHighlight: {
        label: "Bold Highlight",
        fontWeight: "800",
        baseFontPx: 54,
        color: "#ffffff",
        activeColor: "#111111",
        highlightBg: "#ffde59",
        outline: "#000000",
        animation: "lineBox",  // POORI line ke peeche ek box + active word black
        uppercase: true,
    },
    bigPop: {
        label: "Big Pop",
        fontWeight: "900",
        baseFontPx: 60,
        color: "#ffffff",
        activeColor: "#ffde59",
        highlightBg: null,
        outline: "#000000",
        animation: "stamp",   // rubber-stamp: active word BOHOT bara (1.35x)
        uppercase: true,
    },
    karaokeFill: {
        label: "Karaoke Fill",
        fontWeight: "700",
        baseFontPx: 48,
        color: "rgba(255,255,255,0.45)",
        activeColor: "#2fb8a6",
        highlightBg: null,
        outline: "#000000",
        animation: "fill",
        uppercase: false,
    },
    minimal: {
        label: "Minimal Clean",
        fontWeight: "500",
        baseFontPx: 42,
        color: "#ffffff",
        activeColor: "#2fb8a6",
        highlightBg: null,
        outline: null,
        animation: "underline",
        uppercase: false,
    },
    classic: {
        label: "Classic Subtitle",
        fontWeight: "400",
        baseFontPx: 44,
        color: "#ffffff",
        activeColor: "#ffffff",
        highlightBg: null,
        outline: "#000000",
        animation: "none",
        uppercase: false,
    },
    // ===== NAYE 16 STYLES (total 26) =====
    viralYellow: {
        label: "Viral Yellow",
        fontWeight: "900",
        baseFontPx: 60,
        color: "#ffffff",
        activeColor: "#ffe600",
        highlightBg: null,
        outline: "#000000",
        outlineWidth: 5,
        animation: "popBounce",  // pop + upar uchhalne wala bounce
        uppercase: true,
    },
    greenScreen: {
        label: "Green Screen",
        fontWeight: "900",
        baseFontPx: 54,
        color: "#00ff00",
        activeColor: "#ffffff",
        highlightBg: "#111111",
        outline: "#000000",
        outlineWidth: 2,
        animation: "boxBounce",  // box ke andar word bounce karta hai
        uppercase: true,
    },
    retroWave: {
        label: "Retro Wave",
        fontWeight: "800",
        baseFontPx: 52,
        color: "#ff71ce",
        activeColor: "#01cdfe",
        highlightBg: null,
        outline: "#28003c",
        glow: "#b967ff",
        glow2: "#01cdfe",       // har doosre word ka glow color badalta hai
        animation: "glowSwap",
        uppercase: true,
    },
    comicPop: {
        label: "Comic Pop",
        fontWeight: "900",
        baseFontPx: 56,
        color: "#ffffff",
        activeColor: "#ff2d55",
        highlightBg: "#ffde00",
        outline: "#000000",
        outlineWidth: 4,
        animation: "boxTilt",  // comic-style tilted highlight box
        uppercase: true,
    },
    gymBeast: {
        label: "Gym Beast",
        fontWeight: "900",
        baseFontPx: 62,
        color: "#ffffff",
        activeColor: "#ff3800",
        highlightBg: "#111111",
        outline: "#000000",
        outlineWidth: 5,
        animation: "shake",   // active word shor machata hua hilta hai
        uppercase: true,
    },
    newsTicker: {
        label: "News Ticker",
        fontWeight: "700",
        baseFontPx: 42,
        color: "#000000",
        activeColor: "#000000",
        highlightBg: "#ffffff",
        outline: "#ffffff",
        outlineWidth: 2,
        animation: "tickerBar",  // full-height ticker bar active word par
        uppercase: false,
    },
    karaokeWave: {
        label: "Karaoke Wave",
        fontWeight: "800",
        baseFontPx: 50,
        color: "rgba(255,255,255,0.45)",
        activeColor: "#00e5ff",
        highlightBg: null,
        outline: "#000000",
        animation: "fillSweep",  // word left->right PROGRESSIVELY fill hota hai
        uppercase: false,
    },
    softPastel: {
        label: "Soft Pastel",
        fontWeight: "600",
        baseFontPx: 46,
        color: "#ffd1dc",
        activeColor: "#ff8fab",
        highlightBg: null,
        outline: null,
        animation: "underlineFloat",  // bar ke sath word halka upar uthta hai
        uppercase: false,
    },
    gamingRgb: {
        label: "Gaming RGB",
        fontWeight: "900",
        baseFontPx: 54,
        color: "#39ff14",
        activeColor: "#ffffff",
        highlightBg: "#111111",
        outline: "#000000",
        outlineWidth: 3,
        activePalette: ["#ff2d55", "#ffe600", "#00e5ff", "#a855f7", "#39ff14"],  // har word ka apna rang
        animation: "rgbCycle",  // active word ka rang palette se cycle hota hai
        uppercase: true,
    },
    luxuryGold: {
        label: "Luxury Gold",
        fontWeight: "800",
        baseFontPx: 52,
        color: "#d4af37",
        activeColor: "#ffffff",
        highlightBg: null,
        outline: "#000000",
        glow: "#d4af37",
        animation: "glow",
        uppercase: true,
    },
    oceanBlue: {
        label: "Ocean Blue",
        fontWeight: "800",
        baseFontPx: 52,
        color: "#ffffff",
        activeColor: "#4cc9f0",
        highlightBg: null,
        outline: "#003049",
        outlineWidth: 4,
        animation: "slide",   // active word left se slide-in + fade
        uppercase: true,
    },
    fireRed: {
        label: "Fire Red",
        fontWeight: "900",
        baseFontPx: 58,
        color: "#ffffff",
        activeColor: "#ff4d00",
        highlightBg: null,
        outline: "#200000",
        outlineWidth: 4.5,
        animation: "flash",   // aag jaisi flash: word bolne ke sath intensity badle
        uppercase: true,
    },
    bubbleGum: {
        label: "Bubble Gum",
        fontWeight: "900",
        baseFontPx: 54,
        color: "#ffffff",
        activeColor: "#ffffff",
        highlightBg: "#ff5da2",
        outline: "#000000",
        outlineWidth: 3,
        animation: "boxRounded",  // gulabi rounded-pill highlight
        uppercase: true,
    },
    monoGray: {
        label: "Mono Gray",
        fontWeight: "600",
        baseFontPx: 46,
        color: "#d0d0d0",
        activeColor: "#ffffff",
        highlightBg: null,
        outline: "#333333",
        outlineWidth: 2,
        animation: "strike",  // active word par editorial strikethrough
        uppercase: false,
    },
    bananaSplit: {
        label: "Banana Split",
        fontWeight: "900",
        baseFontPx: 56,
        color: "#111111",
        activeColor: "#111111",
        highlightBg: "#ffe135",
        outline: "#000000",
        outlineWidth: 3,
        animation: "outlineBox",  // filled box nahi — thick yellow OUTLINE box
        uppercase: true,
    },
    whisperSmall: {
        label: "Whisper Small",
        fontWeight: "400",
        baseFontPx: 34,
        color: "#eeeeee",
        activeColor: "#ffffff",
        highlightBg: null,
        outline: "#000000",
        outlineWidth: 2,
        animation: "squash",  // active word halka squash + brighten (subtle)
        uppercase: false,
    },
    // ===== "MY CAPTION" STYLES (sample-video mirror: white words + active word
    // bright-yellow + golden glow + pop; sentence case, koi box/outline nahi) =====
    myCaption1: {
        label: "My Caption 1",
        fontWeight: "900",
        baseFontPx: 58,
        color: "#ffffff",
        activeColor: "#ffe200",
        highlightBg: null,
        outline: null,
        glow: "#ffd400",
        glowAll: true,          // HARB koil — sample video look
        animation: "glowPop",   // active: golden glow + pop-scale
        uppercase: false,
    },
    myCaption2: {
        label: "My Caption 2",
        fontWeight: "800",
        baseFontPx: 54,
        color: "rgba(255,255,255,0.78)",
        activeColor: "#ffdd00",
        highlightBg: null,
        outline: null,
        glow: "#ffe63e",
        glowAll: true,
        animation: "popFill",   // active: pop + white→yellow fill
        uppercase: false,
    },
    // ===== MY CAPTION 3 — sample-video ka EXACT look =====
    // 2-words-per-line multi-line wrap; KEY words (video/editor/work/business)
    // BADE + yellow + glow hote hain, filler words (are/you/a/for/looking)
    // chhote + white; active word par extra pop.
    myCaption3: {
        label: "My Caption 3",
        fontWeight: "900",
        baseFontPx: 56,
        color: "#ffffff",
        activeColor: "#ffe200",
        highlightBg: null,
        outline: null,
        glow: "#ffd400",
        glowAll: false,
        animation: "wrapBig",   // custom multi-line renderer (neeche wrapBig branch)
        uppercase: false,
    },
    // ===== MY CAPTION 4 — mussy-style sample ka EXACT look =====
    // SINGLE line; non-active words dim (~45% opacity), jo word bolne ka time
    // hai wo SMOOTH fade-up kar ke white hota hai; REPEATER keyword (1st/last
    // word rule neeche fadeCloud branch) BLUE; word ON hone par quick pop.
    myCaption4: {
        label: "My Caption 4",
        fontWeight: "800",
        baseFontPx: 62,
        color: "#ffffff",
        activeColor: "#ffffff",
        highlightBg: null,
        outline: null,
        glow: null,
        accentColor: "#2e8bff",     // keyword color (first/clipping/followers...)
        dimOpacity: 0.42,           // baaqi words kitne faded
        fadeUp: 14,                 // ON-word smooth float-up px
        animation: "fadeCloud",     // custom renderer (neeche fadeCloud branch)
        uppercase: true,
    },
    // ===== MY CAPTION 5 — mussy full-video ka EXACT look =====
    // per-pair REVEAL: unspoken pair dim, jo pair bolne wala hai wo ACCENT
    // color (keyword-cycle: blue/purple/green/red), bol-chuka pair solid
    // WHITE; max-2-word wrap (3+ words = 2 lines); accent word par slight
    // scale-up; poore block par soft black glow-shadow (readability).
    myCaption5: {
        label: "My Caption 5",
        fontWeight: "800",
        baseFontPx: 60,
        color: "#ffffff",
        activeColor: "#ffffff",      // bol-chuka pair yahi solid white hota hai
        highlightBg: null,
        outline: null,
        glow: null,
        accentColors: ["#33b1ff", "#a34bff", "#33cc55", "#ff2d28"],  // wireless aur HAR keyword-cycle agar bole
        dimOpacity: 0.55,            // upcoming pairs ghost-kitne faded
        fadeUp: 0,                   // ye style fade only (koi move nahi)
        animScale: 1.06,             // reveal par thoda bara hota hai
        animation: "fadeSplit",      // custom renderer (neeche fadeSplit branch)
        uppercase: true,
    },
    // ===== MY CAPTION 6 — mussy NEON multi-color sample mirror =====
    // CHUNKS: (1) har phrase 2-4 WHITE words + 1-3 COLORED words — pehle white
    // phir colored; (2) chunk ka NAYA color palette se, pichle ka repeat NAHI;
    // (3) WHITE words CHHOTE (~85%), COLORED words BARE (~118% — video me
    // FOLLOWERS / MONEY ONLINE NOWADAYS / NEVER BEEN EASIER sab colored-bare);
    // (4) line 1 ~57px, line 2 ~85% (tight stacked, centers-centered);
    // (5) word apni FINAL jagah par fade-in (blur+alpha, koi slide nahi).
    myCaption6: {
        label: "My Caption 6",
        fontWeight: "700",
        baseFontPx: 57,
        color: "#ffffff",
        activeColor: "#01cdfe",
        highlightBg: null,
        outline: null,
        glow: "#01cdfe",
        neonPalette: ["#2db4ff", "#4a8cff", "#ffc21a", "#ffe600", "#1fe6f2", "#ff3de0", "#ff5ad9", "#ff1c1c", "#4dff6a", "#b36bff"],  // video palette (10 colors)
        neonChunkMax: 3,           // colored chunk kabhi 3 se zyada nahi
        animScale: 1.04,           // reveal par soft punch
        line2Ratio: 0.85,          // line-2 ~85% of line-1 (video)
        lineGapRatio: 0.7,         // tight stacking
        emphasisRed: "#ff1010",   // EMPHASIS single-huge-word color
        animation: "neonChunks",   // custom renderer (neeche neonChunks branch)
        uppercase: true,
    },
};

// Style + user-overrides merge kar ke EFFECTIVE style deta hai
// GENERIC: ab sirf fixed 3 nahi — har style-prop (dynamic fields + purane 3)
// par user override apply hota hai. Array-override: user ne poora array set
// kiya (N swatches) to replace hota hai; warna style ka apna.
function getEffectiveCaptionStyle() {
    const base = CAPTION_STYLES[currentCaptionStyle] || CAPTION_STYLES.hormozi;
    const eff0 = { ...base };                          // style-scope (panel preview value ke liye)
    const fields = getStyleColorFields(eff0);
    // PURANE 3 fixed keys bhi saath me (backward-compat: koi naya style jisme
    // color/activeColor/highlightBg string nahi hai jaise rgba default — wo bhi)
    const eff = { ...base };
    fields.forEach((f) => {
        const ov = captionOverrides[f.prop];
        if (ov == null) return;
        if (f.list) {
            if (Array.isArray(ov) && ov.length) eff[f.prop] = ov.slice();
        } else {
            eff[f.prop] = ov;
        }
    });
    // legacy flat keys (back-compat jo pehle se the):
    if (captionOverrides.color) eff.color = captionOverrides.color;
    if (captionOverrides.activeColor) eff.activeColor = captionOverrides.activeColor;
    if (captionOverrides.highlightBg !== null && captionOverrides.highlightBg !== undefined) {
        eff.highlightBg = captionOverrides.highlightBg;
    }
    return eff;
}

// Panel preview-value resolve (disabled-picker me style ka current color dikhane
// ke liye): string-color ya list-swatch at index n.
function _getPreviewColor(eff, f, idx) {
    const v = eff[f.prop];
    if (f.list) {
        if (!Array.isArray(v) || !v.length) return "#ffffff";
        return (v[idx != null ? idx : 0]) || "#ffffff";
    }
    const s = typeof v === "string" ? v : "#ffffff";
    // rgba(255,255,255,0.45) jaisa non-hex color — picker sirf readable hex dikhata hai
    if (s.startsWith("rgba") || s.startsWith("rgb")) {
        const m = s.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/);
        if (m) return "#" + [m[1], m[2], m[3]].map((c) => parseInt(c, 10).toString(16).padStart(2, "0")).join("");
    }
    return s.startsWith("#") ? s : "#ffffff";
}

function getActiveCaptionCue() {
    if (!captionsEnabled || !captionCues.length) return null;
    const srcT = window.__activeSourceTime;
    if (srcT == null || srcT === undefined) return null;
    return captionCues.find((c) => srcT >= c.start && srcT < c.end) || null;
}

// rectX/rectY/rectW/rectH = us canvas ke andar video-frame ka area.
// isPreview = true jab preview-canvas (final 9:16 output) par draw ho raha ho.
function drawCaptionsOnCanvas(ctx, rectX, rectY, rectW, rectH, refHeightPx, isPreview) {
    const cue = getActiveCaptionCue();
    if (!cue) {
        if (isPreview) window.__captionBBox = null;
        return;
    }
    // DEFENSIVE: purane persisted state se cue aaye jis mein words hi na hon
    // (ya koi word adhoora ho) — pehle yahan seedha .map crash karta tha aur
    // render loop maar jata tha (dono canvas blank). Ab aise cues skip hote hain.
    if (!cue.words || !cue.words.length || cue.words.some((w) => !w || typeof w.text !== "string")) {
        if (isPreview) window.__captionBBox = null;
        return;
    }

    const style = getEffectiveCaptionStyle();
    const srcT = window.__activeSourceTime;
    const scale = rectH / (refHeightPx || 1080);
    // (MC6 FIX) baseFontPx per-style hota hai — jab tak style me "baseFontPx"
    // nahi hai (legacy callers), hormozi default 58 use karo.
    const fontBasePx = ((style.baseFontPx != null) ? style.baseFontPx : 58);
    const fontSize = Math.max(10, fontBasePx * scale * captionFontScale);

    ctx.save();
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.font = `${style.fontWeight} ${fontSize}px Arial, sans-serif`;

    const words = cue.words.map((w) => (style.uppercase ? w.text.toUpperCase() : w.text));
    const gap = 10 * scale;
    const widths = words.map((w) => ctx.measureText(w).width);
    const totalWidth = widths.reduce((a, b) => a + b, 0) + gap * Math.max(0, words.length - 1);

    // agar line canvas se chauri hai, font ko itna shrink karo ke fit ho jaye
    let fitScale = 1;
    if (totalWidth > rectW * 0.92) fitScale = (rectW * 0.92) / totalWidth;
    if (fitScale < 1) {
        ctx.font = `${style.fontWeight} ${fontSize * fitScale}px Arial, sans-serif`;
        for (let i = 0; i < words.length; i++) widths[i] = ctx.measureText(words[i]).width;
    }
    const finalGap = gap * fitScale;
    const finalTotalWidth = widths.reduce((a, b) => a + b, 0) + finalGap * Math.max(0, words.length - 1);
    const finalFontSize = fontSize * fitScale;

    const cxBase = rectX + rectW * captionPosition.x;

    // ===== "My Caption 6" — neonChunks renderer (mussy NEON video mirror) =====
    // PHRASE-CHUNKING: 2-4 white words + 1-3 colored (NEON) words — har colored
    // chunk ko palette se RANDOM lega DIFFERENT color (pichle color repeat nahi,
    // deterministic seed = cue-index). 2 lines: L1 ~57px (y=52%), L2 ~85% (y=58%)
    // tight stacked (~0.7 lh). Layout PRE-COMPUTED & centered — har word apni
    // FINAL jagah par fade-in hota hai (alpha+blur in, koi slide/bounce nahi).
    // Word reveal ~100ms. NEON = glow same color (6px + 14px @60%) + dark strip.
    // EMPHASIS 1-word: huge + RED + scale-punch 1.3->1 (sirf AGAR cue ka 1 hi
    // word ho aur wo 15+ sec per 1x ho — heuristically: cue.length==1).
    if (style.animation === "neonChunks") {
        const cx6 = rectX + rectW * captionPosition.x;
        // DRAG-FOLLOW: lines captionPosition.y se derive — default pos.y=.86
        // par L1=52% / L2=58% (video), drag par poora block saath move hota hai.
        const clamp01 = (v) => Math.min(0.98, Math.max(0.02, v));
        const yL1 = rectY + rectH * clamp01(captionPosition.y - 0.34);
        const yLine1 = yL1;
        const yLine2 = yL1 + rectH * 0.06;
        const ySingle = rectY + rectH * clamp01(captionPosition.y - 0.31);
        const pal = (style.neonPalette && style.neonPalette.length) ? style.neonPalette : ["#2db4ff"];
        const fs1 = fontBasePx * scale * captionFontScale;
        const fs2 = fs1 * ((style.line2Ratio != null) ? style.line2Ratio : 0.85);

        // --- cue INDEX (deterministic seed — random-color per-chunk) ---
        let cueIdx = captionCues.indexOf(cue);
        if (cueIdx < 0) cueIdx = 0;

        // --- CHUNK build: 2-4 white + 1-3 colored (seeded) ---
        // GUARANTEE: har cue me kam-az-kam 1 COLORED chunk ho (video: 3-word
        // phrases bhi colored the — NEVER BEEN EASIER). 3-word cue me white
        // chunk max 2 word, taake 1 colored bachay.
        const chunks = [];
        const W = cue.words.length;
        let wi = 0;
        let lastColor = -1;
        // colored chunk ke WORDS REQUIRED: W=3 → white max 1; W>=4 → white max W-2
        const maxWhite = (W <= 3) ? Math.max(1, W - 2) : Math.max(2, W - 2);
        while (wi < W) {
            const remains = W - wi;
            // white chunk: 2-4 words — colored ke baad W bacha to white
            let wc = 2 + Math.floor(((cueIdx * 7 + wi * 3) % 3));
            if (remains <= maxWhite + 1) wc = remains - 1;           // colored ke liye 1 word chhodo (agar W>=3)
            if (remains - wc < 1) wc = remains - 1;                  // (W=2: 1 white + 1 colored)
            wc = Math.max(1, Math.min(wc, remains));
            const white = [];
            for (let k = 0; k < wc && wi < W; k++) white.push(wi++);
            if (white.length && (white.length < W || chunks.length)) chunks.push({ idxs: white, color: null });
            // colored chunk: 1-3 words (never same color as previous)
            if (wi < W) {
                const cc = Math.min(1 + ((cueIdx + wi) % 3), W - wi);
                let ci = Math.floor(Math.abs(Math.sin(cueIdx * 17.3 + wi * 7.7)) * pal.length) % pal.length;
                if (ci === lastColor) ci = (ci + 1 + ((cueIdx + wi) % (pal.length - 1))) % pal.length;
                lastColor = ci;
                const col = [];
                for (let k = 0; k < cc && wi < W; k++) col.push(wi++);
                chunks.push({ idxs: col, color: pal[ci] });
            }
        }
        // LAST-WO: agar COLORED chunk hi nahi bana (sab white), aakhri word ko
        // forced-colored kar do (video spec: har phrase me accents hote hain)
        if (chunks.length && !chunks.some((c) => c.color)) {
            chunks[chunks.length - 1].color = pal[Math.floor(Math.abs(Math.sin(cueIdx * 17.3)) * pal.length) % pal.length];
        }

        // --- LINE BUILD: chunking se lines, 86% width par greedy wrap.
        // PER-WORD SIZE (video f001/f018/f030 ka ASLI look): WHITE words CHHOTE
        // (~85%), COLORED words BARE (~118% — video me FOLLOWERS / MONEY ONLINE
        // NOWADAYS / NEVER BEEN EASIER sab colored-bare the). Har line CENTERED.
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        const ctxFont = (fs) => { ctx.font = `${style.fontWeight} ${fs}px Arial, sans-serif`; };
        const gapW = 10 * scale;
        const fsWhite = fs2;          // white words chhote (~85%)
        const fsColor = fs1 * 1.18;   // NEON words BARE
        const widthsAt = (w, fs) => { ctxFont(fs); return ctx.measureText(w).width; };

        const wordColor = [], wordFs = [];
        chunks.forEach((c) => c.idxs.forEach((i) => { wordColor[i] = c.color; wordFs[i] = c.color ? fsColor : fsWhite; }));

        const lines = [];
        let cur = [], curW = 0;
        for (let i = 0; i < W; i++) {
            const ww = widthsAt(words[i], wordFs[i]);
            if (cur.length && (curW + gapW + ww) > rectW * 0.86) {
                lines.push(cur);
                cur = []; curW = 0;
            }
            cur.push({ i, ww, fs: wordFs[i], color: wordColor[i] || null });
            curW += cur.length > 1 ? gapW + ww : ww;
        }
        if (cur.length) lines.push(cur);

        // badi line 88% ke andar squash (saare words proportional chhote)
        lines.forEach((ln) => {
            let tot = ln.reduce((a, it) => a + it.ww, 0) + gapW * (ln.length - 1);
            if (tot > rectW * 0.88) {
                const f = (rectW * 0.88) / tot;
                ln.forEach((it) => { it.ww *= f; it.fs *= f; });
                tot *= f;
            }
            ln._w = tot;
        });

        // layout: lines centered — drag-follow (pos.y=.86 → L1 52% / L2 58%)
        const layout = [];
        const lineH = fsColor * 0.62 * scale;   // tight stacking (video jaisa)
        lines.forEach((ln, li) => {
            const cy = lines.length === 1 ? ySingle : (li === 0 ? yLine1 : yLine2 + (li - 1) * lineH);
            let lx = cx6 - ln._w / 2;
            ln.forEach((it) => {
                layout.push({ i: it.i, x: lx + it.ww / 2, y: cy, fs: it.fs, color: it.color });
                lx += it.ww + gapW;
            });
        });

        // --- word reveal state (alpha+blur in ~100ms = 3 frames) ---
        layout.forEach((it) => {
            const w = cue.words[it.i];
            const act = srcT != null && srcT >= w.start && srcT < w.end;
            const spoken = srcT != null && srcT >= w.end;
            const dur = Math.min(0.1, (w.end - w.start) || 0.1);
            const tt = act ? Math.min(1, Math.max(0, (srcT - w.start) / Math.max(0.02, dur))) : (spoken ? 1 : 0);
            it.alpha = tt;
            it.blur = (1 - tt) * 4;
            it.spoken = spoken;
            const heading = (it.color && act) || (it.color && spoken);
            it.fill = it.color || style.color;
            // NEON: colored word = same-color glow (6 & 14px @60%) + dark drop
            it.neon = !!it.color;
            it.pop = act ? 1 + ((style.animScale || 1.04) - 1) * Math.sin(tt * Math.PI) : 1;
        });

        layout.forEach((it) => {
            if (it.alpha <= 0) return;
            ctx.save();
            ctx.globalAlpha = Math.max(0, Math.min(1, it.alpha));
            ctx.translate(it.x, it.y);
            ctx.scale(it.pop, it.pop);
            ctxFont(it.fs);
            if (it.neon) {
                ctx.shadowColor = it.color;
                ctx.shadowBlur = 6 * scale;
                ctx.fillStyle = it.color;
                ctx.fillText(words[it.i], 0, 0);
                ctx.shadowColor = it.color;
                ctx.shadowBlur = 14 * scale;
                ctx.globalAlpha = Math.max(0, Math.min(1, it.alpha * 0.6));
                ctx.fillText(words[it.i], 0, 0);
                ctx.globalAlpha = Math.max(0, Math.min(1, it.alpha));
            }
            // dark drop shadow har word ke peeche
            ctx.shadowColor = "rgba(0,0,0,0.5)";
            ctx.shadowBlur = 6 * scale;
            ctx.shadowOffsetY = 2 * scale;
            ctxFont(it.fs);
            ctx.fillStyle = it.fill;
            ctx.fillText(words[it.i], 0, 0);
            ctx.restore();
        });

        ctx.restore();
        if (isPreview) {
            const pad = 14 * scale;
            const minX = Math.min(...layout.map((l) => l.x), cx6), maxX = Math.max(...layout.map((l) => l.x), cx6);
            const minY = Math.min(...layout.map((l) => l.y)), maxY = Math.max(...layout.map((l) => l.y));
            window.__captionBBox = { x: minX - pad, y: minY - fs2 / 2 - pad, w: (maxX - minX) + pad * 2, h: (maxY - minY) + fs2 + pad * 2 };
        }
        return;
    }

    // ===== "My Caption 5" — fadeSplit renderer (mussy full-video mirror) =====
    // MAX 2 WORDS PER LINE — 3+ words wale cues 2 lines mein bat jaate hain
    // (live video jaisa). Per-pair REVEAL: abi-nahin-bole pairs dim (ghost),
    // jo pair ABHI bole wala hai wo ACCENT COLOR mein reveal hota hai
    // (color-cycle: naya keyword naya random palet color), bol-chuka pair
    // solid WHITE. Reveal par animScale (thoda bara). Soft black shadow
    // poore text par (thick dark edge, video jaisi readability).
    if (style.animation === "fadeSplit") {
        const cxBaseL = rectX + rectW * captionPosition.x;
        const yC = rectY + rectH * captionPosition.y;
        const dim = (style.dimOpacity != null) ? style.dimOpacity : 0.55;
        const animS = (style.animScale != null) ? style.animScale : 1.06;
        const accents = (style.accentColors != null && style.accentColors.length) ? style.accentColors : ["#33b1ff"];

        // per-word reveal state: ACCENT color DETERMINISTIC — word ke pehle
        // (usi cue mein) kitne keywords aaye, us count se palette dedo; is se
        // har frame pe color flicker nahi hota (counter per-frame bug foold).
        const isKwBase = (txt) => ((txt || "").replace(/[^a-zA-Z0-9$]/g, "")).length >= 4;
        let kwBefore = 0;
        const wState = cue.words.map((w) => {
            const isKeyword = isKwBase(w.text || "");
            const accentIdx = kwBefore;
            if (isKeyword) kwBefore++;
            const act = srcT != null && srcT >= w.start && srcT < w.end;
            const dur = Math.min(0.25, (w.end - w.start) || 0.2);
            const tt = act ? Math.min(1, Math.max(0, (srcT - w.start) / Math.max(0.02, dur))) : 1;
            const reveal = act || (w.end != null && w.end <= (srcT == null ? Infinity : srcT));
            // keyword hamesha accent color (unspoken = ghost-dim accent bhi —
            // video me GATEWAYS/PAGE unspoken par bhi blue/purple tint tha)
            const accentColor = isKeyword ? accents[accentIdx % accents.length] : null;
            return {
                act, tt, reveal,
                isKeyword,
                alpha: act ? (dim + (1 - dim) * tt) : (reveal ? 1 : dim),
                accentColor,
            };
        });

        // 2-WORD LINES: max 2 words per line (3+ words = 2 lines)
        const gapW = 16 * scale;
        const linesArr = [];
        for (let i = 0; i < cue.words.length; i += 2) linesArr.push(cue.words.slice(i, i + 2));

        // per-line per-word measure (statement style per-line)
        const lw2 = [];
        const fsLine = finalFontSize;
        const lh2 = fsLine * 1.05;
        linesArr.forEach((ln) => {
            let wsum = 0;
            const ws = [];
            ln.forEach((w, j) => {
                const idx = cue.words.indexOf(w);
                ww = widths[idx] || 0;
                ws.push(ww);
                wsum += ww + (j > 0 ? gapW : 0);
            });
            lw2.push({ lineW: wsum, ws });
        });

        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        let ly = yC - (linesArr.length * lh2) / 2 + lh2 / 2;
        linesArr.forEach((ln, li) => {
            const lwid = lw2[li].lineW;
            let lx = cxBaseL - lwid / 2;
            ln.forEach((w, j) => {
                const idx = cue.words.indexOf(w);
                const st = wState[idx];
                const isAct = st.act;
                // video jaisa: keyword (chah.e GHUS bhi) = ACCENT color (dark)
                // ACTIVE keyword = accent BRIGHT; nahi keyword = white;
                // bol-chuka = solid white
                let fill;
                const accentOn = st.isKeyword && (st.act || !st.reveal);
                if (st.isKeyword && accentOn) fill = st.accentColor;
                else if (st.reveal) fill = style.activeColor;
                else fill = style.color;
                const pop = isAct ? 1 + (animS - 1) * (1 - Math.abs(2 * st.tt - 1)) : 1;
                ctx.save();
                ctx.globalAlpha = Math.max(0, Math.min(1, st.alpha));
                ctx.translate(lx + lw2[li].ws[j] / 2, ly);
                ctx.scale(pop, pop);
                ctx.font = `${style.fontWeight} ${fsLine}px Arial, sans-serif`;
                ctx.fillStyle = fill;
                // soft black shadow (video ka dark readability-edge)
                ctx.shadowColor = "rgba(0,0,0,0.55)";
                ctx.shadowBlur = 14 * scale;
                ctx.fillText(words[idx], 0, 0);
                ctx.restore();
                lx += lw2[li].ws[j] + gapW;
            });
            ly += lh2;
        });
        ctx.restore();
        if (isPreview) {
            const pad = 14 * scale;
            const maxW = Math.max(...lw2.map((o) => o.lineW));
            window.__captionBBox = {
                x: cxBaseL - maxW / 2 - pad,
                y: yC - (linesArr.length * lh2) / 2 - pad,
                w: maxW + pad * 2,
                h: linesArr.length * lh2 + pad * 2,
            };
        }
        return;
    }

    // ===== "My Caption 4" — fadeCloud renderer (mussy-sample mirror) =====
    // Ek SINGLE line (fit-scale same simple wale branch ka). Har word:
    //   - saath-baaki words: dim (style.dimOpacity ~0.45), opaque white jab bol
    //     chuka; non-repeated words ki base-color white
    //   - bolne-wala word: smooth fade-up (style.fadeUp px) + alpha 0->1
    //   - HOW/AI dimmed saaye ko — pehle words ghost-jaisa (alpha ~0.5)
    //   - PEHLA/LAST KEYWORD (ya cue ka 1st & 3rd word) -> style.accentColor
    if (style.animation === "fadeCloud") {
        const dim = (style.dimOpacity != null) ? style.dimOpacity : 0.5;
        const rise = ((style.fadeUp != null) ? style.fadeUp : 14) * scale;
        const cxBaseL = rectX + rectW * captionPosition.x;
        const yC = rectY + rectH * captionPosition.y;

        // REPEATER-keyword accent: jo word >=4 letters ka poore video mein
        // behas 2+ dafa aata hai (mussy-style: FIRST / CLIPAI / FOLLOWERS...)
        // wo accent color (blue) hota hai, baqi words white.
        let dict = null;
        try {
            if (typeof captionCues !== "undefined" && captionCues.length) {
                dict = {};
                captionCues.forEach((c) => (c.words || []).forEach((w) => {
                    const b = (w.text || "").toLowerCase().replace(/[^a-z0-9]/g, "");
                    if (b.length >= 4) dict[b] = (dict[b] || 0) + 1;
                }));
            }
        } catch (e) { dict = null; }
        const isAccent = (txt) => {
            if (!dict) return false;
            const b = (txt || "").toLowerCase().replace(/[^a-z0-9]/g, "");
            return b.length >= 4 && dict[b] >= 2;
        };

        // per-word reveal state (active word smooth fade-up hota hai)
        const wState = cue.words.map((w) => {
            const act = srcT != null && srcT >= w.start && srcT < w.end;
            const dur = Math.min(0.22, (w.end - w.start) || 0.2);
            const tt = act ? Math.min(1, Math.max(0, (srcT - w.start) / Math.max(0.02, dur))) : 1;
            const alpha = act ? (0.3 + 0.7 * tt) : (w.end <= srcT ? 1 : dim);
            return {
                act, tt, alpha,
                dy: act ? -rise * tt : 0,
                pop: act ? 1 + 0.07 * Math.sin(tt * Math.PI) : 1,
                fill: isAccent(w.text || "") && style.accentColor ? style.accentColor : style.color,
            };
        });

        // word-WRAP: jab line 90% width bhar jaye, agla word nayi line par
        const gapW = 16 * scale;
        const linesArr = [];
        let curIdxs = [], curW = 0;
        for (let i = 0; i < cue.words.length; i++) {
            const ww = widths[i];
            if (curIdxs.length && curW + gapW + ww > rectW * 0.9) {
                linesArr.push(curIdxs); curIdxs = []; curW = 0;
            }
            curIdxs.push(i); curW += ww + (curIdxs.length > 1 ? gapW : 0);
        }
        if (curIdxs.length) linesArr.push(curIdxs);

        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        const lh2 = finalFontSize * 1.12;
        let ly = yC - (linesArr.length * lh2) / 2 + lh2 / 2;
        linesArr.forEach((idxs) => {
            const lw = idxs.reduce((a, i) => a + widths[i], 0) + gapW * Math.max(0, idxs.length - 1);
            let lx = cxBaseL - lw / 2;
            idxs.forEach((i) => {
                const st = wState[i];
                ctx.save();
                ctx.globalAlpha = Math.max(0, Math.min(1, st.alpha));
                ctx.translate(lx + widths[i] / 2, ly + st.dy);
                ctx.scale(st.pop, st.pop);
                ctx.font = `${style.fontWeight} ${finalFontSize}px Arial, sans-serif`;
                ctx.fillStyle = st.fill;
                ctx.fillText(words[i], 0, 0);
                ctx.restore();
                lx += widths[i] + gapW;
            });
            ly += lh2;
        });
        ctx.restore();
        if (isPreview) {
            const pad = 12 * scale;
            window.__captionBBox = {
                x: cxBaseL - rectW * 0.45 - pad,
                y: yC - (linesArr.length * lh2) / 2 - pad,
                w: rectW * 0.9 + pad * 2,
                h: linesArr.length * lh2 + pad * 2,
            };
        }
        return;
    }

    // ===== "My Caption 3" — custom multi-line / per-word-size renderer =====
    // RULES (sample-video se): 2 words per line, centered block; KEY word =
    // len>=4 + not-stopword + not "-ing" → 1.55x size + yellow + glow;
    // filler words → normal size + white; ACTIVE word → extra 1.12 pop +
    // strong glow (deterministic, word-timings se).
    if (style.animation === "wrapBig") {
        const animW = "wrapBig";
        const yBase = rectY + rectH * captionPosition.y;
        const wProg = (w) => (srcT != null && w.end > w.start) ? Math.min(1, Math.max(0, (srcT - w.start) / (w.end - w.start))) : 0;
        const CAP_STOP = new Set(("a an the and or but for with is are was were be been am " +
            "it i you we they he she me my your our their as by from of to in on at if so do does did done " +
            "has have had not will can could should would just about out up down all any what when where who why how " +
            "than then too very also into over there here that this those these no nor yet both each other some such only own same s t don now").split(" "));
        const baseWord = (txt) => txt.toLowerCase().replace(/[^a-z0-9]/g, "");
        const isKeyWord = (txt) => { const b = baseWord(txt); return b.length >= 4 && !CAP_STOP.has(b) && !/ing$/.test(b); };

        const linesArr = [];
        for (let i = 0; i < cue.words.length; i += 2) linesArr.push(cue.words.slice(i, i + 2));
        const gapW = 14 * scale;
        let lineWs = [], lineHs = [];
        linesArr.forEach((ln) => {
            let wsum = 0, hmax = 0;
            ln.forEach((w) => {
                const act = srcT != null && srcT >= w.start && srcT < w.end;
                const key = isKeyWord(w.text || "");
                const fsz = finalFontSize * (key ? 1.55 : 1.0) * (act ? 1.12 : 1.0);
                ctx.font = `${style.fontWeight} ${fsz}px Arial, sans-serif`;
                const ww = ctx.measureText(w.text || "").width;
                w.__mw = ww; w.__fs = fsz; w.__act = act; w.__key = key;
                wsum += ww; hmax = Math.max(hmax, fsz);
            });
            wsum += gapW * Math.max(0, ln.length - 1);
            lineWs.push(wsum); lineHs.push(hmax);
        });
        const totH = lineHs.reduce((a, b) => a + b, 0) + 14 * scale * Math.max(0, linesArr.length - 1);
        let yy = yBase - totH / 2 + lineHs[0] / 2;
        linesArr.forEach((ln, li) => {
            let lx = cxBase - lineWs[li] / 2;
            const lineCy = yy;
            ln.forEach((w) => {
                const text = w.text || "";
                const fsz = w.__fs, ww = w.__mw, act = w.__act, key = w.__key;
                const prog = wProg(w);
                const pop = act ? (1 + 0.06 * (1 - Math.abs(2 * prog - 1))) : 1; // peek-pop
                ctx.save();
                ctx.translate(lx + ww / 2, lineCy);
                ctx.scale(pop, pop);
                ctx.textAlign = "center"; ctx.textBaseline = "middle";
                ctx.font = `${style.fontWeight} ${fsz}px Arial, sans-serif`;
                if ((key || act) && style.glow) { ctx.shadowColor = style.glow; ctx.shadowBlur = (act ? 34 : 20) * scale; }
                ctx.fillStyle = key ? style.activeColor : style.color;
                ctx.fillText(text, 0, 0);
                ctx.restore();
                lx += ww + gapW;
            });
            yy += lineHs[li] / 2 + lineHs[Math.min(li + 1, lineHs.length - 1)] / 2 + 14 * scale;
        });
        if (isPreview) {
            const maxW = Math.max(...lineWs);
            window.__captionBBox = { x: cxBase - maxW / 2 - 12 * scale, y: yBase - totH / 2 - 12 * scale, w: maxW + 24 * scale, h: totH + 24 * scale };
        }
        ctx.restore();
        return;
    }

    let x = rectX + rectW * captionPosition.x - finalTotalWidth / 2;
    const y = rectY + rectH * captionPosition.y;

    // ===== ANIMATION HELPERS (har style ka apna effect — deterministic,
    // frame-stable: word timings se drive hote hain, wall-clock se nahi) =====
    const wordProg = (w) => (srcT != null && w.end > w.start) ? Math.min(1, Math.max(0, (srcT - w.start) / (w.end - w.start))) : 0;
    const hs = (p) => Math.sin(p * Math.PI); // 0->1->0 smooth hump (deterministic)

    function drawBox(a, bx, by, bw2, bh2, fillStyle, opts) {
        ctx.save();
        if (opts && opts.tilt) {
            ctx.translate(bx + bw2 / 2, by + bh2 / 2);
            ctx.rotate(opts.tilt);
            ctx.translate(-(bx + bw2 / 2), -(by + bh2 / 2));
        }
        if (opts && opts.rounded) {
            const r2 = Math.min(bh2 / 2, 14 * scale * fitScale);
            ctx.beginPath();
            ctx.moveTo(bx + r2, by);
            ctx.arcTo(bx + bw2, by, bx + bw2, by + bh2, r2);
            ctx.arcTo(bx + bw2, by + bh2, bx, by + bh2, r2);
            ctx.arcTo(bx, by + bh2, bx, by, r2);
            ctx.arcTo(bx, by, bx + bw2, by, r2);
            ctx.closePath();
            if (fillStyle) { ctx.fillStyle = fillStyle; ctx.fill(); }
            if (opts.stroke) { ctx.strokeStyle = opts.stroke; ctx.lineWidth = opts.strokeW || 3; ctx.stroke(); }
        } else {
            if (fillStyle) { ctx.fillStyle = fillStyle; ctx.fillRect(bx, by, bw2, bh2); }
            if (opts && opts.stroke) { ctx.strokeStyle = opts.stroke; ctx.lineWidth = opts.strokeW || 3; ctx.strokeRect(bx, by, bw2, bh2); }
        }
        ctx.restore();
    }

    cue.words.forEach((w, i) => {
        const isActive = srcT >= w.start && srcT < w.end;
        const text = words[i];
        const wWidth = widths[i];
        const cx = x + wWidth / 2;
        const prog = wordProg(w);
        const anim = style.animation;
        const padX = 10 * scale * fitScale, padY = 6 * scale * fitScale;

        // ---------- HIGHLIGHT / BOX BACKDROPS (text se pehle) ----------
        if (isActive && style.highlightBg) {
            if (anim === "box") {
                drawBox(null, x - padX, y - finalFontSize / 2 - padY, wWidth + padX * 2, finalFontSize + padY * 2, style.highlightBg);
            } else if (anim === "doubleBox") {
                drawBox(null, x - padX - 4 * scale * fitScale, y - finalFontSize / 2 - padY - 4 * scale * fitScale,
                    wWidth + padX * 2 + 8 * scale * fitScale, finalFontSize + padY * 2 + 8 * scale * fitScale, "#ffffff");
                drawBox(null, x - padX, y - finalFontSize / 2 - padY, wWidth + padX * 2, finalFontSize + padY * 2, style.highlightBg);
            } else if (anim === "boxTilt") {
                drawBox(null, x - padX, y - finalFontSize / 2 - padY, wWidth + padX * 2, finalFontSize + padY * 2, style.highlightBg, { tilt: -0.06 });
            } else if (anim === "boxBounce") {
                const hop = -hs(prog) * 6 * scale * fitScale;
                drawBox(null, x - padX, y - finalFontSize / 2 - padY + hop, wWidth + padX * 2, finalFontSize + padY * 2, style.highlightBg);
            } else if (anim === "boxRounded") {
                drawBox(null, x - padX, y - finalFontSize / 2 - padY, wWidth + padX * 2, finalFontSize + padY * 2, style.highlightBg, { rounded: true });
            } else if (anim === "outlineBox") {
                drawBox(null, x - padX, y - finalFontSize / 2 - padY, wWidth + padX * 2, finalFontSize + padY * 2, null, { stroke: style.highlightBg, strokeW: Math.max(3, 6 * scale * fitScale), rounded: true });
            }
        }
        if (isActive && anim === "lineBox" && style.highlightBg) {
            // poori line ke peeche ek lagatar box
            drawBox(null, rectX + rectW * captionPosition.x - finalTotalWidth / 2 - padX, y - finalFontSize / 2 - padY,
                finalTotalWidth + padX * 2, finalFontSize + padY * 2, style.highlightBg);
        }
        if (isActive && anim === "tickerBar") {
            // full-height ticker bar (news style) active word ke peeche
            drawBox(null, x - padX, y - finalFontSize * 0.75, wWidth + padX * 2, finalFontSize * 1.5, style.highlightBg);
        }

        // ---------- TRANSFORM (scale/rotate/offset per-animation) ----------
        let drawScale = 1, dx = 0, dy = 0, rot = 0;
        if (isActive) {
            if (anim === "pop") drawScale = 1.15;
            else if (anim === "stamp") drawScale = 1.35;
            else if (anim === "rotPop") { drawScale = 1.12; rot = (i % 2 === 0 ? -1 : 1) * 0.09; }
            else if (anim === "popBounce") { drawScale = 1.12; dy = -hs(prog) * 10 * scale * fitScale; }
            else if (anim === "boxBounce") { dy = -hs(prog) * 6 * scale * fitScale; }
            else if (anim === "shake") { dx = Math.sin(prog * 24) * 3 * scale * fitScale; dy = Math.cos(prog * 19) * 2 * scale * fitScale; }
            else if (anim === "slide") { dx = -(1 - Math.min(1, prog * 2.2)) * 26 * scale * fitScale; }
            else if (anim === "squash") { drawScale = 1 + 0.08 * hs(prog); dy = 0.06 * hs(prog) * finalFontSize; }
            else if (anim === "underlineFloat") { dy = -hs(prog) * 4 * scale * fitScale; }
            else if (anim === "flash") drawScale = 1 + 0.1 * hs(prog);
            else if (anim === "glowPop") drawScale = 1.12;
            else if (anim === "popFill") drawScale = 1 + 0.15 * hs(prog);
        }

        ctx.save();
        ctx.translate(cx + dx, y + dy);
        if (rot) ctx.rotate(rot);
        if (drawScale !== 1) ctx.scale(drawScale, drawScale);

        // ---------- GLOW VARIANTS ----------
        // glowAll (My Caption styles): glow HARB word par — sample-video jaisa look
        if (style.glow && (isActive || style.glowAll)) {
            ctx.shadowColor = style.glow;
            if (anim === "glowPulse") ctx.shadowBlur = (10 + 22 * hs(prog)) * scale * fitScale;
            else if (anim === "glowPop") ctx.shadowBlur = 30 * scale * fitScale;
            else if (anim === "popFill") ctx.shadowBlur = 22 * scale * fitScale;
            else ctx.shadowBlur = 18 * scale * fitScale;
        }

        if (style.outline) {
            ctx.lineWidth = Math.max(1, (style.outlineWidth || 3.5) * scale * fitScale);
            ctx.strokeStyle = style.outline;
            ctx.strokeText(text, 0, 0);
        }

        // ---------- FILL COLOR (color-highlighting per style) ----------
        let fillColor = style.color;
        if (isActive) {
            fillColor = style.activeColor;
            if (anim === "rgbCycle" && style.activePalette) {
                fillColor = style.activePalette[i % style.activePalette.length];
            } else if (anim === "glowSwap" && style.glow2) {
                fillColor = (i % 2 === 0) ? style.activeColor : style.glow2;  // har word ka alag neon
            } else if (anim === "flash") {
                // base->active flash: word ke start mein BOHOT bright, phir settle
                fillColor = prog < 0.3 ? "#ffe08a" : style.activeColor;
            } else if (anim === "popFill") {
                fillColor = prog < 0.35 ? "#ffffff" : style.activeColor;
            } else if (anim === "fillSweep") {
                fillColor = style.color; // sweep neeche handle karta hai
            }
        }
        ctx.fillStyle = fillColor;
        ctx.fillText(text, 0, 0);

        // ---------- PROGRESSIVE / SWEEP FILLS (clip-based, fill ke baad) ----------
        if (isActive && anim === "fillSweep") {
            ctx.save();
            ctx.beginPath();
            ctx.rect(-wWidth / 2, -finalFontSize, wWidth * prog, finalFontSize * 2);
            ctx.clip();
            ctx.fillStyle = style.activeColor;
            ctx.fillText(text, 0, 0);
            ctx.restore();
        }
        if (isActive && anim === "fill") {
            // karaoke fill: poora word fill ho chuka (start se end tak solid)
            ctx.fillStyle = style.activeColor;
            ctx.fillText(text, 0, 0);
        }

        // ---------- OVERLAYS (underline/strike) ----------
        if (isActive && (anim === "underline" || anim === "underlineFloat")) {
            ctx.strokeStyle = style.activeColor;
            ctx.lineWidth = Math.max(1, 3 * scale * fitScale);
            ctx.beginPath();
            ctx.moveTo(-wWidth / 2, finalFontSize * 0.42);
            ctx.lineTo(wWidth / 2, finalFontSize * 0.42);
            ctx.stroke();
        }
        if (isActive && anim === "strike") {
            ctx.strokeStyle = style.activeColor;
            ctx.lineWidth = Math.max(1, 4 * scale * fitScale);
            ctx.beginPath();
            ctx.moveTo(-wWidth / 2 - 2, 0);
            ctx.lineTo(wWidth / 2 + 2, 0);
            ctx.stroke();
        }

        ctx.restore();
        x += wWidth + finalGap;
    });

    ctx.restore();

    if (isPreview) {
        const pad = 12 * scale;
        window.__captionBBox = {
            x: (rectX + rectW * captionPosition.x - finalTotalWidth / 2) - pad,
            y: y - finalFontSize / 2 - pad,
            w: finalTotalWidth + pad * 2,
            h: finalFontSize + pad * 2,
        };
    }
}

// ===== DRAG (move) + RESIZE — sirf 9:16 preview canvas par =====

function getPreviewPos(e) {
    const rect = previewCanvas.getBoundingClientRect();
    return { x: e.clientX - rect.left, y: e.clientY - rect.top };
}

function inCaptionBBox(pos) {
    const b = window.__captionBBox;
    if (!b) return false;
    return pos.x >= b.x && pos.x <= b.x + b.w && pos.y >= b.y && pos.y <= b.y + b.h;
}

function nearCaptionResizeHandle(pos) {
    const b = window.__captionBBox;
    if (!b) return false;
    const hx = b.x + b.w, hy = b.y + b.h;
    return Math.abs(pos.x - hx) < 14 && Math.abs(pos.y - hy) < 14;
}

previewCanvas.addEventListener("mousedown", (e) => {
    // SPOTLIGHT PRIORITY: bubble grab ho to caption-drag START hi mat karo
    // (dono ka drag-region overlap ho sakta hai — bubble jeetega)
    if (typeof spotlightHandleMouseDown === "function" && spotlightHandleMouseDown(e)) return;
    if (!window.__captionBBox) return;
    const pos = getPreviewPos(e);

    if (nearCaptionResizeHandle(pos)) {
        captionDragState = {
            type: "resize",
            anchorX: window.__captionBBox.x, anchorY: window.__captionBBox.y,
            startX: pos.x, startY: pos.y,
            origScale: captionFontScale,
        };
        e.stopPropagation();
        return;
    }
    if (inCaptionBBox(pos)) {
        captionDragState = {
            type: "move",
            startX: pos.x, startY: pos.y,
            origPos: { x: captionPosition.x, y: captionPosition.y },
        };
        e.stopPropagation();
    }
});

document.addEventListener("mousemove", (e) => {
    if (!captionDragState) return;
    const pos = getPreviewPos(e);

    if (captionDragState.type === "move") {
        const dx = (pos.x - captionDragState.startX) / previewCanvas.width;
        const dy = (pos.y - captionDragState.startY) / previewCanvas.height;
        captionPosition.x = Math.max(0.05, Math.min(0.95, captionDragState.origPos.x + dx));
        captionPosition.y = Math.max(0.08, Math.min(0.98, captionDragState.origPos.y + dy));
        // (FIX) DRAG KE DAURAN hi playhead-span live-update — warna layers.js ka
        // draw-wrapper har frame span ki PURANI position se draw karta hai aur
        // drag "invisible" ho jata tha (mouseup par hi copy hota tha).
        try {
            if (typeof capSpanAt === "function" && typeof virtualTime !== "undefined" && captionSpans.length) {
                const sp = capSpanAt(virtualTime);
                if (sp) sp.position = { x: captionPosition.x, y: captionPosition.y };
            }
        } catch (err) {}
    } else if (captionDragState.type === "resize") {
        const startDist = Math.hypot(
            captionDragState.startX - captionDragState.anchorX,
            captionDragState.startY - captionDragState.anchorY
        );
        const curDist = Math.hypot(
            pos.x - captionDragState.anchorX,
            pos.y - captionDragState.anchorY
        );
        const ratio = startDist > 5 ? curDist / startDist : 1;
        captionFontScale = Math.max(0.4, Math.min(3, captionDragState.origScale * ratio));
        // (FIX) resize bhi span live-update (move wale fix jaisa)
        try {
            if (typeof capSpanAt === "function" && typeof virtualTime !== "undefined" && captionSpans.length) {
                const sp2 = capSpanAt(virtualTime);
                if (sp2) sp2.fontScale = captionFontScale;
            }
        } catch (err) {}
    }
});

document.addEventListener("mouseup", () => {
    if (captionDragState) {
        // (FIX) span-copy HOOD pehle (persistCaptionsIfRemembered wrapper globals→span
        // copy karta hai) — remember-flag OFF ho to bhi TIMELINE-span to update ho.
        try {
            if (typeof capSpanAt === "function" && typeof virtualTime !== "undefined" && captionSpans.length) {
                const sp3 = capSpanAt(virtualTime);
                if (sp3) {
                    sp3.position = { x: captionPosition.x, y: captionPosition.y };
                    sp3.fontScale = captionFontScale;
                }
            }
        } catch (err) {}
        if (typeof persistCaptionsIfRemembered === "function") persistCaptionsIfRemembered();
        else if (typeof persistTimelineState === "function") persistTimelineState();
    }
    captionDragState = null;
});

// ===== CAPTIONS PANEL (media-bin ke neeche) =====

function persistCaptionsIfRemembered() {
    if (captionRemember && typeof persistTimelineState === "function") persistTimelineState();
}

function resetCaptionSettingsToDefault() {
    captionOverrides = {};  // DYNAMIC: sab color-overrides clear (style me jo bhi hain)
    captionFontScale = 1.0;
    captionPosition = { x: 0.5, y: 0.86 };
    currentCaptionStyle = "hormozi";
    buildCaptionsPanel();
    if (typeof persistTimelineState === "function") persistTimelineState();
}

function buildCaptionsPanel() {
    const wrap = document.getElementById("captionsPanel");
    if (!wrap) return;

    const eff = getEffectiveCaptionStyle();
    const baseStyle = CAPTION_STYLES[currentCaptionStyle] || CAPTION_STYLES.hormozi;
    // DYNAMIC COLOR OPTIONS: jitne color-fields is style me mojood hain, utne
    // pickers. Array-field (accentColors/neonPalette) = per-swatch pickers.
    const colorFields = getStyleColorFields(baseStyle);
    let colorOptionsHtml = "";
    colorFields.forEach((f) => {
        if (!f.list) {
            const ov = captionOverrides[f.prop];
            const preview = _getPreviewColor(eff, f, null);
            colorOptionsHtml += `
                <label class="cp-color-item"><input type="checkbox" id="cpUse_${f.prop}" ${ov ? "checked" : ""}/> ${f.label}</label>
                <input type="color" id="cpC_${f.prop}" value="${ov || preview}" ${ov ? "" : "disabled"}/>`;
        } else {
            const arr = eff[f.prop] || [];
            const ovArr = (captionOverrides[f.prop] && Array.isArray(captionOverrides[f.prop])) ? captionOverrides[f.prop] : null;
            arr.forEach((c, idx) => {
                const cur = (ovArr && ovArr[idx]) ? ovArr[idx] : c;
                const ovThis = !!(ovArr && ovArr[idx] && ovArr[idx] !== c);
                const label = f.shortLabel ? f.shortLabel(idx + 1) : (f.label + " " + (idx + 1));
                colorOptionsHtml += `
                <label class="cp-color-item"><input type="checkbox" id="cpUse_${f.prop}_${idx}" ${ovThis ? "checked" : ""}/> ${label}</label>
                <input type="color" id="cpC_${f.prop}_${idx}" value="${cur}" ${ovThis ? "" : "disabled"}/>`;
            });
        }
    });
    if (!colorOptionsHtml) colorOptionsHtml = "<span class=\"cp-hint\">(style me koi color option nahi)</span>";

    wrap.innerHTML = `
        <div class="cp-header">
            <span class="cp-title">💬 Captions</span>
            <label class="cp-enable"><input type="checkbox" id="cpEnableChk" ${captionsEnabled ? "checked" : ""}/> On</label>
            <span class="cp-toggle" id="cpCollapse">▾</span>
        </div>
        <div class="cp-body" id="cpBody">
            <label class="cp-label">Style</label>
            <select id="cpStyleSelect" class="cp-select"></select>

            <label class="cp-label">Colors <span class="cp-hint">(tick = custom, untick = style default)</span></label>
            <div class="cp-color-grid" id="cpColorGrid">
                ${colorOptionsHtml}
            </div>

            <label class="cp-label">Size <span class="cp-hint" id="cpSizeVal">${captionFontScale.toFixed(2)}x</span></label>
            <input type="range" id="cpSizeSlider" class="cp-slider" min="0.4" max="3" step="0.05" value="${captionFontScale}"/>

            <div class="cp-footer">
                <label class="cp-remember"><input type="checkbox" id="cpRememberChk" ${captionRemember ? "checked" : ""}/> Save settings</label>
                <button id="cpResetBtn" class="cp-reset-btn" title="Reset to default">↺ Reset</button>
            </div>
            <div class="cp-hint-line">9:16 preview par caption ko drag/resize kar ke position bhi set kar sakte hain</div>
        </div>
    `;

    // --- style dropdown ---
    const sel = document.getElementById("cpStyleSelect");
    Object.keys(CAPTION_STYLES).forEach((key) => {
        const opt = document.createElement("option");
        opt.value = key;
        opt.textContent = CAPTION_STYLES[key].label;
        sel.appendChild(opt);
    });
    sel.value = currentCaptionStyle;
    sel.addEventListener("change", () => {
        currentCaptionStyle = sel.value;
        // naya style = custom colors apne aap off (style ka apna look dikhe)
        captionOverrides = {};  // DYNAMIC: style ke apne marzi ke color-keys clear
        // FIX: pehle span me persist karo, PHIR panel rebuild — warna
        // buildCaptionsPanel override (layers.js) playhead-span ka PURANA style
        // wapas globals me load kar deta tha aur user ki selection swallow ho
        // jati thi (style kabhi change nahi hota tha)
        persistCaptionsIfRemembered();
        buildCaptionsPanel();
    });

    // --- enable checkbox ---
    document.getElementById("cpEnableChk").addEventListener("change", (e) => {
        captionsEnabled = e.target.checked;
        persistCaptionsIfRemembered();
    });

    // --- collapse toggle ---
    document.getElementById("cpCollapse").addEventListener("click", () => {
        const body = document.getElementById("cpBody");
        body.style.display = body.style.display === "none" ? "" : "none";
        document.getElementById("cpCollapse").textContent = body.style.display === "none" ? "▸" : "▾";
    });

    // --- color overrides (DYNAMIC: jitne colors current style me hain) ---
    // single: chk={prop}; list: per-swatch chk={prop:idx} — sirf ticked swatch poore array ko replace karta hai.
    colorFields.forEach((f) => {
        if (!f.list) {
            const chk = document.getElementById("cpUse_" + f.prop);
            const color = document.getElementById("cpC_" + f.prop);
            if (!chk || !color) return;
            const apply = () => {
                captionOverrides[f.prop] = chk.checked ? color.value : null;
                color.disabled = !chk.checked;
                persistCaptionsIfRemembered();
            };
            chk.addEventListener("change", apply);
            color.addEventListener("input", () => { if (chk.checked) apply(); });
        } else {
            const arr = (captionOverrides[f.prop] && Array.isArray(captionOverrides[f.prop])) ? captionOverrides[f.prop] : null;
            eff[f.prop].forEach((_, idx) => {
                const chk = document.getElementById("cpUse_" + f.prop + "_" + idx);
                const color = document.getElementById("cpC_" + f.prop + "_" + idx);
                if (!chk || !color) return;
                const apply = () => {
                    if (!chk.checked) {
                        // untick: agar override array hai to is index ka custom hatao
                        if (Array.isArray(captionOverrides[f.prop])) {
                            const base = CAPTION_STYLES[currentCaptionStyle] || CAPTION_STYLES.hormozi;
                            const def = base[f.prop] || [];
                            const ov = captionOverrides[f.prop].slice();
                            if (idx < ov.length && ov[idx] !== def[idx]) {
                                ov[idx] = def[idx];
                                captionOverrides[f.prop] = ov;
                            }
                            if (ov.every((c, i) => c === (def[i] || c))) captionOverrides[f.prop] = null;
                        }
                        color.disabled = true;
                        persistCaptionsIfRemembered();
                        return;
                    }
                    const cur = (captionOverrides[f.prop] && Array.isArray(captionOverrides[f.prop]))
                        ? captionOverrides[f.prop].slice()
                        : eff[f.prop].slice();
                    cur[idx] = color.value;
                    captionOverrides[f.prop] = cur;
                    color.disabled = false;
                    persistCaptionsIfRemembered();
                };
                chk.addEventListener("change", apply);
                color.addEventListener("input", () => { if (chk.checked) apply(); });
            });
        }
    });

    // --- size slider ---
    const slider = document.getElementById("cpSizeSlider");
    slider.addEventListener("input", () => {
        captionFontScale = parseFloat(slider.value);
        document.getElementById("cpSizeVal").textContent = captionFontScale.toFixed(2) + "x";
    });
    slider.addEventListener("change", () => persistCaptionsIfRemembered());

    // --- remember checkbox ---
    document.getElementById("cpRememberChk").addEventListener("change", (e) => {
        captionRemember = e.target.checked;
        persistCaptionsIfRemembered();
    });

    // --- reset button ---
    document.getElementById("cpResetBtn").addEventListener("click", resetCaptionSettingsToDefault);
}

function resetCaptionPosition() {
    captionPosition = { x: 0.5, y: 0.86 };
    captionFontScale = 1.0;
    buildCaptionsPanel();
    if (typeof persistTimelineState === "function") persistTimelineState();
}

// backward-compat (timeline.js initTimeline se call hota hai)
function refreshCaptionsUI() {
    buildCaptionsPanel();
}

// ===== CAPTION GENERATION =====

async function generateCaptions() {
    if (!currentVideoRef) return;
    const btn = document.getElementById("generateCaptionsBtn");
    const label = btn.querySelector(".tool-label");
    const original = label ? label.textContent : null;
    btn.disabled = true;
    if (label) label.textContent = "Transcribing…";

    try {
        const res = await fetch(`/video/${currentVideoRef.saved_name}/generate_captions`, { method: "POST" });
        const data = await res.json();
        if (data.error) { alert("Auto Captions failed: " + data.error); return; }

        captionCues = data.cues || [];
        captionsEnabled = true;

        // NAYA: generate hote hi panel khul kar saamne aa jata hai
        buildCaptionsPanel();
        const body = document.getElementById("cpBody");
        if (body) body.style.display = "";
        const collapse = document.getElementById("cpCollapse");
        if (collapse) collapse.textContent = "▾";

        persistTimelineState();
        alert(`${captionCues.length} caption line(s) generate ho gayi hain. Neeche Captions panel se style/colors/size badal sakte hain.`);
    } catch (err) {
        alert("Auto Captions error: " + err);
    } finally {
        btn.disabled = false;
        if (label && original) label.textContent = original;
    }
}

document.addEventListener("DOMContentLoaded", () => {
    buildCaptionsPanel();

    const genBtn = document.getElementById("generateCaptionsBtn");
    if (genBtn) genBtn.addEventListener("click", generateCaptions);
});
