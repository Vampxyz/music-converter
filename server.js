const express = require("express");
const path = require("path");
const fs = require("fs");
const os = require("os");
const youtubedl = require("youtube-dl-exec");
const ffmpegPath = require("ffmpeg-static");
const ffprobeStatic = require("ffprobe-static");

const app = express();
const defaultPort = Number(process.env.PORT) || 3000;
const defaultDownloadsDir = path.join(
  os.homedir(),
  "Downloads",
  "MusicConverter",
);
const ffmpegDir = path.dirname(ffmpegPath);
const ffprobeTarget = path.join(ffmpegDir, "ffprobe.exe");
const progressStore = new Map();

const ensureFfmpegTools = () => {
  if (!fs.existsSync(ffprobeTarget) && ffprobeStatic && ffprobeStatic.path) {
    fs.copyFileSync(ffprobeStatic.path, ffprobeTarget);
  }

  const currentPath = process.env.PATH || "";
  const paths = currentPath.split(path.delimiter).filter(Boolean);

  if (!paths.includes(ffmpegDir)) {
    process.env.PATH = `${ffmpegDir}${path.delimiter}${currentPath}`;
  }
};

ensureFfmpegTools();

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, "public")));

const resolveDestinationDirectory = (destinationPath) => {
  const baseDirectory =
    destinationPath && destinationPath.trim()
      ? destinationPath.trim()
      : defaultDownloadsDir;

  const normalizedDirectory = path.normalize(baseDirectory);

  if (!fs.existsSync(normalizedDirectory)) {
    fs.mkdirSync(normalizedDirectory, { recursive: true });
  }

  return normalizedDirectory;
};

const createProgressSession = (name, total = 1) => {
  const sessionId = `${Date.now()}-${Math.random().toString(16).slice(2)}`;

  progressStore.set(sessionId, {
    sessionId,
    status: "processing",
    name,
    progress: 0,
    currentTrack: "Preparing",
    currentIndex: 0,
    total,
    completed: false,
    error: null,
    result: {
      fileNames: [],
    },
  });

  return sessionId;
};

const updateProgress = (sessionId, nextState) => {
  const current = progressStore.get(sessionId);

  if (!current) {
    return;
  }

  progressStore.set(sessionId, {
    ...current,
    ...nextState,
  });
};

app.get("/api/health", (req, res) => {
  res.json({ status: "ok" });
});

app.get("/api/progress/:sessionId", (req, res) => {
  const session = progressStore.get(req.params.sessionId);

  if (!session) {
    return res.status(404).json({ error: "Progress session not found." });
  }

  return res.json(session);
});

app.post("/api/convert", async (req, res) => {
  const { url, type = "single", destinationPath } = req.body;

  if (!url || !url.trim()) {
    return res.status(400).json({ error: "YouTube URL is required." });
  }

  try {
    const targetDirectory = resolveDestinationDirectory(destinationPath);
    const sessionId = createProgressSession(
      type === "playlist" ? "Playlist" : "Single video",
      type === "playlist" ? 1 : 1,
    );

    res.json({
      status: "started",
      sessionId,
      targetDirectory,
    });

    if (type === "playlist") {
      processPlaylist(url, targetDirectory, sessionId).catch((error) => {
        updateProgress(sessionId, {
          status: "error",
          error: error.message || "Playlist conversion failed.",
          progress: 0,
          completed: false,
        });
      });
      return;
    }

    processSingleTrack(url, null, targetDirectory, sessionId).catch((error) => {
      updateProgress(sessionId, {
        status: "error",
        error: error.message || "Video conversion failed.",
        progress: 0,
        completed: false,
      });
    });
  } catch (error) {
    return res
      .status(500)
      .json({ error: error.message || "Conversion failed." });
  }
});

async function processSingleTrack(
  url,
  customTitle = null,
  destinationDirectory = defaultDownloadsDir,
  sessionId = null,
  trackIndex = null,
  totalTracks = null,
) {
  const sourceTitle = customTitle || (await getVideoTitle(url));
  const title = sanitizeFileName(sourceTitle) || "track";
  const outputBase = path.join(destinationDirectory, title);
  const mp3Path = `${outputBase}.mp3`;

  if (sessionId) {
    updateProgress(sessionId, {
      currentTrack: title,
      currentIndex: trackIndex ?? 1,
      total: totalTracks ?? 1,
      progress: 0,
      status: "processing",
    });
  }

  if (fs.existsSync(mp3Path)) {
    fs.unlinkSync(mp3Path);
  }

  const result = await runYoutubeDlWithProgress(
    url,
    {
      output: `${outputBase}.%(ext)s`,
      extractAudio: true,
      audioFormat: "mp3",
      audioQuality: "0",
      noWarnings: true,
      noCheckCertificate: true,
      noPlaylist: true,
      ffmpegLocation: ffmpegDir,
    },
    sessionId,
    title,
  );

  const finalFile = findMatchingMp3(destinationDirectory, title);

  if (!finalFile) {
    throw new Error("The converted MP3 file was not found.");
  }

  const response = {
    message: "Download completed.",
    fileName: path.basename(finalFile),
    filePath: finalFile,
    type: "single",
  };

  if (sessionId) {
    updateProgress(sessionId, {
      status: "processing",
      progress: 100,
      completed: false,
      currentTrack: title,
      currentIndex: trackIndex ?? 1,
      total: totalTracks ?? 1,
    });
  }

  return response;
}

