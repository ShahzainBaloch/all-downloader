const express = require("express");
const { spawn } = require("child_process");
const cors = require("cors");
const path = require("path");

const app = express();
const PORT = process.env.PORT || 4000;

// --- Middleware ---
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

// --- Helper to get video metadata ---
async function getVideoInfo(url) {
    return new Promise((resolve, reject) => {
        const ytProcess = spawn('yt-dlp', ['--dump-single-json', '--no-warnings', url]);
        let stdoutData = '', stderrData = '';
        ytProcess.stdout.on('data', (data) => stdoutData += data);
        ytProcess.stderr.on('data', (data) => stderrData += data);
        ytProcess.on('close', (code) => {
            if (code === 0) {
                try { resolve(JSON.parse(stdoutData)); }
                catch (e) { reject(new Error("Failed to parse video metadata.")); }
            } else {
                reject(new Error(`yt-dlp exited with code ${code}. Error: ${stderrData}`));
            }
        });
        ytProcess.on('error', (err) => reject(err));
    });
}

// --- NEW Helper to process and simplify formats ---
function processFormats(formats) {
    const availableQualities = {
        video: {},
        audio: null
    };

    // Find the best audio-only format
    let bestAudio = null;
    formats
        .filter(f => f.vcodec === 'none' && f.acodec !== 'none' && f.abr)
        .forEach(f => {
            if (!bestAudio || f.abr > bestAudio.abr) {
                bestAudio = f;
            }
        });

    if (bestAudio) {
        availableQualities.audio = {
            label: `${Math.round(bestAudio.abr)}kbps`,
            formatId: bestAudio.format_id,
        };
    }

    // Define standard video resolutions
    const standardResolutions = [1080, 720, 480, 360, 240, 144];

    // Find the best format for each standard resolution
    standardResolutions.forEach(res => {
        let bestFormatForRes = null;
        formats
            // Filter for formats that have both video and audio, and have a height
            .filter(f => f.vcodec !== 'none' && f.acodec !== 'none' && f.height)
            .forEach(f => {
                // Check if the format's height is close to the standard resolution
                if (Math.abs(f.height - res) < 50) { // Allow for some tolerance
                    // If we haven't found a format for this resolution yet, or if this one is better
                    if (!bestFormatForRes || (f.tbr || 0) > (bestFormatForRes.tbr || 0)) {
                        bestFormatForRes = f;
                    }
                }
            });
        
        if (bestFormatForRes) {
            availableQualities.video[res] = {
                label: `${res}p`,
                formatId: bestFormatForRes.format_id,
            };
        }
    });

    return availableQualities;
}

// --- Route to get video info ---
app.post("/info", async (req, res) => {
    const { url } = req.body;
    if (!url) return res.status(400).json({ error: "Please provide a video URL." });

    console.log(`Fetching info for: ${url}`);
    try {
        const metadata = await getVideoInfo(url);
        // Process the formats before sending them to the client
        const processedFormats = processFormats(metadata.formats);
        
        res.json({
            title: metadata.title,
            thumbnail: metadata.thumbnail,
            duration: metadata.duration,
            // Send the clean, processed format list instead of the raw one
            formats: processedFormats,
        });
    } catch (error) {
        console.error("Info fetch error:", error.message);
        res.status(500).json({ error: "Failed to fetch video information." });
    }
});

// --- Route to download video ---
app.post("/download", async (req, res) => {
    const { url, formatId } = req.body;
    if (!url || !formatId) return res.status(400).json({ error: "URL and Format ID are required." });
    
    console.log(`Download request for: ${url} with format: ${formatId}`);
    try {
        const metadata = await getVideoInfo(url);
        const sanitizedTitle = metadata.title.replace(/[^a-zA-Z0-9\s.-]/g, "").trim();
        const filename = `${sanitizedTitle || 'video'}.mp4`;
        
        console.log(`Streaming with filename: ${filename}`);
        res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
        res.setHeader('Content-Type', 'video/mp4');

        const ytProcess = spawn('yt-dlp', ['-f', formatId, '-o', '-', url]);
        ytProcess.stdout.pipe(res);
        ytProcess.stderr.on('data', (data) => console.error(`yt-dlp stderr: ${data}`));
        ytProcess.on('close', (code) => {
            if (code !== 0) console.error(`yt-dlp process exited with code ${code}`);
            else console.log("Stream finished successfully.");
        });
    } catch (error) {
        console.error("Download route error:", error.message);
        if (!res.headersSent) res.status(500).json({ error: "Failed to start video download." });
    }
});

// --- Server Start ---
app.listen(PORT, () => {
    console.log(`✅ Server is live and running on port ${PORT}`);
});