// ============================================================================
// EVENT OVERRIDES HELPER
//
// ufc_events is a global reference table representing the real UFC schedule.
// Commissioners can override per-league fields (date, lock time, name, etc.)
// via the league_event_overrides table. This module is the single place that
// knows how to merge those overrides onto a base ufc_events row.
//
// Usage in a league-scoped page:
//
//   var { data: events } = await supabaseClient.from('ufc_events').select(...);
//   var overrides = await EventOverrides.fetchForLeague(supabaseClient, leagueId);
//   events = EventOverrides.mergeAll(events, overrides);
//
// For a single event:
//
//   event = EventOverrides.merge(event, overrides[event.id]);
//
// The helper is exposed on `window.EventOverrides` because this codebase
// loads JS via plain <script> tags (no modules / bundler).
// ============================================================================

(function (root) {
  'use strict';

  // Fields that a commissioner can override on a per-league basis. Anything
  // else on the ufc_events row (id, photos, fight relations, etc.) is always
  // taken from the base row.
  var OVERRIDABLE_FIELDS = [
    'name',
    'full_name',
    'event_date',
    'lineup_lock_time',
    'venue'
  ];

  // Apply non-null override fields on top of a base ufc_events row.
  // Returns a shallow-cloned object so callers can mutate safely. Adds
  // a `_hasOverride` flag so UI can surface "this is a league override"
  // hints when useful.
  function merge(event, override) {
    if (!event) return event;
    if (!override) return event;
    var merged = Object.assign({}, event);
    var didOverride = false;
    OVERRIDABLE_FIELDS.forEach(function (field) {
      if (override[field] != null) {
        merged[field] = override[field];
        didOverride = true;
      }
    });
    if (didOverride) merged._hasOverride = true;
    return merged;
  }

  // Merge an array of events with a map of overrides keyed by event id.
  function mergeAll(events, overridesByEventId) {
    if (!Array.isArray(events)) return events;
    if (!overridesByEventId) return events.slice();
    return events.map(function (e) {
      return merge(e, overridesByEventId[e.id]);
    });
  }

  // Fetch overrides for a league. Returns a map: eventId -> override row.
  // When `eventIds` is provided, scopes the fetch to only those events
  // (useful when you've already fetched a small set and want to keep the
  // query tight). Returns {} on error or no league — callers can still
  // merge against {} safely.
  async function fetchForLeague(client, leagueId, eventIds) {
    if (!client || !leagueId) return {};
    var query = client.from('league_event_overrides').select('*').eq('league_id', leagueId);
    if (Array.isArray(eventIds) && eventIds.length > 0) {
      query = query.in('event_id', eventIds);
    }
    var res = await query;
    if (res.error) {
      console.error('Failed to fetch event overrides:', res.error);
      return {};
    }
    var map = {};
    (res.data || []).forEach(function (row) { map[row.event_id] = row; });
    return map;
  }

  root.EventOverrides = {
    merge:          merge,
    mergeAll:       mergeAll,
    fetchForLeague: fetchForLeague,
    OVERRIDABLE_FIELDS: OVERRIDABLE_FIELDS
  };
})(window);
