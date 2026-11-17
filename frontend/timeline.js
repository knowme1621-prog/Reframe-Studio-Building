const timelineScroll = document.getElementById("timelineScroll");
const timelineTrack = document.getElementById("timelineTrack");
const timelineLabels = document.getElementById("timelineLabels");
const scrubArea = document.getElementById("scrubArea");
const tracksArea = document.getElementById("tracksArea");
const playhead = document.getElementById("playhead");
const timeDisplay = document.getElementById("timeDisplay");
const zoomInBtn = document.getElementById("zoomIn");
const zoomOutBtn = document.getElementById("zoomOut");
const videoBlocksLayer = document.getElementById("videoBlocksLayer");
const segmentsLayer = document.getElementById("segmentsLayer");
const audioLayer = document.getElementById("audioLayer");
const rulerFramesEl = document.getElementById("rulerFrames");
const rulerSecondsEl = document.getElementById("rulerSeconds");
const playPauseBtnEl = document.getElementById("playPauseBtn");
const hScrollBarEl = document.getElementById("hScrollBar");
const hScrollThumbEl = document.getElementById("hScrollThumb");
// ===== NAYE LAYER ROWS (Captions / Transitions / CropZoom(PanZoom) / Grade) =====
const captionSpansLayer = document.getElementById("captionSpansLayer");
const transitionSpansLayer = document.getElementById("transitionSpansLayer");
const pzSpansLayer = document.getElementById("pzSpansLayer");
const gradeSpansLayer = document.getElementById("gradeSpansLayer");
const titlesSpansLayer = document.getElementById("titlesSpansLayer"); // TITLES layer row
// STACK-2 rows (Add-Stack ke baad dikhne lagti hain)
// STACK-2 REMOVED: Add-Stack UI hata di gayi — spotlight ab MULTI-SCREEN hai
// (spotlight.js, segment ke andar N screens). Ye legacy vars sirf purane saved
// data + undo/redo snapshots ka compatibility ke liye hain (UI rows nahi).
const stack2VideoBlocksLayer = null;
const stack2SegmentsLayer = null;
const stack2AudioLayer = null;

// ===== SOURCE vs TIMELINE (the core fix) =====
// sourceDuration : original uploaded file's real length (NEVER changes)
// timelineDuration: current editable timeline length (grows automatically, Filmora-style)
let sourceDuration = 0;
let timelineDuration = 0;
let timelineContentEnd = 0; // asal content ka end (playback yahin rukta hai — padding nahi)
let pixelsPerSecond = 100;
let isDraggingPlayhead = false;
let currentVideoRef = null;

let allThumbnails = [];   // filenames covering the whole sourceDuration
let waveformFile = null;  // waveform PNG covering the whole sourceDuration

// ===== 3 independent layers =====
// videoClips: {id, start, end, sourceStart, sourceEnd, muted, audioDetached, speed}
// audioLanes: {id, start, end, sourceStart, sourceEnd, muted, sourceClipId}
// segments  : {id, start, end, mode, modeBoxState, muted, audioDetached}  (crop layer, no source concept)
let videoClips = [];
let audioLanes = [];
let segments = [];

// ===== EFFECT-LAYERS (span-based, koi source concept nahi) =====
// captionSpans : {id, start, end, style, position:{x,y}, fontScale, overrides, remember}  — per-piece caption look
// transitions  : {id, start, end, type, duration, intensity}                              — no keyframing
// panZoomSpans : {id, start, end, mode:"static"|"in"|"out", zoom, box:{x,y,w,h}}           — 9:16 window ke andar box
// gradeSpans   : {id, start, end, grade:{...CG_DEFAULTS}}                                 — per-span color grade
let captionSpans = [];
let transitions = [];
let panZoomSpans = [];
let gradeSpans = [];
// TITLES LAYER (9:16 heading-spans — caption-cues text-source, manual text)
let titlesSpans = [];

// ===== MULTI-STACK (2-Stack Spotlight) =====
// Har timeline-item par OPTIONAL `stack` field hota hai (1 = base stack, 2 = doosri
// stack). Purani saves mein field nahi hoti — wahan stack=1 assume hota hai, isliye
// purana behavior 100% waise ka waisa rehta hai. Base stack (1) hamesha mainPlayer
// element use karta hai; stack-2 ka video ek SEPARATE hidden <video> element par
// chalta hai (same file ka doosra decoder, ek hi disk-copy). Stack-2 ki video
// stack-1 ki video ke NICHE layer hai: spotlight segment (mode=spotlight) neeche
// wali video ko circle ring ke andar ZOOM kar ke dikhata hai (zoom-bubble mode).
let stackCount = 1;
let baseVideoEl = null;      // mainPlayer — initTimeline par set hota hai
let stackAudioEls = {};      // stackN -> <audio> element (embedded-audio sync, playback hi ke liye)
let stackVideoEls = {};      // savedName -> <video> element (S2 MULTI-SOURCE: har file ka apna decoder)

let selectedItems = [];
let selectedSegmentId = null;
let selectedAudioId = null;
let dragState = null;
let marqueeState = null;

// ===== STACK-2 ARRAYS (2-Stack Spotlight) =====
// Base arrays (upar) stack-1 ke hain. Stack-2 ka apna poora 3-layer group hai —
// Video / Audio / Segment — bilkul same shape. Stack-1 ka spotlight segment
// stack-2 ki video ke upar zoom-ring dikhata hai (spotlight.js).
let stack2VideoClips = [];
let stack2AudioLanes = [];
let stack2Segments = [];

// ===== VIRTUAL PLAYBACK ENGINE =====
let isPlaying = false;
let virtualTime = 0;
let lastFrameTs = null;
let rafId = null;
let extraAudioEl = null; // plays detached audio lanes (separate from mainPlayer)

