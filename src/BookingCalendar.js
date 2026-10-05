function bcEventKey_(ev) {
  const raw = [ev.provider, ev.ref || '', ev.start, ev.location || '', ev._isPreDeparture ? 'pre' : ''].join('|');
  return Utilities.base64EncodeWebSafe(Utilities.computeDigest(Utilities.DigestAlgorithm.MD5, raw)).replace(/=+$/, '');
}

const bcLayerScore = { 'schema.org': 30, 'ics': 20 }; // anything else (AI) scores 10

// Per-run cache of Calendar.Events.list by day; invalidated on every write.
const bcDayEventsCache_ = {};
function bcDayEvents_(date) {
  if (!(date in bcDayEventsCache_)) {
    const items = [];
    let pageToken;
    do {
      const res = Calendar.Events.list(BC.CALENDAR_ID, {
        timeMin: date + 'T00:00:00Z', timeMax: date + 'T23:59:59Z',
        maxResults: 250, showDeleted: false, singleEvents: true, orderBy: 'startTime', pageToken,
      });
      items.push.apply(items, res.items || []);
      pageToken = res.nextPageToken;
    } while (pageToken && items.length < 1000);
    bcDayEventsCache_[date] = items;
  }
  return bcDayEventsCache_[date];
}
function bcInvalidateDay_(date) { delete bcDayEventsCache_[date]; }

// Skips an AI call when a high-confidence event with a similar title already
// exists on a date found (via regex) in the email itself.
function bcAlreadyWellCovered_(ctx) {
  const dates = bcExtractDates_(ctx.subject + ' ' + ctx.text);
  if (!dates.length) return false;
  const seen = new Set();
  for (const d of dates) {
    for (const e of bcDayEvents_(d)) {
      if (seen.has(e.id)) continue;
      seen.add(e.id);
      if (+(e.extendedProperties?.private?.resaQuality || 0) >= 20 && e.summary && bcTitleSimilar_(e.summary, ctx.subject)) return true;
    }
  }
  return false;
}

function bcSpanMin_(start, end) {
  const a = bcInstantMs_(start, start && start.timeZone);
  const b = bcInstantMs_(end, end && end.timeZone);
  if (!isFinite(a) || !isFinite(b)) return NaN;
  return Math.round((b - a) / 60000);
}

// True when the event's end came from a real arrival, not a default-duration guess.
function bcExistingEndReal_(event, cat) {
  const flag = event?.extendedProperties?.private?.resaEndReal;
  if (flag === '1') return true;
  if (flag === '0') return false;
  const mins = bcSpanMin_(event.start, event.end);
  const def = bcDefaultDuration[cat] || 120;
  return isFinite(mins) && mins !== def;
}

function bcEventQuality_(ev, layer) {
  let score = bcLayerScore[layer] || 10;
  if (ev.end && !ev._endEstimated) score += 10; // a real DTEND beats a duration guess
  if (!ev.needsReview) score += 3;
  score += (ev.details || []).filter(d => d[1]).length;
  return score;
}

// Instant (ms since epoch) for a wall-clock time + IANA zone, since Apps
// Script has no zone parser of its own.
function bcInstantMs_(isoOrStart, tz) {
  let s = isoOrStart;
  let zone = tz || BC.TIMEZONE;
  if (s && typeof s === 'object') {
    zone = s.timeZone || zone;
    s = s.dateTime || (s.date ? s.date + 'T00:00:00' : '');
  }
  s = String(s || '');
  if (!s) return NaN;
  if (/Z|[+-]\d{2}:\d{2}$/.test(s)) return new Date(s).getTime();
  const asUtc = new Date(s.slice(0, 19) + 'Z');
  if (isNaN(asUtc.getTime())) return NaN;
  const shown = Utilities.formatDate(asUtc, zone, "yyyy-MM-dd'T'HH:mm:ss");
  return asUtc.getTime() - (new Date(shown + 'Z').getTime() - asUtc.getTime());
}

function bcSameInstant_(evMs, event) {
  const startMs = bcInstantMs_(event.start, event.start?.timeZone);
  return isFinite(evMs) && isFinite(startMs) && Math.abs(startMs - evMs) <= 5 * 60000;
}

