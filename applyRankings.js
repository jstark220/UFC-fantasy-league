// ============================================================================
// applyRankings.js - v3 matches by ufc_id (slug) instead of name
// 
// WHY THIS IS BETTER:
// Octagon API stores fighter names with accents and sometimes trailing spaces:
//   'Jiří Procházka '     (not 'Jiri Prochazka')
//   'Jan Błachowicz'      (not 'Jan Blachowicz')
//   'Benoît Saint Denis ' (not 'Benoit Saint Denis')
// Matching by name breaks for these fighters. But the ufc_id is always a
// clean ASCII slug like 'jiri-prochazka' or 'jan-blachowicz'. Reliable.
//
// Run: node applyRankings.js
// ============================================================================

require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');

if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
  console.error('ERROR: Missing environment variables in .env');
  process.exit(1);
}

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

// ============================================================================
// RESET: Clear all rankings before applying fresh data
// ============================================================================
async function resetRankings() {
  console.log('Clearing stale rankings and champion flags...\n');
  const { error } = await supabase
    .from('fighters')
    .update({
      current_rank: null,
      is_champion: false,
      is_sub_champion: false,
      sub_title_type: 'none',
    })
    .not('id', 'is', null);
  
  if (error) {
    console.error('Error resetting rankings:', error.message);
    process.exit(1);
  }
  console.log('Reset complete.\n');
}

// ============================================================================
// RANKINGS KEYED BY ufc_id (Octagon's slug format)
// ============================================================================
// Format: { ufc_id_slug: { rank, isChamp, subTitle, isSubChamp } }
// Slugs are always lowercase-hyphenated. No accents, no spaces.

