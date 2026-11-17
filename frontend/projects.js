// ============================================================================
// PROJECTS — Save / Load / Rename / Delete system
// Main folder ke andar `projects/` ban-ta hai. Har project folder mein:
//   project.json + media/ (videos ki SAFE copies + timeline JSONs)
// Uploads session-only hain (app close par delete), isliye save par media copy
// hoti hai aur restore par wapis uploads/ mein aati hai.
// ============================================================================

let pjOpen = false;

function pjEl(id) { return document.getElementById(id); }

function pjShowHint(msg, isErr) {
    const h = pjEl("pjHint");
    if (!h) return;
    h.textContent = msg || "";
    h.classList.toggle("error", !!isErr);
    if (msg) setTimeout(() => { if (h.textContent === msg) h.textContent = ""; }, 4000);
}

async function pjListProjects() {
    try {
        const res = await fetch("/projects");
        const data = await res.json();
        return data.projects || [];
    } catch (e) { return []; }
}

async function pjRenderList() {
    const list = pjEl("pjList");
    if (!list) return;
    const projects = await pjListProjects();
    list.innerHTML = "";

    if (!projects.length) {
        const empty = document.createElement("div");
        empty.className = "pj-empty";
        empty.textContent = "Koi project saved nahi hai — upar naam likh kar Save dabao.";
        list.appendChild(empty);
        return;
    }

    projects.forEach(p => {
        const row = document.createElement("div");
        row.className = "pj-row";

        const info = document.createElement("div");
        info.className = "pj-row-info";
        const nm = document.createElement("div");
        nm.className = "pj-row-name";
        nm.textContent = p.name;
        const sub = document.createElement("div");
        sub.className = "pj-row-sub";
        sub.textContent = `${p.video_count || 0} video(s) • ${p.saved_at || ""}`;
        info.appendChild(nm);
        info.appendChild(sub);

        const actions = document.createElement("div");
        actions.className = "pj-row-actions";

        const openB = document.createElement("button");
        openB.className = "pj-mini-btn pj-open";
        openB.textContent = "Open";
        openB.title = "Is project ko kholo (media wapis load hoti hai)";
        openB.addEventListener("click", () => pjOpenProject(p.name));

        const renB = document.createElement("button");
        renB.className = "pj-mini-btn";
        renB.textContent = "Rename";
        renB.addEventListener("click", async () => {
            const nn = prompt("Naya naam:", p.name);
            if (!nn || nn.trim() === "" || nn === p.name) return;
            const res = await fetch(`/projects/${encodeURIComponent(p.name)}/rename`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ new_name: nn.trim() })
            });
            const d = await res.json().catch(() => ({}));
            if (d.error) { pjShowHint("Rename fail: " + d.error, true); return; }
            pjShowHint(`Project rename ho gaya: ${d.name}`);
            pjRenderList();
        });

        const delB = document.createElement("button");
        delB.className = "pj-mini-btn pj-danger";
        delB.textContent = "Del";
        delB.title = "Project delete (media copies bhi)";
        delB.addEventListener("click", async () => {
            if (!confirm(`"${p.name}" delete kar dein? Media copies bhi delete hongi.`)) return;
            await fetch(`/projects/${encodeURIComponent(p.name)}`, { method: "DELETE" });
            pjShowHint("Project delete ho gaya");
            pjRenderList();
        });

        actions.appendChild(openB);
        actions.appendChild(renB);
        actions.appendChild(delB);
        row.appendChild(info);
        row.appendChild(actions);
        list.appendChild(row);
    });
}

async function pjSaveProject(name) {
    name = (name || "").trim();
    if (!name) { pjShowHint("Pehle project ka naam likho", true); return; }
    if (typeof uploadedVideos === "undefined" || !uploadedVideos.length) {
        pjShowHint("Koi video loaded nahi hai — pehle media import karo", true);
        return;
    }
    const active = (typeof currentVideoRef !== "undefined" && currentVideoRef)
        ? currentVideoRef.saved_name : null;
    // timeline state ko pehle flush karo (persistTimelineState async hai)
    if (typeof persistTimelineState === "function") {
        try { await persistTimelineState(); } catch (e) {}
    }
    try {
        const res = await fetch(`/projects/${encodeURIComponent(name)}/save`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                videos: uploadedVideos,
                active_saved_name: active
            })
        });
        const d = await res.json().catch(() => ({}));
        if (d.error) { pjShowHint("Save fail: " + d.error, true); return; }
        pjShowHint(`Project "${d.name}" save ho gaya (${d.videos} video, media copy bhi)`);
        pjRenderList();
    } catch (e) {
        pjShowHint("Save fail: " + e, true);
    }
}

async function pjOpenProject(name) {
    try {
        const res = await fetch(`/projects/${encodeURIComponent(name)}/restore`, { method: "POST" });
        const d = await res.json().catch(() => ({}));
        if (d.error) { pjShowHint("Open fail: " + d.error, true); return; }
        if (!d.videos || !d.videos.length) {
            pjShowHint("Project khali hai (media missing)", true);
            return;
        }
        // frontend state refresh
        if (typeof uploadedVideos !== "undefined") {
            uploadedVideos.length = 0;
            d.videos.forEach(v => uploadedVideos.push(v));
        }
        if (typeof renderVideoList === "function") renderVideoList();
        const activeName = d.active_saved_name || (d.videos[0] && d.videos[0].saved_name);
        const active = d.videos.find(v => v.saved_name === activeName) || d.videos[0];
        if (active && typeof selectVideo === "function") await selectVideo(active);
        pjShowHint(`Project "${name}" khul gaya (${d.videos.length} video)`);
        pjToggle(); // panel band kar do
    } catch (e) {
        pjShowHint("Open fail: " + e, true);
    }
}

function pjToggle() {
    const panel = pjEl("projectsPanel");
    if (!panel) return;
    pjOpen = !pjOpen;
    panel.classList.toggle("open", pjOpen);
    if (pjOpen) pjRenderList();
}

// auto-init
(function pjInit() {
    function wire() {
        const btn = pjEl("pjToggleBtn");
        if (btn) btn.addEventListener("click", pjToggle);
        const closeB = pjEl("pjCloseBtn");
        if (closeB) closeB.addEventListener("click", pjToggle);
        const saveB = pjEl("pjSaveBtn");
        if (saveB) saveB.addEventListener("click", () => pjSaveProject(pjEl("pjNameInput") ? pjEl("pjNameInput").value : ""));
        const input = pjEl("pjNameInput");
        if (input) input.addEventListener("keydown", (e) => {
            if (e.key === "Enter") pjSaveProject(input.value);
        });
    }
    if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", wire);
    else wire();
})();

// saveCurrentProject global (Ctrl+S keybinding isi ko call karta hai)
window.saveCurrentProject = function () {
    if (!pjOpen) pjToggle();
    const input = pjEl("pjNameInput");
    if (input && !input.value.trim()) {
        input.focus();
        pjShowHint("Project ka naam likh kar Enter dabao (ya Save dabao)", false);
    } else if (input) {
        pjSaveProject(input.value);
    }
};