// True if the shorter stop name's words are all contained in the longer one.
function bcStopIncludes_(hay, needle) {
  const words = s => bcNormalize_(s).replace(/[^\p{L}\p{N}\s]/gu, ' ').split(/\s+/).filter(w => w.length > 2);
  const h = words(hay), n = words(needle);
  if (!h.length || !n.length) return false;
  const small = h.length <= n.length ? h : n;
  const big = new Set(small === h ? n : h);
  return small.every(w => big.has(w));
}

// Removes duplicate script-owned events at the same instant left by past
// runs, keeping the one with the most accurate end time.
function bcDropExtraTwins_(keep, ev) {
  if (!keep || !ev || !ev.start) return;
  const evMs = bcInstantMs_(ev.start, ev.tzStart);
  const days = [String(ev.start).slice(0, 10)];
  const keepDay = (keep.start?.dateTime || keep.start?.date || '').slice(0, 10);
  if (keepDay && days.indexOf(keepDay) < 0) days.push(keepDay);
  const group = [keep];
  days.forEach(day => {
    bcDayEvents_(day).forEach(e => {
      if (!e.id) return;
      if (e.id === keep.id) { group[0] = e; return; }
      if (group.some(g => g.id === e.id)) return;
      if (!e.extendedProperties?.private?.resaKey) return;
      if (!bcSameInstant_(evMs, e)) return;
      if (!e.summary || !bcTitleSimilar_(e.summary, ev.title)) return;
      group.push(e);
    });
  });
  group.sort((a, b) => {
    const ar = bcExistingEndReal_(a, ev.cat) ? 1 : 0;
    const br = bcExistingEndReal_(b, ev.cat) ? 1 : 0;
    if (ar !== br) return br - ar;
    const ad = bcSpanMin_(a.start, a.end), bd = bcSpanMin_(b.start, b.end);
    if (ad !== bd) return ad - bd;
    if (a.id === keep.id) return -1;
    if (b.id === keep.id) return 1;
    return 0;
  });
  group.slice(1).forEach(e => {
    try {
      Calendar.Events.remove(BC.CALENDAR_ID, e.id);
      bcTrace_('  DROP twin "' + (e.summary || '') + '"');
    } catch (err) { bcTrace_('  DROP failed: ' + err); }
  });
  days.forEach(bcInvalidateDay_);
}

function bcWallStartMs_(isoOrStart) {
  let s = isoOrStart;
  if (s && typeof s === 'object') s = s.dateTime || (s.date ? s.date + 'T00:00:00' : '');
  s = String(s || '').replace(/Z|[+-]\d{2}:\d{2}$/, '');
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2}))?/);
  if (!m) return NaN;
  return Date.UTC(+m[1], +m[2] - 1, +m[3], +(m[4] || 0), +(m[5] || 0));
}

function bcFindExisting_(key, ev) {
  if (!ev || !ev.start) return null;
  const quality = e => +(e.extendedProperties?.private?.resaQuality || 0);
  const hits = bcDayEvents_(ev.start.slice(0, 10));
  const byKey = hits.find(e => e.extendedProperties?.private?.resaKey === key);
  if (byKey) return { event: byKey, exact: true, quality: quality(byKey) };
  const evMs = bcInstantMs_(ev.start, ev.tzStart);
  if (ev._isPreDeparture) {
    const twin = hits.find(e => bcSameInstant_(evMs, e) && e.summary && bcTitleSimilar_(e.summary, ev.title));
    return twin ? { event: twin, exact: true, quality: quality(twin) } : null;
  }

  const locSlug = ev.location ? bcNormalize_(ev.location.split(',')[0]).slice(0, 20) : '';
  // Instant match (not wall clock): 18:04 London and 19:04 Paris can be the same train.
  const found = hits.find(e => {
    if (!bcSameInstant_(evMs, e)) return false;
    const locMatch = !!(locSlug && e.location && bcStopIncludes_(e.location, locSlug));
    const titleMatch = !!(e.summary && bcTitleSimilar_(e.summary, ev.title));
    return locMatch || titleMatch;
  });
  return found ? { event: found, exact: false, quality: quality(found) } : null;
}

