# HLF Grants Network Visualization

Interactive network visualization of Hidden Leaf Foundation grants and related funding networks, built with React, TypeScript, D3.js, and IRS 990 data.

**Hidden Leaf Foundation EIN: 35-2338463**

## Features

- **Fast Loading**: Pre-filtered network data (< 1MB) loads instantly
- **IDE-Style Interface**: Fixed right sidebar panel with rich grant metadata
- **Multi-Year Support**: Filter by year (2023, 2024, or all)
- **Rich Metadata**: View funders, grantees, amounts, years, assets, revenue, location
- **Interactive Graph**: Drag nodes, zoom, click for details

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                    DATA FLOW                                │
├─────────────────────────────────────────────────────────────┤
│                                                             │
│  IRS Monthly ZIPs (2022-2025)                              │
│         ↓                                                   │
│  1. build-complete-grants-dataset.ts                       │
│     - Downloads IRS XML files by month & year              │
│     - Processes Form 990-PF (foundation grants)            │
│     - Processes Form 990 (public charity metadata)         │
│     - Builds bidirectional dataset with consolidation      │
│     - Builds HLF network directly from dataset             │
│     - Outputs:                                             │
│       • data/complete-grants-dataset.json (~1GB)           │
│       • public/grants-network-data.json (~1MB)             │
│         ↓                                                   │
│  2. React App                                              │
│     - Loads filtered network data (fast!)                  │
│     - Year filtering in browser                            │
│     - D3 force-directed graph with curved edges            │
│     - IDE-style side panel with rich metadata              │
│                                                             │
└─────────────────────────────────────────────────────────────┘
```

## Quick Start

### 1. Install Dependencies

```bash
npm install
```

### 2. Build Complete Dataset (First Time or to Update)

**For 2024 only (recommended for testing):**
```bash
# Edit scripts/build-complete-grants-dataset.ts
# Set: const YEARS = [2024];

npm run build-complete-dataset
```

**For both 2023 and 2024 (full dataset):**
```bash
# Edit scripts/build-complete-grants-dataset.ts
# Set: const YEARS = [2023, 2024];

npm run build-complete-dataset
```

This will:
- Download IRS monthly ZIP files for each year (3 months in parallel)
- Extract and parse Form 990-PF (foundation grants) and Form 990 (charity metadata)
- Extract grant data + metadata (assets, revenue, address)
- Consolidate organizations by name (merges placeholder entries with real EINs)
- Build HLF network directly from the complete dataset
- Cache monthly results in `.cache/monthly/YEAR_month_N.json`
- Generate both:
  - `data/complete-grants-dataset.json` (~1GB) - Full dataset cache
  - `public/grants-network-data.json` (~1MB) - HLF network for visualization
- **Takes several hours** (caching speeds up reruns)

**Progress**: The script shows real-time progress:
```
🗓️  === PROCESSING YEAR 2024 ===

--- Processing 2024 Month: 1 ---
🔍 Downloading monthly ZIP...
✅ Downloaded
🗜️  Extracting ZIP...
✅ Extracted
🔍 Processing 23,456 XML files for month 1...
  ...processed 1000 of 23456 files
  ...processed 2000 of 23456 files
  ...
✅ XML Processing complete for month 1!
   Found 1,234 990-PF filings.
   Found 567 foundations with grants.
✅ Cached month 1 data
🧹 Cleaning up downloaded files...
```

### 3. Run Development Server

```bash
npm run dev
```

Open http://localhost:5173 and click "Load Data"

## Project Structure

```
hlf-grants-network/
├── public/
│   ├── grants_list.csv              # HLF grantees (manually maintained)
│   ├── grants-network-data.json     # Filtered network data (~1MB)
│   └── vite.svg
├── data/
│   └── complete-grants-dataset.json # Full bidirectional dataset (~260MB)
├── .cache/
│   └── monthly/                     # Cached monthly results
│       ├── 2023_month_1.json
│       ├── 2023_month_2.json
│       ├── 2024_month_1.json
│       └── ...
├── scripts/
│   └── build-complete-grants-dataset.ts  # Build dataset & HLF network
└── src/
    ├── components/
    │   └── NetworkGraph.tsx              # D3 visualization
    ├── services/
    │   └── csvParser.ts                  # Type definitions
    └── App.tsx                           # Main app with side panel
