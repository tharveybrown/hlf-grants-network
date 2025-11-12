/**
 * Test script to verify Schedule I parsing for Brooklyn Community Foundation
 */

import { parseStringPromise } from 'xml2js';
import * as fs from 'fs';
import * as path from 'path';

// Helper function to normalize EINs (remove dashes, trim whitespace)
function normalizeEIN(ein: string | undefined | null): string {
  if (!ein) return '';
  return ein.replace(/[^0-9]/g, '').trim();
}

interface Grant {
  recipientEIN: string;
  recipientName: string;
  amount: number;
  year: number;
  recipientCity?: string;
  recipientState?: string;
  recipientZip?: string;
}

async function testParseScheduleI() {
  const xmlPath = '/tmp/brooklyn_990pf.xml';

  if (!fs.existsSync(xmlPath)) {
    console.error(`❌ XML file not found at ${xmlPath}`);
    console.error('   Run this first: curl -L "https://projects.propublica.org/nonprofits/download-xml?object_id=202331329349308423" -o /tmp/brooklyn_990pf.xml');
    process.exit(1);
  }

  console.log('📄 Reading XML file...');
  const xmlContent = fs.readFileSync(xmlPath, 'utf-8');

  console.log('🔍 Checking file type...');
  const has990 = xmlContent.includes('<IRS990');
  const has990PF = xmlContent.includes('<IRS990PF');
  console.log(`   Has <IRS990: ${has990}`);
  console.log(`   Has <IRS990PF: ${has990PF}`);

  if (!has990 || has990PF) {
    console.error('❌ This is not a Form 990 (it\'s a 990-PF or other form)');
    process.exit(1);
  }

  console.log('\n📊 Parsing XML...');
  const data = await parseStringPromise(xmlContent);

  const root = data.Return?.ReturnData?.[0];
  const header = data.Return?.ReturnHeader?.[0];

  if (!root || !header) {
    console.error('❌ Missing Return/ReturnData or ReturnHeader');
    process.exit(1);
  }

  const rawEin = header.Filer?.[0]?.EIN?.[0];
  const ein = normalizeEIN(rawEin);
  const name = header.Filer?.[0]?.BusinessName?.[0]?.BusinessNameLine1Txt?.[0] || '';

  console.log(`\n✅ Found organization:`);
  console.log(`   EIN: ${ein}`);
  console.log(`   Name: ${name}`);

  // Parse Schedule I
  console.log('\n🔍 Looking for Schedule I...');
  const scheduleI = root.IRS990ScheduleI?.[0];

  if (!scheduleI) {
    console.error('❌ No IRS990ScheduleI found in ReturnData');
    console.log('\n📋 Available keys in ReturnData:');
    console.log(Object.keys(root));
    process.exit(1);
  }

  console.log('✅ Found IRS990ScheduleI!');
  console.log(`   Schedule I keys: ${Object.keys(scheduleI).join(', ')}`);

  const recipientTables = scheduleI?.RecipientTable || [];
  console.log(`   RecipientTable count: ${recipientTables.length}`);

  if (recipientTables.length === 0) {
    console.warn('⚠️  No RecipientTable entries found');
    process.exit(0);
  }

  // Parse grants
  console.log('\n📝 Parsing grants...');
  const grants: Grant[] = [];
  const year = 2022; // Tax year

  for (const recipient of recipientTables) {
    const recipientName = recipient.RecipientBusinessName?.[0]?.BusinessNameLine1Txt?.[0] ||
                          recipient.RecipientPersonNm?.[0] || '';
    const recipientEIN = normalizeEIN(recipient.RecipientEIN?.[0]);
    const amount = parseFloat(recipient.CashGrantAmt?.[0] || '0');

    // Extract address information
    const recAddress = recipient.USAddress?.[0] || recipient.ForeignAddress?.[0];
    const recipientCity = recAddress?.CityNm?.[0] || '';
    const recipientState = recAddress?.StateAbbreviationCd?.[0] || '';
    const recipientZip = recAddress?.ZIPCd?.[0] || '';

    if (recipientName && amount > 0) {
      grants.push({
        recipientEIN,
        recipientName,
        amount,
        year,
        recipientCity,
        recipientState,
        recipientZip
      });
    }
  }

  console.log(`\n✅ Parsed ${grants.length} grants!`);
  console.log(`\n📊 First 10 grants:`);
  for (const grant of grants.slice(0, 10)) {
    console.log(`   ${grant.recipientName} (${grant.recipientEIN || 'no EIN'}) - $${grant.amount.toLocaleString()}`);
  }

  console.log(`\n💾 Result object that would be returned:`);
  const result = {
    ein,
    name,
    metadata: { /* would have metadata here */ },
    grants
  };
  console.log(`   { ein: "${result.ein}", name: "${result.name}", grants: [${result.grants.length} grants] }`);
}

testParseScheduleI().catch(console.error);
