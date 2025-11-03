/**
 * Build COMPLETE bidirectional grants dataset from IRS 990-PF bulk XML data.
 *
 * New Approach:
 * 1. Download monthly ZIP file from IRS
 * 2. Extract XMLs to disk
 * 3. Parse all 990-PFs locally
 * 4. Build complete bidirectional dataset
 * 5. Run in a few hours instead of days!
 *
 * Usage:
 * - Default (HLF): npm run build-complete-dataset
 * - Custom EIN: npm run build-complete-dataset -- --ein=123456789
 *
 * The custom EIN mode uses only IRS 990-PF data (no Excel file needed).
 * It builds a network with the specified foundation as the central node.
 */

import * as fs from 'fs';
import * as path from 'path';
import { createWriteStream } from 'fs';
import { finished } from 'stream/promises';
import { fileURLToPath } from 'url';
import { execFile } from 'child_process';
import axios from 'axios';
import { parseStringPromise } from 'xml2js';
import xlsx from 'xlsx';
import yauzl from 'yauzl';
import { pipeline } from 'stream';
import { promisify } from 'util';
import pLimit from 'p-limit';

const pipe = promisify(pipeline);
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// --- CONFIGURATION ---
const YEARS = [2023, 2024, 2025];
const TEST_MODE = false; // Set to true to process only a small number of filings
const TEST_LIMIT = 200;
const PROCESS_990 = true; // Set to true to also process Form 990 (public charities)
const CONCURRENCY_LIMIT = 20; // Number of concurrent XML file parsers
const BATCH_SIZE = 2000; // Process files in batches to control memory usage

// --- PATHS ---
const DATA_DIR = path.join(__dirname, '..', 'data', 'irs_bulk');
const CACHE_DIR = path.join(__dirname, '..', '.cache', 'monthly');
const OUTPUT_PATH = path.join(__dirname, '..', 'data', 'complete-grants-dataset.json');
const HLF_NETWORK_OUTPUT_PATH = path.join(__dirname, '..', 'public', 'grants-network-data.json');
const HLF_MASTER_EXCEL_PATH = path.join(__dirname, '..', 'public', 'master_grants_list.xlsx');
const XML_EXTRACT_PATH = path.join(DATA_DIR, 'xml');

const HLF_EIN = '352338463';

// Parse command-line arguments
const args = process.argv.slice(2);
const customEINArg = args.find(arg => arg.startsWith('--ein='));
const CUSTOM_EIN = customEINArg ? customEINArg.split('=')[1] : null;

interface Grant {
  recipientEIN: string;
  recipientName: string;
  amount: number;
  year: number;
  recipientCity?: string;
  recipientState?: string;
  recipientZip?: string;
}

interface Foundation {
  ein: string;
  name: string;
  grantsGiven: Grant[];
  metadata?: {
    address?: string;
    city?: string;
    state?: string;
    assets?: number;
    revenue?: number;
  };
}

interface Organization {
  ein: string;
  name: string;
  grantsReceived: Array<{
    funderEIN: string;
    funderName: string;
    amount: number;
    year: number;
  }>;
  metadata?: {
    address?: string;
    city?: string;
    state?: string;
  };
}

interface CompleteDataset {
  foundations: Record<string, Foundation>;
  organizations: Record<string, Organization>;
  metadata: {
    foundationsProcessed: number;
    totalGrants: number;
    generatedAt: string;
  };
}

/**
 * Ensure data directory exists
 */
function setupDirectory(isMonthly: boolean = true) {
  if (isMonthly) {
    if (fs.existsSync(DATA_DIR)) {
      fs.rmSync(DATA_DIR, { recursive: true, force: true });
    }
    fs.mkdirSync(XML_EXTRACT_PATH, { recursive: true });
  }
  if (!fs.existsSync(CACHE_DIR)) {
    fs.mkdirSync(CACHE_DIR, { recursive: true });
  }
}

/**
 * Download a file from a URL using streaming (handles large files)
 */
async function downloadFile(url: string, dest: string) {
  console.log(`⬇️  Downloading ${url}...`);

  // Delete any existing partial/corrupted file
  if (fs.existsSync(dest)) {
    fs.unlinkSync(dest);
  }

  try {
    const response = await axios({
      method: 'get',
      url: url,
      responseType: 'stream',
      timeout: 600000, // 10 minutes for large files
    });

    const totalLength = parseInt(response.headers['content-length'] || '0', 10);
    let downloadedLength = 0;
    let lastProgress = 0;

    const writer = createWriteStream(dest);

    response.data.on('data', (chunk: Buffer) => {
      downloadedLength += chunk.length;
      if (totalLength > 0) {
        const progress = Math.floor((downloadedLength / totalLength) * 100);
        if (progress >= lastProgress + 10) { // Log every 10%
          console.log(`   Progress: ${progress}% (${(downloadedLength / 1024 / 1024).toFixed(0)}MB / ${(totalLength / 1024 / 1024).toFixed(0)}MB)`);
          lastProgress = progress;
        }
      }
    });

    response.data.pipe(writer);

    await new Promise<void>((resolve, reject) => {
      writer.on('finish', () => resolve());
      writer.on('error', (err) => {
        // Clean up partial file on error
        fs.unlinkSync(dest);
        reject(err);
      });
      response.data.on('error', (err: any) => {
        writer.close();
        // Clean up partial file on error
        if (fs.existsSync(dest)) {
          fs.unlinkSync(dest);
        }
        reject(err);
      });
    });

    // Verify file size
    const stats = fs.statSync(dest);
    if (totalLength > 0 && stats.size !== totalLength) {
      fs.unlinkSync(dest); // Clean up bad file
      throw new Error(`Download incomplete: expected ${totalLength} bytes, got ${stats.size} bytes`);
    }

    console.log(`✅ Saved to ${dest} (${(stats.size / 1024 / 1024).toFixed(0)}MB)`);
  } catch (error) {
    // Ensure cleanup on any error
    if (fs.existsSync(dest)) {
      fs.unlinkSync(dest);
    }
    throw error;
  }
}

