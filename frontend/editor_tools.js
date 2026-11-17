let clipboardItems = []; // [{kind, data, offset}]
let undoStack = [];
let redoStack = [];

function snapshotState() {
    return {
        // TITLES LAYER (undo/redo mein)
        titlesSpans: JSON.parse(JSON.stringify(titlesSpans || [])),
        segments: JSON.parse(JSON.stringify(segments)),
        audioLanes: JSON.parse(JSON.stringify(audioLanes)),
        videoClips: JSON.parse(JSON.stringify(videoClips)),
        // STACK-2 bhi undo/redo mein
        stack2Segments: JSON.parse(JSON.stringify(stack2Segments || [])),
        stack2AudioLanes: JSON.parse(JSON.stringify(stack2AudioLanes || [])),
        stack2VideoClips: JSON.parse(JSON.stringify(stack2VideoClips || [])),
        stackCount: (typeof stackCount !== "undefined") ? stackCount : 1,
        // NAYE EFFECT-LAYERS bhi undo/redo mein
        captionSpans: JSON.parse(JSON.stringify(captionSpans || [])),
        transitions: JSON.parse(JSON.stringify(transitions || [])),
        panZoomSpans: JSON.parse(JSON.stringify(panZoomSpans || [])),
        gradeSpans: JSON.parse(JSON.stringify(gradeSpans || [])),
        // SHORTS CANVAS (undo/redo mein bhi)
        shortsCanvas: (typeof scPersistPayload === "function") ? scPersistPayload() : null,
    };
}

function pushHistory() {
    undoStack.push(snapshotState());
    if (undoStack.length > 50) undoStack.shift();
    redoStack = [];
}

function clearHistory() {
    undoStack = [];
    redoStack = [];
}

function restoreState(state) {
    segments = state.segments;
    audioLanes = state.audioLanes;
    videoClips = state.videoClips;
    // STACK-2 restore (purane snapshots mein nahi hota — khali reset)
    stack2Segments = state.stack2Segments || [];
    stack2AudioLanes = state.stack2AudioLanes || [];
    stack2VideoClips = state.stack2VideoClips || [];
    // NAYE EFFECT-LAYERS restore
    captionSpans = state.captionSpans || [];
    transitions = state.transitions || [];
    panZoomSpans = state.panZoomSpans || [];
    titlesSpans = state.titlesSpans || [];
    // SHORTS CANVAS restore (purane snapshots me nahi hota — skip)
    if (state.shortsCanvas !== undefined && typeof scLoadFromState === "function") { try { scLoadFromState(state.shortsCanvas); } catch (e) {} }
    gradeSpans = state.gradeSpans || [];
    if (typeof ensureStackCount === "function") {
        ensureStackCount(state.stackCount || (stack2VideoClips.length || stack2Segments.length ? 2 : 1));
    }
    if (typeof updateStackLabels === "function") updateStackLabels();
    clearSelection();
    recalcTimelineDuration();
    renderAll();
    persistTimelineState();
}

function undo() {
    if (!undoStack.length) return;
    redoStack.push(snapshotState());
    restoreState(undoStack.pop());
}

function redo() {
    if (!redoStack.length) return;
    undoStack.push(snapshotState());
    restoreState(redoStack.pop());
}

function getByKindId(kind, id) {
    if (kind === "segment") return getSegmentById(id);
    if (kind === "audio") return getAudioById(id);
    if (kind === "video") return getVideoClipById(id);
    // NAYE EFFECT-LAYERS (timeline.js getters)
    if (typeof getItemByKindId === "function") return getItemByKindId(kind, id);
    return null;
}

function arrayOfKind(kind) {
    if (kind === "segment") return segments;
    if (kind === "audio") return audioLanes;
    if (kind === "video") return videoClips;
    // NAYE EFFECT-LAYERS
    if (typeof arrayOfEffectKind === "function") {
        const arr = arrayOfEffectKind(kind);
        if (arr) return arr;
    }
    return [];
}

