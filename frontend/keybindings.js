// ============================================================================
// KEYBINDINGS ENGINE — short-keys + custom assignment + persistence
//
// User ke diye hue DEFAULTS (sab numpad keys par):
//   Num1  <- 5s      Ctrl+Num1  <- 5ms
//   Num3  -> 5s      Ctrl+Num3  -> 5ms
//   Num4  <- 1s      Ctrl+Num4  <- 1ms
//   Num6  -> 1s      Ctrl+Num6  -> 1ms
//   Num7  <- 10s     Ctrl+Num7  <- 20s
//   Num9  -> 10s     Ctrl+Num9  -> 20s
//   Num5  Play/Pause (Long Space bar bhi)
//   Num8  STOP (pause + seek 0)
//   Num2  -> 1 frame   Ctrl+Num2 -> 5f   Shift+Num2 -> 10f
//   Num0  <- 1 frame   Ctrl+Num0 <- 5f   Shift+Num0 <- 10f
//   Ctrl+S  Project Save
//   A  Segment START, D  Segment END (crop segment)
//   F  Split, K  Split
//   Ctrl+C Copy, Ctrl+V Paste, Ctrl+Z Undo, Ctrl+X REDO
// ============================================================================

// ---- Default bindings (user-specified) ----
const KB_DEFAULT_BINDINGS = {
    "kb_seek_back_5s":    { code: "Numpad1", ctrl: false, shift: false },
    "kb_seek_back_5ms":   { code: "Numpad1", ctrl: true,  shift: false },
    "kb_seek_fwd_5s":     { code: "Numpad3", ctrl: false, shift: false },
    "kb_seek_fwd_5ms":    { code: "Numpad3", ctrl: true,  shift: false },
    "kb_seek_back_1s":    { code: "Numpad4", ctrl: false, shift: false },
    "kb_seek_back_1ms":   { code: "Numpad4", ctrl: true,  shift: false },
    "kb_seek_fwd_1s":     { code: "Numpad6", ctrl: false, shift: false },
    "kb_seek_fwd_1ms":    { code: "Numpad6", ctrl: true,  shift: false },
    "kb_seek_back_10s":   { code: "Numpad7", ctrl: false, shift: false },
    "kb_seek_back_20s":   { code: "Numpad7", ctrl: true,  shift: false },
    "kb_seek_fwd_10s":    { code: "Numpad9", ctrl: false, shift: false },
    "kb_seek_fwd_20s":    { code: "Numpad9", ctrl: true,  shift: false },
    "kb_play_pause":      { code: "Numpad5", ctrl: false, shift: false },
    "kb_stop":            { code: "Numpad8", ctrl: false, shift: false },
    "kb_frame_fwd":       { code: "Numpad2", ctrl: false, shift: false },
    "kb_frame_fwd_5":     { code: "Numpad2", ctrl: true,  shift: false },
    "kb_frame_fwd_10":    { code: "Numpad2", ctrl: false, shift: true  },
    "kb_frame_back":      { code: "Numpad0", ctrl: false, shift: false },
    "kb_frame_back_5":    { code: "Numpad0", ctrl: true,  shift: false },
    "kb_frame_back_10":   { code: "Numpad0", ctrl: false, shift: true  },
    "kb_project_save":    { code: "KeyS",    ctrl: true,  shift: false },
    "kb_seg_start":       { code: "KeyA",    ctrl: false, shift: false },
    "kb_seg_end":         { code: "KeyD",    ctrl: false, shift: false },
    "kb_split_f":         { code: "KeyF",    ctrl: false, shift: false },
    "kb_split_k":         { code: "KeyK",    ctrl: false, shift: false },
    "kb_copy":            { code: "KeyC",    ctrl: true,  shift: false },
    "kb_paste":           { code: "KeyV",    ctrl: true,  shift: false },
    "kb_undo":            { code: "KeyZ",    ctrl: true,  shift: false },
    "kb_redo":            { code: "KeyX",    ctrl: true,  shift: false }
};

// split ke liye REAL function ka naam (splitAtPlayhead exist nahi karta —
// asli naam splitSelectedAtPlayhead hai, editor_tools.js mein)
function kbCall(fnName, ...args) {
    const fn = window[fnName];
    if (typeof fn === "function") { fn(...args); return true; }
    console.warn("Keybinding: function missing:", fnName);
    return false;
}