```

## Key Scripts

| Script | Description | Duration |
|--------|-------------|----------|
| `npm run build-complete-dataset` | Download IRS data, build dataset & HLF network | Hours (first run), faster with cache |
| `npm run clear-cache` | Clear `.cache/monthly/` directory | Instant |
| `npm run dev` | Start development server | Instant |

## Data Sources

- **IRS Form 990-PF** (Private Foundation Returns): Foundation grant data
  - Monthly XML files from https://apps.irs.gov/pub/epostcard/990/xml/YYYY/
  - Format: `YYYY_TEOS_XML_MMA.zip` (e.g., `2024_TEOS_XML_01A.zip`)
  - 12 ZIP files per year (one per month)
- **IRS Form 990** (Public Charity Returns): Organization metadata (assets, revenue, location)
  - Same monthly XML files as above
  - Provides detailed financial information for grantee organizations
- **HLF Grants**: `public/grants_list.csv` (manually maintained from HLF records)

## Metadata Extracted

From IRS 990-PF XMLs:

### Foundation Metadata
- **EIN** (Employer Identification Number)
- **Name** (Business name)
- **Address** (Street, city, state)
- **Assets** (Total assets beginning of year)
- **Revenue** (Total revenue)

### Grant Data
- **Recipient EIN**
- **Recipient Name**
- **Amount** (Grant amount)
- **Year** (Tax year)

### Bidirectional Tracking
- **Foundations**: Who they gave grants to
- **Organizations**: Who gave grants to them

## Configuration

### Change Years to Process

Edit `scripts/build-complete-grants-dataset.ts`:

```typescript
const YEARS = [2023, 2024]; // Add or remove years
```

### Test Mode (Process Fewer Files)

Edit `scripts/build-complete-grants-dataset.ts`:

```typescript
const TEST_MODE = true;  // Enable test mode
const TEST_LIMIT = 200;  // Process only 200 files per month
```

Useful for:
- Testing the pipeline
- Debugging XML parsing
- Faster iteration during development

### HLF EIN

The HLF EIN is configured in `scripts/filter-hlf-network.ts`:

```typescript
const HLF_EIN = '352338463'; // Hidden Leaf Foundation EIN
```

### Filter Discretionary Grants

Edit `scripts/filter-hlf-network.ts`:

```typescript
// Current logic: filters out single names with ≤ $10,000
const isSingleName = org.trim().split(/\s+/).length === 1;
if (isSingleName && parsedAmount <= 10000) return false;
```

This removes individual discretionary grants (e.g., "Tara $5,000") and keeps organizational grants.

## Year Filtering in UI

The app supports filtering by year in the UI:

1. Load the data (loads all years)
2. Select year from dropdown (2023, 2024, or All Years)
3. Click "Reload" to apply filter

Filtering happens **client-side** for fast switching between years.

## Cache Management

The build script caches monthly results to speed up reruns:

- **First run**: Downloads ZIPs, processes XMLs, caches results
- **Subsequent runs**: Loads from cache for processed months, only processes new months
- **Cache location**: `.cache/monthly/YEAR_month_N.json`
- **Clear cache**: `npm run clear-cache`

**Example workflow:**
```bash
# Process January-June 2024
npm run build-complete-dataset

# Later, add July-December 2024
# Cached months (1-6) load instantly!
# Only months 7-12 are processed
npm run build-complete-dataset
```

## Common Workflows

### Add a New Year (e.g., 2025)

1. Edit `scripts/build-complete-grants-dataset.ts`:
   ```typescript
   const YEARS = [2023, 2024, 2025];
   ```

2. Rebuild dataset (includes network):
   ```bash
   npm run build-complete-dataset
   ```

3. Add year to UI dropdown in `src/App.tsx`:
   ```tsx
   <option value="2025">2025</option>
   ```

### Update HLF Grantees

1. Edit `public/grants_list.csv` (add/remove rows)
2. Rebuild dataset:
   ```bash
   npm run build-complete-dataset
   ```
3. Reload browser

### Process Only Specific Months

Edit `scripts/build-complete-grants-dataset.ts`:

```typescript
for (let month = 1; month <= 5; month++) {  // Only Jan-May
  // ...
}
```

Then run:
```bash
npm run build-complete-dataset
```

### Start Fresh

```bash
npm run clear-cache
npm run build-complete-dataset
npm run dev
```

## Performance

- **Initial page load**: < 1 second (loads 1MB network data)
- **Year filtering**: Instant (client-side)
- **Build complete dataset & network**:
  - First run: Several hours (depends on internet speed)
  - With cache: Minutes (only new months)

## Tech Stack

- **React 19** + TypeScript
- **D3.js v7** for force-directed graph
- **Tailwind CSS 4** for styling
- **Vite 7** for fast dev server and build
- **xml2js** for parsing IRS XMLs
- **AdmZip** for extracting IRS ZIP files
- **PapaParse** for CSV parsing

## Troubleshooting

### "Failed to load network data"

**Solution:**
```bash
npm run build-complete-dataset
```

### Visualization looks wrong

1. Hard refresh browser (Cmd+Shift+R or Ctrl+Shift+R)
2. Rebuild dataset:
   ```bash
   npm run build-complete-dataset
   ```

### Out of memory during build

**Solutions:**
1. Enable test mode:
   ```typescript
   const TEST_MODE = true;
   const TEST_LIMIT = 500;  // Smaller limit
   ```

2. Process one year at a time:
   ```typescript
   const YEARS = [2024];  // Just one year
   ```

3. Process months in batches:
   ```typescript
   for (let month = 1; month <= 3; month++) {  // First 3 months
     // ...
   }
   ```
   Then run again for months 4-6, etc.

### Download timeouts

The script has a 10-minute timeout per download. If downloads fail:
1. Check internet connection
2. Try again (cached months skip automatically)
3. Reduce months processed at once

### No matches found for HLF grantees

**Possible causes:**
1. Grantee names in CSV don't match IRS 990 data exactly
2. Grantees haven't filed recent 990s
3. Grantees are individuals (filtered out)

**Solutions:**
1. Check exact name spelling in CSV
2. Adjust discretionary grant filter threshold
3. Check if organization has recent IRS filings

## Commands Summary

```bash
# Development
npm install              # Install dependencies
npm run dev             # Start dev server

# Data Pipeline
npm run build-complete-dataset  # Build dataset & network (hours)
npm run clear-cache             # Clear monthly cache

# Build for Production
npm run build           # Build React app
npm run preview         # Preview production build
```

## File Sizes

- `public/grants_list.csv`: ~10 KB (HLF grantees)
- `public/grants-network-data.json`: ~1 MB (filtered network)
- `data/complete-grants-dataset.json`: ~260 MB (full dataset)
- `.cache/monthly/`: ~10-30 MB per month file

## License

Internal use by Hidden Leaf Foundation.

## Support

For questions or issues:
1. Check this README
2. Review error messages (they're informative!)
3. Check the console for detailed logs
4. Clear cache and try again

---

**Last Updated**: October 2025