// ===== SPLIT — playhead (virtualTime, i.e. timeline position — NOT mainPlayer.currentTime
//        which is now the *source* position) par selected item(s) ko todna =====
// STACK-AWARE: jo item jis stack ka hai, usi stack ke array mein split hota hai.
function splitSelectedAtPlayhead() {
    if (!selectedItems.length) return;
    const t = virtualTime;

    const splittable = selectedItems.filter(({ kind, id }) => {
        const item = getByKindId(kind, id);
        return item && (t - item.start > 0.1) && (item.end - t > 0.1);
    });
    if (!splittable.length) return;

    pushHistory();

    splittable.forEach(({ kind, id }) => {
        const item = getByKindId(kind, id);
        // item jis stack ke array mein mila wahi array use hoga (S1 ya S2)
        let arr = arrayOfKind(kind);
        if (typeof isEffectKind !== "function" || !isEffectKind(kind)) {
            for (let s = 1; s <= (typeof totalStacks === "function" ? totalStacks() : 1); s++) {
                const cand = arrayOfKindInStack(kind, s);
                if (cand.some((x) => x.id === item.id)) { arr = cand; break; }
            }
        }

        // NAYE EFFECT-LAYERS: poora object deep-copy right-half mein (style/grade/box
        // sab sath jata hai) — baad mein user right piece ki settings alag badal sakta hai
        if (typeof isEffectKind === "function" && isEffectKind(kind)) {
            const rightHalf = JSON.parse(JSON.stringify(item));
            rightHalf.id = genId();
            rightHalf.start = t;
            item.end = t;
            arr.splice(arr.indexOf(item) + 1, 0, rightHalf);
            return;
        }

        if (kind === "segment") {
            const rightHalf = {
                id: genId(), start: t, end: item.end, mode: item.mode,
                modeBoxState: JSON.parse(JSON.stringify(item.modeBoxState || {})),
                muted: !!item.muted, audioDetached: !!item.audioDetached,
            };
            if (item.bubbleState) rightHalf.bubbleState = JSON.parse(JSON.stringify(item.bubbleState));
            if (item.bubbleZoom !== undefined) rightHalf.bubbleZoom = item.bubbleZoom;
            if (item.bubbleStyle) rightHalf.bubbleStyle = item.bubbleStyle;
            if (item.bubbleBorder) rightHalf.bubbleBorder = JSON.parse(JSON.stringify(item.bubbleBorder));
            if (item.bubbleShadow) rightHalf.bubbleShadow = JSON.parse(JSON.stringify(item.bubbleShadow));
            item.end = t;
            arr.splice(arr.indexOf(item) + 1, 0, rightHalf);
        } else if (kind === "audio") {
            const splitSrc = item.sourceStart + (t - item.start);
            const rightHalf = {
                id: genId(), start: t, end: item.end,
                sourceStart: splitSrc, sourceEnd: item.sourceEnd,
                muted: !!item.muted, sourceClipId: item.sourceClipId,
            };
            item.end = t;
            item.sourceEnd = splitSrc;
            arr.splice(arr.indexOf(item) + 1, 0, rightHalf);
        } else if (kind === "video") {
            const splitSrc = item.sourceStart + (t - item.start);
            const rightHalf = {
                id: genId(), start: t, end: item.end,
                sourceStart: splitSrc, sourceEnd: item.sourceEnd,
                muted: !!item.muted, audioDetached: !!item.audioDetached,
            };
            item.end = t;
            item.sourceEnd = splitSrc;
            arr.splice(arr.indexOf(item) + 1, 0, rightHalf);
        }
        // left half (original id) selected hi rehta hai — jaisa pehle hota tha
    });

    recalcTimelineDuration();
    renderAll();
    persistTimelineState();
}

// ===== COPY / PASTE — multi-select ko group ke tor par copy karta hai, relative spacing preserve hoti hai
// STACK-AWARE: copied item apna stack carry karta hai; paste usi stack ke array mein jata hai.
function copySelected() {
    if (!selectedItems.length) { clipboardItems = []; return; }
    const items = selectedItems
        .map(({ kind, id }) => ({ kind, data: getByKindId(kind, id) }))
        .filter((x) => x.data);
    if (!items.length) { clipboardItems = []; return; }

    const minStart = Math.min(...items.map((x) => x.data.start));
    clipboardItems = items.map((x) => ({
        kind: x.kind,
        data: JSON.parse(JSON.stringify(x.data)),
        offset: x.data.start - minStart,
        stack: (x.data && x.data.__stack) || (typeof getStackOf === "function" ? getStackOf(x.kind, x.data.id) : 1),
    }));
}