/**
 * Extract a ZIP file using system unzip command (handles all compression methods)
 */
async function extractZip(zipPath: string, dest: string) {
  console.log(`📦 Extracting ${zipPath}...`);

  if (!fs.existsSync(dest)) {
    fs.mkdirSync(dest, { recursive: true });
  }

  return new Promise<void>((resolve, reject) => {
    // Use system unzip command which supports all compression methods including deflate64
    execFile('unzip', ['-q', '-o', zipPath, '-d', dest], (error: any, stdout: any, stderr: any) => {
      if (error) {
        // Exit codes: 0=success, 1=warnings, 2=errors, 3=severe errors
        // Exit code 3 from corrupted ZIP files often still extracts 99.9% of files successfully
        // Check if files were actually extracted before failing
        if (error.code === 1 || error.code === 3) {
          console.log(`   ⚠️  Extraction completed with ${error.code === 1 ? 'warnings' : 'errors (but files extracted)'}`);

          // Verify files were extracted
          if (fs.existsSync(dest) && fs.readdirSync(dest).length > 0) {
            resolve();
          } else {
            reject(new Error(`Unzip failed - no files extracted: ${error.message}\n${stderr}`));
          }
        } else {
          reject(new Error(`Unzip failed: ${error.message}\n${stderr}`));
        }
      } else {
        resolve();
      }
    });
  });
}

/**
 * Parse a single XML file and extract grants if it is a 990-PF
 */
async function processXmlFile(filePath: string, year: number): Promise<{ funderEIN: string; funderName: string; grants: Grant[]; metadata?: any } | null> {
  try {
    const xmlContent = fs.readFileSync(filePath, 'utf-8');

    // Quick check for 990-PF to avoid parsing unnecessary files
    if (!xmlContent.includes('<IRS990PF')) {
      return null;
    }

    const data = await parseStringPromise(xmlContent);

    const root = data.Return?.ReturnData?.[0];
    const header = data.Return?.ReturnHeader?.[0];
    if (!root || !header || !root.IRS990PF) return null;

    const funderEIN = header.Filer?.[0]?.EIN?.[0];
    const funderName = header.Filer?.[0]?.BusinessName?.[0]?.BusinessNameLine1Txt?.[0] || `Foundation ${funderEIN}`;
    // Use the tax year from XML - this is when the grant actually occurred
    const taxYear = parseInt(header.TaxYr?.[0] || year.toString(), 10);

    // Extract metadata
    const usAddress = header.Filer?.[0]?.USAddress?.[0];
    const balanceSheet = root.IRS990PF?.[0]?.Form990PFBalanceSheetsGrp?.[0];
    const revenueExpenses = root.IRS990PF?.[0]?.AnalysisOfRevenueAndExpenses?.[0];

    const metadata = {
      address: usAddress?.AddressLine1Txt?.[0],
      city: usAddress?.CityNm?.[0],
      state: usAddress?.StateAbbreviationCd?.[0],
      assets: parseFloat(balanceSheet?.TotalAssetsEOYAmt?.[0] || balanceSheet?.TotalAssetsBOYAmt?.[0] || '0'),
      revenue: parseFloat(revenueExpenses?.TotalRevAndExpnssAmt?.[0] || '0')
    };

    const grants: Grant[] = [];

    const irs990pf = root.IRS990PF?.[0];
    const supplementaryInfo = irs990pf?.SupplementaryInformationGrp?.[0];

    const grantSections = supplementaryInfo?.GrantOrContributionPdDurYrGrp ||
                          irs990pf?.GrantOrContributionPdDurYrGrp ||
                          irs990pf?.GrantOrContribPaidDuringYear ||
                          [];

    for (const recipient of grantSections) {
      const recipientName = recipient.RecipientBusinessName?.[0]?.BusinessNameLine1Txt?.[0] ||
                            recipient.RecipientPersonNm?.[0] ||
                            recipient.RecipientOrganizationName?.[0] || '';
      const recipientEIN = recipient.RecipientEIN?.[0] || '';
      const amount = parseFloat(recipient.Amt?.[0] || recipient.Amount?.[0] || recipient.CashGrantAmt?.[0] || '0');

      // Extract address information
      const usAddress = recipient.RecipientUSAddress?.[0];
      const recipientCity = usAddress?.CityNm?.[0] || '';
      const recipientState = usAddress?.StateAbbreviationCd?.[0] || '';
      const recipientZip = usAddress?.ZIPCd?.[0] || '';

      if (recipientName && amount > 0) {
        grants.push({
          recipientEIN,
          recipientName,
          amount,
          year: taxYear,
          recipientCity,
          recipientState,
          recipientZip
        });
      }
    }

    return { funderEIN, funderName, grants, metadata };
  } catch (error: any) {
    console.warn(`  ⚠️  Skipping file ${path.basename(filePath)} due to parsing error: ${error.message}`);
    return null;
  }
}

/**
 * Parse Form 990 XML file for organization data
 * Returns organization metadata (no grants given, only received if reported)
 */
