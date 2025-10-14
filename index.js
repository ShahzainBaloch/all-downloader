const express = require("express");
const { spawn } = require("child_process");
const cors = require("cors");
const path = require("path");
const fs = require("fs"); // File System module for managing temp files

const app = express();
const PORT = process.env.PORT || 4000;

// --- Middleware ---
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

// --- Real-time Progress Reporting with Server-Sent Events (SSE) ---
let clients = [];

// Endpoint for clients to connect and listen for progress
app.get("/progress", (req, res) => {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders(); // Flush the headers to establish the connection

    clients.push(res);
    console.log("Client connected for progress updates.");

    req.on('close', () => {
        clients = clients.filter(client => client !== res);
        console.log("Client disconnected.");
    });
});

// Function to send progress data to all connected clients
function sendProgress(data) {
    clients.forEach(client => client.write(`data: ${JSON.stringify(data)}\n\n`));
}

// --- Helper Functions (No changes here) ---
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

function processFormats(formats) {
    const availableQualities = { video: {}, audio: null };
    let bestAudio = null;
    formats.filter(f => f.vcodec === 'none' && f.acodec !== 'none' && f.abr).forEach(f => {
        if (!bestAudio || f.abr > bestAudio.abr) bestAudio = f;
    });
    if (bestAudio) {
        availableQualities.audio = { label: `${Math.round(bestAudio.abr)}kbps`, formatId: bestAudio.format_id };
    }
    const standardResolutions = [1080, 720, 480, 360, 240, 144];
    standardResolutions.forEach(res => {
        let bestFormatForRes = null;
        formats.filter(f => f.vcodec !== 'none' && f.acodec !== 'none' && f.height && Math.abs(f.height - res) < 50).forEach(f => {
            if (!bestFormatForRes || (f.tbr || 0) > (bestFormatForRes.tbr || 0)) bestFormatForRes = f;
        });
        if (!bestFormatForRes && bestAudio) {
            let bestVideoOnly = null;
            formats.filter(f => f.vcodec !== 'none' && f.acodec === 'none' && f.height && Math.abs(f.height - res) < 50).forEach(f => {
                if (!bestVideoOnly || (f.tbr || 0) > (bestVideoOnly.tbr || 0)) bestVideoOnly = f;
            });
            if (bestVideoOnly) {
                bestFormatForRes = { format_id: `${bestVideoOnly.format_id}+${bestAudio.format_id}` };
            }
        }
        if (bestFormatForRes) {
            availableQualities.video[res] = { label: `${res}p`, formatId: bestFormatForRes.format_id };
        }
    });
    return availableQualities;
}

// --- Route to get video info (No changes here) ---
app.post("/info", async (req, res) => {
    const { url } = req.body;
    if (!url) return res.status(400).json({ error: "Please provide a video URL." });
    try {
        const metadata = await getVideoInfo(url);
        const processedFormats = processFormats(metadata.formats);
        res.json({ title: metadata.title, thumbnail: metadata.thumbnail, duration: metadata.duration, formats: processedFormats });
    } catch (error) {
        console.error("Info fetch error:", error.message);
        res.status(500).json({ error: "Failed to fetch video information." });
    }
});

// --- UPGRADED Download Route ---
app.post("/download", async (req, res) => {
    const { url, formatId } = req.body;
    if (!url || !formatId) return res.status(400).json({ error: "URL and Format ID are required." });

    try {
        const metadata = await getVideoInfo(url);
        const sanitizedTitle = metadata.title.replace(/[^a-zA-Z0-9\s.-]/g, "").trim();
        const tempFilename = `${Date.now()}-${sanitizedTitle || 'video'}.mp4`;
        const tempFilePath = path.join('/tmp', tempFilename); // Use /tmp for Render's ephemeral disk

        console.log(`Downloading to temporary file: ${tempFilePath}`);
        sendProgress({ status: 'initializing', message: 'Initializing download...' });

        const ytProcess = spawn('yt-dlp', [
            '--progress', // Enable progress reporting
            '-f', formatId,
            '-o', tempFilePath, // Output to the temporary file
            url
        ]);

        ytProcess.stdout.on('data', (data) => {
            const output = data.toString();
            // Regex to capture the percentage from yt-dlp's progress line
            const progressMatch = output.match(/\[download\]\s+([\d\.]+)%/);
            if (progressMatch) {
                const percent = parseFloat(progressMatch[1]);
                sendProgress({ status: 'downloading', percent });
            }
        });

        ytProcess.stderr.on('data', (data) => console.error(`yt-dlp stderr: ${data}`));

        ytProcess.on('close', (code) => {
            if (code === 0) {
                console.log("Temporary file created successfully.");
                sendProgress({ status: 'complete', message: 'Download complete! Sending file...' });
                
                // Set headers and stream the completed file to the user
                res.setHeader('Content-Disposition', `attachment; filename="${sanitizedTitle || 'video'}.mp4"`);
                res.setHeader('Content-Type', 'video/mp4');
                const fileStream = fs.createReadStream(tempFilePath);
                fileStream.pipe(res);
                
                // Clean up the temporary file after streaming is complete
                fileStream.on('end', () => {
                    fs.unlink(tempFilePath, (err) => {
                        if (err) console.error("Error deleting temp file:", err);
                        else console.log("Temp file deleted.");
                    });
                });
            } else {
                console.error(`yt-dlp process exited with code ${code}`);
                sendProgress({ status: 'error', message: `Download failed with code ${code}.` });
                if (!res.headersSent) res.status(500).json({ error: "Failed to download video." });
            }
        });

    } catch (error) {
        console.error("Download route error:", error.message);
        sendProgress({ status: 'error', message: "An unexpected error occurred." });
        if (!res.headersSent) res.status(500).json({ error: "Failed to process video." });
    }
});

// --- Server Start ---
app.listen(PORT, () => {
    console.log(`✅ Server is live and running on port ${PORT}`);
});