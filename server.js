import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT || 3000;

// Health check endpoint for Replit
app.get('/health', (req, res) => {
  res.status(200).send('OK');
});

// API endpoint to proxy GitHub Release data (avoids CORS issues)
app.get('/api/grants-network-data', async (req, res) => {
  try {
    console.log('📥 Fetching grants data from GitHub Release...');
    const response = await fetch('https://github.com/tharveybrown/hlf-grants-network/releases/download/v1.0.0/grants-network-data.json');
    console.log(`📊 GitHub response status: ${response.status}`);

    if (!response.ok) {
      throw new Error(`GitHub fetch failed: ${response.status} ${response.statusText}`);
    }

    const data = await response.json();
    console.log('✅ Successfully fetched and parsed grants data');
    res.json(data);
  } catch (error) {
    console.error('❌ Error fetching grants data:', error.message);
    res.status(500).json({ error: `Failed to fetch grants network data: ${error.message}` });
  }
});

// Serve static files from the dist directory
app.use(express.static(path.join(__dirname, 'dist')));

// Handle SPA routing - send all requests to index.html
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'dist', 'index.html'));
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`🚀 HLF Grants Network running on port ${PORT}`);
  console.log(`🔒 Password protected with: hlf2025`);
  console.log(`📂 Serving from: ${path.join(__dirname, 'dist')}`);
  console.log(`✅ Server ready at http://0.0.0.0:${PORT}`);
});
