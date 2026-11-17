// ===== COLOR GRADING (Phase 1 — Filmora-style basic sliders) =====
// GLOBAL grade (poori video par) — Phase 2 mein per-clip aayega.
//
// Preview: canvas 2D ka `filter` (brightness/contrast/saturate) + temperature
// ke liye warm/cool overlay + vignette radial-gradient. Sharpen preview mein
// skip (canvas equivalent nahi — sirf export burn hota hai, warna hint dikhata hai).
// Export: export_engine.py ka grade_frame() — same params ka Python mirror.
//
// Persist: persistTimelineState payload mein colorGrade (timeline.js jodta hai)
// + project save/load sab automatically cover.
//
// UI: 🎨 Grade button (topbar, Spotlights ke sath) -> panel preview-ke-neeche
// spotlight-ctrls ke style mein. Presets + Before/After hold-toggle.

const CG_DEFAULTS = {
    brightness: 0,   // -100..100  (%)
    contrast: 0,     // -100..100  (%)
    saturation: 0,   // -100..100  (%)
    temperature: 0,  // -100(cool)..100(warm)
    sharpen: 0,      // 0..100 (sirf export burn — preview hint)
    vignette: 0,     // 0..100
};

let colorGrade = { ...CG_DEFAULTS };
let cgBeforeAfter = false; // Before/After hold (button press ke dauran)

const CG_PRESETS = {
    none:      { label: "Original",      v: {} },
    cinematic: { label: "Cinematic",     v: { contrast: 15, saturation: -10, temperature: -12, vignette: 35 } },
    vivid:     { label: "Vivid",         v: { contrast: 12, saturation: 28, brightness: 4 } },
    warm:      { label: "Warm Sunset",   v: { temperature: 32, saturation: 10, brightness: 3 } },
    cold:      { label: "Cold Blue",     v: { temperature: -32, contrast: 8, saturation: -6 } },
    bw:        { label: "Black & White", v: { saturation: -100, contrast: 14 } },
    vintage:   { label: "Vintage",       v: { contrast: -8, saturation: -22, temperature: 18, vignette: 45 } },
    fade:      { label: "Faded Film",    v: { contrast: -14, saturation: -12, brightness: 6, vignette: 20 } },
    punchy:    { label: "Punchy",        v: { contrast: 24, saturation: 18, sharpen: 30 } },
    night:     { label: "Night Mood",    v: { brightness: -18, contrast: 10, temperature: -18, vignette: 55 } },
};

function cgIsDefault() {
    return Object.keys(CG_DEFAULTS).every((k) => (colorGrade[k] || 0) === CG_DEFAULTS[k]);
}

function cgApply(presetKey) {
    const p = CG_PRESETS[presetKey];
    if (!p) return;
    colorGrade = { ...CG_DEFAULTS, ...p.v };
    cgSyncUI();
    if (typeof persistTimelineState === "function") persistTimelineState();
}

function cgReset() {
    colorGrade = { ...CG_DEFAULTS };
    cgSyncUI();
    if (typeof persistTimelineState === "function") persistTimelineState();
}

// canvas filter string (drawPlayerCanvas/drawPreview grade ON ho to ye lagayenge)
function cgCanvasFilter() {
    if (cgBeforeAfter || cgIsDefault()) return "none";
    const f = [];
    f.push(`brightness(${(100 + colorGrade.brightness) / 100})`);
    f.push(`contrast(${(100 + colorGrade.contrast) / 100})`);
    f.push(`saturate(${(100 + colorGrade.saturation) / 100})`);
    return f.join(" ");
}

function cgIsTemperature() { return !cgBeforeAfter && colorGrade.temperature !== 0; }
function cgIsVignette() { return !cgBeforeAfter && colorGrade.vignette !== 0; }

