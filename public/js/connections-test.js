// ========================================================================
// CONNECTION TEST PAGE LOGIC
// Fetches fighters from Supabase and renders them in a table.
// Depends on supabaseClient defined in supabase-config.js.
// ========================================================================

async function loadFighters() {
  const statusEl = document.getElementById('status');

  try {
    // Query the fighters table
    // .select() = SELECT (list of columns)
    // .order() = ORDER BY (called twice for multi-column sort)
    const { data, error } = await supabaseClient
      .from('fighters')
      .select('name, nickname, primary_division, current_rank, is_champion, record_wins, record_losses, record_draws, country')
      .order('is_champion', { ascending: false })  // Champions first
      .order('current_rank', { nullsFirst: false }); // Then by rank; unranked last

    // If Supabase returned an error object, surface it
    if (error) throw error;

    statusEl.textContent = 'Loaded ' + data.length + ' fighters from Supabase';
    statusEl.className = 'status success';

    renderTable(data);

  } catch (err) {
    statusEl.innerHTML = '<strong>Error:</strong> ' + err.message +
      '<br><small>Check the browser console (F12) for details.</small>';
    statusEl.className = 'status error';
    console.error('Full error:', err);
  }
}

// ========================================================================
// RENDER TABLE
// Builds a table row for each fighter and appends it to the tbody
// ========================================================================
function renderTable(fighters) {
  const table = document.getElementById('fighterTable');
  const tbody = document.getElementById('fighterBody');

  // Clear any rows from a previous render
  tbody.innerHTML = '';

  fighters.forEach(function(f) {
    const row = document.createElement('tr');

    // Format rank display: "CHAMP", "#N", or "-" for unranked
    let rankDisplay;
    if (f.is_champion)    rankDisplay = '<span class="champion">CHAMP</span>';
    else if (f.current_rank) rankDisplay = '#' + f.current_rank;
    else                  rankDisplay = '-';

    // Format the record as wins-losses-draws
    const record = f.record_wins + '-' + f.record_losses + '-' + f.record_draws;

    // Replace underscores in the enum value with spaces for display
    const divDisplay = f.primary_division.replace(/_/g, ' ');

    row.innerHTML =
      '<td>' + rankDisplay + '</td>' +
      '<td>' + f.name + '</td>' +
      '<td>' + (f.nickname || '') + '</td>' +
      '<td>' + divDisplay + '</td>' +
      '<td>' + record + '</td>' +
      '<td>' + (f.country || '') + '</td>';

    tbody.appendChild(row);
  });

  // Reveal the table now that it has rows
  table.style.display = 'table';
}

// Run as soon as the page loads
loadFighters();
