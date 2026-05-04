const express = require("express");
const path = require("path");
const fs = require("fs");
const crypto = require("crypto");
const archiver = require("archiver");
const PDFDocument = require("pdfkit");
const { PNG } = require("pngjs");
const { chromium } = require("playwright");

const app = express();
const PORT = process.env.PORT || 3030;

const ROOT_DIR = __dirname;
const TEMP_DIR = path.join(ROOT_DIR, "temp");
const PREVIEW_DIR = path.join(ROOT_DIR, "public", "preview");
const DOWNLOADS_DIR = path.join(ROOT_DIR, "public", "downloads");

fs.mkdirSync(TEMP_DIR, { recursive: true });
fs.mkdirSync(PREVIEW_DIR, { recursive: true });
fs.mkdirSync(DOWNLOADS_DIR, { recursive: true });

app.use(express.json({ limit: "5mb" }));
app.use(express.static(path.join(ROOT_DIR, "public")));

const jobs = new Map();

function sanitizeName(value) {
  return String(value || "")
    .replace(/[^\w.-]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 80);
}

function buildSlideUrl(inputUrl, slideNumber, enabled) {
  const url = new URL(inputUrl);

  if (enabled) {
    const currentSlide = url.searchParams.get("slide") || "";
    const match = currentSlide.match(/^(.*?)(\d+)$/);

    if (match) {
      const prefix = match[1];
      url.searchParams.set("slide", `${prefix}${slideNumber}`);
    } else {
      url.searchParams.set("slide", `id.${slideNumber}`);
    }
  }

  if (!url.searchParams.has("start")) url.searchParams.set("start", "false");
  if (!url.searchParams.has("loop")) url.searchParams.set("loop", "false");
  if (!url.searchParams.has("delayms")) url.searchParams.set("delayms", "3000");

  return url.toString();
}

function getCleanClip(width, height, aspectRatio = "16:9") {
  const controlsHeight = Math.max(42, Math.round(height * 0.075));
  const safeHeight = height - controlsHeight;
  const ratio = aspectRatio === "4:3" ? 4 / 3 : 16 / 9;

  let slideW = width;
  let slideH = slideW / ratio;

  if (slideH > safeHeight) {
    slideH = safeHeight;
    slideW = slideH * ratio;
  }

  const x = Math.max(0, Math.round((width - slideW) / 2));
  const y = Math.max(0, Math.round((safeHeight - slideH) / 2));
  const w = Math.min(width - x, Math.round(slideW));
  const h = Math.min(height - y, Math.round(slideH));

  return { x, y, width: w, height: h };
}

async function screenshotCurrentPage(page, outputPath, options) {
  const width = Number(options.width || 1280);
  const height = Number(options.height || 720);

  if (options.cleanCapture) {
    const clip = getCleanClip(width, height, options.aspectRatio || "16:9");
    await page.screenshot({ path: outputPath, type: "png", clip });
  } else {
    await page.screenshot({
      path: outputPath,
      fullPage: Boolean(options.fullPage),
      type: "png"
    });
  }
}

function analyzePng(filePath) {
  const buffer = fs.readFileSync(filePath);
  const png = PNG.sync.read(buffer);
  const width = png.width;
  const height = png.height;
  const stepX = Math.max(1, Math.floor(width / 80));
  const stepY = Math.max(1, Math.floor(height / 80));

  let count = 0;
  let sum = 0;
  let sumSq = 0;
  let dark = 0;
  let light = 0;

  for (let y = 0; y < height; y += stepY) {
    for (let x = 0; x < width; x += stepX) {
      const idx = (width * y + x) << 2;
      const r = png.data[idx];
      const g = png.data[idx + 1];
      const b = png.data[idx + 2];
      const lum = (r + g + b) / 3;

      count++;
      sum += lum;
      sumSq += lum * lum;
      if (lum < 12) dark++;
      if (lum > 243) light++;
    }
  }

  const mean = sum / count;
  const variance = sumSq / count - mean * mean;
  const std = Math.sqrt(Math.max(0, variance));
  const darkRatio = dark / count;
  const lightRatio = light / count;
  const suspicious = std < 7 || darkRatio > 0.94 || lightRatio > 0.94;

  return {
    width,
    height,
    mean: Number(mean.toFixed(2)),
    std: Number(std.toFixed(2)),
    darkRatio: Number(darkRatio.toFixed(3)),
    lightRatio: Number(lightRatio.toFixed(3)),
    suspicious
  };
}

async function createPdfFromImages(imagePaths, outputPdfPath) {
  return new Promise((resolve, reject) => {
    if (!imagePaths.length) return resolve();

    const doc = new PDFDocument({ autoFirstPage: false, margin: 0 });
    const stream = fs.createWriteStream(outputPdfPath);
    doc.pipe(stream);

    for (const imagePath of imagePaths) {
      const info = analyzePng(imagePath);
      doc.addPage({ size: [info.width, info.height], margin: 0 });
      doc.image(imagePath, 0, 0, { width: info.width, height: info.height });
    }

    doc.end();
    stream.on("finish", resolve);
    stream.on("error", reject);
  });
}

