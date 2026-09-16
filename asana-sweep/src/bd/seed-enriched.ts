/** Decision makers found for the BD prospects with Apollo (organisation match, people search, reveal). Generated on 2026-09-16; seeded by migration 16. */
export interface SeedEnrichedContact { apollo_id: string; name: string; title: string | null; email: string | null; linkedin_url: string | null; note: string | null }
export interface SeedEnrichedShop { seller_id: string; company: string | null; domain: string | null; apollo_org_id: string | null; contacts: SeedEnrichedContact[] }

export const SEED_ENRICHED: SeedEnrichedShop[] = [
  { seller_id: "7494472493961151610", company: "SharkNinja", domain: "sharkninja.com", apollo_org_id: "5da6dea5b07642000121f2df", contacts: [
    { apollo_id: "66fb550da187f300012a68f4", name: "Alec Korkuc", title: "Social Commerce Lead", email: "alec.korkuc@sharkninja.com", linkedin_url: "http://www.linkedin.com/in/alec-korkuc", note: "TikTok Shop / Social Commerce Lead, Cologne (Germany) · email verified" },
    { apollo_id: "62481552afcf2a0001b9ac26", name: "Johannes Dustmann", title: "Senior Director E-Commerce Central Europe", email: "jdustmann@sharkninja.com", linkedin_url: "http://www.linkedin.com/in/johannes-dustmann-91472b229", note: "Senior Director E-Commerce Central Europe, Frankfurt · email verified" },
    { apollo_id: "66f7acdc3ba6980001696c5b", name: "Triantafillos Pavlidis", title: "Senior Affiliate Marketing & Partnerships Manager DACH", email: "t.pavlidis@sharkninja.com", linkedin_url: "http://www.linkedin.com/in/tpavlidis", note: "Affiliate & Partnerships DACH · email verified" },
    { apollo_id: "611e680254f3f70001bd8f52", name: "Markus Becker", title: "Vice President Sales DACH", email: "markus.becker@sharkninja.com", linkedin_url: "http://www.linkedin.com/in/markus-becker-96a81069", note: "VP Sales DACH · email verified" },
  ] },
  { seller_id: "7494542612017022903", company: "Halara", domain: "halara.com", apollo_org_id: "5fca5542192d410001300928", contacts: [
    { apollo_id: "684590211fb2e800012387ba", name: "Joyce Zhang", title: "Founder & CEO", email: null, linkedin_url: "http://www.linkedin.com/in/joyce-zhang-7a5784", note: "Founder & CEO (US) · email unavailable" },
    { apollo_id: "5f30a88ef02f100001041da4", name: "Chuhe Taylor", title: "Ecommerce Manager - TikTok Live", email: null, linkedin_url: "http://www.linkedin.com/in/chuhe-taylor-b726b819b", note: "Ecommerce Manager TikTok Live / TikTok Shop (US) · email unavailable" },
    { apollo_id: "606f6447633cf900011824cf", name: "Cindy Nalbandyan", title: "Sr. Marketing Manager - Influencer, VIP, & Brand Partnerships", email: "cindy.nalbandyan@halara.com", linkedin_url: "http://www.linkedin.com/in/cindynalbandyan", note: "Sr. Influencer & Brand Partnerships Manager (US) · email verified" },
    { apollo_id: "66ac96d76504d100014008e3", name: "Riley Huang", title: "Affiliate Marketing Manager", email: null, linkedin_url: "http://www.linkedin.com/in/riley-huang-a7aa84206", note: "Affiliate Marketing Manager (Shanghai) · email unavailable" },
  ] },
  { seller_id: "7494473298127193363", company: "SharkNinja", domain: "sharkninja.com", apollo_org_id: "5da6dea5b07642000121f2df", contacts: [
    { apollo_id: "57d42544a6da985372f86c23", name: "Anna Panasyuk", title: "E-commerce Manager", email: "anna.panasyuk@sharkninja.com", linkedin_url: "http://www.linkedin.com/in/anna-panasyuk-15228086", note: "E-commerce Manager, Wiesbaden (same company as Ninja Kitchen DE; see its contacts too) · email verified" },
    { apollo_id: "5f0d94a3d7ea5900013f0de6", name: "Dennis Martens", title: "Senior Marketing Manager DACH", email: "dennis.martens@sharkninja.com", linkedin_url: "http://www.linkedin.com/in/dennis-martens-97589415a", note: "Senior Marketing Manager DACH · email verified" },
    { apollo_id: "5d4c4b0880f93e48e4af7412", name: "Vanessa Quaresima", title: "Brand Marketing Manager - DACH", email: null, linkedin_url: "http://www.linkedin.com/in/vanessa-quaresima-b94140167", note: "Brand Marketing Manager DACH · email unavailable" },
  ] },
  { seller_id: "7496123122517969900", company: "Lubluelu", domain: "lubluelu.com", apollo_org_id: "6633650a286e5703001a2851", contacts: [
    { apollo_id: "6135f2d5a7b86800016d1030", name: "Stephie Fang", title: "Sales Team Lead", email: "stephie@lubluelu.com", linkedin_url: "http://www.linkedin.com/in/stephiefang", note: "Sales Team Lead (China HQ) · email verified" },
    { apollo_id: "66797b64e208080001c23e3d", name: "Tracy Deng", title: "Oversea Channel Business Development", email: "tracy@lubluelu.com", linkedin_url: "http://www.linkedin.com/in/tracy-deng-96995523a", note: "Overseas Channel BD (Shenzhen) · email verified" },
  ] },
  { seller_id: "7494385350230247126", company: "APR Corporation (medicube parent)", domain: "apr-in.com", apollo_org_id: "5c988873b873a80b11956546", contacts: [
    { apollo_id: "63eab2075d95ab00017d982d", name: "Jaehee Shim", title: "TikTok Shop MKT Lead", email: null, linkedin_url: "http://www.linkedin.com/in/jaehee-shim-4862a0249", note: "TikTok Shop Marketing Lead / Digital Performance Director (Seoul HQ); no Europe-based medicube staff in Apollo · email unavailable" },
    { apollo_id: "65c5eabb2f1cad0001a7c495", name: "Yoonjae Lee", title: "Global Sales Manager", email: "y.lee@apr-in.com", linkedin_url: "http://www.linkedin.com/in/yoonjae-lee-088a89173", note: "Global Sales Manager (Seoul HQ) · email verified" },
  ] },
  { seller_id: "7496180685249219475", company: "Dreame Technology", domain: "dreametech.com", apollo_org_id: "5da55cab65f378000193d35a", contacts: [
    { apollo_id: "610100e78e3368000107e99f", name: "Chao Gao", title: "Country Manager DACH & BNL", email: "gaochao@dreame.tech", linkedin_url: "http://www.linkedin.com/in/chao-gao-6095ab99", note: "Country Manager DACH & Benelux (Hoofddorp, NL) · email verified" },
    { apollo_id: "67303c851fe13c00014e2910", name: "Yuki Yu", title: "E-Commerce Operation and Sales Manager", email: null, linkedin_url: "http://www.linkedin.com/in/yuki-yu-a0aa95158", note: "E-Commerce Operations & Sales Manager (UK) · email unavailable" },
    { apollo_id: "57df5c39a6da980b6588e471", name: "Yongxin Hong", title: "Head of PR, West Europe", email: "hongyongxin@dreame.tech", linkedin_url: "http://www.linkedin.com/in/yongxin-hong-229736b4", note: "Head of PR Western Europe · email verified" },
  ] },
  { seller_id: "7494147516683748793", company: "Crocs, Inc.", domain: "crocs.com", apollo_org_id: "54a135dd69702d425501d500", contacts: [
    { apollo_id: "55709a8c736964219bd30000", name: "Dirk Wulf", title: "Head of Key Accounts Germany / Austria / Benelux", email: null, linkedin_url: "http://www.linkedin.com/in/dirk-wulf-769ba168", note: "Head of Key Accounts DACH/Benelux (Germany) · email unavailable" },
    { apollo_id: "57d87443a6da984683011faa", name: "Antonela Grippo", title: "Head of UK Marketing and Digital Commerce EMEA", email: "agrippo@crocs.com", linkedin_url: "http://www.linkedin.com/in/agrippo", note: "Head of Digital Commerce EMEA (NL) · email verified" },
    { apollo_id: "62e0b268d4b42a0001c7cd1c", name: "Mireia Jimenez", title: "Digital Commerce Manager International Distributors", email: null, linkedin_url: "http://www.linkedin.com/in/mireiajimenezm", note: "Digital Commerce Manager (NL) · email unavailable" },
  ] },
  { seller_id: "7496257912646961254", company: "VEVOR", domain: "vevor.com", apollo_org_id: "65bb5cdca6509600010b2a62", contacts: [
    { apollo_id: "6570ef27e9631200019e2fc3", name: "Yolanda Song", title: "Vevor Marketing Team - Sr. Director of Partner Development", email: "affiliate@vevor.com", linkedin_url: "http://www.linkedin.com/in/yolanda-song-900b66129", note: "Sr. Director Partner Development / affiliate (Hong Kong); no Europe-based staff in Apollo · email verified" },
    { apollo_id: "6107955b0edcf600018585fd", name: "Domi Chang", title: "Affiliate Marketing Manager", email: null, linkedin_url: "http://www.linkedin.com/in/domi-chang-0baa82166", note: "Affiliate Marketing Manager (China) · email unavailable" },
    { apollo_id: "6925979ceee8ab00012293ca", name: "Jiping Qiu", title: "Social Media Channel Manager", email: null, linkedin_url: "http://www.linkedin.com/in/%e7%ba%aa%e5%b9%b3-%e9%82%b1-256637118", note: "Social Media Channel Manager (Shenzhen) · email unavailable" },
  ] },
  { seller_id: "7496303129653316227", company: "Philips", domain: "philips.com", apollo_org_id: "55922989736964185f60a500", contacts: [
    { apollo_id: "54c21fbd7468697af7f51a7d", name: "Krisztina Orschel", title: "E-Commerce Lead", email: "krisztina.orschel@philips.com", linkedin_url: "http://www.linkedin.com/in/krisztina-orschel-957a56ab", note: "Channel Lead E-Commerce DACH, Hamburg · email verified" },
    { apollo_id: "66fee665b9b7c70001101a86", name: "Caroline Rausch", title: "Consumer Marketing Manager DACH", email: "caroline.rausch@philips.com", linkedin_url: "http://www.linkedin.com/in/caroline-rausch", note: "Consumer Marketing Manager DACH (Personal Health), Hamburg · email verified" },
  ] },
  { seller_id: "7494485177186813748", company: "Pammys (dieseo GmbH)", domain: "pammys.com", apollo_org_id: "6486c322319bb800ab2bca78", contacts: [
    { apollo_id: "5ade5bb7a6da984e06a4150a", name: "Eugen Nowosselski", title: "Co-Founder & CEO", email: "en@dieseo.de", linkedin_url: "http://www.linkedin.com/in/eugen-nowosselski", note: "Co-Founder & CEO, Kiel (emails on parent domain dieseo.de) · email verified" },
    { apollo_id: "5e798fb29f15f8000184daad", name: "Leo Cooley", title: "Sr. Influencer Marketing Manager", email: "l.cooley@dieseo.de", linkedin_url: "http://www.linkedin.com/in/leo-cooley-44a973330", note: "Sr. Influencer Marketing Manager, Hamburg · email verified" },
    { apollo_id: "69ca4708922c520001e7ce0d", name: "Armand Tetaj", title: "Teamlead Influencer Marketing", email: "at@dieseo.de", linkedin_url: "http://www.linkedin.com/in/armand-tetaj-804260360", note: "Teamlead Influencer Marketing, Hamburg · email verified" },
    { apollo_id: "69d318ef2e623000019de69d", name: "Christina Jobst", title: "Project Manager E-Commerce", email: "cj@dieseo.de", linkedin_url: "http://www.linkedin.com/in/christina-jobst-b85b5b189", note: "Project Manager E-Commerce, Kiel · email verified" },
  ] },
  { seller_id: "8647269099932454561", company: "Wavytalk", domain: "wavytalk.com", apollo_org_id: "66eafd30d3f81501b272770d", contacts: [
    { apollo_id: "66eed456880ff5000103487c", name: "Queenie Yang", title: "Wavytalk UK EU Influencer Supervisor", email: null, linkedin_url: "http://www.linkedin.com/in/queenie-yang-131b32158", note: "UK/EU Influencer Supervisor · email unavailable" },
    { apollo_id: "609699fa7fb97c00018c4646", name: "Marina Fernandez", title: "VP of Brand & Retail", email: "marina@wavytalk.com", linkedin_url: "http://www.linkedin.com/in/marina-fernandez-09b1b129", note: "VP Brand & Retail (New York) · email verified" },
    { apollo_id: "679bcf5fa7afed0001d753b5", name: "Hayes Nabozny", title: "Head of Sales | Growth Strategy Executive", email: "hayesn@wavytalk.com", linkedin_url: "http://www.linkedin.com/in/hayes-nabozny-6534488", note: "Head of Sales (US) · email verified" },
    { apollo_id: "610a5d443f81c20001d055c7", name: "Hailey Zanesky", title: "Senior Social Media and Influencer Manager", email: "hailey@wavytalk.com", linkedin_url: "http://www.linkedin.com/in/hailey-zanesky-306833170", note: "Senior Social Media & Influencer Manager (New York) · email verified" },
  ] },
  { seller_id: "7496137625597610444", company: "cfab / Creamy Fabrics", domain: "cfab.com", apollo_org_id: "66e281d5344783074f1c585e", contacts: [
    { apollo_id: "66cf2cddec75d30001e286af", name: "Yasar Ozkan", title: "CEO & Founder", email: "can@creamyfabrics.com", linkedin_url: "http://www.linkedin.com/in/yasar-can-%c3%b6zkan-180ab6318", note: "CEO & Founder, Duesseldorf · email verified" },
    { apollo_id: "69aa9c7f1416f30001339478", name: "Tufan Alkan", title: "Head of Marketplaces", email: "tufan.alkan@multiecom.de", linkedin_url: "http://www.linkedin.com/in/tufan-alkan-839476389", note: "Head of Marketplaces, Cologne (email on multiecom.de) · email verified" },
    { apollo_id: "66348f5289dc7600072e059b", name: "Aylin Cici-Akin", title: "Team Lead Influencer Marketing", email: "aylin@creamyfabrics.com", linkedin_url: "http://www.linkedin.com/in/aylin-cici-akin", note: "Team Lead Influencer Marketing, Duesseldorf · email verified" },
    { apollo_id: "6424303d84723600011791dd", name: "Emre Girkin", title: "Founder", email: "emre.girkin@ecomunlimited.de", linkedin_url: "http://www.linkedin.com/in/emre-girkin-4a7a3624a", note: "Founder, Duesseldorf (email on ecomunlimited.de) · email verified" },
  ] },
  { seller_id: "7496101518497646856", company: "SEAMLESS FASHION Shop", domain: "seamless-fashion.de", apollo_org_id: "670b2ecac4d8d30001bdb2a9", contacts: [
  ] },
  { seller_id: "8647418550144571494", company: "ISEE HAIR", domain: "iseehair.com", apollo_org_id: "66d948ad7a61940001ea9ea0", contacts: [
  ] },
  { seller_id: "7494573679031322194", company: "PUFFIT", domain: "puffit.com", apollo_org_id: "671719fc555e68000123f384", contacts: [
    { apollo_id: "643e67dc94e65700011cc172", name: "Lindi Qi", title: "Influencer Marketing Manager", email: null, linkedin_url: "http://www.linkedin.com/in/lindi-qi-880912b4", note: "Influencer Marketing Manager, TikTok Shop UK / social commerce & affiliate (UK); only 5-person company · email unavailable" },
  ] },
  { seller_id: "7496252968566164090", company: "Hzuaneri", domain: "hzuaneri.org", apollo_org_id: "6a9f1cbde456d90001030630", contacts: [
  ] },
  { seller_id: "7496099180035082903", company: "WOLTU GmbH", domain: "woltu.eu", apollo_org_id: "68c9b4dbba85d1001deb7ef9", contacts: [
    { apollo_id: "663a59f155c98d00014d3e2d", name: "Henry Hu", title: "Deputy General Manager", email: "henry.hu@woltu.com", linkedin_url: "http://www.linkedin.com/in/henry-hu-b87080a6", note: "Deputy General Manager, Wuppertal (catch-all domain) · email verified" },
  ] },
  { seller_id: "7494582654207559391", company: "ECOVACS ROBOTICS / ECOVACS EMEA", domain: "ecovacs.com", apollo_org_id: "5f48b5df7602f50001663e4c", contacts: [
    { apollo_id: "63528f4285008300010580e4", name: "Tobias Kuhnhaeuser", title: "Head of Western Europe", email: "t.kuhnhaeuser@ecovacs.com", linkedin_url: "http://www.linkedin.com/in/tobias-kuhnh%c3%a4user-551a90218", note: "Head of Western Europe (ECOVACS EMEA, Germany) · email verified" },
    { apollo_id: "610aa024f767a40001faf66a", name: "Nicola Cipriani", title: "Senior Manager E-commerce Sales", email: "nicola.cipriani@ecovacs.com", linkedin_url: "http://www.linkedin.com/in/nicola-cipriani-54329114", note: "Senior Manager E-commerce Sales EMEA (Italy) · email verified" },
    { apollo_id: "677d1042bc764c0001e6d53f", name: "Holger Schmidt", title: "Marketing Manager DACH", email: "h.schmidt@ecovacs.com", linkedin_url: "http://www.linkedin.com/in/holger-c-schmidt", note: "Marketing Manager DACH, UK & BNL, Duesseldorf · email verified" },
    { apollo_id: "5b05b76ba3ae61f7af5d998a", name: "Ivan Doubell", title: "Marketing Manager Western Europe", email: "ivan.doubell@ecovacs.com", linkedin_url: "http://www.linkedin.com/in/ivan-doubell-9a121318", note: "Marketing Manager Western Europe (Germany) · email verified" },
  ] },
  { seller_id: "8648556360989317846", company: "APR Corporation (medicube parent)", domain: "apr-in.com", apollo_org_id: "5c988873b873a80b11956546", contacts: [
    { apollo_id: "63eab2075d95ab00017d982d", name: "Jaehee Shim", title: "TikTok Shop MKT Lead", email: null, linkedin_url: "http://www.linkedin.com/in/jaehee-shim-4862a0249", note: "TikTok Shop marketing lead at APR Corp (medicube parent), Seoul; no Europe/Spain staff found in Apollo · email unavailable" },
    { apollo_id: "65c5eabb2f1cad0001a7c495", name: "Yoonjae Lee", title: "Global Sales Manager", email: "y.lee@apr-in.com", linkedin_url: "http://www.linkedin.com/in/yoonjae-lee-088a89173", note: "Global sales manager at APR Corp (medicube parent), Seoul · email verified" },
  ] },
  { seller_id: "7494571503020770593", company: "SharkNinja", domain: "sharkninja.com", apollo_org_id: "5da6dea5b07642000121f2df", contacts: [
    { apollo_id: "60d047b4cb40e20001f47578", name: "Carine Montes", title: "Tiktok Shop Lead Spain", email: "carine.montes@sharkninja.com", linkedin_url: "http://www.linkedin.com/in/carine-montes-56484217b", note: "TikTok Shop Lead Spain, Madrid · email verified" },
    { apollo_id: "5d438ba280f93ea4c1959f47", name: "Ricardo Montes De Oca", title: "E-comerce Manager - Spain", email: null, linkedin_url: "http://www.linkedin.com/in/rbriz", note: "E-commerce Manager Spain, Alcobendas · email unavailable" },
    { apollo_id: "674f30da0e63610001336e5e", name: "Carlos Rocabert Barroso", title: "Affiliate Manager ES & IT", email: "carlos.rocabert@sharkninja.com", linkedin_url: "http://www.linkedin.com/in/carlos-rocabert-barroso", note: "Affiliate Manager Spain & Italy, Madrid · email verified" },
    { apollo_id: "6698e1772221400001247958", name: "Nuno Constant", title: "General Manager Southern Europe", email: "nuno.constant@sharkninja.com", linkedin_url: "http://www.linkedin.com/in/nunoconstant", note: "GM Southern Europe, Madrid · email verified" },
  ] },
  { seller_id: "7495815000108140546", company: "UTOPYA", domain: "utopya.fr", apollo_org_id: "56deb7a3f3e5bb707e00230c", contacts: [
    { apollo_id: "5feb81cf11575100013fab73", name: "Aldric Meneghel", title: "Founder - CEO", email: "aldric@utopya.fr", linkedin_url: "http://www.linkedin.com/in/aldric-meneghel-3552231a3", note: "Founder & CEO, Lyon · email verified" },
    { apollo_id: "66f81041ae47ef000175c571", name: "Silvia Luca", title: "Head of Sales", email: null, linkedin_url: "http://www.linkedin.com/in/silvialuca", note: "Head of Sales, Paris · email unavailable" },
    { apollo_id: "6604ebc5249ee50007e6ab0e", name: "Elias Khalag", title: "Sales Manager", email: "elias@utopya.fr", linkedin_url: "http://www.linkedin.com/in/elias-khalag-00528772", note: "Sales Manager, Bonn · email verified" },
  ] },
  { seller_id: "8647465318367533158", company: "VEVOR", domain: "vevor.com", apollo_org_id: "65bb5cdca6509600010b2a62", contacts: [
    { apollo_id: "6570ef27e9631200019e2fc3", name: "Yolanda Song", title: "Vevor Marketing Team - Sr. Director of Partner Development", email: "affiliate@vevor.com", linkedin_url: "http://www.linkedin.com/in/yolanda-song-900b66129", note: "Sr Director Partner Development (affiliate/partnerships), Hong Kong; no Spain/Europe staff found in Apollo · email verified" },
    { apollo_id: "6107955b0edcf600018585fd", name: "Domi Chang", title: "Affiliate Marketing Manager", email: null, linkedin_url: "http://www.linkedin.com/in/domi-chang-0baa82166", note: "Affiliate Marketing Manager, China · email unavailable" },
    { apollo_id: "6925979ceee8ab00012293ca", name: "Jiping Qiu", title: "Social Media Channel Manager", email: null, linkedin_url: "http://www.linkedin.com/in/%e7%ba%aa%e5%b9%b3-%e9%82%b1-256637118", note: "Social Media Channel Manager, Shenzhen · email unavailable" },
    { apollo_id: "63fefa2c92f90100016736ca", name: "Juan Xie", title: "Cross-border E-commerce Operations Manager", email: null, linkedin_url: "http://www.linkedin.com/in/%e5%a8%9f-%e8%b0%a2-196ab4203", note: "Cross-border e-commerce ops manager, Shanghai · email unavailable" },
  ] },
  { seller_id: "7495819924678871471", company: "Aldous Bio", domain: "aldousbio.com", apollo_org_id: "5e56331f1dcc380001cd7187", contacts: [
    { apollo_id: "64a602856c5f59000189fcdc", name: "Karyna Klachyk", title: "Social Commerce Manager", email: "karyna.klachyk@aldousbio.com", linkedin_url: "http://www.linkedin.com/in/karyna-klachyk", note: "Social Commerce Manager, Valencia · email verified" },
    { apollo_id: "68c1ce9232641a0001017b48", name: "Antonio Pellon Huelamo", title: "CEO & Founder", email: "antonio.pellon@aldousbio.com", linkedin_url: "http://www.linkedin.com/in/antoniopellonhuelamo", note: "CEO & Founder · email verified" },
    { apollo_id: "611f0aea49148a0001b6c85d", name: "Monica Gras Trinidad", title: "CMO", email: "monica.gras@aldousbio.com", linkedin_url: "http://www.linkedin.com/in/m%c3%b3nicagrastrinidad", note: "CMO · email verified" },
    { apollo_id: "5e76dfa83da38a0001fd8d20", name: "Marta De San Pedro", title: "Brand Manager", email: null, linkedin_url: "http://www.linkedin.com/in/marta-villalba-saenz", note: "Brand Manager, Valencia · email unavailable" },
  ] },
  { seller_id: "7495820057582864916", company: "ARMONIAS", domain: "armonias.com", apollo_org_id: "5a9f464ea6da98d97e824137", contacts: [
    { apollo_id: "68c623a43fb0a900012385f0", name: "Duohui Ye", title: "TikTok Shop Channel Operations & Sales Manager — Armonias", email: "duohuiye@armonias.com", linkedin_url: "http://www.linkedin.com/in/duohui-ye-242860259", note: "TikTok Shop channel ops & sales manager, Seville · email extrapolated" },
    { apollo_id: "6702c7f47924e100010f8c9c", name: "Duoma Ye", title: "Co-Founder", email: "duoma.ye@armonias.com", linkedin_url: "http://www.linkedin.com/in/duoma-ye-b81677114", note: "Co-Founder, Seville · email verified" },
  ] },
  { seller_id: "7495866266162399877", company: "L'Oréal", domain: "loreal.com", apollo_org_id: "62cc1a6a8eb39400cbb65bce", contacts: [
    { apollo_id: "54ebc0ce746869444c0b2d1d", name: "Alicia Espejo", title: "Head of Ecommerce", email: "alicia.espejo@loreal.com", linkedin_url: "http://www.linkedin.com/in/aliciaespejo", note: "Head of Ecommerce, Madrid (Spain) · email verified" },
    { apollo_id: "54a48a38746869344265a34f", name: "Antonio Frazao", title: "E-Commerce & Parapharmacy Channel Director", email: "antonio.frazao@loreal.com", linkedin_url: "http://www.linkedin.com/in/antoniofrazao", note: "E-Commerce Channel Director, Madrid (Spain) · email verified" },
    { apollo_id: "66fdae21096970000131e5a5", name: "Daniel Santos", title: "E-Commerce Director", email: "daniel.santos@loreal.com", linkedin_url: "http://www.linkedin.com/in/danieloivosantos", note: "E-Commerce Director, Spain · email verified" },
    { apollo_id: "60bf972c461eba00018bc537", name: "Ismael Romero Nieto", title: "Global Data & Analytics Product Owner for TikTok Shop", email: "ismael.romeronieto@loreal.com", linkedin_url: "http://www.linkedin.com/in/ismaelromeronieto", note: "TikTok Shop data/analytics product owner, Madrid; useful for intro to the TikTok Shop team · email verified" },
  ] },
  { seller_id: "8649779932573702695", company: "PRETTYCARE", domain: "prettycarelife.com", apollo_org_id: "64e7176a42d8e000a3f8173b", contacts: [
    { apollo_id: "65abca7bc755490001dd1ea6", name: "Loura Rowe", title: "Agency Manager", email: null, linkedin_url: "http://www.linkedin.com/in/loura-rowe-571a62279", note: "Agency Manager (likely affiliate/agency partnerships), US; match is plausible (vacuum brand, HK HQ) but unverified · email unavailable" },
    { apollo_id: "6925753f28dfb200013464a4", name: "Guozhu Chen", title: "Foreign Trade Manager", email: null, linkedin_url: "http://www.linkedin.com/in/%e5%9b%bd%e6%9f%b1-%e9%99%88-405428175", note: "Foreign trade manager, Foshan · email unavailable" },
  ] },
  { seller_id: "7495835666377836835", company: "Aigostar", domain: "aigostar.com", apollo_org_id: "61ec6097d3c3e3000168cd83", contacts: [
    { apollo_id: "54a2b4b37468693825b44d37", name: "Yindi Pang", title: "E-Commerce Director", email: null, linkedin_url: "http://www.linkedin.com/in/yindi-pang-43aa0230", note: "E-Commerce Director, Madrid · email unavailable" },
    { apollo_id: "608c0348b83a5e0001ed3826", name: "Gerardo Maestro", title: "Key Account Manager España y Portugal en Aigostar y Nobleza", email: "gerardo.maestro@aigostar.com", linkedin_url: "http://www.linkedin.com/in/gerardomaestrolobo", note: "Sales/KAM Spain & Portugal, Madrid · email verified" },
    { apollo_id: "67c260d2ea92040001cd9d98", name: "Vanessa Zhuang", title: "Brand Manager", email: "vanessazhuang@aigostar.com", linkedin_url: "http://www.linkedin.com/in/vanessa-zhuang-25436b154", note: "Brand Manager / Manager of Sales, Rotterdam (Europe) · email verified" },
    { apollo_id: "62fb061843c5fd0001be81d3", name: "Lin Bifang", title: "Managing Director", email: null, linkedin_url: "http://www.linkedin.com/in/lin-bifang-a61292245", note: "Managing Director Aigostar & Nobleza, Fuzhou · email unavailable" },
  ] },
  { seller_id: "7495863410767267902", company: "1990s", domain: "1990s.es", apollo_org_id: "6852402a058a2d00012e25ce", contacts: [
  ] },
  { seller_id: "7495866134124464548", company: "Aosom España (Aosom)", domain: "aosom.es", apollo_org_id: "69e2fe2ebc12be0001486f65", contacts: [
    { apollo_id: "61174fca3fdd940001c9314d", name: "Sergi Cunill", title: "Head of eCommerce Sales & Digital Marketing", email: null, linkedin_url: "http://www.linkedin.com/in/sergi-cunill-77655842", note: "Head of eCommerce Sales & Digital Marketing, Aosom España (Vic, Barcelona) · email unavailable" },
    { apollo_id: "607ff42be5b20100011f49ac", name: "Judit Febrer", title: "Responsable de Marketing en Aosom", email: null, linkedin_url: "http://www.linkedin.com/in/judit-febrer-69a93140", note: "Marketing lead, Aosom (global org aosom.com, id 5d35475da3ae618c3b88efda), Barcelona · email unavailable" },
  ] },
  { seller_id: "7496201090740553830", company: "ISEE HAIR", domain: "iseehair.com", apollo_org_id: "66d948ad7a61940001ea9ea0", contacts: [
  ] },
  { seller_id: "8648556814322014934", company: "APR Corporation (medicube)", domain: "apr-in.com", apollo_org_id: "5c988873b873a80b11956546", contacts: [
    { apollo_id: "63eab2075d95ab00017d982d", name: "Jaehee Shim", title: "TikTok Shop MKT Lead", email: null, linkedin_url: "http://www.linkedin.com/in/jaehee-shim-4862a0249", note: "TikTok Shop marketing lead (Seoul HQ), no Europe-based staff in Apollo · email unavailable" },
    { apollo_id: "6429853a13c17a000110cc18", name: "Danhee Kim", title: "Global Marketing", email: null, linkedin_url: "http://www.linkedin.com/in/danhee-kim-623072265", note: "Global marketing / K-beauty PR (Seoul) · email unavailable" },
    { apollo_id: "67b3009bc29fe700017dd272", name: "Jiyeon Lee", title: "Global Marketing", email: null, linkedin_url: "http://www.linkedin.com/in/jiyeon-lee-8798402bb", note: "Global marketing (Seoul) · email unavailable" },
  ] },
  { seller_id: "8647412015075728275", company: "Dreame Technology", domain: "dreametech.com", apollo_org_id: "5da55cab65f378000193d35a", contacts: [
    { apollo_id: "65e021b3e45f7c0001c127f2", name: "Xiaoxi Luo", title: "Country Manager France", email: null, linkedin_url: "http://www.linkedin.com/in/xiaoxi-c%c3%a9cile-luo-59b3108a", note: "Country Manager France · email unavailable" },
    { apollo_id: "67303c851fe13c00014e2910", name: "Yuki Yu", title: "E-Commerce Operation and Sales Manager", email: null, linkedin_url: "http://www.linkedin.com/in/yuki-yu-a0aa95158", note: "E-commerce ops & sales (UK-based, Europe) · email unavailable" },
    { apollo_id: "5e63276c27cdc9000141fd5e", name: "Gregory Hackiere", title: "Head of Sales France - DIY", email: null, linkedin_url: "http://www.linkedin.com/in/gregory-hackiere-76920312a", note: "Head of Sales France · email unavailable" },
    { apollo_id: "54a4b0e37468692cf0128e5b", name: "Elodie Thuret", title: "PR Manager France & Benelux", email: "elodiethuret@dreame.tech", linkedin_url: "http://www.linkedin.com/in/elodie-thuret-350949a6", note: "PR Manager France & Benelux · email verified" },
  ] },
  { seller_id: "8647465436750190694", company: "VEVOR", domain: "vevor.com", apollo_org_id: "65bb5cdca6509600010b2a62", contacts: [
    { apollo_id: "63fefa2c92f90100016736ca", name: "Juan Xie", title: "Cross-border E-commerce Operations Manager", email: null, linkedin_url: "http://www.linkedin.com/in/%e5%a8%9f-%e8%b0%a2-196ab4203", note: "Cross-border e-commerce ops (Shanghai) · email unavailable" },
    { apollo_id: "6107955b0edcf600018585fd", name: "Domi Chang", title: "Affiliate Marketing Manager", email: null, linkedin_url: "http://www.linkedin.com/in/domi-chang-0baa82166", note: "Affiliate marketing manager · email unavailable" },
    { apollo_id: "6570ef27e9631200019e2fc3", name: "Yolanda Song", title: "Sr. Director of Partner Development", email: "affiliate@vevor.com", linkedin_url: "http://www.linkedin.com/in/yolanda-song-900b66129", note: "Sr Director Partner Development (marketing team); email is a shared affiliate inbox · email verified" },
    { apollo_id: "6925979ceee8ab00012293ca", name: "Jiping Qiu", title: "Social Media Channel Manager", email: null, linkedin_url: "http://www.linkedin.com/in/%e7%ba%aa%e5%b9%b3-%e9%82%b1-256637118", note: "Social media channel manager · email unavailable" },
  ] },
  { seller_id: "8648947726060723127", company: "Halara", domain: "halara.com", apollo_org_id: "5fca5542192d410001300928", contacts: [
    { apollo_id: "5f30a88ef02f100001041da4", name: "Chuhe Taylor", title: "Ecommerce Manager - TikTok Live", email: null, linkedin_url: "http://www.linkedin.com/in/chuhe-taylor-b726b819b", note: "TikTok Live e-commerce manager (LA); no Europe staff in Apollo · email unavailable" },
    { apollo_id: "606f6447633cf900011824cf", name: "Cindy Nalbandyan", title: "Sr. Marketing Manager - Influencer, VIP, & Brand Partnerships", email: "cindy.nalbandyan@halara.com", linkedin_url: "http://www.linkedin.com/in/cindynalbandyan", note: "Influencer & brand partnerships lead (LA) · email verified" },
    { apollo_id: "66ac96d76504d100014008e3", name: "Riley Huang", title: "Affiliate Marketing Manager", email: null, linkedin_url: "http://www.linkedin.com/in/riley-huang-a7aa84206", note: "Affiliate marketing manager (Shanghai) · email unavailable" },
  ] },
  { seller_id: "7496114768666200619", company: "MUSBLANC (luxalia.fr)", domain: "luxalia.fr", apollo_org_id: "6740340b4833c50001a1edc9", contacts: [
  ] },
  { seller_id: "7494210785049478465", company: "Ulefone", domain: "ulefone.com", apollo_org_id: "57c5026aa6da986aaa1751b2", contacts: [
    { apollo_id: "6290cae22c4a6400013cb85a", name: "David Gustavo", title: "Chief Executive Officer", email: null, linkedin_url: "http://www.linkedin.com/in/david-gustavo-2800a9225", note: "CEO · email unavailable" },
    { apollo_id: "66f3e800a2724e0001e1a7b1", name: "Ansen Xiong", title: "Co Founder", email: "ansen.xiong@ulefone.com", linkedin_url: "http://www.linkedin.com/in/ansen-xiong-648696121", note: "Co-founder · email verified" },
    { apollo_id: "665ca8defe71120001e39df1", name: "Lena Cui", title: "Director of Marketing", email: "lena@ulefone.com", linkedin_url: "http://www.linkedin.com/in/lena-cui-b21595136", note: "Director of Marketing · email verified" },
    { apollo_id: "66f78dcc5fbdcd00016fe9f7", name: "Zou Yinmei", title: "Brand Manager", email: null, linkedin_url: "http://www.linkedin.com/in/zou-yinmei-amanda-11743680", note: "Brand Manager · email unavailable" },
  ] },
  { seller_id: "7496124825659083734", company: "La Boutique Anais", domain: "laboutiqueanais.com", apollo_org_id: "6732f1abd7a790000162c0a6", contacts: [
  ] },
  { seller_id: "7494475518662051478", company: "SharkNinja", domain: "sharkninja.com", apollo_org_id: "5da6dea5b07642000121f2df", contacts: [
    { apollo_id: "54aa58e974686923663b6901", name: "Christophe Tavlaridis", title: "Tiktok Shop Lead", email: "christophe.tavlaridis@sharkninja.com", linkedin_url: "http://www.linkedin.com/in/christophe-tavlaridis-73394a21", note: "TikTok Shop Lead (France) · email verified" },
    { apollo_id: "67401b4537531100019f8967", name: "Felix Monnot", title: "E-Commerce Director - DTC & TikTok Shop", email: "fmonnot@sharkninja.com", linkedin_url: "http://www.linkedin.com/in/felix-monnot", note: "E-Commerce Director DTC & TikTok Shop (Paris) · email verified" },
    { apollo_id: "636ce580afde59000155ff26", name: "Matthieu Heynes", title: "Ecommerce Manager - France", email: "mheynes@sharkninja.com", linkedin_url: "http://www.linkedin.com/in/matthieu-heynes", note: "Ecommerce Manager France · email verified" },
    { apollo_id: "6111385a33095a0001b692b8", name: "Thibault Luminet", title: "E-commerce Senior Director", email: "tluminet@sharkninja.com", linkedin_url: "http://www.linkedin.com/in/thibaultluminet", note: "E-commerce Senior Director, SharkNinja France · email verified" },
  ] },
  { seller_id: "8649475935525313103", company: "Versuni (Philips home appliances)", domain: "versuni.com", apollo_org_id: "60954512b1311e00a538ef4c", contacts: [
    { apollo_id: "54a8295574686962202cec63", name: "Laurence Etienne", title: "Managing Director South Europe (France, Iberia, Italy, Greece, Israel)", email: "laurence.etienne@versuni.com", linkedin_url: "http://www.linkedin.com/in/laurence-etienne-b6b04bb", note: "MD South Europe incl. France · email verified" },
    { apollo_id: "652e7d359f819200019fccec", name: "Iryna Kurylo", title: "Consumer Marketing Manager France", email: "irina.kurilo@versuni.com", linkedin_url: "http://www.linkedin.com/in/iryna-kurylo-a2969211a", note: "Consumer Marketing Manager France · email verified" },
    { apollo_id: "63461cc3ab4ebe00013e140d", name: "Guillaume Roi", title: "Marketing Director", email: "guillaume.roi@versuni.com", linkedin_url: "http://www.linkedin.com/in/g-roi", note: "Marketing Director (Paris) · email verified" },
    { apollo_id: "6820bcfbb948080001ec404f", name: "Patrick Lin", title: "E-commerce Support South Europe", email: "patrick.lin@versuni.com", linkedin_url: "http://www.linkedin.com/in/patrick-thl", note: "E-commerce South Europe (Paris) · email verified" },
  ] },
  { seller_id: "8647271672645127198", company: "SONGMICS HOME", domain: "songmicshomeb2b.com", apollo_org_id: "6614e9b19f44770007aed967", contacts: [
    { apollo_id: "60f97a0a7210380001ec4c5d", name: "Yujun Xu", title: "Affiliate Marketing Manager", email: null, linkedin_url: "http://www.linkedin.com/in/yujun-xu-42176b177", note: "Affiliate Marketing Manager (US) · email unavailable" },
    { apollo_id: "5f5af37c15147d000191a5b3", name: "Chantal Li", title: "Head of Social Media and Influencer Relations", email: null, linkedin_url: "http://www.linkedin.com/in/chantal-li-2232aa153", note: "Head of Social Media & Influencer Relations · email unavailable" },
    { apollo_id: "5f4d5e4af6e11d00010ba934", name: "Daisy Wei", title: "Senior Brand Manager", email: null, linkedin_url: "http://www.linkedin.com/in/daisy-wei-34bb28101", note: "Senior Brand Manager (Shenzhen) · email unavailable" },
    { apollo_id: "64d5559b340b2c00011eed55", name: "Taylor Xie", title: "Brand Manager", email: null, linkedin_url: "http://www.linkedin.com/in/taylor-xie-59b4bba5", note: "Brand Manager (Shenzhen) · email unavailable" },
  ] },
  { seller_id: "8647333877768034781", company: "TOPDON", domain: "topdon.com", apollo_org_id: "613e168d5ebded00010b6475", contacts: [
    { apollo_id: "662d26ce71a6bf000735c6c7", name: "Laura Jimenez", title: "Sales Manager", email: "laura@topdon.com", linkedin_url: "http://www.linkedin.com/in/laura-jimenez-tech", note: "Sales Manager, TOPDON EUROPE (Barcelona) · email verified" },
    { apollo_id: "61666bc6b5ce740001e5113d", name: "Lizzie Wang", title: "Marketing Manager", email: "utha@topdon.com", linkedin_url: "http://www.linkedin.com/in/lizzie-wang-8646b588", note: "Marketing Manager · email verified" },
    { apollo_id: "62a79d1267bb930001be22d2", name: "Vivian Tang", title: "Sales Marketing Manager", email: null, linkedin_url: "http://www.linkedin.com/in/vivian-tang-04ab3918b", note: "Sales Marketing Manager · email unavailable" },
  ] },
  { seller_id: "8648556814322080470", company: "APR Corporation (medicube parent)", domain: "apr-in.com", apollo_org_id: "5c988873b873a80b11956546", contacts: [
    { apollo_id: "63eab2075d95ab00017d982d", name: "Jaehee Shim", title: "TikTok Shop MKT Lead", email: null, linkedin_url: "http://www.linkedin.com/in/jaehee-shim-4862a0249", note: "TikTok Shop marketing lead at APR/medicube (Seoul HQ) · email unavailable" },
    { apollo_id: "66ed19d767d6d00001702102", name: "Jeong-Eun Bae", title: "ME/EU Influencer PR", email: null, linkedin_url: "http://www.linkedin.com/in/%eb%b0%b0%ec%a0%95%ec%9d%80-%d9%85%d8%b1%d8%ad-14822528b", note: "Middle East / Europe influencer PR (Seoul HQ) · email unavailable" },
    { apollo_id: "63f62ffaf503de00016a2afa", name: "Joe Cho", title: "Team Lead of Media Relations (North America & Europe)", email: "joe.cho@apr-in.com", linkedin_url: "http://www.linkedin.com/in/joechojc", note: "Media relations lead NA & Europe (Seoul HQ) · email verified" },
    { apollo_id: "67b3009bc29fe700017dd272", name: "Jiyeon Lee", title: "Global Marketing", email: null, linkedin_url: "http://www.linkedin.com/in/jiyeon-lee-8798402bb", note: "Global marketing (Seoul HQ) · email unavailable" },
  ] },
  { seller_id: "8647412029765032851", company: "Dreame Technology", domain: "dreametech.com", apollo_org_id: "5da55cab65f378000193d35a", contacts: [
    { apollo_id: "61282faa22717a00010b7cf1", name: "Jane Wang", title: "Country Manager Italy", email: null, linkedin_url: "http://www.linkedin.com/in/jane-wang-172033196", note: "Country Manager Italy (based London) · email unavailable" },
    { apollo_id: "67303c851fe13c00014e2910", name: "Yuki Yu", title: "E-Commerce Operation and Sales Manager", email: null, linkedin_url: "http://www.linkedin.com/in/yuki-yu-a0aa95158", note: "E-commerce ops & sales manager, Europe (UK-based) · email unavailable" },
    { apollo_id: "54c25e257468697af7ae9792", name: "Ayana Zhumadilova", title: "Brand Marketing Manager", email: null, linkedin_url: "http://www.linkedin.com/in/ayana-zhumadilova-051a0967", note: "Brand marketing manager (Almaty) - lower priority · email unavailable" },
  ] },
  { seller_id: "7494587591343048476", company: "SharkNinja", domain: "sharkninja.com", apollo_org_id: "5da6dea5b07642000121f2df", contacts: [
    { apollo_id: "60fa345e1e793b000171a0d2", name: "Marianna Morena", title: "Ecommerce Manager Italy", email: "mmorena@sharkninja.com", linkedin_url: "http://www.linkedin.com/in/marianna-morena-58b58b16", note: "Ecommerce Manager Italy (Milan) · email verified" },
    { apollo_id: "67401b4537531100019f8967", name: "Felix Monnot", title: "E-Commerce Director - DTC & TikTok Shop", email: "fmonnot@sharkninja.com", linkedin_url: "http://www.linkedin.com/in/felix-monnot", note: "E-Commerce Director DTC & TikTok Shop, Europe (Paris) · email verified" },
    { apollo_id: "54aa58e974686923663b6901", name: "Christophe Tavlaridis", title: "Tiktok Shop Lead", email: "christophe.tavlaridis@sharkninja.com", linkedin_url: "http://www.linkedin.com/in/christophe-tavlaridis-73394a21", note: "TikTok Shop Lead, Europe (Lyon) · email verified" },
    { apollo_id: "6033ca9db1d6ca0001e195ed", name: "Fabiana Magni", title: "Sr. Social Media Content & Influencer Manager", email: "fabiana.magni@sharkninja.com", linkedin_url: "http://www.linkedin.com/in/fabianamagni", note: "Social media & influencer manager Italy (Milan) · email verified" },
  ] },
  { seller_id: "8647465782790166630", company: "VEVOR", domain: "vevor.com", apollo_org_id: "65bb5cdca6509600010b2a62", contacts: [
    { apollo_id: "6570ef27e9631200019e2fc3", name: "Yolanda Song", title: "Sr. Director of Partner Development (Marketing)", email: "affiliate@vevor.com", linkedin_url: "http://www.linkedin.com/in/yolanda-song-900b66129", note: "Partner/affiliate development director (Hong Kong); email is the shared affiliate inbox · email verified" },
    { apollo_id: "6107955b0edcf600018585fd", name: "Domi Chang", title: "Affiliate Marketing Manager", email: null, linkedin_url: "http://www.linkedin.com/in/domi-chang-0baa82166", note: "Affiliate marketing manager (China) · email unavailable" },
    { apollo_id: "63fefa2c92f90100016736ca", name: "Juan Xie", title: "Cross-border E-commerce Operations Manager", email: null, linkedin_url: "http://www.linkedin.com/in/%e5%a8%9f-%e8%b0%a2-196ab4203", note: "Cross-border e-commerce ops manager (Shanghai) · email unavailable" },
    { apollo_id: "6925979ceee8ab00012293ca", name: "Jiping Qiu", title: "Social Media Channel Manager", email: null, linkedin_url: "http://www.linkedin.com/in/%e7%ba%aa%e5%b9%b3-%e9%82%b1-256637118", note: "Social media channel manager (Shenzhen) · email unavailable" },
  ] },
  { seller_id: "8647333875949607343", company: "Aldous Bio", domain: "aldousbio.com", apollo_org_id: "5e56331f1dcc380001cd7187", contacts: [
    { apollo_id: "68c1ce9232641a0001017b48", name: "Antonio Pellon Huelamo", title: "CEO & Founder", email: "antonio.pellon@aldousbio.com", linkedin_url: "http://www.linkedin.com/in/antoniopellonhuelamo", note: "CEO & Founder (Spain HQ) · email verified" },
    { apollo_id: "64a602856c5f59000189fcdc", name: "Karyna Klachyk", title: "Social Commerce Manager", email: "karyna.klachyk@aldousbio.com", linkedin_url: "http://www.linkedin.com/in/karyna-klachyk", note: "Social Commerce Manager, runs EU/UK TikTok Shop · email verified" },
    { apollo_id: "611f0aea49148a0001b6c85d", name: "Monica Gras Trinidad", title: "CMO", email: "monica.gras@aldousbio.com", linkedin_url: "http://www.linkedin.com/in/m%c3%b3nicagrastrinidad", note: "CMO · email verified" },
    { apollo_id: "612b974cc358fc000134d2fa", name: "Gonzalo Sarabia", title: "International Sales Manager", email: "gonzalo.sarabia@aldousbio.com", linkedin_url: "http://www.linkedin.com/in/gonzalo-sarabia", note: "International Sales Manager (ex online sales director) · email verified" },
  ] },
  { seller_id: "8648820787889871394", company: "Insta360", domain: "insta360.com", apollo_org_id: "56e3249ff3e5bb2eaf006e9c", contacts: [
    { apollo_id: "61b8568f62d33200018dabb8", name: "Philipp Dreyer", title: "Director of Partnerships Europe", email: "philipp.dreyer@insta360.com", linkedin_url: "http://www.linkedin.com/in/philipp-dreyer", note: "Director of Partnerships Europe (Germany) · email verified" },
    { apollo_id: "603196ee6fbe9f00015b30b3", name: "Giulia Sabato", title: "Marketing Manager for Italy", email: "giulia@insta360.com", linkedin_url: "http://www.linkedin.com/in/giulia-sab%c3%a0to-72871730", note: "Marketing Manager Italy · email verified" },
    { apollo_id: "64f94c0a310e34000114f7d0", name: "Daniel Mueller", title: "Marketing Manager", email: "danielmuller@insta360.com", linkedin_url: "http://www.linkedin.com/in/daniel-m%c3%bcller-359b97239", note: "Marketing Manager Europe (Berlin) · email verified" },
  ] },
  { seller_id: "7496100599137602478", company: "AVILIA Group", domain: "aviliagroup.it", apollo_org_id: "61ec4e7ca241f3000184b18e", contacts: [
    { apollo_id: "651a9c1b888f1d0001204b03", name: "Vincenzo Avilia", title: "AD", email: null, linkedin_url: "http://www.linkedin.com/in/vincenzo-avilia-826721238", note: "Amministratore Delegato, Avilia Group · email unavailable" },
    { apollo_id: "66f506ddb8b672000191b0d5", name: "Francesco Avilia", title: "Board Member", email: "francescoavilia@aviliagroup.it", linkedin_url: "http://www.linkedin.com/in/francesco-avilia-0244a4120", note: "Board member (owner family) · email verified" },
    { apollo_id: "63493cc42785340001c4eab8", name: "Fabio Avilia", title: "Marketing Specialist", email: "fabioavilia@aviliagroup.it", linkedin_url: "http://www.linkedin.com/in/fabio-avilia-850b5a1b8", note: "Marketing (owner family) · email verified" },
  ] },
  { seller_id: "7496189771657742360", company: "GeDi Group SRL", domain: "gedishop.it", apollo_org_id: "66898f747ebc9f0001348396", contacts: [
    { apollo_id: "5ad56eb6a6da98673cb3d35b", name: "Giuseppe Agoretti", title: "Founder", email: null, linkedin_url: "http://www.linkedin.com/in/giuseppe-agoretti-8047b082", note: "Founder of GeDi Shop (Naples) · email unavailable" },
  ] },
  { seller_id: "7494433150569645671", company: "Beper", domain: "beper.com", apollo_org_id: "55f5c2d5f3e5bb17a2002c1a", contacts: [
    { apollo_id: "66f9b5db61199700016f0656", name: "Gianluca Bosetto", title: "President", email: "g.bosetto@beper.com", linkedin_url: "http://www.linkedin.com/in/beper", note: "President / owner · email verified" },
    { apollo_id: "66f5f500c5abd3000168e0f9", name: "Samantha Bosetto", title: "Brand Manager", email: "s.bosetto@beper.com", linkedin_url: "http://www.linkedin.com/in/samantha-bosetto", note: "Brand Manager (owner family) · email verified" },
    { apollo_id: "66f9d23e61199700017bc24e", name: "Margherita Falsiroli", title: "Web Content & Social Media Manager", email: null, linkedin_url: "http://www.linkedin.com/in/margherita-falsiroli-a46b9b7a", note: "Web content & social media manager · email unavailable" },
  ] },
  { seller_id: "7496262949893736527", company: "Coffeina - cialde e capsule caffe", domain: "coffeina.it", apollo_org_id: "640e70e1a39f5b0001ee4fa0", contacts: [
  ] },
  { seller_id: "7496138579921635932", company: "SUPERTOP Supermercati", domain: "supertopsupermercati.it", apollo_org_id: "678c741ecfd959000115d83a", contacts: [
  ] },
  { seller_id: "7496047005540322107", company: "SharkNinja", domain: "sharkninja.com", apollo_org_id: "5da6dea5b07642000121f2df", contacts: [
    { apollo_id: "54c29ef67468697af70164b1", name: "Sam Proctor", title: "Senior Director, E-Commerce", email: "sproctor@sharkninja.com", linkedin_url: "http://www.linkedin.com/in/sam-proctor-022874a2", note: "Senior Director E-Commerce, SharkNinja UK (Cleckheaton) · email verified" },
    { apollo_id: "5d4d627380f93ebd6baff0b3", name: "Caitlin Maclean", title: "Senior Manager, Social Commerce Affiliates", email: "caitlin.maclean@sharkninja.com", linkedin_url: "http://www.linkedin.com/in/caitlinmaclean", note: "Social commerce / affiliates lead, SharkNinja UK (Glasgow) · email verified" },
    { apollo_id: "5b8da02b324d445a42a0c10a", name: "Katie Burton", title: "Senior Manager, Beauty Social Lead", email: "katie.burton@sharkninja.com", linkedin_url: "http://www.linkedin.com/in/katie-burton-3b3215152", note: "Shark Beauty social lead UK (London) - relevant to sharkbeautyuk handle · email verified" },
    { apollo_id: "613ad5564aa4fc0001378f32", name: "Erin Sharp", title: "Senior Digital Marketplace Manager", email: "esharp@sharkninja.com", linkedin_url: "http://www.linkedin.com/in/erin-sharp-068878199", note: "Senior Digital Marketplace Manager, SharkNinja UK (Harrogate) · email verified" },
  ] },
  { seller_id: "7494683660387060475", company: "SharkNinja", domain: "sharkninja.com", apollo_org_id: "5da6dea5b07642000121f2df", contacts: [
    { apollo_id: "54c29ef67468697af70164b1", name: "Sam Proctor", title: "Senior Director, E-Commerce", email: "sproctor@sharkninja.com", linkedin_url: "http://www.linkedin.com/in/sam-proctor-022874a2", note: "Senior Director E-Commerce, SharkNinja UK (Cleckheaton) · email verified" },
    { apollo_id: "5d4d627380f93ebd6baff0b3", name: "Caitlin Maclean", title: "Senior Manager, Social Commerce Affiliates", email: "caitlin.maclean@sharkninja.com", linkedin_url: "http://www.linkedin.com/in/caitlinmaclean", note: "Social commerce / affiliates lead, SharkNinja UK (Glasgow) · email verified" },
    { apollo_id: "6198a34cfc571e0001b796e1", name: "Oliver Harras", title: "E-Commerce Manager", email: "oharras@sharkninja.com", linkedin_url: "http://www.linkedin.com/in/oliver-h-000909206", note: "E-Commerce Manager, SharkNinja UK (Leeds) · email verified" },
    { apollo_id: "67012a0c222a8100014129d0", name: "Olivia Rostron", title: "Online Marketplace Manager", email: "olivia.rostron@sharkninja.com", linkedin_url: "http://www.linkedin.com/in/olivia-rostron", note: "Online Marketplace Manager, SharkNinja UK · email verified" },
  ] },
  { seller_id: "7494608413204122336", company: "PL Makeup Academy", domain: "plmakeupacademy.com", apollo_org_id: "66f01129b92f6e00012c0c5b", contacts: [
  ] },
  { seller_id: "7496099247909472498", company: "Halara", domain: "halara.com", apollo_org_id: "5fca5542192d410001300928", contacts: [
    { apollo_id: "606f6447633cf900011824cf", name: "Cindy Nalbandyan", title: "Sr. Marketing Manager - Influencer, VIP, & Brand Partnerships", email: "cindy.nalbandyan@halara.com", linkedin_url: "http://www.linkedin.com/in/cindynalbandyan", note: "Influencer & brand partnerships lead (US HQ, Los Angeles) · email verified" },
    { apollo_id: "5f30a88ef02f100001041da4", name: "Chuhe Taylor", title: "Ecommerce Manager - TikTok Live", email: null, linkedin_url: "http://www.linkedin.com/in/chuhe-taylor-b726b819b", note: "TikTok Live e-commerce manager (Los Angeles) - LinkedIn only · email unavailable" },
    { apollo_id: "684590211fb2e800012387ba", name: "Joyce Zhang", title: "Founder & CEO", email: null, linkedin_url: "http://www.linkedin.com/in/joyce-zhang-7a5784", note: "Founder & CEO - LinkedIn only · email unavailable" },
    { apollo_id: "66ac96d76504d100014008e3", name: "Riley Huang", title: "Affiliate Marketing Manager", email: null, linkedin_url: "http://www.linkedin.com/in/riley-huang-a7aa84206", note: "Affiliate marketing manager (Shanghai) - LinkedIn only · email unavailable" },
  ] },
  { seller_id: "7495918771470502637", company: "Halara", domain: "halara.com", apollo_org_id: "5fca5542192d410001300928", contacts: [
    { apollo_id: "606f6447633cf900011824cf", name: "Cindy Nalbandyan", title: "Sr. Marketing Manager - Influencer, VIP, & Brand Partnerships", email: "cindy.nalbandyan@halara.com", linkedin_url: "http://www.linkedin.com/in/cindynalbandyan", note: "Influencer & brand partnerships lead (US HQ, Los Angeles) · email verified" },
    { apollo_id: "5f30a88ef02f100001041da4", name: "Chuhe Taylor", title: "Ecommerce Manager - TikTok Live", email: null, linkedin_url: "http://www.linkedin.com/in/chuhe-taylor-b726b819b", note: "TikTok Live e-commerce manager (Los Angeles) - LinkedIn only · email unavailable" },
    { apollo_id: "684590211fb2e800012387ba", name: "Joyce Zhang", title: "Founder & CEO", email: null, linkedin_url: "http://www.linkedin.com/in/joyce-zhang-7a5784", note: "Founder & CEO - LinkedIn only · email unavailable" },
    { apollo_id: "66ac96d76504d100014008e3", name: "Riley Huang", title: "Affiliate Marketing Manager", email: null, linkedin_url: "http://www.linkedin.com/in/riley-huang-a7aa84206", note: "Affiliate marketing manager (Shanghai) - LinkedIn only · email unavailable" },
  ] },
  { seller_id: "7495800853072349547", company: "BellaVita (Bella Vita Organic / Luxury, India)", domain: "bellavitaorganic.com", apollo_org_id: "64b10316e7ddaa00018dbdf8", contacts: [
    { apollo_id: "5f73fafbd097d20001116083", name: "Rohan Saraf", title: "Commercial Director", email: "rohan.saraf@bellavitauae.com", linkedin_url: "http://www.linkedin.com/in/rohan-saraf-0887b212", note: "Commercial Director, international (UAE arm) · email verified" },
    { apollo_id: "5d60fa6da3ae613fcdf2d5cb", name: "Rohit Bhakuni", title: "Marketplace Manager", email: null, linkedin_url: "http://www.linkedin.com/in/rohit-singh-bhakuni-93bb29146", note: "Marketplace Manager (India HQ) - LinkedIn only · email unavailable" },
    { apollo_id: "630358e77b78de0001b9041c", name: "Neha Chawla", title: "Ecommerce Manager", email: null, linkedin_url: "http://www.linkedin.com/in/neha-chawla-348409239", note: "Ecommerce Manager (India HQ) - LinkedIn only · email unavailable" },
    { apollo_id: "683d83081ebe4f0001e5bc60", name: "Aman Mishra", title: "Creative Marketing Director", email: "aman.mishra@idamwellness.com", linkedin_url: "http://www.linkedin.com/in/aman--mishra-", note: "Creative Marketing Director (parent Idam Wellness, India) · email verified" },
  ] },
  { seller_id: "7494477044510853251", company: "Online Home Shop", domain: "onlinehomeshop.com", apollo_org_id: "604a7b79ee3e5900016b6730", contacts: [
    { apollo_id: "65e8303ed982ea0007721b72", name: "Moshe Cohen", title: "CEO", email: "moshe@onlinehomeshop.com", linkedin_url: "http://www.linkedin.com/in/moshe-cohen-3853a146", note: "CEO · email verified" },
    { apollo_id: "6700136af4c7410001c6c35b", name: "Christopher Stone", title: "Head of eCommerce and Digital", email: null, linkedin_url: "http://www.linkedin.com/in/christopher-stone-14513059", note: "Head of eCommerce & Digital - LinkedIn only · email unavailable" },
    { apollo_id: "66fb3bd50ae236000131f0b1", name: "Gary Brook", title: "Ecommerce Manager", email: "gary@onlinehomeshop.com", linkedin_url: "http://www.linkedin.com/in/garybrook", note: "Ecommerce Manager (Manchester) · email verified" },
    { apollo_id: "611bdec60029090001e6723e", name: "Ian Harrison", title: "Chief Marketing Officer (CMO)", email: "ian@onlinehomeshop.com", linkedin_url: "http://www.linkedin.com/in/iaharrison", note: "CMO (Manchester) · email verified" },
  ] },
  { seller_id: "7496100358311676717", company: "PUFFIT", domain: "puffit.com", apollo_org_id: "671719fc555e68000123f384", contacts: [
    { apollo_id: "643e67dc94e65700011cc172", name: "Lindi Qi", title: "Influencer Marketing Manager", email: null, linkedin_url: "http://www.linkedin.com/in/lindi-qi-880912b4", note: "Influencer Marketing Manager, UK - LinkedIn only (only 2 people at org; other is a Live Host) · email unavailable" },
  ] },
  { seller_id: "7494548121986763046", company: "Made by Mitchell", domain: "madebymitchell.co.uk", apollo_org_id: "61727d008ff8c300a4cd0069", contacts: [
    { apollo_id: "66f278a5d715e00001afb9fe", name: "Gabrielle Grierson", title: "Head of Social Commerce & Creator/Influencer Relations", email: null, linkedin_url: "http://www.linkedin.com/in/gabrielle-grierson-316a97254", note: "Head of Social Commerce & Creator Relations (Liverpool) - LinkedIn only · email unavailable" },
    { apollo_id: "66f14e8e62d5340001317de2", name: "Mitchell Halliday", title: "Founder", email: "mitchell@madebymitchell.co.uk", linkedin_url: "http://www.linkedin.com/in/mitchell-halliday-749065228", note: "Founder · email verified" },
    { apollo_id: "631f0ab6808d22000172ae62", name: "Sean Kelly", title: "Commercial Manager", email: "sean@madebymitchell.co.uk", linkedin_url: "http://www.linkedin.com/in/sean-kelly-aa7209211", note: "Commercial Manager · email verified" },
  ] },
  { seller_id: "7494981884491762531", company: "Straame", domain: "straame.com", apollo_org_id: "60acd61f17f4be00a43d1ca5", contacts: [
  ] },
  { seller_id: "7495694615892363469", company: "EGO OFFICIAL", domain: "ego.co.uk", apollo_org_id: "5a9e506ca6da98d93ee0b851", contacts: [
    { apollo_id: "629504f213a4e80001d156b4", name: "Lauren Doherty", title: "Senior Paid Social & TikTok Affiliate Manager", email: "lauren.doherty@ego.co.uk", linkedin_url: "http://www.linkedin.com/in/lauren-doherty-382b2b153", note: "TikTok affiliate lead (Manchester) · email verified" },
    { apollo_id: "60fb0c07353db10001755c56", name: "Dan O'Reilly", title: "Head of Ecommerce", email: "daniel.oreilly@ego.co.uk", linkedin_url: "http://www.linkedin.com/in/dan-oreilly-ecommerce", note: "Head of Ecommerce (Manchester) · email verified" },
    { apollo_id: "61143655217a590001b196b0", name: "Usman Riaz", title: "Co Founder and Managing Director", email: "usman@ego.co.uk", linkedin_url: "http://www.linkedin.com/in/usman-riaz", note: "Co-founder & MD · email verified" },
    { apollo_id: "66f151171b6c5a000129f9b9", name: "Hannah McFarlane", title: "Head of Marketing", email: "hannah.mcfarlane@ego.co.uk", linkedin_url: "http://www.linkedin.com/in/hannah-mcfarlane-8847b765", note: "Head of Marketing · email verified" },
  ] },
  { seller_id: "7496052564698762045", company: "QVC UK Ltd.", domain: "qvcuk.com", apollo_org_id: "664ef6deee4fef00015e0997", contacts: [
    { apollo_id: "611d265254a6e20001519804", name: "Robyn Cooke", title: "Director of Social Commerce", email: "robyn.cooke@qvc.com", linkedin_url: "http://www.linkedin.com/in/robyn-cooke-9783125b", note: "Director of Social Commerce, QVC UK (London) · email verified" },
    { apollo_id: "55dcaccbf3e5bb37930015d4", name: "Chandni Sood", title: "Head of Ecommerce", email: null, linkedin_url: "http://www.linkedin.com/in/chandni-sood-93160846", note: "Head of Ecommerce, QVC UK - LinkedIn only · email unavailable" },
    { apollo_id: "54a32c7b7468693cdde7f259", name: "Hanna Smith", title: "Social Media Manager", email: null, linkedin_url: "http://www.linkedin.com/in/hanna-rose-smith-3a810a45", note: "Social Media Manager, QVC UK - LinkedIn only · email unavailable" },
  ] },
  { seller_id: "7495946411494640638", company: "DECIEM | The Abnormal Beauty Company", domain: "deciem.com", apollo_org_id: "54a1a47b7468694012392b04", contacts: [
    { apollo_id: "60639e051b4e74000132f2ac", name: "Frances Leonard", title: "Senior Manager, Social Commerce - UK + AMEA", email: "fleonard@deciem.com", linkedin_url: "http://www.linkedin.com/in/frances-leonard", note: "Social Commerce lead UK + AMEA · email verified" },
    { apollo_id: "614e9dd0b408820001fb20c6", name: "Aris Ng", title: "Associate Manager, Social Commerce, UK & EMEA", email: "ang2@deciem.com", linkedin_url: "http://www.linkedin.com/in/arisng", note: "Social Commerce UK & EMEA (London) · email verified" },
    { apollo_id: "66f9ff2ed1c6fd0001883b8c", name: "Maria Heneghan", title: "Director of Partnerships, UK & Ireland", email: "mhe@deciem.com", linkedin_url: "http://www.linkedin.com/in/maria-heneghan-78543b148", note: "Director of Partnerships UK & Ireland (London) · email verified" },
    { apollo_id: "60a8d324c4b224000112363a", name: "Sarah Thompson", title: "Acting Head of Partnerships", email: "sth@deciem.com", linkedin_url: "http://www.linkedin.com/in/sarah-thompson-58591315", note: "Acting Head of Partnerships, UK · email verified" },
  ] },
  { seller_id: "7496202157693962430", company: "Innovist (parent of Bare Anatomy)", domain: "innovist.com", apollo_org_id: "5da5598b5bff920001b6303f", contacts: [
    { apollo_id: "68b296035603a800015f5303", name: "Rohit Chawla", title: "Founder & CEO", email: "rohit@innovist.com", linkedin_url: "http://www.linkedin.com/in/rchawla", note: "Founder & CEO, Innovist / Bare Anatomy (India) · email verified" },
    { apollo_id: "66f11c69edcade00014366be", name: "Sifat Khurana", title: "Co-Founder & Chief Marketing Officer", email: "sifat@bareanatomy.com", linkedin_url: "http://www.linkedin.com/in/sifatkhurana", note: "Co-founder & CMO (bareanatomy.com email) · email verified" },
    { apollo_id: "649d9af7f3223500015d014b", name: "Yukta Jain", title: "Ecommerce Manager", email: "yukta@bareanatomy.com", linkedin_url: "http://www.linkedin.com/in/yukta-jain-65261b245", note: "Ecommerce Manager (bareanatomy.com email) · email verified" },
    { apollo_id: "5f5d195ecd2c91000175f96b", name: "Ekansh Mathur", title: "Manager - Influencer Marketing", email: "ekansh@onestolabs.com", linkedin_url: "http://www.linkedin.com/in/ekanshmathur", note: "Influencer Marketing Manager (email on sister-brand domain onestolabs.com) · email verified" },
  ] },
  { seller_id: "7496147334275566468", company: "Crocs, Inc.", domain: "crocs.com", apollo_org_id: "54a135dd69702d425501d500", contacts: [
    { apollo_id: "57d87443a6da984683011faa", name: "Antonela Grippo", title: "Head of UK Marketing and Digital Commerce EMEA", email: "agrippo@crocs.com", linkedin_url: "http://www.linkedin.com/in/agrippo", note: "Head of UK Marketing & Digital Commerce EMEA (NL-based) · email verified" },
    { apollo_id: "6558fae2bb887d00014b1b2f", name: "Victoria Chazal", title: "Digital Distributors Manager - EMEA & Latam", email: "vchazal@crocs.com", linkedin_url: "http://www.linkedin.com/in/victoria-chazal", note: "Digital distributors / marketplaces EMEA · email verified" },
    { apollo_id: "66fb695359b0010001de4553", name: "Scott Lucas", title: "UK & Ireland Managing Director", email: null, linkedin_url: "http://www.linkedin.com/in/scottlucas2009", note: "UK & Ireland MD (Ipswich) - LinkedIn only · email unavailable" },
    { apollo_id: "66fbbb812a16c200012cc45b", name: "Leila Hassan", title: "Marketing Manager UK", email: null, linkedin_url: "http://www.linkedin.com/in/leilaalihassan", note: "Marketing Manager UK - LinkedIn only · email unavailable" },
  ] },
  { seller_id: "7496106835003738774", company: "KatchMe", domain: "katchme.com", apollo_org_id: "5e55e8aae8c29100019057d1", contacts: [
    { apollo_id: "6099de753e17c700017977f1", name: "Jenny Fung", title: "Deputy Manager", email: null, linkedin_url: "http://www.linkedin.com/in/jenny-fung-8a86581a9", note: "Deputy Manager (Manchester) - most senior person listed; LinkedIn only · email unavailable" },
    { apollo_id: "64302549ac166a00013a5986", name: "Xiaoying Huang", title: "Digital Marketing", email: null, linkedin_url: "http://www.linkedin.com/in/xiaoying-huang-151473181", note: "Digital Marketing (Manchester) - LinkedIn only · email unavailable" },
    { apollo_id: "68dbdb9008dfa400016fc196", name: "Jane Chong", title: "Creator & Affiliate Executive", email: null, linkedin_url: "http://www.linkedin.com/in/jane-chong-635a68236", note: "TikTok creator & affiliate executive (Manchester) - LinkedIn only · email unavailable" },
  ] },
  { seller_id: "7495314598416255768", company: "Vax", domain: "vax.co.uk", apollo_org_id: "54a12a2c69702da2201bf501", contacts: [
    { apollo_id: "54a3b9117468692cf09e9c0d", name: "Phil Kallitsakis", title: "Creative and Brand Lead", email: "pkallitsakis@vax.co.uk", linkedin_url: "http://www.linkedin.com/in/phil-kallitsakis-515458a6", note: "Creative & Brand Lead · email verified" },
    { apollo_id: "61174e5d3fdd940001c92a3d", name: "Mark Shapiro", title: "Head of Marketing Communications", email: null, linkedin_url: "http://www.linkedin.com/in/mark-shapiro-40902317", note: "Head of Marketing Communications - LinkedIn only · email unavailable" },
    { apollo_id: "5d612c8af65125f68d4bb3b0", name: "Harriet Jones", title: "Head of Social Media", email: null, linkedin_url: "http://www.linkedin.com/in/harriet-j-0553635a", note: "Head of Social Media - LinkedIn only · email unavailable" },
    { apollo_id: "636bec76bf6d5f0001985102", name: "Charlee Painter", title: "Paid Social Media Manager", email: null, linkedin_url: "http://www.linkedin.com/in/charleepainter", note: "Paid Social Media Manager - LinkedIn only · email unavailable" },
  ] },
  { seller_id: "7494684671938037907", company: "Spectrum Brands (UK) Limited", domain: "spectrumbrands.co.uk", apollo_org_id: "5e56a4be1501e50001eaf649", contacts: [
    { apollo_id: "57d8c08da6da987232758ae2", name: "Claire Whalley-Livesey", title: "Managing Director", email: "claire.whalley-livesey@eu.spectrumbrands.com", linkedin_url: "http://www.linkedin.com/in/claire-whalley-livesey-3533122b", note: "Managing Director, Spectrum Brands UK · email verified" },
    { apollo_id: "67dd81107b8d3e0001e3fc8c", name: "Louise Bruchez", title: "Director of Digital Marketing", email: "louise.bruchez@eu.spectrumbrands.com", linkedin_url: "http://www.linkedin.com/in/louise-bruchez", note: "Director of Digital Marketing UK · email verified" },
    { apollo_id: "5fcf41c97598bf0001b888ff", name: "Caroline Clark", title: "Global Snr. Director Brand and Product Marketing Remington", email: "caroline.clark@eu.spectrumbrands.com", linkedin_url: "http://www.linkedin.com/in/caroline-clark-33a07912", note: "Global Senior Director Brand & Product Marketing, Remington (UK-based) · email verified" },
    { apollo_id: "602fc288a6e14f0001b98b77", name: "Natalie Carney", title: "Senior Brand Manager", email: "natalie.carney@eu.spectrumbrands.com", linkedin_url: "http://www.linkedin.com/in/nataliecarney", note: "Senior Brand Manager, Personal Care (ex Remington EMEA brand manager) · email verified" },
  ] },
];