async function processPlaylist(
  url,
  destinationDirectory = defaultDownloadsDir,
  sessionId = null,
) {
  const playlistInfo = await youtubedl(url, {
    dumpSingleJson: true,
    noWarnings: true,
    noCheckCertificate: true,
    flatPlaylist: true,
    ffmpegLocation: ffmpegDir,
  });

  const entries = Array.isArray(playlistInfo.entries)
    ? playlistInfo.entries
    : [];

  if (entries.length === 0) {
    throw new Error("No tracks were found in the playlist.");
  }

  if (sessionId) {
    updateProgress(sessionId, {
      total: entries.length,
      currentIndex: 0,
      progress: 0,
      currentTrack: "Starting playlist",
      status: "processing",
      result: {
        fileNames: [],
      },
    });
  }

  const downloadedFiles = [];

  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index];
    const entryUrl = entry?.url || entry?.webpage_url || entry?.original_url;

    if (!entryUrl) {
      continue;
    }

    const totalSongs = entries.length;
    const trackIndex = index + 1;
    const trackName = sanitizeFileName(entry.title || `Track ${trackIndex}`);

    if (sessionId) {
      updateProgress(sessionId, {
        currentTrack: trackName,
        currentIndex: trackIndex,
        total: totalSongs,
        progress: 0,
        status: "processing",
        result: {
          fileNames: [...downloadedFiles],
        },
      });
    }

    const finalResult = await processSingleTrack(
      entryUrl,
      `${trackName}_${trackIndex}`,
      destinationDirectory,
      sessionId,
      trackIndex,
      totalSongs,
    );

    downloadedFiles.push(finalResult.fileName);

    if (sessionId) {
      updateProgress(sessionId, {
        progress: 100,
        currentTrack: trackName,
        currentIndex: trackIndex,
        total: totalSongs,
        status: "processing",
        result: {
          fileNames: [...downloadedFiles],
        },
      });
    }
  }

  const response = {
    message: `Playlist processed successfully. ${downloadedFiles.length} tracks downloaded.`,
    fileNames: downloadedFiles,
    type: "playlist",
  };

  if (sessionId) {
    updateProgress(sessionId, {
      status: "completed",
      progress: 100,
      completed: true,
      currentIndex: entries.length,
      total: entries.length,
      currentTrack: `${downloadedFiles.length} tracks downloaded`,
      error: null,
      result: {
        fileNames: [...downloadedFiles],
      },
    });
  }

  return response;
}

async function runYoutubeDlWithProgress(url, flags, sessionId, title) {
  const subprocess = youtubedl.exec(url, flags);

  return new Promise((resolve, reject) => {
    let output = "";

    const handleData = (chunk) => {
      const text = chunk.toString();
      output += text;

      const lines = text.split(/\r?\n/);

      for (const line of lines) {
        if (
          !line.includes("[download]") &&
          !line.includes("[ffmpeg]") &&
          !line.includes("[ExtractAudio]")
        ) {
          continue;
        }

        const match = line.match(/(\d+(?:\.\d+)?)%/);

        if (match && sessionId) {
          const percentValue = Number(match[1]);
          updateProgress(sessionId, {
            progress: Math.max(0, Math.min(100, percentValue)),
            currentTrack: title,
          });
        }
      }
    };

    subprocess.stderr.on("data", handleData);
    subprocess.stdout.on("data", handleData);

    subprocess.on("close", (code) => {
      if (code === 0) {
        resolve();
        return;
      }

      reject(new Error(output || "Video download failed."));
    });

    subprocess.on("error", (error) => {
      reject(error);
    });
  });
}

async function getVideoTitle(url) {
  const info = await youtubedl(url, {
    dumpSingleJson: true,
    noWarnings: true,
    noCheckCertificate: true,
    noPlaylist: true,
    ffmpegLocation: ffmpegDir,
  });

  return info.title || "track";
}

function findMatchingMp3(folderPath, title) {
  const files = fs.readdirSync(folderPath);

  for (const file of files) {
    const lowerFile = file.toLowerCase();
    const lowerTitle = title.toLowerCase();

    if (lowerFile.endsWith(".mp3") && lowerFile.includes(lowerTitle)) {
      return path.join(folderPath, file);
    }
  }

  return null;
}

function sanitizeFileName(value) {
  return (
    String(value)
      .replace(/[\\/:*?"<>|]/g, "")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 120) || "track"
  );
}

app.get("*", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

const tryListen = (port) => {
  const server = app.listen(port, () => {
    console.log(`Server running at http://localhost:${port}`);
  });

  server.on("error", (error) => {
    if (error.code === "EADDRINUSE") {
      const nextPort = port + 1;
      if (nextPort <= port + 10) {
        console.log(`Port ${port} is busy. Trying ${nextPort}...`);
        server.close();
        tryListen(nextPort);
        return;
      }

      console.error(`No free port found from ${defaultPort} to ${port + 10}.`);
      process.exit(1);
    }

    throw error;
  });
};

tryListen(defaultPort);
