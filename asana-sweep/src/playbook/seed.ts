import type { PlaybookKind } from '../sweep/types.js';

/**
 * Brightform's Cruva best practice: Cruva's own six lifecycle bots (Shipped, Delivered, First sale,
 * Content unfulfilled 7d, No post in 10 days, Rejected), our outreach pushes (first outreach, monthly
 * deals, new product, top creators collab), the CRM groups behind them, a creator brief, the creator
 * newsletter, and the hygiene items that live in the Cruva UI (auto review rules, blacklist, AI replies,
 * workflows from Cruva's templates). Every item is checked against the shop; the creatable ones are drafted
 * in the shop's language with [brand], products, categories and the brief link filled in.
 * [brand] / [brief_link] / [month] are ours; [affiliate_name] is Cruva's placeholder.
 * `core: true` marks the bots the monitor warns about when missing or paused.
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

const delivered: Copy = {
  en: 'Hi [affiliate_name], your [brand] sample should have arrived by now 💜\n\nHave fun with it, we cannot wait to see what you create. The brief below has the videos that convert best, the hooks and the do\'s and don\'ts:\n👉 [brief_link]\n\nAny question, just reply here.\n\nTeam [brand]',
  de: 'Hi [affiliate_name], dein [brand]-Sample sollte inzwischen bei dir sein 💜\n\nViel Spaß damit, wir sind gespannt auf dein Video. Im Brief unten findest du die Videos, die am besten konvertieren, die Hooks und die Do\'s und Don\'ts:\n👉 [brief_link]\n\nBei Fragen einfach hier antworten.\n\nTeam [brand]',
  fr: 'Hello [affiliate_name], ton échantillon [brand] a dû arriver 💜\n\nAmuse-toi avec, on a hâte de voir ta vidéo. Le brief ci-dessous regroupe les vidéos qui convertissent le mieux, les hooks et les do\'s and don\'ts :\n👉 [brief_link]\n\nUne question ? Réponds ici.\n\nL\'équipe [brand]',
  it: 'Ciao [affiliate_name], il tuo campione [brand] dovrebbe essere arrivato 💜\n\nDivertiti, non vediamo l\'ora di vedere il tuo video. Nel brief qui sotto trovi i video che convertono meglio, gli hook e i do\'s and don\'ts:\n👉 [brief_link]\n\nPer qualsiasi domanda rispondi qui.\n\nTeam [brand]',
  es: 'Hola [affiliate_name], tu muestra de [brand] ya debería haber llegado 💜\n\nDisfrútala, tenemos muchas ganas de ver tu vídeo. En el brief de abajo tienes los vídeos que mejor convierten, los hooks y los do\'s and don\'ts:\n👉 [brief_link]\n\nCualquier duda, responde aquí.\n\nEquipo [brand]',
};
const firstSale: Copy = {
  en: 'Congrats on your first [brand] sale, [affiliate_name]! 🎉 That is a real win.\n\nKeep posting videos like that one, creators who post two or three times a week on the same product see their commission climb fast. Need another sample or a different product? Reply here.\n\nTeam [brand]',
  de: 'Glückwunsch zu deinem ersten [brand]-Verkauf, [affiliate_name]! 🎉 Das ist ein echter Erfolg.\n\nMach genau so weiter: Creator, die zwei- bis dreimal pro Woche zum selben Produkt posten, sehen ihre Provision schnell steigen. Brauchst du ein weiteres Sample oder ein anderes Produkt? Antworte einfach hier.\n\nTeam [brand]',
  fr: 'Bravo pour ta première vente [brand], [affiliate_name] ! 🎉 C\'est une vraie réussite.\n\nContinue comme ça : les créateurs qui postent deux ou trois fois par semaine sur le même produit voient leur commission grimper vite. Besoin d\'un autre échantillon ou d\'un autre produit ? Réponds ici.\n\nL\'équipe [brand]',
  it: 'Complimenti per la tua prima vendita [brand], [affiliate_name]! 🎉 È un bel traguardo.\n\nContinua così: i creator che postano due o tre volte a settimana sullo stesso prodotto vedono le commissioni salire in fretta. Ti serve un altro campione o un prodotto diverso? Rispondi qui.\n\nTeam [brand]',
  es: '¡Enhorabuena por tu primera venta de [brand], [affiliate_name]! 🎉 Es un logro de verdad.\n\nSigue así: los creadores que publican dos o tres veces por semana sobre el mismo producto ven subir su comisión rápido. ¿Necesitas otra muestra u otro producto? Responde aquí.\n\nEquipo [brand]',
};
const noPost10: Copy = {
  en: 'Hi [affiliate_name], we loved what you posted for [brand], great work 💜\n\nIt has been a little while since your last video. Creators who keep a steady rhythm earn the most, and we are putting budget behind the videos that perform. Want a fresh sample or a product to feature next? Reply here and we sort it.\n\nTeam [brand]',
  de: 'Hi [affiliate_name], dein Content für [brand] hat uns richtig gut gefallen 💜\n\nDein letztes Video ist schon eine Weile her. Creator mit einem festen Rhythmus verdienen am meisten, und wir schieben Budget hinter die Videos, die laufen. Brauchst du ein frisches Sample oder ein neues Produkt? Antworte hier, wir kümmern uns.\n\nTeam [brand]',
  fr: 'Hello [affiliate_name], on a adoré ce que tu as posté pour [brand], bravo 💜\n\nÇa fait un petit moment depuis ta dernière vidéo. Les créateurs qui gardent un rythme régulier gagnent le plus, et on met du budget derrière les vidéos qui marchent. Envie d\'un nouvel échantillon ou d\'un autre produit ? Réponds ici, on s\'en occupe.\n\nL\'équipe [brand]',
  it: 'Ciao [affiliate_name], ci è piaciuto molto quello che hai postato per [brand], ottimo lavoro 💜\n\nÈ passato un po\' dal tuo ultimo video. I creator con un ritmo costante guadagnano di più, e noi mettiamo budget dietro ai video che funzionano. Vuoi un nuovo campione o un altro prodotto? Rispondi qui e ci pensiamo noi.\n\nTeam [brand]',
  es: 'Hola [affiliate_name], nos encantó lo que publicaste para [brand], gran trabajo 💜\n\nHace un tiempo desde tu último vídeo. Los creadores con un ritmo constante son los que más ganan, y ponemos presupuesto detrás de los vídeos que funcionan. ¿Quieres una muestra nueva u otro producto? Responde aquí y lo organizamos.\n\nEquipo [brand]',
};
const rejected: Copy = {
  en: 'Hi [affiliate_name], thank you for your interest in [brand]. We could not approve your sample request this time, usually down to stock or the current campaign focus.\n\nYou are welcome to apply again in a few weeks, and you can still add [brand] to your showcase in the meantime.\n\nTeam [brand]',
  de: 'Hi [affiliate_name], danke für dein Interesse an [brand]. Wir konnten deine Sample-Anfrage diesmal nicht freigeben, meist liegt das am Lagerbestand oder am aktuellen Kampagnenfokus.\n\nIn ein paar Wochen kannst du dich gern wieder bewerben, und [brand] kannst du jederzeit in dein Showcase aufnehmen.\n\nTeam [brand]',
  fr: 'Hello [affiliate_name], merci pour ton intérêt pour [brand]. On n\'a pas pu valider ta demande d\'échantillon cette fois-ci, en général à cause du stock ou de la campagne en cours.\n\nTu peux refaire une demande dans quelques semaines, et ajouter [brand] à ta vitrine en attendant.\n\nL\'équipe [brand]',
  it: 'Ciao [affiliate_name], grazie per il tuo interesse per [brand]. Questa volta non abbiamo potuto approvare la tua richiesta di campione, di solito per lo stock o per il focus della campagna in corso.\n\nPuoi riprovare tra qualche settimana, e nel frattempo puoi aggiungere [brand] alla tua vetrina.\n\nTeam [brand]',
  es: 'Hola [affiliate_name], gracias por tu interés en [brand]. Esta vez no hemos podido aprobar tu solicitud de muestra, normalmente por stock o por el enfoque de la campaña actual.\n\nPuedes volver a solicitarla en unas semanas, y mientras tanto puedes añadir [brand] a tu escaparate.\n\nEquipo [brand]',
};
const inviteMessage: Copy = {
  en: '[brand] is growing fast on TikTok Shop. Creators posting about us earn 20% commission on every sale plus 5% ad commission, and we send a free sample to get you started. Request yours and we ship this week.',
  de: '[brand] wächst gerade stark auf TikTok Shop. Creator verdienen 20% Provision auf jeden Verkauf plus 5% Ad-Provision, und wir schicken dir ein kostenloses Sample zum Start. Fordere es an, wir verschicken diese Woche.',
  fr: '[brand] grandit vite sur TikTok Shop. Les créateurs gagnent 20% de commission sur chaque vente plus 5% de commission pub, et on envoie un échantillon gratuit pour démarrer. Demande le tien, envoi cette semaine.',
  it: '[brand] sta crescendo velocemente su TikTok Shop. I creator guadagnano il 20% di commissione su ogni vendita più il 5% di commissione ads, e ti mandiamo un campione gratuito per iniziare. Richiedilo, spediamo questa settimana.',
  es: '[brand] está creciendo rápido en TikTok Shop. Los creadores ganan un 20% de comisión por cada venta más un 5% de comisión por anuncios, y te enviamos una muestra gratis para empezar. Pídela y la enviamos esta semana.',
};
const newsletter: Copy = {
  en: 'Hi [affiliate_name],\n\nQuick update from [brand] for [month]: our deals are live on TikTok Shop, so every video converts better than usual. Commission stays the same, more sales for you.\n\nProducts to push this month and the hooks that work are in the brief: [brief_link]\n\nNeed a fresh sample? Reply to this email.\n\nTeam [brand]',
  de: 'Hi [affiliate_name],\n\nkurzes Update von [brand] für [month]: Unsere Deals laufen auf TikTok Shop, jedes Video konvertiert also besser als sonst. Die Provision bleibt gleich, mehr Verkäufe für dich.\n\nWelche Produkte diesen Monat laufen und welche Hooks funktionieren, steht im Brief: [brief_link]\n\nBrauchst du ein neues Sample? Antworte einfach auf diese Mail.\n\nTeam [brand]',
  fr: 'Bonjour [affiliate_name],\n\nPetit point [brand] pour [month] : nos promos sont en ligne sur TikTok Shop, chaque vidéo convertit mieux que d\'habitude. La commission ne change pas, plus de ventes pour toi.\n\nLes produits à pousser ce mois-ci et les hooks qui marchent sont dans le brief : [brief_link]\n\nBesoin d\'un nouvel échantillon ? Réponds à cet e-mail.\n\nL\'équipe [brand]',
  it: 'Ciao [affiliate_name],\n\nbreve aggiornamento da [brand] per [month]: le nostre offerte sono attive su TikTok Shop, quindi ogni video converte meglio del solito. La commissione resta la stessa, più vendite per te.\n\nI prodotti da spingere questo mese e gli hook che funzionano sono nel brief: [brief_link]\n\nTi serve un nuovo campione? Rispondi a questa email.\n\nTeam [brand]',
  es: 'Hola [affiliate_name],\n\nBreve actualización de [brand] para [month]: nuestras ofertas están activas en TikTok Shop, así que cada vídeo convierte mejor de lo normal. La comisión se mantiene, más ventas para ti.\n\nLos productos a impulsar este mes y los hooks que funcionan están en el brief: [brief_link]\n\n¿Necesitas una muestra nueva? Responde a este correo.\n\nEquipo [brand]',
};

const LANGS = ['en', 'de', 'fr', 'it', 'es'];
const SEND_WINDOW = { time_limits: { start: '08:00', end: '22:00' } };

function dmAutomation(key: string, name: string, description: string, copy: Copy, audience: 'new_affiliates' | 'groups', extra: Record<string, unknown> = {}): SeedItem[] {
  return LANGS.map((language) => ({ kind: 'automation', key, language, name, description, config: { title: name, message_type: 'dm', outreach_audience: audience, dm_messages: [{ type: 'message', content: copy[language] }], content_type: 'any', status: 'stopped', ...SEND_WINDOW, ...extra } }));
}

/** Target collab + DM: the invite card first, then the message. Products and categories are filled in from the shop at prepare time. */
function inviteAutomation(key: string, name: string, description: string, copy: Copy, invite: Copy, extra: Record<string, unknown> = {}): SeedItem[] {
  return LANGS.map((language) => ({ kind: 'automation', key, language, name, description, config: {
    title: name, message_type: 'invite+dm', outreach_audience: 'new_affiliates', content_type: 'any', status: 'stopped', ...SEND_WINDOW,
    outreach_filters: { categories: [], min_gmv: 10000 },
    invite_details: { title: '[brand]: free sample + 20%', message: invite[language], offer_free_samples: true, auto_approve_free_samples: false, resolve_conflicts: true, products: [], commission: 20, shop_ads_commission: 5, expire_time: 6, expire_grain: 'weeks' },
    dm_messages: [{ type: 'invite_card' }, { type: 'message', content: copy[language] }, { type: 'followup', content: copy[language].split('\n')[0] + ' ' + ({ en: 'Just checking you saw this, the sample is still yours if you want it.', de: 'Nur zur Sicherheit, das Sample wartet noch auf dich.', fr: 'Juste pour être sûr que tu as vu, l\'échantillon est toujours pour toi.', it: 'Solo per sicurezza, il campione è ancora tuo se lo vuoi.', es: 'Solo por si no lo viste, la muestra sigue siendo tuya si la quieres.' } as Copy)[language], delay_days: 3 }],
    ...extra,
  } }));
}

