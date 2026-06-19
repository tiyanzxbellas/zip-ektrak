const express = require('express');
const multer = require('multer');
const axios = require('axios');
const JSZip = require('jszip');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

// Setup multer untuk file upload
const storage = multer.memoryStorage();
const upload = multer({
    storage: storage,
    limits: { fileSize: 50 * 1024 * 1024 }, // 50MB
    fileFilter: (req, file, cb) => {
        if (file.mimetype === 'application/zip' || file.originalname.endsWith('.zip')) {
            cb(null, true);
        } else {
            cb(new Error('Hanya file ZIP yang diizinkan!'));
        }
    }
});

// Helper functions
const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));

function isBinaryFile(filename) {
    const binaryExtensions = [
        '.png', '.jpg', '.jpeg', '.gif', '.bmp', '.ico', '.webp',
        '.pdf', '.zip', '.rar', '.7z', '.tar', '.gz',
        '.exe', '.dll', '.so', '.dylib', '.bin', '.dat',
        '.mp3', '.mp4', '.avi', '.mov', '.mkv', '.flv',
        '.doc', '.docx', '.xls', '.xlsx', '.ppt', '.pptx',
        '.woff', '.woff2', '.ttf', '.eot', '.otf'
    ];
    const lowerName = filename.toLowerCase();
    return binaryExtensions.some(ext => lowerName.endsWith(ext));
}

function bufferToBase64(buffer) {
    return buffer.toString('base64');
}

// Upload ke GitHub
async function uploadToGitHub(token, owner, repo, filePath, content) {
    const encodedPath = filePath.split('/').map(segment => encodeURIComponent(segment)).join('/');
    const url = `https://api.github.com/repos/${owner}/${repo}/contents/${encodedPath}`;

    let sha = null;
    try {
        const checkRes = await axios.get(url, {
            headers: { 'Authorization': `token ${token}` }
        });
        if (checkRes.data) {
            sha = checkRes.data.sha;
        }
    } catch (e) {}

    const response = await axios.put(url, {
        message: sha ? `Update ${filePath}` : `Add ${filePath}`,
        content: content,
        sha: sha
    }, {
        headers: {
            'Authorization': `token ${token}`,
            'Content-Type': 'application/json'
        }
    });

    return response.data;
}

// Buat repository baru
async function createRepository(token, owner, repoName) {
    const response = await axios.post('https://api.github.com/user/repos', {
        name: repoName,
        private: false,
        auto_init: false
    }, {
        headers: {
            'Authorization': `token ${token}`,
            'Content-Type': 'application/json'
        }
    });
    return response.data;
}

// Proses file ZIP
async function processZipFile(zipBuffer, token, owner, repo, sendProgress) {
    const zip = await JSZip.loadAsync(zipBuffer);
    const fileList = [];

    zip.forEach((relativePath, zipEntry) => {
        if (!zipEntry.dir) {
            fileList.push({ path: relativePath, entry: zipEntry });
        }
    });

    if (fileList.length === 0) {
        throw new Error('Tidak ada file yang ditemukan dalam ZIP');
    }

    let uploaded = 0;
    let failed = 0;
    const results = [];

    for (let i = 0; i < fileList.length; i++) {
        const { path: filePath, entry } = fileList[i];
        try {
            const isBinary = isBinaryFile(filePath);
            let content;

            if (isBinary) {
                const arrayBuf = await entry.async('arraybuffer');
                content = bufferToBase64(Buffer.from(arrayBuf));
            } else {
                const text = await entry.async('string');
                content = Buffer.from(text).toString('base64');
            }

            await uploadToGitHub(token, owner, repo, filePath, content);
            uploaded++;
            results.push({ path: filePath, status: 'success' });

            if ((i + 1) % 3 === 0 || i === fileList.length - 1) {
                sendProgress({ uploaded, total: fileList.length });
            }

            await delay(200);

        } catch (err) {
            failed++;
            results.push({ path: filePath, status: 'failed', error: err.message });
        }
    }

    return { uploaded, failed, total: fileList.length, results };
}

// Route untuk upload
app.post('/upload', upload.single('zipFile'), async (req, res) => {
    try {
        const { token, owner, repo, mode } = req.body;
        const zipFile = req.file;

        if (!token || !owner || !repo || !zipFile) {
            return res.status(400).json({
                success: false,
                message: 'Semua field harus diisi!'
            });
        }

        // Validasi token
        if (!token.startsWith('ghp_') && !token.startsWith('github_pat_')) {
            return res.status(400).json({
                success: false,
                message: 'Token GitHub tidak valid!'
            });
        }

        // Set SSE headers
        res.setHeader('Content-Type', 'text/event-stream');
        res.setHeader('Cache-Control', 'no-cache');
        res.setHeader('Connection', 'keep-alive');

        // Fungsi kirim progress
        const sendProgress = (data) => {
            res.write(`data: ${JSON.stringify(data)}\n\n`);
        };

        const zipBuffer = zipFile.buffer;

        // Buat repo baru jika mode new
        if (mode === 'new') {
            sendProgress({ message: `Membuat repository ${repo}...` });
            await createRepository(token, owner, repo);
            await delay(2000);
        } else {
            // Cek repo existing
            try {
                await axios.get(`https://api.github.com/repos/${owner}/${repo}`, {
                    headers: { 'Authorization': `token ${token}` }
                });
            } catch (e) {
                throw new Error(`Repository ${repo} tidak ditemukan atau token tidak memiliki akses`);
            }
        }

        sendProgress({ message: `Memproses file ZIP...` });

        // Proses ZIP
        const result = await processZipFile(zipBuffer, token, owner, repo, sendProgress);

        // Kirim hasil akhir
        const finalResult = {
            success: true,
            uploaded: result.uploaded,
            failed: result.failed,
            total: result.total,
            repo: `https://github.com/${owner}/${repo}`
        };

        sendProgress({ done: true, ...finalResult });
        res.end();

    } catch (error) {
        console.error('Error:', error);
        res.write(`data: ${JSON.stringify({
            success: false,
            message: error.message
        })}\n\n`);
        res.end();
    }
});

// Serve HTML
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

// Start server
app.listen(PORT, () => {
    console.log(`🚀 Server running on http://localhost:${PORT}`);
});