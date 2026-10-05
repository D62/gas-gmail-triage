function bcEventKey_(ev) {
  const raw = [ev.provider, ev.ref || '', ev.start, ev.location || '', ev._isPreDeparture ? 'pre' : ''].join('|');
  return Utilities.base64EncodeWebSafe(Utilities.computeDigest(Utilities.DigestAlgorithm.MD5, raw)).replace(/=+$/, '');
}

const bcLayerScore = { 'schema.org': 30, 'ics': 20 }; // anything else (AI) scores 10

// Per-run cache of Calendar.Events.list results by day, shared by
// bcAlreadyWellCovered_ and bcFindExisting_ — both query "what's on this
// day" and a batch run often touches the same day more than once (several
// emails about the same trip, or several unrelated bookings close together).
// Invalidated on every write so a later lookup in the same run always sees
// what was just created/updated.
const bcDayEventsCache_ = {};
function bcDayEvents_(date) {
  if (!(date in bcDayEventsCache_)) {
    bcDayEventsCache_[date] = (Calendar.Events.list(BC.CALENDAR_ID, { timeMin: date + 'T00:00:00Z', timeMax: date + 'T23:59:59Z', maxResults: 50, showDeleted: false }).items || []);
  }
  return bcDayEventsCache_[date];
}
function bcInvalidateDay_(date) { delete bcDayEventsCache_[date]; }

// Before spending an AI call on a message that has no schema.org/ICS data,
// check whether a high-confidence event (schema.org or ICS tier) with a
// clearly similar title already exists on the same day(s) — if so, this
// email is very likely a weaker duplicate of something we already have
// complete data for, so skip the AI extraction entirely instead of calling
// it only to discard or append its result.
//
// The dates are found (via regex, no AI) in the email itself — if none are
// found we have no safe way to scope the check, so it is skipped and the
// AI call proceeds normally.
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

function bcEventQuality_(ev, layer) {
  let score = bcLayerScore[layer] || 10;
  if (ev.end) score += 5;
  if (!ev.needsReview) score += 3;
  score += (ev.details || []).filter(d => d[1]).length;
  return score;
}

function bcFindExisting_(key, ev) {
  if (!ev || !ev.start) return null;
  const quality = e => +(e.extendedProperties?.private?.resaQuality || 0);
  const hits = bcDayEvents_(ev.start.slice(0, 10));
  const byKey = hits.find(e => e.extendedProperties?.private?.resaKey === key);
  if (byKey) return { event: byKey, exact: true, quality: quality(byKey) };
  if (!ev.location) return null;
  const locSlug = bcNormalize_(ev.location.split(',')[0]).slice(0, 20);
  // Same day + (location prefix matches OR titles are clearly the same event
  // worded differently) — covers sources that describe the location in
  // incompatible ways (e.g. a venue's full name vs just the room name).
  const found = hits.find(e => (e.location && bcNormalize_(e.location).includes(locSlug)) || (e.summary && bcTitleSimilar_(e.summary, ev.title)));
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
  const durMs = (bcDefaultDuration[ev.cat] || 120) * 60000;
  const endDt = ev.end || new Date(new Date(ev.start).getTime() + durMs).toISOString();
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
      end: { dateTime: hasOffset(endDt) ? endDt : new Date(new Date(ev.start).getTime() + durMs).toISOString() },
    };
  }
  return {
    start: { dateTime: ev.start, timeZone: ev.tzStart || BC.TIMEZONE },
    end: { dateTime: endDt, timeZone: ev.tzEnd || ev.tzStart || BC.TIMEZONE },
  };
}

// A later email about the same booking that's a strictly better source
// (higher-confidence layer and/or more complete data) replaces the dates,
// title, location and description instead of just appending to them —
// this is what fixes a bad guess from a weak source once a better one shows up.
function bcUpgradeEvent_(existing, ev, ctx, files, layer, quality) {
  const atts = files.filter(f => !ev.attachmentFilter || ev.attachmentFilter.test(f.name));
  const time = bcEventTimeFields_(ev);
  const patch = {
    summary: (ev.needsReview ? '[To review] ' : '') + ev.title,
    location: ev.location || '',
    description: bcBuildDescription_(ev, ctx, atts, layer),
    start: time.start, end: time.end,
    extendedProperties: { private: { resaKey: existing.extendedProperties?.private?.resaKey || ev._key, resaRef: ev.ref || '', resaQuality: String(quality) } },
  };
  if (atts.length) patch.attachments = [...(existing.attachments || []), ...atts.map(bcAttResource_)];
  try {
    Calendar.Events.patch(patch, BC.CALENDAR_ID, existing.id, { supportsAttachments: true });
    bcInvalidateDay_((existing.start?.date || existing.start?.dateTime || '').slice(0, 10));
    bcInvalidateDay_(ev.start.slice(0, 10));
  } catch(e) {}
}

