// ============================================================================
// fetchFighters.js - v2 using Octagon API
// Fetches every UFC fighter from the community Octagon API and inserts them
// into your Supabase fighters table.
//
// Run from terminal: node fetchFighters.js
// ============================================================================

// Load Supabase credentials from .env file
require('dotenv').config();

// Import the Supabase SDK
const { createClient } = require('@supabase/supabase-js');

// Safety check: make sure .env loaded properly
if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
  console.error('ERROR: Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY in .env file');
  process.exit(1);
}

// Create the Supabase client (with secret key to bypass RLS for data loading)
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

// ============================================================================
// OCTAGON API ENDPOINT
// ============================================================================
// The /fighters endpoint returns every UFC fighter as a single JSON object.
// Each key is the fighter's slug (e.g., "jon-jones") and the value is their info.
const OCTAGON_API_URL = 'https://api.octagon-api.com/fighters';

// ============================================================================
// DIVISION MAPPING
// ============================================================================
// Octagon API uses "Welterweight Division" format for category names.
// We need to map these to our enum values defined in the Supabase schema.

const DIVISION_MAP = {
  // Men's divisions
  'Heavyweight Division': 'heavyweight',
  'Light Heavyweight Division': 'light_heavyweight',
  'Middleweight Division': 'middleweight',
  'Welterweight Division': 'welterweight',
  'Lightweight Division': 'lightweight',
  'Featherweight Division': 'featherweight',
  'Bantamweight Division': 'bantamweight',
  'Flyweight Division': 'flyweight',
  // Women's divisions
  "Women's Strawweight Division": 'strawweight',
  "Women's Flyweight Division": 'flyweight_w',
  "Women's Bantamweight Division": 'bantamweight_w',
  // Without "Division" suffix, just in case
  'Heavyweight': 'heavyweight',
  'Light Heavyweight': 'light_heavyweight',
  'Middleweight': 'middleweight',
  'Welterweight': 'welterweight',
  'Lightweight': 'lightweight',
  'Featherweight': 'featherweight',
  'Bantamweight': 'bantamweight',
  'Flyweight': 'flyweight',
  "Women's Strawweight": 'strawweight',
  "Women's Flyweight": 'flyweight_w',
  "Women's Bantamweight": 'bantamweight_w',
};

// ============================================================================
// HELPER: Safely convert a string like "26" to an integer
// Octagon returns numeric fields as strings, which our DB expects as integers.
// ============================================================================
function parseIntSafe(value, fallback = 0) {
  if (value === null || value === undefined || value === '') return fallback;
  const parsed = parseInt(value, 10);
  return isNaN(parsed) ? fallback : parsed;
}

// ============================================================================
// HELPER: Extract country from "City, Country" format
// Octagon stores place of birth like "Rochester, United States"
// We just want the country, which is the part after the last comma.
// ============================================================================
function parseCountry(placeOfBirth) {
  if (!placeOfBirth || typeof placeOfBirth !== 'string') return null;
  const parts = placeOfBirth.split(',').map(p => p.trim());
  return parts.length > 1 ? parts[parts.length - 1] : placeOfBirth;
}

// ============================================================================
// STEP 1: Fetch all fighters from Octagon API in one request
// ============================================================================
async function fetchAllFighters() {
  console.log('Fetching all fighters from Octagon API...');
  console.log(`URL: ${OCTAGON_API_URL}\n`);
  
  try {
    // Built-in fetch() makes an HTTP GET request
    const response = await fetch(OCTAGON_API_URL);
    
    if (!response.ok) {
      console.error(`Error: HTTP ${response.status} ${response.statusText}`);
      return null;
    }
    
    // Parse JSON response into a JavaScript object
    const data = await response.json();
    
    // The response is an object with fighter IDs as keys
    // Object.keys() gives us an array of all fighter IDs
    const fighterIds = Object.keys(data);
    console.log(`Received ${fighterIds.length} fighters from Octagon API\n`);
    
    return data;
  } catch (err) {
    console.error('Failed to fetch from Octagon API:', err.message);
    return null;
  }
}