async function parseXML990File(filePath: string, year: number): Promise<{ ein: string; name: string; metadata: any } | null> {
  try {
    const xmlContent = fs.readFileSync(filePath, 'utf-8');

    // Quick check for 990 to avoid parsing 990-PF files
    if (!xmlContent.includes('<IRS990') || xmlContent.includes('<IRS990PF')) {
      return null;
    }

    const data = await parseStringPromise(xmlContent);

    const root = data.Return?.ReturnData?.[0];
    const header = data.Return?.ReturnHeader?.[0];
    if (!root || !header || !root.IRS990) return null;

    const ein = header.Filer?.[0]?.EIN?.[0];
    const name = header.Filer?.[0]?.BusinessName?.[0]?.BusinessNameLine1Txt?.[0] ||
                 header.Filer?.[0]?.BusinessName?.[0]?.BusinessNameLine1?.[0] ||
                 `Organization ${ein}`;

    // Extract metadata
    const usAddress = header.Filer?.[0]?.USAddress?.[0] || root.IRS990?.[0]?.PrincipalOfficeUSAddress?.[0];
    const irs990 = root.IRS990?.[0];

    const metadata = {
      address: usAddress?.AddressLine1Txt?.[0] || usAddress?.AddressLine1?.[0],
      city: usAddress?.CityNm?.[0] || usAddress?.City?.[0],
      state: usAddress?.StateAbbreviationCd?.[0] || usAddress?.State?.[0],
      assets: parseFloat(irs990?.TotalAssetsEOYAmt?.[0] || irs990?.Form990PartVIISectionAGrp?.[0]?.TotalAssetsEOYAmt?.[0] || '0'),
      revenue: parseFloat(irs990?.CYTotalRevenueAmt?.[0] || irs990?.TotalRevenueCurrentYearAmt?.[0] || '0')
    };

    return { ein, name, metadata };
  } catch (error: any) {
    // Silently skip parsing errors for 990s (many format variations)
    return null;
  }
}

/**
 * Normalize organization name for fuzzy matching
 */
function normalizeOrgName(name: string): string {
  return name
    .toLowerCase()
    .replace(/\b(inc|incorporated|llc|ltd|limited|corp|corporation|foundation|fund|trust|the|a|an)\b/g, '')
    .replace(/[^a-z0-9]+/g, '')
    .trim();
}

/**
 * Builds a bidirectional dataset of foundations and the organizations they fund.
 * This version is corrected to handle very large arrays of grants without causing a stack overflow.
 * @param allGrantsData An array of funder data, each containing their grants.
 * @returns A complete dataset object.
 */
function buildBidirectionalDataset(
  allGrantsData: Array<{ funderEIN: string; funderName: string; grants: Grant[]; metadata?: any }>
): CompleteDataset {
  const dataset: CompleteDataset = {
    foundations: {},
    organizations: {},
    metadata: {
      foundationsProcessed: 0,
      totalGrants: 0,
      generatedAt: new Date().toISOString()
    }
  };

  let totalGrants = 0;

  for (const { funderEIN, funderName, grants, metadata } of allGrantsData) {
    if (!funderEIN) continue;

    // Merge or create foundation entry
    if (!dataset.foundations[funderEIN]) {
      dataset.foundations[funderEIN] = {
        ein: funderEIN,
        name: funderName,
        grantsGiven: [],
        metadata
      };
    }

    // --- FIX IS HERE ---
    // The original code used: .push(...grants)
    // That can cause a stack overflow if the 'grants' array is very large because
    // it treats each item as a separate function argument.
    // Using .concat() is a safer way to merge large arrays.
    dataset.foundations[funderEIN].grantsGiven = dataset.foundations[funderEIN].grantsGiven.concat(grants);

    totalGrants += grants.length;

    for (const grant of grants) {
      // Use a fallback for recipient EIN to ensure every grant is processed
      // Use same normalization as network builder for consistency
      let recipientEIN = grant.recipientEIN;
      if (!recipientEIN || recipientEIN === '' || recipientEIN.startsWith('unknown_')) {
        const normalized = normalizeOrgName(grant.recipientName);
        recipientEIN = `no_ein_${normalized}`;
      }

      if (!dataset.organizations[recipientEIN]) {
        dataset.organizations[recipientEIN] = {
          ein: recipientEIN,
          name: grant.recipientName,
          grantsReceived: []
        };
      }

      dataset.organizations[recipientEIN].grantsReceived.push({
        funderEIN,
        funderName,
        amount: grant.amount,
        year: grant.year
      });
    }
  }

  dataset.metadata.foundationsProcessed = Object.keys(dataset.foundations).length;
  dataset.metadata.totalGrants = totalGrants;
  return dataset;
}

/**
 * Writes a large CompleteDataset object to a JSON file using a stream to avoid memory issues.
 * This avoids the 'RangeError: Invalid string length' by not calling JSON.stringify() on the entire object at once.
 * @param dataset The complete dataset object returned from buildBidirectionalDataset.
 * @param filePath The path to the output JSON file.
 * @returns A promise that resolves when the file has been completely written.
 */
async function streamDatasetToFile(dataset: CompleteDataset, filePath: string): Promise<void> {
  console.log(`\n💾 Streaming final dataset to ${filePath}...`);
  const stream = createWriteStream(filePath, { encoding: 'utf8' });

  // Start the JSON object
  stream.write('{\n');

  // Stream the 'foundations' object
  stream.write('"foundations": {\n');
  const foundationKeys = Object.keys(dataset.foundations);
  foundationKeys.forEach((key, index) => {
    const foundation = dataset.foundations[key];
    const comma = index < foundationKeys.length - 1 ? ',' : '';
    // Stringify each foundation individually
    stream.write(`"${key}": ${JSON.stringify(foundation)}${comma}\n`);
  });
  stream.write('},\n');

  // Stream the 'organizations' object
  stream.write('"organizations": {\n');
  const orgKeys = Object.keys(dataset.organizations);
  orgKeys.forEach((key, index) => {
    const org = dataset.organizations[key];
    const comma = index < orgKeys.length - 1 ? ',' : '';
    // Stringify each organization individually
    stream.write(`"${key}": ${JSON.stringify(org)}${comma}\n`);
  });
  stream.write('},\n');

  // Write the final metadata object
  stream.write(`"metadata": ${JSON.stringify(dataset.metadata)}\n`);

  // Close the JSON object
  stream.write('}\n');

  // End the stream
  stream.end();

  // Wait for the stream to finish writing all data to the file
  await finished(stream);
  console.log('✅ Dataset streaming complete.');
}

/**
 * Load HLF grants from Excel master file
 */