function pasteClipboard() {
    if (!clipboardItems.length) return;
    const t = virtualTime; // timeline position (was incorrectly mainPlayer.currentTime before)
    pushHistory();

    const newSelection = [];
    clipboardItems.forEach(({ kind, data, offset, stack }) => {
        const dur = data.end - data.start;
        const start = Math.max(0, t + offset), end = start + dur; // no upper clamp — timeline auto-extends
        const targetStack = (stack === 2) ? 2 : 1; // copied item apna stack carry karta hai
        const arrs = (typeof stackArrays === "function") ? stackArrays(targetStack) : { segment: segments, audio: audioLanes, video: videoClips };

        // NAYE EFFECT-LAYERS: poora object deep-copy + naya id
        if (typeof arrayOfEffectKind === "function") {
            const effArr = arrayOfEffectKind(kind);
            if (effArr) {
                const newItem = JSON.parse(JSON.stringify(data));
                newItem.id = genId();
                newItem.start = start;
                newItem.end = end;
                effArr.push(newItem);
                newSelection.push({ kind, id: newItem.id });
                return;
            }
        }

        let newItem = null;
        if (kind === "segment") {
            newItem = {
                id: genId(), start, end, mode: data.mode,
                modeBoxState: JSON.parse(JSON.stringify(data.modeBoxState || {})),
                muted: !!data.muted, audioDetached: !!data.audioDetached,
            };
            if (data.bubbleState) newItem.bubbleState = JSON.parse(JSON.stringify(data.bubbleState));
            if (data.bubbleZoom !== undefined) newItem.bubbleZoom = data.bubbleZoom;
            if (data.bubbleStyle) newItem.bubbleStyle = data.bubbleStyle;
            if (data.bubbleBorder) newItem.bubbleBorder = JSON.parse(JSON.stringify(data.bubbleBorder));
            if (data.bubbleShadow) newItem.bubbleShadow = JSON.parse(JSON.stringify(data.bubbleShadow));
            arrs.segment.push(newItem);
        } else if (kind === "audio") {
            newItem = {
                id: genId(), start, end,
                sourceStart: data.sourceStart, sourceEnd: data.sourceEnd,
                muted: !!data.muted, sourceClipId: data.sourceClipId,
            };
            arrs.audio.push(newItem);
        } else if (kind === "video") {
            newItem = {
                id: genId(), start, end,
                sourceStart: data.sourceStart, sourceEnd: data.sourceEnd,
                muted: !!data.muted, audioDetached: !!data.audioDetached,
            };
            arrs.video.push(newItem);
        }
        if (newItem) newSelection.push({ kind, id: newItem.id });
    });

    selectedItems = newSelection;
    syncSelectionMirrors();
    recalcTimelineDuration();
    renderAll();
    persistTimelineState();
}

