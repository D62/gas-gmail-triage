const bcSubjects = [
  // French
  'confirmation', 'réservation', 'billet', 'ticket', 'e-ticket', 'rendez-vous',
  'commande', 'voyage', 'vol', 'séjour',
  'Vos billets', 'Votre billet', 'Confirmation de votre réservation',
  'Billet et informations', 'référence de réservation', 'Billet transféré',
  'reçu Airbnb', 'Réservation confirmée', 'est confirmée',
  // English
  'booking', 'reservation', 'tickets', 'your booking', 'booking confirmation',
  'order confirmation', 'itinerary', 'e-ticket', 'your receipt', 'your trip',
  'your flight', 'your stay', 'check-in',
  // Spanish
  'reserva', 'confirmación', 'tu reserva', 'billete', 'entrada', 'viaje',
  'confirmación de reserva', 'tu pedido', 'embarque',
  // Portuguese
  'reserva confirmada', 'sua reserva', 'bilhete', 'passagem', 'confirmação',
  'check-in online', 'sua viagem',
  // Italian
  'prenotazione', 'conferma', 'biglietto', 'la tua prenotazione',
  'conferma prenotazione', 'il tuo ordine', 'check-in',
  // Polish
  'rezerwacja', 'potwierdzenie', 'bilet', 'zamówienie', 'podróż',
  'potwierdzenie rezerwacji', 'twoja rezerwacja',
  // Japanese
  '予約確認', '予約完了', 'ご予約', 'チケット', '搭乗券', 'eチケット', '宿泊予約',
  // Chinese (Simplified)
  '预订确认', '订单确认', '您的预订', '机票', '车票', '酒店预订', '行程单',
  // Korean
  '예약 확인', '예약확인', '항공권', '승차권', '숙박 예약', '예약 완료',
  // German
  'Buchungsbestätigung', 'Reservierungsbestätigung', 'Ihr Ticket', 'Ihre Buchung',
  'Reisebestätigung', 'Auftragsbestätigung', 'Fahrkarte', 'Bordkarte',
  // Swedish
  'bokningsbekräftelse', 'din bokning', 'din resa', 'biljett', 'orderbekräftelse',
  // Norwegian
  'bestillingsbekreftelse', 'din bestilling', 'din reise', 'billett',
  // Danish
  'bookingbekræftelse', 'din booking', 'din rejse', 'billet', 'ordrebekræftelse',
  // Finnish
  'varausvahvistus', 'tilauksesi', 'lippusi', 'matkasi',
];

const bcMaxThreads = 50;

const bcActiveCategories = {
  transport: true,
  accommodation: true,
  show: true,
  appointment_medical: true,
  appointment_personal: true,
  meeting: false,
};

const bcDefaultDuration = { train: 120, flight: 180, hotel: 0, event: 180, appointment: 60, meeting: 60 };
const bcDepartureBuffer = { eurostar: 60, flight_short: 120, flight_long: 180 };
const bcReminders = { train: [1440, 120], flight: [1440, 180], hotel: [1440], event: [1440, 120], appointment: [1440, 60], meeting: [60] };

const bcAttachmentExt = /\.(pdf|pkpass|png|jpe?g)$/i;
const bcAttachmentExclude = /CGV|CGU|conditions|terms|mentions|facture|invoice/i;

const bcDescLabels = {
  tickets: 'Ticket(s)',
  links: 'Links',
  email: 'Email',
  source: 'Source',
};

const bcExclSenders = /leboncoin|vinted\.fr|amazon\.|leclerc|netflix|dealabs/i;
const bcMedicalSenders = /doctolib|captainvet|vetup|vetolog/i;
const bcPersonalApptSenders = /square\.|squareup\.com/i;
const bcCalComSenders = /\bcal\.com\b|calendly\.com|acuityscheduling/i;

// Videoconference products — a join invite, not a booking.
const bcVideoSenders = /zoom\.(?:us|com)|teams\.microsoft\.com|email\.teams\.microsoft|webex\.com|gotomeeting\.com|\bgoto\.com|bluejeans\.com|whereby\.com|meet\.google\.com|chime\.aws|ringcentral\.com|dialpad\.com|livestorm\.|demio\.com|hopin\.com|skype\.com|meeting\.zoho\.com|around\.co|meet\.jit\.si/i;
const bcVideoInvite = /join zoom meeting|zoom meeting invitation|invited to a zoom|invitation[^.\n]{0,40}zoom meeting|r[ée]union\s+(?:zoom|teams|webex)|microsoft teams meeting|teams\.microsoft\.com\/l\/meetup-join|teams\.live\.com\/meet|zoom\.us\/(?:j|w)\//i;

