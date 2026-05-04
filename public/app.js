const $ = (id) => document.getElementById(id);

const form = $("captureForm");
const statusBox = $("status");
const previewBtn = $("previewBtn");
const cancelBtn = $("cancelBtn");
const previewImage = $("previewImage");
const emptyState = $("emptyState");
const openPreview = $("openPreview");
const downloadZip = $("downloadZip");
const results = $("results");
const resultSummary = $("resultSummary");
const progressText = $("progressText");
const progressDetail = $("progressDetail");
const progressFill = $("progressFill");

let currentJobId = null;
let pollTimer = null;

$("url").value = "https://docs.google.com/presentation/d/e/2PACX-1vSeRuFQ5l9Gpi7TvjgNr4Kl5Q0wJ9-GlyKlpat8wCtITwTVeAq_ItlRmt779qkiMQ/pubembed?slide=id.p57";

$("preset").addEventListener("change", () => {
  const value = $("preset").value;
  if (value === "custom") return;
  const [w, h] = value.split("x").map(Number);
  $("width").value = w;
  $("height").value = h;
});

$("width").addEventListener("input", () => $("preset").value = "custom");
$("height").addEventListener("input", () => $("preset").value = "custom");

function getPayload() {
  return {
    url: $("url").value.trim(),
    width: Number($("width").value),
    height: Number($("height").value),
    scale: Number($("scale").value),
    delayMs: Number($("delayMs").value),
    retries: Number($("retries").value),
    fullPage: $("fullPage").checked,
    cleanCapture: $("cleanCapture").checked,
    validateBlank: $("validateBlank").checked,
    exportPdf: $("exportPdf").checked,
    aspectRatio: $("aspectRatio").value,
    rangeEnabled: $("rangeEnabled").checked,
    from: Number($("from").value),
    to: Number($("to").value),
    previewSlide: Number($("previewSlide").value),
    prefix: $("prefix").value.trim() || "slide"
  };
}

function setLoading(isLoading, text = "") {
  previewBtn.disabled = isLoading;
  form.querySelector("button[type='submit']").disabled = isLoading;
  cancelBtn.disabled = !isLoading;
  statusBox.textContent = text;
}

function setProgress(percent, detail) {
  progressText.textContent = `${percent || 0}%`;
  progressDetail.textContent = detail || "";
  progressFill.style.width = `${percent || 0}%`;
}

async function postJson(path, payload = {}) {
  const response = await fetch(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload)
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || "Error inesperado.");
  return data;
}

async function getJson(path) {
  const response = await fetch(path);
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || "Error inesperado.");
  return data;
}

function renderResults(result, jobId) {
  if (result.zipUrl) {
    downloadZip.href = result.zipUrl;
    downloadZip.style.display = "inline";
    downloadZip.setAttribute("download", result.zipName || "capturas.zip");
    setTimeout(() => { try { downloadZip.click(); } catch {} }, 250);
  } else {
    downloadZip.style.display = "none";
    downloadZip.removeAttribute("href");
  }

  resultSummary.innerHTML = `
    <strong>ZIP listo para descargar.</strong><br>
    Capturas OK: ${result.count ?? 0}<br>
    Fallidas: ${result.failedCount ?? 0}<br>
    ${result.pdfUrl ? `PDF incluido: sí<br>` : `PDF incluido: no<br>`}
    El ZIP expira en aprox. ${result.expiresInMinutes ?? 60} minutos.
  `;

  const savedHtml = (result.saved || []).map(item => {
    const warn = item.analysis && item.analysis.suspicious
      ? `<div class="bad">Advertencia: posible captura vacía</div>`
      : `<div class="good">OK · intento ${item.attempts}</div>`;

    const slideLabel = item.slide != null ? `Slide ${item.slide}` : "Slide";
    return `
      <div class="resultItem">
        <div>
          <strong>${item.filename}</strong>
          <div class="meta">${slideLabel}</div>
          ${warn}
          <div class="meta">std: ${item.analysis?.std ?? "-"} · dark: ${item.analysis?.darkRatio ?? "-"} · light: ${item.analysis?.lightRatio ?? "-"}</div>
        </div>
        <a href="/job/${jobId}/file/${encodeURIComponent(item.filename)}" target="_blank" rel="noreferrer">Abrir</a>
      </div>
    `;
  }).join("");

  const failedHtml = (result.failed || []).map(item => `
    <div class="resultItem">
      <div>
        <strong>${item.filename}</strong>
        <div class="bad">Falló: ${item.error}</div>
      </div>
      <span></span>
    </div>
  `).join("");

  results.innerHTML = savedHtml + failedHtml;
}

