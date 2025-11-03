import axios from 'axios';

export interface NonprofitSearchResult {
  ein: string;
  name: string;
  city: string;
  state: string;
}

export interface Grant {
  recipientName: string;
  amount: number;
  year: number;
}

export interface Filing {
  taxPeriod: number;
  taxYear: number;
  pdfUrl: string;
  totRevenue: number;
  totFuncExpenses: number;
}

const PROPUBLICA_API_BASE = 'https://projects.propublica.org/nonprofits/api/v2';

/**
 * Service to interact with ProPublica's Nonprofit Explorer API
 *
 * IMPORTANT LIMITATION:
 * ProPublica's API does not provide reverse lookup functionality.
 * To find "who else funds organization X", we would need to:
 * 1. Have a curated list of major foundations
 * 2. Download each foundation's 990 Schedule I (grants made)
 * 3. Parse XML to find recipients matching our organizations
 *
 * This requires processing thousands of 990 forms and is beyond
 * the scope of a simple POC. For production, consider:
 * - Candid (formerly Foundation Center) API (paid)
 * - Manual curation of known funders
 * - Building a grants database from IRS bulk 990 data
 */
export class ProPublicaService {
  /**
   * Search for a nonprofit by name using ProPublica's API
   * This ACTUALLY works and uses real ProPublica data
   */
  async searchNonprofit(name: string): Promise<NonprofitSearchResult[]> {
    try {
      console.log(`🔍 Searching ProPublica API for: ${name}`);

      const response = await axios.get(`${PROPUBLICA_API_BASE}/search.json`, {
        params: { q: name },
        timeout: 10000
      });

      if (response.data && response.data.organizations) {
        const results = response.data.organizations.map((org: any) => ({
          ein: org.ein.toString(),
          name: org.name,
          city: org.city,
          state: org.state
        }));

        console.log(`✅ Found ${results.length} organizations`);
        return results;
      }

      console.log(`❌ No organizations found`);
      return [];
    } catch (error) {
      console.error('❌ Error searching nonprofit:', error);
      return [];
    }
  }

  /**
   * Get organization details and filings by EIN
   * This ACTUALLY works and uses real ProPublica data
   */
  async getOrganizationData(ein: string): Promise<Filing[]> {
    try {
      console.log(`📊 Fetching organization data for EIN: ${ein}`);

      const response = await axios.get(`${PROPUBLICA_API_BASE}/organizations/${ein}.json`, {
        timeout: 10000
      });

      if (response.data && response.data.filings_with_data) {
        const filings = response.data.filings_with_data.map((f: any) => ({
          taxPeriod: f.tax_prd,
          taxYear: f.tax_prd_yr,
          pdfUrl: f.pdf_url,
          totRevenue: f.totrevenue,
          totFuncExpenses: f.totfuncexpns
        }));

        console.log(`✅ Found ${filings.length} filings`);
        return filings;
      }

      return [];
    } catch (error) {
      console.error(`❌ Error fetching organization data for EIN ${ein}:`, error);
      return [];
    }
  }

  /**
   * Get grants data - the funders who gave TO this organization
   *
   * **IMPORTANT**: This functionality requires data that ProPublica doesn't provide directly.
   *
   * To find funders of an organization, we would need to:
   * 1. Search all foundation 990 forms (hundreds of thousands)
   * 2. Parse Schedule I (grants made) from each
   * 3. Match recipient names/EINs to our target organization
   *
   * OPTIONS FOR PRODUCTION:
   * A) Use a paid service like Candid (Foundation Directory Online)
   * B) Build a grants database from IRS bulk 990 XML data
   * C) Manually curate known major funders and check their Schedule Is
   * D) Use mock/sample data for visualization purposes (current approach)
   *
   * For this POC, we use deterministic mock data based on the EIN
   * to demonstrate the visualization concept.
   */
  async getGrantsByEIN(ein: string, year: number = 2024): Promise<Grant[]> {
    console.log(`⚠️  NOTE: Using mock funder data for EIN ${ein}`);
    console.log(`   Real implementation requires parsing thousands of foundation 990s`);
    console.log(`   or using a paid grants database service.`);

    // Verify the organization exists first
    await this.searchNonprofitByEIN(ein);

    // Generate deterministic mock data for POC
    return this.generateMockFunders(ein, year);
  }

  /**
   * Search for nonprofit by exact EIN
   */
  private async searchNonprofitByEIN(ein: string): Promise<boolean> {
    try {
      const response = await axios.get(`${PROPUBLICA_API_BASE}/organizations/${ein}.json`, {
        timeout: 10000
      });
      return !!response.data.organization;
    } catch (error) {
      return false;
    }
  }

  /**
   * Generate mock funder data for POC purposes
   *
   * In production, this would be replaced with actual 990 Schedule I parsing
   * or data from a grants database service.
   */
  private generateMockFunders(ein: string, year: number): Grant[] {
    // Major foundations that commonly fund social justice organizations
    const majorFunders = [
      'Ford Foundation',
      'Kresge Foundation',
      'John D. and Catherine T. MacArthur Foundation',
      'Rockefeller Foundation',
      'Andrew W. Mellon Foundation',
      'Open Society Foundations',
      'W.K. Kellogg Foundation',
      'Robert Wood Johnson Foundation',
      'Silicon Valley Community Foundation',
      'NoVo Foundation',
      'Marguerite Casey Foundation',
      'Nathan Cummings Foundation',
      'Surdna Foundation',
      'William and Flora Hewlett Foundation',
      'McKnight Foundation',
      'Joyce Foundation'
    ];

    // Use EIN as seed for consistent, deterministic results
    const seed = parseInt(ein.slice(0, 6));
    const numGrants = (seed % 6) + 2; // 2-7 grants per organization
    const grants: Grant[] = [];

    for (let i = 0; i < numGrants; i++) {
      const funderIndex = (seed + i) % majorFunders.length;
      const foundation = majorFunders[funderIndex];

      // Generate realistic grant amounts based on foundation (larger foundations give more)
      const baseAmount = funderIndex < 5 ? 200000 : 100000; // Top foundations give more
      const variance = (seed + i * 7919) % 300000; // Prime number for distribution
      const amount = baseAmount + variance;

      grants.push({
        recipientName: foundation,
        amount,
        year
      });
    }

    return grants.sort((a, b) => b.amount - a.amount); // Sort by amount descending
  }
}

export const propublicaService = new ProPublicaService();
