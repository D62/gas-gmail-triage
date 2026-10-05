/* ===================== LAYER 1 — SCHEMA.ORG ===================== */

const bcSchemaTypes = ['FlightReservation', 'TrainReservation', 'BusReservation', 'LodgingReservation',
  'EventReservation', 'FoodEstablishmentReservation', 'RentalCarReservation', 'ReservationPackage'];

function bcEventsFromSchema_(ctx) {
  const html = ctx.msg.getBody() || '';
  const domain = bcReconstructDomain_(ctx.from);
  const results = [];
  for (const obj of [...bcExtractJsonLd_(html), ...bcParseMicrodata_(html)]) {
    const type = bcSchemaType_(obj);
    if (!bcSchemaTypes.includes(type)) continue;
    if (/cancelled|cancel|annul/i.test(String(obj.reservationStatus || ''))) continue;
    if (type === 'ReservationPackage') {
      [].concat(obj.subReservation || []).forEach(sub => { const ev = bcSchemaToEvent_(sub, domain); if (ev && ev.title && ev.start) results.push(ev); });
    } else {
      const ev = bcSchemaToEvent_(obj, domain);
      if (ev && ev.title && ev.start) results.push(ev);
    }
  }
  return results;
}

function bcExtractJsonLd_(html) {
  const out = [];
  const re = /<script\b[^>]*\btype\s*=\s*["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  let m;
  while ((m = re.exec(html))) {
    try { [].concat(JSON.parse(m[1].trim())).forEach(item => { const g = item['@graph']; g ? [].concat(g).forEach(o => out.push(o)) : out.push(item); }); } catch (e) {}
  }
  return out;
}

function bcParseMicrodata_(html) {
  const types = 'FlightReservation|TrainReservation|BusReservation|LodgingReservation|EventReservation|FoodEstablishmentReservation|RentalCarReservation|ReservationPackage';
  const startRe = new RegExp('<[^>]+\\bitemscope\\b[^>]*\\bitemtype\\s*=\\s*["\'][^"\']*schema\\.org\\/(' + types + ')[^"\']*["\'][^>]*>', 'gi');
  const positions = [];
  let m;
  while ((m = startRe.exec(html)) !== null) positions.push({ pos: m.index + m[0].length, type: m[1] });
  return positions.map(({ pos, type }, i) => {
    const block = html.slice(pos, i + 1 < positions.length ? positions[i + 1].pos : html.length);
    const obj = { '@type': 'http://schema.org/' + type };
    const scan = re => { let pm; while ((pm = re.exec(block))) { const p = pm[1] || pm[4], v = pm[2] || pm[3]; if (p && v && !obj[p]) obj[p] = v; } };
    scan(/itemprop\s*=\s*["']([^"']+)["'][^>]*content\s*=\s*["']([^"']+)["']|content\s*=\s*["']([^"']+)["'][^>]*itemprop\s*=\s*["']([^"']+)["']/gi);
    scan(/itemprop\s*=\s*["']([^"']+)["'][^>]*href\s*=\s*["']([^"']+)["']|href\s*=\s*["']([^"']+)["'][^>]*itemprop\s*=\s*["']([^"']+)["']/gi);
    scan(/itemprop\s*=\s*["']([^"']+)["'][^>]*datetime\s*=\s*["']([^"']+)["']|datetime\s*=\s*["']([^"']+)["'][^>]*itemprop\s*=\s*["']([^"']+)["']/gi);
    let pm2;
    const textRe = /<(?:span|div|td|p|h[1-6]|a)\b[^>]*\bitemprop\s*=\s*["']([^"']+)["'][^>]*>\s*([^<]{1,200}?)\s*<\//gi;
    while ((pm2 = textRe.exec(block))) { if (pm2[2].trim() && !obj[pm2[1]]) obj[pm2[1]] = pm2[2].trim(); }
    return obj;
  }).filter(obj => Object.keys(obj).length > 1);
}

function bcSchemaType_(obj) { return String(obj['@type'] || '').replace(/.*schema\.org\//, ''); }
function bcSchemaGet_(obj, ...path) { let c = obj; for (const k of path) { if (c == null || typeof c !== 'object') return null; c = c[k]; } return c != null ? String(c) : null; }
function bcSchemaDate_(val) {
  if (!val) return null;
  const s = String(val).trim();
  let iso = null;
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(s)) iso = s;
  else if (/^\d{4}-\d{2}-\d{2}$/.test(s)) iso = s + 'T00:00:00';
  if (!iso) return null;
  // Matches the digit pattern but may still be an impossible date (month 13, etc.)
  return isNaN(new Date(iso.slice(0, 19) + 'Z').getTime()) ? null : iso;
}
function bcCategoryActive_(cat) {
  const map = { train: 'transport', flight: 'transport', hotel: 'accommodation', event: 'show', appointment_medical: 'appointment_medical', appointment_personal: 'appointment_personal', meeting: 'meeting' };
  return bcActiveCategories[map[cat] || cat] !== false;
}

function bcSchemaToEvent_(obj, domain) {
  switch (bcSchemaType_(obj)) {
    case 'FlightReservation':            return bcSchemaFlight_(obj, domain);
    case 'TrainReservation':
    case 'BusReservation':               return bcSchemaTrain_(obj, domain);
    case 'LodgingReservation':           return bcSchemaLodging_(obj, domain);
    case 'EventReservation':             return bcSchemaEventRes_(obj, domain);
    case 'FoodEstablishmentReservation': return bcSchemaFood_(obj, domain);
    default:                             return null;
  }
}

function bcSchemaFlight_(obj, domain) {
  const rf = obj.reservationFor || {};
  const dep = rf.departureAirport || {}, arr = rf.arrivalAirport || {}, al = rf.airline || {};
  const depTime = bcSchemaDate_(rf.departureTime); if (!depTime) return null;
  const depCode = dep.iataCode || '', arrCode = arr.iataCode || '';
  const depCity = dep.name || '', arrCity = arr.name || '';
  const flight = rf.flightNumber || '', airline = al.name || al.iataCode || '';
  const ref = bcSchemaGet_(obj, 'reservationNumber') || '';
  const title = (flight ? flight + ' · ' : '') + depCity + (depCode ? ' (' + depCode + ')' : '') + ' → ' + arrCity + (arrCode ? ' (' + arrCode + ')' : '');
  return {
    provider: domain, cat: 'flight', ref,
    title: bcPickEmoji_('flight', title) + ' ' + title,
    start: depTime, tzStart: bcTzIata_(depCode, depCity),
    end: bcSchemaDate_(rf.arrivalTime) || bcPlusMin_(depTime, bcDefaultDuration.flight), tzEnd: bcTzIata_(arrCode, arrCity),
    location: depCity + (depCode ? ' (' + depCode + ')' : ''),
    details: [['Flight', flight + (airline ? ' (' + airline + ')' : '')], ['Departure', depCity], ['Arrival', arrCity], ['Passenger', bcSchemaGet_(obj, 'underName', 'name') || ''], ['🔖 Reference', ref]],
    links: [['Manage booking', bcSchemaGet_(obj, 'url') || '']],
    _src: 'schema.org departureTime=' + rf.departureTime + ' arrivalTime=' + (rf.arrivalTime || '') + ' | ' + depCity + ' (' + depCode + ') → ' + arrCity + ' (' + arrCode + ')',
  };
}

function bcSchemaTrain_(obj, domain) {
  const rf = obj.reservationFor || {};
  const dep = rf.departureStation || {}, arr = rf.arrivalStation || {};
  const depTime = bcSchemaDate_(rf.departureTime); if (!depTime) return null;
  const depCity = typeof dep === 'string' ? dep : (dep.name || '');
  const arrCity = typeof arr === 'string' ? arr : (arr.name || '');
  const ref = bcSchemaGet_(obj, 'reservationNumber') || '';
  const title = depCity + ' → ' + arrCity;
  return {
    provider: domain, cat: 'train', ref,
    title: bcPickEmoji_('train', title) + ' ' + title,
    start: depTime, tzStart: bcTzCity_(depCity),
    end: bcSchemaDate_(rf.arrivalTime) || bcPlusMin_(depTime, bcDefaultDuration.train), tzEnd: bcTzCity_(arrCity),
    location: depCity,
    details: [['Departure', depCity], ['Arrival', arrCity], ['Passenger', bcSchemaGet_(obj, 'underName', 'name') || ''], ['🔖 Reference', ref]],
    links: [['Manage booking', bcSchemaGet_(obj, 'url') || '']],
    _src: 'schema.org departureTime=' + rf.departureTime + ' arrivalTime=' + (rf.arrivalTime || '') + ' | ' + depCity + ' → ' + arrCity,
  };
}

function bcSchemaLodging_(obj, domain) {
  const rf = obj.reservationFor || {};
  const name = (typeof rf === 'object' ? rf.name : rf) || obj.name || 'Accommodation';
  const checkin  = bcSchemaDate_(obj.checkinDate  || obj.checkinTime); if (!checkin) return null;
  const checkout = bcSchemaDate_(obj.checkoutDate || obj.checkoutTime);
  const ref = bcSchemaGet_(obj, 'reservationNumber') || '';
  return {
    provider: domain, cat: 'hotel', ref, allDay: true,
    title: bcPickEmoji_('hotel', name) + ' ' + name,
    start: checkin.slice(0, 10), end: checkout ? checkout.slice(0, 10) : null,
    location: name,
    details: [['Accommodation', name], ['Check-in', checkin.slice(0, 10)], ['Check-out', checkout ? checkout.slice(0, 10) : ''], ['🔖 Reference', ref]],
    links: [['Manage booking', bcSchemaGet_(obj, 'url') || '']],
    _src: 'schema.org checkin=' + (obj.checkinDate || obj.checkinTime || '') + ' checkout=' + (obj.checkoutDate || obj.checkoutTime || ''),
  };
}

// schema.org Event subtypes — used when available instead of guessing the
// emoji from the title text alone.
const bcEventTypeEmoji = {
  MusicEvent: '🎵',
  TheaterEvent: '🎭',
  ExhibitionEvent: '🖼️',
  ComedyEvent: '😂',
  DanceEvent: '💃',
  SportsEvent: '⚽',
  Festival: '🎪',
  ScreeningEvent: '🎬',
  LiteraryEvent: '📖',
  VisualArtsEvent: '🎨',
};

function bcSchemaEventRes_(obj, domain) {
  const rf = obj.reservationFor || {};
  const isObj = typeof rf === 'object';
  const title = (isObj ? rf.name : rf) || obj.name || domain;
  const startDate = bcSchemaDate_((isObj ? rf.startDate : null) || obj.startDate); if (!startDate) return null;
  const loc = (isObj ? rf.location : null) || obj.location || {};
  const locName = typeof loc === 'object' ? (loc.name || '') : String(loc || '');
  const address = typeof loc === 'object' ? (typeof loc.address === 'string' ? loc.address : (loc.address?.streetAddress || '')) : '';
  // No venue/address at all is a strong sign of broken/sparse markup (seen
  // on some ticket resale sites where reservationFor.name ends up being the
  // buyer's own name instead of the event). Bail so ICS/AI get a chance
  // instead of locking in a garbage title with nothing to show for it.
  if (!locName && !address) return null;
  const ref = bcSchemaGet_(obj, 'reservationNumber') || '';
  const rfType = isObj ? bcSchemaType_(rf) : '';
  const emoji = bcEventTypeEmoji[rfType] || bcPickEmoji_('event', title);
  return {
    provider: domain, cat: 'event', ref,
    title: emoji + ' ' + title,
    start: startDate, tzStart: BC.TIMEZONE,
    end: bcSchemaDate_((isObj ? rf.endDate : null) || obj.endDate) || bcPlusMin_(startDate, bcDefaultDuration.event), tzEnd: BC.TIMEZONE,
    location: [locName, address].filter(Boolean).join(', '),
    details: [['Event', title], ['Venue', locName], ['Address', address], ['🔖 Reference', ref], ['Passenger', bcSchemaGet_(obj, 'underName', 'name') || '']],
    links: [['Tickets', bcSchemaGet_(obj, 'ticketDownloadUrl') || ''], ['Manage booking', bcSchemaGet_(obj, 'url') || bcSchemaGet_(obj, 'modifyReservationUrl') || '']],
    _src: 'schema.org startDate=' + ((isObj ? rf.startDate : null) || obj.startDate || '') + ' endDate=' + ((isObj ? rf.endDate : null) || obj.endDate || ''),
  };
}

function bcSchemaFood_(obj, domain) {
  const rf = obj.reservationFor || {};
  const name = (typeof rf === 'object' ? rf.name : rf) || 'Restaurant';
  const start = bcSchemaDate_(obj.startTime); if (!start) return null;
  const ref = bcSchemaGet_(obj, 'reservationNumber') || '';
  return {
    provider: domain, cat: 'food', ref,
    title: bcPickEmoji_('food', name) + ' ' + name,
    start, tzStart: BC.TIMEZONE,
    end: bcPlusMin_(start, 90), tzEnd: BC.TIMEZONE,
    location: name,
    details: [['Restaurant', name], ['🔖 Reference', ref]],
    links: [['Details', bcSchemaGet_(obj, 'url') || '']],
    _src: 'schema.org startTime=' + (obj.startTime || ''),
  };
}

/* ===================== LAYER 2 — ICS ===================== */

function bcEventsFromIcs_(ctx) {
  const cat = bcIcsCategory_(ctx);
  if (cat && !bcCategoryActive_(cat)) return [];
  const results = [];

  for (const att of ctx.attachments) {
    if (/\.ics$/i.test(att.getName()) || /calendar|icalendar/i.test(att.getContentType())) {
      try { bcParseAllIcs_(att.getDataAsString()).forEach(p => { p.file = att.getName(); const ev = bcIcsToEvent_(p, ctx, cat); if (ev) results.push(ev); }); } catch (e) {}
    }
  }
  if (results.length) return results;

  const gcalLink = bcFindLink_(ctx, /calendar\.google\.com\/calendar\/(?:r\/eventedit|event)\?/i);
  if (gcalLink) { const ev = bcGcalLinkToEvent_(gcalLink, ctx, cat); if (ev) return [ev]; }

  const icsLink = bcFindLink_(ctx, /\.ics(?:[?#]|$)/i);
  if (icsLink && !/doctolib|square\.|captainvet|\.app\//i.test(icsLink)) {
    try {
      const resp = UrlFetchApp.fetch(icsLink, { muteHttpExceptions: true });
      if (resp.getResponseCode() === 200) bcParseAllIcs_(resp.getContentText()).forEach(p => { p.file = icsLink; const ev = bcIcsToEvent_(p, ctx, cat); if (ev) results.push(ev); });
    } catch (e) {}
  }
  return results;
}

function bcIcsCategory_(ctx) {
  const domain = bcReconstructDomain_(ctx.from);
  if (bcMedicalSenders.test(ctx.from) || bcMedicalSenders.test(domain)) return 'appointment_medical';
  if (bcPersonalApptSenders.test(domain)) return 'appointment_personal';
  return null;
}

function bcIcsToEvent_(parsed, ctx, cat) {
  const rawTitle = parsed.summary || ctx.subject;
  const route = bcTransportEndpoints_([rawTitle, parsed.file, parsed.location]);
  const resolved = cat || (route && route.cat) || 'event';
  const isMedical = resolved === 'appointment_medical';
  const dur = bcDefaultDuration[isMedical ? 'appointment' : resolved] || 60;
  // Also check the subject line and ICS description for a genre hint — a
  // ticket's title is often just an artist/act name with none. Deliberately
  // NOT the full email body: footers/widgets ("Chat with us") produce false
  // matches (e.g. "chat" tripping the pets/vet rule).
  const dep = (route && route.dep) || '';
  const arr = (route && route.arr) || '';
  const emoji = bcPickEmoji_(resolved, (dep && arr ? dep + ' ' + arr : rawTitle) + ' ' + (parsed.description || '') + ' ' + ctx.subject);

  // A missing DTEND is not a real arrival time. The description sometimes
  // still states it ("Arrivée: … 08:57"). That clock is local to the arrival
  // station: 08:57 at St Pancras is 09:57 in Paris, a 1h22 trip, not 22 min.
  // A pure guess stays in the departure zone — labeling a Paris wall-clock
  // with London turns "start + 3h" into a 4h block.
  const fromDescription = !parsed.end && bcArrivalFromText_(parsed.description, parsed.start.dt);
  const statedEnd = parsed.end?.dt || fromDescription;
  const endEstimated = !statedEnd;
  let tzStart = parsed.start.tz, tzEnd = parsed.end?.tz;
  if (!tzStart) tzStart = bcLegTz_(dep) || BC.TIMEZONE;
  if (endEstimated) tzEnd = tzStart;
  else if (fromDescription) tzEnd = bcLegTz_(arr) || tzStart;
  else if (!tzEnd) tzEnd = bcLegTz_(arr) || tzStart;
  const endDt = statedEnd || bcPlusMin_(parsed.start.dt, dur);
  const duration = (route && route.duration) || (statedEnd ? bcDurationLabel_(parsed.start.dt, endDt, tzStart, tzEnd) : '');

  return {
    provider: 'ics', cat: resolved, ref: parsed.uid || '',
    title: emoji + ' ' + (dep && arr ? dep + ' → ' + arr + (duration ? ' ' + duration : '') : rawTitle),
    start: parsed.start.dt, tzStart,
    end: endDt, tzEnd,
    location: dep || parsed.location || '',
    _endEstimated: endEstimated,
    details: parsed.description ? [['Details', parsed.description.slice(0, 300)]] : [],
    links: parsed.url ? [['Details', parsed.url]] : [],
    _src: 'ics ' + (parsed.file || '') + ' DTSTART' + (parsed.rawStart || '') + ' → ' + parsed.start.dt + ' tz=' + parsed.start.tz + ' | DTEND' + (parsed.rawEnd || '') + ' → ' + (parsed.end ? parsed.end.dt + ' tz=' + parsed.end.tz : statedEnd ? 'description ' + statedEnd + ' tz=' + tzEnd : 'none') + ' | route "' + dep + '" / "' + arr + '"',
  };
}

function bcGcalLinkToEvent_(url, ctx, cat) {
  try {
    const params = Object.fromEntries([...url.matchAll(/[?&]([^=&]+)=([^&]*)/g)].map(([, k, v]) => [decodeURIComponent(k), decodeURIComponent(v.replace(/\+/g, ' '))]));
    const rawDates = params.dates || params.dtstart || '';
    const datesUtc = rawDates.match(/^(\d{8}T\d{6})Z\/(\d{8}T\d{6})Z$/);
    const datesLocal = !datesUtc && rawDates.match(/^(\d{8}T\d{6})\/(\d{8}T\d{6})$/);
    const dates = datesUtc || datesLocal;
    if (!dates) return null;
    const toLocal = datesUtc ? bcUtcToLocal_ : (s => s.slice(0,4)+'-'+s.slice(4,6)+'-'+s.slice(6,8)+'T'+s.slice(9,11)+':'+s.slice(11,13)+':'+s.slice(13,15));
    const ticketLink = ctx.links.find(x => /t[eé]l[eé]charg|e.?ticket|download.*ticket|ticket.*download/i.test(x.text));
    const rawTitle = params.text || ctx.subject;
    // Subject only, not the full body — footers/widgets ("Chat with us")
    // produce false matches against the full text.
    const emoji = bcPickEmoji_(cat || 'event', rawTitle + ' ' + ctx.subject);
    // Same floating-time problem as ICS attachments (see bcIcsLegTz_): a
    // Google Calendar "add" link carries no per-leg TZID either.
    const [depText, arrText] = bcSplitRoute_(rawTitle + ' ' + (params.location || ''));
    const tzStart = datesUtc ? BC.TIMEZONE : (bcLegTz_(depText) || BC.TIMEZONE);
    const tzEnd = datesUtc ? BC.TIMEZONE : (bcLegTz_(arrText || depText) || BC.TIMEZONE);
    return { provider: 'ics', cat: cat || 'event', ref: '', title: emoji + ' ' + rawTitle, start: toLocal(dates[1]), tzStart, end: toLocal(dates[2]), tzEnd, location: params.location || '', details: [], links: ticketLink ? [['Download tickets', ticketLink.url]] : [], _src: 'gcal dates=' + rawDates + (datesUtc ? ' (UTC)' : ' (local)') + ' | route "' + depText + '" / "' + arrText + '"' };
  } catch (e) { return null; }
}

/* ===================== LAYER 3 — AI EXTRACTION ===================== */

const bcAiProviders = {
  claude: {
    defaultModel: 'claude-haiku-4-5-20251001',
    url: () => 'https://api.anthropic.com/v1/messages',
    headers: apiKey => ({ 'x-api-key': apiKey, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' }),
    payload: (content, model) => JSON.stringify({ model, max_tokens: 1024, messages: [{ role: 'user', content }] }),
    pdfPart: data => ({ type: 'document', source: { type: 'base64', media_type: 'application/pdf', data } }),
    textPart: text => ({ type: 'text', text }),
    extractText: json => json.content[0].text,
  },
  gemini: {
    defaultModel: 'gemini-2.0-flash',
    url: (apiKey, model) => 'https://generativelanguage.googleapis.com/v1beta/models/' + model + ':generateContent?key=' + apiKey,
    headers: () => ({ 'content-type': 'application/json' }),
    payload: content => JSON.stringify({ contents: [{ parts: content }] }),
    pdfPart: data => ({ inlineData: { mimeType: 'application/pdf', data } }),
    textPart: text => ({ text }),
    extractText: json => json.candidates[0].content.parts[0].text,
  },
};

function bcClaudeExtract_(ctx) {
  const props = PropertiesService.getScriptProperties();
  const apiKey = props.getProperty('AI_API_KEY');
  if (!apiKey) return [];
  const model = props.getProperty('AI_MODEL') || bcAiProviders.claude.defaultModel;
  const name = /gemini/i.test(model) ? 'gemini' : 'claude';
  const cfg = bcAiProviders[name];

  const content = [];
  ctx.attachments.forEach(att => {
    if (/\.pdf$/i.test(att.getName()) && !bcAttachmentExclude.test(att.getName())) {
      try { content.push(cfg.pdfPart(Utilities.base64Encode(att.getBytes()))); } catch(e) {}
    }
  });
  content.push(cfg.textPart(bcAiPrompt_(ctx)));

  try {
    const resp = UrlFetchApp.fetch(cfg.url(apiKey, model), { method: 'post', muteHttpExceptions: true, headers: cfg.headers(apiKey), payload: cfg.payload(content, model) });
    if (resp.getResponseCode() !== 200) { console.warn(name + ' error ' + resp.getResponseCode() + ': ' + resp.getContentText().slice(0, 200)); return []; }
    const aiText = cfg.extractText(JSON.parse(resp.getContentText())).trim();
    bcTrace_('  AI raw: ' + aiText.slice(0, 1500));
    return bcAiParseResult_(aiText, name, model);
  } catch(e) { console.warn(name + ' error: ' + e); return []; }
}

function bcAiPrompt_(ctx) {
  return [
    'Extract booking/reservation events from this confirmation email.',
    'IMPORTANT: only extract events the recipient has CONFIRMED, PURCHASED or REGISTERED for. Return [] for newsletters, promotions, or "upcoming events" listings.',
    'Return ONLY a JSON array (empty if no booking). One object per event:',
    '{"title":"short name","category":"flight|train|hotel|event|appointment_medical|appointment_personal","emoji":"single emoji","start":"YYYY-MM-DDTHH:MM:SS","end":"...or null","allDay":false,"location":"","destination":"","reference":""}',
    'Hotels: date-only strings (YYYY-MM-DD) and allDay:true. "start" is the check-in date, "end" is the check-out date — both are REQUIRED, never null, even if you have to infer checkout from a stated number of nights.',
    'For flight/train: "location" is the departure city/station/airport (include the IATA code in parentheses if given, e.g. "Paris (CDG)"), "destination" is the arrival city/station/airport likewise. Report "start" and "end" exactly as the LOCAL date & time printed for departure and arrival respectively — do NOT convert between timezones yourself, that is handled separately from "location"/"destination". For every other category, "destination" is not needed and all datetimes are in ' + BC.TIMEZONE + '.',
    '',
    'Subject: ' + ctx.subject,
    'From: ' + ctx.from,
    '',
    ctx.lines.slice(0, 120).join('\n'),
  ].join('\n');
}

function bcAiParseResult_(raw, providerName, model) {
  try {
    const parsed = JSON.parse(raw.match(/\[[\s\S]*\]/)[0]);
    return [].concat(parsed).filter(e => e && e.start).map(e => {
      const cat = e.category || 'event';
      // Only flight/train have two different locations, so only those can
      // need two different zones. The model is asked for literal local
      // times per leg, not converted — our own IATA/city lookup resolves
      // the actual zone from "location"/"destination" (an LLM doing
      // timezone arithmetic itself is the unreliable part we're avoiding).
      const isTransport = cat === 'train' || cat === 'flight';
      const dep = e.location || '';
      const arr = e.destination || '';
      const tzStart = isTransport ? (bcLegTz_(dep) || BC.TIMEZONE) : BC.TIMEZONE;
      const tzEnd = isTransport ? (bcLegTz_(arr || dep) || tzStart) : BC.TIMEZONE;
      return {
        provider: providerName, cat, ref: e.reference || '',
        title: (e.emoji || bcPickEmoji_(cat, e.title)) + ' ' + (isTransport && dep && arr ? dep + ' → ' + arr : (e.title || '')),
        start: e.start, end: e.end || null, allDay: !!e.allDay,
        needsReview: cat === 'hotel' && !e.end,
        _endEstimated: !e.end,
        tzStart, tzEnd: e.end ? tzEnd : tzStart,
        location: isTransport ? dep : (e.location || ''),
        details: [['🔖 Reference', e.reference || '']],
        links: [],
        _aiModel: model,
        _src: 'ai ' + JSON.stringify({ start: e.start, end: e.end, allDay: !!e.allDay, location: e.location || '', destination: e.destination || '', category: cat }),
      };
    }).filter(e => bcCategoryActive_(e.cat));
  } catch(e) { console.warn(providerName + ' parse error: ' + e); return []; }
}

