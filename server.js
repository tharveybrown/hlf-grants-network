import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT || 3000;

// In-memory cache for grants data
let grantsDataCache = null;
let cacheTimestamp = null;
const CACHE_DURATION = 60 * 60 * 1000; // 1 hour

// Health check endpoint for Replit
app.get('/health', (req, res) => {
  res.status(200).send('OK');
});

// API endpoint to proxy GitHub Release data (avoids CORS issues)
app.get('/api/grants-network-data', async (req, res) => {
  try {
    // Check if we have cached data that's still fresh
    const now = Date.now();
    if (grantsDataCache && cacheTimestamp && (now - cacheTimestamp) < CACHE_DURATION) {
      console.log('✅ Serving grants data from cache');
      return res.json(grantsDataCache);
    }

    // Check if local file exists (for development)
    const localPath = path.join(__dirname, 'public', 'grants-network-data.json');
    if (fs.existsSync(localPath)) {
      console.log('📂 Loading grants data from local file...');
      const data = JSON.parse(fs.readFileSync(localPath, 'utf-8'));

      // Cache it
      grantsDataCache = data;
      cacheTimestamp = Date.now();

      console.log('✅ Successfully loaded local grants data');
      return res.json(data);
    }

    console.log('📥 Fetching grants data from GitHub Release... (this may take 15-20 seconds)');
    const response = await fetch('https://github.com/tharveybrown/hlf-grants-network/releases/download/v1.0.0/grants-network-data.json');
    console.log(`📊 GitHub response status: ${response.status}`);

    if (!response.ok) {
      throw new Error(`GitHub fetch failed: ${response.status} ${response.statusText}`);
    }

    const data = await response.json();

    // Cache the data
    grantsDataCache = data;
    cacheTimestamp = Date.now();

    console.log('✅ Successfully fetched, parsed, and cached grants data');
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
