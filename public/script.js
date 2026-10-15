const urlInput = document.getElementById("urlInput");
const destinationInput = document.getElementById("destinationInput");
const convertButton = document.getElementById("convertButton");
const browseFolderButton = document.getElementById("browseFolderButton");
const statusBox = document.getElementById("status");
const resultBox = document.getElementById("result");
const resultList = document.getElementById("resultList");
const typeInputs = document.querySelectorAll('input[name="type"]');
const progressCard = document.createElement("div");
progressCard.className = "progress-card hidden";
progressCard.innerHTML = `
  <div class="progress-header">
    <span id="progressLabel">Preparing</span>
    <span id="progressPercentage">0%</span>
  </div>
  <div class="progress-bar">
    <div id="progressFill" class="progress-fill"></div>
  </div>
  <div id="progressStatus" class="progress-status">Waiting</div>
`;
statusBox.parentNode.insertBefore(progressCard, statusBox.nextSibling);

const progressLabel = document.getElementById("progressLabel");
const progressPercentage = document.getElementById("progressPercentage");
const progressFill = document.getElementById("progressFill");
const progressStatus = document.getElementById("progressStatus");

const defaultDestination = "C:\\Users\\YourName\\Downloads\\MusicConverter";
destinationInput.value = defaultDestination;

browseFolderButton.addEventListener("click", async () => {
  const customPath = window.prompt(
    "Enter the destination folder path:",
    destinationInput.value || defaultDestination,
  );

  if (customPath && customPath.trim()) {
    destinationInput.value = customPath.trim();
  }
});

typeInputs.forEach((input) => {
  input.addEventListener("change", () => {
    urlInput.value = "";
    resultBox.classList.add("hidden");
    resultList.innerHTML = "";
    setStatus("");
    hideProgress();
  });
});

convertButton.addEventListener("click", async () => {
  const url = urlInput.value.trim();
  const type = document.querySelector('input[name="type"]:checked').value;
  const destinationPath = destinationInput.value.trim();

  if (!url) {
    setStatus("Please enter a valid YouTube URL.", true);
    return;
  }

  setStatus("Processing...");
  convertButton.disabled = true;
  resultBox.classList.add("hidden");
  resultList.innerHTML = "";
  showProgress();

  try {
    const response = await fetch("/api/convert", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ url, type, destinationPath }),
    });

    const data = await response.json();

    if (!response.ok) {
      throw new Error(
        data.error || "An error occurred while processing your request.",
      );
    }

    const sessionId = data.sessionId;
    await pollProgress(sessionId, type);

    urlInput.value = "";
  } catch (error) {
    setStatus(error.message, true);
  } finally {
    convertButton.disabled = false;
  }
});

async function pollProgress(sessionId, type) {
  const maxAttempts = 3000;

  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    const response = await fetch(`/api/progress/${sessionId}`);

    if (!response.ok) {
      await new Promise((resolve) => setTimeout(resolve, 1000));
      continue;
    }

    const progressData = await response.json();
    updateProgressUI(progressData);

    if (progressData.completed) {
      const files = Array.isArray(progressData.result?.fileNames)
        ? progressData.result.fileNames
        : progressData.result?.fileName
          ? [progressData.result.fileName]
          : [];

      resultList.innerHTML = "";
      files.forEach((file) => {
        const listItem = document.createElement("li");
        listItem.textContent = file;
        resultList.appendChild(listItem);
      });

      resultBox.classList.remove("hidden");
      setStatus(
        progressData.result?.message || "Playlist finished successfully.",
        false,
        true,
      );
      hideProgress();
      return;
    }

    if (progressData.error) {
      setStatus(progressData.error, true);
      hideProgress();
      return;
    }

    await new Promise((resolve) => setTimeout(resolve, 1000));
  }

  setStatus("The download is taking longer than expected.", false, true);
  hideProgress();
}

function updateProgressUI(progressData) {
  const percent = Math.max(
    0,
    Math.min(100, Number(progressData.progress || 0)),
  );
  const currentIndex = Number(progressData.currentIndex || 0);
  const total = Number(progressData.total || 1);
  const trackName = progressData.currentTrack || "Preparing";

  const label =
    total > 1 ? `${currentIndex}/${total} - ${trackName}` : trackName;

  progressLabel.textContent = label;
  progressPercentage.textContent = `${Math.round(percent)}%`;
  progressFill.style.width = `${percent}%`;
  progressStatus.textContent = progressData.completed
    ? "Completed"
    : `${progressData.status || "Processing"}`;

  if (progressData.completed) {
    progressFill.style.background = "linear-gradient(90deg, #22c55e, #86efac)";
    return;
  }

  progressFill.style.background = "linear-gradient(90deg, #38bdf8, #8b5cf6)";
}

function showProgress() {
  progressCard.classList.remove("hidden");
}

function hideProgress() {
  progressCard.classList.add("hidden");
  progressFill.style.width = "0%";
  progressPercentage.textContent = "0%";
  progressLabel.textContent = "Preparing";
  progressStatus.textContent = "Waiting";
}

function setStatus(message, isError = false, isSuccess = false) {
  statusBox.textContent = message;
  statusBox.classList.remove("success", "error");

  if (isError) {
    statusBox.classList.add("error");
  }

  if (isSuccess) {
    statusBox.classList.add("success");
  }
}