// ---- Action registry: har action ka label + handler ----
const KB_ACTIONS = {
    "kb_seek_back_5s":  { label: "\u2190 5 sec", run: () => kbNudge(-5) },
    "kb_seek_back_5ms": { label: "\u2190 5 ms",  run: () => kbNudge(-0.005) },
    "kb_seek_fwd_5s":   { label: "5 sec \u2192", run: () => kbNudge(5) },
    "kb_seek_fwd_5ms":  { label: "5 ms \u2192",  run: () => kbNudge(0.005) },
    "kb_seek_back_1s":  { label: "\u2190 1 sec", run: () => kbNudge(-1) },
    "kb_seek_back_1ms": { label: "\u2190 1 ms",  run: () => kbNudge(-0.001) },
    "kb_seek_fwd_1s":   { label: "1 sec \u2192", run: () => kbNudge(1) },
    "kb_seek_fwd_1ms":  { label: "1 ms \u2192",  run: () => kbNudge(0.001) },
    "kb_seek_back_10s": { label: "\u2190 10 sec", run: () => kbNudge(-10) },
    "kb_seek_back_20s": { label: "\u2190 20 sec", run: () => kbNudge(-20) },
    "kb_seek_fwd_10s":  { label: "10 sec \u2192", run: () => kbNudge(10) },
    "kb_seek_fwd_20s":  { label: "20 sec \u2192", run: () => kbNudge(20) },
    "kb_play_pause":    { label: "Play / Pause", run: () => { if (typeof togglePlay === "function") togglePlay(); } },
    "kb_stop":          { label: "Stop", run: () => { if (typeof stopPlayback === "function") stopPlayback(); } },
    "kb_frame_fwd":     { label: "\u2192 1 Frame",  run: () => kbFrame(1) },
    "kb_frame_fwd_5":   { label: "\u2192 5 Frames", run: () => kbFrame(5) },
    "kb_frame_fwd_10":  { label: "\u2192 10 Frames", run: () => kbFrame(10) },
    "kb_frame_back":    { label: "\u2190 1 Frame",  run: () => kbFrame(-1) },
    "kb_frame_back_5":  { label: "\u2190 5 Frames", run: () => kbFrame(-5) },
    "kb_frame_back_10": { label: "\u2190 10 Frames", run: () => kbFrame(-10) },
    "kb_project_save":  { label: "Project Save", run: () => { if (typeof saveCurrentProject === "function") saveCurrentProject(); } },
    "kb_seg_start":     { label: "Segment START", run: () => kbCall("setSegmentMarker", "start") },
    "kb_seg_end":       { label: "Segment END", run: () => kbCall("setSegmentMarker", "end") },
    "kb_split_f":       { label: "Split (F)", run: () => kbCall("splitSelectedAtPlayhead") },
    "kb_split_k":       { label: "Split (K)", run: () => kbCall("splitSelectedAtPlayhead") },
    "kb_copy":          { label: "Copy", run: () => kbCall("copySelected") },
    "kb_paste":         { label: "Paste", run: () => kbCall("pasteClipboard") },
    "kb_undo":          { label: "Undo", run: () => kbCall("undo") },
    "kb_redo":          { label: "RE-DO", run: () => kbCall("redo") }
};

// ---- state ----
let kbBindings = {};          // actionId -> {keys: [{code, ctrl, shift}, ...]} (multi-key)
let kbCaptureTarget = null;   // actionId jiske liye user naya key press kar raha hai
let kbLastEventTs = 0;        // keyauto-repeat throttle

function kbDeepCopy(o) { return JSON.parse(JSON.stringify(o)); }

// purana single-key format {code,ctrl,shift} -> naya multi-key {keys:[...]}
function kbNormalizeBinding(b) {
    if (b && Array.isArray(b.keys)) {
        return { keys: b.keys.filter(k => k && k.code).map(k => ({ code: k.code, ctrl: !!k.ctrl, shift: !!k.shift })) };
    }
    if (b && b.code) return { keys: [{ code: b.code, ctrl: !!b.ctrl, shift: !!b.shift }] };
    return { keys: [] };
}

function kbLoadBindings() {
    kbBindings = {};
    Object.keys(KB_DEFAULT_BINDINGS).forEach(id => {
        kbBindings[id] = kbNormalizeBinding(KB_DEFAULT_BINDINGS[id]);
    });
    try {
        const raw = localStorage.getItem("reframe_keybindings");
        if (raw) {
            const saved = JSON.parse(raw);
            Object.keys(saved).forEach(id => {
                if (kbBindings[id] && saved[id]) kbBindings[id] = kbNormalizeBinding(saved[id]);
            });
        }
    } catch (e) {}
}

function kbSaveBindings() {
    try { localStorage.setItem("reframe_keybindings", JSON.stringify(kbBindings)); } catch (e) {}
}

