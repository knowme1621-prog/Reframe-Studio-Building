// ===== EXPORT MODAL =====

let exportPollTimer = null;

function openExportModal() {
    if (!currentVideoRef) { alert("Pehle koi video import/select karen."); return; }
    document.getElementById("exportModalOverlay").style.display = "flex";
    document.getElementById("exportProgressWrap").style.display = "none";
    document.getElementById("exportResultWrap").style.display = "none";
    document.getElementById("exportStartBtn").style.display = "inline-block";
    document.getElementById("exportStartBtn").disabled = false;
}

function closeExportModal() {
    document.getElementById("exportModalOverlay").style.display = "none";
    if (exportPollTimer) { clearInterval(exportPollTimer); exportPollTimer = null; }
}

function getSelectedRadioValue(name) {
    const el = document.querySelector(`input[name="${name}"]:checked`);
    return el ? el.value : null;
}

async function startExport() {
    const quality = getSelectedRadioValue("exportQuality") || "720p";
    const codec = getSelectedRadioValue("exportCodec") || "h264";

    const startBtn = document.getElementById("exportStartBtn");
    startBtn.disabled = true;
    startBtn.textContent = "Starting…";

    // pehle timeline save karo, taake export bilkul latest state par ho
    if (typeof persistTimelineState === "function") {
        await persistTimelineState();
    }

    try {
        const res = await fetch(`/video/${currentVideoRef.saved_name}/export`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ quality, codec }),
        });
        const data = await res.json();
        if (data.error) { alert("Export start nahi ho saka: " + data.error); resetExportStartBtn(); return; }

        startBtn.style.display = "none";
        document.getElementById("exportProgressWrap").style.display = "block";
        pollExportStatus(data.job_id);
    } catch (err) {
        alert("Export error: " + err);
        resetExportStartBtn();
    }
}

function resetExportStartBtn() {
    const startBtn = document.getElementById("exportStartBtn");
    startBtn.disabled = false;
    startBtn.textContent = "Start Export";
}

function pollExportStatus(jobId) {
    const fill = document.getElementById("exportProgressFill");
    const label = document.getElementById("exportProgressLabel");

    exportPollTimer = setInterval(async () => {
        try {
            const res = await fetch(`/export_status/${jobId}`);
            const job = await res.json();
            if (job.error) {
                clearInterval(exportPollTimer);
                alert("Export status error: " + job.error);
                closeExportModal();
                return;
            }

            const pct = Math.round((job.progress || 0) * 100);
            fill.style.width = `${pct}%`;

            if (job.status === "running") {
                label.textContent = `Rendering… ${pct}%`;
            } else if (job.status === "done") {
                clearInterval(exportPollTimer);
                label.textContent = "Done! Export folder khud khul gaya hai.";
                document.getElementById("exportProgressWrap").style.display = "none";
                document.getElementById("exportResultWrap").style.display = "block";
                const link = document.getElementById("exportDownloadLink");
                link.href = `/exports/${job.filename}`;
                link.setAttribute("download", job.filename);
                link.textContent = "⬇ Download Video (agar folder na khula ho)";
            } else if (job.status === "error") {
                clearInterval(exportPollTimer);
                alert("Export fail ho gaya: " + (job.error || "unknown error"));
                closeExportModal();
            }
        } catch (err) {
            clearInterval(exportPollTimer);
            alert("Export status check error: " + err);
        }
    }, 1000);
}

document.addEventListener("DOMContentLoaded", () => {
    const exportBtn = document.getElementById("exportBtn");
    if (exportBtn) exportBtn.addEventListener("click", openExportModal);

    const cancelBtn = document.getElementById("exportCancelBtn");
    if (cancelBtn) cancelBtn.addEventListener("click", closeExportModal);

    const startBtn = document.getElementById("exportStartBtn");
    if (startBtn) startBtn.addEventListener("click", startExport);
});