const RANKINGS = {
  // ========== FLYWEIGHT ==========
  'joshua-van': { rank: 0, isChamp: true, subTitle: 'none' },
  'alexandre-pantoja': { rank: 1, subTitle: 'none' },
  'manel-kape': { rank: 2, subTitle: 'none' },
  'tatsuro-taira': { rank: 3, subTitle: 'none' },
  'brandon-royval': { rank: 4, subTitle: 'none' },
  'kyoji-horiguchi': { rank: 5, subTitle: 'none' },
  'brandon-moreno': { rank: 6, subTitle: 'none' },
  'amir-albazi': { rank: 7, subTitle: 'none' },
  'assu-almabayev': { rank: 8, subTitle: 'none' },  // Octagon uses 'assu' spelling
  'tim-elliott': { rank: 9, subTitle: 'none' },
  'alex-perez': { rank: 10, subTitle: 'none' },
  'steve-erceg': { rank: 11, subTitle: 'none' },
  'tagir-ulanbekov': { rank: 12, subTitle: 'none' },
  'charles-johnson': { rank: 13, subTitle: 'none' },
  'bruno-gustavo-da-silva': { rank: 14, subTitle: 'none' },
  'joseph-morales': { rank: 15, subTitle: 'none' },
  
  // ========== BANTAMWEIGHT ==========
  'petr-yan': { rank: 0, isChamp: true, subTitle: 'none' },
  'merab-dvalishvili': { rank: 1, subTitle: 'none' },
  'umar-nurmagomedov': { rank: 2, subTitle: 'none' },
  'sean-omalley': { rank: 3, subTitle: 'none' },  // Possibly "sean-o-malley"
  'cory-sandhagen': { rank: 4, subTitle: 'none' },
  'yadong-song': { rank: 5, subTitle: 'none' },
  'aiemann-zahabi': { rank: 6, subTitle: 'none' },
  'deiveson-figueiredo': { rank: 7, subTitle: 'none' },
  'mario-bautista': { rank: 8, subTitle: 'none' },
  'marlon-vera': { rank: 9, subTitle: 'none' },
  'david-martinez': { rank: 10, subTitle: 'none' },
  'payton-talbott': { rank: 11, subTitle: 'none' },
  'vinicius-oliveira': { rank: 12, subTitle: 'none' },
  'rob-font': { rank: 13, subTitle: 'none' },
  'kyler-phillips': { rank: 14, subTitle: 'none' },
  'montel-jackson': { rank: 15, subTitle: 'none' },
  
  // ========== FEATHERWEIGHT ==========
  'alexander-volkanovski': { rank: 0, isChamp: true, subTitle: 'none' },
  'movsar-evloev': { rank: 1, subTitle: 'none' },
  'diego-lopes': { rank: 2, subTitle: 'none' },
  'lerone-murphy': { rank: 3, subTitle: 'none' },
  'yair-rodriguez': { rank: 4, subTitle: 'none' },
  'aljamain-sterling': { rank: 5, subTitle: 'none' },
  'jean-silva': { rank: 6, subTitle: 'none' },
  'arnold-allen': { rank: 7, subTitle: 'none' },
  'youssef-zalal': { rank: 8, subTitle: 'none' },
  'steve-garcia': { rank: 9, subTitle: 'none' },
  'brian-ortega': { rank: 10, subTitle: 'none' },
  'josh-emmett': { rank: 11, subTitle: 'none' },
  'patricio-pitbull': { rank: 12, subTitle: 'none' },
  'melquizael-costa': { rank: 13, subTitle: 'none' },
  'kevin-vallejos': { rank: 14, subTitle: 'none' },
  'david-onama': { rank: 15, subTitle: 'none' },
  
  // ========== LIGHTWEIGHT ==========
  'ilia-topuria': { rank: 0, isChamp: true, subTitle: 'none' },
  'justin-gaethje': { rank: 1, subTitle: 'interim', isSubChamp: true },
  'arman-tsarukyan': { rank: 2, subTitle: 'none' },
  'charles-oliveira': { rank: 3, subTitle: 'bmf', isSubChamp: true },
  'max-holloway': { rank: 4, subTitle: 'none' },
  'benoit-saint-denis': { rank: 5, subTitle: 'none' },
  'paddy-pimblett': { rank: 6, subTitle: 'none' },
  'mateusz-gamrot': { rank: 7, subTitle: 'none' },
  'dan-hooker': { rank: 8, subTitle: 'none' },
  'mauricio-ruffy': { rank: 9, subTitle: 'none' },
  'renato-moicano': { rank: 10, subTitle: 'none' },
  'rafael-fiziev': { rank: 11, subTitle: 'none' },
  'beneil-dariush': { rank: 12, subTitle: 'none' },
  'michael-chandler': { rank: 13, subTitle: 'none' },
  'manuel-torres': { rank: 14, subTitle: 'none' },
  'fares-ziam': { rank: 15, subTitle: 'none' },
  
  // ========== WELTERWEIGHT ==========
  'islam-makhachev': { rank: 0, isChamp: true, subTitle: 'none' },
  'jack-della-maddalena': { rank: 1, subTitle: 'none' },
  'ian-garry': { rank: 2, subTitle: 'none' },
  'michael-morales': { rank: 3, subTitle: 'none' },
  'belal-muhammad': { rank: 4, subTitle: 'none' },
  'carlos-prates': { rank: 5, subTitle: 'none' },
  'sean-brady': { rank: 6, subTitle: 'none' },
  'kamaru-usman': { rank: 7, subTitle: 'none' },
  'leon-edwards': { rank: 8, subTitle: 'none' },
  'joaquin-buckley': { rank: 9, subTitle: 'none' },
  'gabriel-bonfim': { rank: 10, subTitle: 'none' },
  'gilbert-burns': { rank: 11, subTitle: 'none' },
  'uros-medic': { rank: 12, subTitle: 'none' },
  'colby-covington': { rank: 13, subTitle: 'none' },
  'michael-page': { rank: 14, subTitle: 'none' },
  'daniel-rodriguez': { rank: 15, subTitle: 'none' },
  
  // ========== MIDDLEWEIGHT ==========
  'khamzat-chimaev': { rank: 0, isChamp: true, subTitle: 'none' },
  'dricus-du-plessis': { rank: 1, subTitle: 'none' },
  'nassourdine-imavov': { rank: 2, subTitle: 'none' },
  'sean-strickland': { rank: 3, subTitle: 'none' },
  'brendan-allen': { rank: 4, subTitle: 'none' },
  'israel-adesanya': { rank: 5, subTitle: 'none' },
  'anthony-hernandez': { rank: 6, subTitle: 'none' },
  'caio-borralho': { rank: 7, subTitle: 'none' },
  'reinier-de-ridder': { rank: 8, subTitle: 'none' },
  'robert-whittaker': { rank: 9, subTitle: 'none' },
  'jared-cannonier': { rank: 10, subTitle: 'none' },
  'roman-dolidze': { rank: 11, subTitle: 'none' },
  'gregory-rodrigues': { rank: 12, subTitle: 'none' },
  'joe-pyfer': { rank: 13, subTitle: 'none' },
  'brunno-ferreira': { rank: 14, subTitle: 'none' },
  'abus-magomedov': { rank: 15, subTitle: 'none' },
  
  // ========== LIGHT HEAVYWEIGHT (UPDATED POST UFC 327) ==========
  'carlos-ulberg': { rank: 0, isChamp: true, subTitle: 'none' },
  'magomed-ankalaev': { rank: 1, subTitle: 'none' },
  'jiri-prochazka': { rank: 2, subTitle: 'none' },
  'khalil-rountree-jr': { rank: 3, subTitle: 'none' },
  'jan-blachowicz': { rank: 4, subTitle: 'none' },
  'jamahal-hill': { rank: 5, subTitle: 'none' },
  'paulo-costa': { rank: 6, subTitle: 'none' },
  'azamat-murzakanov': { rank: 7, subTitle: 'none' },
  'volkan-oezdemir': { rank: 8, subTitle: 'none' },
  'bogdan-guskov': { rank: 9, subTitle: 'none' },
  'dominick-reyes': { rank: 10, subTitle: 'none' },
  'aleksandar-rakic': { rank: 11, subTitle: 'none' },
  'johnny-walker': { rank: 12, subTitle: 'none' },
  'nikita-krylov': { rank: 13, subTitle: 'none' },
  'dustin-jacoby': { rank: 14, subTitle: 'none' },
  'zhang-mingyang': { rank: 15, subTitle: 'none' },
  
  // ========== HEAVYWEIGHT ==========
  'tom-aspinall': { rank: 0, isChamp: true, subTitle: 'none' },
  'ciryl-gane': { rank: 1, subTitle: 'none' },
  'alexander-volkov': { rank: 2, subTitle: 'none' },
  'sergei-pavlovich': { rank: 3, subTitle: 'none' },
  'josh-hokit': { rank: 4, subTitle: 'none' },
  'waldo-cortes-acosta': { rank: 5, subTitle: 'none' },
  'serghei-spivac': { rank: 6, subTitle: 'none' },
  'rizvan-kuniev': { rank: 7, subTitle: 'none' },
  'derrick-lewis': { rank: 8, subTitle: 'none' },
  'curtis-blaydes': { rank: 9, subTitle: 'none' },
  'marcin-tybura': { rank: 10, subTitle: 'none' },
  'ante-delija': { rank: 11, subTitle: 'none' },
  'tallison-teixeira': { rank: 12, subTitle: 'none' },
  'shamil-gaziev': { rank: 13, subTitle: 'none' },
  'valter-walker': { rank: 14, subTitle: 'none' },
  'vitor-petrino': { rank: 15, subTitle: 'none' },
  
  // ========== WOMEN'S STRAWWEIGHT ==========
  'mackenzie-dern': { rank: 0, isChamp: true, subTitle: 'none' },
  'weili-zhang': { rank: 1, subTitle: 'none' },
  'tatiana-suarez': { rank: 2, subTitle: 'none' },
  'virna-jandiroba': { rank: 3, subTitle: 'none' },
  'xiaonan-yan': { rank: 4, subTitle: 'none' },
  'amanda-lemos': { rank: 5, subTitle: 'none' },
  'loopy-godinez': { rank: 6, subTitle: 'none' },
  'tabatha-ricci': { rank: 7, subTitle: 'none' },
  'gillian-robertson': { rank: 8, subTitle: 'none' },
  'jessica-andrade': { rank: 9, subTitle: 'none' },
  'amanda-ribas': { rank: 10, subTitle: 'none' },
  'fatima-kline': { rank: 11, subTitle: 'none' },
  'denise-gomes': { rank: 12, subTitle: 'none' },
  'alexia-thainara': { rank: 13, subTitle: 'none' },
  'angela-hill': { rank: 14, subTitle: 'none' },
  'mizuki-inoue': { rank: 15, subTitle: 'none' },
  
  // ========== WOMEN'S FLYWEIGHT ==========
  'valentina-shevchenko': { rank: 0, isChamp: true, subTitle: 'none' },
  'natalia-silva': { rank: 1, subTitle: 'none' },
  'manon-fiorot': { rank: 2, subTitle: 'none' },
  'alexa-grasso': { rank: 3, subTitle: 'none' },
  'erin-blanchfield': { rank: 4, subTitle: 'none' },
  'maycee-barber': { rank: 5, subTitle: 'none' },
  'jasmine-jasudavicius': { rank: 6, subTitle: 'none' },
  'rose-namajunas': { rank: 7, subTitle: 'none' },
  'tracy-cortez': { rank: 8, subTitle: 'none' },
  'karine-silva': { rank: 9, subTitle: 'none' },
  'miranda-maverick': { rank: 10, subTitle: 'none' },
  'wang-cong': { rank: 11, subTitle: 'none' },
  'casey-oneill': { rank: 12, subTitle: 'none' },
  'eduarda-moura': { rank: 13, subTitle: 'none' },
  'gabriella-fernandes': { rank: 14, subTitle: 'none' },
  'jj-aldrich': { rank: 15, subTitle: 'none' },
  
  // ========== WOMEN'S BANTAMWEIGHT ==========
  'kayla-harrison': { rank: 0, isChamp: true, subTitle: 'none' },
  'julianna-pena': { rank: 1, subTitle: 'none' },
  'raquel-pennington': { rank: 2, subTitle: 'none' },
  'norma-dumont': { rank: 3, subTitle: 'none' },
  'ketlen-vieira': { rank: 4, subTitle: 'none' },
  'yana-santos': { rank: 5, subTitle: 'none' },
  'irene-aldana': { rank: 6, subTitle: 'none' },
  'ailin-perez': { rank: 7, subTitle: 'none' },
  'macy-chiasson': { rank: 8, subTitle: 'none' },
  'karol-rosa': { rank: 9, subTitle: 'none' },
  'jacqueline-cavalcanti': { rank: 10, subTitle: 'none' },
  'joselyne-edwards': { rank: 11, subTitle: 'none' },
  'mayra-bueno-silva': { rank: 12, subTitle: 'none' },
  'nora-cornolle': { rank: 13, subTitle: 'none' },
  'miesha-tate': { rank: 14, subTitle: 'none' },
  'luana-santos': { rank: 15, subTitle: 'none' },
};

