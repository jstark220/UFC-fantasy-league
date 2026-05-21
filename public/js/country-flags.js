// ========================================================================
// COUNTRY → FLAG EMOJI
// Small helper that maps a country name (as stored in fighters.country)
// to a flag emoji. Uses Unicode regional-indicator pairs, which render as
// the country flag on all modern systems.
//
// The Octagon API stores countries by their full name ("United States",
// "Brazil"). Some auto-created fighters use short forms ("USA", "UK").
// We normalize everything via COUNTRY_TO_ISO_2.
//
// Attach to window so plain <script> includes can call it without imports.
// ========================================================================

(function (root) {
  // Country name (lowercase, trimmed) → ISO 3166-1 alpha-2 code.
  // Only includes the countries that show up in UFC rosters (~50).
  // Add more as needed.
  var COUNTRY_TO_ISO_2 = {
    'united states':         'US',
    'usa':                   'US',
    'us':                    'US',
    'america':               'US',

    'brazil':                'BR',
    'russia':                'RU',
    'russian federation':    'RU',
    'canada':                'CA',
    'mexico':                'MX',

    'united kingdom':        'GB',
    'uk':                    'GB',
    'great britain':         'GB',
    'england':               'GB',
    'scotland':              'GB',
    'wales':                 'GB',
    'northern ireland':      'GB',

    'ireland':               'IE',
    'new zealand':           'NZ',
    'australia':             'AU',
    'china':                 'CN',
    'japan':                 'JP',
    'south korea':           'KR',
    'north korea':           'KP',
    'korea':                 'KR',

    'kazakhstan':            'KZ',
    'kyrgyzstan':            'KG',
    'uzbekistan':            'UZ',
    'tajikistan':            'TJ',
    'turkmenistan':          'TM',
    'azerbaijan':            'AZ',
    'armenia':               'AM',
    'georgia':               'GE',
    'ukraine':               'UA',
    'belarus':               'BY',
    'moldova':               'MD',

    'france':                'FR',
    'germany':               'DE',
    'netherlands':           'NL',
    'belgium':               'BE',
    'poland':                'PL',
    'spain':                 'ES',
    'portugal':              'PT',
    'italy':                 'IT',
    'switzerland':           'CH',
    'sweden':                'SE',
    'norway':                'NO',
    'denmark':               'DK',
    'finland':               'FI',
    'iceland':               'IS',
    'austria':               'AT',
    'czech republic':        'CZ',
    'czechia':               'CZ',
    'slovakia':              'SK',
    'romania':               'RO',
    'bulgaria':              'BG',
    'hungary':               'HU',
    'croatia':               'HR',
    'serbia':                'RS',
    'bosnia and herzegovina':'BA',
    'slovenia':              'SI',
    'lithuania':             'LT',
    'latvia':                'LV',
    'estonia':               'EE',
    'greece':                'GR',
    'turkey':                'TR',
    'cyprus':                'CY',
    'malta':                 'MT',

    'cuba':                  'CU',
    'jamaica':               'JM',
    'dominican republic':    'DO',
    'haiti':                 'HT',
    'puerto rico':           'PR',
    'trinidad and tobago':   'TT',

    'argentina':             'AR',
    'chile':                 'CL',
    'peru':                  'PE',
    'colombia':              'CO',
    'venezuela':             'VE',
    'ecuador':               'EC',
    'bolivia':               'BO',
    'uruguay':               'UY',
    'paraguay':              'PY',

    'south africa':          'ZA',
    'nigeria':               'NG',
    'cameroon':              'CM',
    'kenya':                 'KE',
    'morocco':               'MA',
    'egypt':                 'EG',
    'algeria':               'DZ',
    'tunisia':               'TN',
    'senegal':               'SN',
    'ghana':                 'GH',
    'angola':                'AO',
    'ethiopia':              'ET',

    'iran':                  'IR',
    'iraq':                  'IQ',
    'israel':                'IL',
    'palestine':             'PS',
    'jordan':                'JO',
    'lebanon':               'LB',
    'syria':                 'SY',
    'saudi arabia':          'SA',
    'united arab emirates':  'AE',
    'uae':                   'AE',
    'qatar':                 'QA',
    'bahrain':               'BH',
    'kuwait':                'KW',
    'oman':                  'OM',
    'yemen':                 'YE',

    'india':                 'IN',
    'pakistan':              'PK',
    'bangladesh':            'BD',
    'sri lanka':             'LK',
    'nepal':                 'NP',
    'afghanistan':           'AF',

    'philippines':           'PH',
    'thailand':              'TH',
    'vietnam':               'VN',
    'indonesia':             'ID',
    'malaysia':              'MY',
    'singapore':             'SG',
    'myanmar':               'MM',
    'cambodia':              'KH',
    'laos':                  'LA',
    'taiwan':                'TW',
    'hong kong':             'HK',
    'mongolia':              'MN',
  };

  // Convert "US" → "🇺🇸". Works by mapping each letter to its regional
  // indicator code point (0x1F1E6 = 🇦, etc.).
  function isoToFlag(iso) {
    if (!iso || iso.length !== 2) return '';
    var a = iso.charCodeAt(0) - 65;  // 'A' = 65
    var b = iso.charCodeAt(1) - 65;
    if (a < 0 || a > 25 || b < 0 || b > 25) return '';
    return String.fromCodePoint(0x1F1E6 + a, 0x1F1E6 + b);
  }

  function countryFlag(country) {
    if (!country) return '';
    var key = String(country).toLowerCase().trim();
    var iso = COUNTRY_TO_ISO_2[key];
    return iso ? isoToFlag(iso) : '';
  }

  root.countryFlag = countryFlag;
})(typeof window !== 'undefined' ? window : this);
