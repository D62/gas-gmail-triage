const bcEmoji = {
  flight: '✈️', train: '🚆', hotel: '🏨', event: '🎫', food: '🍽️',
  appointment_medical: '🏥', appointment_personal: '📅', meeting: '📞',
};
function bcPickEmoji_(cat, title) {
  const t = String(title || '');
  for (const [re, em] of bcEmojiContext) { if (re.test(t)) return em; }
  return bcEmoji[cat] || '📅';
}

function bcForEachIncoming_(thread, fn) {
  const me = Session.getEffectiveUser().getEmail().toLowerCase();
  thread.getMessages().forEach(msg => {
    if (msg.getFrom().toLowerCase().includes(me)) return;
    try { fn(msg); } catch (e) { console.error('Error processing "' + msg.getSubject() + '": ' + e); }
  });
}

function processBookings(thread) {
  bcForEachIncoming_(thread, msg => bcProcessMsg_(msg, false));
}

// Verbose date trace for manual runs only. runAll() leaves this off.
var bcTraceOn_ = false;
function bcTrace_(line) { if (bcTraceOn_) console.log(line); }

function bcTraceEvent_(ctx, ev, layer, action) {
  if (!bcTraceOn_) return;
  let calendar = '';
  try { calendar = JSON.stringify(bcEventTimeFields_(ev)); } catch (e) { calendar = 'time fields failed: ' + e; }
  console.log([
    'EVENT ' + action,
    '  mail: ' + ctx.subject + ' | ' + ctx.from,
    '  thread: ' + ctx.msg.getThread().getId(),
    '  layer: ' + layer + ' | cat=' + (ev.cat || '') + (ev._isPreDeparture ? ' | blocker' : '') + (ev.allDay ? ' | allDay' : ''),
    '  title: ' + ev.title,
    '  source: ' + (ev._src || '(no raw source — derived blocker)'),
    '  resolved: start=' + ev.start + ' tzStart=' + (ev.tzStart || '') + ' end=' + (ev.end || '') + ' tzEnd=' + (ev.tzEnd || '') + (ev.location ? ' | loc=' + ev.location : ''),
    '  calendar: ' + calendar,
  ].join('\n'));
}

function runBookingScanner({ days = 60, from = null, to = null, skipProcessed = true, simulate = false } = {}) {
  let q = '-in:sent -in:drafts -in:trash -in:spam';
  if (from || to) {
    if (from) q = 'after:'  + from.replace(/-/g, '/') + ' ' + q;
    if (to)   q = 'before:' + to.replace(/-/g, '/')   + ' ' + q;
  } else {
    q = 'newer_than:' + days + 'd ' + q;
  }
  if (skipProcessed) q += ' -label:_ckd';
  q += ' (' + bcSubjects.map(s => 'subject:"' + s + '"').join(' OR ') + ' OR filename:ics OR (has:attachment filename:pdf))';
  bcTraceOn_ = true;
  try {
    bcTrace_('SCAN simulate=' + !!simulate + '\n  q=' + q);
    bcRunBatch_(q, simulate);
  } finally {
    bcTraceOn_ = false;
  }
}

function processThread(threadId, simulate) {
  const thread = GmailApp.getThreadById(threadId);
  if (!thread) { console.error('Thread not found: ' + threadId); return; }
  const tally = bcTally_();
  bcTraceOn_ = true;
  try {
    bcTrace_('THREAD ' + threadId + ' simulate=' + !!simulate);
    bcForEachIncoming_(thread, msg => bcProcessMsg_(msg, !!simulate, tally));
    console.log(bcTallyStr_(tally, simulate ? '[DRY RUN] Thread ' + threadId : 'Thread ' + threadId));
  } finally {
    bcTraceOn_ = false;
  }
}

// Schema.org/ICS run for the whole batch first; AI extraction runs last,
// once every fast-layer event already exists in Calendar.
function bcRunBatch_(q, simulate) {
  const tally = bcTally_();
  const deferred = [];
  GmailApp.search(q, 0, bcMaxThreads).forEach(thread => bcForEachIncoming_(thread, msg => bcProcessMsg_(msg, simulate, tally, deferred)));
  deferred.forEach(d => bcProcessDeferred_(d));
  console.log(bcTallyStr_(tally, simulate ? 'Dry run' : 'Done'));
  if (tally.unrecognised.length) console.log('Unrecognised:\n' + tally.unrecognised.slice(0, 40).join('\n'));
}

function bcTally_() { return { created: 0, needsReview: 0, skipped: 0, unrecognised: [], seen: [] }; }
function bcTallyStr_(t, prefix) {
  return prefix + ': ' + t.created + ' created, ' + t.needsReview + ' needs review, ' +
    t.skipped + ' skipped' + (t.unrecognised.length ? ', ' + t.unrecognised.length + ' unrecognised' : '') + '.';
}

/* ===================== MAIN PIPELINE ===================== */

