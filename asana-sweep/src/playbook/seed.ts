import type { PlaybookKind } from '../sweep/types.js';

/**
 * Brightform's Cruva best practice, distilled from the shops that perform (GreatVita DE, Kijimea DE
 * and the rest of the portfolio): a first outreach to new affiliates, a monthly deals push, a new
 * product push, the CRM groups that segment existing creators, and the DM automations that run on
 * them (sample sent, content not posted, push more videos, retarget with a bonus, deals info).
 * [brand] is replaced with the shop's brand at apply time; [affiliate_name] is Cruva's own placeholder.
 */

export interface SeedItem { kind: PlaybookKind; key: string; language: string; name: string; description?: string; config: Record<string, unknown> }

type Copy = Record<string, string>;

const firstOutreach: Copy = {
  en: 'Hi [affiliate_name],\n\nWe are [brand] and we are growing fast on TikTok Shop. Creators who post about us are earning well on commission, and we send free samples to get you started.\n\nRequest your sample through the affiliate programme and we will get it out to you this week. Tag us when you post and we will push the best videos.\n\nTeam [brand]',
  de: 'Hi [affiliate_name],\n\nwir sind [brand] und wachsen gerade stark auf TikTok Shop. Creator, die über uns posten, verdienen gute Provision, und wir schicken dir ein kostenloses Sample zum Start.\n\nFordere dein Sample über das Affiliate-Programm an, wir verschicken es diese Woche. Tagge uns in deinem Video, dann pushen wir die besten Clips.\n\nTeam [brand]',
  fr: 'Bonjour [affiliate_name],\n\nNous sommes [brand] et nous grandissons vite sur TikTok Shop. Les créateurs qui parlent de nous gagnent de bonnes commissions, et nous envoyons un échantillon gratuit pour démarrer.\n\nDemande ton échantillon via le programme d’affiliation, on l’envoie cette semaine. Tague-nous sur ta vidéo et on poussera les meilleures.\n\nL’équipe [brand]',
  it: 'Ciao [affiliate_name],\n\nsiamo [brand] e stiamo crescendo velocemente su TikTok Shop. I creator che parlano di noi guadagnano bene con le commissioni, e ti mandiamo un campione gratuito per iniziare.\n\nRichiedi il campione dal programma affiliati e lo spediamo questa settimana. Taggaci nel video e spingeremo i migliori.\n\nTeam [brand]',
  es: 'Hola [affiliate_name],\n\nSomos [brand] y estamos creciendo rápido en TikTok Shop. Los creadores que hablan de nosotros ganan buenas comisiones, y te enviamos una muestra gratis para empezar.\n\nPide tu muestra desde el programa de afiliados y la enviamos esta semana. Etiquétanos en tu vídeo y daremos impulso a los mejores.\n\nEquipo [brand]',
};
const dealsOutreach: Copy = {
  en: 'Hi [affiliate_name],\n\nThis month [brand] is running deals on TikTok Shop, which means higher conversion on every video you post. Commission stays the same, so this is the best time to post.\n\nRequest a free sample from the affiliate programme and we will ship it this week.\n\nTeam [brand]',
  de: 'Hi [affiliate_name],\n\ndiesen Monat laufen bei [brand] Deals auf TikTok Shop, das heißt mehr Verkäufe pro Video. Die Provision bleibt gleich, also ist jetzt der beste Zeitpunkt zu posten.\n\nFordere ein kostenloses Sample über das Affiliate-Programm an, wir verschicken es diese Woche.\n\nTeam [brand]',
  fr: 'Bonjour [affiliate_name],\n\nCe mois-ci [brand] lance des promos sur TikTok Shop, donc plus de ventes sur chaque vidéo. La commission ne change pas, c’est le meilleur moment pour poster.\n\nDemande un échantillon gratuit via le programme d’affiliation, on l’envoie cette semaine.\n\nL’équipe [brand]',
  it: 'Ciao [affiliate_name],\n\nquesto mese [brand] ha delle offerte su TikTok Shop, quindi più vendite per ogni video. La commissione resta la stessa: è il momento migliore per postare.\n\nRichiedi un campione gratuito dal programma affiliati, lo spediamo questa settimana.\n\nTeam [brand]',
  es: 'Hola [affiliate_name],\n\nEste mes [brand] tiene ofertas en TikTok Shop, así que cada vídeo convierte más. La comisión se mantiene, así que es el mejor momento para publicar.\n\nPide una muestra gratis desde el programa de afiliados y la enviamos esta semana.\n\nEquipo [brand]',
};
const newProduct: Copy = {
  en: 'Hi [affiliate_name],\n\n[brand] just launched new products on TikTok Shop and we are sending samples to the first creators who post about them. Request yours through the affiliate programme and we will get it out this week.\n\nTeam [brand]',
  de: 'Hi [affiliate_name],\n\n[brand] hat gerade neue Produkte auf TikTok Shop gelauncht und wir schicken Samples an die ersten Creator, die darüber posten. Fordere deins über das Affiliate-Programm an, wir verschicken es diese Woche.\n\nTeam [brand]',
  fr: 'Bonjour [affiliate_name],\n\n[brand] vient de lancer de nouveaux produits sur TikTok Shop et nous envoyons des échantillons aux premiers créateurs qui en parlent. Demande le tien via le programme d’affiliation, envoi cette semaine.\n\nL’équipe [brand]',
  it: 'Ciao [affiliate_name],\n\n[brand] ha appena lanciato nuovi prodotti su TikTok Shop e mandiamo i campioni ai primi creator che ne parlano. Richiedi il tuo dal programma affiliati, lo spediamo questa settimana.\n\nTeam [brand]',
  es: 'Hola [affiliate_name],\n\n[brand] acaba de lanzar productos nuevos en TikTok Shop y enviamos muestras a los primeros creadores que hablen de ellos. Pide la tuya desde el programa de afiliados y la enviamos esta semana.\n\nEquipo [brand]',
};
const sampleSent: Copy = {
  en: 'Hey [affiliate_name],\n\nThanks for requesting a [brand] sample. TikTok has shipped your parcel and it should be with you very soon.\n\nA few content ideas that worked well last month:\n- Honest first impression on camera\n- How it fits into your daily routine\n- Before and after, or a quick taste / feel test\n\nThe more you post, the more you sell and the more commission you earn. Tag us and we will push the best videos.\n\nTeam [brand]',
  de: 'Hey [affiliate_name],\n\nvielen Dank, dass du ein [brand]-Sample angefragt hast. TikTok hat dein Paket bereits verschickt und es sollte dich sehr bald erreichen.\n\nEin paar Content-Ideen, die letzten Monat gut liefen:\n- Ehrlicher erster Eindruck vor der Kamera\n- Wie es in deine tägliche Routine passt\n- Vorher-Nachher oder ein kurzer Test\n\nJe mehr du postest, desto mehr verkaufst du und desto mehr Provision verdienst du. Tagge uns, dann pushen wir die besten Videos.\n\nTeam [brand]',
  fr: 'Hey [affiliate_name],\n\nMerci d’avoir demandé un échantillon [brand]. TikTok a expédié ton colis, il arrive très bientôt.\n\nQuelques idées de contenu qui ont bien marché le mois dernier :\n- Première impression honnête face caméra\n- Comment ça s’intègre dans ta routine\n- Avant / après ou un test rapide\n\nPlus tu postes, plus tu vends et plus tu gagnes de commission. Tague-nous et on poussera les meilleures vidéos.\n\nL’équipe [brand]',
  it: 'Hey [affiliate_name],\n\ngrazie per aver richiesto un campione [brand]. TikTok ha spedito il pacco e arriverà molto presto.\n\nAlcune idee di contenuto che hanno funzionato il mese scorso:\n- Prima impressione sincera davanti alla camera\n- Come entra nella tua routine quotidiana\n- Prima e dopo, o un test veloce\n\nPiù posti, più vendi e più commissioni guadagni. Taggaci e spingeremo i video migliori.\n\nTeam [brand]',
  es: 'Hey [affiliate_name],\n\nGracias por pedir una muestra de [brand]. TikTok ya ha enviado tu paquete y llegará muy pronto.\n\nAlgunas ideas de contenido que funcionaron bien el mes pasado:\n- Primera impresión sincera a cámara\n- Cómo encaja en tu rutina diaria\n- Antes y después, o una prueba rápida\n\nCuanto más publiques, más vendes y más comisión ganas. Etiquétanos y daremos impulso a los mejores vídeos.\n\nEquipo [brand]',
};
const contentNotPosted: Copy = {
  en: 'Hey [affiliate_name],\n\nWe hope your [brand] sample arrived safely. We would love to see how you bring it into your content.\n\nIf you have any questions or need input, message us any time. Otherwise we are looking forward to your video. Do not forget to tag us.\n\nTeam [brand]',
  de: 'Hey [affiliate_name],\n\nwir hoffen, dein [brand]-Sample ist gut bei dir angekommen. Wir sind gespannt, wie du es in deinen Content einbaust.\n\nFalls du Fragen hast oder Input brauchst, melde dich jederzeit. Ansonsten freuen wir uns auf dein Video. Vergiss nicht, uns zu taggen.\n\nTeam [brand]',
  fr: 'Hey [affiliate_name],\n\nOn espère que ton échantillon [brand] est bien arrivé. On a hâte de voir comment tu l’intègres dans ton contenu.\n\nSi tu as des questions, écris-nous à tout moment. Sinon, on attend ta vidéo avec impatience. N’oublie pas de nous taguer.\n\nL’équipe [brand]',
  it: 'Hey [affiliate_name],\n\nsperiamo che il tuo campione [brand] sia arrivato bene. Non vediamo l’ora di vedere come lo userai nei tuoi contenuti.\n\nSe hai domande o ti serve qualcosa, scrivici quando vuoi. Altrimenti aspettiamo il tuo video. Non dimenticare di taggarci.\n\nTeam [brand]',
  es: 'Hey [affiliate_name],\n\nEsperamos que tu muestra de [brand] haya llegado bien. Tenemos ganas de ver cómo la integras en tu contenido.\n\nSi tienes dudas o necesitas algo, escríbenos cuando quieras. Si no, esperamos tu vídeo. No olvides etiquetarnos.\n\nEquipo [brand]',
};
const pushMore: Copy = {
  en: 'Hey [affiliate_name],\n\nYour [brand] videos are converting well, thank you. Creators who post two or three times a week on the same product are seeing their commission climb fast.\n\nWant more samples or a different product to feature? Reply here and we will sort it.\n\nTeam [brand]',
  de: 'Hey [affiliate_name],\n\ndeine [brand]-Videos laufen richtig gut, danke dir. Creator, die zwei- bis dreimal pro Woche zum selben Produkt posten, sehen ihre Provision schnell steigen.\n\nBrauchst du mehr Samples oder ein anderes Produkt? Antworte einfach hier, wir kümmern uns darum.\n\nTeam [brand]',
  fr: 'Hey [affiliate_name],\n\nTes vidéos [brand] convertissent bien, merci. Les créateurs qui postent deux ou trois fois par semaine sur le même produit voient leur commission grimper vite.\n\nTu veux d’autres échantillons ou un autre produit ? Réponds ici et on s’en occupe.\n\nL’équipe [brand]',
  it: 'Hey [affiliate_name],\n\ni tuoi video [brand] stanno convertendo bene, grazie. I creator che postano due o tre volte a settimana sullo stesso prodotto vedono le commissioni salire in fretta.\n\nVuoi altri campioni o un prodotto diverso? Rispondi qui e ci pensiamo noi.\n\nTeam [brand]',
  es: 'Hey [affiliate_name],\n\nTus vídeos de [brand] están convirtiendo bien, gracias. Los creadores que publican dos o tres veces por semana sobre el mismo producto ven subir su comisión rápido.\n\n¿Quieres más muestras u otro producto? Responde aquí y lo gestionamos.\n\nEquipo [brand]',
};
const retargetBonus: Copy = {
  en: 'Hey [affiliate_name],\n\nIt has been a while since your last [brand] video. We are running a bonus this month for creators who post again: post one video about [brand] and message us the link, and we will top up your commission.\n\nNeed a fresh sample? Reply here.\n\nTeam [brand]',
  de: 'Hey [affiliate_name],\n\ndein letztes [brand]-Video ist schon eine Weile her. Diesen Monat gibt es einen Bonus für Creator, die wieder posten: Poste ein Video über [brand], schick uns den Link, und wir stocken deine Provision auf.\n\nBrauchst du ein neues Sample? Antworte einfach hier.\n\nTeam [brand]',
  fr: 'Hey [affiliate_name],\n\nÇa fait un moment depuis ta dernière vidéo [brand]. Ce mois-ci, bonus pour les créateurs qui repostent : publie une vidéo sur [brand], envoie-nous le lien, et on complète ta commission.\n\nBesoin d’un nouvel échantillon ? Réponds ici.\n\nL’équipe [brand]',
  it: 'Hey [affiliate_name],\n\nè passato un po’ dal tuo ultimo video [brand]. Questo mese c’è un bonus per chi torna a postare: pubblica un video su [brand], mandaci il link e integriamo la tua commissione.\n\nTi serve un nuovo campione? Rispondi qui.\n\nTeam [brand]',
  es: 'Hey [affiliate_name],\n\nHace tiempo desde tu último vídeo de [brand]. Este mes hay un bono para creadores que vuelven a publicar: sube un vídeo sobre [brand], mándanos el enlace y completamos tu comisión.\n\n¿Necesitas una muestra nueva? Responde aquí.\n\nEquipo [brand]',
};
const dealsInfo: Copy = {
  en: 'Hey [affiliate_name],\n\nHeads up: [brand] has deals live on TikTok Shop this month, so your videos will convert better than usual. Same commission, more sales. Worth posting this week.\n\nTeam [brand]',
  de: 'Hey [affiliate_name],\n\nkurzer Hinweis: [brand] hat diesen Monat Deals auf TikTok Shop, deine Videos konvertieren also besser als sonst. Gleiche Provision, mehr Verkäufe. Lohnt sich, diese Woche zu posten.\n\nTeam [brand]',
  fr: 'Hey [affiliate_name],\n\nPetit rappel : [brand] a des promos en ligne sur TikTok Shop ce mois-ci, tes vidéos vont mieux convertir. Même commission, plus de ventes. Ça vaut le coup de poster cette semaine.\n\nL’équipe [brand]',
  it: 'Hey [affiliate_name],\n\nun avviso: [brand] ha offerte attive su TikTok Shop questo mese, quindi i tuoi video convertiranno meglio del solito. Stessa commissione, più vendite. Vale la pena postare questa settimana.\n\nTeam [brand]',
  es: 'Hey [affiliate_name],\n\nAviso: [brand] tiene ofertas activas en TikTok Shop este mes, así que tus vídeos convertirán mejor de lo normal. Misma comisión, más ventas. Merece la pena publicar esta semana.\n\nEquipo [brand]',
};