const bcExclSubjects = [
  // Day-before departure/trip reminders (French-specific wording)
  /J-1\b|d[ée]part imminent/i,
  // Feedback/survey requests
  /Dites.nous comment|votre opinion|votre exp[ée]rience|c[óo]mo fue tu experiencia|conta.nos a tua experi[eê]ncia/i,
  /re[çc]u.*caisse|ticket de caisse/i,
  // Refunds — FR, EN, ES, PT, IT, DE
  /remboursement|\brefund(ed)?\b|reembolso|rimborso|Erstattung|R[uü]ckerstattung/i,
  /\bretour\b.*(?:billet|article|colis)/i,
  /demande sp[ée]ciale/i,
  // Verification codes / passwords — FR, EN, ES, PT, IT, DE
  /code de v[ée]rification|mot de passe|verification code|c[óo]digo de verifica[çc][ãa]o|c[oó]digo de verificaci[oó]n|codice di verifica|Best[äa]tigungscode|Passwort/i,
  // Newsletters / promotions / alerts — FR, EN, ES, PT, IT, PL, DE, JA, ZH, KO, SV/NO/DA
  /\bnewsletter\b|\bpromo(tion)?\b|\balerte\s|\balert\b|promoci[oó]n|promo[çc][ãa]o|promozione|promocja|Werbung|Angebot|ニュースレター|セール情報|促销|优惠快讯|프로모션|nyhetsbrev|nyhedsbrev/i,
  /le billet que vous attendiez/i,
  /\bsont dispo\b|billets?.+(?:disponible|promo|réduction)/i,
  // Appointment reminders (not confirmations) — FR, EN, ES, PT, IT, DE
  /rappel.*rendez.vous|reminder.*appointment|confirm.*your.*appointment|votre rendez.vous.*approche|recordatorio de (?:tu |su )?cita|lembrete de consulta|promemoria appuntamento|Terminerinnerung/i,
  // "Discover / don't miss / what's on" marketing teasers — FR, EN, ES, PT, IT, DE
  /d[ée]couvrez|à ne pas manquer|nos prochains|programmation|à l.affiche|agenda\b|programme\b|don.t miss|coming soon|what.s on|no te lo pierdas|descubre|descubra|non perdere|entdecke|verpasse nicht/i,
  /\babonnement\b(?!.*(confirm|valid|activ))/i,
  // Special/flash/exclusive offers — FR, EN, ES, PT, IT, DE
  /offre\s+(sp[eé]ciale?|exclusive?|flash)|bon\s+(plan|deal)|special offer|exclusive offer|flash sale|oferta especial|oferta exclusiva|offerta speciale|Sonderangebot/i,
  // Pre-sale / on-sale / "tickets are live" — FR, EN, ES, PT, IT, DE
  /pre-?sale|on[- ]sale now|tickets?\s+(?:are|is)\s+live|VIP\s+(?:access|pre-?sale)|on-?sale\s+(?:alert|now)|pr[ée]vente|en vente (?:le|d[eè]s)|preventa|pr[ée]-venda|prevendita|Vorverkauf/i,
];

const bcEmojiContext = [
  [/barbier|coiffeur|haircut|barber|coupe.*barbe|hair/i, '💈'],
  [/dentiste?|dental/i, '🦷'],
  [/ophtalm|optique|optic\b|eye\b/i, '👁️'],
  [/vét[eé]rin|vet\b|animal|chat\b|chien\b|dog\b|cat\b/i, '🐾'],
  [/massage|spa|bien.?[eê]tre|wellness/i, '💆'],
  [/piscine|natation|swimming|pool\b/i, '🏊'],
  [/sport|fitness|gym|musculation|yoga|pilates|kiné/i, '🏋️'],
  [/concert|festival|gig\b|live\b/i, '🎵'],
  [/cin[eé]ma|cin[eé]\b|movie|film\b/i, '🎬'],
  [/match|football|rugby|basket|tennis|stade|arena/i, '⚽'],
  [/th[eé][aâ]tre|opéra|opera|ballet|danse/i, '🎭'],
  [/conf[eé]rence|s[eé]minaire|summit|forum|talk\b/i, '🎤'],
];
