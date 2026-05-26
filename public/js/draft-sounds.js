// ========================================================================
// DRAFT SOUNDS
// Web Audio API-synthesized sound effects for the draft room. No external
// audio files — each effect is a quick mix of oscillator tones built at
// play time. Cheap to ship (zero asset hosting), instant playback (no
// network), and easy to tweak (numbers, not files).
//
// Browser autoplay policies block audio until the user has interacted
// with the page. The AudioContext is created lazily on the first play()
// call; if its state is "suspended", we resume() it. Because draft.js
// only triggers sounds AFTER user clicks (pick events, etc.), the first
// click reliably unlocks subsequent playback.
//
// Public API:
//   DraftSounds.pickMade()       — soft click for any pick landing
//   DraftSounds.yourPickMade()   — three-tone ascending pop for own pick
//   DraftSounds.yourTurn()       — chime when the clock moves to you
//   DraftSounds.clockWarn()      — single beep, ~30s warning
//   DraftSounds.clockUrgent()    — double beep, ~10s urgency
//   DraftSounds.clockExpired()   — buzzer at 0:00
//   DraftSounds.draftDone()      — major arpeggio at draft completion
//   DraftSounds.setMuted(bool)   — toggle mute (persists to localStorage)
//   DraftSounds.isMuted()        — current mute state
// ========================================================================

(function (root) {
  var ctx   = null;
  var muted = false;

  // Restore mute pref BEFORE any tone() call so the first sound respects
  // the user's prior choice. localStorage may throw in private mode.
  try { muted = localStorage.getItem('draft-sounds-muted') === '1'; } catch (e) { /* private mode */ }

  function ensureCtx() {
    if (ctx) return ctx;
    try {
      ctx = new (window.AudioContext || window.webkitAudioContext)();
    } catch (e) {
      // No Web Audio support — sounds simply no-op.
      console.warn('[DraftSounds] Web Audio not available; sounds disabled');
    }
    return ctx;
  }

  function setMuted(next) {
    muted = !!next;
    try { localStorage.setItem('draft-sounds-muted', muted ? '1' : '0'); } catch (e) { /* private mode */ }
  }
  function isMuted() { return muted; }

  // Single oscillator + envelope, fire-and-forget. opts:
  //   freq    : Hz (required)
  //   dur     : seconds for the audible portion (required)
  //   gain    : peak gain 0..1 (default 0.18)
  //   type    : oscillator type (default 'sine')
  //   delay   : seconds before this tone starts, used to layer notes
  //   attack  : attack time in seconds (default 0.005)
  function tone(opts) {
    if (muted) return;
    var c = ensureCtx();
    if (!c) return;
    // Autoplay-policy resume — no-op if already running. Returns a promise
    // but we don't need to await it; the start/stop timing handles itself.
    if (c.state === 'suspended') c.resume();

    var osc = c.createOscillator();
    var g   = c.createGain();
    osc.type            = opts.type || 'sine';
    osc.frequency.value = opts.freq;

    var startAt = c.currentTime + (opts.delay || 0);
    var peak    = opts.gain   != null ? opts.gain   : 0.18;
    var attack  = opts.attack != null ? opts.attack : 0.005;

    g.gain.setValueAtTime(0, startAt);
    g.gain.linearRampToValueAtTime(peak, startAt + attack);
    // Exponential decay to near-silent. Can't ramp to exactly 0 with
    // exponentialRampToValueAtTime, so we end at 0.0001.
    g.gain.exponentialRampToValueAtTime(0.0001, startAt + opts.dur);

    osc.connect(g);
    g.connect(c.destination);
    osc.start(startAt);
    // Small buffer past the decay end so the node disposal doesn't audibly
    // truncate the tail.
    osc.stop(startAt + opts.dur + 0.05);
  }

  // ----- Public sounds ---------------------------------------------------

  // Soft click — any pick (including others). Kept quiet so 7 other
  // managers' picks don't drown out voice chat during a live draft.
  function pickMade() {
    tone({ freq: 700, dur: 0.07, gain: 0.10 });
  }

  // Own pick — three-tone ascending pop. Distinctive enough to confirm
  // the click registered even without looking at the board.
  function yourPickMade() {
    tone({ freq: 540, dur: 0.10, gain: 0.20 });
    tone({ freq: 760, dur: 0.14, gain: 0.20, delay: 0.07 });
    tone({ freq: 980, dur: 0.18, gain: 0.17, delay: 0.16 });
  }

  // Your turn — major-triad chime so the user can step away from the
  // keyboard and still know when it's their pick.
  function yourTurn() {
    tone({ freq: 523, dur: 0.15, gain: 0.18 });
    tone({ freq: 659, dur: 0.15, gain: 0.18, delay: 0.13 });
    tone({ freq: 784, dur: 0.25, gain: 0.18, delay: 0.26 });
  }

  // Clock warning at ~30s — single soft square-wave beep.
  function clockWarn() {
    tone({ freq: 880, dur: 0.10, gain: 0.13, type: 'square' });
  }

  // Clock urgent at ~10s — double-tap higher beep.
  function clockUrgent() {
    tone({ freq: 1000, dur: 0.07, gain: 0.16, type: 'square' });
    tone({ freq: 1000, dur: 0.07, gain: 0.16, type: 'square', delay: 0.11 });
  }

  // Clock at 0:00 — low sawtooth buzzer. Distinct from any other sound
  // so the user knows immediately that the timer expired.
  function clockExpired() {
    tone({ freq: 200, dur: 0.40, gain: 0.25, type: 'sawtooth' });
  }

  // Draft complete — confident ascending C-major arpeggio.
  function draftDone() {
    tone({ freq: 523, dur: 0.25, gain: 0.20 });
    tone({ freq: 659, dur: 0.25, gain: 0.20, delay: 0.13 });
    tone({ freq: 784, dur: 0.40, gain: 0.20, delay: 0.26 });
  }

  root.DraftSounds = {
    pickMade:     pickMade,
    yourPickMade: yourPickMade,
    yourTurn:     yourTurn,
    clockWarn:    clockWarn,
    clockUrgent:  clockUrgent,
    clockExpired: clockExpired,
    draftDone:    draftDone,
    setMuted:     setMuted,
    isMuted:      isMuted
  };
})(typeof window !== 'undefined' ? window : this);