function kbResetToDefaults() {
    Object.keys(KB_DEFAULT_BINDINGS).forEach(id => {
        kbBindings[id] = kbNormalizeBinding(KB_DEFAULT_BINDINGS[id]);
    });
    kbSaveBindings();
    kbRenderPanel();
}

// ---- helper: binding ko readable label ----
function kbBindingLabel(b) {
    if (!b || !b.code) return "not set";
    let key = b.code;
    if (key.startsWith("Numpad")) key = "Num" + key.slice(6);
    else if (key.startsWith("Key")) key = key.slice(3);
    else if (key.startsWith("Digit")) key = key.slice(5);
    let s = "";
    if (b.ctrl) s += "Ctrl+";
    if (b.shift) s += "Shift+";
    return s + key;
}

// ---- main keydown handler ----
function kbHandleKeydown(e) {
    const tag = (e.target && e.target.tagName) ? e.target.tagName.toLowerCase() : "";
    const inField = tag === "input" || tag === "textarea" || tag === "select" ||
        (e.target && e.target.isContentEditable);
    if (inField) return;

    const code = e.code || "";
    if (!code) return;
    if (code === "Escape" && kbCaptureTarget) { kbCancelCapture(); e.preventDefault(); return; }
    // Space ko browser-page-scroll se roko (play/pause hum karenge)
    if (code === "Space") e.preventDefault();

    const now = Date.now();
    const isAutoRepeat = now - kbLastEventTs < 30; // held-key throttle
    if (isAutoRepeat && !code.startsWith("Numpad")) return;
    kbLastEventTs = now;

    // capture mode: user naya key assign kar raha hai
    if (kbCaptureTarget) {
        if (code === "Escape") { kbCancelCapture(); return; }
        kbAssignCaptured(code, e.ctrlKey, e.shiftKey);
        e.preventDefault();
        return;
    }

    // binding match: kisi bhi assigned key par chalega (MULTI-KEY support)
    for (const actionId of Object.keys(kbBindings)) {
        const keys = kbBindings[actionId].keys || [];
        const hit = keys.find(k => k.code === code && !!k.ctrl === e.ctrlKey && !!k.shift === e.shiftKey);
        if (hit) {
            const action = KB_ACTIONS[actionId];
            if (action && typeof action.run === "function") {
                // Text-copy ko kharab na karein: agar Ctrl+C system text-selection par mara
                // to bhi humara copy chalega (app mein text selection critical nahi hai)
                e.preventDefault();
                e.stopPropagation();
                try { action.run(); } catch (err) { console.error("Keybinding action failed:", actionId, err); }
            }
            return;
        }
    }
}

// ---- transport helpers ----
function kbNudge(delta) {
    if (typeof seekVirtual !== "function") return;
    const cur = (typeof virtualTime !== "undefined") ? virtualTime : 0;
    seekVirtual(cur + delta);
    if (typeof updatePlayheadPosition === "function") updatePlayheadPosition(cur + delta);
    if (typeof renderSegments === "function") renderSegments();
}

function kbFrame(frames) {
    if (typeof seekVirtual !== "function") return;
    const fps = (typeof currentFps === "function") ? currentFps() : 25;
    const cur = (typeof virtualTime !== "undefined") ? virtualTime : 0;
    seekVirtual(cur + frames / fps);
    if (typeof updatePlayheadPosition === "function") updatePlayheadPosition(cur + frames / fps);
    if (typeof renderSegments === "function") renderSegments();
}

// Long Space bar bhi Play/Pause (user request)
function kbHandleSpaceRepeat(e) {
    const tag = (e.target && e.target.tagName) ? e.target.tagName.toLowerCase() : "";
    if (tag === "input" || tag === "textarea" || tag === "select") return;
    if (e.code !== "Space") return;
    e.preventDefault();
    if (Date.now() - kbLastEventTs < 25) return;
    kbLastEventTs = Date.now();
    if (kbCaptureTarget) { kbAssignCaptured("Space", e.ctrlKey, e.shiftKey); return; }
    const b = kbBindings["kb_play_pause"];
    if (b && (b.keys || []).some(k => k.code === "Space") && typeof togglePlay === "function") togglePlay();
}