const LANGS = ['en', 'de', 'fr', 'it', 'es'];

function dmAutomation(key: string, name: string, description: string, copy: Copy, audience: 'new_affiliates' | 'groups', extra: Record<string, unknown> = {}): SeedItem[] {
  return LANGS.map((language) => ({ kind: 'automation', key, language, name, description, config: { title: name, message_type: 'dm', outreach_audience: audience, dm_messages: [{ type: 'message', content: copy[language] }], content_type: 'any', status: 'stopped', daily_limits_timezone: 'Europe/Madrid', ...extra } }));
}

export const SEED_PLAYBOOK: SeedItem[] = [
  // CRM groups (segments of the shop's own creators). Filters are Cruva group filters; adjust thresholds per shop in the library.
  { kind: 'group', key: 'sample_sent', language: '*', name: 'Sample sent', description: 'Creators whose sample was approved / shipped and who have not posted yet (feeds the "Sample sent" DM).', config: { title: 'Sample sent', filters: { min_samples: 1, max_videos: 0, max_days_sample: 14 } } },
  { kind: 'group', key: 'content_not_posted', language: '*', name: 'Content not posted', description: 'Sample delivered more than 7 days ago and still no video.', config: { title: 'Content not posted', filters: { min_samples: 1, max_videos: 0, min_days_sample: 7 } } },
  { kind: 'group', key: 'top_creators', language: '*', name: 'Top creators', description: 'Creators who drove real GMV for this shop (push more videos, collabs, bonuses).', config: { title: 'Top creators', filters: { min_gmv: 300, min_videos: 1 } } },
  { kind: 'group', key: 'inactive_creators', language: '*', name: 'Inactive creators (30d+)', description: 'Posted before, nothing in the last 30 days (retarget with a bonus).', config: { title: 'Inactive creators (30d+)', filters: { min_videos: 1, min_days: 30 } } },
  { kind: 'group', key: 'existing_creators', language: '*', name: 'Existing creators', description: 'Everyone who has posted at least once (deals info, new product messages).', config: { title: 'Existing creators', filters: { min_videos: 1 } } },
  // New-affiliate outreach automations.
  ...dmAutomation('first_outreach', 'First outreach', 'Broad DM to new affiliates in the shop\'s categories with a sample offer (the biggest driver of new creators on every shop).', firstOutreach, 'new_affiliates', { outreach_filters: { categories: [] }, daily_message_limits: { dm: 1500 } }),
  ...dmAutomation('monthly_deals_outreach', 'Monthly deals outreach', 'Monthly refresh of the big outreach tied to the live deals (September Deals, October Deals...). Rename with the month when applying.', dealsOutreach, 'new_affiliates', { outreach_filters: { categories: [] }, daily_message_limits: { dm: 1500 } }),
  ...dmAutomation('new_product_outreach', 'New product outreach', 'DM to new affiliates whenever a product launches, with the new product attached.', newProduct, 'new_affiliates', { outreach_filters: { categories: [] } }),
  // Automations on the CRM groups.
  ...dmAutomation('sample_sent', 'Sample sent', 'Runs on the "Sample sent" group: thanks, shipping note, three content ideas, tag us.', sampleSent, 'groups', { group_key: 'sample_sent' }),
  ...dmAutomation('content_not_posted', 'Content not posted', 'Runs on the "Content not posted" group: friendly chase a week after delivery.', contentNotPosted, 'groups', { group_key: 'content_not_posted' }),
  ...dmAutomation('push_more_videos', 'Push more videos', 'Runs on "Top creators": ask for two or three posts a week, offer more samples.', pushMore, 'groups', { group_key: 'top_creators' }),
  ...dmAutomation('retarget_bonus', 'Retarget + bonus', 'Runs on "Inactive creators": come back and post for a commission top-up.', retargetBonus, 'groups', { group_key: 'inactive_creators' }),
  ...dmAutomation('deals_info_existing', 'Deals info (existing creators)', 'Runs on "Existing creators" when deals go live: post this week, same commission, more sales.', dealsInfo, 'groups', { group_key: 'existing_creators' }),
  { kind: 'automation', key: 'ai_auto_replies', language: '*', name: 'AI Auto Replies', description: 'Cruva\'s AI replies to creator DMs (switched on in the Cruva UI; checked here, not created).', config: { title: 'AI Auto Replies', message_type: 'replies', manual: true } },
  { kind: 'automation', key: 'top_creators_collab', language: '*', name: 'Target collab: top creators', description: 'Invite + DM to a saved list of the top 20 creators in the category (needs a list: build it with the Cruva AI search first).', config: { title: 'Target collab: top creators', message_type: 'invite+dm', outreach_audience: 'list', list_ids: [], manual: true } },
  // Workflow: chase creators who got a sample and did not post, automatically.
  { kind: 'workflow', key: 'sample_chase', language: '*', name: 'Sample to post chase', description: 'When a creator\'s sample is delivered and no video after 7 days: DM, wait 7 days, DM again, then tag as "no content".', config: { name: 'Sample to post chase', status: 'paused', trigger: { type: 'creator_matches', config: { conditions: [{ field: 'samples', op: 'gte', value: 1 }, { field: 'videos', op: 'eq', value: 0 }, { field: 'days_since_sample', op: 'gte', value: 7 }] }, next: 'dm1' }, steps: [{ id: 'dm1', type: 'send_dm', config: { message: contentNotPosted.en }, next: 'wait1' }, { id: 'wait1', type: 'wait', config: { days: 7 }, next: 'check' }, { id: 'check', type: 'condition', config: { field: 'videos', op: 'gte', value: 1 }, branches: { onTrue: null, onFalse: 'dm2' } }, { id: 'dm2', type: 'send_dm', config: { message: retargetBonus.en }, next: 'tag' }, { id: 'tag', type: 'tag', config: { tag: 'no content' }, next: null }] } },
  // Email campaign to existing creators (needs a linked sender email).
  { kind: 'email_campaign', key: 'creator_newsletter', language: '*', name: 'Creator newsletter (monthly deals)', description: 'Monthly email to existing creators with the deals and the products to push. Needs a sender email linked in Cruva.', config: { title: 'Creator newsletter (monthly deals)', subject: '[brand] on TikTok Shop this month: deals and what to post', email_body: '<p>Hi [affiliate_name],</p><p>[brand] has deals live on TikTok Shop this month, so your videos will convert better than usual. Same commission, more sales.</p><p>Need a fresh sample or a different product? Reply to this email.</p><p>Team [brand]</p>', sender_emails: [], outreach_audience: 'groups', group_key: 'existing_creators', status: 'stopped', manual: true } },
];