// ===== DUPLICATE — har selected item apne hi end ke turant baad clone hota hai =====
function duplicateSelected() {
    if (!selectedItems.length) return;
    pushHistory();
    const newSelection = [];

    selectedItems.forEach(({ kind, id }) => {
        const item = getByKindId(kind, id);
        if (!item) return;
        // NAYE EFFECT-LAYERS: deep-copy + naya id, original ke end ke baad
        if (typeof arrayOfEffectKind === "function") {
            const effArr = arrayOfEffectKind(kind);
            if (effArr) {
                const newItem = JSON.parse(JSON.stringify(item));
                newItem.id = genId();
                newItem.start = item.end;
                newItem.end = item.end + (item.end - item.start);
                effArr.push(newItem);
                newSelection.push({ kind, id: newItem.id });
                return;
            }
        }
        const dur = item.end - item.start;
        const start = item.end, end = start + dur; // no upper clamp — timeline auto-extends
        const arrs = (typeof stackArrays === "function") ? stackArrays(getStackOf(kind, id)) : { segment: segments, audio: audioLanes, video: videoClips };

        let newItem = null;
        if (kind === "segment") {
            newItem = {
                id: genId(), start, end, mode: item.mode,
                modeBoxState: JSON.parse(JSON.stringify(item.modeBoxState || {})),
                muted: !!item.muted, audioDetached: !!item.audioDetached,
            };
            if (item.bubbleState) newItem.bubbleState = JSON.parse(JSON.stringify(item.bubbleState));
            if (item.bubbleZoom !== undefined) newItem.bubbleZoom = item.bubbleZoom;
            if (item.bubbleStyle) newItem.bubbleStyle = item.bubbleStyle;
            if (item.bubbleBorder) newItem.bubbleBorder = JSON.parse(JSON.stringify(item.bubbleBorder));
            if (item.bubbleShadow) newItem.bubbleShadow = JSON.parse(JSON.stringify(item.bubbleShadow));
            arrs.segment.push(newItem);
        } else if (kind === "audio") {
            newItem = {
                id: genId(), start, end,
                sourceStart: item.sourceStart, sourceEnd: item.sourceEnd,
                muted: !!item.muted, sourceClipId: item.sourceClipId,
            };
            arrs.audio.push(newItem);
        } else if (kind === "video") {
            newItem = {
                id: genId(), start, end,
                sourceStart: item.sourceStart, sourceEnd: item.sourceEnd,
                muted: !!item.muted, audioDetached: !!item.audioDetached,
            };
            arrs.video.push(newItem);
        }
        if (newItem) newSelection.push({ kind, id: newItem.id });
    });

    selectedItems = newSelection;
    syncSelectionMirrors();
    recalcTimelineDuration();
    renderAll();
    persistTimelineState();
}

// ===== MUTE — jo bhi selected ho (kisi bhi layer ka) uska muted flag toggle =====
function toggleMuteSelected() {
    if (!selectedItems.length) return;
    pushHistory();
    selectedItems.forEach(({ kind, id }) => {
        const item = getByKindId(kind, id);
        if (item) item.muted = !item.muted;
    });
    renderAll();
    persistTimelineState();
}

// ===== DETACH AUDIO — sirf selected VIDEO clip par kaam karta hai; naye audioLane
//        mein sourceStart/sourceEnd bhi carry hote hain (taake uska waveform sahi dikhe) =====
function toggleDetachAudioSelected() {
    const videoIds = selectedIdsOf("video");
    if (!videoIds.length) return;
    pushHistory();

    videoIds.forEach((id) => {
        const c = getVideoClipById(id);
        if (!c) return;
        c.audioDetached = !c.audioDetached;

        if (c.audioDetached) {
            audioLanes.push({
                id: genId(), start: c.start, end: c.end,
                sourceStart: c.sourceStart, sourceEnd: c.sourceEnd,
                muted: false, sourceClipId: c.id,
            });
        } else {
            audioLanes = audioLanes.filter((a) => a.sourceClipId !== c.id);
        }
    });

    renderAll();
    persistTimelineState();
}

// ===== DELETE — jo bhi selected ho, sab hat jayen =====
// NEW — RIPPLE DELETE: video-clip delete hone par baad ki clips LEFT shift ho
// kar gap ko close kar deti hain (Filmora-style). Pehle user ko gap ke baad
// clips manually drag kar ke join karni padti thi, aur wo manual join hi glitch
// ka doosra sabab tha (overlaps + drift). Ab join automatic aur exact hai — na
// gap bachta hai na overlap. NOTE: pehli clip apni jagah anchored rehti hai
// (intentionally rakha hua leading gap kharab nahi hota); sirf andar ke gaps
// close hote hain.
function rippleCloseVideoGaps() {
    rippleCloseIn(videoClips);
    rippleCloseIn(stack2VideoClips || []); // STACK-2 bhi
}

function rippleCloseIn(clipArr) {
    if (clipArr.length < 2) return;
    const sorted = [...clipArr].sort((a, b) => a.start - b.start);
    let cursor = sorted[0].start; // first clip anchored
    for (const c of sorted) {
        const dur = c.end - c.start;
        if (Math.abs(c.start - cursor) > 1e-6) {
            c.start = cursor;
            c.end = cursor + dur;
        }
        cursor = c.end;
    }
}