async function createZipFromFolder(sourceFolder, zipFilePath) {
  return new Promise((resolve, reject) => {
    const output = fs.createWriteStream(zipFilePath);
    const archive = archiver("zip", { zlib: { level: 9 } });

    output.on("close", () => resolve({ bytes: archive.pointer() }));
    archive.on("error", reject);

    archive.pipe(output);
    archive.directory(sourceFolder, false);
    archive.finalize();
  });
}

function scheduleCleanup(jobId, minutes = 60) {
  setTimeout(() => {
    const job = jobs.get(jobId);
    if (!job) return;

    try {
      if (job.batchFolder && fs.existsSync(job.batchFolder)) {
        fs.rmSync(job.batchFolder, { recursive: true, force: true });
      }
      if (job.downloadZipPath && fs.existsSync(job.downloadZipPath)) {
        fs.rmSync(job.downloadZipPath, { force: true });
      }
    } catch {}

    jobs.delete(jobId);
  }, minutes * 60 * 1000);
}

async function gotoWithRetry(page, url, outputPath, options, job, slideLabel) {
  const maxRetries = Number(options.retries || 2);
  let lastError = null;

  for (let attempt = 1; attempt <= maxRetries + 1; attempt++) {
    if (job.cancelled) throw new Error("Proceso cancelado por el usuario.");

    try {
      job.currentStatus = `Abriendo slide ${slideLabel}. Intento ${attempt}/${maxRetries + 1}`;
      await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60000 });
      await page.waitForTimeout(Number(options.delayMs || 1800));
      await screenshotCurrentPage(page, outputPath, options);

      const analysis = analyzePng(outputPath);

      if (options.validateBlank && analysis.suspicious) {
        throw new Error(
          `La captura parece vacía o mal cargada. std=${analysis.std}, dark=${analysis.darkRatio}, light=${analysis.lightRatio}`
        );
      }

      return { ok: true, attempt, analysis };
    } catch (error) {
      lastError = error;
      if (attempt <= maxRetries) {
        job.currentStatus = `Falló slide ${slideLabel}. Reintentando...`;
        await page.waitForTimeout(800);
      }
    }
  }

  return { ok: false, error: lastError ? lastError.message : "Error desconocido" };
}

async function runCaptureJob(jobId, payload) {
  const job = jobs.get(jobId);
  const saved = [];
  const failed = [];
  const imagePaths = [];
  const width = Number(payload.width || 1280);
  const height = Number(payload.height || 720);
  const scale = Number(payload.scale || 1);
  const safePrefix = sanitizeName(payload.prefix || "slide");
  const start = payload.rangeEnabled ? Number(payload.from || 1) : 1;
  const end = payload.rangeEnabled ? Number(payload.to || 1) : 1;
  const total = end - start + 1;
  const batchName = `${safePrefix}_${Date.now()}_${jobId.slice(0, 8)}`;
  const batchFolder = path.join(TEMP_DIR, batchName);
  let browser = null;

  try {
    if (!payload.url) throw new Error("Falta el link de Google Slides.");
    if (payload.rangeEnabled && (!Number.isFinite(start) || !Number.isFinite(end) || start < 1 || end < start)) {
      throw new Error("Rango inválido. Ejemplo válido: de 1 a 60.");
    }
    if (payload.rangeEnabled && total > 500) {
      throw new Error("Máximo 500 capturas por tanda.");
    }

    fs.mkdirSync(batchFolder, { recursive: true });

    job.status = "running";
    job.batchFolder = batchFolder;
    job.total = total;
    job.done = 0;
    job.saved = [];
    job.failed = [];

    browser = await chromium.launch({ headless: true });
    const page = await browser.newPage({
      viewport: { width, height },
      deviceScaleFactor: scale
    });

    for (let n = start; n <= end; n++) {
      if (job.cancelled) throw new Error("Proceso cancelado por el usuario.");

      const finalUrl = buildSlideUrl(payload.url, n, Boolean(payload.rangeEnabled));
      const filename = payload.rangeEnabled
        ? `${safePrefix}_${String(n).padStart(3, "0")}.png`
        : `${safePrefix}.png`;
      const outputPath = path.join(batchFolder, filename);

      job.currentSlide = payload.rangeEnabled ? n : null;
      job.currentStatus = `Capturando ${job.done + 1}/${total}`;

      const result = await gotoWithRetry(page, finalUrl, outputPath, payload, job, payload.rangeEnabled ? n : "único");

      if (result.ok) {
        imagePaths.push(outputPath);
        const item = {
          slide: payload.rangeEnabled ? n : null,
          filename,
          attempts: result.attempt,
          analysis: result.analysis
        };
        saved.push(item);
        job.saved = saved;
      } else {
        const item = {
          slide: payload.rangeEnabled ? n : null,
          filename,
          error: result.error
        };
        failed.push(item);
        job.failed = failed;
      }

      job.done++;
      job.progress = Math.round((job.done / total) * 100);
    }

    let pdfRelativeUrl = null;
    if (payload.exportPdf && imagePaths.length) {
      job.currentStatus = "Generando PDF...";
      const pdfName = `${safePrefix}.pdf`;
      const pdfPath = path.join(batchFolder, pdfName);
      await createPdfFromImages(imagePaths, pdfPath);
      pdfRelativeUrl = `/job/${jobId}/file/${encodeURIComponent(pdfName)}`;
    }

    job.currentStatus = "Armando ZIP...";
    const zipName = `${safePrefix}.zip`;
    const publicZipName = `${batchName}.zip`;
    const zipFilePath = path.join(DOWNLOADS_DIR, publicZipName);
    await createZipFromFolder(batchFolder, zipFilePath);

    job.status = "done";
    job.progress = 100;
    job.currentStatus = "Listo";
    job.downloadZipPath = zipFilePath;
    job.result = {
      ok: true,
      count: saved.length,
      failedCount: failed.length,
      saved,
      failed,
      zipName,
      zipUrl: `/downloads/${encodeURIComponent(publicZipName)}`,
      pdfUrl: pdfRelativeUrl,
      expiresInMinutes: 60
    };

    scheduleCleanup(jobId, 60);
  } catch (error) {
    job.status = job.cancelled ? "cancelled" : "error";
    job.currentStatus = job.cancelled ? "Cancelado" : "Error";
    job.error = error.message || "Error desconocido.";
    job.result = { ok: false, saved, failed, error: job.error };
    scheduleCleanup(jobId, 60);
  } finally {
    if (browser) {
      try { await browser.close(); } catch {}
    }
  }
}

