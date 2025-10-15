const express = require("express");
const { spawn } = require("child_process");
const cors = require("cors");
const path = require("path");
const fs = require("fs");

const app = express();
const PORT = process.env.PORT || 4000;

// --- Create cookie files from environment variables ---
if (process.env.FACEBOOK_COOKIES) {
    // Note the filename change to match the new logic
    fs.writeFileSync(path.join(__dirname, 'facebook.com-cookies.txt'), process.env.FACEBOOK_COOKIES);
    console.log("✅ Facebook cookie file created.");
}
if (process.env.TIKTOK_COOKIES) {
    fs.writeFileSync(path.join(__dirname, 'tiktok.com-cookies.txt'), process.env.TIKTOK_COOKIES);
    console.log("✅ TikTok cookie file created.");
}

// --- Middleware ---
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

// --- Real-time Progress (SSE) ---
let clients = [];
app.get("/progress", (req, res) => {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders();
    clients.push(res);
    req.on('close', () => { clients = clients.filter(c => c !== res); });
});
function sendProgress(data) {
    clients.forEach(client => client.write(`data: ${JSON.stringify(data)}\n\n`));
}

// --- Helper to get video metadata ---
async function getVideoInfo(url) {
    return new Promise((resolve, reject) => {
        const hostname = new URL(url).hostname.replace('www.','');
        const cookieFile = path.join(__dirname, `${hostname}-cookies.txt`);
        const args = ['--dump-single-json', '--no-warnings'];

        if (fs.existsSync(cookieFile)) {
            console.log(`Using cookies for ${hostname}`);
            args.push('--cookies', cookieFile);
        }
        
        args.push(url);

        const ytProcess = spawn('yt-dlp', args);
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

// --- FINAL, UPGRADED Helper to process formats ---
function processFormats(formats) {
    if (!Array.isArray(formats)) return { video: {}, audio: null };

    const availableQualities = { video: {}, audio: null };

    // --- Add the reliable "Auto" option ---
    availableQualities.video['Auto'] = {
        label: 'Auto',
        formatId: 'bestvideo+bestaudio/best' // Magic yt-dlp command
    };

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


// --- Routes ---
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

app.post("/download", async (req, res) => {
    const { url, formatId } = req.body;
    if (!url || !formatId) return res.status(400).json({ error: "URL and Format ID are required." });

    try {
        const metadata = await getVideoInfo(url);
        const sanitizedTitle = metadata.title.replace(/[^a-zA-Z0-9\s.-]/g, "").trim();
        const tempFilename = `${Date.now()}-${sanitizedTitle || 'video'}.mp4`;
        const tempFilePath = path.join('/tmp', tempFilename);

        sendProgress({ status: 'initializing', message: 'Initializing download...' });
        
        const args = ['--progress', '-f', formatId, '-o', tempFilePath];
        
        const hostname = new URL(url).hostname.replace('www.','');
        const cookieFile = path.join(__dirname, `${hostname}-cookies.txt`);
        if (fs.existsSync(cookieFile)) {
            args.push('--cookies', cookieFile);
        }
        args.push(url);

        const ytProcess = spawn('yt-dlp', args);

        ytProcess.stdout.on('data', (data) => {
            const output = data.toString();
            const progressMatch = output.match(/\[download\]\s+([\d\.]+)%/);
            if (progressMatch) {
                sendProgress({ status: 'downloading', percent: parseFloat(progressMatch[1]) });
            }
        });
        ytProcess.stderr.on('data', (data) => console.error(`yt-dlp stderr: ${data}`));
        ytProcess.on('close', (code) => {
            if (code === 0) {
                sendProgress({ status: 'complete', message: 'Sending file...' });
                res.setHeader('Content-Disposition', `attachment; filename="${sanitizedTitle || 'video'}.mp4"`);
                const fileStream = fs.createReadStream(tempFilePath);
                fileStream.pipe(res);
                fileStream.on('end', () => fs.unlink(tempFilePath, (err) => {
                    if (err) console.error("Error deleting temp file:", err);
                }));
            } else {
                sendProgress({ status: 'error', message: `Download failed.` });
                if (!res.headersSent) res.status(500).json({ error: "Failed to download video." });
            }
        });

    } catch (error) {
        sendProgress({ status: 'error', message: "An unexpected error occurred." });
        if (!res.headersSent) res.status(500).json({ error: "Failed to process video." });
    }
});

// --- Server Start ---
app.listen(PORT, () => {
    console.log(`✅ Server is live and running on port ${PORT}`);
});