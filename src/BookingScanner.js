const bcEmoji = {
  flight: '✈️', train: '🚆', hotel: '🏨', event: '🎫', food: '🍽️',
  appointment_medical: '🏥', appointment_personal: '📅', meeting: '📞',
};
function bcPickEmoji_(cat, title) {
  const t = String(title || '');
  for (const [re, em] of bcEmojiContext) { if (re.test(t)) return em; }
  return bcEmoji[cat] || '📅';
}

// One message throwing (malformed source data, API hiccup, etc.) must never
// abort the whole thread/batch — that would stop `_ckd` from ever being
// applied, and the same broken message gets retried forever on every
// trigger run. Isolate each message's processing instead.
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
  bcRunBatch_(q, simulate);
}

function processThread(threadId, simulate) {
  const thread = GmailApp.getThreadById(threadId);
  if (!thread) { console.error('Thread not found: ' + threadId); return; }
  const tally = bcTally_();
  bcForEachIncoming_(thread, msg => bcProcessMsg_(msg, !!simulate, tally));
  console.log(bcTallyStr_(tally, simulate ? '[DRY RUN] Thread ' + threadId : 'Thread ' + threadId));
}

// Schema.org/ICS run for the whole batch first; AI extraction (the expensive,
// order-sensitive layer) runs last, once every fast-layer event already
// exists in Calendar — so quality comparisons see the full picture instead
// of whatever happened to be processed first.
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

// deferred, when passed, collects messages needing AI extraction instead of
// calling it immediately — see bcRunBatch_.
function bcProcessMsg_(msg, simulate, tally, deferred) {
  if (!tally) tally = bcTally_();
  const ctx = bcBuildCtx_(msg);
  if (!bcIsEligible_(ctx)) { tally.skipped++; return; }

  let evs = bcEventsFromSchema_(ctx), layer = evs.length ? 'schema.org' : '';
  if (!evs.length) { evs = bcEventsFromIcs_(ctx); if (evs.length) layer = 'ics'; }

  if (!evs.length) {
    if (deferred) { deferred.push({ ctx, simulate, tally }); return; }
    if (bcAlreadyWellCovered_(ctx)) { tally.skipped++; return; }
    evs = bcClaudeExtract_(ctx);
    if (evs.length) layer = evs[0].provider + (evs[0]._aiModel ? ' (' + evs[0]._aiModel + ')' : '');
  }

  bcFinishProcessing_(ctx, evs, layer, simulate, tally);
}

function bcProcessDeferred_({ ctx, simulate, tally }) {
  if (bcAlreadyWellCovered_(ctx)) { tally.skipped++; return; }
  const evs = bcClaudeExtract_(ctx);
  const layer = evs.length ? evs[0].provider + (evs[0]._aiModel ? ' (' + evs[0]._aiModel + ')' : '') : '';
  bcFinishProcessing_(ctx, evs, layer, simulate, tally);
}

function bcFinishProcessing_(ctx, evs, layer, simulate, tally) {
  if (!evs.length) {
    tally.unrecognised.push(ctx.subject + '  <' + ctx.from.replace(/.*<|>/g, '') + '>');
    return;
  }

  const { connections, suppressSecurityFor } = bcConnectionEvents_(evs);
  const preDep = evs.filter(e => !suppressSecurityFor.has(e)).map(e => bcPreDepartureEv_(e)).filter(Boolean);
  evs = evs.concat(preDep, connections);

  if (simulate) {
    evs.forEach(e => {
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
    const seenKey = ev.start.slice(0, 10) + '|' + bcNormalize_((ev.location || '').split(',')[0]).slice(0, 20);
    if (tally.seen.includes(ev._key) || tally.seen.includes(seenKey)) return;
    const match = bcFindExisting_(ev._key, ev);
    if (match) {
      const quality = bcEventQuality_(ev, layer);
      if (quality > match.quality) {
        bcUpgradeEvent_(match.event, ev, ctx, bcSaveAttachments_(ctx, ev), layer, quality);
        tally.seen.push(ev._key, seenKey);
        tally.created++;
      } else if (!match.exact) {
        bcEnrichEvent_(match.event, ev, ctx, bcSaveAttachments_(ctx, ev), layer);
        tally.seen.push(ev._key, seenKey);
        tally.created++;
      }
      return;
    }
    bcCreateEvent_(ev, ctx, bcSaveAttachments_(ctx, ev), layer);
    tally.seen.push(ev._key, seenKey);
    ev.needsReview ? tally.needsReview++ : tally.created++;
  });
}

/* ===================== LAYER 0 — ELIGIBILITY ===================== */

function bcIsEligible_(ctx) {
  const { subject, from, text, lines } = ctx;
  const domain = bcReconstructDomain_(from);
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
