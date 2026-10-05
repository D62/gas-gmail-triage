function bcBuildCtx_(msg) {
  const html = msg.getBody() || '';
  const lines = bcHtmlToLines_(html.length > 50 ? html : msg.getPlainBody());
  return { msg, from: msg.getFrom(), subject: msg.getSubject(), date: msg.getDate(), lines, text: lines.join(' '), links: bcExtractLinks_(html), attachments: msg.getAttachments({ includeInlineImages: false }) };
}

function bcHtmlToLines_(html) {
  let t = String(html || '')
    .replace(/<(script|style|head)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(td|th|tr|p|div|h[1-6]|li|table|ul|ol|section|article|center|blockquote)>/gi, '\n')
    .replace(/<(tr|p|div|h[1-6]|li|table)\b[^>]*>/gi, '\n')
    .replace(/<[^>]+>/g, '');
  t = bcDecode_(t).replace(/[­͏​-‏⁠﻿]/g, '').replace(/[   ]/g, ' ');
  return t.split(/\r?\n/).map(l => l.replace(/\s+/g, ' ').trim()).filter(l => l && !/^[-_=─]{3,}$/.test(l));
}

function bcDecode_(s) {
  const e = { nbsp: ' ', amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", eacute: 'é', egrave: 'è', ecirc: 'ê', euml: 'ë', agrave: 'à', acirc: 'â', ccedil: 'ç', ocirc: 'ô', ucirc: 'û', ugrave: 'ù', icirc: 'î', iuml: 'ï', Eacute: 'É', euro: '€', rsquo: '’', lsquo: '‘', ldquo: '“', rdquo: '”', laquo: '«', raquo: '»', hellip: '…', ndash: '–', mdash: '-', middot: '·', bull: '•', deg: '°' };
  return s.replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(+d))
    .replace(/&([a-zA-Z]+);/g, (m, n) => e[n] ?? m);
}