previewBtn.addEventListener("click", async () => {
  try {
    setLoading(true, "Generando preview...");
    setProgress(0, "Preview");
    const data = await postJson("/api/preview", getPayload());

    previewImage.src = data.url + "?t=" + Date.now();
    previewImage.style.display = "block";
    emptyState.style.display = "none";

    openPreview.href = data.url;
    openPreview.style.display = "inline";

    setProgress(100, "Preview generada");
    statusBox.textContent = "Preview generada.\nURL usada:\n" + data.finalUrl + (data.warning ? "\n\nADVERTENCIA:\n" + data.warning : "");
  } catch (error) {
    statusBox.textContent = "Error: " + error.message;
    setProgress(0, "Error");
  } finally {
    setLoading(false, statusBox.textContent);
  }
});

form.addEventListener("submit", async (event) => {
  event.preventDefault();

  try {
    const payload = getPayload();
    const total = payload.rangeEnabled ? payload.to - payload.from + 1 : 1;

    currentJobId = null;
    results.innerHTML = "";
    resultSummary.textContent = "Preparando ZIP...";
    downloadZip.style.display = "none";
    setProgress(0, `Preparando ${total} captura(s)...`);
    setLoading(true, `Iniciando ${total} captura(s)...`);

    const start = await postJson("/api/capture/start", payload);
    currentJobId = start.jobId;

    pollTimer = setInterval(async () => {
      try {
        const job = await getJson(`/api/capture/status/${currentJobId}`);

        setProgress(job.progress || 0, `${job.done || 0}/${job.total || 0} · ${job.currentStatus || ""}`);
        statusBox.textContent =
          `Estado: ${job.status}\n` +
          `Progreso: ${job.done || 0}/${job.total || 0}\n` +
          `${job.currentStatus || ""}`;

        if (job.status === "done" || job.status === "error" || job.status === "cancelled") {
          clearInterval(pollTimer);
          pollTimer = null;
          setLoading(false, statusBox.textContent);

          if (job.status === "done") {
            renderResults(job.result || {}, currentJobId);
            statusBox.textContent =
              `Listo. Se generó el ZIP.\n` +
              `Capturas OK: ${job.result.count}\n` +
              `Fallidas: ${job.result.failedCount}\n` +
              `Descargá el ZIP desde el botón de la derecha.`;
          } else {
            renderResults(job.result || {}, currentJobId);
            resultSummary.textContent = "El proceso terminó con error o fue cancelado.";
            statusBox.textContent = `${job.status.toUpperCase()}: ${job.error || "Proceso detenido."}`;
          }
        }
      } catch (error) {
        clearInterval(pollTimer);
        pollTimer = null;
        setLoading(false, "Error consultando progreso.");
        statusBox.textContent = "Error: " + error.message;
      }
    }, 700);
  } catch (error) {
    statusBox.textContent = "Error: " + error.message;
    setProgress(0, "Error");
    setLoading(false, statusBox.textContent);
  }
});

cancelBtn.addEventListener("click", async () => {
  if (!currentJobId) return;

  try {
    await postJson(`/api/capture/cancel/${currentJobId}`, {});
    statusBox.textContent = "Cancelando proceso...";
    progressDetail.textContent = "Cancelando...";
  } catch (error) {
    statusBox.textContent = "Error cancelando: " + error.message;
  }
});
