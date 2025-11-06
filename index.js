// index.js
const express = require('express');
const multer = require('multer');
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const { execFile } = require('child_process');
const { randomUUID } = require('crypto');

const app = express();
const port = process.env.PORT || 3000;

const TMP_DIR = path.join(__dirname, 'tmp');
const PUBLIC_DIR = path.join(__dirname, 'public');

const DOWNLOAD_IDLE_MS = 5 * 60 * 1000; // 5 minutes

// In-memory job store
// job = { id, origName, inPath, outPath, status, message?, createdAt, readyAt?, expiresAt?, durationMs?, idleTimer?, streamActive? }
const JOBS = new Map();

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
app.use(express.static(PUBLIC_DIR));

// Multer in-memory; we write to disk with our own filename
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
    if (child.stdout) child.stdout.setEncoding('utf8');
    if (child.stderr) child.stderr.setEncoding('utf8');
  });
}

function prettyCmd(cmd, args) {
  const escaped = [cmd, ...args.map(a => (/\s/.test(a) ? `"${a.replace(/"/g, '\\"')}"` : a))];
  return escaped.join(' ');
}

// RFC 5987 encoder for header values (UTF-8)
function encodeRFC5987(str) {
  return encodeURIComponent(str)
    .replace(/['()]/g, escape) // keep quoted-string safe
    .replace(/\*/g, '%2A')
    .replace(/%20/g, '%20'); // spaces as %20 (not +)
}

// Best-effort ASCII fallback for legacy user agents
function asciiFallback(name, def = 'download') {
  // strip diacritics, then non-ASCII, then dangerous chars
  const noDiacritics = name.normalize('NFKD').replace(/[\u0300-\u036f]/g, '');
  const ascii = noDiacritics.replace(/[^\x20-\x7E]+/g, '');
  return (ascii || def).replace(/["\\]/g, '');
}

function scheduleIdleExpiry(job) {
  clearIdleTimer(job);
  job.expiresAt = new Date(Date.now() + DOWNLOAD_IDLE_MS).toISOString();
  job.idleTimer = setTimeout(() => expireJob(job.id), DOWNLOAD_IDLE_MS);
}

function clearIdleTimer(job) {
  if (job && job.idleTimer) {
    clearTimeout(job.idleTimer);
    job.idleTimer = null;
  }
}

async function expireJob(jobId) {
  const job = JOBS.get(jobId);
  if (!job) return;
  // delete files
  for (const p of [job.inPath, job.outPath]) {
    try { if (p) await fsp.unlink(p); } catch (_) { }
  }
  clearIdleTimer(job);
  job.status = 'expired';
  job.expiresAt = null;
  job.message = job.message || 'Download expired.';
  console.log(`[${jobId}] expired and files removed`);
}

app.post('/upload', upload.single('file'), async (req, res) => {
  if (!req.file) {
    res.status(400).json({ error: 'No file uploaded (field name must be "file").' });
    return;
  }

  const id = randomUUID();
  const tag = `[${id}]`;
  // https://github.com/expressjs/multer/issues/1104#issuecomment-1152987772
  req.file.originalname = Buffer.from(req.file.originalname, 'latin1').toString('utf8');
  const origName = path.parse(req.file.originalname || 'score.pdf').base;

  const inPath = path.join(TMP_DIR, `${id}.pdf`);
  const outPath = path.join(TMP_DIR, `${id}-out.pdf`);

  const job = {
    id,
    origName,
    inPath,
    outPath,
    status: 'queued',
    createdAt: new Date().toISOString(),
    readyAt: null,
    expiresAt: null,
    durationMs: null,
    idleTimer: null,
    streamActive: false,
  };
  JOBS.set(id, job);

  // Write upload to disk
  try {
    await fsp.writeFile(inPath, req.file.buffer);
  } catch (e) {
    console.error(`${tag} write error:`, e);
    job.status = 'error';
    job.message = 'Failed to save uploaded file.';
    return res.status(500).json({ jobId: id, status: job.status, message: job.message });
  }

  // Kick off processing (async)
  (async () => {
    const startedAt = Date.now();
    try {
      job.status = 'processing';
      job.message = null;

      // Ghostscript command (single step)
      const gsCmd = 'gs';
      const gsArgs = [
        '-sDEVICE=pdfwrite',
        '-dCompatibilityLevel=1.4',
        '-dPDFSETTINGS=/ebook',
        '-dNOPAUSE',
        '-dQUIET',
        '-dBATCH',
        '-dColorConversionStrategy=/LeaveColorUnchanged',
        `-sOutputFile=${outPath}`,
        inPath,
      ];
      console.log(`${tag} running: ${prettyCmd(gsCmd, gsArgs)}`);
      await run(gsCmd, gsArgs);

      // verify output
      const stats = await fsp.stat(outPath).catch(() => null);
      if (!stats || stats.size === 0) {
        throw new Error('No output produced.');
      }

      job.status = 'done';
      job.readyAt = new Date().toISOString();
      scheduleIdleExpiry(job);
      console.log(`${tag} processing done; ready for download. Expires at ${job.expiresAt}`);
    } catch (e) {
      console.error(`${tag} processing error:`, e?.stderr || e?.message || e);
      job.status = 'error';
      job.message = 'Processing failed.';
      // cleanup inputs if processing failed
      try { await fsp.unlink(inPath); } catch (_) { }
      try { await fsp.unlink(outPath); } catch (_) { }
    } finally {
      job.durationMs = Date.now() - startedAt;
      const suffix = `Done in ${job.durationMs}ms.`;
      job.message = job.message ? `${job.message} ${suffix}` : suffix;
      console.log(`${tag} ${job.status === 'done' ? 'success' : job.status} in ${job.durationMs}ms`);
    }
  })().catch(() => { /* already handled */ });

  // Immediately return job id
  res.json({ jobId: id });
});

app.get('/status/:id', async (req, res) => {
  const job = JOBS.get(req.params.id);
  if (!job) {
    res.status(404).json({ status: 'missing', message: 'Unknown job ID.' });
    return;
  }
  res.json({
    jobId: job.id,
    status: job.status,
    message: job.message || null,
    createdAt: job.createdAt,
    readyAt: job.readyAt,
    expiresAt: job.expiresAt,
    durationMs: job.durationMs,
  });
});

app.get('/download/:id', async (req, res) => {
  const job = JOBS.get(req.params.id);
  if (!job) {
    return res.status(404).send('Unknown job ID.');
  }
  if (job.status === 'expired') {
    return res.status(410).send('This download has expired.');
  }
  if (job.status !== 'done') {
    return res.status(409).send('Not ready yet. Try again shortly.');
  }

  // If still within idle window, proceed to stream and then expire immediately
  try {
    const exists = await fsp.stat(job.outPath).catch(() => null);
    if (!exists) {
      job.status = 'expired';
      return res.status(410).send('This download has expired.');
    }
  } catch {
    job.status = 'expired';
    return res.status(410).send('This download has expired.');
  }

  // Clear pending idle expiry; we will expire after streaming
  clearIdleTimer(job);
  job.streamActive = true;

  // Content headers with UTF-8 filename support
  const utf8Name = job.origName || 'download.pdf';
  const fallbackName = asciiFallback(utf8Name);
  const encodedName = encodeRFC5987(utf8Name);

  res.setHeader('Content-Type', 'application/pdf');
  // Provide both classic filename= (ASCII) and RFC 5987 filename*= (UTF-8)
  res.setHeader(
    'Content-Disposition',
    `attachment; filename="${fallbackName}"; filename*=UTF-8''${encodedName}`
  );

  const stream = fs.createReadStream(job.outPath);

  const finalize = async () => {
    if (job.streamActive) {
      job.streamActive = false;
      await expireJob(job.id); // immediate expiry after stream
    }
  };

  stream.on('error', async (err) => {
    console.error(`[${job.id}] stream read error:`, err);
    if (!res.headersSent) res.status(500).end('Download failed.');
    await finalize();
  });

  res.on('finish', finalize);
  res.on('close', finalize);

  stream.pipe(res);
});

// Start server and enable Ctrl+C (SIGINT) graceful exit
const server = app.listen(port, () => {
  console.log(`forscore-pdf-optimizer listening on http://0.0.0.0:${port}`);
});

async function gracefulShutdown(signal) {
  console.log(`[shutdown] received ${signal}, closing server...`);
  server.close(async () => {
    try {
      // expire all jobs and remove tmp
      await Promise.all([...JOBS.values()].map(j => expireJob(j.id)));
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