function bcThreadUrl_(ctx) { return 'https://mail.google.com/mail/u/0/#all/' + ctx.msg.getThread().getId(); }
function bcKv_(pair) { return pair[0] + ': ' + pair[1]; }
function bcAttResource_(f) { return { fileUrl: f.url, title: f.name, mimeType: f.mime }; }
function bcBlock_(label, items) { return items.length ? [label + ':', ...items.map(i => '- ' + bcKv_(i))] : []; }

function bcSplitRef_(details) {
  const ref = details.find(d => d[1] && /reference/i.test(d[0]));
  const rest = details.filter(d => d[1] && !/reference/i.test(d[0]));
  return { ref, rest };
}

// Order: raw content from the source (details + links) → email → tickets → reference → source
function bcBuildDescription_(ev, ctx, atts, layer) {
  const { ref, rest } = bcSplitRef_(ev.details);
  return [
    rest.map(bcKv_),
    bcBlock_('🔗 ' + bcDescLabels.links, (ev.links || []).filter(l => l[1])),
    [bcKv_(['📧 ' + bcDescLabels.email, bcThreadUrl_(ctx)])],
    bcBlock_('🎫 ' + bcDescLabels.tickets, atts.map(f => [f.name, f.url])),
    ref ? [bcKv_(ref)] : [],
    [bcKv_(['⚙️ ' + bcDescLabels.source, layer || 'unknown'])],
  ].filter(b => b.length).map(b => b.join('\n')).join('\n\n');
}

function bcEventTimeFields_(ev) {
  const hasOffset = s => /[+-]\d{2}:\d{2}$|Z$/.test(s || '');
  const endDt = ev.end || bcPlusMin_(ev.start, bcDefaultDuration[ev.cat] || 120);
  const endTz = ev._endEstimated ? (ev.tzStart || BC.TIMEZONE) : (ev.tzEnd || ev.tzStart || BC.TIMEZONE);
  if (ev.allDay) {
    // Calendar API end is exclusive: +1 day so checkout day shows on calendar
    const endBase = (ev.end || ev.start).slice(0, 10);
    return {
      start: { date: ev.start.slice(0, 10) },
      end: { date: new Date(new Date(endBase + 'T00:00:00Z').getTime() + 86400000).toISOString().slice(0, 10) },
    };
  }
  if (hasOffset(ev.start)) {
    return {
      start: { dateTime: ev.start },
      end: { dateTime: hasOffset(endDt) ? endDt : bcPlusMin_(ev.start, bcDefaultDuration[ev.cat] || 120) },
    };
  }
  return {
    start: { dateTime: ev.start, timeZone: ev.tzStart || BC.TIMEZONE },
    end: { dateTime: endDt, timeZone: endTz },
  };
}

// Calendar labels are a separate API call: the Apps Script client doesn't
// support eventLabelVersion=1, so this talks to the REST API directly.
var bcResolvedLabelId_;
function bcCalendarApi_(method, path, body) {
  const opts = {
    method,
    headers: { Authorization: 'Bearer ' + ScriptApp.getOAuthToken() },
    muteHttpExceptions: true,
  };
  if (body != null) {
    opts.contentType = 'application/json';
    opts.payload = JSON.stringify(body);
  }
  const res = UrlFetchApp.fetch('https://www.googleapis.com/calendar/v3' + path, opts);
  const code = res.getResponseCode();
  const text = res.getContentText() || '';
  if (code >= 300) throw new Error(method + ' ' + path + ' ' + code + ': ' + text.slice(0, 240));
  return text ? JSON.parse(text) : {};
}

function bcLabelId_() {
  if (bcResolvedLabelId_ !== undefined) return bcResolvedLabelId_;
  const name = typeof BC_LABEL === 'string' ? BC_LABEL : (BC_LABEL && BC_LABEL.name);
  if (!name) { bcResolvedLabelId_ = ''; return ''; }
  try {
    const cal = bcCalendarApi_('get', '/calendars/' + encodeURIComponent(BC.CALENDAR_ID));
    const labels = (cal.labelProperties && cal.labelProperties.eventLabels) || [];
    const found = labels.find(l => bcNormalize_(l.name || '') === bcNormalize_(name));
    bcTrace_('  LABEL lookup "' + name + '" among ' + (labels.map(l => l.name).join(', ') || 'none'));
    if (!found) { bcResolvedLabelId_ = ''; return ''; }
    bcResolvedLabelId_ = found.id;
    return found.id;
  } catch (e) {
    bcTrace_('  LABEL failed: ' + e);
    bcResolvedLabelId_ = '';
    return '';
  }
}