function loadHLFGrantsFromExcel(): Array<{ organization: string; amount: number; year: number }> {
  console.log(`📊 Reading HLF grants from ${HLF_MASTER_EXCEL_PATH}...`);

  const workbook = xlsx.readFile(HLF_MASTER_EXCEL_PATH);
  const allGrants: Array<{ organization: string; amount: number; year: number }> = [];

  // Map sheet names to years
  const sheetYearMap: Record<string, number> = {
    '2020': 2020,
    '2021': 2021,
    '2022': 2022,
    '2023': 2023,
    '2024': 2024,
    '2025 DRAFT': 2025
  };

  for (const [sheetName, year] of Object.entries(sheetYearMap)) {
    if (!workbook.SheetNames.includes(sheetName)) {
      console.log(`   ⚠️  Sheet "${sheetName}" not found, skipping...`);
      continue;
    }

    const sheet = workbook.Sheets[sheetName];
    const data: any[] = xlsx.utils.sheet_to_json(sheet);

    const grants = data
      .filter((row: any) => {
        const org = row.Organization || '';
        const amount = row[`${year} Amount`] || row['2025 Amount'] || ''; // Handle different column names

        if (!org || !amount) return false;
        if (org === 'Discretionary Grants' || org === 'Mini grants for Storytelling') return false;

        const parsedAmount = parseFloat((String(amount) || '0').replace(/[$,]/g, '')) || 0;
        const isSingleName = org.trim().split(/\s+/).length === 1;
        if (isSingleName && parsedAmount <= 10000) return false;

        return true;
      })
      .map((row: any) => {
        const amount = row[`${year} Amount`] || row['2025 Amount'] || '';
        return {
          organization: row.Organization,
          amount: parseFloat((String(amount) || '0').replace(/[$,]/g, '')) || 0,
          year
        };
      });

    console.log(`   Found ${grants.length} grants from ${year} (sheet: ${sheetName})`);
    allGrants.push(...grants);
  }

  return allGrants;
}

/**
 * Build HLF network from complete dataset
 */
async function buildHLFNetwork(dataset: CompleteDataset): Promise<{ nodes: any[]; links: any[] }> {
  console.log('\n🕸️  Building HLF network from complete dataset...');

  // Load HLF grantees from Excel master file (all years)
  const allHLFGrantees = loadHLFGrantsFromExcel();

  console.log(`   Total HLF grants loaded: ${allHLFGrantees.length}`);

  // Build lookup structures - group grants by organization name
  const hlfGrantsByOrg = new Map<string, Array<{ amount: number; year: number }>>();
  const hlfGranteeNames = new Set<string>();

  for (const grant of allHLFGrantees) {
    const normalizedName = grant.organization.toLowerCase().trim();
    hlfGranteeNames.add(normalizedName);

    if (!hlfGrantsByOrg.has(normalizedName)) {
      hlfGrantsByOrg.set(normalizedName, []);
    }
    hlfGrantsByOrg.get(normalizedName)!.push({ amount: grant.amount, year: grant.year });
  }

  const nodes: any[] = [];
  const links: any[] = [];
  const addedNodes = new Set<string>();

  // Add HLF node
  const hlfId = 'hlf';
  nodes.push({ id: hlfId, name: 'Hidden Leaf Foundation', type: 'funder', central: true });
  addedNodes.add(hlfId);

  // Find unmatched grantees (in CSV but not in IRS data)
  const unmatchedGrantees: Array<{ organization: string; amount: number; year: number }> = [];

  for (const hlfGrant of allHLFGrantees) {
    const normalizedName = hlfGrant.organization.toLowerCase().trim();
    let foundInDataset = false;

    for (const org of Object.values(dataset.organizations)) {
      if (org.name.toLowerCase().trim() === normalizedName) {
        foundInDataset = true;
        break;
      }
    }

    if (!foundInDataset) {
      unmatchedGrantees.push(hlfGrant);
    }
  }

  // Count unique unmatched grantees
  const uniqueUnmatchedOrgs = new Set(unmatchedGrantees.map(g => g.organization.toLowerCase().trim()));
  console.log(`   Found ${hlfGranteeNames.size - uniqueUnmatchedOrgs.size} unique HLF grantees in IRS dataset`);
  console.log(`   Adding ${uniqueUnmatchedOrgs.size} unique HLF grantees not in IRS data`);

  // Add unmatched grantees - group by organization
  const unmatchedByOrg = new Map<string, Array<{ amount: number; year: number }>>();
  for (const grantee of unmatchedGrantees) {
    const normalizedName = grantee.organization.toLowerCase().trim();
    if (!unmatchedByOrg.has(normalizedName)) {
      unmatchedByOrg.set(normalizedName, []);
    }
    unmatchedByOrg.get(normalizedName)!.push({ amount: grantee.amount, year: grantee.year });
  }

  for (const [normalizedName, grants] of unmatchedByOrg.entries()) {
    const granteeId = `hlf_grantee_${normalizedName.replace(/\s+/g, '_')}`;
    const originalName = unmatchedGrantees.find(g => g.organization.toLowerCase().trim() === normalizedName)!.organization;

    const grantsReceived = grants.map(g => ({
      funderEIN: 'hlf',
      funderName: 'Hidden Leaf Foundation',
      amount: g.amount,
      year: g.year
    }));

    nodes.push({
      id: granteeId,
      name: originalName,
      type: 'grantee',
      amount: grants.reduce((sum, g) => sum + g.amount, 0), // Total amount
      grantsReceived
    });
    addedNodes.add(granteeId);

    // Add a link for each grant (different years)
    for (const grant of grants) {
      links.push({
        source: hlfId,
        target: granteeId,
        amount: grant.amount,
        type: 'hlf-grant',
        year: grant.year
      });
    }
  }

  // Add matched grantees and their other funders
  let matchedGrantees = 0;

  for (const [orgEIN, org] of Object.entries(dataset.organizations)) {
    const normalizedName = org.name.toLowerCase().trim();

    if (hlfGranteeNames.has(normalizedName)) {
      const hlfGrants = hlfGrantsByOrg.get(normalizedName) || [];
      matchedGrantees++;

      if (!addedNodes.has(orgEIN)) {
        const totalHLFAmount = hlfGrants.reduce((sum, g) => sum + g.amount, 0);

        // Merge HLF grants with IRS grants received
        const allGrantsReceived = [
          ...hlfGrants.map(g => ({
            funderEIN: 'hlf',
            funderName: 'Hidden Leaf Foundation',
            amount: g.amount,
            year: g.year
          })),
          ...(org.grantsReceived || [])
        ];

        nodes.push({
          id: orgEIN,
          name: org.name,
          type: 'grantee',
          amount: totalHLFAmount,
          metadata: org.metadata,
          grantsReceived: allGrantsReceived
        });
        addedNodes.add(orgEIN);
      }

      // Add a link for each HLF grant (different years)
      for (const grant of hlfGrants) {
        links.push({
          source: hlfId,
          target: orgEIN,
          amount: grant.amount,
          type: 'hlf-grant',
          year: grant.year
        });
      }

      // Add other funders
      for (const grant of org.grantsReceived || []) {
        const funderEIN = grant.funderEIN;

        if (funderEIN === HLF_EIN) continue;

        if (!addedNodes.has(funderEIN)) {
          const funderData = dataset.foundations[funderEIN];
          nodes.push({
            id: funderEIN,
            name: grant.funderName,
            type: 'funder',
            metadata: funderData?.metadata,
            grantsGiven: funderData?.grantsGiven || []
          });
          addedNodes.add(funderEIN);
        }

        links.push({
          source: funderEIN,
          target: orgEIN,
          amount: grant.amount,
          type: 'other-funder',
          year: grant.year
        });
      }
    }
  }

  console.log(`   Matched ${matchedGrantees} HLF grantees in IRS dataset`);

  const grantees = nodes.filter(n => n.type === 'grantee').length;
  const funders = nodes.filter(n => n.type === 'funder').length;

  console.log('\n📊 HLF Network Statistics:');
  console.log(`   Nodes: ${nodes.length}`);
  console.log(`   Links: ${links.length}`);
  console.log(`   Grantees: ${grantees}`);
  console.log(`   Other Funders: ${funders}`);

  return { nodes, links };
}

