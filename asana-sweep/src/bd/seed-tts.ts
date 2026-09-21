/**
 * The TikTok Shop counterpart map (internal management review, September 2026): 172 named counterparts
 * across EU5, the UK, Benelux and the cross-market units, one row per person, plus the handful of people
 * seen in Isaac's Gmail who are not on the map. This seeds the "TikTok Shop POC" suggestion:
 *
 *  - `category` set   → the person owns that category in the market (the obvious AM to loop in)
 *  - is_agency_manager → TSP / agency partnerships person, the fallback when no category owner is obvious
 *  - notes carry the map's signals: "Closeness N" (Germany only was scored), "gives us active leads",
 *    "Apollo verified", "Promoted", "No Apollo record" (likely leaver: verify before writing) and
 *    "Primary TSP contact" (the person Isaac actually goes through in Lark for that market)
 *
 * Markets: DE, UK, ES, IT, FR, NL (Benelux) and EU for the cross-market units (CAP, FBT, AIGC, APAC, BytePlus).
 */
export interface SeedTtsContact { market: string; category: string | null; name: string; role: string | null; lark: string | null; email: string | null; notes: string | null; is_agency_manager: boolean }

const VER = 'Apollo verified';
const NOREC = 'No Apollo record: likely moved on, verify before writing';
const PROMO = 'Promoted or widened remit (Apollo)';
const LEADS = 'gives us active leads';

function row(market: string, name: string, role: string | null, o: Partial<SeedTtsContact> = {}): SeedTtsContact {
  return { market, category: null, name, role, lark: null, email: null, notes: null, is_agency_manager: false, ...o };
}
const notes = (...parts: (string | null | undefined | false)[]): string => parts.filter(Boolean).join(' · ');