// ============================================================================
// STEP 2: Transform Octagon's data format to match our database schema
// ============================================================================
function transformFighter(octagonId, fighter) {
  // Skip fighters with missing critical data
  if (!fighter.name || !fighter.category) {
    return null;
  }
  
  // Look up our enum value for the fighter's division
  const division = DIVISION_MAP[fighter.category];
  
  // Skip fighters with unrecognized divisions (usually retired/special categories)
  if (!division) {
    return null;
  }
  
  return {
    // Core identity
    name: fighter.name,
    nickname: fighter.nickname || null,
    primary_division: division,
    
    // Record (stored as strings in Octagon, we need integers)
    record_wins: parseIntSafe(fighter.wins),
    record_losses: parseIntSafe(fighter.losses),
    record_draws: parseIntSafe(fighter.draws),
    record_no_contests: 0,  // Octagon doesn't track NCs separately
    
    // Geographic info
    country: parseCountry(fighter.placeOfBirth),

    // Age (Octagon returns this as a string, e.g. "32"). Refreshed weekly so
    // staleness is at most ~7 days. Null when API doesn't report it.
    age: parseIntSafe(fighter.age, null),

    // Active status - Octagon uses "Active" or "Retired"
    is_active: fighter.status === 'Active' || !fighter.status,
    
    // External ID for future updates (Octagon's slug like "jon-jones")
    ufc_id: octagonId,

    // Fighter headshot from UFC.com CDN (null if API didn't return one)
    photo_url: fighter.imgUrl || null,

    // Fields we don't know yet - will be populated by applyRankings.js
    current_rank: null,
    is_champion: false,
    is_sub_champion: false,
    sub_title_type: 'none',
  };
}

// ============================================================================
// STEP 3: Insert fighters into Supabase in batches
// ============================================================================
async function insertFighters(fighters) {
  console.log(`Inserting ${fighters.length} fighters into Supabase...`);
  
  // Supabase has request size limits, so we insert 50 at a time
  const BATCH_SIZE = 50;
  let inserted = 0;
  let failed = 0;
  
  for (let i = 0; i < fighters.length; i += BATCH_SIZE) {
    const batch = fighters.slice(i, i + BATCH_SIZE);
    const batchNum = Math.floor(i / BATCH_SIZE) + 1;
    
    // .upsert() inserts new rows OR updates if they already exist
    // onConflict: 'ufc_id' means match on the UFC slug
    // This way, running the script twice doesn't create duplicates
    const { data, error } = await supabase
      .from('fighters')
      .upsert(batch, { onConflict: 'ufc_id' });
    
    if (error) {
      console.error(`  Batch ${batchNum} FAILED: ${error.message}`);
      failed += batch.length;
    } else {
      inserted += batch.length;
      console.log(`  Batch ${batchNum}: inserted/updated ${batch.length} fighters`);
    }
  }
  
  console.log(`\nFinal summary:`);
  console.log(`  Successfully inserted: ${inserted}`);
  console.log(`  Failed: ${failed}`);
}

// ============================================================================
// MAIN EXECUTION
// ============================================================================
async function main() {
  const startTime = Date.now();
  
  // Step 1: Get all fighters in one API call
  const rawData = await fetchAllFighters();
  
  if (!rawData) {
    console.error('No data returned. Aborting.');
    return;
  }
  
  // Step 2: Transform each fighter into our database format
  const fightersToInsert = [];
  let skippedCount = 0;
  
  // Loop through every fighter in the response
  // Object.entries() gives us [key, value] pairs
  for (const [octagonId, fighter] of Object.entries(rawData)) {
    const transformed = transformFighter(octagonId, fighter);
    if (transformed) {
      fightersToInsert.push(transformed);
    } else {
      skippedCount++;
    }
  }
  
  console.log(`Transformed ${fightersToInsert.length} fighters`);
  if (skippedCount > 0) {
    console.log(`Skipped ${skippedCount} fighters (missing data or unknown division)\n`);
  }
  
  // Step 3: Insert into Supabase
  if (fightersToInsert.length > 0) {
    await insertFighters(fightersToInsert);
  }
  
  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  console.log(`\nTotal time: ${elapsed} seconds`);
  console.log('\nNext step: Run "node applyRankings.js" to apply rankings and champion flags');
}

// Run main() and print any crash errors cleanly
main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
