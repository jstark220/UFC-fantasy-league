// ========================================================================
// NEXT-FIGHT LOOKUP
// Given a list of fighter IDs, returns a map of fighter_id → next-fight
// info (event date, event name, opponent name+id). "Next" means the
// earliest scheduled UFC fight where the result hasn't been recorded
// yet and the event date is today or later.
//
// Used by waivers, lineup, fighter modal, and fighter page so every
// surface where fighters are listed can surface their next bout.
//
// Attaches to window.NextFight so plain <script> includes can use it.
// ========================================================================

(function (root) {
  /**
   * Fetch next-fight info for a batch of fighters.
   * @param {string[]} fighterIds — UUIDs from the fighters table
   * @returns {Promise<Object<string,{event_id,event_name,event_date,opponent_id,opponent_name}>>}
   */
  async function loadNextFights(fighterIds) {
    if (!fighterIds || fighterIds.length === 0) return {};
    if (typeof supabaseClient === 'undefined') return {};

    const todayISO = new Date().toISOString().split('T')[0];

    // Strategy: pull every upcoming fight in the DB first (a few dozen
    // rows at most), then filter to the fighters the caller asked about.
    // Querying with .in() on 6000+ fighter IDs blows past PostgREST's URL
    // length limit and fails silently, so this flip is essential.
    const { data: rawFights, error } = await supabaseClient
      .from('fight_results')
      .select('fighter_a_id, fighter_b_id, event:ufc_events!inner(id, name, event_date)')
      .is('outcome', null)
      .gte('event.event_date', todayISO);

    if (error) {
      console.warn('NextFight.loadNextFights query failed:', error.message);
      return {};
    }

    const upcoming = (rawFights || []).filter(function (f) {
      // The !inner join can still surface rows where event resolves to null
      // (orphaned fight_results). Defend against it.
      return f.event && f.event.event_date && f.event.event_date >= todayISO;
    });

    // Resolve opponent names. Opponent ids may not be in the caller's list.
    const allParticipantIds = new Set();
    upcoming.forEach(function (f) {
      if (f.fighter_a_id) allParticipantIds.add(f.fighter_a_id);
      if (f.fighter_b_id) allParticipantIds.add(f.fighter_b_id);
    });
    let nameMap = {};
    if (allParticipantIds.size > 0) {
      const fres = await supabaseClient.from('fighters')
        .select('id, name').in('id', Array.from(allParticipantIds));
      (fres.data || []).forEach(function (f) { nameMap[f.id] = f.name; });
    }

    // For each requested fighter, pick their earliest upcoming fight.
    const wanted = new Set(fighterIds);
    const sorted = upcoming.slice().sort(function (a, b) {
      return (a.event.event_date < b.event.event_date) ? -1 : (a.event.event_date > b.event.event_date ? 1 : 0);
    });
    const result = {};
    for (const fight of sorted) {
      [fight.fighter_a_id, fight.fighter_b_id].forEach(function (fid) {
        if (!wanted.has(fid)) return;
        if (result[fid]) return; // earlier event already won
        const oppId = fid === fight.fighter_a_id ? fight.fighter_b_id : fight.fighter_a_id;
        result[fid] = {
          event_id:      fight.event.id,
          event_name:    fight.event.name,
          event_date:    fight.event.event_date,
          opponent_id:   oppId,
          opponent_name: nameMap[oppId] || 'TBD',
        };
      });
    }
    return result;
  }

  // Short display format used on tight rows: "May 30 vs Pereira"
  function formatNextFightShort(nf) {
    if (!nf) return '';
    const d = new Date(nf.event_date + 'T12:00:00');
    const dStr = d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
    return dStr + ' vs ' + (nf.opponent_name || 'TBD');
  }

  // Long display format for the fighter modal/page hero
  function formatNextFightLong(nf) {
    if (!nf) return '';
    const d = new Date(nf.event_date + 'T12:00:00');
    const dStr = d.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
    return dStr + ' · ' + nf.event_name + ' · vs ' + (nf.opponent_name || 'TBD');
  }

  root.NextFight = {
    loadNextFights:      loadNextFights,
    formatShort:         formatNextFightShort,
    formatLong:          formatNextFightLong,
  };
})(typeof window !== 'undefined' ? window : this);
