const express = require("express");
const { exec: ytDlpExec } = require("yt-dlp-exec");
const cors = require("cors");
const path = require("path");

const app = express();
const PORT = process.env.PORT || 4000;

// --- Middleware ---
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

// --- Route to get video info ---
app.post("/info", async (req, res) => {
    const { url } = req.body;
    if (!url) {
        return res.status(400).json({ error: "Please provide a video URL." });
    }
    console.log(`Fetching info for: ${url}`);
    try {
        const metadata = await ytDlpExec(url, {
            dumpSingleJson: true,
            noWarnings: true,
        });
        // Send back only the necessary details
        res.json({
            title: metadata.title,
            thumbnail: metadata.thumbnail,
            duration: metadata.duration,
            formats: metadata.formats,
        });
    } catch (error) {
        console.error("Info fetch error:", error);
        res.status(500).json({ error: "Failed to fetch video information." });
    }
});

// --- Route to download the selected video format ---
app.post("/download", async (req, res) => {
    const { url, formatId } = req.body;
    if (!url || !formatId) {
        return res.status(400).json({ error: "URL and Format ID are required." });
    }
    console.log(`Download request for: ${url} with format: ${formatId}`);
    try {
        // Fetch metadata again to get a reliable title for the filename
        const metadata = await ytDlpExec(url, { dumpSingleJson: true });
        const sanitizedTitle = metadata.title.replace(/[^a-zA-Z0-9\s.-]/g, "").trim();
        const filename = `${sanitizedTitle || 'video'}.mp4`;
        
        console.log(`Streaming with filename: ${filename}`);

        res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
        res.setHeader('Content-Type', 'video/mp4');

        const videoStream = ytDlpExec(url, {
            format: formatId,
            output: '-', // Stream to stdout
        }).stdout;

        videoStream.pipe(res);

    } catch (error) {
        console.error("Download stream error:", error);
        res.status(500).json({ error: "Failed to start video download." });
    }
});

// --- Server Start ---
app.listen(PORT, () => {
    console.log(`✅ Server is live and running on port ${PORT}`);
});