const express = require("express");
const { spawn } = require("child_process");
const path = require("path");
const fs = require("fs");

const app = express();
const PORT = 4000;

// Path to your yt-dlp.exe
const ytdlpPath = "C:\\Users\\Hp 840 G5\\Downloads\\yt-dlp.exe";

// Ensure downloads folder exists
const downloadsFolder = path.join(__dirname, "downloads");
if (!fs.existsSync(downloadsFolder)) {
    fs.mkdirSync(downloadsFolder);
}

// Middleware
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

let clients = [];

// SSE endpoint for live progress
app.get("/progress", (req, res) => {
    res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
    });
    clients.push(res);
    req.on("close", () => {
        clients = clients.filter(c => c !== res);
    });
});

// Send progress to all clients
function sendProgress(data) {
    clients.forEach(res => res.write(`data: ${JSON.stringify(data)}\n\n`));
}

// Route to download video
app.post("/download", (req, res) => {
    const { url } = req.body;
    if (!url) {
        return res.status(400).json({ error: "Please provide a video URL." });
    }

    const outputTemplate = path.join(downloadsFolder, "%(title)s.%(ext)s");

    const ytProcess = spawn(ytdlpPath, [
        "-f", "best",
        "-o", outputTemplate,
        url
    ]);

    ytProcess.stdout.on("data", (data) => {
        const output = data.toString();
        const match = output.match(/(\d+\.\d)%/); // capture %
        if (match) {
            const progress = parseFloat(match[1]);
            sendProgress({ progress });
        }
    });

    ytProcess.stderr.on("data", (data) => {
        console.error("yt-dlp:", data.toString());
    });

    ytProcess.on("close", (code) => {
        sendProgress({ progress: 100, message: "Download complete!" });
        console.log(`yt-dlp exited with code ${code}`);
    });

    res.json({ message: "Download started..." });
});

// Route for manual test
app.get("/test", (req, res) => {
    res.sendFile(path.join(__dirname, "public", "index.html"));
});

// Start server
app.listen(PORT, () => {
    console.log(`✅ YT-DLP Server running at http://localhost:${PORT}`);
});