export const SEED_TTS_CONTACTS: SeedTtsContact[] = [
  // ───────────── Germany · leads and heads (scored: closeness 1–10, 12 of the 13 people giving us leads sit here)
  row('DE', 'Max Burianek', 'Leiter TikTok Shop Deutschland', { notes: notes('Closeness 5', LEADS, VER) }),
  row('DE', 'Benedikt Pohl (Bene)', 'BD Multicategory & FMCG, TikTok Shop DE', { category: 'Multi-category & FMCG', notes: notes('Closeness 10', LEADS, VER, 'Anchor relationship with Laurie') }),
  row('DE', 'Saniah Ahmed', 'Head of Agency Partnerships, TikTok Shop', { email: 'saniah.ahmed@tiktok.com', is_agency_manager: true, notes: notes('Primary TSP contact', 'Closeness 8', LEADS, PROMO, 'Sends the TSP matchmaking intros for DE launches (MyHummy, d\'Alba); also covers UK brands expanding to DE') }),
  row('DE', 'Moria Lee', 'GKA Lead DE', { email: 'moria.lee@tiktok.com', notes: notes('Closeness 3', LEADS, NOREC, 'Signed as TTS Beauty Germany in Gmail (d\'Alba intro)') }),
  row('DE', 'Jose Andres Garcia', 'FMCG Lead DE', { category: 'FMCG', email: 'josegarcia@bytedance.com', notes: notes('Closeness 5', LEADS, NOREC, 'On the THG thread with Gerard Ferreiro') }),
  row('DE', 'Bjoern Theissen', 'Category Manager', { notes: VER }),
  row('DE', 'Xianyun Li (Xinyun)', 'Category Lead Beauty, TikTok Shop', { category: 'Beauty', notes: notes('Closeness 4', LEADS, VER) }),
  row('DE', 'Ningxin Wu', 'Tech Sales & Marketing Leader (Multi-Category Lead, Munich)', { lark: 'https://www.larkoffice.com/invitation/page/add_contact/?token=eebi9019-8460-4297-b406-eee360a2cd71&unique_id=SHw670hGAal0eRlUm91xvg==', email: 'ningxin.wu@tiktok.com', notes: notes('Closeness 2', LEADS, VER, 'Introduced Versuni (Philips) to Brightform') }),
  // ───────────── Germany · beauty pod
  row('DE', 'Laurie', 'FMCG / Beauty DE', { category: 'FMCG & Beauty', notes: notes('Closeness 10', LEADS, 'Anchor relationship with Bene') }),
  row('DE', 'Marina Kress', 'Account Manager Beauty', { category: 'Beauty', notes: notes('Closeness 7', LEADS, VER) }),
  row('DE', 'Finja Zeyss', 'Senior AM Beauty', { category: 'Beauty', notes: notes('Closeness 6', LEADS, NOREC) }),
  row('DE', 'Jian Zhao', 'Junior FMCG / Beauty', { category: 'FMCG & Beauty', notes: notes('Closeness 4', LEADS) }),
  row('DE', 'Vanessa Qoli', 'Account-Manager Beauty', { category: 'Beauty', notes: VER }),
  row('DE', 'Elyse Simek', 'Strategy and Operations, Beauty & Personal Care', { category: 'Beauty & Personal Care', notes: VER }),
  // ───────────── Germany · FMCG and categories
  row('DE', 'Niklas Brunn', 'Category Lead - Electronics', { category: 'Electronics', notes: notes('Closeness 6', LEADS, PROMO) }),
  row('DE', 'Giulia', 'H&L AM DE', { category: 'Home & Living (household, kitchen, furniture)', notes: notes('Closeness 2', LEADS) }),
  row('DE', 'Philipp Auerbach', 'Account-Manager FMCG', { category: 'FMCG (Food & Beverages)', email: 'philipp.auerbach@tiktok.com', notes: notes(VER, 'Technical setup and commissions on the THG and Coca-Cola threads') }),
  row('DE', 'Jessica Yen', 'Account Manager', { notes: VER }),
  row('DE', 'Zlatina Bozhinova', 'SMB Account Manager (TikTok for Business, ads)', { lark: 'https://bytedance.my.larkoffice.com/scheduler/4a11b7c9bbe8d723', email: 'zlatina.bozhinova@tiktok.com', notes: notes(VER, 'Ads side, not Shop; Beauty, Health and FMCG focus; took over from Daniel Weithenauer') }),
  row('DE', 'Karen Froehlich', 'Account Management Graduate', { notes: VER }),
  row('DE', 'Faris Sharafli', 'FMCG DE', { category: 'FMCG' }),
  // ───────────── Germany · TSP partner team
  row('DE', 'Ali Atahan Demirci', 'TSP partner manager DE', { is_agency_manager: true, notes: NOREC }),
  row('DE', 'Katharina Guenther', 'TSP · owns the DE TTS Summit', { is_agency_manager: true, notes: NOREC }),
  row('DE', 'Tana-Maria Schaechtele', 'Head of Marketing - Europe', { notes: PROMO }),
  row('DE', 'Kati Anger', 'TSP DE', { is_agency_manager: true, notes: NOREC }),
  row('DE', 'Ana Zamiatina', 'TSP DE', { is_agency_manager: true, notes: NOREC }),
  row('DE', 'Zhu Yumeng', 'TSP DE', { is_agency_manager: true }),
  row('DE', 'Christian Blum', 'Communications Lead, E-Commerce', { notes: VER }),
  row('DE', 'Gan Lai', 'TSP DE', { is_agency_manager: true }),
  // ───────────── Germany · Coca-Cola pod
  row('DE', 'Romina Menzel', 'Creative Agency Partnerships Manager', { notes: notes(VER, 'Coca-Cola pod') }),
  row('DE', 'Elena Sivekova', 'Brand Partnerships Manager CPG @TikTok', { email: 'elena.sivekova@tiktok.com', notes: notes(VER, 'Coca-Cola pod; Coca-Cola TikTok Shop launch DE') }),
  row('DE', 'Felix Kruck', 'Client Solutions Manager', { email: 'felix.kruck@bytedance.com', notes: notes(VER, 'Coca-Cola pod; full-funnel campaigns') }),
  // ───────────── Germany · seller account management
  row('DE', "Ariane d'Autheville", 'SAM DE', { notes: NOREC }),
  row('DE', 'Oussama Arfaoui', 'Program Manager, Seller Growth & Performance', { notes: VER }),
  row('DE', 'Enrico Leitao Glingani', 'SAM DE'),
  row('DE', 'Yihe Zhan', 'SAM DE'),
  // ───────────── Germany · creator and LIVE
  row('DE', 'Delun Xu', 'Creative Labs DE'),
  row('DE', 'Luca Mueller', 'Creator Manager', { notes: VER }),
  row('DE', 'Alexandra Oechsle', 'Creator / LIVE DE', { notes: NOREC }),
  row('DE', 'Maja Peric', 'Creator / LIVE DE'),
  row('DE', 'Luisa Marie Gebauer', 'Creator / LIVE DE', { notes: NOREC }),
  // ───────────── Germany · named accounts, projects and the rest
  row('DE', 'Meyra Ceylan', 'Beauty Account Manager', { category: 'Beauty', notes: VER }),
  row('DE', 'Junadia Rosinta', 'Named account: Unilever · B&B Drogerie'),
  row('DE', 'Lukas Hendrischke', 'TikTok Shop - Client Solutions Manager - Integrations', { notes: VER }),
  row('DE', 'Micheal Rekik', 'Creator Manager Project', { notes: VER }),
  row('DE', 'Katey McElroy', 'TTS DE', { notes: NOREC }),
  row('DE', 'Yanan Wang', 'TTS DE'),
  row('DE', 'Hassell Mundorf Carbajal', 'TTS DE'),
  row('DE', 'Maja Zakierska', 'TikTok Shop partner matchmaking', { email: 'maja.zakierska@bytedance.com', notes: 'From Gmail (not on the map): cc on the MyHummy matchmaking' }),
  // ───────────── GBS DACH · agency and brand partnerships outside the shop org
  row('DE', 'Nele Odzuck', 'GBS DACH · Group Vertical Director Commerce DACH', { notes: VER }),
  row('DE', 'Joshua Gerstendorf', 'GBS DACH · Agency Partnerships Manager | Independent & Performance Agencies', { email: 'joshua.gerstendorf@tiktok.com', is_agency_manager: true, notes: notes(LEADS, VER, 'Runs the Brightform x TikTok weekly; the only lead source outside the shop org and nobody second-lines him') }),
  row('DE', 'Rico Zimmermann', 'GBS DACH · Head of Client Solutions Commerce DACH', { notes: VER }),
  row('DE', 'Christian Seiler', 'GBS DACH · Brand Partnership Manager', { notes: notes('Closeness 7', LEADS, VER) }),
  row('DE', 'Elsa Goeritzer', 'GBS DACH · Team Lead Global Business Marketing, DACH', { notes: PROMO }),

  // ───────────── United Kingdom · TSP partner team (top 10 TSP market, no relationship data yet)
  row('UK', 'Liam Phillips', 'TSP UK · owns the UK TAP community', { is_agency_manager: true, notes: NOREC }),
  row('UK', 'Eve Wilson', 'E-Commerce Senior Manager (TSP partner team)', { is_agency_manager: true, notes: VER }),
  row('UK', 'Sophie Lewis', 'Account Manager (TSP partner team)', { is_agency_manager: true, notes: VER }),
  row('UK', 'Giulia Yang', 'TSP UK', { is_agency_manager: true }),
  row('UK', 'Esme Qiu', 'TSP UK', { is_agency_manager: true }),
  row('UK', 'He Jiayi', 'TSP UK', { is_agency_manager: true }),
  row('UK', 'Mandy Graham', 'TSP UK', { is_agency_manager: true, notes: NOREC }),
  row('UK', 'Jan Wilk', 'TikTok Shop Operations', { notes: VER }),
  // ───────────── United Kingdom · new seller growth
  row('UK', 'Ercan Boyraz', 'Creator Strategy and Partnerships, TikTok Shop', { notes: VER }),
  row('UK', 'Faisal Al-Sabti', 'New seller growth · owns Living Things', { notes: NOREC }),
  row('UK', 'Ed Gilmartin', 'Partnerships Lead, new seller growth', { notes: PROMO }),
  row('UK', 'Sam Tovey', 'Partnerships Lead, new seller growth', { notes: PROMO }),
  row('UK', 'Tom Owen', 'Acquisition Manager and Business Development', { notes: VER }),
  row('UK', 'Beth Parker', 'New seller growth', { notes: NOREC }),
  row('UK', 'Barney Waugh', 'Creator Management Lead', { notes: VER }),
  row('UK', 'Ema Delacote', 'New seller growth'),
  row('UK', 'Massimo Rocchelli', 'Head of Home, FMCG, Sports and new seller growth', { category: 'Home, FMCG & Sports', notes: PROMO }),
  row('UK', 'Joanna Zhu', 'New seller growth'),
  row('UK', 'Yu Bai', 'New seller growth'),
  row('UK', 'Yajie Luo', 'New seller growth'),
  row('UK', 'Daoping Tang', 'New seller growth'),

  // ───────────── Spain · heads and partnerships
  row('ES', 'Joe Jiao', 'TTS Head ES'),
  row('ES', 'Valentina Huang', 'TSP Lead · TAP / CAP / TSP', { is_agency_manager: true, notes: NOREC }),
  row('ES', 'Tingyu L', 'Partnerships lead · 2026 Spain TSP', { is_agency_manager: true }),
  row('ES', 'Monica Jin', 'Partnerships · TSP + CAP group', { is_agency_manager: true }),
  // ───────────── Spain · TSP team
  row('ES', 'Wilbur Hu', 'TSP manager ES · owns the Brightform x TTS ES relationship', { is_agency_manager: true, notes: notes('Primary TSP contact', 'Owns TTS ES') }),
  row('ES', 'Zhou Tiantian', 'TSP ES · Q3 evaluation panel', { is_agency_manager: true }),
  row('ES', 'Keira Gu', 'TSP ES', { is_agency_manager: true }),
  // ───────────── Spain · seller side (the people we actually deal with)
  row('ES', 'Patricia Buakuma Urosa', 'Seller side ES · owns Mixsoon', { email: 'patricia.buakuma@bytedance.com', notes: 'Ran the Brightform Spain weekly with Isaac' }),
  row('ES', 'Yue Wang', 'Seller side ES · Neuro Gum VAT group'),
  row('ES', 'Jason Li', 'Seller side ES · owns the MAI EU group'),
  row('ES', 'Gerard Ferreiro', 'FMCG Category Manager, TikTok Shop Spain', { category: 'FMCG (Food & Beverages)', email: 'gerard.ferreiro@tiktok.com', notes: 'Also DE FMCG and TCCC; introduced Kraft Heinz and Bimbo to Brightform' }),
  row('ES', 'Lia Lai', 'Seller side ES'),
  row('ES', 'Cheng Yu', 'Seller side ES'),
  row('ES', 'Huang Yuhan', 'Seller side ES'),
  row('ES', 'Laura Garcia', 'Seller side ES · also at the IT summit'),
  row('ES', 'Silvia Caballero', 'Seller side ES'),
  row('ES', 'Liya Mamtimen', 'TTS ES'),
  row('ES', 'Santiago Allier', 'TTS ES'),
  // ───────────── Spain · the AM bench (28 account managers nobody on our side owns yet)
  ...['Freya Huang', 'Mateo Padilla', 'Alex Zhu', 'Camilo Roman', 'Salome Zhu', 'Lucia Zhan', 'Ana Montenegro', 'Rui Zhou', 'Iris Wu', 'Irene Garcia', 'Pau Juncadella', 'Julia Liu', 'Carmela Olmos', 'Inigo Enriquez', 'Stella Zhou', 'Rafael Uriarte', 'Paula Sebastian', 'Li Su', 'Lucia Herranz', 'Jiali Xu', 'Andrea Sebastian', 'Alberto Rojo', 'Lucila Fernandez', 'Hemil Hernandez', 'Wanting Liu', 'Stefan Garcia', 'Maika Robledo', 'Zhao Huanli']
    .map((name) => row('ES', name, 'Account Manager ES (AM bench)', { notes: 'AM bench: no owner on our side and no recorded contact yet' })),

  // ───────────── Italy
  row('IT', 'Melody', 'TTS Head IT'),
  row('IT', 'Vincenzo Santillo', 'Head of Agency Partnerships, TikTok Shop', { email: 'vincenzo.santillo@tiktok.com', is_agency_manager: true, notes: notes('Primary TSP contact', PROMO, 'Give Back Beauty matchmaking') }),
  row('IT', 'Giulia Barilaro', 'TikTok Shop Creator Manager', { notes: VER }),
  row('IT', 'Liu Ning', 'Owns the main Brightform x TTS Italy group', { is_agency_manager: true }),
  row('IT', 'Carolina Wang', 'TTS IT'),
  row('IT', 'Paolo Bertaccini', 'TTS IT (cross-border sellers into the UK and EU)', { email: 'paolo.bertaccini@tiktok.com', notes: 'Threads with UAE and Gulf sellers launching in Europe' }),
  row('IT', 'Bledi Balliu', 'TTS IT'),
  row('IT', 'Yi Kun', 'TTS IT'),
  row('IT', 'Alessandro Apolito', 'EU Key Account Manager, TikTok Shop (Milan)', { lark: 'https://bytedance.sg.larkoffice.com/scheduler/438bfa68d0de649e', email: 'alessandro.apolito@tiktok.com', notes: notes('Comfort Click intro', 'On the map as Alessandro Nicola Apolito, attached to Vegavero (DE)', NOREC) }),
  row('IT', 'Silvia Delfino', 'TikTok Shop Italy (TSP matchmaking)', { email: 'silvia.delfino@bytedance.com', notes: 'From Gmail (not on the map)' }),

  // ───────────── France (four names, two leads, nothing beneath them)
  row('FR', 'Mehdi Meghzifene', 'E-Commerce lead, TikTok Shop France', { notes: VER }),
  row('FR', 'Alexandre Giraudeau', 'TikTok Shop France Launcher', { email: 'alexandre.giraudeau@bytedance.com', is_agency_manager: true, notes: notes('Primary TSP contact', VER, 'Weekly with Isaac') }),
  row('FR', 'Laura Kuroki', 'TTS France'),
  row('FR', 'Pierre Amend', 'TTS France'),

  // ───────────── Benelux (everything runs through Jiayue's group)
  row('NL', 'Jiayue Ren', 'TTS Benelux · owns the Brightform Benelux group', { email: 'jiayue.ren@bytedance.com', is_agency_manager: true, notes: notes('Primary TSP contact', 'Brightform Benelux weekly') }),
  row('NL', 'Boris Hoevenaar', 'TTS Benelux · Super Ninja workgroup', { notes: NOREC }),
  row('NL', 'Daria Kalinina', 'TTS Benelux'),
  row('NL', 'Liang Jiayan', 'TTS Benelux'),
  row('NL', 'Walid Omar', 'TTS Benelux'),
  row('NL', 'Sofia Soria Poblaciones', 'TTS Benelux'),
  row('NL', 'Remi Moenielal', 'TTS Benelux'),
  row('NL', 'Alvaro Castillo Sierra', 'TTS Benelux'),
  row('NL', 'Xiong Yujiao', 'TTS Benelux'),

  // ───────────── Cross-market units (not tied to a market)
  row('EU', 'Billy Zhao', 'CAP partnerships · owns the CAP community chat'),
  row('EU', 'Caroline J. Kinnula', 'CAP partnerships · in six of our groups'),
  row('EU', 'Vivienne Hua', 'CAP partnerships · also AIGC, LIVE, DE pilot'),
  row('EU', 'Cai Meng', 'CAP partnerships · Brightform x BDD, Nativex'),
  row('EU', 'Won Kil', 'CAP partnerships'),
  row('EU', 'Rayna Zhu', 'CAP partnerships'),
  row('EU', 'Elise Huang', 'CAP partnerships'),
  row('EU', 'Hu Biao (Bill)', 'CAP partnerships'),
  row('EU', 'Zheng Wang', 'CAP partnerships'),
  row('EU', 'Hao Huang', 'Fulfilled by TikTok · owns Brightform x FBT'),
  row('EU', 'Gergely Hollos', 'Fulfilled by TikTok · DE seller broadcast channel'),
  row('EU', 'Neil Yu', 'AIGC · owns the AIGC project group'),
  row('EU', 'Ye Weixiong', 'AIGC'),
  row('EU', 'Wang Xiaohui', 'AIGC'),
  row('EU', 'Qiu Kaizhou', 'APAC · TTS Japan visit'),
  row('EU', 'Li Chenjun (Roger)', 'APAC · TTS Japan visit'),
  row('EU', 'Yuki (Elon) Tagami', 'APAC · TTS Japan visit'),
  row('EU', 'Judy Chiu', 'APAC'),
  row('EU', 'Mandy Chen', 'APAC'),
  row('EU', 'Chris Chan', 'APAC'),
  // ───────────── BytePlus (separate business unit; Shop API and Dyna.ai threads run through it)
  row('EU', 'Aygul Zagidullina', 'BytePlus · Global AI Partnership & Ecosystem Manager', { notes: notes(VER, 'The one live commercial thread: Shop API') }),
  row('EU', 'Lucy Li', 'BytePlus / TikTok Shop API'),
  row('EU', 'Lin Yuanjun', 'BytePlus · owns the Dyna.ai group'),
  row('EU', 'Vincent Huys', 'BytePlus'),
  row('EU', 'Zhao Tuo', 'BytePlus'),
  row('EU', 'Terry', 'BytePlus'),
  row('EU', 'Jay Kim', 'BytePlus'),
  row('EU', 'Will Jin', 'BytePlus'),
  row('EU', 'Gu Lin', 'BytePlus'),
];
