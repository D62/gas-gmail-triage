function labelAliasThread(thread) {
  const props = PropertiesService.getScriptProperties();
  const gmailUser = props.getProperty('GMAIL_USER');
  const domainsJson = props.getProperty('ALLOWED_DOMAINS_JSON');
  if (!gmailUser || !domainsJson) {
    throw new Error('Set GMAIL_USER and ALLOWED_DOMAINS_JSON in Script Properties (run setupConfig()).');
  }
  const allowedDomains = JSON.parse(domainsJson);
  const gmailDomain = (props.getProperty('GMAIL_DOMAIN') || 'gmail.com').toLowerCase();

  const domainRegex = new RegExp(
    `([\\w.+-]+)@((?:[\\w-]+\\.)*(?:${allowedDomains.map(d => d.replace('.', '\\.')).join('|')}))`,
    'i'
  );
  const escapedUser   = gmailUser.replace(/\./g, '\\.');
  const escapedDomain = gmailDomain.replace(/\./g, '\\.');
  const gmailRegex = new RegExp(`^${escapedUser}(@${escapedDomain}|\\+([\\w-]+)@${escapedDomain})$`, 'i');
  const emailInText = /[\w.+-]+@[\w.-]+/g;

  const labelCache = new Map();
  const getOrCreateLabel = (name) => {
    let lbl = labelCache.get(name);
    if (lbl) return lbl;
    lbl = GmailApp.getUserLabelByName(name) || GmailApp.createLabel(name);
    labelCache.set(name, lbl);
    return lbl;
  };

  const addresses = new Set();
  for (const msg of thread.getMessages()) {
    for (const field of [msg.getTo(), msg.getCc()]) {
      if (!field) continue;
      const found = field.match(emailInText);
      if (found) for (const addr of found) addresses.add(addr);
    }
  }

  for (const addr of addresses) {
    const davMatch = addr.match(domainRegex);
    if (davMatch) {
      const [, local, domain] = davMatch;
      const parts = domain.split('.');
      const root = parts.slice(-2).join('.');
      const sub = parts.length > 2 ? parts.slice(0, -2).join('.') : null;
      const parentLabel = sub ? `@${root}:${sub}` : `@${root}`;
      getOrCreateLabel(`${parentLabel}/${local}`).addToThread(thread);
      getOrCreateLabel(parentLabel).addToThread(thread);
      thread.moveToArchive();
      return true;
    }

    const gmailMatch = addr.match(gmailRegex);
    if (gmailMatch && addr.toLowerCase().startsWith(gmailUser)) {
      const plus = gmailMatch[2];
      const label = plus ? `@${gmailDomain}/${gmailUser}+${plus}` : `@${gmailDomain}/${gmailUser}`;
      getOrCreateLabel(label).addToThread(thread);
      getOrCreateLabel(`@${gmailDomain}`).addToThread(thread);
      return true;
    }
  }

  return false;
}