function formatTime(seconds) {
    const m = Math.floor(seconds / 60);
    const s = Math.floor(seconds % 60);
    return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

function formatTimeMs(seconds) {
    const m = Math.floor(seconds / 60);
    const s = Math.floor(seconds % 60);
    const ms = Math.round((seconds - Math.floor(seconds)) * 1000);
    return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}.${String(ms).padStart(3, "0")}`;
}

function currentFps() {
    return (currentVideoRef && currentVideoRef.fps) ? currentVideoRef.fps : 25;
}

function genId() {
    return "id_" + Math.random().toString(36).slice(2, 10);
}

// ===== STACK HELPERS (multi-stack engine) =====
// Sab jagah seedhe videoClips/audioLanes/segments use karne ki jagah ye getters
// use karo — har stack ka apna independent group banta hai. stack=1 (default,
// purani data) => base arrays; stack>=2 => `stack2*` arrays.
function stackArrays(n) {
    if (n === 2) return { video: stack2VideoClips, audio: stack2AudioLanes, segment: stack2Segments };
    return { video: videoClips, audio: audioLanes, segment: segments };
}
function totalStacks() {
    return stackCount;
}
function ensureStackCount(n) {
    stackCount = Math.max(1, Math.min(2, n)); // abhi 2 stacks tak
    const body = document.body;
    if (body) body.classList.toggle("stack2-active", stackCount >= 2);
}
function getDefaultStack(item) {
    if (!item) return 1;
    return item.stack === 2 ? 2 : 1;
}
function getStackOf(kind, id) {
    if (getStackOf._cache && getStackOf._cache.kind === kind && getStackOf._cache.id === id) return getStackOf._cache.stack;
    for (let s = 1; s <= stackCount; s++) {
        const arrs = stackArrays(s);
        const arr = kind === "segment" ? arrs.segment : kind === "audio" ? arrs.audio : arrs.video;
        if (arr.some((it) => it.id === id)) {
            getStackOf._cache = { kind, id, stack: s };
            return s;
        }
    }
    return 1;
}
function getItemInStack(kind, id) {
    // FIX (BUG 5/6): EFFECT-KINDS (captionSpan/transition/panZoom/gradeSpan)
    // stacks ke bahar hain — pehle ye video-fallback me chale jate the ->
    // undefined -> move/resize SILENTLY fail (transition/grade length change
    // nahi hoti thi). Ab apne arrays se lookup.
    if (typeof isEffectKind === "function" && isEffectKind(kind)) {
        const arr = arrayOfEffectKind(kind) || [];
        return arr.find((x) => x.id === id) || null;
    }
    for (let s = 1; s <= stackCount; s++) {
        const arrs = stackArrays(s);
        const arr = kind === "segment" ? arrs.segment : kind === "audio" ? arrs.audio : arrs.video;
        const it = arr.find((x) => x.id === id);
        if (it) return it;
    }
    return null;
}
// Base video element — stack-2 ho to uska apna hidden <video> (sirf 1x, stack-2
// clips par speed abhi burn-in-only hai, warna do playback rates sync karna
// thread-expensive hota).
function getBaseVideoElement() {
    if (baseVideoEl) return baseVideoEl;
    if (typeof mainPlayer !== "undefined" && mainPlayer) return mainPlayer;
    return null;
}
function ensureStackVideoElement(n, savedName) {
    if (n < 2) return null;
    const key = savedName || (currentVideoRef && currentVideoRef.saved_name) || "_main";
    if (!stackVideoEls[key]) {
        const el = document.createElement("video");
        el.style.display = "none";
        el.preload = "auto";
        el.muted = true;
        el.src = `/video/${key}`;
        document.body.appendChild(el);
        stackVideoEls[key] = el;
    }
    return stackVideoEls[key];
}
function pauseAllStackVideoEls(exceptEl) {
    Object.values(stackVideoEls).forEach((el) => {
        if (el !== exceptEl && !el.paused) el.pause();
    });
}

function ensureStackAudioElement(n) {
    if (n < 2) return null;
    if (!stackAudioEls[n]) {
        const el = document.createElement("audio");
        el.style.display = "none";
        el.muted = true; // preview mein sirf base-stack ki audio sunai deti hai
        document.body.appendChild(el);
        stackAudioEls[n] = el;
    }
    return stackAudioEls[n];
}

// ===== SELECTION HELPERS =====

function isSelected(kind, id) {
    return selectedItems.some((s) => s.kind === kind && s.id === id);
}

function selectOnly(kind, id) {
    selectedItems = [{ kind, id }];
    syncSelectionMirrors();
}

function toggleSelectItem(kind, id) {
    const idx = selectedItems.findIndex((s) => s.kind === kind && s.id === id);
    if (idx >= 0) selectedItems.splice(idx, 1);
    else selectedItems.push({ kind, id });
    syncSelectionMirrors();
}

function clearSelection() {
    selectedItems = [];
    syncSelectionMirrors();
}

function selectedIdsOf(kind) {
    return selectedItems.filter((s) => s.kind === kind).map((s) => s.id);
}

function syncSelectionMirrors() {
    const segIds = selectedIdsOf("segment");
    const audIds = selectedIdsOf("audio");
    selectedSegmentId = segIds.length ? segIds[segIds.length - 1] : null;
    selectedAudioId = audIds.length ? audIds[audIds.length - 1] : null;
}

// crop_editor.js is the only external consumer of this function — kept same contract.
// NOTE: uses virtualTime (timeline position), NOT mainPlayer.currentTime (source position) —
// these are now two different things.
function getActiveSegment() {
    if (selectedSegmentId) {
        const seg = getSegmentById(selectedSegmentId);
        if (seg) return seg;
    }
    const t = virtualTime;
    return segments.find((s) => t >= s.start && t < s.end) || null;
}

function getVideoClipById(id) { return getItemInStack("video", id); }
function getSegmentById(id) { return getItemInStack("segment", id); }
function getAudioById(id) { return getItemInStack("audio", id); }

// Stack-2 ke apna render function (spotlight.js use karta hai)
function renderStack2() {
    if (typeof window.__renderStack2UI === "function") window.__renderStack2UI();
}

function getItemByKindId(kind, id) {
    if (kind === "segment") return getSegmentById(id);
    if (kind === "audio") return getAudioById(id);
    if (kind === "captionSpan") return captionSpans.find((x) => x.id === id) || null;
    if (kind === "transition") return transitions.find((x) => x.id === id) || null;
    if (kind === "panZoom") return panZoomSpans.find((x) => x.id === id) || null;
    if (kind === "gradeSpan") return gradeSpans.find((x) => x.id === id) || null;
    if (kind === "titleSpan") return titlesSpans.find((x) => x.id === id) || null;
    return getVideoClipById(id);
}

// Naye layers ke arrays kind se — drag/copy/split generic engine isi use karega
function arrayOfEffectKind(kind) {
    if (kind === "captionSpan") return captionSpans;
    if (kind === "transition") return transitions;
    if (kind === "panZoom") return panZoomSpans;
    if (kind === "gradeSpan") return gradeSpans;
    if (kind === "titleSpan") return titlesSpans;
    return null;
}
function isEffectKind(kind) { return !!arrayOfEffectKind(kind); }
function arrayOfKindTL(kind) {
    // STACK-AWARE: drag/marquee engine isi se item dhoondta hai. Selection ek
    // time par ek hi stack se aati hai (Add-Stack button doosri stack ki video
    // uthata hai; clipboard cross-stack paste kar deta hai — items us stack ke
    // array mein jate hain jahan paste button/shortcut use hua... asal mein
    // clipboard items apna stack carry karte hain, pasteClipboard dekho).
    if (kind === "segment") return segments;
    if (kind === "audio") return audioLanes;
    return videoClips;
}
function arrayOfKindInStack(kind, stack) {
    const arrs = stackArrays(stack);
    if (kind === "segment") return arrs.segment;
    if (kind === "audio") return arrs.audio;
    return arrs.video;
}

// Jab multi-select ke kisi item ko drag kiya jaye (bina Ctrl), poori selection
// (chahe alag-alag layers se ho — video+audio+segment sab) ek rigid group ke
// tor par saath move hoti hai. "primary" wo item hai jo asal mein grab hua tha —
// sirf uske kinaron par snap check hoti hai, baaki sab same delta se shift hote hain.
function buildMoveDragState(clientX, primaryKind, primaryId) {
    return {
        type: "move",
        startClientX: clientX,
        primaryKind, primaryId,
        items: selectedItems
            .map(({ kind, id }) => {
                const it = getItemByKindId(kind, id);
                return it ? { kind, id, origStart: it.start, origEnd: it.end } : null;
            })
            .filter(Boolean),
    };
}

function findActiveVideoClip(t, stack) {
    // last match in array = "on top" for overlaps (matches DOM stacking order)
    const arr = (stack === 2) ? stack2VideoClips : videoClips;
    let found = null;
    for (const c of arr) if (t >= c.start && t < c.end) found = c;
    return found;
}
function findActiveAudioLane(t, stack) {
    const arr = (stack === 2) ? stack2AudioLanes : audioLanes;
    let found = null;
    for (const a of arr) if (t >= a.start && t < a.end) found = a;
    return found;
}

// ===== VIDEO OVERLAP GUARD =====
// Video-layer par do clips kabhi overlap nahi honi chahiye: playback engine
// overlap par sirf top-most clip dikhata hai, jo "same part bar bar play"
// jaisa glitch ban jata hai (manually drag kar ke join karte waqt ye aksar
// hota tha). Ye helper overlaps khud resolve kar deta hai — later clip ko
// pichli clip ke end par push kar ke. Saved/broken projects bhi load par
// theek ho jate hain.
function resolveVideoClipOverlaps() {
    resolveVideoClipOverlapsIn(videoClips);
    resolveVideoClipOverlapsIn(stack2VideoClips); // dono stacks independent
}

function resolveVideoClipOverlapsIn(clipArr) {
    if (clipArr.length < 2) return;

    // active drag ke dauran dragged items exclude — warna doosri clips drag
    // ke waqt hi idhar-udhar dhakelne lagti hain; final resolve mouseup par hota hai
    let excludeIds = null;
    if (dragState) {
        if (dragState.type === "move") {
            excludeIds = new Set(dragState.items.filter((x) => x.kind === "video").map((x) => x.id));
        } else if ((dragState.type === "resize-left" || dragState.type === "resize-right") && dragState.kind === "video") {
            excludeIds = new Set([dragState.id]);
        }
    }
    const fixed = excludeIds && excludeIds.size ? clipArr.filter((c) => !excludeIds.has(c.id)) : clipArr;
    if (fixed.length < 2) return;

    const sorted = [...fixed].sort((a, b) => a.start - b.start || a.end - b.end);
    let prevEnd = -Infinity;
    for (const c of sorted) {
        if (c.start < prevEnd - 1e-6) {
            const dur = c.end - c.start;
            c.start = prevEnd;
            c.end = c.start + dur;
        }
        prevEnd = c.end;
    }
}

// ===== TIMELINE LENGTH vs PLAYBACK LIMIT (2 alag cheezein) =====
// 1) PLAYBACK LIMIT (timelineContentEnd): sirf VIDEO + AUDIO content jitna.
//    Crop-segments playback limit nahi badhate — warna koi segment door right
//    par drag ho to playhead khali/black area mein chala jata tha. Video aur
//    audio jahan khatam, playback wahin khatam.
// 2) TIMELINE LENGTH (timelineDuration): SAB layers (segments included) + 15s
//    extra room — taake video/audio/crop-segment ko aage-peeche drag karne ke
//    liye timeline hamesha lambi bani rahe.
function recalcTimelineDuration() {
    resolveVideoClipOverlaps();
    // EFFECT-LAYERS: timeline lamba karte hain (playback limit NAHI badhate)

    let playEnd = 0;
    videoClips.forEach((c) => { playEnd = Math.max(playEnd, c.end); });
    audioLanes.forEach((a) => { playEnd = Math.max(playEnd, a.end); });
    // STACK-2: doosri stack ka content bhi timeline lamba karta hai aur playback
    // limit badhata hai (spotlight usi video par hota hai — content ke baghair
    // stack-2 khali hai hi)
    stack2VideoClips.forEach((c) => { playEnd = Math.max(playEnd, c.end); });
    stack2AudioLanes.forEach((a) => { playEnd = Math.max(playEnd, a.end); });
    timelineContentEnd = playEnd; // playback YAHIN rukega (video/audio end)

    let farthest = playEnd;
    segments.forEach((s) => { farthest = Math.max(farthest, s.end); });
    stack2Segments.forEach((s) => { farthest = Math.max(farthest, s.end); });
    // NAYE LAYERS: timeline-length mein count (playback-limit nahi)
    captionSpans.forEach((s) => { farthest = Math.max(farthest, s.end); });
    transitions.forEach((s) => { farthest = Math.max(farthest, s.end); });
    panZoomSpans.forEach((s) => { farthest = Math.max(farthest, s.end); });
    gradeSpans.forEach((s) => { farthest = Math.max(farthest, s.end); }); // FIX: ye line 01-Oct wale add me reh gayi thi
    gradeSpans.forEach((s) => { farthest = Math.max(farthest, s.end); });
    timelineDuration = farthest + 15; // extra room to drop/drag clips further right
    timelineTrack.style.width = `${timelineDuration * pixelsPerSecond}px`;
    updateCustomHScrollbar();
}

// ===== CUSTOM HORIZONTAL SCROLLBAR (native overlay-bars par bharosa nahi) =====
// WebView2 ki native scrollbar kabhi-kabhi render hi nahi hoti — isliye apna
// bar hai jo HAMESHA dikhta hai. Thumb ka size/position scroll-content ke
// mutabiq sync rehta hai; click + drag dono se scroll hota hai.
function updateCustomHScrollbar() {
    if (!hScrollBarEl || !hScrollThumbEl) return;
    const scrollW = timelineScroll.scrollWidth;
    const clientW = timelineScroll.clientWidth;
    const barW = hScrollBarEl.clientWidth;
    if (!scrollW || !clientW || !barW) return;

    const overflow = scrollW - clientW;
    if (overflow <= 2) {
        // koi overflow nahi — poori width ka thumb (bar phir bhi visible)
        hScrollThumbEl.style.width = `${barW - 4}px`;
        hScrollThumbEl.style.left = "2px";
        return;
    }

    const thumbW = Math.max(36, (clientW / scrollW) * barW);
    const maxScroll = overflow;
    const maxThumb = barW - thumbW - 4;
    const frac = Math.min(1, timelineScroll.scrollLeft / maxScroll);

    hScrollThumbEl.style.width = `${thumbW}px`;
    hScrollThumbEl.style.left = `${2 + frac * maxThumb}px`;
}

let hScrollDrag = null; // { startX, startScrollLeft }

if (hScrollBarEl && hScrollThumbEl) {
    hScrollThumbEl.addEventListener("mousedown", (e) => {
        e.preventDefault();
        e.stopPropagation();
        hScrollDrag = {
            startX: e.clientX,
            startScrollLeft: timelineScroll.scrollLeft,
        };
        hScrollThumbEl.classList.add("dragging");
    });

    hScrollBarEl.addEventListener("mousedown", (e) => {
        // track par click (thumb ke ilawa) -> us position par jump
        if (e.target === hScrollThumbEl) return;
        const rect = hScrollBarEl.getBoundingClientRect();
        const frac = (e.clientX - rect.left) / rect.width;
        timelineScroll.scrollLeft = frac * (timelineScroll.scrollWidth - timelineScroll.clientWidth);
        updateCustomHScrollbar();
    });

    document.addEventListener("mousemove", (e) => {
        if (!hScrollDrag) return;
        const dx = e.clientX - hScrollDrag.startX;
        const thumbW = hScrollThumbEl.offsetWidth;
        const barW = hScrollBarEl.clientWidth;
        const scrollable = timelineScroll.scrollWidth - timelineScroll.clientWidth;
        const thumbTrack = Math.max(1, barW - thumbW - 4);
        timelineScroll.scrollLeft = hScrollDrag.startScrollLeft + (dx / thumbTrack) * scrollable;
        updateCustomHScrollbar();
    });

    document.addEventListener("mouseup", () => {
        if (hScrollDrag) {
            hScrollDrag = null;
            hScrollThumbEl.classList.remove("dragging");
        }
    });

    window.addEventListener("resize", updateCustomHScrollbar);
}

// ===== RULERS (frame-numbers row + seconds row) =====

function niceSecondsStep(pxPerSec) {
    const steps = [0.1, 0.2, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 900];
    for (const s of steps) {
        if (s * pxPerSec >= 55) return s;
    }
    return steps[steps.length - 1];
}

function renderSecondsRuler() {
    rulerSecondsEl.innerHTML = "";
    const width = timelineDuration * pixelsPerSecond;
    rulerSecondsEl.style.width = `${width}px`;
    if (!timelineDuration) return;

    const step = niceSecondsStep(pixelsPerSecond);
    for (let t = 0; t <= timelineDuration + 0.0001; t += step) {
        const tick = document.createElement("div");
        tick.className = "ruler-tick";
        tick.style.left = `${t * pixelsPerSecond}px`;
        const label = step < 1 ? formatTimeMs(t) : formatTime(t);
        tick.innerHTML = `<span class="tick-label">${label}</span>`;
        rulerSecondsEl.appendChild(tick);
    }
}

function renderFramesRuler() {
    rulerFramesEl.innerHTML = "";
    const width = timelineDuration * pixelsPerSecond;
    rulerFramesEl.style.width = `${width}px`;

    const fps = currentFps();
    const framePx = pixelsPerSecond / fps;

    let step = null;
    if (framePx >= 18) step = 1;
    else if (framePx >= 9) step = 5;
    else if (framePx >= 4) step = 10;

    if (!step || !timelineDuration) {
        rulerFramesEl.classList.add("hidden-ruler");
        return;
    }
    rulerFramesEl.classList.remove("hidden-ruler");

    const totalFrames = Math.ceil(timelineDuration * fps);
    for (let f = 0; f <= totalFrames; f += step) {
        const t = f / fps;
        if (t > timelineDuration) break;
        const tick = document.createElement("div");
        tick.className = "frame-tick";
        tick.style.left = `${t * pixelsPerSecond}px`;
        tick.innerHTML = `<span class="frame-label">${f}</span>`;
        rulerFramesEl.appendChild(tick);
    }
}

function renderRulers() {
    renderSecondsRuler();
    renderFramesRuler();
}

// ===== RESIZABLE TRACK HEIGHTS =====

const trackHeights = {
    trackVideo: 62, trackAudioCombined: 72, segmentsLayer: 36,
    trackCaptionLayer: 36, trackTitlesLayer: 36,
    trackTransitionsLayer: 36, trackPzLayer: 36, trackGradeLayer: 36,
};

function applyTrackHeight(key) {
    const trackEl = document.getElementById(key);
    const labelEl = document.querySelector(`.label-row[data-for="${key}"]`);
    if (trackEl) trackEl.style.height = `${trackHeights[key]}px`;
    if (labelEl) labelEl.style.height = `${trackHeights[key]}px`;
}

Object.keys(trackHeights).forEach(applyTrackHeight);

// ===== ADD-STACK BUTTON (2-Stack Spotlight) =====
// Stack-2 rows enable/disable karta hai. Video stack-2 mein 3 tareeqon se aati
// hai: (1) media-bin item ko stack-2 video row par DRAG-DROP, (2) stack-1 clip
// select kar ke '⧉ Stack 2' button (duplicate), (3) clipboard paste.
// (Add-Stack feature REMOVED — spotlight ab multi-screen engine hai)

function updateStackLabels() {
    document.body.classList.toggle("stack2-active", stackCount >= 2);
    // Spotlight button sirf tab useful hai jab stack-2 ho
    const spotBtn = document.getElementById("stack2SpotBtn");
    if (spotBtn) spotBtn.style.display = stackCount >= 2 ? "" : "none";
}

// ===== S2 DRAG-DROP (media bin -> Video S2 row = ALAG file stack-2 mein) =====
// Media-bin item ka saved_name "application/x-reframe-video" format mein aata
// hai (app.js dragstart). Drop par S2 video-clip ban jata hai jo us FILE se
// chalta hai — MULTI-SOURCE: preview mein us file ka apna hidden <video>
// element (ensureStackVideoElement savedName-map), export mein us file ka apna
// decoder + audio-input. Bubble isi file ke frames se banta hai.
function setupS2DragDrop() {
    // S2 rows UI se hat gayi — drag-drop na hi kare to koi dikkat nahi
    if (!stack2VideoBlocksLayer) return;
    const row = stack2VideoBlocksLayer;
    row.addEventListener("dragover", (e) => {
        if (!e.dataTransfer.types.includes("application/x-reframe-video")) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = "copy";
        row.classList.add("drop-hover");
    });
    row.addEventListener("dragleave", () => row.classList.remove("drop-hover"));
    row.addEventListener("drop", (e) => {
        row.classList.remove("drop-hover");
        const savedName = e.dataTransfer.getData("application/x-reframe-video");
        if (!savedName) return;
        e.preventDefault();
        e.stopPropagation();
        const meta = (typeof uploadedVideos !== "undefined") ? uploadedVideos.find((v) => v.saved_name === savedName) : null;
        const dur = (meta && meta.duration) ? meta.duration : 10;
        if (typeof pushHistory === "function") pushHistory();
        const x = timeFromClientX(e.clientX);
        const start = Math.max(0, x - 2);
        stack2VideoClips.push({
            id: genId(), start, end: start + dur,
            sourceStart: 0, sourceEnd: dur,
            muted: true, stack: 2, savedName,
        });
        if (stackCount < 2) { ensureStackCount(2); updateStackLabels(); }
        recalcTimelineDuration();
        renderAll();
        persistTimelineState();
    });
}
setupS2DragDrop();

document.querySelectorAll(".track-resize-handle").forEach((handle) => {
    handle.addEventListener("mousedown", (e) => {
        e.preventDefault();
        e.stopPropagation();
        const key = handle.dataset.target;
        const startY = e.clientY;
        const startH = trackHeights[key];
        handle.classList.add("active");

        function onMove(ev) {
            const dy = ev.clientY - startY;
            const newH = Math.max(MIN_TRACK_H, Math.min(MAX_TRACK_H, startH + dy));
            trackHeights[key] = newH;
            applyTrackHeight(key);
        }
        function onUp() {
            handle.classList.remove("active");
            document.removeEventListener("mousemove", onMove);
            document.removeEventListener("mouseup", onUp);
        }
        document.addEventListener("mousemove", onMove);
        document.addEventListener("mouseup", onUp);
    });
});

timelineScroll.addEventListener("scroll", () => {
    timelineLabels.scrollTop = timelineScroll.scrollTop;
    updateCustomHScrollbar(); // thumb position live sync
});

// ===== MOUSE WHEEL over timeline =====
// FIX: wheel ab HORIZONTAL scroll karta hai (timeline lambi hoti hai, vertical
// scroll ka koi faida nahi jab tak layer heights badli na hon). Agar layers
// itni bari hain ke vertical overflow hai to wheel pehle jaisa vertical hi
// rahega. Ctrl+wheel = zoom in/out (Photo-shop/Filmora style).
timelineScroll.addEventListener("wheel", (e) => {
    if (e.ctrlKey) {
        e.preventDefault();
        pixelsPerSecond = Math.min(500, Math.max(20, pixelsPerSecond + (e.deltaY < 0 ? 40 : -40)));
        rezoomTimeline();
        return;
    }
    const canScrollVertically = timelineScroll.scrollHeight > timelineScroll.clientHeight + 2;
    if (canScrollVertically) return; // default (vertical) behavior rehne do
    if (e.deltaY !== 0) {
        e.preventDefault();
        timelineScroll.scrollLeft += e.deltaY;
    }
}, { passive: false });

// ===== VIRTUAL PLAYBACK ENGINE =====
// mainPlayer plays the raw uploaded file. The canvas (crop_editor.js) is what the
// user actually sees, so we control what's drawn based on which clip (if any) is
// "active" at the current virtual timeline position. This is what makes
// move/delete actually affect what plays — before, mainPlayer just played the raw
// file start-to-end regardless of the videoClips/audioLanes arrays.
//
// CLOCK RULE (core glitch fix): virtualTime hi MASTER clock hai (rAF se chalta
// hai). Video element sirf SLAVE hai — hum uski currentTime SET karte hain,
// uski apni clock se virtualTime KABHI nahi chalate. Pehle sirf 0.25s+ drift
// par re-sync hoti thi, isliye clip-boundary par seek-hiccup video ko purani
// source-position par chhodi rehta tha aur playhead aage badhte hue bhi WOHI
// PART bar bar play hota dikhta tha. Ab: (1) clip change par HAMESHA hard-seek,
// (2) same-clip drift 0.35s se bara ho to re-seek, (3) seek ke dauran canvas
// par purana frame nahi dikhta (black frame = clean cut).

const SEEK_RESYNC_THRESHOLD = 0.35; // sec
let videoSeekGuard = 0;        // >0 => seek in-progress, canvas blank frame dikhata hai
let lastAppliedClipKey = null; // kaunsi clip ki last frame apply hui thi
let lastAppliedLaneKey = null;

function ensurePlayerSeekGuard() {
    if (!mainPlayer || ensurePlayerSeekGuard.done) return;
    ensurePlayerSeekGuard.done = true;
    // CRITICAL: guard ab sirf 4 frames (~66ms) — stale-frame glitch sirf 1-2
    // frames hota hai, 30 frames (0.5s) ka blank har boundary par flicker ban
    // jata tha. Aur 'seeked' ke sath canplay/playing par bhi clear — WebView2
    // mein rapid seeks par 'seeked' kabhi kabhi MISS hota hai (yehi guard ko
    // hamesha ke liye phansa deta tha → dono canvas blank). Triple fail-safe.
    mainPlayer.addEventListener("seeking", () => {
        if (isPlaying) videoSeekGuard = 4;
    });
    mainPlayer.addEventListener("seeked", () => { videoSeekGuard = 0; });
    mainPlayer.addEventListener("canplay", () => { videoSeekGuard = 0; });
    mainPlayer.addEventListener("playing", () => { videoSeekGuard = 0; });
}

function applyVirtualTime(t, playing) {
    ensurePlayerSeekGuard();

    // ---- video ----
    const vc = findActiveVideoClip(t);
    window.__activeVideoClipForCanvas = vc || null;

    if (vc && mainPlayer) {
        const speed = vc.speed === undefined ? 1 : vc.speed;
        const srcT = vc.sourceStart + (t - vc.start) * speed;   // speed-aware mapping
        const clampedSrcT = Math.max(0, Math.min(srcT, sourceDuration));

        mainPlayer.muted = !!vc.muted || !!vc.audioDetached;
        if (mainPlayer.playbackRate !== speed) mainPlayer.playbackRate = speed; // native audio bhi sahi speed par

        if (vc.id !== lastAppliedClipKey) {
            // clip boundary (naya clip, ya gap ke baad wahi clip) — HAMESHA
            // hard-seek: warna video purani clip ki source-position par chalti
            // rehti hai aur boundary par glitch/repeat hota hai
            if (playing) videoSeekGuard = 4;
            mainPlayer.currentTime = clampedSrcT;
            lastAppliedClipKey = vc.id;
        } else if (!playing || Math.abs(mainPlayer.currentTime - clampedSrcT) > SEEK_RESYNC_THRESHOLD) {
            // paused/scrub, ya bara drift (decode hiccup) — real seek theek hai.
            // PLAYBACK ke dauran chhota drift (< 0.35s) intentionally RIDE karo:
            // WebView2 mein playback ke dauran repeated seeks 'seeking' state
            // mein phans jate hain (freeze/blank) — aur chhota drift har haal
            // invisible hai kyunki audio+video ek hi element mein hain (hamesha
            // synced). Boundary par waise bhi hard-seek ho jata hai.
            if (playing) videoSeekGuard = 4;
            mainPlayer.currentTime = clampedSrcT;
        }
        if (playing) {
            if (mainPlayer.paused) mainPlayer.play().catch(() => {});
        } else if (!mainPlayer.paused) {
            mainPlayer.pause();
        }
        window.__activeSourceTime = clampedSrcT; // captions.js isi source-time se sahi word/cue dhoondta hai
    } else if (mainPlayer) {
        lastAppliedClipKey = null;
        mainPlayer.muted = true;
        if (!mainPlayer.paused) mainPlayer.pause();
        window.__activeSourceTime = null; // gap/deleted region — koi caption bhi na dikhe
    }

    // ---- SPOTLIGHT SOURCE video (multi-screen) ----
    // Stack-2 rows UI se hata chuke hain — S2 video ab sirf SPOTLIGHT ki
    // source hai: jab koi segment ka spotlight mode on ho, S2 clip chalti hai
    // (auto full-length duplicate) aur spotlight.js uske frames se screens
    // banata hai. MULTI-SOURCE: har S2 clip apni file ka <video> element use
    // karti hai (clip.savedName; na ho to currentVideoRef ki file).
    const spotWantsS2 = (typeof spotlightNeedsSource === "function") ? spotlightNeedsSource() : (stackCount >= 2);
    const vc2 = spotWantsS2 ? findActiveVideoClip(t, 2) : null;
    if (spotWantsS2 && vc2) {
        const s2el = ensureStackVideoElement(2, vc2.savedName);
        if (s2el) {
            s2el.muted = true; // preview mein stack-2 audio nahi (S2 audio-lane mute by design)
            const srcT2 = Math.max(0, Math.min(vc2.sourceStart + (t - vc2.start) * (vc2.speed || 1), sourceDuration));
            if (s2el.__lastClipKey !== vc2.id || !playing) {
                // boundary change ya paused-scrub -> EXACT seek (paused seek sasta hai)
                s2el.currentTime = srcT2;
                s2el.__lastClipKey = vc2.id;
            } else if (Math.abs(s2el.currentTime - srcT2) > SEEK_RESYNC_THRESHOLD * 2) {
                s2el.currentTime = srcT2; // playback mein bara drift hi theek karo, chhota ride
            }
            if (playing) {
                if (s2el.paused) s2el.play().catch(() => {});
            } else if (!s2el.paused) {
                s2el.pause();
            }
            window.__stack2VideoEl = s2el;
            pauseAllStackVideoEls(s2el); // baaki files ke elements so jayen
        }
    } else {
        pauseAllStackVideoEls(null);
        if (!spotWantsS2) window.__stack2VideoEl = null;
    }

    // stack-2 detached audio lanes (preview mein muted — export mein mix hongi)
    if (stackCount >= 2) {
        const al2 = findActiveAudioLane(t, 2);
        if (al2) {
            const a2el = ensureStackAudioElement(2);
            if (a2el) {
                const srcT2 = Math.max(0, Math.min(al2.sourceStart + (t - al2.start), sourceDuration));
                if (a2el.__lastLaneKey !== al2.id || Math.abs(a2el.currentTime - srcT2) > SEEK_RESYNC_THRESHOLD) {
                    a2el.currentTime = srcT2;
                    a2el.__lastLaneKey = al2.id;
                }
                a2el.muted = true;
                if (playing) {
                    if (a2el.paused) a2el.play().catch(() => {});
                } else if (!a2el.paused) a2el.pause();
            }
        } else {
            const a2el = stackAudioEls[2];
            if (a2el && !a2el.paused) a2el.pause();
        }
    }

    // ---- detached audio lanes ----
    const al = findActiveAudioLane(t, 1);
    if (al && extraAudioEl) {
        const srcT = Math.max(0, Math.min(al.sourceStart + (t - al.start), sourceDuration));
        extraAudioEl.muted = !!al.muted;
        if (al.id !== lastAppliedLaneKey) {
            extraAudioEl.currentTime = srcT; // lane boundary — hard seek
            lastAppliedLaneKey = al.id;
        } else if (!playing || Math.abs(extraAudioEl.currentTime - srcT) > SEEK_RESYNC_THRESHOLD) {
            extraAudioEl.currentTime = srcT;
        }
        if (playing) {
            if (extraAudioEl.paused) extraAudioEl.play().catch(() => {});
        } else if (!extraAudioEl.paused) {
            extraAudioEl.pause();
        }
    } else {
        lastAppliedLaneKey = null;
        if (extraAudioEl && !extraAudioEl.paused) extraAudioEl.pause();
    }
}

function playbackTick(ts) {
    if (!isPlaying) return;
    if (lastFrameTs == null) lastFrameTs = ts;
    const dt = (ts - lastFrameTs) / 1000;
    lastFrameTs = ts;

    virtualTime += dt;
    // CRITICAL FIX: seek-guard ka DECAY — pehle guard sirf 'seeked' event par
    // clear hota tha, lekin rapid boundary seeks (speed != 1x) par 'seeked'
    // kabhi-kabhi fire NAHI hota aur guard HAMESHA ke liye phans jata tha —
    // dono canvas blank ho kar reh jate the (playhead chalta rehta hai).
    // Ab har frame par decay: worst case ~0.5s blank, phir guaranteed clear.
    if (videoSeekGuard > 0) videoSeekGuard--;

    // FIX (BUG 7 family): timelineContentEnd kabhi NaN ho gaya (load edge-case)
    // to playback khud ko hi freeze kar leta tha — self-heal recompute.
    if (!(typeof timelineContentEnd === "number" && isFinite(timelineContentEnd))) {
        recalcTimelineDuration();
    }

    // FIX: playback sirf VIDEO+AUDIO content tak (segments/crop playhead ko aage
    // nahi kheenchte) — uske baad khali timeline hai, wahan sirf drag/drop hota hai
    if (virtualTime >= timelineContentEnd) {
        virtualTime = timelineContentEnd;
        pausePlayback();
        if (playPauseBtnEl) playPauseBtnEl.textContent = "▶";
        updatePlayheadPosition(virtualTime);
        return;
    }

    // FIX (BUG 7): playback-loop DEATH-PROOF — applyVirtualTime/updatePlayhead
    // me koi bhi throw ho to bhi loop chalta rahe (pehle ek throw = rAF kabhi
    // re-queue nahi hota tha = playhead + video HAMESHA ke liye freeze). Error
    // log hota hai, agla frame try karta hai.
    try {
        applyVirtualTime(virtualTime, true);
        updatePlayheadPosition(virtualTime);
    } catch (err) {
        console.warn("playbackTick step failed (loop continues):", err);
    }
    rafId = requestAnimationFrame(playbackTick);
}

function startPlayback() {
    if (isPlaying) return;
    isPlaying = true;
    lastFrameTs = null;
    // end par play dabaya to start se dobara chalao (Filmora-style)
    if (timelineContentEnd > 0 && virtualTime >= timelineContentEnd - 0.01) {
        virtualTime = 0;
        updatePlayheadPosition(virtualTime);
    }
    // fresh sync: pehle sahi source-position par seek karo, phir clock chalao
    lastAppliedClipKey = null;
    lastAppliedLaneKey = null;
    // stack-2 elements bhi fresh-sync (sab ke __lastClipKey reset)
    Object.values(stackVideoEls).forEach((el) => { el.__lastClipKey = null; });
    const s2a = stackAudioEls[2];
    if (s2a) s2a.__lastLaneKey = null;
    applyVirtualTime(virtualTime, false);
    rafId = requestAnimationFrame(playbackTick);
}

function pausePlayback() {
    isPlaying = false;
    if (rafId) cancelAnimationFrame(rafId);
    rafId = null;
    videoSeekGuard = 0; // playback ruka to blank-guard bhi foran clear (paused seek guard set hi nahi karta)
    if (mainPlayer && !mainPlayer.paused) mainPlayer.pause();
    if (extraAudioEl && !extraAudioEl.paused) extraAudioEl.pause();
    // stack-2 elements bhi rok do (sab files ke)
    pauseAllStackVideoEls(null);
    const s2a = stackAudioEls[2];
    if (s2a && !s2a.paused) s2a.pause();
}

function seekVirtual(t) {
    // FIX: playhead sirf video/audio content ke andar hi move hota hai —
    // content ke aage ki khali timeline (jo drag/drop ke liye hai) par
    // playhead nahi jata, wahan kuch play hone ko hai hi nahi
    // HARDENING (BUG 3): timelineContentEnd NaN/undefined ho to limit=0 ->
    // playhead HAMESHA 0 par clamp (frozen) — ab NaN-guard; aur t bhi NaN ho
    // to 0. capLoadPlayheadSpanToGlobals throw kare to seek mar na jaye
    // (try/catch) — warna shortkey-handler/tick break ho jata tha.
    const limit = (typeof timelineContentEnd === "number" && isFinite(timelineContentEnd) && timelineContentEnd > 0) ? timelineContentEnd : 0;
    const tt = (typeof t === "number" && isFinite(t)) ? t : 0;
    virtualTime = Math.max(0, Math.min(tt, limit));
    // BUG 3/7 guard: applyVirtualTime throw kare to playhead-position update
    // phir bhi ho (warna playhead frozen dikhta tha)
    try { applyVirtualTime(virtualTime, false); } catch (err) { console.warn("applyVirtualTime (seek) failed:", err); }
    updatePlayheadPosition(virtualTime);
    // CAPTIONS LAYER: playhead naye span mein enter hua to panel us span ki
    // values dikhaye (playhead-piece editing — user choice)
    try { if (typeof capLoadPlayheadSpanToGlobals === "function") capLoadPlayheadSpanToGlobals(); } catch (err) { console.warn("capLoadPlayheadSpanToGlobals failed:", err); }
}

// kept for backward compatibility (app.js jump-to-time calls this)
function seekToTime(t) {
    seekVirtual(t);
}

// ===== TIMELINE INIT =====

function migrateClip(c) {
    if (c.sourceStart === undefined) c.sourceStart = c.start;
    if (c.sourceEnd === undefined) c.sourceEnd = c.end;
    if (c.speed === undefined) c.speed = 1;   // NAYA: purani saved clips ke liye default 1x
    return c;
}
function migrateAudio(a) {
    if (a.sourceStart === undefined) a.sourceStart = a.start;
    if (a.sourceEnd === undefined) a.sourceEnd = a.end;
    return a;
}

async function initTimeline(video) {
    pausePlayback();
    ensurePlayerSeekGuard();
    currentVideoRef = video;
    baseVideoEl = mainPlayer || null;
    const res = await fetch(`/video/${video.saved_name}/timeline_assets`);
    const data = await res.json();

    sourceDuration = data.duration;
    allThumbnails = data.thumbnails || [];
    waveformFile = data.waveform || null;

    const stateRes = await fetch(`/video/${video.saved_name}/segments`);
    const stateData = await stateRes.json();
    segments = stateData.segments || [];
    audioLanes = (stateData.audioLanes || []).map(migrateAudio);
    // NAYE LAYERS restore (purane saves mein nahi hongi — khali arrays)
    captionSpans = stateData.captionSpans || [];
    transitions = stateData.transitions || [];
    panZoomSpans = stateData.panZoomSpans || [];
    gradeSpans = stateData.gradeSpans || [];
    titlesSpans = stateData.titlesSpans || [];
    if (typeof migrateEffectLayers === "function") migrateEffectLayers(stateData);
    videoClips = (stateData.videoClips && stateData.videoClips.length)
        ? stateData.videoClips.map(migrateClip)
        : [{ id: genId(), start: 0, end: sourceDuration, sourceStart: 0, sourceEnd: sourceDuration, muted: false, audioDetached: false, speed: 1 }];

    // STACK-2 restore — purane saves mein S2 data ho sakta hai (legacy).
    // Multi-screen redesign ke baad S2 sirf SPOTLIGHT ka source hai; rows UI
    // mein nahi hain, magar data-compatible rehna zaroori hai (undo/redo + save).
    stack2VideoClips = ((stateData.stack2VideoClips || []).map(migrateClip));
    stack2AudioLanes = ((stateData.stack2AudioLanes || []).map(migrateAudio));
    stack2Segments = stateData.stack2Segments || [];
    ensureStackCount(stateData.stackCount === 2 || stack2VideoClips.length || stack2Segments.length || stack2AudioLanes.length ? 2 : 1);
    if (stackCount >= 2) ensureStackVideoElement(2);
    updateStackLabels();

    // COLOR GRADE restore
    if (typeof colorGrade !== "undefined" && stateData.colorGrade) {
        Object.keys(colorGrade).forEach((k) => {
            if (stateData.colorGrade[k] !== undefined && stateData.colorGrade[k] !== null) {
                colorGrade[k] = stateData.colorGrade[k];
            }
        });
        if (typeof cgSyncUI === "function") cgSyncUI();
    }

    if (!extraAudioEl) {
        extraAudioEl = document.createElement("audio");
        extraAudioEl.style.display = "none";
        document.body.appendChild(extraAudioEl);
    }
    extraAudioEl.src = `/video/${video.saved_name}`;

    // captions.js ke globals (agar file loaded hai) — per-video state restore
    if (typeof captionCues !== "undefined") {
        captionCues = stateData.captionCues || [];
        currentCaptionStyle = stateData.captionStyle || currentCaptionStyle || "hormozi";
        captionsEnabled = stateData.captionsEnabled !== false;
        captionPosition = stateData.captionPosition || { x: 0.5, y: 0.86 };
        captionFontScale = stateData.captionFontScale || 1.0;
        // NAYA: color-overrides + remember-checkbox restore
        if (stateData.captionOverrides) captionOverrides = stateData.captionOverrides;
        if (stateData.captionRemember !== undefined) captionRemember = stateData.captionRemember;
        if (typeof refreshCaptionsUI === "function") refreshCaptionsUI();
    }

        // SHORTS CANVAS settings restore
        if (stateData.shortsCanvas) { try { if (typeof scLoadFromState === "function") scLoadFromState(stateData.shortsCanvas); } catch (e) {} }
        else { try { if (typeof scLoadFromState === "function") scLoadFromState({ enabled: false }); } catch (e) {} }
        clearSelection();
    if (typeof clearHistory === "function") clearHistory();

    recalcTimelineDuration();
    renderAll();
    virtualTime = 0;
    seekVirtual(0);
}

let __persistTimer = null;
async function persistTimelineState() {
    if (!currentVideoRef) return;
    const payload = {
        segments, audioLanes, videoClips,
        // STACK-2 state bhi save
        stack2VideoClips, stack2AudioLanes, stack2Segments, stackCount,
        // COLOR GRADE (global) — color_grade.js module se
        colorGrade: (typeof colorGrade !== "undefined") ? JSON.parse(JSON.stringify(colorGrade)) : null,
        // NAYE EFFECT-LAYERS
        captionSpans, transitions, panZoomSpans, gradeSpans,
        // TITLES LAYER (9:16 heading-spans)
        titlesSpans,
        // SHORTS CANVAS settings (null = OFF)
        shortsCanvas: (typeof scPersistPayload === "function") ? scPersistPayload() : null,
    };
    if (typeof captionCues !== "undefined") {
        payload.captionCues = captionCues;
        payload.captionStyle = currentCaptionStyle;
        payload.captionsEnabled = captionsEnabled;
        payload.captionPosition = captionPosition;
        payload.captionFontScale = captionFontScale;
        // NAYA: color-overrides + remember-checkbox bhi save
        payload.captionOverrides = (typeof captionOverrides !== "undefined") ? captionOverrides : null;
        payload.captionRemember = (typeof captionRemember !== "undefined") ? captionRemember : true;
    }
    // (HANG FIX) DEBOUNCE: pehle HAR input-event par ek full-timeline POST ja
    // raha tha (grade/trans sliders ~30-60 events/sec, captionCues ke sath poora
    // JSON) — backend flood ho kar UI freeze/lamba run crash karta tha. Ab 350ms
    // ke andar ke sab events EK hi POST mein coalesce hote hain (trailing).
    if (__persistTimer) clearTimeout(__persistTimer);
    __persistTimer = setTimeout(() => {
        __persistTimer = null;
        try {
            fetch(`/video/${currentVideoRef.saved_name}/segments`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify(payload),
            }).catch(() => {});
        } catch (err) { /* network fail — silent */ }
    }, 350);
}

function updatePlayheadPosition(t) {
    const x = t * pixelsPerSecond;
    playhead.style.left = `${x}px`;

    const fps = currentFps();
    const curF = Math.floor(t * fps);
    // FIX: total duration ab content-end hai (pehle +15s padding count hoti thi)
    const totF = Math.floor(timelineContentEnd * fps);
    timeDisplay.textContent = `${formatTime(t)} (f${curF}) / ${formatTime(timelineContentEnd)} (f${totF})`;
}

function timeFromClientX(clientX) {
    const rect = timelineTrack.getBoundingClientRect();
    const x = clientX - rect.left;
    const t = x / pixelsPerSecond;
    return Math.max(0, Math.min(t, timelineDuration));
}

// ===== FILMSTRIP / WAVEFORM (now per-clip, driven by the arrays) =====

function buildClipFilmstrip(c) {
    const wrap = document.createElement("div");
    wrap.className = "clip-filmstrip";
    if (!allThumbnails.length || !sourceDuration) return wrap;

    const n = allThumbnails.length;
    let firstIdx = Math.floor((c.sourceStart / sourceDuration) * n);
    let lastIdx = Math.ceil((c.sourceEnd / sourceDuration) * n) - 1;
    firstIdx = Math.max(0, Math.min(firstIdx, n - 1));
    lastIdx = Math.max(firstIdx, Math.min(lastIdx, n - 1));

    const count = lastIdx - firstIdx + 1;
    const widthPx = (c.end - c.start) * pixelsPerSecond;
    const tileW = widthPx / count;

    for (let i = firstIdx; i <= lastIdx; i++) {
        const img = document.createElement("img");
        img.src = `/cache/${allThumbnails[i]}`;
        img.style.width = `${tileW}px`;
        wrap.appendChild(img);
    }
    return wrap;
}

function styleWaveformSlice(el, srcStart) {
    if (!waveformFile || !sourceDuration) return;
    const fullWidthPx = sourceDuration * pixelsPerSecond;
    el.style.backgroundImage = `url(/cache/${waveformFile})`;
    el.style.backgroundSize = `${fullWidthPx}px 100%`;
    el.style.backgroundRepeat = "no-repeat";
    el.style.backgroundPosition = `-${srcStart * pixelsPerSecond}px 0`;
}

// ===== RENDER: VIDEO / AUDIO / SEGMENT blocks =====

function renderVideoClips() {
    videoBlocksLayer.innerHTML = "";
    videoClips.forEach((c) => {
        const el = document.createElement("div");
        el.className = "video-block" + (isSelected("video", c.id) ? " selected" : "");
        el.style.left = `${c.start * pixelsPerSecond}px`;
        el.style.width = `${(c.end - c.start) * pixelsPerSecond}px`;
        el.dataset.id = c.id;

        let icons = "";
        if (c.muted) icons += " 🔇";
        if (c.audioDetached) icons += " 🎧";
        if (c.speed !== undefined && c.speed !== 1) icons += ` ${c.speed.toFixed(2)}x`;

        el.innerHTML = `<span class="seg-label">video${icons}</span>
                         <div class="video-handle video-handle-left" data-id="${c.id}"></div>
                         <div class="video-handle video-handle-right" data-id="${c.id}"></div>`;
        el.insertBefore(buildClipFilmstrip(c), el.firstChild);
        videoBlocksLayer.appendChild(el);
    });
}

// STACK-2 renders — bilkul same look, sirf block par .stack2 class (thori
// different tint) taake visually turant pata chale ke ye doosri stack hai.
function renderStack2VideoClips() {
    if (!stack2VideoBlocksLayer) return;
    stack2VideoBlocksLayer.innerHTML = "";
    stack2VideoClips.forEach((c) => {
        const el = document.createElement("div");
        el.className = "video-block stack2" + (isSelected("video", c.id) ? " selected" : "");
        el.style.left = `${c.start * pixelsPerSecond}px`;
        el.style.width = `${(c.end - c.start) * pixelsPerSecond}px`;
        el.dataset.id = c.id;

        let icons = "";
        if (c.muted) icons += " 🔇";
        if (c.speed !== undefined && c.speed !== 1) icons += ` ${c.speed.toFixed(2)}x`;
        if (c.savedName && currentVideoRef && c.savedName !== currentVideoRef.saved_name) icons += " 📎"; // alag file

        el.innerHTML = `<span class="seg-label">video S2${icons}</span>
                         <div class="video-handle video-handle-left" data-id="${c.id}"></div>
                         <div class="video-handle video-handle-right" data-id="${c.id}"></div>`;
        // filmstrip sirf current-video ke thumbnails se — alag file ka skip
        if (!c.savedName || !currentVideoRef || c.savedName === currentVideoRef.saved_name) {
            el.insertBefore(buildClipFilmstrip(c), el.firstChild);
        }
        stack2VideoBlocksLayer.appendChild(el);
    });
}

function renderStack2Segments() {
    if (!stack2SegmentsLayer) return;
    stack2SegmentsLayer.querySelectorAll(".segment-block").forEach((n) => n.remove());
    stack2Segments.forEach((seg) => {
        const el = document.createElement("div");
        el.className = "segment-block stack2" + (isSelected("segment", seg.id) ? " selected" : "");
        el.style.left = `${seg.start * pixelsPerSecond}px`;
        el.style.width = `${(seg.end - seg.start) * pixelsPerSecond}px`;
        el.dataset.id = seg.id;

        el.innerHTML = `<span class="seg-label">${seg.mode} S2</span>
                         <div class="seg-handle seg-handle-left" data-id="${seg.id}"></div>
                         <div class="seg-handle seg-handle-right" data-id="${seg.id}"></div>`;
        stack2SegmentsLayer.appendChild(el);
    });
}

function renderStack2AudioLane() {
    if (!stack2AudioLayer) return;
    stack2AudioLayer.innerHTML = "";
    stack2AudioLanes.forEach((a) => {
        const el = document.createElement("div");
        el.className = "audio-block stack2" + (isSelected("audio", a.id) ? " selected" : "");
        el.style.left = `${a.start * pixelsPerSecond}px`;
        el.style.width = `${(a.end - a.start) * pixelsPerSecond}px`;
        el.dataset.id = a.id;
        styleWaveformSlice(el, a.sourceStart);
        el.insertAdjacentHTML("beforeend", `<span class="seg-label">🎵 audio S2</span>
                         <div class="audio-handle audio-handle-left" data-id="${a.id}"></div>
                         <div class="audio-handle audio-handle-right" data-id="${a.id}"></div>`);
        stack2AudioLayer.appendChild(el);
    });
}

function renderStack2All() {
    renderStack2VideoClips();
    renderStack2Segments();
    renderStack2AudioLane();
    window.__renderStack2UI = renderStack2All; // timeline.js ke renderStack2() ke liye
}

function renderSegments() {
    segmentsLayer.querySelectorAll(".segment-block").forEach((n) => n.remove());
    segments.forEach((seg) => {
        const el = document.createElement("div");
        el.className = "segment-block" + (isSelected("segment", seg.id) ? " selected" : "");
        el.style.left = `${seg.start * pixelsPerSecond}px`;
        el.style.width = `${(seg.end - seg.start) * pixelsPerSecond}px`;
        el.dataset.id = seg.id;

        let icons = "";
        if (seg.muted) icons += " 🔇";
        if (seg.audioDetached) icons += " 🎧";

        el.innerHTML = `<span class="seg-label">${seg.mode}${icons}</span>
                         <div class="seg-handle seg-handle-left" data-id="${seg.id}"></div>
                         <div class="seg-handle seg-handle-right" data-id="${seg.id}"></div>`;
        segmentsLayer.appendChild(el);
    });
}

function renderAudioLane() {
    audioLayer.innerHTML = "";

    // shadow waveform for a video clip's own embedded audio (follows the video clip
    // automatically — only shown while NOT detached)
    videoClips.forEach((c) => {
        if (c.audioDetached) return;
        const el = document.createElement("div");
        el.className = "audio-shadow" + (c.muted ? " muted" : "");
        el.style.left = `${c.start * pixelsPerSecond}px`;
        el.style.width = `${(c.end - c.start) * pixelsPerSecond}px`;
        styleWaveformSlice(el, c.sourceStart);
        audioLayer.appendChild(el);
    });

    // real, independent, draggable audio lanes (detached / pasted / duplicated)
    audioLanes.forEach((a) => {
        const el = document.createElement("div");
        el.className = "audio-block" + (isSelected("audio", a.id) ? " selected" : "");
        el.style.left = `${a.start * pixelsPerSecond}px`;
        el.style.width = `${(a.end - a.start) * pixelsPerSecond}px`;
        el.dataset.id = a.id;
        styleWaveformSlice(el, a.sourceStart);

        const icon = a.muted ? "🔇" : "🎵";
        el.insertAdjacentHTML("beforeend", `<span class="seg-label">${icon} audio</span>
                         <div class="audio-handle audio-handle-left" data-id="${a.id}"></div>
                         <div class="audio-handle audio-handle-right" data-id="${a.id}"></div>`);
        audioLayer.appendChild(el);
    });
}

function renderAll() {
    recalcTimelineDuration();
    // BUG 7 perf-fix ka hissa: naya draw-cycle — snapshot cache invalidate
    if (typeof invalidateSnapshot === "function") invalidateSnapshot();
    renderVideoClips();
    renderSegments();
    renderAudioLane();
    renderRulers();
    renderStack2All();
    // NAYE LAYER ROWS (layers.js — agar load ho)
    if (typeof renderEffectLayers === "function") renderEffectLayers();
}

// ===== SCRUB AREA: click = seek, click+drag = marquee select (press-and-hold) =====

function handleScrubMouseDown(e) {
    pausePlayback();
    if (playPauseBtnEl) playPauseBtnEl.textContent = "▶";
    const rect = timelineTrack.getBoundingClientRect();
    marqueeState = {
        startClientX: e.clientX, startClientY: e.clientY,
        startXpx: e.clientX - rect.left, startYpx: e.clientY - rect.top,
        ctrlKey: e.ctrlKey, moved: false, el: null,
        curX1: 0, curX2: 0, curY1: 0, curY2: 0,
    };
}

scrubArea.addEventListener("mousedown", handleScrubMouseDown);

rulerFramesEl.addEventListener("mousedown", (e) => {
    pausePlayback();
    if (playPauseBtnEl) playPauseBtnEl.textContent = "▶";
    isDraggingPlayhead = true;
    seekVirtual(timeFromClientX(e.clientX));
});
rulerSecondsEl.addEventListener("mousedown", (e) => {
    pausePlayback();
    if (playPauseBtnEl) playPauseBtnEl.textContent = "▶";
    isDraggingPlayhead = true;
    seekVirtual(timeFromClientX(e.clientX));
});

document.addEventListener("mousemove", (e) => {
    if (isDraggingPlayhead) {
        seekVirtual(timeFromClientX(e.clientX));
        return;
    }

    if (marqueeState && !dragState) {
        const dist = Math.hypot(e.clientX - marqueeState.startClientX, e.clientY - marqueeState.startClientY);
        if (!marqueeState.moved && dist > 4) {
            marqueeState.moved = true;
            const el = document.createElement("div");
            el.className = "marquee-box";
            tracksArea.appendChild(el);
            marqueeState.el = el;
        }
        if (marqueeState.moved) {
            const rect = timelineTrack.getBoundingClientRect();
            const curX = e.clientX - rect.left, curY = e.clientY - rect.top;
            const x1 = Math.min(marqueeState.startXpx, curX), x2 = Math.max(marqueeState.startXpx, curX);
            const y1 = Math.min(marqueeState.startYpx, curY), y2 = Math.max(marqueeState.startYpx, curY);
            marqueeState.el.style.left = `${x1}px`;
            marqueeState.el.style.top = `${y1}px`;
            marqueeState.el.style.width = `${x2 - x1}px`;
            marqueeState.el.style.height = `${y2 - y1}px`;
            marqueeState.curX1 = x1; marqueeState.curX2 = x2;
            marqueeState.curY1 = y1; marqueeState.curY2 = y2;
        }
    }
});

function applyMarqueeSelection(m, additive) {
    if (!additive) clearSelection();
    const trackRect = timelineTrack.getBoundingClientRect();
    function rowRange(el) {
        if (!el) return { top: -1, bottom: -1 };
        const r = el.getBoundingClientRect();
        return { top: r.top - trackRect.top, bottom: r.bottom - trackRect.top };
    }
    const videoRow = rowRange(document.getElementById("trackVideo"));
    const audioRow = rowRange(document.getElementById("trackAudioCombined"));
    const segRow = rowRange(document.getElementById("segmentsLayer"));
    const s2VideoRow = rowRange(document.getElementById("stack2VideoBlocksLayer")) || { top: -1, bottom: -1 };
    const s2AudioRow = rowRange(document.getElementById("stack2AudioLayer")) || { top: -1, bottom: -1 };
    const s2SegRow = rowRange(document.getElementById("stack2SegmentsLayer")) || { top: -1, bottom: -1 };
    // NAYE LAYER ROWS (marquee selection)
    const capRow = rowRange(captionSpansLayer ? captionSpansLayer.parentElement : null);
    const transRow = rowRange(transitionSpansLayer ? transitionSpansLayer.parentElement : null);
    const pzRow = rowRange(pzSpansLayer ? pzSpansLayer.parentElement : null);
    const gradeRow = rowRange(gradeSpansLayer ? gradeSpansLayer.parentElement : null);

    function intersects(rowR, itemStartPx, itemEndPx) {
        const vOverlap = !(m.curY2 < rowR.top || m.curY1 > rowR.bottom);
        const hOverlap = !(itemEndPx < m.curX1 || itemStartPx > m.curX2);
        return vOverlap && hOverlap;
    }

    videoClips.forEach((c) => {
        if (intersects(videoRow, c.start * pixelsPerSecond, c.end * pixelsPerSecond)) toggleSelectItem("video", c.id);
    });
    audioLanes.forEach((a) => {
        if (intersects(audioRow, a.start * pixelsPerSecond, a.end * pixelsPerSecond)) toggleSelectItem("audio", a.id);
    });
    segments.forEach((s) => {
        if (intersects(segRow, s.start * pixelsPerSecond, s.end * pixelsPerSecond)) toggleSelectItem("segment", s.id);
    });
    // STACK-2 rows bhi marquee mein shamil
    stack2VideoClips.forEach((c) => {
        if (intersects(s2VideoRow, c.start * pixelsPerSecond, c.end * pixelsPerSecond)) toggleSelectItem("video", c.id);
    });
    stack2AudioLanes.forEach((a) => {
        if (intersects(s2AudioRow, a.start * pixelsPerSecond, a.end * pixelsPerSecond)) toggleSelectItem("audio", a.id);
    });
    stack2Segments.forEach((s) => {
        if (intersects(s2SegRow, s.start * pixelsPerSecond, s.end * pixelsPerSecond)) toggleSelectItem("segment", s.id);
    });
    // NAYE LAYERS bhi marquee se select
    captionSpans.forEach((s) => { if (intersects(capRow, s.start * pixelsPerSecond, s.end * pixelsPerSecond)) toggleSelectItem("captionSpan", s.id); });
    transitions.forEach((s) => { if (intersects(transRow, s.start * pixelsPerSecond, s.end * pixelsPerSecond)) toggleSelectItem("transition", s.id); });
    panZoomSpans.forEach((s) => { if (intersects(pzRow, s.start * pixelsPerSecond, s.end * pixelsPerSecond)) toggleSelectItem("panZoom", s.id); });
    gradeSpans.forEach((s) => { if (intersects(gradeRow, s.start * pixelsPerSecond, s.end * pixelsPerSecond)) toggleSelectItem("gradeSpan", s.id); });
    // TITLES row (marquee-select)
    const titleRow = rowRange(titlesSpansLayer ? titlesSpansLayer.parentElement : null);
    titlesSpans.forEach((s) => { if (intersects(titleRow, s.start * pixelsPerSecond, s.end * pixelsPerSecond)) toggleSelectItem("titleSpan", s.id); });

    renderAll();
}

document.addEventListener("mouseup", (e) => {
    if (marqueeState) {
        if (marqueeState.moved) {
            applyMarqueeSelection(marqueeState, marqueeState.ctrlKey);
            if (marqueeState.el) marqueeState.el.remove();
        } else {
            if (!marqueeState.ctrlKey) clearSelection();
            seekVirtual(timeFromClientX(marqueeState.startClientX));
            renderAll();
        }
        marqueeState = null;
    }
    isDraggingPlayhead = false;
});

// ===== VIDEO LAYER interactions =====

videoBlocksLayer.addEventListener("mousedown", (e) => {
    const target = e.target;
    e.stopPropagation();
    pausePlayback();
    if (playPauseBtnEl) playPauseBtnEl.textContent = "▶";

    if (target.classList.contains("video-handle-left") || target.classList.contains("video-handle-right")) {
        const id = target.dataset.id;
        const c = getVideoClipById(id);
        if (e.ctrlKey) toggleSelectItem("video", id); else selectOnly("video", id);
        dragState = {
            kind: "video",
            type: target.classList.contains("video-handle-left") ? "resize-left" : "resize-right",
            id, origStart: c.start, origEnd: c.end,
        };
        renderAll();
        return;
    }

    const blockEl = target.closest(".video-block");
    if (blockEl) {
        const id = blockEl.dataset.id;
        if (e.ctrlKey) {
            if (isSelected("video", id) && selectedItems.length > 1) {
                // ambiguous: plain ctrl-click (toggle off) ya ctrl-held-drag (group move)?
                // decide at mouseup based on whether the mouse actually moved
                dragState = buildMoveDragState(e.clientX, "video", id);
                dragState.pendingCtrlToggle = { kind: "video", id };
            } else {
                toggleSelectItem("video", id);
            }
        } else {
            // agar ye item already ek multi-selection ka hissa hai, to poori
            // selection ko group ke tor par move karo (collapse mat karo)
            if (!isSelected("video", id) || selectedItems.length <= 1) {
                selectOnly("video", id);
            }
            dragState = buildMoveDragState(e.clientX, "video", id);
        }
        renderAll();
    }
});

// ===== SEGMENT LAYER interactions (unchanged: click+drag empty area = create) =====

segmentsLayer.addEventListener("mousedown", (e) => {
    e.stopPropagation();
    pausePlayback();
    if (playPauseBtnEl) playPauseBtnEl.textContent = "▶";
    const target = e.target;

    if (target.classList.contains("seg-handle-left") || target.classList.contains("seg-handle-right")) {
        const id = target.dataset.id;
        const seg = getSegmentById(id);
        if (e.ctrlKey) toggleSelectItem("segment", id); else selectOnly("segment", id);
        dragState = {
            kind: "segment",
            type: target.classList.contains("seg-handle-left") ? "resize-left" : "resize-right",
            id, origStart: seg.start, origEnd: seg.end,
        };
        renderAll();
        return;
    }

    const blockEl = target.closest(".segment-block");
    if (blockEl) {
        const id = blockEl.dataset.id;
        if (e.ctrlKey) {
            if (isSelected("segment", id) && selectedItems.length > 1) {
                dragState = buildMoveDragState(e.clientX, "segment", id);
                dragState.pendingCtrlToggle = { kind: "segment", id };
            } else {
                toggleSelectItem("segment", id);
            }
        } else {
            if (!isSelected("segment", id) || selectedItems.length <= 1) {
                selectOnly("segment", id);
            }
            dragState = buildMoveDragState(e.clientX, "segment", id);
        }
        renderAll();
        return;
    }

    // empty area → draw new segment (Phase 4 behaviour, unchanged)
    if (!e.ctrlKey) clearSelection();
    renderAll();
    const startTime = timeFromClientX(e.clientX);
    dragState = { kind: "segment", type: "create", startTime, tempEl: null };
});

// ===== AUDIO LAYER interactions =====

audioLayer.addEventListener("mousedown", (e) => {
    const target = e.target;
    e.stopPropagation();
    pausePlayback();
    if (playPauseBtnEl) playPauseBtnEl.textContent = "▶";

    if (target.classList.contains("audio-handle-left") || target.classList.contains("audio-handle-right")) {
        const id = target.dataset.id;
        const a = getAudioById(id);
        if (e.ctrlKey) toggleSelectItem("audio", id); else selectOnly("audio", id);
        dragState = {
            kind: "audio",
            type: target.classList.contains("audio-handle-left") ? "resize-left" : "resize-right",
            id, origStart: a.start, origEnd: a.end,
        };
        renderAll();
        return;
    }

    const blockEl = target.closest(".audio-block");
    if (blockEl) {
        const id = blockEl.dataset.id;
        if (e.ctrlKey) {
            if (isSelected("audio", id) && selectedItems.length > 1) {
                dragState = buildMoveDragState(e.clientX, "audio", id);
                dragState.pendingCtrlToggle = { kind: "audio", id };
            } else {
                toggleSelectItem("audio", id);
            }
        } else {
            if (!isSelected("audio", id) || selectedItems.length <= 1) {
                selectOnly("audio", id);
            }
            dragState = buildMoveDragState(e.clientX, "audio", id);
        }
        renderAll();
    }
});

// ===== MAGNETIC SNAP (Filmora-style "join") =====
// FIX: ab CROSS-LAYER snap hai — pehle har layer sirf apni hi clips ke kinaron
// par snap karti thi (segment->segment only), isliye crop-segment video ke
// end par PERFECT stick nahi hota tha aur pata nahi chalta tha ke segment
// kahan tak apply hua. Ab: segment draw/move/resize par VIDEO clips ke start/end
// (aur playhead/0) bhi snap-points hain — aur ulta bhi (video clips segments ke
// kinaron par snap karti hain). Audio bhi dono se snap karta hai.
function getSnapCandidates(kind, excludeId) {
    const points = [0, virtualTime];
    // SAB layers (video + audio + segment, DONO stacks) ke kinaron par snap hota hai —
    // IDs globally unique hain (genId), isliye sirf id se exclude kaafi hai
    // NAYE LAYERS bhi snap-points hain (BUG 5/6 ki family — magnetic snap ab
    // transition/panzoom/grade/caption kinaron par bhi chipkega)
    [segments, audioLanes, videoClips, stack2Segments, stack2AudioLanes, stack2VideoClips,
     captionSpans, transitions, panZoomSpans, gradeSpans].forEach((arr) => {
        arr.forEach((it) => {
            if (excludeId && it.id === excludeId) return; // khud apne kinaron par snap na ho
            points.push(it.start, it.end);
        });
    });
    return points;
}

function closestSnap(value, candidates, thresholdSec) {
    let best = value, bestDist = thresholdSec;
    for (const c of candidates) {
        const d = Math.abs(value - c);
        if (d < bestDist) { bestDist = d; best = c; }
    }
    return best;
}

// ===== SHARED DRAG (move/resize/create) for all 3 layers =====
// move: only start/end change (position) — sourceStart/sourceEnd (content) untouched.
// resize: trims the SOURCE range too (like Filmora trim), 1:1 time mapping.

document.addEventListener("mousemove", (e) => {
    if (!dragState) return;

    if (dragState.type === "create") {
        const t = timeFromClientX(e.clientX);
        const start = Math.min(dragState.startTime, t);
        const end = Math.max(dragState.startTime, t);

        if (!dragState.tempEl) {
            const el = document.createElement("div");
            // EFFECT-LAYER create-drag: temp block usi layer-row mein dikhe
            if (dragState.effectKind) {
                el.className = "layer-span creating";
                const layerMap = { transition: transitionSpansLayer, panZoom: pzSpansLayer, gradeSpan: gradeSpansLayer };
                (layerMap[dragState.effectKind] || segmentsLayer).appendChild(el);
                // ROW-HEIGHT FIX: naye rows abs-inset hain — temp block poori row
                // cover kare (warna sirf 3px strip dikhta tha)
                el.style.top = "0";
                el.style.height = "100%";
            } else {
                el.className = "segment-block creating";
                segmentsLayer.appendChild(el);
            }
            dragState.tempEl = el;
        }
        dragState.tempEl.style.left = `${start * pixelsPerSecond}px`;
        dragState.tempEl.style.width = `${(end - start) * pixelsPerSecond}px`;
        dragState.liveStart = start;
        dragState.liveEnd = end;
        return;
    }

    if (dragState.type === "move") {
        const dt = (e.clientX - dragState.startClientX) / pixelsPerSecond;
        if (Math.abs(e.clientX - dragState.startClientX) > 3) dragState.hasMoved = true;
        let effectiveDt = dt;

        // sirf "primary" (jo item asal mein grab hua tha) ke kinaron par snap
        // check karo — baaki group same amount se shift hota hai (rigid group move)
        const primary = dragState.items.find(
            (x) => x.kind === dragState.primaryKind && x.id === dragState.primaryId
        );
        if (primary) {
            const dur = primary.origEnd - primary.origStart;
            let newStart = Math.max(0, primary.origStart + dt);
            const snapThresholdSec = 8 / pixelsPerSecond; // ~8px tolerance, Filmora-style magnetic snap
            const candidates = getSnapCandidates(primary.kind, primary.id);
            const snappedStart = closestSnap(newStart, candidates, snapThresholdSec);
            const snappedEnd = closestSnap(newStart + dur, candidates, snapThresholdSec);
            if (snappedStart !== newStart) {
                newStart = snappedStart;
            } else if (snappedEnd !== newStart + dur) {
                newStart = snappedEnd - dur;
            }
            newStart = Math.max(0, newStart);
            effectiveDt = newStart - primary.origStart;
        }

        // koi bhi item group mein 0 se neeche na jaye
        let minAllowedDt = -Infinity;
        dragState.items.forEach(({ origStart }) => {
            minAllowedDt = Math.max(minAllowedDt, -origStart);
        });
        effectiveDt = Math.max(effectiveDt, minAllowedDt);

        dragState.items.forEach(({ kind, id, origStart, origEnd }) => {
            const item = getItemInStack(kind, id); // STACK-AWARE: selection dono stacks se aa sakti hai
            if (!item) return;
            const dur = origEnd - origStart;
            const newStart = origStart + effectiveDt;
            item.start = newStart;
            item.end = newStart + dur;
            // sourceStart/sourceEnd intentionally untouched — moving changes position only
        });

        recalcTimelineDuration();
        renderAll();
        return;
    }

    // ---- resize-left / resize-right: single item only ----
    const item = getItemInStack(dragState.kind, dragState.id); // STACK-AWARE
    if (!item) return;

    const snapThresholdSec = 8 / pixelsPerSecond;
    const snapCandidates = getSnapCandidates(dragState.kind, item.id);

    if (dragState.type === "resize-left") {
        let newStart = timeFromClientX(e.clientX);
        newStart = closestSnap(newStart, snapCandidates, snapThresholdSec);
        newStart = Math.max(0, Math.min(newStart, item.end - 0.2));
        let deltaStart = newStart - item.start;
        if (item.sourceStart !== undefined) {
            if (item.sourceStart + deltaStart < 0) {
                deltaStart = -item.sourceStart;
                newStart = item.start + deltaStart;
            }
            item.sourceStart += deltaStart;
        }
        item.start = newStart;
    } else if (dragState.type === "resize-right") {
        let newEnd = timeFromClientX(e.clientX);
        newEnd = closestSnap(newEnd, snapCandidates, snapThresholdSec);
        newEnd = Math.max(newEnd, item.start + 0.2);
        let deltaEnd = newEnd - item.end;
        if (item.sourceEnd !== undefined) {
            let newSourceEnd = item.sourceEnd + deltaEnd;
            if (newSourceEnd > sourceDuration) {
                newSourceEnd = sourceDuration;
                deltaEnd = newSourceEnd - item.sourceEnd;
                newEnd = item.end + deltaEnd;
            }
            item.sourceEnd = newSourceEnd;
        }
        item.end = newEnd;
    }

    recalcTimelineDuration();
    renderAll();
});

document.addEventListener("mouseup", () => {
    if (!dragState) return;

    if (dragState.type === "create") {
        if (dragState.tempEl) dragState.tempEl.remove();
        const start = dragState.liveStart, end = dragState.liveEnd;

        // TITLES: titleSpan create default-data (createEffectSpan titleSpan branch)
        if (dragState.effectKind === "titleSpan" && typeof createEffectSpan === "function") {
            createEffectSpan("titleSpan", start, end);
            dragState = null;
            return;
        }

        // NAYE EFFECT-LAYERS: apna create-function (transition/panZoom/gradeSpan)
        if (dragState.effectKind && typeof createEffectSpan === "function") {
            createEffectSpan(dragState.effectKind, start, end);
            dragState = null;
            return;
        }

        if (end - start > 0.15) {
            if (typeof pushHistory === "function") pushHistory();
            const newSeg = {
                id: genId(),
                start, end,
                mode: "single",
                modeBoxState: {},
                muted: false,
                audioDetached: false,
            };
            segments.push(newSeg);
            selectOnly("segment", newSeg.id);
            recalcTimelineDuration();
            renderAll();
            persistTimelineState();
        }
    } else if (dragState.type === "move" || dragState.type === "resize-left" || dragState.type === "resize-right") {
        if (dragState.type === "move" && dragState.pendingCtrlToggle && !dragState.hasMoved) {
            // ye asal mein ek plain ctrl-click tha (drag nahi hua) — ab item ko
            // deselect karo, jaisa normal ctrl-click karta hai
            toggleSelectItem(dragState.pendingCtrlToggle.kind, dragState.pendingCtrlToggle.id);
        }
        dragState = null; // pehle drag khatam karo — taake recalc video-overlaps poori tarah resolve kare
        recalcTimelineDuration();
        renderAll();
        persistTimelineState();
    }

    dragState = null;
});

// ===== ZOOM =====

zoomInBtn.addEventListener("click", () => {
    pixelsPerSecond = Math.min(pixelsPerSecond + 40, 500);
    rezoomTimeline();
});

zoomOutBtn.addEventListener("click", () => {
    pixelsPerSecond = Math.max(pixelsPerSecond - 40, 20);
    rezoomTimeline();
});

function rezoomTimeline() {
    recalcTimelineDuration();
    renderAll();
    updatePlayheadPosition(virtualTime);
    // segment-marker flags (A/D) zoom ke sath re-position
    if (typeof updateMarkerOverlay === "function" && typeof __segMarkStart !== "undefined" && __segMarkStart !== null) {
        updateMarkerOverlay(__segMarkStart, null);
    }
}
