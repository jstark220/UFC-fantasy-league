// ========================================================================
// COMMISSIONER HELPERS
// ========================================================================
// Single source of truth for "is this user a commissioner of this league?"
// Used by every page that gates UI on commissioner status: league,
// league-settings, score-event, waivers, trades, draft.
//
// A user is a commissioner of a league when:
//   * They are the league's primary owner (leagues.commissioner_id), OR
//   * They have a league_members row in this league with
//     is_commissioner = true (a co-commissioner).
//
// Two flavors are exposed:
//
//   isPrimaryCommissioner(league, userId)
//     True only for the primary owner. Use when an action must be
//     restricted to the owner specifically — e.g., promoting/demoting
//     other members, or transferring ownership.
//
//   isCommissioner(league, members, userId)
//     True for primary OR co-commissioners. Use for general gating:
//     starting the draft, scoring events, processing waivers, etc.
//
// Both helpers tolerate missing inputs by returning false rather than
// throwing — keeps callers free of null guards.
// ========================================================================

(function (root) {

  function isPrimaryCommissioner(league, userId) {
    if (!league || !userId) return false;
    return league.commissioner_id === userId;
  }

  // members: array of league_members rows; each must include user_id and
  // is_commissioner. The caller is expected to already be loading these
  // for the page anyway, so we don't re-fetch here.
  function isCommissioner(league, members, userId) {
    if (isPrimaryCommissioner(league, userId)) return true;
    if (!members || !userId) return false;
    return members.some(function(m) {
      return m.user_id === userId && m.is_commissioner === true;
    });
  }

  // Member-row variant for code paths that already have the user's own
  // league_members row in hand (e.g., on the league page after
  // identifying `myMember`). Avoids the array scan.
  function memberIsCommissioner(league, member) {
    if (!member) return false;
    if (isPrimaryCommissioner(league, member.user_id)) return true;
    return member.is_commissioner === true;
  }

  root.Commissioner = {
    isPrimaryCommissioner: isPrimaryCommissioner,
    isCommissioner:        isCommissioner,
    memberIsCommissioner:  memberIsCommissioner
  };

}(typeof self !== 'undefined' ? self : this));
