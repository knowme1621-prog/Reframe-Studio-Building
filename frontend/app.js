const fileInput = document.getElementById("fileInput");
const videoList = document.getElementById("videoList");
const mainPlayer = document.getElementById("mainPlayer");
const videoInfo = document.getElementById("videoInfo");
const playPauseBtn = document.getElementById("playPauseBtn");

let uploadedVideos = [];

fileInput.addEventListener("change", async (e) => {
    const files = Array.from(e.target.files);
    for (const file of files) {
        await uploadVideo(file);
    }
});

async function uploadVideo(file) {
    const formData = new FormData();
    formData.append("file", file);

    try {
        const res = await fetch("/upload", {
            method: "POST",
            body: formData,
        });
        const data = await res.json();

        if (data.error) {
            alert("Upload failed: " + data.error);
            return;
        }

        uploadedVideos.push(data);
        renderVideoList();
    } catch (err) {
        alert("Upload error: " + err);
    }
}

function renderVideoList() {
    videoList.innerHTML = "";
    uploadedVideos.forEach((v) => {
        const item = document.createElement("div");
        item.className = "video-item";
        item.textContent = v.original_name;
        item.draggable = true;

        item.addEventListener("click", () => selectVideo(v));

        item.addEventListener("dragstart", (e) => {
            e.dataTransfer.setData("text/plain", v.saved_name);
            // S2 DROP: stack-2 ki Video row apni ALAG file ke liye ye format check karti hai
            try { e.dataTransfer.setData("application/x-reframe-video", v.saved_name); } catch (err) {}
        });

        videoList.appendChild(item);
    });
}

async function selectVideo(v) {
    mainPlayer.src = `/video/${v.saved_name}`;
    videoInfo.textContent = `${v.original_name} | ${v.width}x${v.height} | ${v.duration.toFixed(1)}s | ${v.fps.toFixed(1)} fps`;

    document.querySelectorAll(".video-item").forEach((el) => el.classList.remove("active"));
    const items = document.querySelectorAll(".video-item");
    uploadedVideos.forEach((vid, idx) => {
        if (vid.saved_name === v.saved_name) {
            items[idx].classList.add("active");
        }
    });

    await initTimeline(v);
    initCropEditor(mainPlayer);

    playPauseBtn.textContent = "▶";
}

// Play/Pause ab mainPlayer ko seedha control nahi karta — timeline.js ka virtual
// playback engine (startPlayback/pausePlayback) drive karta hai, jo videoClips /
// audioLanes arrays ke hisaab se decide karta hai kya dikhna/sunayi dena chahiye.
function togglePlay() {
    if (typeof isPlaying !== "undefined" && isPlaying) {
        pausePlayback();
        playPauseBtn.textContent = "▶";
    } else {
        startPlayback();
        playPauseBtn.textContent = "⏸";
    }
}

// global (keybindings.js Num5/Space aur stopPlayback use karte hain)
window.togglePlay = togglePlay;

playPauseBtn.addEventListener("click", togglePlay);

const mediaBin = document.getElementById("mediaBin");
const mediaBinToggle = document.getElementById("mediaBinToggle");

mediaBinToggle.addEventListener("click", () => {
    mediaBin.classList.toggle("collapsed");
    mediaBin.classList.toggle("expanded");

    // poora left-column bhi narrow ho jaye (warna khali 240px strip reh jati hai)
    const leftCol = document.querySelector(".left-column");
    if (leftCol) leftCol.classList.toggle("bin-collapsed", mediaBin.classList.contains("collapsed"));

    // FIX: media bin collapse/expand par Captions panel ko bhi saath fold karo —
    // pehle media bin to chhota ho jata tha lekin neeche wali Captions panel
    // khuli rehti thi (column ka sara space kha jati thi)
    const cp = document.getElementById("captionsPanel");
    const cpBody = document.getElementById("cpBody");
    const cpCollapse = document.getElementById("cpCollapse");
    if (mediaBin.classList.contains("collapsed")) {
        if (cp) cp.classList.add("cp-hidden");
        if (cpBody) cpBody.style.display = "none";
        if (cpCollapse) cpCollapse.textContent = "▸";
    } else {
        if (cp) cp.classList.remove("cp-hidden");
        if (cpBody) cpBody.style.display = "";
        if (cpCollapse) cpCollapse.textContent = "▾";
    }
});

const dropZone = document.querySelector(".center-column");

dropZone.addEventListener("dragover", (e) => {
    e.preventDefault();
    dropZone.classList.add("drag-over");
});

dropZone.addEventListener("dragleave", () => {
    dropZone.classList.remove("drag-over");
});

dropZone.addEventListener("drop", (e) => {
    e.preventDefault();
    dropZone.classList.remove("drag-over");
    const savedName = e.dataTransfer.getData("text/plain");
    const video = uploadedVideos.find((v) => v.saved_name === savedName);
    if (video) {
        selectVideo(video);
    }
});

// ===== JUMP TO TIME (Start / End inputs neeche player ke) =====
// Accepts "mm:ss", "mm:ss.ms", ya sirf seconds jese "12.5"
function parseTimeInput(str) {
    if (!str) return null;
    str = str.trim();
    if (!str) return null;

    let seconds;
    if (str.includes(":")) {
        const parts = str.split(":");
        const mins = parseFloat(parts[0]) || 0;
        const secs = parseFloat(parts[1]) || 0;
        seconds = mins * 60 + secs;
    } else {
        seconds = parseFloat(str);
    }
    return isNaN(seconds) ? null : seconds;
}

function jumpToInputValue(inputEl) {
    const t = parseTimeInput(inputEl.value);
    if (t === null) return;
    const clamped = Math.max(0, Math.min(t, timelineDuration || t));
    seekToTime(clamped);
}

const jumpStartInput = document.getElementById("jumpStartInput");
const jumpEndInput = document.getElementById("jumpEndInput");
const jumpStartBtn = document.getElementById("jumpStartBtn");
const jumpEndBtn = document.getElementById("jumpEndBtn");

jumpStartBtn.addEventListener("click", () => jumpToInputValue(jumpStartInput));
jumpEndBtn.addEventListener("click", () => jumpToInputValue(jumpEndInput));

[jumpStartInput, jumpEndInput].forEach((inp) => {
    inp.addEventListener("keydown", (e) => {
        if (e.key === "Enter") {
            e.preventDefault();
            jumpToInputValue(inp);
        }
    });
});