function bcApplyLabel_(eventId) {
  const labelId = bcLabelId_();
  if (!labelId || !eventId) return;
  try {
    bcCalendarApi_('patch', '/calendars/' + encodeURIComponent(BC.CALENDAR_ID) + '/events/' + encodeURIComponent(eventId) + '?eventLabelVersion=1', { eventLabelId: labelId });
  } catch (e) { bcTrace_('  LABEL failed: ' + e); }
}

// A strictly better source replaces dates/title/location/description outright.
function bcUpgradeEvent_(existing, ev, ctx, files, layer, quality) {
  const atts = files.filter(f => !ev.attachmentFilter || ev.attachmentFilter.test(f.name));
  const time = bcEventTimeFields_(ev);
  const patch = {
    summary: (ev.needsReview ? '[To review] ' : '') + ev.title,
    location: ev.location || '',
    description: bcBuildDescription_(ev, ctx, atts, layer),
    start: time.start, end: time.end,
    extendedProperties: { private: { resaKey: existing.extendedProperties?.private?.resaKey || ev._key, resaRef: ev.ref || '', resaQuality: String(quality), resaEndReal: ev._endEstimated ? '0' : '1' } },
  };
  if (atts.length) patch.attachments = [...(existing.attachments || []), ...atts.map(bcAttResource_)];
  try {
    Calendar.Events.patch(patch, BC.CALENDAR_ID, existing.id, { supportsAttachments: true });
    bcApplyLabel_(existing.id);
    bcInvalidateDay_((existing.start?.date || existing.start?.dateTime || '').slice(0, 10));
    bcInvalidateDay_(ev.start.slice(0, 10));
  } catch (e) { bcTrace_('  WRITE failed: ' + e); }
}

// Appends a full extra source block, separated by "------", rather than
// diffing into the existing text.
function bcEnrichEvent_(existing, ev, ctx, files, layer) {
  const currentDesc = existing.description || '';
  const threadUrl = bcThreadUrl_(ctx);
  const atts = files.filter(f => !ev.attachmentFilter || ev.attachmentFilter.test(f.name));
  const have = new Set((existing.attachments || []).map(a => a.title));
  const fresh = atts.filter(a => !have.has(a.name));
  if (currentDesc.includes(threadUrl) && !fresh.length) return;
  const patch = {};
  if (!currentDesc.includes(threadUrl)) patch.description = currentDesc + '\n\n------\n\n' + bcBuildDescription_(ev, ctx, atts, layer);
  if (fresh.length) patch.attachments = [...(existing.attachments || []), ...fresh.map(bcAttResource_)];
  try {
    Calendar.Events.patch(patch, BC.CALENDAR_ID, existing.id, { supportsAttachments: true });
    bcApplyLabel_(existing.id);
  } catch (e) { bcTrace_('  WRITE failed: ' + e); }
}

// "STATION_A_STATION_B_2026-10-06_LASTNAME_FIRSTNAME_REF.pdf" → matches the
// leg already created from the ICS.
function bcRouteFromPdfName_(name) {
  const base = String(name || '').replace(/\.pdf$/i, '');
  const dm = base.match(/_(\d{4}-\d{2}-\d{2})(?:_|$)/);
  if (!dm) return null;
  const parts = base.slice(0, dm.index).split('_').map(s => s.trim()).filter(Boolean);
  if (parts.length < 2) return null;
  return { dep: parts[0], arr: parts.slice(1).join(' '), date: dm[1] };
}

function bcFindTicketEvent_(route) {
  const dep = bcNormalize_(route.dep), arr = bcNormalize_(route.arr);
  return bcDayEvents_(route.date).find(e => {
    if (!e.summary || !e.extendedProperties?.private?.resaKey) return false;
    const title = bcNormalize_(e.summary);
    const depAt = title.indexOf(dep), arrAt = title.indexOf(arr);
    if (depAt < 0 || arrAt < 0 || depAt >= arrAt) return false;
    return !e.location || bcStopIncludes_(e.location, route.dep);
  });
}

