const express = require('express');
const timecut = require('timecut');
const fs = require('fs');
const path = require('path');
const cors = require('cors'); // Para permitir que tu Next.js le hable

const app = express();
app.use(express.json({ limit: '10mb' })); // Aumentamos límite para recibir HTML grande
app.use(cors());

app.post('/render', async (req, res) => {
  const { html, css, width, height, duration } = req.body;
  const id = Date.now();
  const tempHtml = path.join(__dirname, `${id}.html`);
  const outputGif = path.join(__dirname, `${id}.gif`);

  // 1. Preparamos el HTML completo
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
    fs.writeFileSync(tempHtml, fullContent);

    console.log(`Iniciando render ${id}...`);

    // 2. Renderizamos (Aquí es donde Railway brilla y Vercel muere)
    await timecut({
      url: `file://${tempHtml}`,
      output: outputGif,
      viewport: { width: parseInt(width), height: parseInt(height) },
      duration: parseInt(duration),
      fps: 30, // 30 es un buen balance calidad/peso
      launchArguments: [
        '--no-sandbox', 
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage' // Importante para Docker
      ]
    });

    // 3. Enviamos el archivo de vuelta
    res.download(outputGif, 'banner.gif', (err) => {
      if (err) console.error(err);
      // Limpieza
      try { fs.unlinkSync(tempHtml); fs.unlinkSync(outputGif); } catch(e){}
    });

  } catch (error) {
    console.error("Error renderizando:", error);
    res.status(500).json({ error: error.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Worker listo en puerto ${PORT}`));