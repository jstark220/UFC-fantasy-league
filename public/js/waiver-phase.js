// ========================================================================
// WAIVER PHASE UTILITY
//
// All date/time math for the waiver system. All cutoffs land on 3:00 AM
// in America/New_York. Saturdays are event days (UFC convention).
//
// Phases relative to the next event_date (a Saturday):
//
//   WINDOW_PRE   — Thu 3am ET (event week)        → Fri 3am ET
//   WINDOW_POST  — Sun 3am ET (after event)       → Tue 3am ET
//   FA           — anywhere else
//
// Roster cap expansion (independent of phase): +3 from Thu 3am ET (event
// week) → Sun 3am ET (after event). Wed 3am ET is the auto-drop cutoff.
//
// Per-fighter rolling waiver: a dropped fighter is on waivers in this
// league until 3am ET on (drop_date_ET + 2 calendar days).
// ========================================================================

// ----- Time-zone helpers -------------------------------------------------
// Browsers don't expose "what wall-clock day is it in New York" directly,
// so we use Intl + a fixed-format parse to derive ET components from any
// JS Date. All math below uses these helpers — never .getDay()/.getHours()
// which would silently use the user's local timezone.

var WP_TZ = 'America/New_York';

// Returns { year, month, day, weekday, hour, minute, second } for `date`
// rendered in America/New_York. Weekday is 0=Sun..6=Sat to match Date#getDay.
function wpEtParts(date) {
  var fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: WP_TZ,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
    hour12: false, weekday: 'short'
  });
  var parts = {};
  fmt.formatToParts(date).forEach(function(p) { parts[p.type] = p.value; });
  var weekdayMap = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  // Intl uses 24-hour with hourCycle h23, but some engines output "24" at
  // midnight — normalize to 0.
  var hour = parseInt(parts.hour, 10);
  if (hour === 24) hour = 0;
  return {
    year:    parseInt(parts.year,   10),
    month:   parseInt(parts.month,  10),  // 1-12
    day:     parseInt(parts.day,    10),
    weekday: weekdayMap[parts.weekday],
    hour:    hour,
    minute:  parseInt(parts.minute, 10),
    second:  parseInt(parts.second, 10)
  };
}

// Returns the ET UTC-offset in minutes at a given instant. ET is always
// either -300 (EST, UTC-5) or -240 (EDT, UTC-4). We read it from the
// browser's IANA timezone data via Intl.
function wpEtOffsetMinutes(date) {
  var fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: WP_TZ,
    timeZoneName: 'shortOffset'
  });
  var parts = fmt.formatToParts(date);
  var nm = parts.find(function(p) { return p.type === 'timeZoneName'; });
  // Format is "GMT-4" / "GMT-5" / occasionally "GMT-4:00"
  var m = nm && nm.value.match(/GMT([+-])(\d{1,2})(?::(\d{2}))?/);
  if (!m) return -300; // sensible default
  var sign  = m[1] === '-' ? -1 : 1;
  var hours = parseInt(m[2], 10);
  var mins  = parseInt(m[3] || '0', 10);
  return sign * (hours * 60 + mins);
}

// Build a Date for "y-m-d HH:MM" interpreted as ET wall-clock time.
// Strategy: build the same components as UTC, then shift by the ET offset
// at that moment. The offset itself is read at noon-of-that-day (stable,
// avoids DST gap/overlap edge cases since DST transitions happen at 2am).
function wpDateInEt(year, month, day, hour, minute) {
  hour   = hour   || 0;
  minute = minute || 0;
  var noonUtc   = new Date(Date.UTC(year, month - 1, day, 12, 0));
  var offsetMin = wpEtOffsetMinutes(noonUtc);
  // ET wall-clock H:M on that date == UTC H:M - offsetMin minutes
  return new Date(Date.UTC(year, month - 1, day, hour, minute) - offsetMin * 60 * 1000);
}

// "3am ET on the calendar day that contains `relativeTo`'s ET date,
// shifted by `dayDelta` days." So wp3amEtOnDay(now, +1) returns 3am ET
// tomorrow (where "tomorrow" is reckoned in ET).
function wp3amEtOnDay(relativeTo, dayDelta) {
  var p = wpEtParts(relativeTo);
  // Use a UTC anchor at noon to add days safely across month boundaries
  var anchor = new Date(Date.UTC(p.year, p.month - 1, p.day, 12, 0));
  anchor.setUTCDate(anchor.getUTCDate() + (dayDelta || 0));
  return wpDateInEt(
    anchor.getUTCFullYear(),
    anchor.getUTCMonth() + 1,
    anchor.getUTCDate(),
    3, 0
  );
}

// ----- Public API --------------------------------------------------------

