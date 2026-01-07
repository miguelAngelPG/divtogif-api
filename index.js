const express = require('express');
const timecut = require('timecut');
const fs = require('fs');
const path = require('path');
const os = require('os');
const cors = require('cors');
const { execSync } = require('child_process'); // Para probar ffmpeg

const app = express();
app.use(express.json({ limit: '50mb' }));
app.use(cors());

const clients = new Map();

const sendEvent = (jobId, data) => {
  const client = clients.get(jobId);
  if (client) client.write(`data: ${JSON.stringify(data)}\n\n`);
};

// Función para asegurar números pares (FFmpeg odia los impares)
const makeEven = (n) => Math.ceil(n / 2) * 2;

app.post('/start', async (req, res) => {
  const { html, css, width, height, duration } = req.body;
  const jobId = Date.now().toString();
  
  // 1. Validamos FFMPEG al inicio
  try {
    const ffmpegVersion = execSync('ffmpeg -version').toString().split('\n')[0];
    console.log(`Verificación de sistema: ${ffmpegVersion}`);
  } catch (e) {
    console.error("¡ALERTA! FFmpeg no responde:", e.message);
    return res.status(500).json({ error: "FFmpeg no está instalado correctamente en el servidor" });
  }

  res.json({ jobId });

  (async () => {
    const workDir = path.join(os.tmpdir(), `job-${jobId}`);
    const tempHtml = path.join(workDir, 'input.html');
    const outputGif = path.join(workDir, 'output.gif');
    
    // Forzamos dimensiones pares y validamos inputs
    const safeWidth = makeEven(parseInt(width || 800));
    const safeHeight = makeEven(parseInt(height || 400));
    const safeDuration = parseInt(duration || 3);

    try {
      if (!fs.existsSync(workDir)) fs.mkdirSync(workDir);

      const fullContent = `<!DOCTYPE html><html><head><style>body{margin:0;overflow:hidden}${css}</style></head><body>${html}</body></html>`;
      fs.writeFileSync(tempHtml, fullContent);

      const customLogger = (msg) => {
        // Logueamos todo para ver errores de timecut
        console.log(`[Job ${jobId}] Timecut:`, msg); 
        
        if (msg.includes('Capturing Frame')) {
          const parts = msg.split(' ');
          const frameNum = parseInt(parts[2]);
          if (!isNaN(frameNum)) {
            const percent = Math.round((frameNum / (safeDuration * 30)) * 100);
            sendEvent(jobId, { status: 'processing', progress: percent });
          }
        }
      };

      console.log(`Iniciando render Job ${jobId} en ${workDir} (${safeWidth}x${safeHeight})`);

      await timecut({
        url: `file://${tempHtml}`,
        output: outputGif,
        viewport: { width: safeWidth, height: safeHeight },
        duration: safeDuration,
        fps: 30,
        tempDir: workDir,
        logger: customLogger,
        launchArguments: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-gpu']
      });

      // --- ZONA DE DIAGNÓSTICO ---
      console.log(`Verificando archivos en: ${workDir}`);
      const files = fs.readdirSync(workDir);
      console.log(`Archivos encontrados:`, files);
      // ---------------------------

      if (fs.existsSync(outputGif)) {
        const stats = fs.statSync(outputGif);
        console.log(`¡Éxito! GIF generado. Tamaño: ${stats.size} bytes`);
        sendEvent(jobId, { status: 'completed', url: `/download/${jobId}` });
      } else {
        throw new Error(`Timecut terminó pero no creó output.gif. Archivos presentes: ${files.join(', ')}`);
      }

    } catch (error) {
      console.error("Error FATAL:", error);
      sendEvent(jobId, { status: 'error', message: error.message });
      
      // NO borramos la carpeta si hay error, para que puedas debuguear si tuvieras acceso SSH
      // Pero como es Railway, confiamos en el console.log de arriba
    }
  })();
});

app.get('/events/:jobId', (req, res) => {
  const { jobId } = req.params;
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();
  clients.set(jobId, res);
  req.on('close', () => clients.delete(jobId));
});

app.get('/download/:jobId', (req, res) => {
  const { jobId } = req.params;
  const filePath = path.join(os.tmpdir(), `job-${jobId}`, 'output.gif');
  if (fs.existsSync(filePath)) {
    res.download(filePath, 'banner.gif'); 
    // Nota: Quitamos el borrado automático temporalmente para debug
  } else {
    res.status(404).send('Archivo no encontrado');
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Worker DEBUG listo en puerto ${PORT}`));