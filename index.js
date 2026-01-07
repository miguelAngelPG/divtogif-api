const express = require('express');
const timecut = require('timecut');
const fs = require('fs');
const path = require('path');
const os = require('os'); // Importamos os
const cors = require('cors');

const app = express();
app.use(express.json({ limit: '10mb' }));
app.use(cors());

app.post('/render', async (req, res) => {
  const { html, css, width, height, duration } = req.body;
  
  // USAMOS LA CARPETA TEMPORAL DEL SISTEMA (/tmp)
  const id = Date.now();
  const tempDir = os.tmpdir(); 
  const tempHtml = path.join(tempDir, `${id}.html`);
  const outputGif = path.join(tempDir, `${id}.gif`);

  const fullContent = `
    <!DOCTYPE html>
    <html>
    <head>
      <style>
        body { margin: 0; padding: 0; overflow: hidden; }
        ${css}
      </style>
    </head>
    <body>${html}</body>
    </html>
  `;

  try {
    // 1. Escribimos el HTML en /tmp
    fs.writeFileSync(tempHtml, fullContent);

    console.log(`Iniciando render ${id}...`);

    await timecut({
      url: `file://${tempHtml}`,
      output: outputGif,
      viewport: { width: parseInt(width || 800), height: parseInt(height || 400) },
      duration: parseInt(duration || 3),
      fps: 30,
      // CRUCIAL: Le decimos a timecut que use /tmp para sus archivos internos
      tempDir: tempDir, 
      launchArguments: [
        '--no-sandbox', 
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-gpu' // Agregado por seguridad
      ]
    });

    // 2. Verificamos que el archivo existe antes de enviarlo
    if (fs.existsSync(outputGif)) {
      res.download(outputGif, 'banner.gif', (err) => {
        if (err) console.error("Error al enviar:", err);
        // Limpieza
        try { 
          if(fs.existsSync(tempHtml)) fs.unlinkSync(tempHtml); 
          if(fs.existsSync(outputGif)) fs.unlinkSync(outputGif); 
        } catch(e) { console.error("Error limpiando:", e); }
      });
    } else {
      throw new Error("El archivo GIF no se generó correctamente.");
    }

  } catch (error) {
    console.error("Error renderizando:", error);
    // Limpieza en caso de error
    try { 
        if(fs.existsSync(tempHtml)) fs.unlinkSync(tempHtml); 
    } catch(e) {}
    
    res.status(500).json({ error: error.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Worker listo en puerto ${PORT}`));