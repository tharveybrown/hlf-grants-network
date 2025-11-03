import Papa from 'papaparse';
import { propublicaService } from './propublica';

export interface HLFGrant {
  organization: string;
  amount: string;
  year: number;
  totalYears: number;
  totalAmount: string;
  grantType: string;
  city: string;
  state: string;
}

export interface NetworkNode {
  id: string;
  name: string;
  type: 'grantee' | 'funder';
  central?: boolean; // True for the central funder node
  amount?: number;
  details?: any;
  metadata?: {
    address?: string;
    city?: string;
    state?: string;
    assets?: number;
    revenue?: number;
  };
  grantsReceived?: Array<{
    funderEIN: string;
    funderName: string;
    amount: number;
    year: number;
  }>;
  grantsGiven?: Array<{
    recipientEIN: string;
    recipientName: string;
    amount: number;
    year: number;
  }>;
}

export interface NetworkLink {
  source: string;
  target: string;
  amount: number;
  year: number;
}

export interface NetworkData {
  nodes: NetworkNode[];
  links: NetworkLink[];
}

export class CSVParser {
  /**
   * Parse the HLF grants CSV file
   */
  async parseCSV(csvContent: string): Promise<HLFGrant[]> {
    return new Promise((resolve, reject) => {
      Papa.parse<any>(csvContent, {
        header: true,
        skipEmptyLines: true,
        complete: (results) => {
          const grants = results.data
            .filter((row: any) => {
              // Filter out header rows, discretionary grants, and incomplete data
              const org = row.Organization || '';
              const amount = row['2025 Amount'] || '';

              // Skip if no organization name or amount
              if (!org || !amount) return false;

              // Skip header/section rows
              if (org === '5-Year Grants' || org === '4-Year Grants' || org === '1-Year Grants') return false;
              if (org === 'Discretionary Grants' || org === 'Mini grants for Storytelling') return false;
              if (org === 'Transition Fund' || org.includes('TOTAL')) return false;

              // Skip discretionary grants - these are individual names without org info
              // They have no city/state info and are small amounts
              if (!row.City && !row.State && !row['Grant Award Address']) return false;

              return true;
            })
            .map((row: any) => ({
              organization: row.Organization,
              amount: row['2025 Amount'],
              year: parseInt(row['Year #']) || 1,
              totalYears: parseInt(row['Total # Years']) || 1,
              totalAmount: row['Total Grant Amount'] || row['2025 Amount'],
              grantType: row['Type of Grant'] || 'General Operating Support',
              city: row.City || '',
              state: row.State || ''
            }));

          resolve(grants);
        },
        error: (error: Error) => {
          reject(error);
        }
      });
    });
  }

  /**
   * Transform CSV data into network graph data
   */
  async buildNetworkData(grants: HLFGrant[]): Promise<NetworkData> {
    const nodes: NetworkNode[] = [];
    const links: NetworkLink[] = [];
    const nodeIds = new Set<string>();

    // Add HLF as the central node
    nodes.push({
      id: 'hlf',
      name: 'Hedge Fund for Liberation',
      type: 'funder',
      central: true
    });
    nodeIds.add('hlf');

    // Process each grant from HLF
    for (const grant of grants) {
      const orgId = this.sanitizeId(grant.organization);

      // Add grantee node if not already added
      if (!nodeIds.has(orgId)) {
        nodes.push({
          id: orgId,
          name: grant.organization,
          type: 'grantee',
          details: {
            city: grant.city,
            state: grant.state,
            grantType: grant.grantType
          }
        });
        nodeIds.add(orgId);
      }

      // Add link from HLF to grantee
      const amount = this.parseAmount(grant.amount);
      if (amount > 0) {
        links.push({
          source: 'hlf',
          target: orgId,
          amount,
          year: 2025
        });
      }

      // Fetch other funders for this organization (for POC, using mock data)
      try {
        const searchResults = await propublicaService.searchNonprofit(grant.organization);

        if (searchResults.length > 0) {
          const ein = searchResults[0].ein;
          const otherGrants = await propublicaService.getGrantsByEIN(ein, 2024);

          // Add funder nodes and links
          for (const otherGrant of otherGrants) {
            const funderId = this.sanitizeId(otherGrant.recipientName);

            // Add funder node if not already added
            if (!nodeIds.has(funderId)) {
              nodes.push({
                id: funderId,
                name: otherGrant.recipientName,
                type: 'funder',
                amount: otherGrant.amount
              });
              nodeIds.add(funderId);
            }

            // Add link from funder to grantee
            links.push({
              source: funderId,
              target: orgId,
              amount: otherGrant.amount,
              year: otherGrant.year
            });
          }
        }
      } catch (error) {
        console.error(`Error fetching grants for ${grant.organization}:`, error);
      }
    }

    return { nodes, links };
  }

  /**
   * Parse dollar amount string to number
   */
  private parseAmount(amountStr: string): number {
    if (!amountStr) return 0;

    // Remove $ and commas, then parse
    const cleaned = amountStr.replace(/[$,]/g, '');
    return parseFloat(cleaned) || 0;
  }

  /**
   * Sanitize organization name to use as ID
   */
  private sanitizeId(name: string): string {
    return name
      .toLowerCase()
      .replace(/[^a-z0-9]/g, '-')
      .replace(/-+/g, '-')
      .replace(/^-|-$/g, '');
  }
}

export const csvParser = new CSVParser();