// ===== GAP FILL — video clips ke beech ki SARI gaps ek click par close =====
// Speed change karne par clips apni jagah shrink ho jati hain aur beech mein
// gaps reh jate hain. Ye button un sab ko left-ripple se join kar deta hai
// (wahi jo delete ke baad automatic hota hai — par yeh manual trigger hai).
function fillAllVideoGaps() {
    if (!videoClips.length) return;
    pushHistory();
    rippleCloseVideoGaps();
    recalcTimelineDuration();
    renderAll();
    persistTimelineState();
    seekVirtual(Math.min(virtualTime, timelineContentEnd));
}

function deleteSelected() {
    if (!selectedItems.length) return;
    pushHistory();
    let videoDeleted = false;

    selectedItems.forEach(({ kind, id }) => {
        // NAYE EFFECT-LAYERS delete (koi stack concept nahi)
        if (typeof arrayOfEffectKind === "function") {
            const effArr = arrayOfEffectKind(kind);
            if (effArr) {
            const idx = effArr.findIndex((x) => x.id === id);
            if (idx >= 0) effArr.splice(idx, 1);
            if (kind === "panZoom" && typeof pzOnDeleted === "function") pzOnDeleted(id);
            // (USER FIX) AAKHRI grade-span delete → global colorGrade (panel
            // working-buffer) bhi reset — warna usme pada last-preset color
            // render-fallback se video par chipak jata tha (delete kar bhi
            // color wapas aa jata tha wala bug).
            if (kind === "gradeSpan" && effArr.length === 0 && typeof colorGrade !== "undefined") {
                Object.keys(colorGrade).forEach((k) => { colorGrade[k] = 0; });
                if (typeof cgSyncUI === "function") cgSyncUI();
            }
            return;
            }
        }
        // STACK-AWARE delete: item jis stack ka hai, usi ke array se hatega
        const stack = getStackOf(kind, id);
        const arrs = stackArrays(stack);
        if (kind === "segment") {
            if (stack === 2) stack2Segments = arrs.segment.filter((s) => s.id !== id);
            else segments = arrs.segment.filter((s) => s.id !== id);
        } else if (kind === "audio") {
            if (stack === 2) stack2AudioLanes = arrs.audio.filter((a) => a.id !== id);
            else audioLanes = arrs.audio.filter((a) => a.id !== id);
        } else if (kind === "video") {
            if (stack === 2) {
                stack2VideoClips = arrs.video.filter((c) => c.id !== id);
                stack2AudioLanes = stack2AudioLanes.filter((a) => a.sourceClipId !== id);
            } else {
                videoClips = arrs.video.filter((c) => c.id !== id);
                audioLanes = audioLanes.filter((a) => a.sourceClipId !== id);
            }
            videoDeleted = true;
        }
    });

    clearSelection();
    if (videoDeleted) rippleCloseVideoGaps(); // sirf video-delete par ripple
    recalcTimelineDuration();
    renderAll();
    persistTimelineState();
    seekVirtual(virtualTime); // re-evaluate what should be playing/showing right now
}

document.addEventListener("keydown", (e) => {
    const tag = (e.target && e.target.tagName) || "";
    if (tag === "INPUT" || tag === "TEXTAREA") return;

    if (e.ctrlKey && !e.shiftKey && e.key.toLowerCase() === "z") { e.preventDefault(); undo(); return; }
    if ((e.ctrlKey && e.key.toLowerCase() === "y") || (e.ctrlKey && e.shiftKey && e.key.toLowerCase() === "z")) { e.preventDefault(); redo(); return; }
    if (e.ctrlKey && e.key.toLowerCase() === "c") { e.preventDefault(); copySelected(); return; }
    if (e.ctrlKey && e.key.toLowerCase() === "v") { e.preventDefault(); pasteClipboard(); return; }
    if (e.ctrlKey && e.shiftKey && e.key.toLowerCase() === "d") { e.preventDefault(); toggleDetachAudioSelected(); return; }
    if (e.ctrlKey && e.key.toLowerCase() === "d") { e.preventDefault(); duplicateSelected(); return; }
    if (!e.ctrlKey && e.key.toLowerCase() === "x") { e.preventDefault(); splitSelectedAtPlayhead(); return; }
    if (e.ctrlKey && e.key.toLowerCase() === "t") { e.preventDefault(); splitSelectedAtPlayhead(); return; }
    if (!e.ctrlKey && e.key.toLowerCase() === "m") { e.preventDefault(); toggleMuteSelected(); return; }
    if (e.key === "Delete") { e.preventDefault(); deleteSelected(); return; }
});