// Appends a full extra source block (same details/email/tickets/reference/
// source structure as the primary description) rather than trying to merge
// new lines into the existing text — simpler and keeps each source legible
// on its own instead of an ad-hoc diff of what's "new".
function bcEnrichEvent_(existing, ev, ctx, files, layer) {
  const currentDesc = existing.description || '';
  const threadUrl = bcThreadUrl_(ctx);
  if (currentDesc.includes(threadUrl)) return;
  const atts = files.filter(f => !ev.attachmentFilter || ev.attachmentFilter.test(f.name));
  const patch = { description: currentDesc + '\n\n------\n\n' + bcBuildDescription_(ev, ctx, atts, layer) };
  if (atts.length) patch.attachments = [...(existing.attachments || []), ...atts.map(bcAttResource_)];
  try { Calendar.Events.patch(patch, BC.CALENDAR_ID, existing.id, { supportsAttachments: true }); } catch(e) {}
}

function bcCreateEvent_(ev, ctx, files, layer) {
  const atts = files.filter(f => !ev.attachmentFilter || ev.attachmentFilter.test(f.name));
  const time = bcEventTimeFields_(ev);
  const resource = {
    summary: (ev.needsReview ? '[To review] ' : '') + ev.title, location: ev.location || '',
    description: bcBuildDescription_(ev, ctx, atts, layer),
    reminders: { useDefault: false, overrides: (bcReminders[ev.cat] || [1440]).map(m => ({ method: 'popup', minutes: m })) },
    extendedProperties: { private: { resaKey: ev._key, resaRef: ev.ref || '', resaQuality: String(bcEventQuality_(ev, layer)) } },
    source: { title: 'Confirmation email', url: bcThreadUrl_(ctx) },
    start: time.start, end: time.end,
  };
  if (atts.length) resource.attachments = atts.map(bcAttResource_);
  for (const patch of [r => r, r => { delete r.source; return r; }, r => { delete r.attachments; return r; }]) {
    try {
      const created = Calendar.Events.insert(patch(resource), BC.CALENDAR_ID, { supportsAttachments: true });
      bcInvalidateDay_(ev.start.slice(0, 10));
      return created;
    } catch (e) {}
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
    // Ticket URLs can come from structured data (e.g. schema.org's
    // ticketDownloadUrl) without appearing as a clickable link in the
    // email's HTML body — check ev.links first, not just the scraped ones.
    const seenUrls = new Set();
    const ticketLinks = [
      ...(ev.links || []).filter(l => l[1] && /ticket/i.test(l[0])).map(l => ({ url: l[1], text: l[0] })),
      ...ctx.links.filter(x => /t[eé]l[eé]charg|e.?ticket|download.*ticket|ticket.*download|billet.*pdf/i.test(x.text) || /\/ticket|\/billet|\/e-ticket/i.test(x.url)),
    ]
      .filter(x => !seenUrls.has(x.url) && seenUrls.add(x.url))
      // Fetches to this domain never return from Apps Script — skip it so
      // one slow link can't stall the whole batch. Link stays in the
      // description for manual use.
      .filter(x => !/fnacspectacles\.com/i.test(x.url));
    ticketLinks.forEach((lk, i) => {
      try {
        let resp = UrlFetchApp.fetch(lk.url, { muteHttpExceptions: true, followRedirects: true });
        if (resp.getResponseCode() !== 200) return;
        let mime = resp.getHeaders()['Content-Type'] || '';
        // Intermediate HTML download page (e.g. "téléchargement commence dans 3s"):
        // extract the direct PDF link from meta-refresh or the fallback "cliquez ici" anchor
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
