const express = require('express');
const timecut = require('timecut');
const fs = require('fs');
const path = require('path');
const os = require('os');
const cors = require('cors');
const { execSync } = require('child_process');

const app = express();
app.use(express.json({ limit: '50mb' }));
app.use(cors());

const clients = new Map();

const sendEvent = (jobId, data) => {
  const client = clients.get(jobId);
  if (client) client.write(`data: ${JSON.stringify(data)}\n\n`);
};

// Función para asegurar números pares
const makeEven = (n) => Math.ceil(n / 2) * 2;

app.post('/start', async (req, res) => {
  const { html, css, width, height, duration } = req.body;
  const jobId = Date.now().toString();
  
  // Verificación rápida de FFmpeg
  try {
    execSync('ffmpeg -version');
  } catch (e) {
    console.error("FFmpeg no encontrado");
    return res.status(500).json({ error: "Server misconfiguration: FFmpeg missing" });
  }

  res.json({ jobId });

  (async () => {
    // ESTA ES LA CORRECCIÓN CLAVE:
    const jobDir = path.join(os.tmpdir(), `job-${jobId}`);     // Carpeta Principal
    const framesDir = path.join(jobDir, 'frames');             // Subcarpeta para basura temporal
    
    const tempHtml = path.join(jobDir, 'input.html');
    const outputGif = path.join(jobDir, 'output.gif');         // El GIF se guarda en la Principal, a salvo

    const safeWidth = makeEven(parseInt(width || 800));
    const safeHeight = makeEven(parseInt(height || 400));
    const safeDuration = parseInt(duration || 3);

    try {
      // Creamos la estructura
      if (!fs.existsSync(jobDir)) fs.mkdirSync(jobDir);
      if (!fs.existsSync(framesDir)) fs.mkdirSync(framesDir);

      const fullContent = `<!DOCTYPE html><html><head><style>body{margin:0;overflow:hidden}${css}</style></head><body>${html}</body></html>`;
      fs.writeFileSync(tempHtml, fullContent);

      const customLogger = (msg) => {
        console.log(`[Job ${jobId}]`, msg);
        if (msg.includes('Capturing Frame')) {
          const parts = msg.split(' ');
          const frameNum = parseInt(parts[2]);
          if (!isNaN(frameNum)) {
            const percent = Math.round((frameNum / (safeDuration * 30)) * 100);
            sendEvent(jobId, { status: 'processing', progress: percent });
          }
        }
      };

      await timecut({
        url: `file://${tempHtml}`,
        output: outputGif,
        viewport: { width: safeWidth, height: safeHeight },
        duration: safeDuration,
        fps: 30,
        // LE DAMOS SU PROPIA CARPETA DE FRAMES PARA QUE JUEGUE
        tempDir: framesDir, 
        logger: customLogger,
        launchArguments: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-gpu']
      });

      // Verificamos en la carpeta PRINCIPAL (jobDir), no en la de frames
      if (fs.existsSync(outputGif)) {
        const stats = fs.statSync(outputGif);
        console.log(`GIF Generado: ${stats.size} bytes`);
        sendEvent(jobId, { status: 'completed', url: `/download/${jobId}` });
      } else {
        // Si falló, listamos qué hay en la carpeta principal
        const files = fs.readdirSync(jobDir);
        throw new Error(`GIF no encontrado. Archivos en dir: ${files.join(', ')}`);
      }

    } catch (error) {
      console.error("Error Worker:", error);
      sendEvent(jobId, { status: 'error', message: error.message });
      // Limpieza en caso de error
      try { fs.rmSync(jobDir, { recursive: true, force: true }); } catch(e){}
    }
  })();
});

// SSE Endpoint
app.get('/events/:jobId', (req, res) => {
  const { jobId } = req.params;
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();
  clients.set(jobId, res);
  req.on('close', () => clients.delete(jobId));
});

// Download Endpoint
app.get('/download/:jobId', (req, res) => {
  const { jobId } = req.params;
  const filePath = path.join(os.tmpdir(), `job-${jobId}`, 'output.gif');
  
  if (fs.existsSync(filePath)) {
    res.download(filePath, 'banner.gif', () => {
      // AHORA SÍ, UNA VEZ DESCARGADO, BORRAMOS TODO EL JOB
      const jobDir = path.join(os.tmpdir(), `job-${jobId}`);
      try { fs.rmSync(jobDir, { recursive: true, force: true }); } catch(e){}
    });
  } else {
    res.status(404).send('Archivo expirado o no encontrado');
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Worker V3 listo en puerto ${PORT}`));