// ---- capture (re-assign) flow ----
function kbStartCapture(actionId) {
    kbCaptureTarget = actionId;
    const el = document.querySelector(`[data-kb-capture="${actionId}"]`);
    if (el) { el.textContent = "key dabao..."; el.classList.add("capturing"); }
}
function kbCancelCapture() {
    const prev = kbCaptureTarget;
    kbCaptureTarget = null;
    if (prev) {
        const el = document.querySelector(`[data-kb-capture="${prev}"]`);
        if (el) {
            const keys = (kbBindings[prev] && kbBindings[prev].keys) || [];
            el.textContent = keys.length ? keys.map(kbBindingLabel).join(" / ") : "not set";
            el.classList.remove("capturing");
        }
    }
}
function kbAssignCaptured(code, ctrl, shift) {
    const actionId = kbCaptureTarget;
    if (!actionId) return;
    // conflict check: yeh combination kisi AUR action ke paas hai to wahan se hata do
    // (naya assignment jeet gaya — purana action us key se mehroom)
    Object.keys(kbBindings).forEach(id => {
        if (id === actionId) return;
        const ks = kbBindings[id].keys || [];
        kbBindings[id].keys = ks.filter(k => !(k.code === code && !!k.ctrl === !!ctrl && !!k.shift === !!shift));
    });
    // ADD (replace nahi!) — ek action par multiple keys (max 4)
    const keys = kbBindings[actionId].keys || [];
    const dup = keys.some(k => k.code === code && !!k.ctrl === !!ctrl && !!k.shift === !!shift);
    if (!dup) {
        keys.push({ code, ctrl: !!ctrl, shift: !!shift });
        if (keys.length > 4) keys.shift();
    }
    kbBindings[actionId] = { keys };
    kbCaptureTarget = null;
    kbSaveBindings();
    kbRenderPanel();
}

// ---- UI panel ----
// Har action: label + assigned-keys CHIPS (right-click = remove) + "+ key" add-button
function kbRenderPanel() {
    const list = document.getElementById("kbActionList");
    if (!list) return;
    list.innerHTML = "";
    Object.keys(KB_ACTIONS).forEach(actionId => {
        const row = document.createElement("div");
        row.className = "kb-action-row";

        const label = document.createElement("span");
        label.className = "kb-action-label";
        label.textContent = KB_ACTIONS[actionId].label;

        const keysWrap = document.createElement("span");
        keysWrap.className = "kb-keys-wrap";

        const keys = (kbBindings[actionId] && kbBindings[actionId].keys) || [];
        if (!keys.length) {
            const none = document.createElement("span");
            none.className = "kb-key-chip empty";
            none.textContent = "not set";
            keysWrap.appendChild(none);
        }
        keys.forEach((k, idx) => {
            const chip = document.createElement("button");
            chip.type = "button";
            chip.className = "kb-key-chip";
            chip.title = "Right-click se ye key hatao";
            chip.textContent = kbBindingLabel(k);
            chip.addEventListener("contextmenu", (ev) => {
                ev.preventDefault();
                kbBindings[actionId].keys.splice(idx, 1);
                kbSaveBindings();
                kbRenderPanel();
            });
            keysWrap.appendChild(chip);
        });

        const addBtn = document.createElement("button");
        addBtn.type = "button";
        addBtn.className = "kb-key-add" + (kbCaptureTarget === actionId ? " capturing" : "");
        addBtn.setAttribute("data-kb-capture", actionId);
        addBtn.textContent = (kbCaptureTarget === actionId) ? "key dabao..." : "+ key";
        addBtn.title = "Nayi key assign karo (ek action par 4 tak) — purani key nahi mitegi";
        addBtn.addEventListener("click", () => kbStartCapture(actionId));

        row.appendChild(label);
        row.appendChild(keysWrap);
        row.appendChild(addBtn);
        list.appendChild(row);
    });
}

function kbTogglePanel() {
    const panel = document.getElementById("keybindPanel");
    if (!panel) return;
    panel.classList.toggle("open");
    if (panel.classList.contains("open")) kbRenderPanel();
    else kbCancelCapture();
}

function kbInit() {
    kbLoadBindings();
    window.addEventListener("keydown", kbHandleKeydown, true);   // capture-phase: app se pehle
    window.addEventListener("keyup", kbHandleSpaceRepeat, false);
    const openBtn = document.getElementById("keybindsBtn");
    if (openBtn) openBtn.addEventListener("click", kbTogglePanel);
    const closeBtn = document.getElementById("kbCloseBtn");
    if (closeBtn) closeBtn.addEventListener("click", kbTogglePanel);
    const resetBtn = document.getElementById("kbResetBtn");
    if (resetBtn) resetBtn.addEventListener("click", kbResetToDefaults);
}

// auto-init (script app.js ke baad load hoti hai)
if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", kbInit);
} else {
    kbInit();
}