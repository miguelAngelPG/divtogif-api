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

const makeEven = (n) => Math.ceil(n / 2) * 2;

app.post('/start', async (req, res) => {
  const { html, css, width, height, duration, bg, fps } = req.body;
  const jobId = Date.now().toString();

  res.json({ jobId });

  (async () => {
    const jobDir = path.join(os.tmpdir(), `job-${jobId}`);
    const framesDir = path.join(jobDir, 'frames');
    const tempHtml = path.join(jobDir, 'input.html');
    const outputGif = path.join(jobDir, 'output.gif');
    const dummyOutput = path.join(jobDir, 'temp_video.mp4');

    try {
      if (!fs.existsSync(jobDir)) fs.mkdirSync(jobDir);
      if (!fs.existsSync(framesDir)) fs.mkdirSync(framesDir);

      // ==========================================
      // 🛡️ ZONA DE SEGURIDAD (LA ADUANA)
      // ==========================================

      // 1. CONSTANTES DE LÍMITE (Ajustables según tu plan de Railway)
      const LIMITS = {
        MAX_WIDTH: 1280,      // Max 720p/HD (Más de esto explota RAM)
        MAX_HEIGHT: 1280,
        MAX_DURATION: 20,     // Segundos máximos absolutos
        MAX_TOTAL_FRAMES: 450 // Presupuesto de fotos (RAM)
      };

      // 2. SANITIZACIÓN DE INPUTS (Recortes)
      let rawWidth = parseInt(width || 800);
      let rawHeight = parseInt(height || 400);
      let rawDuration = parseInt(duration || 3);
      let rawFps = parseInt(fps || 30);

      // Aplicamos tijera si se pasan
      if (rawWidth > LIMITS.MAX_WIDTH) rawWidth = LIMITS.MAX_WIDTH;
      if (rawHeight > LIMITS.MAX_HEIGHT) rawHeight = LIMITS.MAX_HEIGHT;
      if (rawDuration > LIMITS.MAX_DURATION) rawDuration = LIMITS.MAX_DURATION;

      // Aseguramos pares para FFmpeg
      const safeWidth = makeEven(rawWidth);
      const safeHeight = makeEven(rawHeight);
      
      // 3. BALANCEO DE FPS (El algoritmo inteligente)
      // Si frames totales > 450, bajamos FPS automáticamente
      let safeFps = rawFps;
      const totalRequestedFrames = rawDuration * safeFps;

      if (totalRequestedFrames > LIMITS.MAX_TOTAL_FRAMES) {
        // Regla de tres: NuevosFPS = MaxFrames / Duración
        safeFps = Math.floor(LIMITS.MAX_TOTAL_FRAMES / rawDuration);
        // Nunca bajar de 10 FPS (para que no parezca diapositiva)
        if (safeFps < 10) safeFps = 10; 
        
        console.log(`[Job ${jobId}] ⚠️ ALERTA: Ajustando carga. De ${rawFps}fps a ${safeFps}fps.`);
      }

      // Calculamos los frames finales reales que vamos a generar
      const expectedFrames = rawDuration * safeFps;
      const safeBg = bg || 'transparent'; 

      console.log(`[Job ${jobId}] CONFIGURACIÓN FINAL: ${safeWidth}x${safeHeight} | ${rawDuration}s @ ${safeFps}fps | Total: ${expectedFrames} frames`);

      // ==========================================
      // FIN DE ZONA DE SEGURIDAD
      // ==========================================

      const fullContent = `
        <!DOCTYPE html>
        <html>
        <head>
          <style>
            * { margin: 0; padding: 0; box-sizing: border-box; }
            html, body {
              width: ${safeWidth}px;
              height: ${safeHeight}px;
              overflow: hidden;
              background-color: ${safeBg} !important;
            }
            ${css}
          </style>
        </head>
        <body>${html}</body>
        </html>
      `;
      
      fs.writeFileSync(tempHtml, fullContent);

      const customLogger = (msg) => {
        if (msg.includes('Capturing Frame')) {
          const parts = msg.split(' ');
          const frameNum = parseInt(parts[2]);
          if (!isNaN(frameNum)) {
            const percent = Math.round((frameNum / expectedFrames) * 80);
            sendEvent(jobId, { status: 'processing', progress: percent });
          }
        }
      };

      // 4. CAPTURA BLINDADA
      await timecut({
        url: `file://${tempHtml}`,
        viewport: { width: safeWidth, height: safeHeight },
        duration: rawDuration,
        fps: safeFps,
        tempDir: framesDir,     
        keepFrames: true,       
        logger: customLogger,
        launchArguments: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-gpu'],
        output: dummyOutput,    
        screenshotPattern: 'image-%09d.png' 
      });

      sendEvent(jobId, { status: 'processing', progress: 85 });
      
      // 5. VERIFICACIÓN
      let files = [];
      if (fs.existsSync(framesDir)) {
        files = fs.readdirSync(framesDir).filter(f => f.endsWith('.png'));
      }

      if (files.length < expectedFrames - 5) { // Tolerancia de 5 frames
        throw new Error(`Render incompleto: ${files.length}/${expectedFrames} frames.`);
      }

      // 6. GENERACIÓN GIF
      const framesPattern = path.join(framesDir, 'image-%09d.png');
      const ffmpegCmd = `ffmpeg -f image2 -framerate ${safeFps} -i "${framesPattern}" -vf "split[s0][s1];[s0]palettegen[p];[s1][p]paletteuse" -loop 0 "${outputGif}"`;

      execSync(ffmpegCmd);

      sendEvent(jobId, { status: 'processing', progress: 100 });

      if (fs.existsSync(outputGif)) {
        sendEvent(jobId, { status: 'completed', url: `/download/${jobId}` });
      } else {
        throw new Error('Fallo en la compresión final.');
      }

    } catch (error) {
      console.error(`[Job ${jobId}] Error:`, error.message);
      sendEvent(jobId, { status: 'error', message: error.message });
      try { fs.rmSync(jobDir, { recursive: true, force: true }); } catch(e){}
    }
  })();
});

// Endpoints GET (events / download) se mantienen igual...
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
    res.download(filePath, 'banner.gif', () => {
      const jobDir = path.join(os.tmpdir(), `job-${jobId}`);
      try { fs.rmSync(jobDir, { recursive: true, force: true }); } catch(e){}
    });
  } else {
    res.status(404).send('Archivo no encontrado');
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Worker V8 (Guardian Mode) listo en ${PORT}`));