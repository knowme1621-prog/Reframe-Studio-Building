// ===== SPEED CONTROL (Filmora-style digital speed meter) =====
// video-wrapper ke top-right corner par floating widget. Selected video-clip
// (ya, agar kuch select nahi hai, playhead ke neeche wali clip) ki speed
// change karta hai — drag se fine-adjust (0.01 steps), ya click kar ke type.
//
// Data-model: videoClips[i].speed (default 1). Speed badalne par clip ki
// TIMELINE duration recompute hoti hai (source-content ki lambai fixed
// rehti hai, timeline par wo lambai speed ke hisaab se chhoti/badi dikhti
// hai) — bilkul Filmora jaisa behavior.

const SPEED_MIN = 0.1;
const SPEED_MAX = 4.0;
const SPEED_DRAG_SENSITIVITY = 0.005; // per pixel horizontal drag

let speedDragState = null; // { startClientX, origSpeed, clip }
let speedEditingInput = false;

function getSpeedTargetClips() {
    // FIX: ab MULTI-SELECT support hai — jitni video-clips selected hain SAB ki
    // speed ek sath change hoti hai (pehle sirf playhead-wali clip ki hoti thi).
    const selVideo = (typeof selectedIdsOf === "function") ? selectedIdsOf("video") : [];
    if (selVideo.length) {
        const clips = selVideo.map((id) => getVideoClipById(id)).filter(Boolean);
        if (clips.length) return clips;
    }
    // warna, playhead ke neeche wali active clip
    if (typeof findActiveVideoClip === "function" && typeof virtualTime !== "undefined") {
        const c = findActiveVideoClip(virtualTime);
        if (c) return [c];
    }
    return [];
}

function getSpeedTargetClip() {
    const clips = getSpeedTargetClips();
    return clips.length ? clips[0] : null; // backward-compat (UI display ke liye)
}

function formatSpeed(v) {
    return v.toFixed(2) + "x";
}

function applySpeedToClip(clip, newSpeed) {
    return applySpeedToClips([clip], newSpeed);
}

function applySpeedToClips(clips, newSpeed) {
    if (!clips || !clips.length) return newSpeed;
    newSpeed = Math.min(SPEED_MAX, Math.max(SPEED_MIN, newSpeed));
    newSpeed = Math.round(newSpeed * 100) / 100;

    clips.forEach((clip) => {
        clip.speed = newSpeed;
        const sourceLen = (clip.sourceEnd - clip.sourceStart);
        const newDuration = Math.max(0.1, sourceLen / newSpeed);
        clip.end = clip.start + newDuration;
    });

    // FIX: multi-clip speed-change par clips apni jagah shrink/badhti hain —
    // beech mein gaps reh jate the. Agar selected clips CONTIGUOUS chain banati
    // hain (typical: sab select kar ke speed badli) to gaps khud close kar do
    // (wahi ripple-join jo delete par hota hai). Non-contiguous selection par
    // user ke intentional gaps preserve rehte hain.
    if (clips.length > 1 && typeof rippleCloseVideoGaps === "function") {
        const byStart = [...clips].sort((a, b) => a.start - b.start);
        const contiguous = byStart.every((c, i) =>
            i === 0 || Math.abs(byStart[i - 1].end - c.start) < 0.05
        );
        if (contiguous) rippleCloseVideoGaps();
    }

    if (typeof recalcTimelineDuration === "function") recalcTimelineDuration();
    if (typeof renderAll === "function") renderAll();
    if (typeof persistTimelineState === "function") persistTimelineState();

    return newSpeed;
}