// Given an event Date (event_date is a Saturday in DB convention) and a
// "now" Date, returns the four key cutoff timestamps for that event cycle.
// Times are 3am ET. event_date itself is a YYYY-MM-DD string from the DB.
function getEventCutoffs(eventDateStr) {
  // event_date is "YYYY-MM-DD" — interpret as ET midnight on that day so
  // weekday math is stable regardless of the parsing browser's tz.
  var parts = eventDateStr.split('-');
  var anchor = wpDateInEt(parseInt(parts[0], 10), parseInt(parts[1], 10),
                          parseInt(parts[2], 10), 12, 0); // noon ET on event day
  return {
    preOpen:    wp3amEtOnDay(anchor, -2), // Thu 3am ET (event week)
    preClose:   wp3amEtOnDay(anchor, -1), // Fri 3am ET
    postOpen:   wp3amEtOnDay(anchor, +1), // Sun 3am ET
    postClose:  wp3amEtOnDay(anchor, +3), // Tue 3am ET
    autoDrop:   wp3amEtOnDay(anchor, +4), // Wed 3am ET (auto-drop sweep)
    capExpand:  wp3amEtOnDay(anchor, -2), // Thu 3am ET — same as preOpen
    capRevert:  wp3amEtOnDay(anchor, +1)  // Sun 3am ET — same as postOpen
  };
}

// Returns the active phase for `now` given the next event date string.
// `nextEventDateStr` may be null — in which case we're always in FA.
function getWaiverPhase(now, nextEventDateStr) {
  if (!nextEventDateStr) return { phase: 'FA', closesAt: null, opensAt: null };
  var c = getEventCutoffs(nextEventDateStr);
  var t = now.getTime();
  if (t >= c.preOpen.getTime()  && t < c.preClose.getTime())  {
    return { phase: 'WINDOW_PRE',  closesAt: c.preClose,  opensAt: c.preOpen };
  }
  if (t >= c.postOpen.getTime() && t < c.postClose.getTime()) {
    return { phase: 'WINDOW_POST', closesAt: c.postClose, opensAt: c.postOpen };
  }
  // Free agency. Compute when the next window opens for display purposes.
  var nextOpen;
  if      (t < c.preOpen.getTime())  nextOpen = c.preOpen;
  else if (t < c.postOpen.getTime()) nextOpen = c.postOpen;
  else                               nextOpen = null; // event cycle finished
  return { phase: 'FA', closesAt: null, opensAt: nextOpen };
}

// True iff the +3 cap expansion is in effect right now.
function isCapExpanded(now, nextEventDateStr) {
  if (!nextEventDateStr) return false;
  var c = getEventCutoffs(nextEventDateStr);
  var t = now.getTime();
  return t >= c.capExpand.getTime() && t < c.capRevert.getTime();
}

// The roster cap that applies right now (20 normal, 23 during expansion).
function getRosterCap(now, nextEventDateStr) {
  return isCapExpanded(now, nextEventDateStr) ? 23 : 20;
}

// Given a drop timestamp, returns when that fighter clears waivers and
// becomes a free agent. Rule: 3am ET on (drop_date_ET + 2 calendar days).
function getRollingClearTime(droppedAt) {
  return wp3amEtOnDay(droppedAt, +2);
}

// True iff a fighter dropped at `droppedAt` is still on rolling waivers.
function isOnRollingWaiver(droppedAt, now) {
  if (!droppedAt) return false;
  return now.getTime() < getRollingClearTime(droppedAt).getTime();
}

// Format a Date for user display, in ET, like "Fri Apr 30, 3:00 AM ET"
function formatEtDateTime(date) {
  if (!date) return '';
  return date.toLocaleString('en-US', {
    timeZone: WP_TZ,
    weekday: 'short', month: 'short', day: 'numeric',
    hour: 'numeric', minute: '2-digit', hour12: true
  }) + ' ET';
}

// Short relative duration like "in 14h 23m" / "in 2d 5h"
function formatRelativeShort(date, now) {
  if (!date) return '';
  var diffMs = date.getTime() - now.getTime();
  if (diffMs <= 0) return 'now';
  var totalMin = Math.floor(diffMs / 60000);
  var days  = Math.floor(totalMin / (60 * 24));
  var hours = Math.floor((totalMin % (60 * 24)) / 60);
  var mins  = totalMin % 60;
  if (days  > 0) return 'in ' + days  + 'd ' + hours + 'h';
  if (hours > 0) return 'in ' + hours + 'h ' + mins  + 'm';
  return 'in ' + mins + 'm';
}

// Human-readable phase description used in banners/labels
function phaseLabel(phase) {
  if (phase === 'WINDOW_PRE')  return 'Pre-event waivers open';
  if (phase === 'WINDOW_POST') return 'Post-event waivers open';
  return 'Free agency';
}