// ============================================================================
// MAIN LOGIC
// ============================================================================

async function applyRankings() {
  await resetRankings();
  
  console.log('Applying rankings (matching by ufc_id slug)...\n');
  
  let updatedCount = 0;
  let notFoundCount = 0;
  const notFoundSlugs = [];
  
  for (const [ufcIdSlug, data] of Object.entries(RANKINGS)) {
    const updates = {
      current_rank: data.rank === 0 ? null : data.rank,
      is_champion: data.isChamp === true,
      is_sub_champion: data.isSubChamp === true,
      sub_title_type: data.subTitle || 'none',
    };
    
    // Match by ufc_id (the slug) instead of name - much more reliable
    const { data: updated, error } = await supabase
      .from('fighters')
      .update(updates)
      .eq('ufc_id', ufcIdSlug)
      .select();
    
    if (error) {
      console.error(`  Error updating ${ufcIdSlug}: ${error.message}`);
      continue;
    }
    
    if (updated && updated.length > 0) {
      updatedCount++;
      const fighterName = updated[0].name;
      const statusTag = data.isChamp ? '[CHAMP]' : 
                       data.isSubChamp ? `[${data.subTitle.toUpperCase()}]` : 
                       `#${data.rank}`;
      console.log(`  ${statusTag.padEnd(10)} ${fighterName}`);
    } else {
      notFoundCount++;
      notFoundSlugs.push(ufcIdSlug);
    }
  }
  
  console.log(`\nSummary:`);
  console.log(`  Updated: ${updatedCount} fighters`);
  console.log(`  Not found: ${notFoundCount} fighters`);
  
  if (notFoundSlugs.length > 0) {
    console.log(`\nFighters not in database (need to be manually added):`);
    notFoundSlugs.forEach(slug => console.log(`  - ${slug}`));
  }
}

applyRankings().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