// deferred, when passed, collects messages needing AI extraction — see bcRunBatch_.
function bcProcessMsg_(msg, simulate, tally, deferred) {
  if (!tally) tally = bcTally_();
  const ctx = bcBuildCtx_(msg);
  bcTrace_('MSG "' + ctx.subject + '" from ' + ctx.from + ' | files: ' + (ctx.attachments.map(a => a.getName()).join(', ') || 'none'));
  if (!bcIsEligible_(ctx)) { bcTrace_('  SKIP ineligible'); tally.skipped++; return; }

  let evs = bcEventsFromSchema_(ctx), layer = evs.length ? 'schema.org' : '';
  if (!evs.length) { evs = bcEventsFromIcs_(ctx); if (evs.length) layer = 'ics'; }

  if (!evs.length) {
    if (!deferred && bcAttachTicketPdfs_(ctx, simulate)) { bcTrace_('  PDF attached to existing event'); tally.created++; return; }
    if (deferred) { bcTrace_('  DEFER to AI'); deferred.push({ ctx, simulate, tally }); return; }
    if (bcAlreadyWellCovered_(ctx)) { bcTrace_('  SKIP already on calendar'); tally.skipped++; return; }
    evs = bcClaudeExtract_(ctx);
    if (evs.length) layer = evs[0].provider + (evs[0]._aiModel ? ' (' + evs[0]._aiModel + ')' : '');
  }

  bcFinishProcessing_(ctx, evs, layer, simulate, tally);
}

function bcProcessDeferred_({ ctx, simulate, tally }) {
  if (bcAttachTicketPdfs_(ctx, simulate)) { bcTrace_('PDF "' + ctx.subject + '"\n  attached to existing event'); tally.created++; return; }
  bcTrace_('AI "' + ctx.subject + '"');
  if (bcAlreadyWellCovered_(ctx)) { bcTrace_('  SKIP already on calendar'); tally.skipped++; return; }
  const evs = bcClaudeExtract_(ctx);
  const layer = evs.length ? evs[0].provider + (evs[0]._aiModel ? ' (' + evs[0]._aiModel + ')' : '') : '';
  bcFinishProcessing_(ctx, evs, layer, simulate, tally);
}

function bcFinishProcessing_(ctx, evs, layer, simulate, tally) {
  if (!evs.length) {
    bcTrace_('  UNRECOGNISED');
    tally.unrecognised.push(ctx.subject + '  <' + ctx.from.replace(/.*<|>/g, '') + '>');
    return;
  }

  const { connections, suppressSecurityFor } = bcConnectionEvents_(evs);
  const preDep = evs.filter(e => !suppressSecurityFor.has(e)).map(e => bcPreDepartureEv_(e)).filter(Boolean);
  evs = evs.concat(preDep, connections);

  if (simulate) {
    evs.forEach(e => {
      bcTraceEvent_(ctx, e, layer, 'DRY RUN');
      const atts = bcPreviewAttachments_(ctx, e);
      const desc = [
        ...e.details.filter(d => d[1]).map(d => d[0] + ': ' + d[1]),
        ...(atts.length ? ['', 'Attachments:', ...atts.map(n => '  - ' + n)] : []),
        ...((e.links || []).filter(l => l[1]).length ? ['', 'Links:', ...(e.links || []).filter(l => l[1]).map(l => '  - ' + l[0] + ': ' + l[1])] : []),
      ].join('\n');
      console.log('[' + layer + '] ' + e.title + (e.needsReview ? ' [REVIEW]' : '') +
        '\n  ' + e.start + ' → ' + (e.end || '?') + (e.location ? ' · ' + e.location : '') +
        (desc ? '\n' + desc.split('\n').map(l => '  ' + l).join('\n') : ''));
    });
    evs.some(e => e.needsReview) ? tally.needsReview += evs.length : tally.created += evs.length;
    return;
  }

  evs.forEach(ev => {
    ev._key = bcEventKey_(ev);
    // Start minute + title, not day + place: several ICS legs often share a day and an airport.
    const seenKey = bcInstantMs_(ev.start, ev.tzStart) + '|' + bcNormalize_(ev.title).replace(/\s*\([^)]*\)?\s*$/g, '').trim().slice(0, 60);
    const duplicate = tally.seen.includes(ev._key) || tally.seen.includes(seenKey);
    const match = bcFindExisting_(ev._key, ev);
    const incomingReal = !!(ev.end && !ev._endEstimated);
    // Still let a real arrival through a duplicate-in-this-run skip when the
    // calendar copy is only a default-duration guess.
    if (duplicate && (!incomingReal || (match && bcExistingEndReal_(match.event, ev.cat)))) {
      if (match) {
        bcDropExtraTwins_(match.event, ev);
        bcApplyLabel_(match.event.id);
      }
      bcTraceEvent_(ctx, ev, layer, 'SKIP duplicate in this run');
      return;
    }
    if (match) {
      const quality = bcEventQuality_(ev, layer);
      const existingWhen = JSON.stringify(match.event.start) + ' → ' + JSON.stringify(match.event.end) + ' "' + (match.event.summary || '') + '"';
      const existingReal = bcExistingEndReal_(match.event, ev.cat);
      const incomingEnd = incomingReal ? bcInstantMs_(ev.end, ev.tzEnd || ev.tzStart) : NaN;
      const existingEnd = bcInstantMs_(match.event.end, match.event.end?.timeZone);
      // An equal-quality source may extend a real arrival but not shrink it.
      const endMoved = isFinite(incomingEnd) && isFinite(existingEnd) && incomingEnd - existingEnd > 5 * 60000;
      const canReplace = incomingReal || !existingReal;
      if ((incomingReal && !existingReal) || (endMoved && incomingReal && quality >= match.quality) || (quality > match.quality && canReplace)) {
        bcTraceEvent_(ctx, ev, layer, 'UPGRADE ' + existingWhen);
        bcUpgradeEvent_(match.event, ev, ctx, bcSaveAttachments_(ctx, ev), layer, quality);
        bcDropExtraTwins_(match.event, ev);
        tally.seen.push(ev._key, seenKey);
        tally.created++;
      } else if (!match.exact) {
        bcTraceEvent_(ctx, ev, layer, 'ENRICH dates kept from ' + existingWhen);
        bcEnrichEvent_(match.event, ev, ctx, bcSaveAttachments_(ctx, ev), layer);
        bcDropExtraTwins_(match.event, ev);
        tally.seen.push(ev._key, seenKey);
        tally.created++;
      } else {
        bcDropExtraTwins_(match.event, ev);
        bcApplyLabel_(match.event.id);
        bcTraceEvent_(ctx, ev, layer, 'SKIP same key as ' + existingWhen);
      }
      return;
    }
    bcTraceEvent_(ctx, ev, layer, 'CREATE');
    const created = bcCreateEvent_(ev, ctx, bcSaveAttachments_(ctx, ev), layer);
    if (created) bcDropExtraTwins_(created, ev);
    tally.seen.push(ev._key, seenKey);
    ev.needsReview ? tally.needsReview++ : tally.created++;
  });
}