document.getElementById("splitBtn").addEventListener("click", splitSelectedAtPlayhead);
document.getElementById("gapFillBtn").addEventListener("click", fillAllVideoGaps);
document.getElementById("copyBtn").addEventListener("click", copySelected);
document.getElementById("pasteBtn").addEventListener("click", pasteClipboard);
document.getElementById("duplicateBtn").addEventListener("click", duplicateSelected);
document.getElementById("deleteBtn").addEventListener("click", deleteSelected);
document.getElementById("muteBtn").addEventListener("click", toggleMuteSelected);
document.getElementById("detachAudioBtn").addEventListener("click", toggleDetachAudioSelected);
document.getElementById("undoBtn").addEventListener("click", undo);
document.getElementById("redoBtn").addEventListener("click", redo);

// ===== SILENCE / FILLER-WORD DETECTION =====
// silence_engine.py video ki ORIGINAL file ko process karta hai, isliye jo
// {start, end} ranges wapas aate hain wo hamesha SOURCE-time mein hote hain
// (0 se sourceDuration tak) — TIMELINE-position nahi. Agar clip kabhi
// move/trim/split hui ho, to source-time aur timeline-time ek jaisi nahi
// rehti. Isi liye yahan har range ko us clip ke sourceStart/sourceEnd se
// map kar ke sahi timeline-position par split karte hain.
const SILENCE_EPS = 0.02;

function splitArrayAtTimelinePos(arr, t) {
    for (let i = arr.length - 1; i >= 0; i--) {
        const item = arr[i];
        if (t - item.start > SILENCE_EPS && item.end - t > SILENCE_EPS) {
            const splitSrc = item.sourceStart + (t - item.start);
            const rightHalf = JSON.parse(JSON.stringify(item));
            rightHalf.id = genId();
            rightHalf.start = t;
            rightHalf.sourceStart = splitSrc;
            item.end = t;
            item.sourceEnd = splitSrc;
            arr.splice(i + 1, 0, rightHalf);
        }
    }
}

// Ek source-time range (srcStart..srcEnd) ko us array ke jitne bhi clips
// overlap karti hain, unke andar timeline-position par convert kar ke split
// karta hai, aur poori tarah range ke andar aane wale pieces ko selection
// mein daal deta hai.
function splitArrayAtSourceRange(arr, srcStart, srcEnd, kind, selectionOut) {
    const targets = arr.filter(
        (it) => it.sourceStart < srcEnd - SILENCE_EPS && it.sourceEnd > srcStart + SILENCE_EPS
    );
    targets.forEach((clip) => {
        const overlapStart = Math.max(srcStart, clip.sourceStart);
        const overlapEnd = Math.min(srcEnd, clip.sourceEnd);
        const tlStart = clip.start + (overlapStart - clip.sourceStart);
        const tlEnd = clip.start + (overlapEnd - clip.sourceStart);
        splitArrayAtTimelinePos(arr, tlStart);
        splitArrayAtTimelinePos(arr, tlEnd);
    });

    arr.forEach((it) => {
        if (it.sourceStart >= srcStart - SILENCE_EPS && it.sourceEnd <= srcEnd + SILENCE_EPS) {
            selectionOut.push({ kind, id: it.id });
        }
    });
}