app.get("/health", (req, res) => {
  res.json({ ok: true, app: "google-slides-capturer-webzip" });
});

app.post("/api/preview", async (req, res) => {
  try {
    const payload = req.body;
    if (!payload.url) {
      return res.status(400).json({ error: "Falta el link de Google Slides." });
    }

    const finalUrl = buildSlideUrl(payload.url, Number(payload.previewSlide || 1), Boolean(payload.rangeEnabled));
    const browser = await chromium.launch({ headless: true });
    const page = await browser.newPage({
      viewport: {
        width: Number(payload.width || 1280),
        height: Number(payload.height || 720)
      },
      deviceScaleFactor: Number(payload.scale || 1)
    });

    const filename = `preview_${Date.now()}.png`;
    const outputPath = path.join(PREVIEW_DIR, filename);

    try {
      await page.goto(finalUrl, { waitUntil: "domcontentloaded", timeout: 60000 });
      await page.waitForTimeout(Number(payload.delayMs || 1800));
      await screenshotCurrentPage(page, outputPath, payload);
    } finally {
      await browser.close();
    }

    const analysis = analyzePng(outputPath);

    res.json({
      ok: true,
      url: `/preview/${filename}`,
      finalUrl,
      analysis,
      warning: payload.validateBlank && analysis.suspicious
        ? "La preview parece vacía o mal cargada. Probá subir el delay o desactivar captura limpia."
        : null
    });
  } catch (error) {
    res.status(500).json({ error: error.message || "Error generando preview." });
  }
});

app.post("/api/capture/start", async (req, res) => {
  const jobId = crypto.randomUUID();
  const job = {
    id: jobId,
    status: "queued",
    progress: 0,
    total: 0,
    done: 0,
    saved: [],
    failed: [],
    currentStatus: "En cola",
    cancelled: false,
    createdAt: new Date().toISOString()
  };

  jobs.set(jobId, job);
  res.json({ ok: true, jobId });
  runCaptureJob(jobId, req.body);
});

app.get("/api/capture/status/:jobId", (req, res) => {
  const job = jobs.get(req.params.jobId);
  if (!job) {
    return res.status(404).json({ error: "No existe ese proceso o ya expiró." });
  }
  res.json(job);
});

app.post("/api/capture/cancel/:jobId", (req, res) => {
  const job = jobs.get(req.params.jobId);
  if (!job) {
    return res.status(404).json({ error: "No existe ese proceso." });
  }
  job.cancelled = true;
  job.currentStatus = "Cancelando...";
  res.json({ ok: true });
});

app.get("/job/:jobId/file/:filename", (req, res) => {
  const job = jobs.get(req.params.jobId);

  if (!job || !job.batchFolder) {
    return res.status(404).send("Archivo no disponible.");
  }

  const requested = path.basename(req.params.filename);
  const filePath = path.join(job.batchFolder, requested);

  if (!fs.existsSync(filePath)) {
    return res.status(404).send("Archivo no encontrado.");
  }

  res.sendFile(filePath);
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(`App lista en http://0.0.0.0:${PORT}`);
});
