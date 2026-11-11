/**
 * Default agent names, hashed off the session id — every robot is somebody
 * from its first frame, the same move autoDecor makes for rooms. A rename in
 * the agent panel overrides this (stored server-side, on Robot.name); two
 * agents occasionally sharing a default is charming, not a bug, and renaming
 * settles it.
 *
 * The pool is office wordplay: every callsign is a plausible name hiding a
 * dev / design / lead / marketing / ops joke. Changing this list re-christens
 * every un-renamed robot, so add to the end rather than reshuffling for fun.
 */
const NAMES = [
  // engineering
  'Jason', // JSON
  'Cachel', // Rachel, cached
  'Mergaret', // merges without conflict
  'Deverly', // Beverly, but dev
  'Gitta', // commits often
  'Bugsy', // finds them, mostly makes them
  'Patch',
  'Cody',
  'Rusty', // memory-safe
  'Javier', // runs on the JVM
  'Swifty',
  'Pippa', // installs fine
  'Noda', // event-looped
  'Sudo', // gets things done, with permission
  'Tessa', // green across the suite
  'Linta', // has opinions about your semicolons
  'Stashley', // will pop it later
  'Reggie', // regex, allegedly readable
  'Kernel', // outranks Colonel
  'Vimla', // knows how to exit
  // design
  'Ingrid', // always in grid
  'Margo', // minds the margins
  'Paddy', // 16px of it
  'Serif',
  'Kern',
  'Vectoria', // scales losslessly
  'Fontaine',
  'Hue',
  'Glyph',
  'Pica',
  'Bez', // draws the curves
  // lead / pm
  'Stan', // runs the standup
  'Miles', // hits the milestones
  'Gantt', // has a chart about it
  'Rhoda', // owns the roadmap
  'Della', // delegates
  'Piper', // keeps the pipelines green
  'Retro', // what went well?
  'Sprint',
  // marketing
  'Brandy', // on-brand
  'Buzz',
  'Sloane', // has a slogan for it
  'Seo', // ranks first
  'Addy', // runs the ads
  'Cammy', // launches the campaign
  'Pitch',
  'Merch',
  // ops / data
  'Paige', // gets paged
  'Logan', // reads the logs
  'Shelly', // lives in the terminal
  'Roxy', // the proxy
  'Upton', // five nines
  'Cron', // right on schedule
  'Porter', // knows which one is open
  'Beta', // ships early
  'Dash', // board
  'Ruth', // has root
  // the back office
  'Ledger', // balances
  'Lex', // legal
  'Audrey', // audits
  'Payton', // runs payroll
];

export function defaultAgentName(sessionId: string): string {
  let h = 0;
  for (let i = 0; i < sessionId.length; i++) h = (h * 31 + sessionId.charCodeAt(i)) | 0;
  return NAMES[Math.abs(h) % NAMES.length];
}