// Matches loose PDF attachments to an already-created event by filename, no AI needed.
function bcAttachTicketPdfs_(ctx, simulate) {
  const pdfs = bcUsefulAttachments_(ctx).filter(a => /\.pdf$/i.test(a.getName() || ''));
  if (!pdfs.length) return false;
  let matched = 0;
  pdfs.forEach(att => {
    const route = bcRouteFromPdfName_(att.getName());
    const event = route && bcFindTicketEvent_(route);
    if (!event) { bcTrace_('  PDF no match "' + att.getName() + '"'); return; }
    matched++;
    bcTrace_('  ATTACH "' + att.getName() + '" → "' + (event.summary || '') + '"');
    if (simulate) return;
    const saved = bcSaveAttachments_(
      Object.assign({}, ctx, { attachments: [att], links: [] }),
      { title: event.summary, start: (event.start?.dateTime || event.start?.date || route.date).slice(0, 19) }
    );
    const have = new Set((event.attachments || []).map(a => a.title));
    const fresh = saved.filter(f => !have.has(f.name));
    const threadUrl = bcThreadUrl_(ctx);
    const desc = event.description || '';
    const patch = {};
    if (fresh.length) patch.attachments = [...(event.attachments || []), ...fresh.map(bcAttResource_)];
    if (threadUrl && !desc.includes(threadUrl)) {
      patch.description = desc + (desc ? '\n\n------\n\n' : '') + ['📧 ' + bcDescLabels.email + ': ' + threadUrl, ...fresh.map(f => '🎫 ' + f.name + ': ' + f.url)].join('\n');
    }
    if (!patch.attachments && !patch.description) return;
    try {
      Calendar.Events.patch(patch, BC.CALENDAR_ID, event.id, { supportsAttachments: true });
      bcInvalidateDay_(route.date);
    } catch (e) { bcTrace_('  WRITE failed: ' + e); }
  });
  return matched > 0 && matched === pdfs.length;
}

function bcCreateEvent_(ev, ctx, files, layer) {
  const atts = files.filter(f => !ev.attachmentFilter || ev.attachmentFilter.test(f.name));
  const time = bcEventTimeFields_(ev);
  const resource = {
    summary: (ev.needsReview ? '[To review] ' : '') + ev.title, location: ev.location || '',
    description: bcBuildDescription_(ev, ctx, atts, layer),
    reminders: { useDefault: false, overrides: (bcReminders[ev.cat] || [1440]).map(m => ({ method: 'popup', minutes: m })) },
    extendedProperties: { private: { resaKey: ev._key, resaRef: ev.ref || '', resaQuality: String(bcEventQuality_(ev, layer)), resaEndReal: ev._endEstimated ? '0' : '1' } },
    source: { title: 'Confirmation email', url: bcThreadUrl_(ctx) },
    start: time.start, end: time.end,
  };
  if (atts.length) resource.attachments = atts.map(bcAttResource_);
  for (const patch of [r => r, r => { delete r.source; return r; }, r => { delete r.attachments; return r; }]) {
    try {
      const created = Calendar.Events.insert(patch(resource), BC.CALENDAR_ID, { supportsAttachments: true });
      bcInvalidateDay_(ev.start.slice(0, 10));
      bcApplyLabel_(created.id);
      return created;
    } catch (e) { bcTrace_('  WRITE failed: ' + e); }
  }
}

function bcFileSlug_(title) {
  return bcNormalize_(String(title || '')
    .replace(/[^\x00-\x7FÀ-ɏ]/g, '')
    .replace(/^\[To review\]\s*/i, '')
    .replace(/\s*[+&]\s*(guest|guests|invit[eé]s?|feat\.?|ft\.?)\b.*/i, '')
    .replace(/\s*(presented by|with guest|w\/)\s+.*/i, '')
    .trim()
  ).replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 30);
}

function bcUsefulAttachments_(ctx) {
  return ctx.attachments.filter(a =>
    bcAttachmentExt.test(a.getName()) && !bcAttachmentExclude.test(a.getName()) &&
    !(/\.(png|jpe?g)$/i.test(a.getName()) && a.getSize() < 40000)
  );
}