/**
 * Build a lookup index from organization names to EINs
 */
function buildNameToEINIndex(dataset: CompleteDataset): Map<string, string[]> {
  const nameIndex = new Map<string, string[]>();

  // Index all organizations
  for (const [ein, org] of Object.entries(dataset.organizations)) {
    const normalizedName = normalizeOrgName(org.name);
    if (!nameIndex.has(normalizedName)) {
      nameIndex.set(normalizedName, []);
    }
    nameIndex.get(normalizedName)!.push(ein);
  }

  return nameIndex;
}

/**
 * Build network for a custom EIN (using IRS data only, no Excel file)
 */
async function buildCustomEINNetwork(dataset: CompleteDataset, centralEIN: string): Promise<{ nodes: any[]; links: any[] }> {
  console.log(`\n🕸️  Building network for EIN ${centralEIN}...`);

  const nodes: any[] = [];
  const links: any[] = [];
  const addedNodes = new Set<string>();

  // Get the central foundation's data
  const centralFoundation = dataset.foundations[centralEIN];
  if (!centralFoundation) {
    throw new Error(`Foundation with EIN ${centralEIN} not found in dataset`);
  }

  console.log(`   Found foundation: ${centralFoundation.name}`);
  console.log(`   Total grants given: ${centralFoundation.grantsGiven?.length || 0}`);

  // Build name lookup index for matching grantees without EINs
  console.log(`   Building name-to-EIN lookup index...`);
  const nameIndex = buildNameToEINIndex(dataset);
  console.log(`   Index contains ${nameIndex.size} unique normalized names`);

  // Add central foundation node
  const centralId = centralEIN;
  nodes.push({
    id: centralId,
    name: centralFoundation.name,
    type: 'funder',
    central: true, // Mark as central node for visualization
    metadata: centralFoundation.metadata
  });
  addedNodes.add(centralId);

  // Track grantees of the central foundation
  const centralGranteeIds = new Set<string>();
  const grantsGiven = centralFoundation.grantsGiven || [];

  console.log(`   Processing ${grantsGiven.length} grants from central foundation...`);

  // Group grants by recipient EIN to avoid duplicate links
  const grantsByRecipient = new Map<string, Grant[]>();
  let grantsWithoutEIN = 0;
  let matchedByName = 0;
  let multipleMatches = 0;

  grantsGiven.forEach(grant => {
    let ein = grant.recipientEIN;

    // If no EIN, try to match by name (and address if multiple matches)
    if (!ein || ein === '' || ein === 'unknown' || ein.startsWith('unknown_')) {
      grantsWithoutEIN++;

      // Try to find matching organization by normalized name
      const normalizedName = normalizeOrgName(grant.recipientName);
      const matches = nameIndex.get(normalizedName);

      if (matches && matches.length === 1) {
        // Single match found - use it
        ein = matches[0];
        matchedByName++;
      } else if (matches && matches.length > 1) {
        // Multiple matches - use address to disambiguate
        let bestMatch = matches[0]; // Default to first match

        if (grant.recipientCity && grant.recipientState) {
          // Try to find match by city + state + zip
          for (const candidateEIN of matches) {
            const org = dataset.organizations[candidateEIN];
            if (org?.metadata) {
              const cityMatch = org.metadata.city?.toUpperCase() === grant.recipientCity.toUpperCase();
              const stateMatch = org.metadata.state?.toUpperCase() === grant.recipientState.toUpperCase();

              if (cityMatch && stateMatch) {
                bestMatch = candidateEIN;
                break;
              }
            }
          }
        }

        ein = bestMatch;
        matchedByName++;
        multipleMatches++;
      } else {
        // No match - create placeholder ID
        ein = `no_ein_${normalizedName}`;
      }
    }

    if (!grantsByRecipient.has(ein)) {
      grantsByRecipient.set(ein, []);
    }
    grantsByRecipient.get(ein)!.push(grant);
  });

  console.log(`   ${grantsWithoutEIN} grants had no EIN in source data`);
  console.log(`   ${matchedByName} matched to organizations by name (${multipleMatches} had multiple matches)`);
  console.log(`   Found ${grantsByRecipient.size} unique recipients`);

  let matchedInIRS = 0;
  let addedAsNodes = 0;

  // Add grantees and their links
  for (const [recipientEIN, grants] of grantsByRecipient.entries()) {
    centralGranteeIds.add(recipientEIN);
    const recipientOrg = dataset.organizations[recipientEIN];
    const firstGrant = grants[0];

    if (recipientOrg) {
      matchedInIRS++;
    }

    if (!addedNodes.has(recipientEIN)) {
      nodes.push({
        id: recipientEIN,
        name: recipientOrg?.name || firstGrant.recipientName,
        type: 'grantee',
        amount: grants.reduce((sum, g) => sum + g.amount, 0),
        metadata: recipientOrg?.metadata,
        grantsReceived: recipientOrg?.grantsReceived || grants.map(g => ({
          funderEIN: centralEIN,
          funderName: centralFoundation.name,
          amount: g.amount,
          year: g.year
        }))
      });
      addedNodes.add(recipientEIN);
      addedAsNodes++;
    }

    // Add links for each grant (different years)
    for (const grant of grants) {
      links.push({
        source: centralId,
        target: recipientEIN,
        amount: grant.amount,
        type: 'hlf-grant',
        year: grant.year
      });
    }

    // Add other funders of this grantee
    if (recipientOrg && recipientOrg.grantsReceived) {
      for (const grant of recipientOrg.grantsReceived) {
        const funderEIN = grant.funderEIN;

        // Skip if it's the central foundation itself
        if (funderEIN === centralEIN) continue;

        if (!addedNodes.has(funderEIN)) {
          const funderData = dataset.foundations[funderEIN];
          nodes.push({
            id: funderEIN,
            name: grant.funderName,
            type: 'funder',
            metadata: funderData?.metadata,
            grantsGiven: funderData?.grantsGiven || []
          });
          addedNodes.add(funderEIN);
        }

        links.push({
          source: funderEIN,
          target: recipientEIN,
          amount: grant.amount,
          type: 'other-funder',
          year: grant.year
        });
      }
    }
  }

  console.log(`   Added ${addedAsNodes} grantees to network`);
  console.log(`   ${matchedInIRS} found in IRS dataset (have 990-PF filings)`);

  const grantees = nodes.filter(n => n.type === 'grantee').length;
  const funders = nodes.filter(n => n.type === 'funder').length;

  console.log('\n📊 Network Statistics:');
  console.log(`   Nodes: ${nodes.length}`);
  console.log(`   Links: ${links.length}`);
  console.log(`   Grantees: ${grantees}`);
  console.log(`   Other Funders: ${funders}`);

  return { nodes, links };
}

