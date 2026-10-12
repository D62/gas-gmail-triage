const processedLabel = '_ckd';

function runAll() {
  const label = GmailApp.getUserLabelByName(processedLabel) || GmailApp.createLabel(processedLabel);
  // No -in:sent: self-sent mail (From == To == you, e.g. another GAS script's
  // own report) gets Gmail's SENT label automatically, which would hide it
  // here. The original pre-rewrite version never excluded it either.
  const threads = GmailApp.search('newer_than:1h -label:' + processedLabel + ' -in:drafts -in:trash -in:spam', 0, 50);

  for (const thread of threads) {
    try {
      if (FEATURES.bookingScanner) processBookings(thread);
      if (FEATURES.aliasLabeler)   labelAliasThread(thread);
    } catch (e) {
      console.error('Error processing thread ' + thread.getId() + ': ' + e);
    }
    // Always label, even on error — an unlabeled thread gets retried every
    // run forever, burning quota on the same broken message indefinitely.
    thread.addLabel(label);
  }
}