function bcAttachmentBase_(ctx, ev) {
  return {
    dateStr: (ev && ev.start ? ev.start : ctx.date.toISOString()).slice(0, 10).replace(/-/g, ''),
    slug: bcFileSlug_(ev ? ev.title : ctx.subject),
  };
}

function bcAttachmentName_(dateStr, slug, ext, i, total) {
  return dateStr + '_' + slug + (total > 1 ? '_' + (i + 1) : '') + ext;
}

function bcFileExt_(name) { return (name.match(/\.[^.]+$/) || [''])[0].toLowerCase(); }

function bcGetOrCreateFile_(folder, name, blob) {
  const it = folder.getFilesByName(name);
  return it.hasNext() ? it.next() : folder.createFile(blob.setName(name));
}

function bcPreviewAttachments_(ctx, ev) {
  const useful = bcUsefulAttachments_(ctx);
  if (!useful.length) return [];
  const { dateStr, slug } = bcAttachmentBase_(ctx, ev);
  return useful.map((a, i) => bcAttachmentName_(dateStr, slug, bcFileExt_(a.getName()), i, useful.length));
}

function bcSaveAttachments_(ctx, ev) {
  const useful = bcUsefulAttachments_(ctx);
  const folder = bcTicketsFolder_();
  const { dateStr, slug } = bcAttachmentBase_(ctx, ev);
  const saved = useful.map((a, i) => {
    const name = bcAttachmentName_(dateStr, slug, bcFileExt_(a.getName()), i, useful.length);
    const f = bcGetOrCreateFile_(folder, name, a.copyBlob());
    return { name, url: f.getUrl(), mime: a.getContentType() };
  });
  if (!saved.length) {
    // Ticket URLs can live in structured data (schema.org) without a visible link.
    const seenUrls = new Set();
    const ticketLinks = [
      ...(ev.links || []).filter(l => l[1] && /ticket/i.test(l[0])).map(l => ({ url: l[1], text: l[0] })),
      ...ctx.links.filter(x => /t[eé]l[eé]charg|e.?ticket|download.*ticket|ticket.*download|billet.*pdf/i.test(x.text) || /\/ticket|\/billet|\/e-ticket/i.test(x.url)),
    ]
      .filter(x => !seenUrls.has(x.url) && seenUrls.add(x.url))
      // Fetches to this domain never return from Apps Script — skip it so
      // one slow link can't stall the whole batch.
      .filter(x => !/fnacspectacles\.com/i.test(x.url));
    ticketLinks.forEach((lk, i) => {
      try {
        let resp = UrlFetchApp.fetch(lk.url, { muteHttpExceptions: true, followRedirects: true });
        if (resp.getResponseCode() !== 200) return;
        let mime = resp.getHeaders()['Content-Type'] || '';
        // Intermediate "téléchargement dans 3s" page: extract the real link
        if (/html/i.test(mime)) {
          const html2 = resp.getContentText();
          const metaRefresh = (html2.match(/meta[^>]+http-equiv\s*=\s*["']refresh["'][^>]*content\s*=\s*["'][^"']*url=([^"']+)/i) || [])[1];
          const directLink = metaRefresh ||
            (html2.match(/<a\b[^>]+href\s*=\s*["']([^"']+\.pdf[^"']*)/i) || [])[1] ||
            (html2.match(/<a\b[^>]+href\s*=\s*["']([^"']+)["'][^>]*>[^<]*(?:cliqu|click|ici|here)/i) || [])[1];
          if (!directLink) return;
          const absLink = /^https?:/i.test(directLink) ? directLink : new URL(directLink, lk.url).href;
          resp = UrlFetchApp.fetch(absLink, { muteHttpExceptions: true, followRedirects: true });
          if (resp.getResponseCode() !== 200) return;
          mime = resp.getHeaders()['Content-Type'] || '';
        }
        if (!/pdf|octet-stream|pkpass/i.test(mime)) return;
        const ext = /pkpass/i.test(mime) ? '.pkpass' : '.pdf';
        const name = bcAttachmentName_(dateStr, slug, ext, i, ticketLinks.length);
        const f = bcGetOrCreateFile_(folder, name, resp.getBlob());
        saved.push({ name, url: f.getUrl(), mime });
      } catch(e) {}
    });
  }
  return saved;
}