export const SEED_PLAYBOOK: SeedItem[] = [
  // ---- CRM groups: the segments of the shop's own creators that the bots run on. Cruva group filters; thresholds editable in the library. ----
  { kind: 'group', key: 'sample_sent', language: '*', name: 'Sample sent', description: 'Sample request status = shipped: the parcel is on its way (feeds the Shipped bot).', config: { title: 'Sample sent', filters: { sample_status: ['shipped'] }, core: true } },
  { kind: 'group', key: 'content_pending', language: '*', name: 'Delivered, content pending', description: 'Sample delivered, no video yet (feeds the Delivered bot).', config: { title: 'Delivered, content pending', filters: { sample_status: ['content_pending'] }, core: true } },
  { kind: 'group', key: 'first_sale', language: '*', name: 'First sale', description: 'Creators who sold at least one unit for this shop (feeds the First sale bot).', config: { title: 'First sale', filters: { min_units_sold: 1 }, core: true } },
  { kind: 'group', key: 'content_not_posted', language: '*', name: 'Content not posted (7d+)', description: 'Sample received 7+ days ago and still no video: Cruva\'s "content unfulfilled" (feeds the Content unfulfilled bot).', config: { title: 'Content not posted', filters: { min_days_unfulfilled: 7 }, core: true } },
  { kind: 'group', key: 'no_post_10d', language: '*', name: 'Posted, quiet 10 days', description: '1 to 5 posts and nothing in the last 10 days (feeds the No post in 10 days bot).', config: { title: 'Posted, quiet 10 days', filters: { min_videos: 1, max_videos: 5, min_days: 10 }, core: true } },
  { kind: 'group', key: 'rejected', language: '*', name: 'Rejected', description: 'Sample request status = rejected (feeds the Rejected bot, which only messages creators who enter after rollout).', config: { title: 'Rejected', filters: { sample_status: ['rejected'] }, core: true } },
  { kind: 'group', key: 'top_creators', language: '*', name: 'Top creators', description: 'Creators who drove real GMV for this shop (push more videos, collabs, bonuses, the VIP tag).', config: { title: 'Top creators', filters: { min_gmv: 300, min_videos: 1 } } },
  { kind: 'group', key: 'inactive_creators', language: '*', name: 'Inactive creators (30d+)', description: 'Posted before, nothing in the last 30 days (retarget with a bonus).', config: { title: 'Inactive creators (30d+)', filters: { min_videos: 1, min_days: 30 } } },
  { kind: 'group', key: 'existing_creators', language: '*', name: 'Existing creators', description: 'Everyone who has posted at least once (deals info, new product messages).', config: { title: 'Existing creators', filters: { min_videos: 1 } } },
  { kind: 'group', key: 'posted_no_gmv', language: '*', name: 'Posted, no sales', description: 'Posted but nothing sold: content that did not convert, worth a brief and a hook.', config: { title: 'Posted, no sales', filters: { min_videos: 1, max_gmv: 0 } } },

  // ---- The six lifecycle bots Cruva says every shop should run (Outreach › Automations › CRM Creators › DM). ----
  ...dmAutomation('sample_sent', 'Sample sent', 'Cruva bot 1, Shipped: thanks, shipping note, the brief link, three content ideas.', sampleSent, 'groups', { group_key: 'sample_sent', core: true }),
  ...dmAutomation('delivered', 'Delivered', 'Cruva bot 2, Delivered: the parcel landed, re-anchor the brief so the first video lands fast.', delivered, 'groups', { group_key: 'content_pending', core: true }),
  ...dmAutomation('first_sale', 'First sale', 'Cruva bot 3, First sale: warm congratulations, ask for a steady rhythm.', firstSale, 'groups', { group_key: 'first_sale', core: true }),
  ...dmAutomation('content_not_posted', 'Content unfulfilled (7 days)', 'Cruva bot 4: soft chase a week after delivery, framed as keeping the account healthy.', contentNotPosted, 'groups', { group_key: 'content_not_posted', core: true }),
  ...dmAutomation('no_post_10d', 'No post in 10 days', 'Cruva bot 5: re-engage creators who posted a bit then went quiet.', noPost10, 'groups', { group_key: 'no_post_10d', core: true }),
  ...dmAutomation('rejected', 'Rejected', 'Cruva bot 6: polite note to rejected creators, door left open. Only creators who enter the group after rollout (entry date guard).', rejected, 'groups', { group_key: 'rejected', filter_by_entry_date: true, entry_date_threshold: '[tomorrow]', core: true }),

  // ---- Our own bots on the CRM groups. ----
  ...dmAutomation('push_more_videos', 'Push more videos', 'Runs on Top creators: ask for two or three posts a week, offer more samples.', pushMore, 'groups', { group_key: 'top_creators' }),
  ...dmAutomation('retarget_bonus', 'Retarget + bonus', 'Runs on Inactive creators: come back and post for a commission top-up.', retargetBonus, 'groups', { group_key: 'inactive_creators' }),
  ...dmAutomation('deals_info_existing', '[month] deals info', 'Runs on Existing creators when deals go live: post this week, same commission, more sales. Renamed with the month at rollout.', dealsInfo, 'groups', { group_key: 'existing_creators' }),

  // ---- New-affiliate outreach. ----
  ...inviteAutomation('first_outreach', 'First outreach', 'Cruva\'s bread-and-butter: target collab invite + DM to new affiliates in the shop\'s categories with 10k+ GMV, 20% + 5% ads, samples on manual review, follow-up after 3 days, 8am to 10pm.', firstOutreach, inviteMessage, { core: true }),
  ...dmAutomation('monthly_deals_outreach', '[month] deals outreach', 'Monthly refresh of the big outreach tied to the live deals. Renamed with the month at rollout.', dealsOutreach, 'new_affiliates', { outreach_filters: { categories: [] } }),
  ...dmAutomation('new_product_outreach', 'New product outreach', 'DM to new affiliates whenever a product launches, with the new product attached.', newProduct, 'new_affiliates', { outreach_filters: { categories: [] } }),
  { kind: 'automation', key: 'top_creators_collab', language: '*', name: 'Target collab: top creators', description: 'Invite + DM to the saved list of top creators in the category (the list comes from the AI search item).', config: { title: 'Target collab: top creators', message_type: 'invite+dm', outreach_audience: 'list', list_key: 'ai_search_list', content_type: 'any', status: 'stopped', ...SEND_WINDOW, invite_details: { title: '[brand]: top creators collab', message: inviteMessage.en, offer_free_samples: true, auto_approve_free_samples: false, resolve_conflicts: true, products: [], commission: 20, shop_ads_commission: 5, expire_time: 6, expire_grain: 'weeks' }, dm_messages: [{ type: 'invite_card' }, { type: 'message', content: firstOutreach.en }] } },
  { kind: 'automation', key: 'ai_auto_replies', language: '*', name: 'AI Auto Replies', description: 'Cruva\'s AI answers creator DMs. Switched on in the Cruva UI (Outreach › Auto Replies); checked here, not created.', config: { title: 'AI Auto Replies', message_type: 'replies', manual: true } },

  // ---- Lists, brief, email. ----
  { kind: 'list', key: 'ai_search_list', language: '*', name: 'Top creators in category (AI search)', description: 'Every creator in the shop\'s categories with 10k+ affiliate GMV, saved as a list for the top creators collab.', config: { title: '[brand] · top creators in category', filters: { categories: [], min_gmv: 10000 }, limit: 2000, strictness: 'balanced' } },
  { kind: 'brief', key: 'creator_brief', language: '*', name: 'Creator brief', description: 'One branded brief page per shop: the shop\'s top videos (auto), hooks and do/don\'t rules. Its link goes into the Shipped and Delivered bots.', config: { name: '[brand] creator brief', headline: 'How to make [brand] videos that sell', brief_type: 'static', video_mode: 'auto', dynamic_content: { all_products: true, video_count: 6, sort_by: 'gmv', past_months: 6 }, top_hooks: ['POV: you finally found the one that works', '3 things I wish I knew before trying [brand]', 'This replaced my whole routine'], guidelines: [{ type: 'do', description: 'Show the product on camera in the first 2 seconds' }, { type: 'do', description: 'Say what it does for you, in your own words' }, { type: 'do', description: 'Tag the product so viewers can buy from the video' }, { type: 'dont', description: 'Skip the hook: TikTok scrolls in 1.4 seconds' }, { type: 'dont', description: 'Read the packaging out loud' }] } },
  { kind: 'sender', key: 'sender_email', language: '*', name: 'Sender email', description: 'A sender address for creator emails, ideally on a verified custom subdomain (Outreach › Email Campaigns › Manage Sender Emails). Checked here; the domain is verified in the Cruva UI.', config: { manual: true } },
  { kind: 'email_campaign', key: 'creator_newsletter', language: '*', name: '[month] creator newsletter', description: 'Monthly email to existing creators with the deals, the products to push and the brief. Needs a sender email on the shop.', config: { title: '[month] creator newsletter', subject: '[brand] · [month] deals and the products to push', email_body: newsletter.en, email_body_by_language: newsletter, outreach_audience: 'groups', group_key: 'existing_creators', sender_emails: [], daily_limit: 60, status: 'stopped' } },

  // ---- Workflows: built from Cruva's templates in the UI (the step graph does not travel well), checked here. ----
  { kind: 'workflow', key: 'sample_chase', language: '*', name: 'Sample request nudge', description: 'Cruva template: creators by sample status, DM, wait, nudge again. Outreach › Workflows › Browse templates.', config: { manual: true } },
  { kind: 'workflow', key: 'welcome_new', language: '*', name: 'Welcome new creators', description: 'Cruva template: DM every new creator, wait a few days, follow up anyone who did not reply.', config: { manual: true } },

  // ---- Tags and hygiene: Cruva UI only, ticked by hand once done. ----
  { kind: 'tag', key: 'do_not_contact', language: '*', name: 'do-not-contact tag', description: 'Static tag excluded from every outreach group: the global blacklist that travels with the creator.', config: { tag: 'do-not-contact', manual: true } },
  { kind: 'tag', key: 'vip', language: '*', name: 'VIP dynamic tag', description: 'Dynamic tag in sync with the Top creators group (Affiliate CRM › Tag Manager › Create dynamic tag).', config: { tag: 'VIP', group_key: 'top_creators', manual: true } },
  { kind: 'manual', key: 'auto_review', language: '*', name: 'Auto review rules', description: 'Sample Requests › Auto Review: approve creators over the follower and GMV floor automatically, reject under 1k followers.', config: { manual: true } },
  { kind: 'manual', key: 'blacklist', language: '*', name: 'Blacklist loaded', description: 'Outreach › Automations › gear › Exclude Affiliates: the agency blacklist CSV uploaded once per shop.', config: { manual: true } },
];
