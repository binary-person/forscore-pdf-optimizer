// index.js
const express = require('express');
const multer = require('multer');
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const { execFile } = require('child_process');

const app = express();
const port = process.env.PORT || 3000;

const TMP_DIR = path.join(__dirname, 'tmp');
let counter = 0;

// Clean/create temp dir on start
(async () => {
  try {
    await fsp.rm(TMP_DIR, { recursive: true, force: true });
    await fsp.mkdir(TMP_DIR, { recursive: true });
    console.log(`[startup] temp folder ready: ${TMP_DIR}`);
  } catch (e) {
    console.error('[startup] failed to prepare temp dir:', e);
    process.exit(1);
  }
})();

// Serve the upload page
app.use(express.static(path.join(__dirname, 'public')));

// Multer in-memory; we write to disk with our own deterministic filename
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 1024 * 1024 * 200 } }); // 200MB

// Helper: run a command and await completion
function run(cmd, args, opts = {}) {
  return new Promise((resolve, reject) => {
    const child = execFile(cmd, args, opts, (err, stdout, stderr) => {
      if (err) {
        err.stdout = stdout?.toString?.();
        err.stderr = stderr?.toString?.();
        return reject(err);
      }
      resolve({ stdout: stdout?.toString?.() || '', stderr: stderr?.toString?.() || '' });
    });
    child.stdout && child.stdout.setEncoding('utf8');
    child.stderr && child.stderr.setEncoding('utf8');
  });
}

function prettyCmd(cmd, args) {
  const escaped = [cmd, ...args.map(a => /\s/.test(a) ? `"${a.replace(/"/g, '\\"')}"` : a)];
  return escaped.join(' ');
}

app.post('/upload', upload.single('file'), async (req, res) => {
  if (!req.file) {
    res.status(400).send('No file uploaded (field name must be "file").');
    return;
  }

  const id = ++counter;
  const tag = `[${id}]`;
  const origName = path.parse(req.file.originalname || 'score.pdf').base;

  console.log(`${tag} - received request to process ${origName}`);

  const uploadedBase = `${id}`;
  const uploadedPath = path.join(TMP_DIR, `${uploadedBase}.pdf`);
  const step1Path = path.join(TMP_DIR, `process${uploadedBase}.pdf`);
  const finalPath = path.join(TMP_DIR, `final${uploadedBase}.pdf`);
  const t0 = Date.now();

  // idempotent cleanup shared by success and error paths
  let cleaned = false;
  const cleanup = async () => {
    if (cleaned) return;
    cleaned = true;
    const toDelete = [uploadedPath, step1Path, finalPath];
    for (const p of toDelete) {
      try { await fsp.unlink(p); } catch (_) {}
    }
    console.log(`${tag} - deleted file`);
  };

  // Write upload to disk as "<n>.pdf"
  try {
    await fsp.writeFile(uploadedPath, req.file.buffer);
  } catch (e) {
    console.error(`${tag} - write error:`, e);
    const elapsed = Date.now() - t0;
    console.log(`${tag} - done in ${elapsed}ms`);
    await cleanup();
    res.status(500).send('Processing failed.');
    return;
  }

  try {
    // 1) shrinkpdf: -r 400 -t 1.25 -g -o processN.pdf N.pdf
    const shrinkCmd = '/opt/shrinkpdf/shrinkpdf.sh';
    const shrinkArgs = ['-r', '400', '-t', '1.25', '-g', '-o', step1Path, uploadedPath];
    console.log(`${tag} - running ${prettyCmd(shrinkCmd, shrinkArgs)}`);
    await run(shrinkCmd, shrinkArgs);

    // 2) pdfsizeopt
    const optCmd = '/usr/local/bin/pdfsizeopt';
    const optArgs = ['--use-pngout=no', step1Path, finalPath];
    console.log(`${tag} - running ${prettyCmd(optCmd, optArgs)}`);

    let optimizedAvailable = false;
    try {
      await run(optCmd, optArgs);
      const stats = await fsp.stat(finalPath).catch(() => null);
      optimizedAvailable = !!(stats && stats.size > 0);
    } catch (e) {
      const guess1 = step1Path.replace(/\.pdf$/i, '-optimized.pdf');
      const guess2 = step1Path.replace(/\.pdf$/i, '-opt.pdf');
      for (const c of [guess1, guess2]) {
        try {
          const s = await fsp.stat(c);
          if (s.size > 0) {
            await fsp.rename(c, finalPath);
            optimizedAvailable = true;
            break;
          }
        } catch (_) { /* ignore */ }
      }
      if (!optimizedAvailable) {
        console.warn(`${tag} - pdfsizeopt failed or produced no file; using shrinkpdf output.`, e.stderr || e.message);
      }
    }

    const outPath = optimizedAvailable ? finalPath : step1Path;

    const elapsed = Date.now() - t0;
    console.log(`${tag} - done in ${elapsed}ms, sending back`);

    // Stream back with the ORIGINAL filename
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${origName.replace(/"/g, '')}"`);

    const stream = fs.createReadStream(outPath);

    stream.on('error', async (err) => {
      console.error(`${tag} - stream read error:`, err);
      if (!res.headersSent) res.status(500).end('Processing failed.');
      await cleanup();
    });

    res.on('finish', cleanup);
    res.on('close', cleanup);

    stream.pipe(res);

  } catch (e) {
    console.error(`${tag} - processing error:`, e.stderr || e.message || e);
    const elapsed = Date.now() - t0;
    console.log(`${tag} - done in ${elapsed}ms`);
    await cleanup();
    if (!res.headersSent) res.status(500).send('Processing failed.');
  }
});

// Start server and enable Ctrl+C (SIGINT) graceful exit
const server = app.listen(port, () => {
  console.log(`forscore-pdf-optimizer listening on http://0.0.0.0:${port}`);
});

async function gracefulShutdown(signal) {
  console.log(`[shutdown] received ${signal}, closing server...`);
  server.close(async () => {
    try {
      await fsp.rm(TMP_DIR, { recursive: true, force: true });
      console.log('[shutdown] cleaned temp directory');
    } catch (e) {
      console.warn('[shutdown] temp cleanup failed:', e?.message || e);
    }
    process.exit(0);
  });
  setTimeout(() => process.exit(0), 5000).unref();
}

process.on('SIGINT', () => gracefulShutdown('SIGINT'));
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