/**
 * Stream network data to file
 */
async function streamHLFNetworkToFile(networkData: { nodes: any[]; links: any[] }, filePath: string): Promise<void> {
  console.log(`\n💾 Streaming network to ${filePath}...`);
  fs.writeFileSync(filePath, JSON.stringify(networkData, null, 2));
  console.log('✅ Network saved.');
}

/**
 * Main
 */
async function main() {
  const startTime = Date.now();

  if (CUSTOM_EIN) {
    console.log(`🚀 Building Grants Network for Custom EIN: ${CUSTOM_EIN}`);
  } else {
    console.log('🚀 Building COMPLETE Bidirectional Grants Dataset from IRS Bulk Data');
  }
  console.log(`📅 Processing years: ${YEARS.join(', ')}`);
  console.log('');
  console.log('═'.repeat(60));

  setupDirectory(false);

  const allGrantsData: Array<{ funderEIN: string; funderName: string; grants: Grant[]; metadata?: any }> = [];
  const allOrgData: Array<{ ein: string; name: string; metadata: any }> = [];

  for (const year of YEARS) {
    console.log(`\n🗓️  === PROCESSING YEAR ${year} ===\n`);

    // Process months in parallel chunks of 3 to balance speed and memory
    const MONTHS_PER_CHUNK = 3;
    for (let chunkStart = 1; chunkStart <= 12; chunkStart += MONTHS_PER_CHUNK) {
      const chunkEnd = Math.min(chunkStart + MONTHS_PER_CHUNK - 1, 12);
      const monthsInChunk = [];
      for (let m = chunkStart; m <= chunkEnd; m++) {
        monthsInChunk.push(m);
      }

      console.log(`\n📦 Processing months ${chunkStart}-${chunkEnd} in parallel...`);

      // Process this chunk of months in parallel
      await Promise.all(monthsInChunk.map(async (month) => {
        console.log(`        --- Processing ${year} Month: ${month} ---`);

        const cachePath = path.join(CACHE_DIR, `${year}_month_${month}.json`);
        const orgCachePath = path.join(CACHE_DIR, `${year}_month_${month}_orgs.json`);

        if (fs.existsSync(cachePath)) {
          console.log(`✅ Loading month ${month} from cache...`);
        const cachedData = JSON.parse(fs.readFileSync(cachePath, 'utf-8'));
        allGrantsData.push(...cachedData);

        if (PROCESS_990 && fs.existsSync(orgCachePath)) {
          const cachedOrgData = JSON.parse(fs.readFileSync(orgCachePath, 'utf-8'));
          allOrgData.push(...cachedOrgData);
        }
        return;  // Skip processing if cached
      }

        // Use unique directory per month to avoid conflicts in parallel processing
        const monthDataDir = path.join(__dirname, '..', 'data', 'irs_bulk', `${year}_month_${month}`);
        const IRS_MONTHLY_ZIP_URL = `https://apps.irs.gov/pub/epostcard/990/xml/${year}/${year}_TEOS_XML_${String(month).padStart(2, '0')}A.zip`;
        const monthlyGrantsData: Array<{ funderEIN: string; funderName: string; grants: Grant[]; metadata?: any }> = [];

    try {
        // Setup unique directory for this month
        if (fs.existsSync(monthDataDir)) {
          fs.rmSync(monthDataDir, { recursive: true, force: true });
        }
        fs.mkdirSync(monthDataDir, { recursive: true });

        const zipPath = path.join(monthDataDir, path.basename(IRS_MONTHLY_ZIP_URL));

        await downloadFile(IRS_MONTHLY_ZIP_URL, zipPath);

        const zipFileName = path.basename(IRS_MONTHLY_ZIP_URL, '.zip');
        const monthExtractPath = path.join(monthDataDir, 'xml');
        fs.mkdirSync(monthExtractPath, { recursive: true });
        const extractedSubdir = path.join(monthExtractPath, zipFileName);

        await extractZip(zipPath, extractedSubdir);

        // Check what actually got extracted - try nested dir first, then extractedSubdir
        const nestedDir = path.join(extractedSubdir, zipFileName);
        let xmlDir: string;

        if (fs.existsSync(nestedDir)) {
          xmlDir = nestedDir;
        } else if (fs.existsSync(extractedSubdir)) {
          // Check if XML files are directly in extractedSubdir
          const filesInExtracted = fs.readdirSync(extractedSubdir);
          const xmlFilesInExtracted = filesInExtracted.filter(f => f.endsWith('.xml'));

          if (xmlFilesInExtracted.length > 0) {
            console.log(`   ℹ️  Files extracted directly to ${path.basename(extractedSubdir)}`);
            xmlDir = extractedSubdir;
          } else {
            // Check subdirectories
            const subdirs = filesInExtracted.filter(f => {
              const fullPath = path.join(extractedSubdir, f);
              return fs.statSync(fullPath).isDirectory();
            });

            if (subdirs.length > 0) {
              // Use the first subdirectory that contains XML files
              const subdirWithXml = subdirs.find(subdir => {
                const subdirPath = path.join(extractedSubdir, subdir);
                const files = fs.readdirSync(subdirPath);
                return files.some(f => f.endsWith('.xml'));
              });

              if (subdirWithXml) {
                xmlDir = path.join(extractedSubdir, subdirWithXml);
                console.log(`   ℹ️  Found XML files in subdirectory: ${subdirWithXml}`);
              } else {
                throw new Error(`Extraction failed - no XML files found in ${extractedSubdir} or subdirectories`);
              }
            } else {
              throw new Error(`Extraction failed - no XML files or subdirectories found in ${extractedSubdir}`);
            }
          }
        } else {
          throw new Error(`Extraction failed - directory not found: ${extractedSubdir}`);
        }

        let allXmlFiles = fs.readdirSync(xmlDir)
          .filter(file => file.endsWith('.xml'))
          .map(file => path.join(xmlDir, file));

        if (TEST_MODE) {
          console.log(`⚠️  TEST MODE: Processing only ${TEST_LIMIT} of ${allXmlFiles.length} filings.`);
          allXmlFiles = allXmlFiles.slice(0, TEST_LIMIT);
        }

        console.log(`🔍 Processing ${allXmlFiles.length} XML files for month ${month} (${CONCURRENCY_LIMIT} concurrent, batches of ${BATCH_SIZE})...`);
        let processedCount = 0;
        let pfCount = 0;
        let orgCount = 0;

        // Process in batches to control memory
        const limit = pLimit(CONCURRENCY_LIMIT);

        // Define result types for clarity
        type PFResult = { type: 'pf'; data: { funderEIN: string; funderName: string; grants: Grant[]; metadata?: any } };
        type OrgResult = { type: 'org'; data: { ein: string; name: string; metadata: any } };
        type BatchResult = PFResult | OrgResult | null;

        // Open file stream for org data - write incrementally instead of accumulating in memory
        let orgFileStream: fs.WriteStream | null = null;
        if (PROCESS_990) {
          orgFileStream = fs.createWriteStream(orgCachePath);
          orgFileStream.write('[\n');
        }

        for (let batchStart = 0; batchStart < allXmlFiles.length; batchStart += BATCH_SIZE) {
          const batchEnd = Math.min(batchStart + BATCH_SIZE, allXmlFiles.length);
          const batchFiles = allXmlFiles.slice(batchStart, batchEnd);

          console.log(`  Processing batch ${Math.floor(batchStart / BATCH_SIZE) + 1}/${Math.ceil(allXmlFiles.length / BATCH_SIZE)} (${batchFiles.length} files)...`);

          // Process files in parallel within this batch
          const batchPromises = batchFiles.map(xmlPath =>
            limit(async (): Promise<BatchResult> => {
              // Try parsing as 990-PF first
              const pfResult = await processXmlFile(xmlPath, year);

              if (pfResult) {
                if (pfResult.grants.length > 0) {
                  return { type: 'pf' as const, data: pfResult };
                }
                // 990-PF with no grants, don't try to parse as 990
                return null;
              }

              // If PROCESS_990 is enabled and it wasn't a 990-PF, try parsing as 990
              if (PROCESS_990) {
                const orgResult = await parseXML990File(xmlPath, year);
                if (orgResult) {
                  return { type: 'org' as const, data: orgResult };
                }
              }

              return null;
            })
          );

          // Wait for batch to complete
          const batchResults = await Promise.all(batchPromises);

          // Collect results and write orgs incrementally to avoid memory buildup
          for (const result of batchResults) {
            if (result) {
              if (result.type === 'pf') {
                monthlyGrantsData.push(result.data);
                pfCount++;
              } else if (result.type === 'org' && orgFileStream) {
                // Write directly to stream instead of accumulating in array
                if (orgCount > 0) orgFileStream.write(',\n');
                orgFileStream.write(JSON.stringify(result.data));
                orgCount++;
              }
            }
          }

          processedCount += batchFiles.length;
          console.log(`  ...processed ${processedCount} of ${allXmlFiles.length} files (${pfCount} 990-PF, ${orgCount} 990)`);
        }

        // Close org stream if open
        if (orgFileStream) {
          orgFileStream.write('\n]');
          await new Promise<void>((resolve, reject) => {
            orgFileStream!.end(() => resolve());
            orgFileStream!.on('error', reject);
          });
        }

        console.log(`✅ XML Processing complete for month ${month}!`);
        console.log(`   Processed ${processedCount} total XML files.`);
        console.log(`   Found ${pfCount} 990-PF filings (foundations).`);
        if (PROCESS_990) {
          console.log(`   Found ${orgCount} Form 990 filings (organizations).`);
        }

        fs.writeFileSync(cachePath, JSON.stringify(monthlyGrantsData, null, 2));
        console.log(`✅ Cached month ${month} grants data to ${cachePath}`);
        allGrantsData.push(...monthlyGrantsData);

        if (PROCESS_990 && orgCount > 0) {
          console.log(`✅ Cached ${orgCount} orgs to ${orgCachePath}`);
          // Load org data from the file we just wrote (streaming avoided memory, but we need it for merging)
          const orgData = JSON.parse(fs.readFileSync(orgCachePath, 'utf-8'));
          allOrgData.push(...orgData);
        }

        } catch (error: any) {
          // Check if it's a 404 error (month doesn't exist yet)
          const is404 = error?.response?.status === 404 ||
                        (error?.code === 'ERR_BAD_REQUEST' && error?.config?.url?.includes('TEOS_XML'));

          if (is404) {
            console.log(`\n⏭️  Skipping ${year} month ${month} - data not available yet (404)`);
          } else {
            console.log(`\n❌ Fatal error during ${year} month ${month}:`, error);
          }
        } finally {
          if (fs.existsSync(monthDataDir)) {
            console.log(`\n🧹 Cleaning up downloaded files for ${year} month ${month}...`);
            fs.rmSync(monthDataDir, { recursive: true, force: true });
            console.log('✅ Cleanup complete.');
          }
        }
        }));  // end Promise.all for parallel months
    }  // end chunks loop
  }  // end year loop

  console.log('\n🕸️  Building final bidirectional dataset...');
  const dataset = buildBidirectionalDataset(allGrantsData);

  // Merge Form 990 organization data into dataset
  if (PROCESS_990 && allOrgData.length > 0) {
    console.log(`\n📝 Merging ${allOrgData.length} Form 990 organizations into dataset...`);
    let added = 0;
    let updated = 0;

    for (const org of allOrgData) {
      if (!org.ein) continue;

      if (!dataset.organizations[org.ein]) {
        // Add new organization from Form 990
        dataset.organizations[org.ein] = {
          ein: org.ein,
          name: org.name,
          grantsReceived: [],
          metadata: org.metadata
        };
        added++;
      } else {
        // Update existing organization's metadata if it's missing
        if (!dataset.organizations[org.ein].metadata) {
          dataset.organizations[org.ein].metadata = org.metadata;
          updated++;
        }
      }
    }

    console.log(`   Added ${added} new organizations from Form 990`);
    console.log(`   Updated ${updated} existing organizations with Form 990 metadata`);

    // Consolidate placeholder entries with real EINs
    console.log(`\n🔗 Consolidating placeholder entries with real EINs...`);
    const nameIndex = buildNameToEINIndex(dataset);
    let consolidated = 0;

    const placeholderKeys = Object.keys(dataset.organizations).filter(k => k.startsWith('no_ein_'));
    for (const placeholderKey of placeholderKeys) {
      const org = dataset.organizations[placeholderKey];
      const normalizedName = normalizeOrgName(org.name);

      // Try to find a real EIN match
      const matches = nameIndex.get(normalizedName);
      if (matches && matches.length > 0) {
        // Find the first match that's NOT a placeholder
        const realEIN = matches.find(ein => !ein.startsWith('no_ein_'));
        if (realEIN && realEIN !== placeholderKey) {
          // Merge grantsReceived into the real entry
          if (dataset.organizations[realEIN]) {
            dataset.organizations[realEIN].grantsReceived.push(...org.grantsReceived);
            consolidated++;
          }
          // Delete the placeholder entry
          delete dataset.organizations[placeholderKey];
        }
      }
    }
    console.log(`   Consolidated ${consolidated} placeholder entries into real EINs`);
  }

  console.log(`
📊 Final Dataset Statistics:`);
  console.log(`   Foundations: ${Object.keys(dataset.foundations).length}`);
  console.log(`   Organizations (recipients): ${Object.keys(dataset.organizations).length}`);
  console.log(`   Total grants: ${dataset.metadata.totalGrants}`);

  // Build network BEFORE streaming complete dataset to avoid re-reading large file
  let network: { nodes: any[]; links: any[] };
  if (CUSTOM_EIN) {
    network = await buildCustomEINNetwork(dataset, CUSTOM_EIN);
  } else {
    network = await buildHLFNetwork(dataset);
  }
  await streamHLFNetworkToFile(network, HLF_NETWORK_OUTPUT_PATH);

  // Stream complete dataset to file
  await streamDatasetToFile(dataset, OUTPUT_PATH);
  console.log(`
    💾 Complete dataset saved to: ${OUTPUT_PATH}
    💾 Network saved to: ${HLF_NETWORK_OUTPUT_PATH}
  `);

  const endTime = Date.now();
  console.log(`
✨ Done in ${((endTime - startTime) / 1000 / 60).toFixed(1)} minutes!`);
}

main().catch(error => {
  console.error('\n❌ Fatal error during execution:', error);
  process.exit(1);
});
