/**
 * Debug script to analyze no_ein_ entries and improve EIN reconciliation
 *
 * This script:
 * 1. Loads the complete dataset
 * 2. Finds all no_ein_ entries
 * 3. Checks if they could be matched to real EINs
 * 4. Shows statistics and examples
 */

import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const DATASET_PATH = path.join(__dirname, '..', 'data', 'complete-grants-dataset.json');

interface Organization {
  ein: string;
  name: string;
  grantsReceived: any[];
  metadata?: any;
}

interface Foundation {
  ein: string;
  name: string;
  grantsGiven: any[];
  metadata?: any;
}

interface Dataset {
  foundations: { [ein: string]: Foundation };
  organizations: { [ein: string]: Organization };
}

// Normalize organization name for matching
function normalizeOrgName(name: string): string {
  return name
    .toLowerCase()
    .replace(/\b(inc|incorporated|llc|ltd|limited|corp|corporation|foundation|fund|trust|the|a|an)\b/g, '')
    .replace(/[^a-z0-9]+/g, '')
    .trim();
}

async function main() {
  console.log('📊 Debugging no_ein_ entries...\n');

  // Load dataset
  if (!fs.existsSync(DATASET_PATH)) {
    console.error(`❌ Dataset not found at ${DATASET_PATH}`);
    console.error('   Run "npm run build-complete-dataset" first.');
    process.exit(1);
  }

  console.log(`📂 Loading dataset from ${DATASET_PATH}...`);
  const dataset: Dataset = JSON.parse(fs.readFileSync(DATASET_PATH, 'utf-8'));

  // Count no_ein entries
  const noEinOrgs = Object.keys(dataset.organizations).filter(k => k.startsWith('no_ein_'));
  const totalOrgs = Object.keys(dataset.organizations).length;
  const realEinOrgs = totalOrgs - noEinOrgs.length;

  console.log(`\n📈 Statistics:`);
  console.log(`   Total organizations: ${totalOrgs.toLocaleString()}`);
  console.log(`   With real EINs: ${realEinOrgs.toLocaleString()} (${(realEinOrgs / totalOrgs * 100).toFixed(1)}%)`);
  console.log(`   With no_ein_: ${noEinOrgs.length.toLocaleString()} (${(noEinOrgs.length / totalOrgs * 100).toFixed(1)}%)`);

  // Build name-to-EIN index from organizations with real EINs
  const nameIndex = new Map<string, string[]>();
  for (const [ein, org] of Object.entries(dataset.organizations)) {
    if (!ein.startsWith('no_ein_')) {
      const normalized = normalizeOrgName(org.name);
      if (!nameIndex.has(normalized)) {
        nameIndex.set(normalized, []);
      }
      nameIndex.get(normalized)!.push(ein);
    }
  }

  console.log(`\n🔍 Name index contains ${nameIndex.size.toLocaleString()} unique normalized names`);

  // Check how many no_ein entries could be matched
  let potentialMatches = 0;
  const examples: Array<{ noEinId: string; name: string; matchedEINs: string[]; grantCount: number }> = [];

  for (const noEinId of noEinOrgs.slice(0, 10000)) { // Sample first 10k
    const org = dataset.organizations[noEinId];
    const normalized = normalizeOrgName(org.name);
    const matches = nameIndex.get(normalized);

    if (matches && matches.length > 0) {
      potentialMatches++;
      if (examples.length < 20) {
        examples.push({
          noEinId,
          name: org.name,
          matchedEINs: matches,
          grantCount: org.grantsReceived.length
        });
      }
    }
  }

  console.log(`\n✅ Potential matches found: ${potentialMatches.toLocaleString()} out of first 10,000 no_ein entries`);
  console.log(`   (${(potentialMatches / 10000 * 100).toFixed(1)}% could potentially be consolidated)`);

  console.log(`\n📝 Example matches (first 20):`);
  for (const example of examples) {
    console.log(`\n   no_ein entry: ${example.noEinId}`);
    console.log(`   Name: "${example.name}"`);
    console.log(`   Grants received: ${example.grantCount}`);
    console.log(`   Matched EINs: ${example.matchedEINs.join(', ')}`);
    if (example.matchedEINs.length > 0) {
      const matchedOrg = dataset.organizations[example.matchedEINs[0]];
      console.log(`   Matched name: "${matchedOrg.name}"`);
    }
  }

  // Analyze grant sources for no_ein entries
  console.log(`\n\n🔎 Analyzing why some grants lack EINs...`);
  const noEinGrantSources = new Map<string, number>();
  let totalNoEinGrants = 0;

  for (const noEinId of noEinOrgs.slice(0, 1000)) { // Sample first 1k
    const org = dataset.organizations[noEinId];
    for (const grant of org.grantsReceived) {
      totalNoEinGrants++;
      const funderName = grant.funderName || 'Unknown';
      noEinGrantSources.set(funderName, (noEinGrantSources.get(funderName) || 0) + 1);
    }
  }

  const topSources = Array.from(noEinGrantSources.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10);

  console.log(`\n📊 Top 10 funders giving grants to no_ein entries (from first 1000):`);
  for (const [funder, count] of topSources) {
    console.log(`   ${count.toLocaleString().padStart(6)} grants - ${funder}`);
  }

  console.log(`\n💡 Recommendations:`);
  console.log(`   1. Improve name normalization to catch more variations`);
  console.log(`   2. Add fuzzy matching for common misspellings`);
  console.log(`   3. Consider using both name AND location (city/state) for matching`);
  console.log(`   4. Check if some funders systematically omit recipient EINs`);
  console.log(`   5. Consider marking consolidated entries to prevent duplication`);
}

main().catch(console.error);