function updateSpeedControlUI() {
    if (speedDragState || speedEditingInput) return; // drag/typing ke waqt UI ko khud se overwrite mat karo

    const wrap = document.getElementById("speedControl");
    const valueEl = document.getElementById("speedValue");
    if (!wrap || !valueEl) return;

    const clip = getSpeedTargetClip();
    if (!clip) {
        wrap.classList.add("speed-disabled");
        valueEl.textContent = "1.00x";
        return;
    }
    wrap.classList.remove("speed-disabled");
    const speed = clip.speed === undefined ? 1 : clip.speed;
    valueEl.textContent = formatSpeed(speed);
}

function startSpeedInlineEdit() {
    const clip = getSpeedTargetClip();
    if (!clip) return;
    const valueEl = document.getElementById("speedValue");
    if (!valueEl) return;

    speedEditingInput = true;
    const current = (clip.speed === undefined ? 1 : clip.speed).toFixed(2);

    valueEl.contentEditable = "true";
    valueEl.textContent = current;
    valueEl.classList.add("speed-editing");

    // select all text taake user seedha type kar sake
    const range = document.createRange();
    range.selectNodeContents(valueEl);
    const sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(range);
    valueEl.focus();

    function commit() {
        speedEditingInput = false;
        valueEl.contentEditable = "false";
        valueEl.classList.remove("speed-editing");
        const parsed = parseFloat(valueEl.textContent.replace(/[^0-9.]/g, ""));
        if (!isNaN(parsed) && parsed > 0) {
            applySpeedToClips(getSpeedTargetClips(), parsed); // FIX: SARI selected clips
        }
        updateSpeedControlUI();
        valueEl.removeEventListener("blur", commit);
        valueEl.removeEventListener("keydown", onKeyDown);
    }
    function onKeyDown(e) {
        if (e.key === "Enter") { e.preventDefault(); valueEl.blur(); }
        else if (e.key === "Escape") { valueEl.textContent = current; valueEl.blur(); }
    }
    valueEl.addEventListener("blur", commit);
    valueEl.addEventListener("keydown", onKeyDown);
}

document.addEventListener("DOMContentLoaded", () => {
    const wrap = document.getElementById("speedControl");
    const valueEl = document.getElementById("speedValue");
    if (!wrap || !valueEl) return;

    let dragMoved = false;

    wrap.addEventListener("mousedown", (e) => {
        if (speedEditingInput) return;
        const clips = getSpeedTargetClips();
        if (!clips.length) return;
        const clip = clips[0];
        dragMoved = false;
        speedDragState = {
            startClientX: e.clientX,
            origSpeed: clip.speed === undefined ? 1 : clip.speed,
            clips,
        };
        e.preventDefault();
    });

    document.addEventListener("mousemove", (e) => {
        if (!speedDragState) return;
        const dx = e.clientX - speedDragState.startClientX;
        if (Math.abs(dx) > 2) dragMoved = true;
        const newSpeed = speedDragState.origSpeed + dx * SPEED_DRAG_SENSITIVITY;
        const clamped = Math.min(SPEED_MAX, Math.max(SPEED_MIN, newSpeed));
        valueEl.textContent = formatSpeed(Math.round(clamped * 100) / 100);
        wrap.classList.toggle("speed-fast", clamped > 1);
        wrap.classList.toggle("speed-slow", clamped < 1);
    });

    document.addEventListener("mouseup", () => {
        if (!speedDragState) return;
        const dx_present = dragMoved;
        const clips = speedDragState.clips;

        if (dx_present) {
            const parsed = parseFloat(valueEl.textContent.replace(/[^0-9.]/g, ""));
            if (!isNaN(parsed)) applySpeedToClips(clips, parsed); // FIX: SARI selected clips
        }
        speedDragState = null;

        if (!dx_present) {
            // ye plain click tha (drag nahi hua) -> inline type-edit shuru karo
            startSpeedInlineEdit();
        } else {
            updateSpeedControlUI();
        }
    });

    // continuous UI sync (selection badalne par, playhead move hone par, etc.)
    function loop() {
        updateSpeedControlUI();
        requestAnimationFrame(loop);
    }
    requestAnimationFrame(loop);
});