async function detectSilenceAndFillers() {
    if (!currentVideoRef) return;
    const btn = document.getElementById("detectSilenceBtn");
    const label = btn.querySelector(".tool-label");
    const original = label ? label.textContent : null;
    btn.disabled = true;
    if (label) label.textContent = "Detecting…";

    try {
        const res = await fetch(`/video/${currentVideoRef.saved_name}/detect_silence`, { method: "POST" });
        const data = await res.json();
        if (data.error) { alert("Detect Silence failed: " + data.error); return; }

        const ranges = data.ranges || [];
        if (!ranges.length) { alert("Koi silence ya filler-word detect nahi hui."); return; }

        pushHistory();
        const newSelection = [];

        // source-time ke hisaab se descending order mein process karo —
        // taake ek range ke split-operations doosri range ki (abhi tak
        // unprocessed) source-time position ko disturb na karen
        const sorted = [...ranges].sort((a, b) => b.start - a.start);
        sorted.forEach(({ start, end }) => {
            splitArrayAtSourceRange(videoClips, start, end, "video", newSelection);
            splitArrayAtSourceRange(audioLanes, start, end, "audio", newSelection);
        });

        selectedItems = newSelection;
        syncSelectionMirrors();
        recalcTimelineDuration();
        renderAll();
        persistTimelineState();

        alert(`${ranges.length} silence/filler portions select ho gaye hain. Delete button ya Delete-key se hata dein, ya kahin aur click kar ke deselect karen.`);
    } catch (err) {
        alert("Detect Silence error: " + err);
    } finally {
        btn.disabled = false;
        if (label && original) label.textContent = original;
    }
}

document.getElementById("detectSilenceBtn").addEventListener("click", detectSilenceAndFillers);

// ===== KEYBINDING-ACTION FUNCTIONS =====
// keybindings.js inhe call karta hai (capture-phase se, double-fire guard ke saath)

// Segment START/END markers (A / D keys) — playhead position par segment banao.
// Pehli baar START, doosri baar END -> segment ready. ESC/START dobara = reset.
let __segMarkStart = null;

function setSegmentMarker(which) {
    if (typeof virtualTime === "undefined" || typeof seekVirtual !== "function") return;
    const t = virtualTime;
    if (which === "start") {
        __segMarkStart = t;
        if (typeof clearSelection === "function") clearSelection();
        if (typeof renderSegments === "function") renderSegments();
        updateMarkerOverlay(t, null);
    } else if (which === "end") {
        if (__segMarkStart === null) {
            // pehle START maarna zaroori hai
            updateMarkerOverlay(null, t);
            return;
        }
        let s = Math.min(__segMarkStart, t);
        let e2 = Math.max(__segMarkStart, t);
        if (e2 - s > 0.15) {
            if (typeof pushHistory === "function") pushHistory();
            const newSeg = {
                id: genId(),
                start: s,
                end: e2,
                mode: "single",
                modeBoxState: {},
                muted: false,
                audioDetached: false,
            };
            segments.push(newSeg);
            if (typeof selectOnly === "function") selectOnly("segment", newSeg.id);
            if (typeof recalcTimelineDuration === "function") recalcTimelineDuration();
            if (typeof renderAll === "function") renderAll();
            persistTimelineState();
        }
        __segMarkStart = null;
        updateMarkerOverlay(null, null);
    }
}

function updateMarkerOverlay(startT, endT) {
    const layer = document.getElementById("markerOverlay");
    if (!layer) return;
    layer.innerHTML = "";
    if (startT !== null && startT !== undefined) {
        const flag = document.createElement("div");
        flag.className = "seg-marker-flag start";
        flag.style.left = (startT * pixelsPerSecond) + "px";
        flag.title = "Segment START (A se set hota hai)";
        layer.appendChild(flag);
    }
    if (endT !== null && endT !== undefined) {
        const flag = document.createElement("div");
        flag.className = "seg-marker-flag end";
        flag.style.left = (endT * pixelsPerSecond) + "px";
        flag.title = "END — lekin pehle START maaro (A)";
        layer.appendChild(flag);
    }
}

// STOP (Num8): pause + playhead 0 par
function stopPlayback() {
    if (typeof pausePlayback === "function") pausePlayback();
    if (typeof seekVirtual === "function") seekVirtual(0);
    const btn = document.getElementById("playPauseBtn");
    if (btn) btn.textContent = "▶";
}

