const express = require("express");
const { spawn } = require("child_process");
const cors = require("cors");
const path = require("path");
const fs = require("fs");

const app = express();
const PORT = process.env.PORT || 4000;

// Create cookie files from environment variables
if (process.env.FACEBOOK_COOKIES) {
    fs.writeFileSync(path.join(__dirname, 'facebook.com-cookies.txt'), process.env.FACEBOOK_COOKIES);
}
if (process.env.TIKTOK_COOKIES) {
    fs.writeFileSync(path.join(__dirname, 'tiktok.com-cookies.txt'), process.env.TIKTOK_COOKIES);
}

// Middleware, SSE, and Helper functions
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

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

async function getVideoInfo(url) {
    return new Promise((resolve, reject) => {
        const hostname = new URL(url).hostname.replace('www.','');
        const cookieFile = path.join(__dirname, `${hostname}-cookies.txt`);
        const args = ['--dump-single-json', '--no-warnings'];
        if (fs.existsSync(cookieFile)) {
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
                catch (e) { reject(new Error("Failed to parse metadata.")); }
            } else {
                reject(new Error(`yt-dlp exited with code ${code}. Error: ${stderrData}`));
            }
        });
        ytProcess.on('error', (err) => reject(err));
    });
}
function processFormats(formats) {
    if (!Array.isArray(formats)) return { video: {}, audio: null };
    const availableQualities = { video: {}, audio: null };
    availableQualities.video['Auto'] = { label: 'Auto', formatId: 'bestvideo+bestaudio/best' };
    let bestAudio = null;
    formats.filter(f => f.vcodec === 'none' && f.acodec !== 'none' && f.abr).forEach(f => {
        if (!bestAudio || f.abr > bestAudio.abr) bestAudio = f;
    });
    if (bestAudio) availableQualities.audio = { label: `${Math.round(bestAudio.abr)}kbps`, formatId: bestAudio.format_id };
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
            if (bestVideoOnly) bestFormatForRes = { format_id: `${bestVideoOnly.format_id}+${bestAudio.format_id}` };
        }
        if (bestFormatForRes) availableQualities.video[res] = { label: `${res}p`, formatId: bestFormatForRes.format_id };
    });
    return availableQualities;
}

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

// --- THIS IS THE UPDATED DOWNLOAD ROUTE ---
app.post("/download", async (req, res) => {
    const { url, formatId } = req.body;
    if (!url || !formatId) return res.status(400).json({ error: "URL and Format ID are required." });

    try {
        // We get metadata here once for the filename
        const metadata = await getVideoInfo(url);
        const sanitizedTitle = metadata.title.replace(/[^a-zA-Z0-9\s.-]/g, "").trim();
        const tempFilename = `${Date.now()}-${sanitizedTitle || 'video'}.mp4`;
        const tempFilePath = path.join('/tmp', tempFilename);

        sendProgress({ status: 'initializing' });

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
            // --- THIS IS THE NEW, SMARTER REGEX ---
            const progressMatch = output.match(/\[download\]\s+([\d\.]+)% of[~\s]+([\d\.]+\w+i?B) at\s+([\d\.]+\w+\/s)/);
            if (progressMatch) {
                const percent = parseFloat(progressMatch[1]);
                const totalSize = progressMatch[2].replace('i', ''); // Sanitize MiB -> MB
                const speed = progressMatch[3];
                // Send all the new data to the app
                sendProgress({ status: 'downloading', percent, totalSize, speed });
            }
        });

        ytProcess.stderr.on('data', (data) => console.error(`yt-dlp stderr: ${data}`));

        ytProcess.on('close', (code) => {
            if (code === 0) {
                // Use the "Converting" status as requested
                sendProgress({ status: 'converting', message: 'Converting...' });
                res.setHeader('Content-Disposition', `attachment; filename="${sanitizedTitle || 'video'}.mp4"`);
                const fileStream = fs.createReadStream(tempFilePath);
                fileStream.pipe(res);
                fileStream.on('end', () => fs.unlink(tempFilePath, (err) => {
                    if (err) console.error("Error deleting temp file:", err);
                }));
            } else {
                sendProgress({ status: 'error' });
                if (!res.headersSent) res.status(500).json({ error: "Failed to download video." });
            }
        });

    } catch (error) {
        sendProgress({ status: 'error' });
        if (!res.headersSent) res.status(500).json({ error: "Failed to process video." });
    }
});

app.listen(PORT, () => {
    console.log(`✅ Server is live and running on port ${PORT}`);
});