/* ===================== LAYER 0 — ELIGIBILITY ===================== */

// Google Calendar already adds this event itself — don't create a second copy.
function bcIsGoogleCalendarInvite_(ctx) {
  if (/calendar-notification@google\.com/i.test(ctx.from || '')) return true;
  return (ctx.attachments || []).some(att => /^invite\.ics$/i.test(att.getName() || ''));
}

// A mail that's itself a video-meeting join invitation, not a ticket that merely mentions one.
function bcIsVideoConferenceInvite_(ctx) {
  const from = ctx.from || '';
  if (bcVideoSenders.test(from) || bcVideoSenders.test(bcReconstructDomain_(from))) return true;
  if (/billet|ticket|r[ée]servation|booking|flight|\bvol\b|train|h[oô]tel|sncf|eurostar/i.test(ctx.subject || '')) return false;
  const opening = (ctx.subject || '') + '\n' + (ctx.lines || []).slice(0, 20).join('\n');
  if (bcVideoInvite.test(opening) || bcVideoSenders.test(opening)) return true;
  const ics = (ctx.attachments || []).filter(att => /\.ics$/i.test(att.getName() || ''));
  if (!ics.length) return false;
  return ics.every(att => {
    let raw = '';
    try { raw = att.getDataAsString().slice(0, 12000).replace(/\r?\n[ \t]/g, ''); } catch (e) { return false; }
    return bcVideoInvite.test(raw) || bcVideoSenders.test(raw);
  });
}

function bcIsEligible_(ctx) {
  const { subject, from, text, lines } = ctx;
  const domain = bcReconstructDomain_(from);
  if (bcIsGoogleCalendarInvite_(ctx) || bcIsVideoConferenceInvite_(ctx)) return false;
  if (bcExclSenders.test(domain) || bcExclSenders.test(from)) return false;
  if (bcCalComSenders.test(domain) && !bcActiveCategories.meeting) return false;
  if (bcExclSubjects.some(re => re.test(subject))) return false;
  if (/\bfacture\b/i.test(subject) && !/r[ée]servation|billet|ticket/i.test(subject)) return false;
  if (/annulation/i.test(subject) && !/confirm/i.test(subject)) return false;
  const contextStart = subject + ' ' + lines.slice(0, 5).join(' ');
  if (/demande de r[ée]servation/i.test(contextStart) && !/confirm[ée]e|accept[ée]e/i.test(contextStart)) return false;
  if (/ne fait pas office de validation/i.test(text)) return false;
  if (/votre avis sur|notez votre exp[ée]rience/i.test(text)) return false;
  return true;
}

function bcReconstructDomain_(from) {
  const slMatch = from.match(/([^\s<]+)@simplelogin\.co/i);
  if (slMatch) {
    const atIdx = slMatch[1].indexOf('_at_');
    if (atIdx >= 0) {
      const parts = slMatch[1].slice(atIdx + 4).split('_');
      if (parts.length > 1 && /^[A-Za-z0-9]{4,12}$/.test(parts.at(-1)) && !/^(?:com|fr|co|net|org|io|uk|de|be|nl)$/.test(parts.at(-1))) parts.pop();
      return parts.join('.');
    }
  }
  const addr = (from.match(/<([^>]+)>/) || [null, from.match(/\S+@\S+/)?.[0] || ''])[1];
  return addr.split('@')[1] || from;
}