// temperature overlay — draw ke BAAD source-over se (warm = orange, cool = blue)
function cgApplyTemperatureOverlay(ctx, w, h) {
    if (!cgIsTemperature()) return;
    const t = colorGrade.temperature;
    ctx.save();
    ctx.globalCompositeOperation = "soft-light";
    ctx.globalAlpha = Math.min(0.55, Math.abs(t) / 100 * 0.55);
    ctx.fillStyle = t > 0 ? "#ff9a3c" : "#3ca8ff";
    ctx.fillRect(0, 0, w, h);
    ctx.restore();
}

// vignette — radial gradient (center transparent -> edges dark)
function cgApplyVignette(ctx, w, h) {
    if (!cgIsVignette()) return;
    const strength = colorGrade.vignette / 100;
    const grad = ctx.createRadialGradient(w / 2, h / 2, Math.min(w, h) * 0.42, w / 2, h / 2, Math.max(w, h) * 0.75);
    grad.addColorStop(0, "rgba(0,0,0,0)");
    grad.addColorStop(1, `rgba(0,0,0,${(0.75 * strength).toFixed(3)})`);
    ctx.save();
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, w, h);
    ctx.restore();
}

// ===== UI =====
function cgSyncUI() {
    const panel = document.getElementById("cgPanel");
    if (!panel) return;
    ["brightness", "contrast", "saturation", "temperature", "sharpen", "vignette"].forEach((k) => {
        const el = document.getElementById("cg_" + k);
        const val = document.getElementById("cg_" + k + "Val");
        if (el) el.value = colorGrade[k] || 0;
        if (val) val.textContent = (colorGrade[k] || 0) + "%";
    });
    // active preset highlight (exact-match)
    document.querySelectorAll(".cg-preset-btn").forEach((b) => {
        const v = CG_PRESETS[b.dataset.preset] ? { ...CG_DEFAULTS, ...CG_PRESETS[b.dataset.preset].v } : null;
        const isMatch = v && Object.keys(CG_DEFAULTS).every((k) => (colorGrade[k] || 0) === (v[k] || 0));
        b.classList.toggle("active", !!isMatch);
    });
}

function initColorGradeUI() {
    const btn = document.getElementById("cgToggleBtn");
    const panel = document.getElementById("cgPanel");
    if (!btn || !panel) return;

    btn.addEventListener("click", () => {
        panel.style.display = panel.style.display === "block" ? "none" : "block";
    });
    const closeBtn = document.getElementById("cgCloseBtn");
    if (closeBtn) closeBtn.addEventListener("click", () => { panel.style.display = "none"; });

    ["brightness", "contrast", "saturation", "temperature", "sharpen", "vignette"].forEach((k) => {
        const el = document.getElementById("cg_" + k);
        if (!el) return;
        el.addEventListener("input", () => {
            colorGrade[k] = parseFloat(el.value);
            const val = document.getElementById("cg_" + k + "Val");
            if (val) val.textContent = el.value + "%";
            document.querySelectorAll(".cg-preset-btn").forEach((b) => b.classList.remove("active"));
            if (typeof persistTimelineState === "function") persistTimelineState();
        });
    });

    document.querySelectorAll(".cg-preset-btn").forEach((b) => {
        b.addEventListener("click", () => cgApply(b.dataset.preset));
    });

    const resetBtn = document.getElementById("cgResetBtn");
    if (resetBtn) resetBtn.addEventListener("click", cgReset);

    // Before/After: HOLD (mousedown/up + touch) — chhorte hi wapis current grade
    const baBtn = document.getElementById("cgBeforeAfterBtn");
    if (baBtn) {
        const on = () => { cgBeforeAfter = true; };
        const off = () => { cgBeforeAfter = false; };
        baBtn.addEventListener("mousedown", on);
        baBtn.addEventListener("mouseup", off);
        baBtn.addEventListener("mouseleave", off);
        baBtn.addEventListener("touchstart", on, { passive: true });
        baBtn.addEventListener("touchend", off);
    }
}

// color_grade.js load hote hi UI init (buttons HTML mein already hain)
initColorGradeUI();