function bcExtractLinks_(html) {
  const out = [], re = /<a\b[^>]*href\s*=\s*["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi; let m;
  while ((m = re.exec(html || ''))) { const url = bcDecode_(m[1]).trim(); if (/^https?:/i.test(url)) out.push({ url, text: bcDecode_(m[2].replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim() }); }
  return out;
}

function bcFindLink_(ctx, re) { return (ctx.links.find(x => re.test(x.url)) || ctx.links.find(x => re.test(x.text)) || {}).url || ''; }
function bcPad_(n) { return (n < 10 ? '0' : '') + n; }
function bcIso_(y, mo, d, h, mi) { return y + '-' + bcPad_(mo) + '-' + bcPad_(d) + 'T' + bcPad_(h || 0) + ':' + bcPad_(mi || 0) + ':00'; }
function bcPlusMin_(iso, min) {
  // iso may already carry an explicit offset/Z (e.g. schema.org dates often
  // do) — only append 'Z' when there isn't one, otherwise "...+02:00Z" is
  // two conflicting timezone markers and parses to an invalid date.
  const hasOffset = /[+-]\d{2}:\d{2}$|Z$/.test(iso);
  const base = iso.length === 10 ? iso + 'T00:00:00' : iso;
  const d = new Date(hasOffset ? base : base + 'Z');
  if (isNaN(d.getTime())) throw new Error('bcPlusMin_: invalid date "' + iso + '"');
  d.setUTCMinutes(d.getUTCMinutes() + min);
  return d.toISOString().slice(0, 19);
}
function bcUtcToLocal_(s) { return Utilities.formatDate(new Date(Date.UTC(+s.slice(0,4), +s.slice(4,6)-1, +s.slice(6,8), +s.slice(9,11), +s.slice(11,13), +s.slice(13,15))), BC.TIMEZONE, "yyyy-MM-dd'T'HH:mm:ss"); }
function bcNormalize_(s) { return String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase(); }

const bcMonthMap = {
  jan: 0, january: 0, janvier: 0, enero: 0, janeiro: 0, gennaio: 0, januar: 0,
  feb: 1, february: 1, fevrier: 1, febrero: 1, fevereiro: 1, febbraio: 1, februar: 1,
  mar: 2, march: 2, mars: 2, marzo: 2, marco: 2, marz: 2,
  apr: 3, april: 3, avril: 3, abril: 3, aprile: 3,
  may: 4, mai: 4, mayo: 4, maio: 4, maggio: 4,
  jun: 5, june: 5, juin: 5, junio: 5, junho: 5, giugno: 5, juni: 5,
  jul: 6, july: 6, juillet: 6, julio: 6, julho: 6, luglio: 6,
  aug: 7, august: 7, aout: 7, agosto: 7,
  sep: 8, sept: 8, september: 8, septembre: 8, septiembre: 8, setembro: 8, settembre: 8,
  oct: 9, october: 9, octobre: 9, octubre: 9, outubro: 9, ottobre: 9, oktober: 9,
  nov: 10, november: 10, novembre: 10, noviembre: 10, novembro: 10,
  dec: 11, december: 11, decembre: 11, diciembre: 11, dezembro: 11, dicembre: 11, dezember: 11,
};
const bcMonthNamesRe = Object.keys(bcMonthMap).sort((a, b) => b.length - a.length).join('|');

// Pulls plausible calendar dates (YYYY-MM-DD) out of free text, no AI
// involved — ISO, numeric DD/MM/YYYY-ish, and "6 October 2026" /
// "October 6, 2026" style in several languages. Used to scope a cheap
// Calendar lookup to the actual booking window instead of guessing broadly.
function bcExtractDates_(text) {
  const t = bcNormalize_(text);
  const dates = new Set();
  const addYMD = (y, mo, d) => {
    const yy = +y, mm = +mo, dd = +d;
    if (yy >= 2020 && yy <= 2035 && mm >= 1 && mm <= 12 && dd >= 1 && dd <= 31) dates.add(yy + '-' + bcPad_(mm) + '-' + bcPad_(dd));
  };
  for (const m of t.matchAll(/\b(\d{4})-(\d{1,2})-(\d{1,2})\b/g)) addYMD(m[1], m[2], m[3]);
  for (const m of t.matchAll(/\b(\d{1,2})[/.](\d{1,2})[/.](\d{4})\b/g)) { addYMD(m[3], m[2], m[1]); addYMD(m[3], m[1], m[2]); }
  const dMonY = new RegExp('\\b(\\d{1,2})\\s+(' + bcMonthNamesRe + ')\\.?\\s+(\\d{4})', 'g');
  for (const m of t.matchAll(dMonY)) addYMD(m[3], bcMonthMap[m[2]] + 1, m[1]);
  const monDY = new RegExp('\\b(' + bcMonthNamesRe + ')\\.?\\s+(\\d{1,2}),?\\s+(\\d{4})', 'g');
  for (const m of t.matchAll(monDY)) addYMD(m[3], bcMonthMap[m[1]] + 1, m[2]);
  return [...dates].sort();
}

// True if two titles share at least half the significant (>2 char) words of
// the shorter one — catches same-event matches when the two sources word the
// location so differently that neither is a substring of the other (e.g. a
// university's full name vs just the amphitheatre name).
function bcTitleSimilar_(a, b) {
  const words = s => new Set(bcNormalize_(s).replace(/[^\p{L}\p{N}\s]/gu, ' ').split(/\s+/).filter(w => w.length > 2));
  const wa = words(a), wb = words(b);
  if (!wa.size || !wb.size) return false;
  let common = 0;
  wa.forEach(w => { if (wb.has(w)) common++; });
  return common / Math.min(wa.size, wb.size) >= 0.5;
}
function bcTicketsFolder_() {
  const id = PropertiesService.getScriptProperties().getProperty('TICKETS_FOLDER_ID');
  if (!id) throw new Error('TICKETS_FOLDER_ID is not set — add it via setupConfig().');
  return DriveApp.getFolderById(id);
}
function bcTzCity_(s) {
  const n = bcNormalize_(s);
  if (/londres|london|heathrow|gatwick|st pancras|stansted|luton|edinb|manchester/.test(n)) return 'Europe/London';
  if (/lisbonne|lisbon|\bporto\b|faro/.test(n)) return 'Europe/Lisbon';
  if (/dublin/.test(n)) return 'Europe/Dublin';
  return BC.TIMEZONE;
}
const bcIataTz = {
  LHR:'Europe/London', LGW:'Europe/London', STN:'Europe/London', LTN:'Europe/London', LCY:'Europe/London',
  MAN:'Europe/London', EDI:'Europe/London', GLA:'Europe/London', BHX:'Europe/London', DUB:'Europe/Dublin',
  LIS:'Europe/Lisbon', OPO:'Europe/Lisbon', FAO:'Europe/Lisbon',
  JFK:'America/New_York', EWR:'America/New_York', LGA:'America/New_York', BOS:'America/New_York',
  IAD:'America/New_York', MIA:'America/New_York', ATL:'America/New_York',
  YYZ:'America/Toronto', YUL:'America/Toronto',
  ORD:'America/Chicago', DFW:'America/Chicago', IAH:'America/Chicago',
  LAX:'America/Los_Angeles', SFO:'America/Los_Angeles', SEA:'America/Los_Angeles', LAS:'America/Los_Angeles',
  NRT:'Asia/Tokyo', HND:'Asia/Tokyo', KIX:'Asia/Tokyo', ICN:'Asia/Seoul',
  DXB:'Asia/Dubai', IST:'Europe/Istanbul', SAW:'Europe/Istanbul',
  ATH:'Europe/Athens', HEL:'Europe/Helsinki', RAK:'Africa/Casablanca', CMN:'Africa/Casablanca',
};
function bcTzIata_(code, city) { return bcIataTz[code] || bcTzCity_(city || ''); }

const bcIataContinent = {
  // Europe
  CDG:'EU', ORY:'EU', LYS:'EU', NCE:'EU', MRS:'EU', TLS:'EU', BOD:'EU', NTE:'EU', RNS:'EU',
  LHR:'EU', LGW:'EU', STN:'EU', LTN:'EU', LCY:'EU', MAN:'EU', EDI:'EU', GLA:'EU', BHX:'EU',
  AMS:'EU', BRU:'EU', CRL:'EU', LGG:'EU',
  MAD:'EU', BCN:'EU', VLC:'EU', AGP:'EU', PMI:'EU',
  FCO:'EU', MXP:'EU', LIN:'EU', VCE:'EU', NAP:'EU', BLQ:'EU', TRN:'EU',
  BER:'EU', MUC:'EU', FRA:'EU', HAM:'EU', DUS:'EU', CGN:'EU', STR:'EU', NUE:'EU',
  ZRH:'EU', GVA:'EU', BSL:'EU',
  VIE:'EU', PRG:'EU', WAW:'EU', KRK:'EU', BUD:'EU', BEG:'EU', SOF:'EU', OTP:'EU',
  ATH:'EU', SKG:'EU', IST:'EU', SAW:'EU', ADB:'EU',
  HEL:'EU', ARN:'EU', CPH:'EU', OSL:'EU', GOT:'EU', BGO:'EU',
  LIS:'EU', OPO:'EU', FAO:'EU', DUB:'EU',
  RAK:'AF', CMN:'AF', TUN:'AF', ALG:'AF', CAI:'AF', NBO:'AF', CPT:'AF', JNB:'AF',
  DXB:'ME', DOH:'ME', AUH:'ME', KWI:'ME', BAH:'ME', RUH:'ME', TLV:'ME', AMM:'ME', BEY:'ME',
  // North America
  JFK:'NA', EWR:'NA', LGA:'NA', BOS:'NA', IAD:'NA', DCA:'NA', MIA:'NA', FLL:'NA', MCO:'NA',
  ATL:'NA', ORD:'NA', MDW:'NA', DFW:'NA', IAH:'NA', HOU:'NA', LAX:'NA', SFO:'NA', OAK:'NA',
  SEA:'NA', LAS:'NA', DEN:'NA', SLC:'NA', PHX:'NA', PDX:'NA', MSP:'NA', DTW:'NA', CLT:'NA',
  YYZ:'NA', YUL:'NA', YVR:'NA', YYC:'NA',
  CUN:'NA', MEX:'NA', GDL:'NA',
  // South/Central America
  GRU:'SA', GIG:'SA', EZE:'SA', SCL:'SA', BOG:'SA', LIM:'SA', UIO:'SA', PTY:'SA',
  // Asia
  NRT:'AS', HND:'AS', KIX:'AS', NGO:'AS', ICN:'AS', GMP:'AS', PEK:'AS', PKX:'AS', PVG:'AS',
  SHA:'AS', CAN:'AS', SZX:'AS', HKG:'AS', TPE:'AS', MNL:'AS',
  SIN:'AS', KUL:'AS', BKK:'AS', DMK:'AS', CGK:'AS', HAN:'AS', SGN:'AS',
  DEL:'AS', BOM:'AS', MAA:'AS', HYD:'AS', BLR:'AS', CCU:'AS', CMB:'AS',
  // Oceania
  SYD:'OC', MEL:'OC', BNE:'OC', PER:'OC', AKL:'OC',
};
function bcFlightContinent_(iataCode) { return bcIataContinent[iataCode] || null; }
function bcIsLongHaul_(depCode, arrCode) {
  const d = bcFlightContinent_(depCode), a = bcFlightContinent_(arrCode);
  if (!d || !a) return true; // unknown → assume long haul
  if (d === a) return false;
  // EU↔ME or EU↔AF treated as short/medium
  if ((d === 'EU' || d === 'ME' || d === 'AF') && (a === 'EU' || a === 'ME' || a === 'AF')) return false;
  return true;
}

function bcIsEurostar_(ev) {
  if (ev.cat !== 'train') return false;
  const loc = bcNormalize_(ev.location || '') + ' ' + bcNormalize_(ev.title || '');
  const provider = bcNormalize_(ev.provider || '');
  if (/eurostar/.test(provider) || /eurostar/.test(loc)) return true;
  const hasUK = /london|st.pancras|ashford|ebbsfleet|stratford/.test(loc);
  const hasContinent = /paris|nord|bruxelles|brussels|midi|amsterdam|rotterdam|lille/.test(loc);
  return hasUK && hasContinent;
}

function bcPreDepartureEv_(ev) {
  if (ev.allDay || !ev.start) return null;
  let bufMin = 0, label = '';
  if (ev.cat === 'train') {
    if (!bcIsEurostar_(ev)) return null;
    bufMin = bcDepartureBuffer.eurostar;
    label = '🚆 Eurostar check-in';
  } else if (ev.cat === 'flight') {
    const codes = (ev.title + ' ' + (ev.location || '')).match(/\b([A-Z]{3})\b/g) || [];
    const depCode = codes[0] || '', arrCode = codes[codes.length - 1] || '';
    const long = bcIsLongHaul_(depCode, arrCode);
    bufMin = long ? bcDepartureBuffer.flight_long : bcDepartureBuffer.flight_short;
    label = long ? '✈️ Airport (long haul)' : '✈️ Airport check-in';
  } else {
    return null;
  }
  const bufEnd = ev.start.length === 10 ? ev.start + 'T00:00:00' : ev.start;
  const bufStart = bcPlusMin_(bufEnd, -bufMin);
  return {
    provider: ev.provider, cat: ev.cat, ref: ev._key || '',
    title: label,
    start: bufStart, end: bufEnd,
    tzStart: ev.tzStart || BC.TIMEZONE, tzEnd: ev.tzStart || BC.TIMEZONE,
    location: ev.location || '',
    allDay: false,
    details: [['For', ev.title]],
    links: [],
    _isPreDeparture: true,
  };
}

function bcIsoToMs_(iso) { return new Date((iso.length === 10 ? iso + 'T00:00:00' : iso) + 'Z').getTime(); }
const bcConnectionGapMax = 12 * 60; // minutes — beyond this, legs are treated as unrelated

// Pairs up consecutive flight/train legs that are close enough in time to be
// the same journey. Flight→flight connections get one "Connection" block
// spanning the whole layover and skip the per-leg security buffer (no
// re-clearing security airside). Any other combination (train→flight,
// flight→train, train→train) keeps the normal security buffer for the next
// leg and fills only the time before it — the two blocks never overlap.
function bcConnectionEvents_(evs) {
  const legs = evs.filter(e => !e.allDay && (e.cat === 'flight' || e.cat === 'train')).sort((a, b) => bcIsoToMs_(a.start) - bcIsoToMs_(b.start));
  const connections = [];
  const suppressSecurityFor = new Set();
  for (let i = 0; i < legs.length - 1; i++) {
    const a = legs[i], b = legs[i + 1];
    const aEnd = a.end || a.start;
    const gapMin = (bcIsoToMs_(b.start) - bcIsoToMs_(aEnd)) / 60000;
    if (gapMin <= 0 || gapMin > bcConnectionGapMax) continue;
    if (a.cat === 'flight' && b.cat === 'flight') {
      suppressSecurityFor.add(b);
      connections.push(bcConnectionEv_(a, b, aEnd, b.start));
    } else {
      const secBlock = bcPreDepartureEv_(b);
      const connectionEnd = secBlock ? secBlock.start : b.start;
      if (bcIsoToMs_(aEnd) < bcIsoToMs_(connectionEnd)) connections.push(bcConnectionEv_(a, b, aEnd, connectionEnd));
    }
  }
  return { connections, suppressSecurityFor };
}

function bcConnectionEv_(a, b, start, end) {
  return {
    provider: a.provider, cat: a.cat, ref: '',
    title: '🔁 Connection',
    start, end,
    tzStart: a.tzEnd || a.tzStart || BC.TIMEZONE, tzEnd: b.tzStart || BC.TIMEZONE,
    location: a.location || '',
    allDay: false,
    details: [['Between', a.title + ' → ' + b.title]],
    links: [],
    _isPreDeparture: true,
  };
}

function bcIcsDate_(v, params) {
  if (/^\d{8}$/.test(v)) return { dt: v.slice(0,4)+'-'+v.slice(4,6)+'-'+v.slice(6,8)+'T00:00:00', tz: BC.TIMEZONE };
  const m = v.match(/^(\d{8}T\d{6})(Z)?$/); if (!m) return null;
  if (m[2]) return { dt: bcUtcToLocal_(m[1]), tz: BC.TIMEZONE };
  const tz = (params.match(/TZID=([^;:]+)/) || [])[1];
  const dt = m[1].slice(0,4)+'-'+m[1].slice(4,6)+'-'+m[1].slice(6,8)+'T'+m[1].slice(9,11)+':'+m[1].slice(11,13)+':'+m[1].slice(13,15);
  return { dt, tz: (tz && /^[A-Za-z_]+\/[A-Za-z_/-]+$/.test(tz)) ? tz : BC.TIMEZONE };
}

function bcParseIcs_(txt) {
  return bcParseAllIcs_(txt)[0] || null;
}

function bcParseAllIcs_(txt) {
  const unfolded = String(txt || '').replace(/\r?\n[ \t]/g, '');
  const results = [];
  const re = /BEGIN:VEVENT[\s\S]*?END:VEVENT/g;
  let m;
  while ((m = re.exec(unfolded)) !== null) {
    const block = m[0];
    const field = k => { const fm = block.match(new RegExp('^' + k + '((?:;[^:\\r\\n]*)?):(.*)$', 'mi')); return fm ? { p: fm[1], v: fm[2].replace(/\\n/gi,'\n').replace(/\\,/g,',').replace(/\\;/g,';').trim() } : null; };
    const s = field('DTSTART'); if (!s) continue;
    const start = bcIcsDate_(s.v, s.p); if (!start?.dt) continue;
    const e = field('DTEND'), l = field('LOCATION'), sum = field('SUMMARY'), uid = field('UID'), url = field('URL'), desc = field('DESCRIPTION');
    results.push({ start, end: e ? bcIcsDate_(e.v, e.p) : null, location: l?.v || '', summary: sum?.v || '', uid: uid?.v || '', url: url?.v || '', description: desc ? desc.v.slice(0, 500) : '' });
  }
  return results;
}
