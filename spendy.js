const DB_NAME = 'spendy';
const STORE = 'expenses';
// Muted editorial data-viz palette — desaturated greens/clays/indigos/ochres that sit quietly
// against the warm-monochrome shell (charts + category dots draw from this in order).
const NICE_COLORS = ['#2f7d4f','#bd5a3a','#5b58c4','#b5852a','#3f8f93','#9a5b8e','#6f7d3a','#c27a4e','#4f6bb0','#8a6f54','#5aa07a','#a4524a','#7a6cae','#5e8a4c','#b08a3e','#6b6f78'];

// Suggested categories shown in the Add/Edit dropdown even before any such record exists.
// (User asked for invest categories to be pre-seeded "for later"; income/expense get sensible defaults too.)
const INVEST_CATS = ['Savings','Gold','Stocks','Crypto','Fund','Real estate'];
const INCOME_CATS = ['Salary','Freelance','Bonus','Interest','Gift','Other'];
const EXPENSE_CATS = ['Groceries','Dining Out','Coffee','Transport','Bills & Utilities','Shopping','Entertainment','Health','Education','Pets','Other','Uncategorized'];
// Default 50/30/20 bucket for each seeded expense category — used only to pre-fill the classifier
// (guessBucket); never written to disk, so it can't override the user's own choices. 'Other' /
// 'Uncategorized' are intentionally left unclassified.
// Migration note (do these manually via Settings → Categories): rename Fixed Costs → "Bills & Utilities",
// Pet → "Pets", Debt → "Debt & Loans"; split "Food & Drinks" into "Groceries" / "Dining Out" by hand.
const SEED_BUCKET = {
  'Groceries':'need','Dining Out':'want','Coffee':'want','Transport':'need','Bills & Utilities':'need',
  'Shopping':'want','Entertainment':'want','Health':'need','Education':'need','Pets':'want'
};

// The Overview "card" now shows your real pinned card (Settings → My cards), not cosmetic constants.
// Pick which saved card is featured with the ★ pin in Settings; see getPinnedCard / renderBalanceCard.

// Overview "Saving Plans": seed plans shown until the user edits/adds their own (persisted in meta 'plans').
const DEFAULT_PLANS = [
  { id: 'seed-1', name: 'Emergency Fund', icon: '🛟', saved: 5000000,  target: 10000000,  color: '#22c55e' },
  { id: 'seed-2', name: 'Travel Fund',  icon: '✈️', saved: 3000000,  target: 5000000,   color: '#14b8a6' },
  { id: 'seed-3', name: 'Buy a House',      icon: '🏠', saved: 72500000, target: 200000000, color: '#3b82f6' },
];

// --- 50/30/20 rule ---
// Bucket targets as % of monthly income: Thiết yếu 50 · Mong muốn 30 · Tiết kiệm 20.
// `catClass` only ever tags expense categories as 'need' or 'want'; the 'save' bucket is derived
// (income base − total spending), so it is never stored on a category.
const FIFTY_TARGET = { need: 50, want: 30, save: 20 };
const BUCKET_LABEL = { need: 'Needs', want: 'Wants', save: 'Savings' };
const BUCKET_COLOR = { need: '#4f6bb0', want: '#b5852a', save: '#2f7d4f' };

// Keyword groups for guessing a transaction's bucket and a better-fitting category from its name.
// Order matters: put more specific groups (e.g. food delivery → want) before broader ones.
// `kw` = substrings matched (accent-insensitive, see norm()) against a transaction/category name;
// `cat` = canonical tokens used to find an existing category that fits the group.
const KW_GROUPS = [
  { key:'food_delivery', bucket:'want', cat:['giao đồ ăn','đồ ăn','đặt đồ'], kw:['grabfood','grab food','shopeefood','shopee food','baemin','beamin','gojek food','foody','đặt đồ ăn','giao đồ ăn'] },
  { key:'coffee', bucket:'want', cat:['cà phê','cafe','coffee','trà sữa'], kw:['cà phê','ca phe','cafe','coffee','highlands','starbucks','trà sữa','tra sua','milk tea','gong cha','phúc long','phuc long','the coffee'] },
  // Note: tones are stripped before matching, so avoid keywords that become homographs of other words
  // (e.g. 'quán'→'quan' collides with 'quần' áo; 'giày'→'giay' collides with 'giấy'). Such tokens are omitted.
  { key:'dining', bucket:'want', cat:['ăn ngoài','nhà hàng','ăn uống','dining out','dining'], kw:['nhà hàng','nha hang','restaurant','quán ăn','quan an','lẩu','nướng','nuong','buffet','kfc','lotteria','mcdonald','jollibee','pizza','gà rán','ga ran','ăn ngoài','an ngoai'] },
  { key:'booze', bucket:'want', cat:['bia rượu','nhậu'], kw:['bia','beer','rượu','ruou','pub','nhậu','nhau','cocktail'] },
  { key:'shopping', bucket:'want', cat:['mua sắm','shopping','quần áo','thời trang'], kw:['shopee','lazada','tiki','sendo','mua sắm','mua sam','shopping','quần áo','quan ao','giày dép','túi xách','mỹ phẩm','my pham','thời trang','thoi trang','tiktok shop'] },
  { key:'entertain', bucket:'want', cat:['giải trí','phim','xem phim','entertainment'], kw:['phim','cinema','cgv','lotte cinema','galaxy cine','game','steam','netflix','spotify','youtube premium','disney','karaoke','vé phim','ve phim'] },
  { key:'travel', bucket:'want', cat:['du lịch','travel'], kw:['du lịch','du lich','travel','vé máy bay','ve may bay','khách sạn','khach san','hotel','resort','booking','airbnb','agoda','tour '] },
  { key:'rent', bucket:'need', cat:['tiền nhà','thuê nhà','nhà ở','rent'], kw:['tiền nhà','tien nha','thuê nhà','thue nha','thuê phòng','thue phong','tiền trọ','tien tro','chung cư','chung cu','tiền cọc nhà'] },
  { key:'utilities', bucket:'need', cat:['hoá đơn','tiện ích','điện nước','bills & utilities','bills','utilities'], kw:['tiền điện','tien dien','tiền nước','tien nuoc','hoá đơn','hoa don','internet','wifi','fpt','viettel','vnpt','truyền hình','truyen hinh','tiền gas','tien gas','tiền điện thoại','tien dien thoai','cước điện thoại','cuoc dien thoai','nạp điện thoại','nap dien thoai','nạp tiền điện thoại','nap tien dien thoai'] },
  { key:'transport', bucket:'need', cat:['đi lại','xăng xe','di chuyển','transport'], kw:['xăng','xang','petrol','đổ xăng','do xang','grab bike','grabbike','grab car','grabcar','xe bus','vé xe','ve xe','gửi xe','gui xe','parking','bảo dưỡng','bao duong','vé tàu','ve tau','taxi','xe ôm','xe om'] },
  { key:'grocery', bucket:'need', cat:['siêu thị','đi chợ','tạp hoá','thực phẩm','groceries','grocery'], kw:['siêu thị','sieu thi','đi chợ','di cho','tạp hoá','tap hoa','bách hoá','bach hoa','vinmart','winmart','coopmart','co.op','lotte mart','big c','mega market','emart','thực phẩm','thuc pham'] },
  { key:'health', bucket:'need', cat:['y tế','sức khoẻ','thuốc','health'], kw:['thuốc','thuoc','nhà thuốc','nha thuoc','pharmacy','pharmacity','long châu','long chau','bệnh viện','benh vien','hospital','phòng khám','phong kham','nha khoa','xét nghiệm','xet nghiem'] },
  { key:'education', bucket:'need', cat:['học phí','giáo dục','học tập','education'], kw:['học phí','hoc phi','tuition','tiền học','tien hoc','khoá học','khoa hoc','sách giáo','đồ dùng học'] },
  { key:'insurance', bucket:'need', cat:['bảo hiểm','insurance'], kw:['bảo hiểm','bao hiem','insurance','bhyt','bhxh'] },
  { key:'kids', bucket:'need', cat:['con cái','gia đình','em bé','kids'], kw:['tã ','bỉm','bim','sữa bột','sua bot','sữa em bé','đồ chơi trẻ','do choi tre'] },
];

// Lowercase + strip Vietnamese tones so an accent-free entry ("ca phe") still matches "cà phê".
function norm(s) {
  return String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/đ/g, 'd');
}
// First keyword group whose any keyword appears in the (accent-insensitive) name; null if none.
function matchGroup(name) {
  const n = norm(name);
  if (!n) return null;
  for (const g of KW_GROUPS) if (g.kw.some(k => n.includes(norm(k)))) return g;
  return null;
}
// An existing EXPENSE category that fits a group (its name contains a cat-token/keyword); null if none.
function suggestCatForGroup(group, excludeCat) {
  let cats = allData.filter(isExpense).map(d => d.category)
    .concat(Object.keys(catReg).filter(c => catReg[c] === 'expense'))
    .concat(EXPENSE_CATS);
  cats = [...new Set(cats)];
  const tokens = (group.cat || []).concat(group.kw).map(norm).filter(Boolean);
  for (const c of cats) {
    if (c === excludeCat) continue;
    const nc = norm(c);
    if (tokens.some(t => nc.includes(t))) return c;
  }
  return null;
}
// Best-guess bucket for a category NAME — checks both cat-tokens and keywords (used to pre-fill the modal).
function guessBucket(catName) {
  if (catName && SEED_BUCKET[catName]) return SEED_BUCKET[catName]; // seeded expense defaults win for exact names
  const nc = norm(catName);
  if (!nc) return null;
  for (const g of KW_GROUPS) {
    const tokens = (g.cat || []).concat(g.kw).map(norm).filter(Boolean);
    if (tokens.some(t => nc.includes(t))) return g.bucket;
  }
  return null;
}

// Per-view (tab) labels/colors. Each "sổ" (ledger) shows only its own type of records.
const VIEW_META = {
  expense: { sổ:'Expenses', emoji:'💸', spentLabel:'Spent',    barTitle:'Monthly Spending',  pieTitle:'By Category', color:'#bd5a3a', amtColor:null,      topLabel:'Top Category', catLabel:'Categories', addLabel:'Add expense',  impLabel:'Import CSV (expenses)' },
  income:  { sổ:'Income', emoji:'💰', spentLabel:'Received', barTitle:'Monthly Income',    pieTitle:'By Source',   color:'#2f7d4f', amtColor:'#2f7d4f', topLabel:'Top Source',   catLabel:'Sources',    addLabel:'Add income',  impLabel:'Import CSV (income)' },
  invest:  { sổ:'Investments',   emoji:'📈', spentLabel:'Invested', barTitle:'Monthly Investing', pieTitle:'By Type',     color:'#5b58c4', amtColor:'#5b58c4', topLabel:'Top Type',     catLabel:'Types',      addLabel:'Add investment', impLabel:'Import CSV (investments)' },
  debts:   { sổ:'Credit Cards', emoji:'💳', spentLabel:'Owed', barTitle:'Monthly', pieTitle:'By Category', color:'#bd5a3a', amtColor:null, topLabel:'Top Category', catLabel:'Categories', addLabel:'Add credit-card expense', impLabel:'Import CSV' },
  overview:{ sổ:'Overview', emoji:'📊', addLabel:'Add transaction', impLabel:'Import CSV' }, // not type-scoped; combines all
  settings:{ sổ:'Settings',  emoji:'⚙️', addLabel:'Add transaction', impLabel:'Import CSV' }, // standalone page, not a ledger
};

let allData = [];
let isLoaded = false;
let view = 'overview';  // current tab/ledger: 'overview' | 'expense' | 'income' | 'invest'
let tableCat = 'all'; // category filter scoped to the table only (independent of charts)
let tableDebtSel = null; // Credit Cards tab: {key, card} selected from the "Remaining owed" panel → filters the table only
let tableSearch = ''; // quick text search scoped to the table (Vietnamese accent-insensitive via norm())
let budgets = {};     // { category: monthlyLimit } — persisted in the IndexedDB 'meta' store
let goal = 0;         // savings target (đ) — persisted in 'meta'; progress = tổng thu − tổng chi
let catClass = {};    // { expenseCategory: 'need' | 'want' } — 50/30/20 bucket per spending category ('meta')
let incomeBase = 0;   // fixed monthly income (đ) used as the 50/30/20 denominator ('meta')
let catReg = {};      // category registry { name: type } in 'meta' — lets user-created/empty categories persist
let plans = null;     // Overview saving plans — array in 'meta'; null until loaded (getPlans() falls back to DEFAULT_PLANS)
let ovStatMode = 'expense'; // Overview statistic doughnut tab: 'income' | 'expense'
let ovYear = 'all';   // Overview cashflow year filter: 'all' | 'YYYY'
let ovFlowMode = 'flow'; // Overview cashflow mode: 'flow' (income vs expense) | 'category' (expense stacked by category)
let ovBudgetsExpanded = false; // Overview Budgets panel: collapsed (top few) vs "Show all" expanded
let notifOpen = false;      // notification dropdown (top toolbar bell) open/closed
let editingPlanId = null;   // id of the saving plan being edited in the plan modal, or null when adding
let debts = [];             // Overview debts list — array in IndexedDB 'meta'
let ccPaidFps = [];         // fingerprints of credit-card transactions ticked "paid" (reminder only; meta 'ccPaidFps')
let ccNoteFps = {};          // { fingerprint: 'YYYY-MM-DD' } confirm note date for credit-card transactions (meta 'ccNoteFps')
let cards = [];             // Saved card details (Settings → My cards) — array in meta 'cards'; stored UNENCRYPTED
let editingCardId = null;   // id of the card being edited in the card modal, or null when adding
let revealedCards = new Set(); // ids of saved cards whose number/CVV are currently revealed (UI only, not persisted)
let pinnedCardId = null;    // id of the card featured on the Overview "card" (meta 'pinnedCard'); null → first card
let editingDebtId = null;   // id of the debt being edited in the debt modal, or null when adding
let ovWidgets = null;       // Overview dashboard layout: [{id, visible}]; null until loaded from meta 'overviewWidgets'

const OV_WIDGET_COLS = {
  left:   ['card','plans','fifty'],
  mid:    ['stats','cashflow','recent'],
  right:  ['stat','budgets','activity'],
};
const DEFAULT_OV_WIDGETS = ['card','plans','fifty','stats','cashflow','recent','stat','budgets','activity'].map(id => ({id, visible: true}));
function getOvWidgets() {
  if (!Array.isArray(ovWidgets) || !ovWidgets.length) return DEFAULT_OV_WIDGETS.slice();
  return ovWidgets.slice();
}
async function persistOvWidgets() {
  const db = await openDB();
  await putMeta(db, 'overviewWidgets', ovWidgets);
  db.close();
}
async function reorderOvWidgets(id, dir) {
  const list = getOvWidgets();
  const i = list.findIndex(w => w.id === id);
  const j = i + (dir === 'up' ? -1 : 1);
  if (i < 0 || j < 0 || j >= list.length) return;
  [list[i], list[j]] = [list[j], list[i]];
  ovWidgets = list;
  await persistOvWidgets();
  renderOvLayoutSettings();
  renderOverview();
  scheduleSyncPush();
}
const monthFilter = document.getElementById('month-filter');
const methodFilter = document.getElementById('method-filter');
const photoFilter = document.getElementById('photo-filter');

const tableWrap = document.getElementById('table-wrap');
const summaryBar = document.getElementById('summary-bar');
const emptyState = document.getElementById('empty-state');
const dashboard = document.getElementById('dashboard');
const toastEl = document.getElementById('toast');
let pieChart, ovChart, ovStatChart;

// Edit/Add modal refs
const overlay = document.getElementById('edit-overlay');
const modalTitle = document.getElementById('modal-title');
const efName = document.getElementById('ef-name');
const efAmount = document.getElementById('ef-amount');
const efType = document.getElementById('ef-type');
const efCategory = document.getElementById('ef-category');
const efCategoryNew = document.getElementById('ef-category-new');
const efDate = document.getElementById('ef-date');
const efMethod = document.getElementById('ef-method');
const efInstall = document.getElementById('ef-install'); // "Trả góp (số tháng)" input
let editingId = null; // id of record being edited, or null when adding a new one
let pendingImage = null; // base64 image for the record being edited/added, or null

// --- IndexedDB ---
function openDB() {
  return new Promise((res, rej) => {
    const req = indexedDB.open(DB_NAME, 2);
    req.onupgradeneeded = e => {
      const db = e.target.result;
      if (!db.objectStoreNames.contains(STORE)) {
        const store = db.createObjectStore(STORE, { keyPath: 'id', autoIncrement: true });
        store.createIndex('fingerprint', 'fingerprint', { unique: true });
      }
      if (!db.objectStoreNames.contains('meta')) {
        db.createObjectStore('meta', { keyPath: 'key' }); // key/value config (e.g. budgets)
      }
    };
    req.onsuccess = e => res(e.target.result);
    req.onerror = e => rej(e.target.error);
    req.onblocked = () => rej(new Error('Database upgrade blocked — close other Spendy tabs and reload')); // otherwise the promise (and every awaited DB op) hangs forever
  });
}

function getMeta(db, key) {
  return new Promise((res, rej) => {
    const req = db.transaction('meta', 'readonly').objectStore('meta').get(key);
    req.onsuccess = () => res(req.result ? req.result.value : null);
    req.onerror = () => rej(req.error);
  });
}
function putMeta(db, key, value) {
  return new Promise((res, rej) => {
    const tx = db.transaction('meta', 'readwrite');
    tx.objectStore('meta').put({ key, value });
    tx.oncomplete = () => res();
    tx.onerror = () => rej(tx.error);
  });
}

function getAll(db) {
  return new Promise((res, rej) => {
    const tx = db.transaction(STORE, 'readonly');
    const req = tx.objectStore(STORE).getAll();
    req.onsuccess = () => res(req.result);
    req.onerror = () => rej(req.error);
  });
}

function getFingerprints(db) {
  return new Promise((res, rej) => {
    const tx = db.transaction(STORE, 'readonly');
    // Iterate the 'fingerprint' index with a KEY cursor so we collect each entry's INDEX key (the fingerprint
    // string). NB: idx.getAllKeys() returns PRIMARY keys (record ids), not the fingerprints — using it here made
    // `existing.has(fingerprint)` a silent no-op across import/restore/sync (dedup then leaned entirely on the
    // unique index throwing on add). The cursor returns the actual fingerprint strings.
    const req = tx.objectStore(STORE).index('fingerprint').openKeyCursor();
    const out = new Set();
    req.onsuccess = () => { const c = req.result; if (c) { out.add(c.key); c.continue(); } else res(out); };
    req.onerror = () => rej(req.error);
  });
}

function putRecord(db, rec) {
  return new Promise((res, rej) => {
    const tx = db.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).put(rec); // put = insert (no id) or update (existing id)
    tx.oncomplete = () => res();
    tx.onabort = () => rej(tx.error || new Error('aborted'));
    tx.onerror = () => rej(tx.error);
  });
}

function deleteRecord(db, id) {
  return new Promise((res, rej) => {
    const tx = db.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).delete(id);
    tx.oncomplete = () => res();
    tx.onerror = () => rej(tx.error);
  });
}

// --- CSV Parsing ---
function parseAmount(s) {
  if (!s) return 0;
  return parseFloat(String(s).replace(/[\$,]/g,'').trim()) || 0;
}
// A Spendy "date" is a calendar day, no time/zone. localDateStr formats a Date from LOCAL components so
// the stored day matches the day the user sees — never via toISOString() (UTC), which rolls the day back
// by one in any timezone ahead of UTC (e.g. UTC+7 Vietnam). See the date-repair note in loadFromDB.
function localDateStr(d) {
  if (!d || isNaN(d.getTime())) return '';
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
}
function parseDate(s) {
  if (s == null || s === '') return null;
  // A bare YYYY-MM-DD must be read as LOCAL midnight: new Date('YYYY-MM-DD') is UTC midnight, which shifts
  // the day in non-UTC zones. Timestamps, ISO datetimes and "March 19, 2026" fall through to new Date().
  if (typeof s === 'string') {
    const m = s.trim().match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (m) return new Date(Number(m[1]), Number(m[2])-1, Number(m[3]));
  }
  const d = new Date(s);
  if (!isNaN(d.getTime())) return d;
  const p = String(s).trim().split(' ');
  if (p.length>=3) { const nd = new Date(`${p[0]} ${p[1].replace(',','')}, ${p[2]}`); return isNaN(nd.getTime())?null:nd; }
  return null;
}
function extractCat(s) {
  if (!s) return 'Uncategorized';
  const i = s.indexOf(' (http');
  return i>0 ? s.substring(0,i).trim() : s.trim();
}
function fingerprint(r) {
  return `${r.name}|${r.amount}|${r.category}|${r.dateStr}`;
}
// Type helpers. A record with no `type` is a legacy expense. Spending views use isExpense only,
// so income and invest records are automatically kept out of "Spent" totals.
function isIncome(d) { return d.type === 'income'; }
function isInvest(d) { return d.type === 'invest'; }
function isDebt(d) { return d.type === 'debt'; } // money owed (credit-card purchase / loan); its own type, kept OUT of spending
function isExpense(d) { return d.type !== 'income' && d.type !== 'invest' && d.type !== 'debt'; }
function typeOf(d) { return isIncome(d) ? 'income' : isInvest(d) ? 'invest' : isDebt(d) ? 'debt' : 'expense'; }
// A payment method that means "a credit card": the generic "Credit Card" OR one of the user's saved card
// labels (Settings → My cards). Lets a transaction record WHICH card it was paid with, via the Method field.
function isCreditCardMethod(m) { return m === 'Credit Card' || getCards().some(c => c.label === m); }
function matchesView(d) {
  if (view === 'income') return isIncome(d);
  if (view === 'invest') return isInvest(d);
  if (view === 'debts') return isCreditCardMethod(d.method) || isDebt(d); // Credit Cards ledger = paid by any credit card (generic or a named card) + legacy debt-type records
  return isExpense(d);
}

// Build a stored record from already-parsed fields (shared by CSV import and the edit/add form).
function makeRecord({ name, amount, category, method, date, type, image = null, installments = null }) {
  const dateStr = date ? localDateStr(date) : ''; // LOCAL day — never toISOString() (UTC) which rolls back a day in zones ahead of UTC
  const amt = Math.abs(Number(amount) || 0); // amount is always stored positive; `type` carries direction
  // monthKey/monthLabel derive FROM dateStr, so a record's month bucket always matches the day it displays.
  const mk = dateStr ? dateStr.slice(0,7) : 'Unknown';
  return {
    name,
    amount: amt,
    type: (type === 'income' || type === 'invest' || type === 'debt') ? type : 'expense',
    category,
    date: date ? date.getTime() : null,
    dateStr,
    monthKey: mk,
    monthLabel: dateStr ? new Date(Number(dateStr.slice(0,4)), Number(dateStr.slice(5,7))-1, 1).toLocaleString('en-US',{month:'long',year:'numeric'}) : 'Unknown',
    method: method || '',
    fingerprint: fingerprint({ name, amount: amt, category, dateStr }),
    image: image || null,
    // Installment plan: N≥2 means this single purchase is paid over N statement cycles. The record stays ONE row
    // (full amount, original date, original name); the "Remaining owed" panel virtualizes the N monthly portions.
    // NOT part of fingerprint — editing the plan never breaks dedup.
    installments: (Number(installments) >= 2) ? Math.floor(Number(installments)) : null
  };
}
// `defaultType` is the importing tab's type — used when a row carries no explicit Type column
// (e.g. a Notion income export has none, so importing it from the Thu nhập tab tags every row income).
function processRow(r, defaultType) {
  const raw = parseAmount(r.Amount);
  const tagged = String(r.Type || '').trim().toLowerCase();
  let type;
  if (tagged === 'income' || tagged === 'expense' || tagged === 'invest' || tagged === 'debt') type = tagged; // explicit wins (incl. 'debt' — keeps CSV round-trip idempotent for credit-card debts)
  else if (raw < 0) type = 'income';        // legacy: a negative amount means income
  else type = defaultType || 'expense';     // otherwise fall back to the tab's type
  return makeRecord({
    name: (r.Name||'').trim(),
    amount: raw,
    category: extractCat(r.Categories),
    method: (r['Payment Method']||'').trim(),
    date: parseDate(r.Date),
    type
  });
}

// --- Toast ---
let toastTimer;
function toast(msg, type='info') {
  clearTimeout(toastTimer);
  toastEl.textContent = msg;
  toastEl.style.borderColor = type==='success' ? 'var(--pos)' : type==='warn' ? 'var(--warn)' : 'var(--border)';
  toastEl.classList.add('show');
  toastTimer = setTimeout(() => toastEl.classList.remove('show'), 3000);
}

// --- Load & Render ---
// One-time migration: collapse legacy split installment rows ("Foo (1/3)","(2/3)","(3/3)") — created by the
// earlier split implementation — back into a single record { name:'Foo', amount: sum, installments: N, earliest
// date }. Conservative: only merges a group where the COMPLETE set 1..N is present and shares method+category,
// so it can't accidentally fold unrelated rows that happen to end in "(k/N)". Returns true if anything merged.
async function mergeLegacyInstallments(db, rows) {
  const SUF = /^(.*?) \((\d+)\/(\d+)\)$/;
  const groups = {};
  for (const r of rows) {
    const m = (r.name || '').match(SUF);
    if (!m) continue;
    const k = Number(m[2]), N = Number(m[3]);
    if (!(N >= 2) || k < 1 || k > N) continue;
    const gk = `${m[1]} ${r.method} ${r.category} ${N}`;
    (groups[gk] || (groups[gk] = { base: m[1], N, method: r.method, category: r.category, parts: [] })).parts.push({ r, k });
  }
  const existing = await getFingerprints(db); // fingerprint strings already in the store
  const seen = new Set();                      // fingerprints this batch will create
  const paidSet = new Set((await getMeta(db, 'ccPaidFps')) || []); // carry "paid" ticks from split rows → merged keys
  const cardsList = (await getMeta(db, 'cards')) || [];            // to mirror paidKeysFor's card-cycle logic (global `cards` isn't loaded yet here)
  const newPaid = []; let paidChanged = false;
  const toDelete = [], toAdd = [];
  for (const g of Object.values(groups)) {
    if (g.parts.length !== g.N) continue;
    const ks = new Set(g.parts.map(p => p.k));
    let full = ks.size === g.N;
    for (let i = 1; i <= g.N && full; i++) if (!ks.has(i)) full = false;
    if (!full) continue;
    g.parts.sort((a, b) => a.k - b.k);
    const first = g.parts[0].r;
    const total = g.parts.reduce((s, p) => s + (Number(p.r.amount) || 0), 0);
    const rec = makeRecord({ name: g.base, amount: total, category: g.category, method: g.method,
      date: first.date != null ? new Date(first.date) : parseDate(first.dateStr), type: first.type, image: first.image || null, installments: g.N });
    // CRITICAL: only delete the source rows if the merged record can actually be written. If its fingerprint
    // already exists (a pre-existing identical row, or another group in this batch), a ConstraintError on add
    // would be swallowed — deleting the parts with no replacement = silent data loss. Skip the group instead.
    if (existing.has(rec.fingerprint) || seen.has(rec.fingerprint)) continue;
    seen.add(rec.fingerprint);
    toAdd.push(rec);
    g.parts.forEach(p => toDelete.push(p.r.id));
    // Carry split-row "paid" ticks onto the merged record, mirroring paidKeysFor(rec): per-period #k keys ONLY when
    // the merged record has a statement cycle (a saved card with statementDay); otherwise the bare fingerprint, and
    // only if EVERY part was paid (the bare key represents the whole debt as one unit).
    const paidParts = g.parts.filter(p => paidSet.has(p.r.fingerprint));
    if (paidParts.length) {
      paidParts.forEach(p => paidSet.delete(p.r.fingerprint));
      paidChanged = true;
      const periods = installmentPeriods(rec, cardsList.find(x => x.label === rec.method));
      if (periods) paidParts.forEach(p => newPaid.push(`${rec.fingerprint}#${p.k}`));
      else if (paidParts.length === g.N) newPaid.push(rec.fingerprint);
    }
  }
  if (!toAdd.length) return false;
  const tx = db.transaction(STORE, 'readwrite'); const store = tx.objectStore(STORE);
  toDelete.forEach(id => store.delete(id));
  let added = 0;
  toAdd.forEach(r => { const rq = store.add(r); rq.onsuccess = () => added++; rq.onerror = e => { if (rq.error && rq.error.name === 'ConstraintError') e.preventDefault(); }; });
  await new Promise((res, rej) => { tx.oncomplete = res; tx.onabort = () => rej(tx.error || new Error('transaction aborted')); });
  if (added) setTimeout(() => toast(`Gộp ${added} khoản trả góp thành dòng đơn`, 'success'), 800);
  if (added && paidChanged) await putMeta(db, 'ccPaidFps', [...new Set([...paidSet, ...newPaid])]); // loadFromDB reads this back right after
  return added > 0;
}
async function loadFromDB() {
  const db = await openDB();
  let rows = await getAll(db);
  // One-time merge of legacy SPLIT installments ("Name (k/N)" rows) back into one record carrying `installments`.
  if (!(await getMeta(db, 'mergedInstallments'))) {
    const did = await mergeLegacyInstallments(db, rows);
    await putMeta(db, 'mergedInstallments', true);
    if (did) rows = await getAll(db);
  }
  budgets = (await getMeta(db, 'budgets')) || {};
  goal = (await getMeta(db, 'goal')) || 0;
  catClass = (await getMeta(db, 'catClass')) || {};
  incomeBase = (await getMeta(db, 'incomeBase')) || 0;
  catReg = (await getMeta(db, 'cats')) || {};
  plans = (await getMeta(db, 'plans')) || null; // null → getPlans() shows DEFAULT_PLANS until edited
  debts = (await getMeta(db, 'debts')) || [];
  ccPaidFps = (await getMeta(db, 'ccPaidFps')) || [];
  ccNoteFps = (await getMeta(db, 'ccNoteFps')) || {};
  cards = (await getMeta(db, 'cards')) || [];
  pinnedCardId = (await getMeta(db, 'pinnedCard')) || null;
  const rawWidgets = await getMeta(db, 'overviewWidgets');
  if (Array.isArray(rawWidgets) && rawWidgets.length === DEFAULT_OV_WIDGETS.length && rawWidgets.every(w => w && w.id && typeof w.visible === 'boolean')) ovWidgets = rawWidgets;
  else ovWidgets = DEFAULT_OV_WIDGETS.map(w => ({ ...w }));
  // One-time date repair (idempotent). Older imports parsed non-ISO dates like Notion's "March 19, 2026"
  // as LOCAL midnight, then derived dateStr via toISOString() (UTC) — rolling the day back by one in any
  // timezone ahead of UTC (e.g. UTC+7 Vietnam). The stored `date` INSTANT is correct (it is local midnight
  // of the intended day), so we recover the true calendar day from it and realign dateStr / monthKey /
  // monthLabel / fingerprint. Re-deriving from the same instant is stable, so this is a no-op once fixed.
  const mLabel = mk => new Date(Number(mk.slice(0,4)), Number(mk.slice(5,7))-1, 1).toLocaleString('en-US',{month:'long',year:'numeric'});
  const repairs = [];
  const fpRemap = {}; // old→new fingerprint for date-repaired records, to carry ccPaidFps paid-state across the change
  for (const r of rows) {
    const instant = r.date != null ? new Date(r.date) : null;
    const correct = (instant && !isNaN(instant.getTime())) ? localDateStr(instant) : null;
    if (correct && r.dateStr && correct !== r.dateStr) {
      const oldFp = r.fingerprint;
      r.dateStr = correct;
      r.monthKey = correct.slice(0,7);
      r.monthLabel = mLabel(r.monthKey);
      r.fingerprint = fingerprint({ name: r.name, amount: r.amount, category: r.category, dateStr: correct });
      if (oldFp !== r.fingerprint) fpRemap[oldFp] = r.fingerprint;
      repairs.push(r);
    } else if (r.dateStr && r.monthKey !== r.dateStr.slice(0,7)) {
      r.monthKey = r.dateStr.slice(0,7);            // dateStr already correct; just realign legacy month skew
      r.monthLabel = mLabel(r.monthKey);
      repairs.push(r);
    }
  }
  // Apply highest-day-first: the shift is a uniform +1 day, so writing later days before earlier ones keeps
  // a record from transiently colliding (on the unique fingerprint index) with the still-unshifted dup of a
  // same-name neighbour one day later. A genuine duplicate (an import that lands on the exact day of a
  // hand-entered row) hits the index — we skip it (stays 1 day off) rather than dropping data.
  repairs.sort((a, b) => (a.dateStr < b.dateStr ? 1 : a.dateStr > b.dateStr ? -1 : 0));
  let dateFixed = 0, dateSkipped = 0;
  for (const r of repairs) {
    try { await putRecord(db, r); dateFixed++; }
    catch (e) { dateSkipped++; console.warn('date repair skipped (dup fingerprint?):', r.name, r.dateStr, e && e.name); }
  }
  if (dateFixed) setTimeout(() => toast(`Realigned dates on ${dateFixed} transaction(s)${dateSkipped ? ` · ${dateSkipped} skipped as duplicates` : ''}`, 'success'), 700);
  // Date repair changed some fingerprints; ccPaidFps keys (fingerprint or fingerprint#k) must follow so a paid credit-card charge stays paid.
  if (Array.isArray(ccPaidFps) && ccPaidFps.length && Object.keys(fpRemap).length) {
    let ccChanged = false;
    const remapped = ccPaidFps.map(k => {
      if (fpRemap[k]) { ccChanged = true; return fpRemap[k]; }              // bare fingerprint (also matches names containing '#')
      const m = k.match(/^(.*)#(\d+)$/);                                    // installment period key: fingerprint#k (k is digits; dateStr has no '#')
      if (m && fpRemap[m[1]]) { ccChanged = true; return fpRemap[m[1]] + '#' + m[2]; }
      return k;
    });
    if (ccChanged) { ccPaidFps = [...new Set(remapped)]; await putMeta(db, 'ccPaidFps', ccPaidFps); }
  }
  allData = rows.map(r => ({
    ...r,
    date: r.date ? new Date(r.date) : null
  }));
  allData.sort((a,b) => (b.date||0)-(a.date||0));
  rebuild();
  db.close();
}

function rebuild() {
  const settingsView = document.getElementById('settings-view');
  const debtsView = document.getElementById('debts-view');
  if (view === 'settings') {
    emptyState.style.display = 'none';
    dashboard.style.display = 'none';
    if (debtsView) debtsView.style.display = 'none';
    settingsView.style.display = 'block';
    if (allData.length) buildFilters();
    renderSettings();
    return;
  }
  if (debtsView) debtsView.style.display = 'none';
  settingsView.style.display = 'none';
  if (allData.length === 0) {
    emptyState.style.display = 'block';
    dashboard.style.display = 'none';
    return;
  }
  emptyState.style.display = 'none';
  dashboard.style.display = 'block';
  buildFilters();
  render();
}

// Switch ledgers (tabs) or the Settings page. rebuild() does the actual display routing.
function setView(v) {
  if (!VIEW_META[v]) return;
  view = v;
  // Tear down charts from the previous view so they don't linger (bound to a now-hidden canvas + its
  // ResizeObserver) after switching tabs; the destination view recreates only the charts it needs.
  if (pieChart) { pieChart.destroy(); pieChart = null; }
  if (ovChart) { ovChart.destroy(); ovChart = null; }
  if (ovStatChart) { ovStatChart.destroy(); ovStatChart = null; }
  tableCat = 'all';
  tableSearch = '';
  tableDebtSel = null; // clear the per-card table filter when switching tabs
  document.querySelectorAll('.nav-btn').forEach(b => b.classList.toggle('active', b.dataset.view === v));
  document.getElementById('add-label').textContent = VIEW_META[v].addLabel;
  document.getElementById('import-label').textContent = VIEW_META[v].impLabel;
  rebuild(); // central router: empty-state / dashboard / settings + buildFilters + render
}

// ignoreMonth: skip the month filter — used for the "Remaining owed" panel, a cross-statement-cycle view whose
// installment portions legitimately span months beyond the purchase month (month-filtering would hide owed money).
function getFiltered(ignoreMonth, ignorePmPf) {
  const m = monthFilter.value;
  const pm = methodFilter.value;
  const pf = photoFilter.value;
  return allData.filter(d => {
    if (!matchesView(d)) return false;           // current tab's type only
    if (!ignoreMonth && m !== 'all' && d.monthKey !== m) return false;
    if (!ignorePmPf && pm !== 'all' && (d.method || '') !== pm) return false;   // ignorePmPf: the "Remaining owed" panel must show ALL outstanding debt
    if (!ignorePmPf && pf === 'yes' && !d.image) return false;
    if (!ignorePmPf && pf === 'no' && d.image) return false;
    return true;
  });
}

// Generic aggregation over an already-filtered (single-type) dataset.
function aggregate(data) {
  const total = data.reduce((s,d)=>s+d.amount,0);
  const count = data.length;
  const byCat = {};
  data.forEach(d => byCat[d.category] = (byCat[d.category]||0) + d.amount);
  const catEntries = Object.entries(byCat).sort((a,b)=>b[1]-a[1]);
  const byMonth = {};
  data.forEach(d => byMonth[d.monthKey] = (byMonth[d.monthKey]||0) + d.amount);
  const monthEntries = Object.entries(byMonth).sort((a,b)=>a[0].localeCompare(b[0]));
  const avg = monthEntries.length > 0 ? total / monthEntries.length : total;
  return { total, count, avg, catEntries, monthEntries };
}

// Breakdown list shown under the doughnut: top categories with their % share, plus a merged "Khác" row.
// Colours line up with the doughnut slices (same NICE_COLORS index). Rows click through to onPick (table filter).
function renderCatBreakdown(agg, onPick) {
  const box = document.getElementById('cat-breakdown');
  if (!box) return;
  if (!agg.catEntries.length) { box.innerHTML = ''; return; }
  const total = agg.total || 1;
  const TOPN = 6;
  const topEntries = agg.catEntries.slice(0, TOPN);
  const rest = agg.catEntries.slice(TOPN);
  const restSum = rest.reduce((s, e) => s + e[1], 0);
  let html = topEntries.map(([cat, amt], i) => {
    const color = NICE_COLORS[i % NICE_COLORS.length];
    const pct = (amt / total * 100).toFixed(0);
    const active = (cat === tableCat) ? ' active' : '';
    return `<div class="cb-row${active}" data-cat="${esc(cat)}"><span class="cb-dot" style="background:${color}"></span><span class="cb-name">${esc(cat)}</span><span class="cb-amt">${fmt(amt)}</span><span class="cb-pct">${pct}%</span></div>`;
  }).join('');
  if (restSum > 0) {
    html += `<div class="cb-row" style="cursor:default"><span class="cb-dot" style="background:#9ca3af"></span><span class="cb-name">Other (${rest.length})</span><span class="cb-amt">${fmt(restSum)}</span><span class="cb-pct">${(restSum / total * 100).toFixed(0)}%</span></div>`;
  }
  box.innerHTML = html;
  box.querySelectorAll('.cb-row[data-cat]').forEach(row => row.addEventListener('click', () => onPick(row.dataset.cat)));
}

// Debts/Credit-Cards side panel — replaces the "By Category" doughnut. Shows only what's STILL owed:
// transactions ticked Paid (ccPaidFps) drop out entirely. Remaining credit-card txns are grouped by WHICH
// card paid them (the Method field — a saved card label, else generic "Credit Card"); person/loan debts
// (type 'debt') are listed by transaction name. Display-only — the table below is where you drill in.
function renderDebtTotals(data) {
  const box = document.getElementById('cat-breakdown');
  if (!box) return;
  const groups = {};
  // Add one owed "portion" to its group, unless that exact portion has been ticked paid. `paidKey` is the
  // record fingerprint for a whole txn, or `${fingerprint}#${k}` for installment period k.
  const addItem = (key, label, due, color, card, sel, amount, paidKey) => {
    if (ccPaidFps.includes(paidKey)) return;
    const g = groups[key] || (groups[key] = { label, due, card, color, sel, amount: 0, count: 0, fps: [] });
    g.amount += amount; g.count++; g.fps.push(paidKey);
    if (due && (!g.due || due.getTime() < g.due.getTime())) g.due = due;
  };
  data.forEach(d => {
    if (isDebt(d)) {                                       // person/loan debt → one row PER NAME: same-name debts merge into one owed total (tick settles the whole group)
      addItem('p:' + (d.name || '(unnamed)'), d.name || '(unnamed)', null, null, false, { kind: 'person', name: d.name || '(unnamed)' }, d.amount, d.fingerprint);
      return;
    }
    const c = getCards().find(x => x.label === d.method);
    const color = (c && c.color) || '#bd5a3a';
    const periods = installmentPeriods(d, c);             // installment plan → one portion per statement month
    if (periods) {
      periods.forEach(p => addItem(`c:${d.method}:${p.ym}`, `${d.method} · tháng ${p.monthNum}`, p.due, color, true, { kind: 'cycle', method: d.method, ym: p.ym }, p.amount, `${d.fingerprint}#${p.k}`));
      return;
    }
    const cyc = c ? statementCycle(d.dateStr, c) : null;  // single credit-card txn: place in its own cycle
    if (cyc) addItem(`c:${d.method}:${cyc.ym}`, `${d.method} · tháng ${cyc.monthNum}`, cyc.due, color, true, { kind: 'cycle', method: d.method, ym: cyc.ym }, d.amount, d.fingerprint);
    else { const m = d.method || 'Credit Card'; addItem('c:' + m, m, null, color, true, { kind: 'card', method: m }, d.amount, d.fingerprint); }
  });
  if (!Object.keys(groups).length) { box.innerHTML = `<div class="dt-empty">Nothing owed — all settled. 🎉</div>`; return; }
  // Sort by due date (soonest first; undated groups last), then by amount.
  const entries = Object.entries(groups).sort((a, b) =>
    ((a[1].due ? a[1].due.getTime() : Infinity) - (b[1].due ? b[1].due.getTime() : Infinity)) || (b[1].amount - a[1].amount));
  box.innerHTML = entries.map(([key, g], i) => {
    const color = g.color || NICE_COLORS[(i + 1) % NICE_COLORS.length];
    const icon = g.card ? '💳 ' : '';
    const count = g.count > 1 ? `<span class="dt-count">${g.count} txn</span>` : '';
    const active = tableDebtSel && tableDebtSel.key === key ? ' active' : '';
    let dueLine = '';
    if (g.due) {
      const dd = daysFromToday(g.due);
      const dm = `${String(g.due.getDate()).padStart(2,'0')}/${String(g.due.getMonth()+1).padStart(2,'0')}`;
      const cd = dd === 0 ? 'hôm nay' : dd > 0 ? `còn ${dd} ngày` : `quá hạn ${-dd} ngày`;
      dueLine = `<div class="dt-due${dd <= 3 ? ' urgent' : ''}">Hạn ${dm} · ${cd}</div>`;
    }
    return `<div class="dt-row${active}" data-i="${i}" title="Bấm để lọc bảng theo nhóm này (bấm lại để bỏ)">
      <button class="dt-tick" data-i="${i}" title="Đánh dấu trả cả nhóm">○</button>
      <span class="dt-dot" style="background:${color}"></span>
      <span class="dt-main"><span class="dt-name">${icon}${esc(g.label)}${count}</span>${dueLine}</span>
      <span class="dt-amt">${fmt(g.amount)}</span>
    </div>`;
  }).join('');
  // Tick the ○ → mark EVERY still-unpaid txn in that group paid at once (stopPropagation so it doesn't filter).
  box.querySelectorAll('.dt-tick').forEach(btn => {
    btn.addEventListener('click', e => { e.stopPropagation(); markDebtGroupPaid(entries[Number(btn.dataset.i)][1].fps); });
  });
  // Click the row → filter the table to that group's transactions (toggle off if already selected).
  box.querySelectorAll('.dt-row').forEach(row => {
    row.addEventListener('click', () => {
      const [key, g] = entries[Number(row.dataset.i)];
      tableDebtSel = (tableDebtSel && tableDebtSel.key === key) ? null : { key, sel: g.sel };
      render();
    });
  });
}

// Mark a whole debt group settled: add all its fingerprints to ccPaidFps (the same set the per-row table
// ticks use), persist, re-render. To un-settle, untick individual rows in the table below.
async function markDebtGroupPaid(fps) {
  if (!fps || !fps.length) return;
  if (!Array.isArray(ccPaidFps)) ccPaidFps = [];
  const set = new Set(ccPaidFps);
  fps.forEach(fp => set.add(fp));
  ccPaidFps = [...set];
  const db = await openDB();
  await putMeta(db, 'ccPaidFps', ccPaidFps);
  db.close();
  toast(`Marked ${fps.length} transaction(s) paid`, 'success');
  render();
  scheduleSyncPush();
}

function render() {
  renderNotifications(); // toolbar bell lives in the shared page-head — keep it fresh on every view
  if (view === 'settings') { renderSettings(); return; }
  if (view === 'overview') { renderOverview(); return; }
  document.getElementById('ledger-view').style.display = 'block';
  document.getElementById('overview-view').style.display = 'none';
  if (document.getElementById('debts-view')) document.getElementById('debts-view').style.display = 'none';

  document.getElementById('search-controls').style.display = 'contents';
  document.getElementById('method-controls').style.display = 'contents';
  document.getElementById('photo-controls').style.display = 'contents';
  document.getElementById('table-search').value = tableSearch;
  const meta = VIEW_META[view];
  const data = getFiltered();
  const agg = aggregate(data);

  document.getElementById('view-title').innerHTML = `<span class="em">${meta.emoji}</span>${meta.sổ}`;

  // Clicking a category on the doughnut / breakdown filters the table to it (click again to clear).
  function pickCat(cat) {
    if (!window.tcf) return;
    window.tcf(tableCat === cat ? 'all' : cat);
    tableWrap.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }

  summaryBar.textContent = data.length
    ? `${data.length} transactions`
    : `No records in this ledger yet — click “${meta.addLabel}” or open Settings to import.`;

  // Side panel. Credit Cards tab: an owed-totals list (grouped by card / debtor) instead of a category
  // doughnut. The other ledgers keep the "By Category" doughnut that doubles as the table's filter.
  const pc = document.getElementById('pie-chart');
  if (pieChart) { pieChart.destroy(); pieChart = null; }
  const dueBar = document.getElementById('card-due-bar');
  if (view === 'debts') {
    pc.style.display = 'none';
    if (dueBar) dueBar.innerHTML = getCards().map(c => cardDueBadge(c)).join(''); // statement/due reminders atop the panel
    document.getElementById('pie-title').innerHTML = `Remaining owed`;
    renderDebtTotals(getFiltered(true, true)); // panel spans ALL months AND ignores method/photo filters (installments owe beyond the purchase month)
  } else {
  if (dueBar) dueBar.innerHTML = '';
  pc.style.display = '';
  document.getElementById('pie-title').innerHTML = `${meta.pieTitle} <span class="chart-note">· click to filter table</span>`;
  if (agg.catEntries.length) {
    pieChart = new Chart(pc, {
      type: 'doughnut',
      data: {
        labels: agg.catEntries.map(e=>e[0]),
        datasets: [{ data: agg.catEntries.map(e=>e[1]), backgroundColor: agg.catEntries.map((_,i)=>NICE_COLORS[i%NICE_COLORS.length]), borderWidth: 2, borderColor: cssVar('--surface') }]
      },
      options: {
        responsive: true,
        maintainAspectRatio: true,
        cutout: '62%',
        onHover: (e, els) => { if (e.native) e.native.target.style.cursor = els.length ? 'pointer' : 'default'; },
        onClick: (e, els) => { if (els.length) pickCat(agg.catEntries[els[0].index][0]); },
        plugins: {
          legend: { display: false },
          tooltip: { callbacks: { label: ctx => `${ctx.label}: ${fmt(ctx.raw)} (${(ctx.raw/(agg.total||1)*100).toFixed(0)}%)` } }
        }
      },
      // Show the total in the hole of the doughnut (Task 3 — "tâm biểu đồ: hiện tổng số tiền").
      plugins: [{
        id: 'centerText',
        afterDraw(chart) {
          const { ctx, chartArea } = chart;
          if (!chartArea) return;
          const cx = (chartArea.left + chartArea.right) / 2;
          const cy = (chartArea.top + chartArea.bottom) / 2;
          const ff = "'Manrope','SF Pro Display','Helvetica Neue',system-ui,sans-serif";
          ctx.save();
          ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
          ctx.fillStyle = cssVar('--text-3'); ctx.font = `600 11px ${ff}`;
          ctx.fillText(meta.spentLabel, cx, cy - 13);
          ctx.fillStyle = cssVar('--text'); ctx.font = `800 17px ${ff}`;
          ctx.fillText(fmtShort(agg.total), cx, cy + 5);
          ctx.restore();
        }
      }]
    });
  }

  // Category breakdown list under the doughnut — a clickable legend showing each share %.
  renderCatBreakdown(agg, pickCat);
  }

  // Table
  const pageSize = 50;
  let page = 0;
  const catsList = [...new Set(allData.map(d=>d.category))];
  const tableCats = [...new Set(data.map(d=>d.category))].sort();
  if (tableCat !== 'all' && !tableCats.includes(tableCat)) tableCat = 'all'; // drop stale selection
  (function renderTable() {
    const q = norm(tableSearch.trim());
    let td = tableCat === 'all' ? data : data.filter(d => d.category === tableCat);
    // Credit Cards tab: a card / statement-cycle / debtor picked in the "Remaining owed" panel filters the table.
    if (view === 'debts' && tableDebtSel) td = td.filter(d => matchDebtSel(d, tableDebtSel.sel));
    if (q) td = td.filter(d => norm(`${d.name || ''} ${d.category || ''} ${d.method || ''} ${fmtDate(d)} ${d.amount || ''} ${fmt(d.amount)} ${fmtShort(d.amount)}`).includes(q));
    const start = page*pageSize;
    const end = Math.min(start+pageSize, td.length);
    const pd = td.slice(start,end);
    const tp = Math.max(1, Math.ceil(td.length/pageSize));
    const catOpts = ['<option value="all">All Categories</option>']
      .concat(tableCats.map(c => `<option value="${esc(c)}"${c===tableCat?' selected':''}>${esc(c)}</option>`)).join('');
    let html = `<div class="table-bar"><label>Category:</label><select onchange="window.tcf(this.value)">${catOpts}</select><span class="table-bar-count">${td.length} of ${data.length} shown</span></div>`;
    const isDebts = view === 'debts';
    html += `<table><thead><tr><th>#</th><th>Name</th><th>Amount</th><th>Category</th><th>Date</th><th>Method</th><th>Confirm</th>${isDebts ? '<th style="text-align:center">Paid</th>' : ''}</tr></thead><tbody>`;
    const amtStyle = meta.amtColor ? ` style="color:${meta.amtColor}"` : '';
    const sign = meta.amtColor ? '+' : '';
    pd.forEach((d,i) => {
      // Installment record: "paid" only when EVERY period is ticked; the table tick toggles all periods at once.
      // Debt-type records never virtualize (the panel lists them by name) — keep all three paths on paidKeysFor.
      const instPeriods = isDebts && !isDebt(d) && Number(d.installments) >= 2 ? installmentPeriods(d, getCards().find(x => x.label === d.method)) : null;
      // When a statement-month group is selected, the row reflects JUST that period (its (k/N) marker, paid tick,
      // strikethrough) — consistent with toggleCcPaidTxn ticking only that period. Otherwise the whole record.
      const selPeriod = (instPeriods && tableDebtSel && tableDebtSel.sel && tableDebtSel.sel.kind === 'cycle')
        ? instPeriods.find(p => p.ym === tableDebtSel.sel.ym) : null;
      const paid = isDebts && (selPeriod ? ccPaidFps.includes(`${d.fingerprint}#${selPeriod.k}`) : paidKeysFor(d).every(k => ccPaidFps.includes(k)));
      const tickCell = isDebts ? `<td style="text-align:center"><button class="cc-tick${paid ? ' on' : ''}" onclick="event.stopPropagation();window.ccTick(${d.id})" title="${paid ? 'Mark unpaid' : 'Mark paid'}">${paid ? '✓' : '○'}</button></td>` : '';
      const noteDate = isDebts ? (ccNoteFps && ccNoteFps[d.fingerprint]) : null;
      const noteCell = isDebts ? `<td style="text-align:center"><button class="cc-note${noteDate ? ' on' : ''}" onclick="event.stopPropagation();window.ccNote(${d.id})" title="${noteDate ? 'Noted ' + noteDate : 'Confirm sent/received'}">${noteDate ? '✓' : '○'}</button></td>` : '';
      const ci = catsList.indexOf(d.category);
      const cc = NICE_COLORS[ci%NICE_COLORS.length];
      const camIc = d.image ? `<svg class="img-ic" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" title="View photo" onclick="window.viewImage(event, ${d.id})"><rect x="3" y="3" width="18" height="18" rx="2" ry="2"></rect><circle cx="8.5" cy="8.5" r="1.5"></circle><polyline points="21 15 16 10 5 21"></polyline></svg>` : '';
      // Faint (k/N) beside the name only while its statement-month group is selected — the name is never renamed.
      const instBadge = selPeriod ? ` <span class="inst-badge">(${selPeriod.k}/${selPeriod.N})</span>` : '';
      html += `<tr class="${paid ? 'tx-paid' : ''}" onclick="window.editRow(${d.id})" title="Click to edit"><td style="color:var(--text-3)">${start+i+1}</td><td>${esc(d.name)}${instBadge}${camIc}</td><td class="amt"${amtStyle}>${sign}${fmt(d.amount)}</td><td><span class="cat-badge" style="background:${cc}22;color:${cc}">${esc(d.category)}</span></td><td style="color:var(--text-2)">${fmtDate(d)}</td><td style="color:var(--text-3);font-size:11px">${d.method ? esc(d.method) : '—'}</td>${noteCell}${tickCell}</tr>`;
    });
    html += `</tbody></table>`;
    html += `<div class="pagination"><span>${td.length?start+1:0}–${end} of ${td.length}</span><div><button onclick="window.pp()" ${page===0?'disabled':''}>←</button><span style="margin:0 6px">${page+1}/${tp}</span><button onclick="window.np()" ${page>=tp-1?'disabled':''}>→</button></div></div>`;
    window.pp = () => { if(page>0){page--;renderTable();} };
    window.np = () => { if(page<tp-1){page++;renderTable();} };
    window.tcf = (v) => { tableCat = v; page = 0; renderTable(); };
    window.tsf = (v) => { tableSearch = v; page = 0; renderTable(); };
    tableWrap.innerHTML = html;
  })();
}

// Overview = the Ponster 3-column dashboard. Not type-scoped — it combines all three flows.
// The global month filter picks the "focus month" the stat cards / doughnut zoom into; the
// cashflow chart and the lists span every month. renderOverview just orchestrates the panels.
//
// Configurable dashboard: persisted in meta 'overviewWidgets' as [{id, visible}] in display order.
// Each panel in #overview-view is tagged `data-ov-id`; renderOverview applies visibility/order.
function renderOverview() {
  document.getElementById('ledger-view').style.display = 'none';
  document.getElementById('overview-view').style.display = 'block';

  document.getElementById('search-controls').style.display = 'none';
  document.getElementById('method-controls').style.display = 'none';
  document.getElementById('photo-controls').style.display = 'none';
  document.getElementById('view-title').innerHTML = '<span class="em">📊</span>Overview';

  const months = [...new Set(allData.map(d => d.monthKey))].filter(m => m !== 'Unknown').sort();
  const fm = focusMonth() || (months[months.length - 1] || null);
  const sumType = (mk, pred) => allData.reduce((s, d) => s + ((d.monthKey === mk && pred(d)) ? d.amount : 0), 0);

  summaryBar.textContent = fm
    ? `Overview · focus month ${monthKeyLabel(fm)}`
    : 'No data yet — add or import transactions in the ledgers.';

  const layout = getOvWidgets();
  const setVis = (id, on) => {
    const el = document.getElementById(id);
    if (el) el.style.display = on ? '' : 'none';
  };

  // Widget IDs (short) map to HTML element IDs. Use the short widget ID for layout checks.
  const wvis = id => layout.some(w => w.id === id && w.visible);
  if (wvis('card')) renderBalanceCard();
  setVis('balance-card', wvis('card'));
  setVis('saving-plans', wvis('plans'));
  setVis('ov-fifty', wvis('fifty'));
  setVis('ov-cards', wvis('stats'));
  setVis('ov-flow', wvis('cashflow'));
  setVis('recent-tx', wvis('recent'));
  setVis('ov-stat-panel', wvis('stat'));
  setVis('ov-budgets', wvis('budgets'));
  setVis('ov-activity', wvis('activity'));

  if (wvis('plans')) renderSavingPlans();
  if (wvis('fifty')) renderFifty(fm, 'ov-fifty');
  if (wvis('stats')) renderOvStats(fm, sumType);
  if (wvis('cashflow')) renderCashflow(months);
  if (wvis('recent')) renderRecentTx();
  if (wvis('stat')) renderOvStat(fm);
  if (wvis('budgets')) renderBudgets('ov-budgets');
  if (wvis('activity')) renderOvActivity();
}

// Settings page (T1: static data ops). Later phases render the categories manager, budgets,
// 50/30/20 config and misclassification suggestions into this page.
function renderSettings() {
  renderCategoriesManager();
  renderCardsManager();
  renderBudgets('set-budgets', true);   // inline editable + drag-sortable (replaces the old modal)
  renderMisclass('set-misclass');
  renderSyncSettings();
  renderOvLayoutSettings();
  // 50/30/20 status (config via the modal; Need/Want/Save bars show on the Overview tab).
  const exCats = [...new Set(allData.filter(isExpense).map(d => d.category))];
  const classified = exCats.filter(c => catClass[c]).length;
  const st = document.getElementById('set-class-status');
  if (st) st.textContent = `Base income: ${incomeBase > 0 ? fmt(incomeBase) : "(not set — using the month's actual income)"} · classified ${classified}/${exCats.length} expense categories · see Need/Want/Save on the Overview tab.`;
}

// Three stat cards (middle column header): Thu nhập · Chi tiêu · Tiết kiệm for the focus month,
// each with a month-over-month badge. Savings = thu − chi for that month (đầu tư cũng tính là tiết kiệm).
function renderOvStats(fm, sumType) {
  const inc = fm ? sumType(fm, isIncome) : 0;
  const exp = fm ? sumType(fm, isExpense) : 0;
  const sav = inc - exp; // invest is a form of saving, so don't subtract it — consistent with the Overall goal and 50/30/20
  const pm = fm ? prevMonthKey(fm) : null;
  const pInc = pm ? sumType(pm, isIncome) : 0, pExp = pm ? sumType(pm, isExpense) : 0;
  const pSav = pInc - pExp;
  const rate = inc > 0 ? Math.round(sav / inc * 100) : null;
  document.getElementById('ov-cards').innerHTML = `
    <div class="card"><div class="card-top"><span class="card-ico ico-income">💰</span>${momBadge(inc, pInc, true)}</div><div class="value">${fmt(inc)}</div><div class="label">Income</div><div class="sub">${monthName(fm)}</div></div>
    <div class="card"><div class="card-top"><span class="card-ico ico-expense">💸</span>${momBadge(exp, pExp, false)}</div><div class="value">${fmt(exp)}</div><div class="label">Expenses</div><div class="sub">${monthName(fm)}</div></div>
    <div class="card"><div class="card-top"><span class="card-ico ico-save">🪙</span>${momBadge(sav, pSav, true)}</div><div class="value" style="color:${sav >= 0 ? 'var(--c-income)' : 'var(--c-expense)'}">${fmt(sav)}</div><div class="label">Savings</div><div class="sub">${rate != null ? 'saved ' + rate + '% of income' : 'income − expenses'}</div></div>
  `;
}





// Saving plans: a pinned all-time savings goal row (real saved vs goal) above the user's own plans.
function renderSavingPlans() {
  const wrap = document.getElementById('saving-plans');
  const totalInc = allData.reduce((s, d) => s + (isIncome(d) ? d.amount : 0), 0);
  const totalExp = allData.reduce((s, d) => s + (isExpense(d) ? d.amount : 0), 0);
  const saved = totalInc - totalExp;
  let goalRow;
  if (goal > 0) {
    const gp = saved / goal * 100;
    goalRow = planRowHtml({ icon: '🎯', name: 'Overall goal', saved, target: goal, color: gp >= 66 ? '#22c55e' : gp >= 33 ? '#f59e0b' : '#3b82f6' }, 'goal');
  } else {
    goalRow = `<div class="plan-row" data-plan="goal"><span class="plan-icon">🎯</span><div class="plan-body"><div class="plan-name"><span>Set an overall goal</span></div><div class="plan-nums" style="color:var(--text-3)">Click to set how much you want to save</div></div></div>`;
  }
  const plansHtml = getPlans().map(p => planRowHtml(p, p.id)).join('');
  wrap.innerHTML = `<div class="ov-phead"><h3>Saving Plans</h3><button class="ov-link" id="add-plan-btn">+ Add Plan</button></div>${goalRow}${plansHtml}`;
  document.getElementById('add-plan-btn').addEventListener('click', () => openPlan(null));
  wrap.querySelectorAll('.plan-row[data-plan]').forEach(row => {
    const id = row.dataset.plan;
    row.addEventListener('click', () => id === 'goal' ? openGoal() : openPlan(id));
  });
}
function planRowHtml(p, id) {
  const pct = p.target > 0 ? Math.max(0, Math.min(100, p.saved / p.target * 100)) : 0;
  return `<div class="plan-row" data-plan="${esc(id)}">
    <span class="plan-icon">${esc(p.icon || '💰')}</span>
    <div class="plan-body">
      <div class="plan-name"><span>${esc(p.name)}</span><span class="plan-pct">${pct.toFixed(0)}%</span></div>
      <div class="plan-bar"><div class="plan-fill" style="transform:scaleX(${pct/100});background:${p.color || '#22c55e'}"></div></div>
      <div class="plan-nums">${fmt(p.saved)} <span style="color:var(--text-3)">/ ${fmt(p.target)}</span></div>
    </div>
  </div>`;
}
function getPlans() { return Array.isArray(plans) ? plans : DEFAULT_PLANS; }

// Cashflow chart (middle column). Two modes via the toggle: 'flow' = Income vs Expense per month;
// 'category' = expense stacked by top-6 categories + Other per month (folds in the old Category trends).
// Year-filtered; clicking a month picks it as the focus month.
function renderCashflow(allMonths) {
  const years = [...new Set(allMonths.map(m => m.split('-')[0]))].sort();
  if (ovYear !== 'all' && !years.includes(ovYear)) ovYear = years[years.length - 1] || 'all';
  const sel = document.getElementById('ov-year');
  sel.innerHTML = `<option value="all">All</option>` + years.map(y => `<option value="${y}"${y === ovYear ? ' selected' : ''}>${y}</option>`).join('');
  sel.onchange = () => { ovYear = sel.value; renderCashflow(allMonths); };

  // Mode toggle (Cashflow ↔ By category)
  const tabs = document.getElementById('ov-flow-tabs');
  if (tabs) tabs.querySelectorAll('.stat-tab').forEach(b => {
    b.classList.toggle('active', b.dataset.mode === ovFlowMode);
    b.onclick = () => { ovFlowMode = b.dataset.mode; renderCashflow(allMonths); };
  });

  const months = ovYear === 'all' ? allMonths : allMonths.filter(m => m.startsWith(ovYear + '-'));
  const selM = monthFilter.value !== 'all' ? monthFilter.value : null; // dim other months on an explicit pick
  const dim = base => months.map(m => (selM && m !== selM) ? base + '66' : base);
  const labels = months.map(m => ovYear === 'all' ? `${monthShort(m)} '${m.split('-')[0].slice(2)}` : monthShort(m));

  let datasets, stacked, legendPos;
  if (ovFlowMode === 'category') {
    const exp = allData.filter(isExpense);
    const catTotals = {};
    exp.forEach(d => { if (months.includes(d.monthKey)) catTotals[d.category] = (catTotals[d.category] || 0) + d.amount; });
    const topCats = Object.entries(catTotals).sort((a, b) => b[1] - a[1]).slice(0, 6).map(e => e[0]);
    const sumCat = (m, pred) => exp.reduce((s, d) => s + ((d.monthKey === m && pred(d)) ? d.amount : 0), 0);
    datasets = topCats.map((c, i) => ({
      label: c,
      data: months.map(m => sumCat(m, d => d.category === c)),
      backgroundColor: dim(NICE_COLORS[i % NICE_COLORS.length]), borderRadius: 3, borderSkipped: false
    }));
    const other = months.map(m => sumCat(m, d => !topCats.includes(d.category)));
    if (other.some(v => v > 0)) datasets.push({ label: 'Other', data: other, backgroundColor: dim('#9ca3af'), borderRadius: 3, borderSkipped: false });
    stacked = true; legendPos = 'bottom';
  } else {
    const sumType = (mk, pred) => allData.reduce((s, d) => s + ((d.monthKey === mk && pred(d)) ? d.amount : 0), 0);
    datasets = [
      { label: 'Income',  data: months.map(m => sumType(m, isIncome)),  backgroundColor: dim('#2f7d4f'), borderRadius: 4, borderSkipped: false },
      { label: 'Expense', data: months.map(m => sumType(m, isExpense)), backgroundColor: dim('#bd5a3a'), borderRadius: 4, borderSkipped: false },
      { label: 'Investments', data: months.map(m => sumType(m, isInvest)), backgroundColor: dim('#5b58c4'), borderRadius: 4, borderSkipped: false }
    ];
    stacked = false; legendPos = 'top';
  }

  if (ovChart) ovChart.destroy();
  if (!months.length) return;
  ovChart = new Chart(document.getElementById('ov-flow'), {
    type: 'bar',
    data: { labels, datasets },
    options: {
      responsive: true, maintainAspectRatio: true, aspectRatio: 1.9,
      onHover: (e, els) => { if (e.native) e.native.target.style.cursor = els.length ? 'pointer' : 'default'; },
      onClick: (e, els) => { if (els.length) selectFocusMonth(months[els[0].index]); },
      plugins: {
        legend: { position: legendPos, align: legendPos === 'top' ? 'end' : 'center', labels: { color: cssVar('--legend'), font: { size: 11 }, boxWidth: 10, padding: legendPos === 'top' ? 12 : 6, usePointStyle: true } },
        tooltip: { callbacks: { label: ctx => `${ctx.dataset.label}: ${fmt(ctx.raw)}` } }
      },
      scales: {
        x: { stacked, ticks: { color: cssVar('--tick'), font: { size: 10 } }, grid: { display: false }, border: { display: false } },
        y: { stacked, ticks: { color: cssVar('--tick'), font: { size: 10 }, callback: v => fmtShort(v) }, grid: { color: cssVar('--grid') }, border: { display: false } }
      }
    }
  });
}

// Recent transactions table (middle column): the 8 newest records of any type, with a status pill.
// Rows click through to the editor (Task 7) — allData is already sorted newest-first.
function renderRecentTx() {
  const wrap = document.getElementById('recent-tx');
  const rows = allData.slice(0, 8);
  let body;
  if (!rows.length) {
    body = '<div class="muted" style="padding:8px 0">No transactions yet.</div>';
  } else {
    const now = new Date();
    const trs = rows.map(d => {
      const t = typeOf(d);
      const amtColor = t === 'income' ? 'var(--c-income)' : t === 'invest' ? 'var(--c-invest)' : 'var(--c-expense)';
      const sign = t === 'expense' ? '−' : '+';
      const pending = d.date && d.date > now;
      const pill = pending ? '<span class="status-pill st-pend">Pending</span>' : '<span class="status-pill st-done">Completed</span>';
      const note = d.method || d.category || '—';
      const camIc = d.image ? `<svg class="img-ic" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" title="View photo" onclick="window.viewImage(event, ${d.id})"><rect x="3" y="3" width="18" height="18" rx="2" ry="2"></rect><circle cx="8.5" cy="8.5" r="1.5"></circle><polyline points="21 15 16 10 5 21"></polyline></svg>` : '';
      return `<tr onclick="window.editRow(${d.id})" title="Click to edit">
        <td class="rtx-name">${esc(d.name) || '—'}${camIc}</td>
        <td class="rtx-date">${d.date ? d.date.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' }) : '—'}</td>
        <td class="rtx-amt" style="color:${amtColor}">${sign}${fmt(d.amount)}</td>
        <td class="rtx-note" title="${esc(note)}">${esc(note)}</td>
        <td>${pill}</td>
      </tr>`;
    }).join('');
    body = `<table class="rtx"><thead><tr><th>Transaction</th><th>Date</th><th style="text-align:right">Amount</th><th>Note</th><th>Status</th></tr></thead><tbody>${trs}</tbody></table>`;
  }
  wrap.innerHTML = `<div class="ov-phead"><h3>Recent Transactions</h3><button class="ov-link" id="rtx-all">View all</button></div><div class="scroll-box">${body}</div>`;
  document.getElementById('rtx-all').addEventListener('click', () => setView('expense'));
}

// Statistic doughnut (right column): category split of the focus month, toggled between Income/Expense.
function renderOvStat(fm) {
  const panel = document.getElementById('ov-stat-panel');
  const mode = ovStatMode || 'expense';
  const pred = mode === 'income' ? isIncome : mode === 'invest' ? isInvest : isExpense;
  const label = mode === 'income' ? 'Income' : mode === 'invest' ? 'Investments' : 'Expenses';
  const byCat = {};
  allData.forEach(d => { if (d.monthKey === fm && pred(d)) byCat[d.category] = (byCat[d.category] || 0) + d.amount; });
  const entries = Object.entries(byCat).sort((a, b) => b[1] - a[1]);
  const total = entries.reduce((s, e) => s + e[1], 0);

  // Destroy the old chart BEFORE replacing the canvas below — otherwise Chart.js is left holding a detached
  // canvas + ResizeObserver until the next destroy happens to fire.
  if (ovStatChart) { ovStatChart.destroy(); ovStatChart = null; }

  panel.innerHTML = `
    <div class="ov-phead"><h3>Statistic</h3>
      <div class="stat-tabs">
        <button class="stat-tab${mode === 'expense' ? ' active' : ''}" data-mode="expense">Expense</button>
        <button class="stat-tab${mode === 'income' ? ' active' : ''}" data-mode="income">Income</button>
        <button class="stat-tab${mode === 'invest' ? ' active' : ''}" data-mode="invest">Invest</button>
      </div>
    </div>
    <div class="ov-stat-wrap"><canvas id="ov-stat"></canvas></div>
    <div id="ov-breakdown"></div>`;
  panel.querySelectorAll('.stat-tab').forEach(b => b.addEventListener('click', () => { ovStatMode = b.dataset.mode; renderOvStat(fm); }));

  const bd = document.getElementById('ov-breakdown');
  if (!entries.length) {
    const labelLower = mode === 'income' ? 'income' : mode === 'invest' ? 'investment' : 'expense';
    bd.innerHTML = `<div class="muted" style="padding:14px 0;text-align:center">No ${labelLower} data for ${monthName(fm) || 'this month'}.</div>`;
    return;
  }
  ovStatChart = new Chart(document.getElementById('ov-stat'), {
    type: 'doughnut',
    data: { labels: entries.map(e => e[0]), datasets: [{ data: entries.map(e => e[1]), backgroundColor: entries.map((_, i) => NICE_COLORS[i % NICE_COLORS.length]), borderWidth: 2, borderColor: cssVar('--surface') }] },
    options: {
      responsive: true, maintainAspectRatio: true, cutout: '68%',
      plugins: { legend: { display: false }, tooltip: { callbacks: { label: ctx => `${ctx.label}: ${fmt(ctx.raw)} (${(ctx.raw / (total || 1) * 100).toFixed(0)}%)` } } }
    },
    plugins: [{
      id: 'ovCenter',
      afterDraw(chart) {
        const { ctx, chartArea } = chart;
        if (!chartArea) return;
        const cx = (chartArea.left + chartArea.right) / 2, cy = (chartArea.top + chartArea.bottom) / 2;
        const ff = "'Manrope','SF Pro Display','Helvetica Neue',system-ui,sans-serif";
        ctx.save();
        ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
        ctx.fillStyle = cssVar('--text-3'); ctx.font = `600 11px ${ff}`;
        ctx.fillText(label, cx, cy - 12);
        ctx.fillStyle = cssVar('--text'); ctx.font = `800 16px ${ff}`;
        ctx.fillText(fmtShort(total), cx, cy + 6);
        ctx.restore();
      }
    }]
  });

  const TOPN = 6;
  const topE = entries.slice(0, TOPN), rest = entries.slice(TOPN);
  const restSum = rest.reduce((s, e) => s + e[1], 0);
  let html = topE.map(([cat, amt], i) => {
    const color = NICE_COLORS[i % NICE_COLORS.length];
    const pct = (amt / (total || 1) * 100).toFixed(0);
    return `<div class="ovb-row"><span class="ovb-dot" style="background:${color}"></span><span class="ovb-name">${esc(cat)}</span><span class="ovb-amt">${fmt(amt)}</span><span class="ovb-pct">${pct}%</span></div>`;
  }).join('');
  if (restSum > 0) html += `<div class="ovb-row"><span class="ovb-dot" style="background:#9ca3af"></span><span class="ovb-name">Other (${rest.length})</span><span class="ovb-amt">${fmt(restSum)}</span><span class="ovb-pct">${(restSum / (total || 1) * 100).toFixed(0)}%</span></div>`;
  bd.innerHTML = html;
}

// Recent activity timeline (right column): the 6 newest records styled as an activity feed.
function renderOvActivity() {
  const wrap = document.getElementById('ov-activity');
  const rows = allData.slice(0, 6);
  let body;
  if (!rows.length) {
    body = '<div class="muted" style="padding:8px 0">No activity yet.</div>';
  } else {
    body = `<div class="timeline">` + rows.map(d => {
      const t = typeOf(d);
      const av = t === 'income' ? '💰' : t === 'invest' ? '📈' : '💸';
      const verb = t === 'income' ? 'Received' : t === 'invest' ? 'Invested' : 'Spent';
      const when = d.date ? d.date.toLocaleDateString('en-GB', { day: 'numeric', month: 'long' }) : '—';
      const camIc = d.image ? `<svg class="img-ic" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" title="View photo" onclick="window.viewImage(event, ${d.id})"><rect x="3" y="3" width="18" height="18" rx="2" ry="2"></rect><circle cx="8.5" cy="8.5" r="1.5"></circle><polyline points="21 15 16 10 5 21"></polyline></svg>` : '';
      return `<div class="tl-item" onclick="window.editRow(${d.id})" style="cursor:pointer"><span class="tl-av">${av}</span><div class="tl-body"><div class="tl-text"><b>${esc(d.name) || '(no name)'}</b> · ${verb} ${fmt(d.amount)}${camIc}</div><div class="tl-time">${esc(d.category)} · ${when}</div></div></div>`;
    }).join('') + `</div>`;
  }
  wrap.innerHTML = `<div class="ov-phead"><h3>Recent Activity</h3></div><div class="scroll-box">${body}</div>`;
}

// --- Saving-plan modal (add / edit / delete a saving plan) ---
function openPlan(id) {
  editingPlanId = id;
  const isEdit = id != null;
  document.getElementById('plan-title').textContent = isEdit ? 'Edit saving plan' : 'Add saving plan';
  const p = isEdit ? getPlans().find(x => x.id === id) : null;
  document.getElementById('pf-name').value = p ? p.name : '';
  document.getElementById('pf-icon').value = p ? (p.icon || '') : '';
  document.getElementById('pf-saved').value = p ? p.saved : '';
  document.getElementById('pf-target').value = p ? p.target : '';
  document.getElementById('pf-color').value = p ? (p.color || '#22c55e') : '#22c55e';
  document.getElementById('pf-delete').style.display = isEdit ? 'inline-block' : 'none';
  document.getElementById('plan-overlay').style.display = 'flex';
  document.getElementById('pf-name').focus();
}
async function persistPlans() { const db = await openDB(); await putMeta(db, 'plans', plans); db.close(); }
async function savePlan() {
  const name = document.getElementById('pf-name').value.trim();
  if (!name) { toast('Enter a plan name', 'warn'); return; }
  const rec = {
    id: editingPlanId || ('p' + Date.now()),
    name,
    icon: document.getElementById('pf-icon').value.trim() || '💰',
    saved: parseAmount(document.getElementById('pf-saved').value),
    target: parseAmount(document.getElementById('pf-target').value),
    color: document.getElementById('pf-color').value || '#22c55e'
  };
  const list = getPlans().slice();
  const idx = list.findIndex(x => x.id === rec.id);
  if (idx >= 0) list[idx] = rec; else list.push(rec);
  plans = list;
  await persistPlans();
  document.getElementById('plan-overlay').style.display = 'none';
  toast(idx >= 0 ? 'Plan saved' : 'Plan added', 'success');
  render();
  scheduleSyncPush();
}
async function deletePlan() {
  if (editingPlanId == null) return;
  plans = getPlans().filter(x => x.id !== editingPlanId);
  await persistPlans();
  document.getElementById('plan-overlay').style.display = 'none';
  toast('Plan deleted', 'success');
  render();
  scheduleSyncPush();
}

// --- Settings → My cards: store the user's own card details (number/expiry/CVV) for reference.
// Persisted UNENCRYPTED in meta 'cards' and included in Backup/Sync JSON — personal device only.
function getCards() { return Array.isArray(cards) ? cards : []; }
// The Overview card features the explicitly-pinned card, else falls back to the first saved card.
function getPinnedCard() { const l = getCards(); return l.find(c => c.id === pinnedCardId) || l[0] || null; }
async function persistPinned() { const db = await openDB(); await putMeta(db, 'pinnedCard', pinnedCardId); db.close(); scheduleSyncPush(); }
function setPinnedCard(id) { pinnedCardId = (pinnedCardId === id) ? null : id; persistPinned(); renderCardsManager(); renderBalanceCard(); }
// Copy helper with a file:// fallback (clipboard API is blocked on some non-secure origins).
async function copyText(t) {
  try { await navigator.clipboard.writeText(t); return true; } catch (e) {}
  try {
    const ta = document.createElement('textarea');
    ta.value = t; ta.style.position = 'fixed'; ta.style.opacity = '0'; ta.style.top = '0';
    document.body.appendChild(ta); ta.focus(); ta.select();
    const ok = document.execCommand('copy'); ta.remove(); return ok;
  } catch (e) { return false; }
}
// Days until the next occurrence of a day-of-month (1–31) from today; clamps to each month's length
// (e.g. day 31 in a 30-day month → the 30th). Returns { date, days } or null if the day isn't valid.
function nextDayOfMonth(day) {
  day = Number(day);
  if (!day || day < 1 || day > 31) return null;
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const at = (y, m) => new Date(y, m, Math.min(day, new Date(y, m + 1, 0).getDate()));
  let t = at(today.getFullYear(), today.getMonth());
  if (t < today) t = at(today.getFullYear(), today.getMonth() + 1);
  return { date: t, days: Math.round((t - today) / 86400000) };
}
// Whole days from today to a Date (negative = past).
function daysFromToday(date) {
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  return Math.round((new Date(date.getFullYear(), date.getMonth(), date.getDate()) - today) / 86400000);
}
// Next statement-close date + the payment-due date for THAT statement — kept consistent with statementCycle():
// the due falls in the close month when dueDay > statementDay, else in the FOLLOWING month (e.g. close 30 → due 30
// is next month, not the same day). Computing them independently is wrong (it shows "Hạn 30/06" instead of 30/07).
function cardCycleDates(card) {
  const S = Number(card && card.statementDay) || 0;
  const Du = Number(card && card.dueDay) || 0;
  const s = (S >= 1 && S <= 31) ? nextDayOfMonth(S) : null;
  let d = null;
  if (Du >= 1 && Du <= 31) {
    if (s) {                                   // due relative to the upcoming statement close
      const base = s.date, off = (Du <= S) ? 1 : 0;
      const y = base.getFullYear(), m = base.getMonth() + off;
      const dd = new Date(y, m, Math.min(Du, new Date(y, m + 1, 0).getDate()));
      d = { date: dd, days: daysFromToday(dd) };
    } else {
      d = nextDayOfMonth(Du);                  // no statement day set → just the next due day
    }
  }
  return { s, d };
}
// The statement cycle a credit-card txn (dateStr) falls into for a card with statementDay S / dueDay Du:
// a txn on/before S is in THIS month's statement (closes on S); after S it rolls to next month's. Due day
// is the next Du after the close (next month when Du <= S). Returns { ym, monthNum, year, due } or null if
// S isn't set (then the card just groups as a whole). Lets us label debt "Shopee · tháng 6 · hạn 10/7".
function statementCycle(dateStr, card) {
  const S = Number(card && card.statementDay);
  if (!dateStr || !S || S < 1 || S > 31) return null;
  const [y, m, day] = dateStr.split('-').map(Number);
  let cy = y, cm = m;                 // close month (1-based)
  if (day > S) { cm++; if (cm > 12) { cm = 1; cy++; } }
  const Du = Number(card.dueDay) || S;
  let dy = cy, dmo = cm;              // due month
  if (Du <= S) { dmo++; if (dmo > 12) { dmo = 1; dy++; } }
  const due = new Date(dy, dmo - 1, Math.min(Du, new Date(dy, dmo, 0).getDate()));
  return { ym: `${cy}-${String(cm).padStart(2, '0')}`, monthNum: cm, year: cy, due };
}
// The N statement-cycle "periods" an installment purchase spreads across. Period 1 = the purchase's own cycle;
// each later period lands one statement month after, with the same due day. Each carries the per-period amount
// (last gets the remainder). Returns null if N<2 or the card has no statement day (can't place it on a calendar).
function installmentPeriods(d, card) {
  const N = Number(d.installments);
  const cyc = (N >= 2 && card) ? statementCycle(d.dateStr, card) : null;
  if (!cyc) return null;
  const total = Number(d.amount) || 0;
  const per = Math.floor(total / N);
  const Du = Number(card.dueDay) || Number(card.statementDay);
  const out = [];
  for (let k = 0; k < N; k++) {
    const cm0 = (cyc.monthNum - 1) + k;                      // 0-based close-month index from the cycle's year
    const cy = cyc.year + Math.floor(cm0 / 12);
    const cmo = (cm0 % 12) + 1;                              // 1-based close month
    const dueBase = new Date(cyc.due.getFullYear(), cyc.due.getMonth() + k, 1);
    const due = new Date(dueBase.getFullYear(), dueBase.getMonth(), Math.min(Du, new Date(dueBase.getFullYear(), dueBase.getMonth() + 1, 0).getDate()));
    out.push({ k: k + 1, N, ym: `${cy}-${String(cmo).padStart(2, '0')}`, monthNum: cmo, year: cy, due, amount: k === N - 1 ? total - per * (N - 1) : per });
  }
  return out;
}
// The ccPaidFps key(s) representing THIS record's paid state: one `fingerprint#k` per installment period for a
// card-paid installment plan that has a statement cycle, otherwise the bare fingerprint. The panel, the table
// and the tick toggle all derive paid state through this one helper so they can never disagree (e.g. for debt
// records, or a card whose statementDay was removed → installmentPeriods returns null → falls back to the bare fp).
function paidKeysFor(d) {
  if (!isDebt(d) && Number(d.installments) >= 2) {
    const periods = installmentPeriods(d, getCards().find(x => x.label === d.method));
    if (periods) return periods.map(p => `${d.fingerprint}#${p.k}`);
  }
  return [d.fingerprint];
}
// Does a txn belong to a "Remaining owed" group selection (card / statement-cycle / person)?
function matchDebtSel(d, sel) {
  if (!sel) return true;
  if (sel.kind === 'person') return isDebt(d) && (d.name || '(unnamed)') === sel.name;
  if (sel.kind === 'card') return !isDebt(d) && (d.method || 'Credit Card') === sel.method;
  if (sel.kind === 'cycle') {
    if (isDebt(d) || d.method !== sel.method) return false;
    const c = getCards().find(x => x.label === d.method);
    if (!c) return false;
    const periods = installmentPeriods(d, c);              // an installment plan can touch several cycles
    if (periods) return periods.some(p => p.ym === sel.ym);
    const cyc = statementCycle(d.dateStr, c);
    return !!(cyc && cyc.ym === sel.ym);
  }
  return true;
}
// Reminder pill for a card's statement-close / payment-due days; '' if neither set. Countdown tracks
// the DUE day (when you must pay). showLabel prefixes the card label (used when several cards stack).
function cardDueBadge(card) {
  if (!card) return '';
  const { s, d } = cardCycleDates(card);
  if (!s && !d) return '';
  const dm = x => `${String(x.getDate()).padStart(2,'0')}/${String(x.getMonth()+1).padStart(2,'0')}`;
  const parts = [];
  if (s) parts.push(`Chốt ${dm(s.date)}`);
  if (d) parts.push(`Hạn ${dm(d.date)}`);
  if (d) parts.push(d.days === 0 ? 'còn hôm nay' : `còn ${d.days} ngày`);
  const urgent = d && d.days <= 3;
  // Two-line block (label on top, dates below) so a long "Chốt · Hạn · còn" line can't break mid-content.
  return `<span class="card-due${urgent ? ' urgent' : ''}"><span class="cd-head">⏰ ${card.label ? esc(card.label) : 'Nhắc đóng thẻ'}</span><span class="cd-body">${parts.join(' · ')}</span></span>`;
}
// ===== Notification bell (top toolbar) =====
// Gathers the live reminders that used to sit inline under the balance card, plus over-budget and
// goal alerts, into one dropdown "bubble". Each item: { icon, title, sub, urgent, view?, sort }.
// `view` (optional) makes the row clickable → jumps to that tab. Lower `sort` floats higher.
function buildNotifications() {
  const out = [];
  // 1) Every saved card with a statement-close / payment-due day → a countdown (urgent ≤ 3 days).
  getCards().forEach(c => {
    const { s, d } = cardCycleDates(c);
    if (!s && !d) return;
    const dm = x => `${String(x.getDate()).padStart(2, '0')}/${String(x.getMonth() + 1).padStart(2, '0')}`;
    const parts = [];
    if (s) parts.push(`Chốt ${dm(s.date)}`);
    if (d) parts.push(`Hạn ${dm(d.date)}`);
    if (d) parts.push(d.days === 0 ? 'còn hôm nay' : `còn ${d.days} ngày`);
    out.push({
      icon: '⏰', title: c.label ? esc(c.label) : 'Nhắc đóng thẻ', sub: parts.join(' · '),
      urgent: !!(d && d.days <= 3), view: 'debts', sort: d ? d.days : (s ? s.days : 99)
    });
  });
  // 2) Categories over their monthly budget (focus month).
  const mk = focusMonth();
  if (mk) Object.keys(budgets).filter(c => budgets[c] > 0).forEach(c => {
    const spent = spentInMonth(mk, c), limit = budgets[c];
    if (spent > limit) out.push({
      icon: '🔴', title: `${esc(c)} over budget`, sub: `${fmt(spent)} / ${fmt(limit)} · +${fmt(spent - limit)}`,
      urgent: true, view: 'expense', sort: -2
    });
  });
  // 3) Saving goal / plans that hit 100%.
  if (goal > 0) {
    const saved = allData.reduce((s, d) => s + (isIncome(d) ? d.amount : isExpense(d) ? -d.amount : 0), 0);
    if (saved >= goal) out.push({ icon: '🎯', title: 'Overall goal reached!', sub: `${fmt(saved)} / ${fmt(goal)}`, urgent: false, sort: 50 });
  }
  getPlans().forEach(p => {
    if (p.target > 0 && p.saved >= p.target)
      out.push({ icon: esc(p.icon || '🎯'), title: `${esc(p.name)} — 100%!`, sub: `${fmt(p.saved)} / ${fmt(p.target)}`, urgent: false, sort: 60 });
  });
  // Urgent first, then soonest / most important.
  out.sort((a, b) => (b.urgent - a.urgent) || (a.sort - b.sort));
  return out;
}
function renderNotifications() {
  const bell = document.getElementById('notif-bell'), badge = document.getElementById('notif-badge'), pop = document.getElementById('notif-pop');
  if (!bell || !badge || !pop) return;
  const items = buildNotifications();
  const urgent = items.some(n => n.urgent);
  if (items.length) { badge.textContent = items.length; badge.style.display = ''; } else badge.style.display = 'none';
  bell.classList.toggle('has-urgent', urgent);
  bell.classList.toggle('open', notifOpen);
  bell.title = items.length ? `${items.length} reminder${items.length > 1 ? 's' : ''}` : 'No reminders';
  pop.innerHTML = `<div class="notif-head"><span>Notifications</span><span class="notif-count">${items.length || ''}</span></div>` +
    (items.length
      ? items.map(n => `<div class="notif-item${n.urgent ? ' urgent' : ''}"${n.view ? ` data-view="${n.view}"` : ''}><span class="notif-ic">${n.icon}</span><div class="notif-body"><div class="notif-title">${n.title}</div><div class="notif-sub">${n.sub}</div></div></div>`).join('')
      : `<div class="notif-empty"><span class="ne-ic">✅</span>No reminders right now — you're all caught up.</div>`);
  pop.querySelectorAll('.notif-item[data-view]').forEach(el =>
    el.addEventListener('click', () => { closeNotifications(); setView(el.dataset.view); }));
  pop.style.display = notifOpen ? 'block' : 'none';
}
function openNotifications() { notifOpen = true; renderNotifications(); }
function closeNotifications() { notifOpen = false; const pop = document.getElementById('notif-pop'); const bell = document.getElementById('notif-bell'); if (pop) pop.style.display = 'none'; if (bell) bell.classList.remove('open'); }
function toggleNotifications() { notifOpen ? closeNotifications() : openNotifications(); }

// Detect the brand from the leading digits (display only).
function cardBrand(num) {
  const n = (num || '').replace(/\D/g, '');
  if (/^4/.test(n)) return 'VISA';
  if (/^(5[1-5]|2[2-7])/.test(n)) return 'MASTERCARD';
  if (/^3[47]/.test(n)) return 'AMEX';
  if (/^9704/.test(n)) return 'NAPAS';
  if (/^6(?:011|5)/.test(n)) return 'DISCOVER';
  if (/^(?:36|38|30[0-5])/.test(n)) return 'DINERS';
  return 'CARD';
}
function groupDigits(n) { return (n || '').replace(/\D/g, '').replace(/(.{4})/g, '$1 ').trim(); }
function maskNumber(num) {
  const n = (num || '').replace(/\D/g, '');
  if (!n) return '•••• •••• •••• ••••';
  if (n.length <= 4) return n;
  // Group into 4s WITHOUT groupDigits() — it strips non-digits, which would eat the • mask characters.
  return ('•'.repeat(n.length - 4) + n.slice(-4)).replace(/(.{4})/g, '$1 ').trim();
}

function renderCardsManager() {
  const wrap = document.getElementById('cards-manager');
  if (!wrap) return;
  const list = getCards();
  if (!list.length) {
    wrap.innerHTML = `<div class="cards-empty">No cards saved yet. Click “+ Add card” to store one.</div>`;
    return;
  }
  const pinned = getPinnedCard(); // the effective featured card (explicit pin, else first)
  wrap.innerHTML = `<div class="cards-grid">${list.map(c => {
    const shown = revealedCards.has(c.id);
    const num = shown ? (groupDigits(c.number) || '•••• •••• •••• ••••') : maskNumber(c.number);
    const cvv = shown && c.cvv ? esc(c.cvv) : '•••';
    const isPinned = pinned && c.id === pinned.id;
    return `<div class="cc-card${isLightColor(c.color) ? ' cc-light' : ''}" style="--cc-bg:${esc(c.color || '#2f5e4f')}">
      <div class="cc-card-top">
        <div style="min-width:0"><div class="cc-brand">${esc(cardBrand(c.number))}</div><div class="cc-label">${esc(c.label || 'Card')}${isPinned ? ' · ★ on Overview' : ''}</div></div>
        <span class="cc-chip"></span>
      </div>
      <div class="cc-number">${esc(num)}</div>
      <div class="cc-bottom">
        <div style="flex:1;min-width:0"><div class="cc-cap">Card Holder</div><div class="cc-val">${esc(c.holder || '—')}</div></div>
        <div><div class="cc-cap">Expires</div><div class="cc-val">${esc(c.expiry || '—')}</div></div>
        <div><div class="cc-cap">CVV</div><div class="cc-val">${cvv}</div></div>
      </div>
      ${(c.statementDay || c.dueDay) ? `<div class="cc-due">⏰ ${c.statementDay ? `Statement day ${esc(String(c.statementDay))}` : ''}${c.statementDay && c.dueDay ? ' · ' : ''}${c.dueDay ? `Due day ${esc(String(c.dueDay))}` : ''}</div>` : ''}
      <div class="cc-actions">
        <button data-act="pin" data-id="${esc(c.id)}" class="${isPinned ? 'cc-pinned' : ''}" title="Show this card on the Overview tab">${isPinned ? '★ Pinned' : '☆ Pin'}</button>
        <button data-act="reveal" data-id="${esc(c.id)}">${shown ? '🙈 Hide' : '👁 Reveal'}</button>
        <button data-act="edit" data-id="${esc(c.id)}">Edit</button>
        <button data-act="del" data-id="${esc(c.id)}">Delete</button>
      </div>
    </div>`;
  }).join('')}</div>`;
  wrap.querySelectorAll('.cc-actions button').forEach(btn => {
    btn.addEventListener('click', () => {
      const id = btn.dataset.id, act = btn.dataset.act;
      if (act === 'pin') setPinnedCard(id);
      else if (act === 'reveal') { revealedCards.has(id) ? revealedCards.delete(id) : revealedCards.add(id); renderCardsManager(); }
      else if (act === 'edit') openCard(id);
      else if (act === 'del') deleteCard(id);
    });
  });
}

function openCard(id) {
  editingCardId = id;
  const isEdit = id != null;
  const c = isEdit ? getCards().find(x => x.id === id) : null;
  document.getElementById('card-title').textContent = isEdit ? 'Edit card' : 'Add card';
  document.getElementById('cf-label').value = c ? (c.label || '') : '';
  document.getElementById('cf-holder').value = c ? (c.holder || '') : '';
  document.getElementById('cf-number').value = c ? (c.number || '') : '';
  document.getElementById('cf-expiry').value = c ? (c.expiry || '') : '';
  document.getElementById('cf-cvv').value = c ? (c.cvv || '') : '';
  document.getElementById('cf-statement').value = c && c.statementDay ? c.statementDay : '';
  document.getElementById('cf-due').value = c && c.dueDay ? c.dueDay : '';
  document.getElementById('cf-color').value = c ? (c.color || '#2f5e4f') : '#2f5e4f';
  document.getElementById('cf-delete').style.display = isEdit ? 'inline-block' : 'none';
  document.getElementById('card-overlay').style.display = 'flex';
  document.getElementById('cf-label').focus();
}
async function persistCards() { const db = await openDB(); await putMeta(db, 'cards', cards); db.close(); }
async function saveCard() {
  const label = document.getElementById('cf-label').value.trim();
  const number = document.getElementById('cf-number').value.trim();
  if (!label && !number) { toast('Enter a card label or number', 'warn'); return; }
  const clampDay = v => { const n = parseInt(v, 10); return (n >= 1 && n <= 31) ? n : null; };
  const rec = {
    id: editingCardId || ('c' + Date.now()),
    label,
    holder: document.getElementById('cf-holder').value.trim(),
    number,
    expiry: document.getElementById('cf-expiry').value.trim(),
    cvv: document.getElementById('cf-cvv').value.trim(),
    statementDay: clampDay(document.getElementById('cf-statement').value), // ngày chốt sao kê (1–31) or null
    dueDay: clampDay(document.getElementById('cf-due').value),             // hạn thanh toán (1–31) or null
    color: document.getElementById('cf-color').value || '#2f5e4f'
  };
  const list = getCards().slice();
  const idx = list.findIndex(x => x.id === rec.id);
  if (idx >= 0) list[idx] = rec; else list.push(rec);
  cards = list;
  await persistCards();
  document.getElementById('card-overlay').style.display = 'none';
  toast(idx >= 0 ? 'Card saved' : 'Card added', 'success');
  renderCardsManager();
  renderBalanceCard(); // keep the Overview card in sync with edits to the pinned/first card
  scheduleSyncPush();
}
async function deleteCard(id) {
  const cid = (id != null && typeof id !== 'object') ? id : editingCardId; // called from list (id) or modal Delete (no arg)
  if (cid == null) return;
  if (!confirm('Delete this card?')) return;
  cards = getCards().filter(x => x.id !== cid);
  revealedCards.delete(cid);
  await persistCards();
  if (pinnedCardId === cid) { pinnedCardId = null; await persistPinned(); } // pinned card gone → fall back to first
  document.getElementById('card-overlay').style.display = 'none';
  toast('Card deleted', 'success');
  renderCardsManager();
  renderBalanceCard();
  scheduleSyncPush();
}

// --- Debts & Credit Cards modal and database logic ---
async function persistDebts() {
  const db = await openDB();
  await putMeta(db, 'debts', debts);
  db.close();
}
function openDebt(id) {
  editingDebtId = id;
  const isEdit = id != null;
  document.getElementById('debt-title').textContent = isEdit ? 'Edit debt & credit card' : 'Add debt & credit card';
  const d = isEdit ? getDebts().find(x => x.id === id) : null;
  
  document.getElementById('df-type').value = d ? d.type : 'credit-card';
  document.getElementById('df-name').value = d ? d.name : '';
  document.getElementById('df-amount').value = d ? d.amount : '';
  document.getElementById('df-recurring').checked = d ? !!d.isRecurring : true;
  document.getElementById('df-due-date').value = d ? (d.dueDate || '') : '';
  document.getElementById('df-due-day').value = d ? (d.dueDay || '') : '';
  document.getElementById('df-note').value = d ? (d.note || '') : '';
  document.getElementById('df-autolog').checked = d ? !!d.autoLog : true; // new debts default to auto-log ON so ticking moves the total

  const isRec = d ? !!d.isRecurring : true;
  document.getElementById('df-due-day-wrap').style.display = isRec ? 'block' : 'none';
  document.getElementById('df-due-date-wrap').style.display = isRec ? 'none' : 'block';
  
  document.getElementById('df-delete').style.display = isEdit ? 'inline-block' : 'none';
  document.getElementById('debt-overlay').style.display = 'flex';
  document.getElementById('df-name').focus();
}
async function saveDebt() {
  const name = document.getElementById('df-name').value.trim();
  if (!name) { toast('Enter a name', 'warn'); return; }
  const amount = parseAmount(document.getElementById('df-amount').value);
  if (amount <= 0) { toast('Enter a valid amount', 'warn'); return; }
  
  const type = document.getElementById('df-type').value;
  const isRecurring = document.getElementById('df-recurring').checked;
  const note = document.getElementById('df-note').value.trim();
  const autoLog = document.getElementById('df-autolog').checked;
  
  let dueDate = '';
  let dueDay = 0;
  if (isRecurring) {
    dueDay = parseInt(document.getElementById('df-due-day').value) || 0;
    if (dueDay < 1 || dueDay > 31) { toast('Enter a due day between 1 and 31', 'warn'); return; }
  } else {
    dueDate = document.getElementById('df-due-date').value;
    if (!dueDate) { toast('Select a due date', 'warn'); return; }
  }
  
  const list = getDebts().slice();
  const existing = editingDebtId ? list.find(x => x.id === editingDebtId) : null;
  
  const rec = {
    id: editingDebtId || ('d' + Date.now()),
    type,
    name,
    amount,
    isRecurring,
    dueDate: isRecurring ? '' : dueDate,
    dueDay: isRecurring ? dueDay : 0,
    note,
    autoLog,
    status: existing ? (existing.status || 'active') : 'active',
    paidMonths: existing ? (existing.paidMonths || []) : [],
    paidAmounts: existing ? (existing.paidAmounts || {}) : {},
    createdAt: existing ? (existing.createdAt || Date.now()) : Date.now()
  };
  
  const idx = list.findIndex(x => x.id === rec.id);
  if (idx >= 0) list[idx] = rec; else list.push(rec);
  
  debts = list;
  await persistDebts();
  document.getElementById('debt-overlay').style.display = 'none';
  toast(idx >= 0 ? 'Debt saved' : 'Debt added', 'success');
  render();
  scheduleSyncPush();
}
async function deleteDebt() {
  if (editingDebtId == null) return;
  if (!confirm('Delete this debt reminder?')) return;
  debts = getDebts().filter(x => x.id !== editingDebtId);
  await persistDebts();
  document.getElementById('debt-overlay').style.display = 'none';
  toast('Debt reminder deleted', 'success');
  render();
  scheduleSyncPush();
}

// --- Debts & Credit Cards rendering and payment logic ---
function getDebtStatus(d, focusMonthKey) {
  const isRec = d.isRecurring;
  let isPaid = false;
  if (isRec) {
    isPaid = Array.isArray(d.paidMonths) && d.paidMonths.includes(focusMonthKey);
  } else {
    isPaid = d.status === 'paid';
  }
  
  if (isPaid) return { isPaid: true, label: 'Paid', class: 'paid' };
  
  const now = new Date();
  const curYear = now.getFullYear();
  const curMonth = String(now.getMonth() + 1).padStart(2, '0');
  const curMonthKey = `${curYear}-${curMonth}`;
  const curDay = now.getDate();
  
  let isOverdue = false;
  if (isRec) {
    // recurring: overdue relative to the month being viewed
    if (focusMonthKey < curMonthKey) isOverdue = true;
    else if (focusMonthKey === curMonthKey && d.dueDay < curDay) isOverdue = true;
  } else if (d.dueDate) {
    // one-time: overdue by its own due date vs today, independent of which focus month is being viewed
    const todayStr = `${curYear}-${curMonth}-${String(curDay).padStart(2, '0')}`;
    if (d.dueDate < todayStr) isOverdue = true;
  }

  if (isOverdue) return { isPaid: false, label: 'Overdue', class: 'overdue' };
  return { isPaid: false, label: 'Upcoming', class: 'upcoming' };
}
// Deterministic calendar date for a debt's auto-logged transaction. Both creating (mark paid) and
// removing (un-mark) compute it identically, so the fingerprints always match regardless of WHEN the user
// clicks. The old code anchored current-month payments to new Date() (today), so un-marking on another day
// — or un-marking a one-time debt whose delete path used dueDate — produced a different fingerprint and
// left the logged transaction orphaned.
function debtTxDate(d, fm) {
  if (!d.isRecurring) return parseDate(d.dueDate);
  const [y, m] = String(fm || '').split('-').map(Number);
  if (!y || !m) return null;
  const daysInMonth = new Date(y, m, 0).getDate();
  const day = Math.min(Math.max(d.dueDay || 1, 1), daysInMonth); // clamp so dueDay > days-in-month never rolls into next month
  return new Date(y, m - 1, day);
}
// Build the auto-log transaction record for a debt + focus month (shared by the create and delete paths).
function debtTxRecord(d, fm, customAmount) {
  const isExp = d.type === 'credit-card' || d.type === 'i-owe';
  const prefix = isExp ? 'Pay' : 'Collect';
  const amt = customAmount !== undefined && customAmount !== null ? customAmount : d.amount;
  return makeRecord({
    name: `${prefix}: ${d.name}`,
    amount: amt,
    category: 'Debt & Loans',
    method: d.type === 'credit-card' ? d.name : '',
    date: debtTxDate(d, fm),
    type: isExp ? 'expense' : 'income'
  });
}
async function logDebtPaymentTransaction(d, focusMonthKey, customAmount) {
  const db = await openDB();
  const rec = debtTxRecord(d, focusMonthKey, customAmount);
  const all = await getAll(db);
  if (!all.some(r => r.fingerprint === rec.fingerprint)) {
    await putRecord(db, rec);
  }
  db.close();
}
function getFocusMonthKey() {
  const months = [...new Set(allData.map(d => d.monthKey))].filter(m => m !== 'Unknown').sort();
  const now = new Date();
  const curMonthKey = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
  let fm = monthFilter.value;
  if (fm === 'all' || !fm) {
    fm = months.length ? months[months.length - 1] : curMonthKey;
  }
  return fm;
}
function getCreditCardBalance(d, fm) {
  // Model B: the card balance is the amount you enter. Individual swipes are NOT logged separately —
  // the bill becomes one expense only when you tick "paid" (auto-log). (fm kept for call-site compat.)
  return d.amount;
}
// --- Credit Cards ledger: the Debts tab is a transaction table of expenses paid by "Credit Card"
// (filtered via matchesView). Each row has a "Paid" tick — a reminder that you've settled that charge on
// your card bill. These transactions ALREADY count as normal expenses, so ticking changes no total; the
// paid state is just a set of fingerprints in meta 'ccPaidFps'.
async function toggleCcPaidTxn(id) {
  const r = allData.find(x => x.id === id);
  if (!r) return;
  if (!Array.isArray(ccPaidFps)) ccPaidFps = [];
  // Default: flip the record's whole paid state (all installment periods together).
  let keys = paidKeysFor(r);
  // But when a single statement-month group is selected in "Remaining owed", target JUST that period — so a
  // mistaken panel tick can be undone, and one month can be settled/un-settled without the others.
  if (!isDebt(r) && Number(r.installments) >= 2 && tableDebtSel && tableDebtSel.sel && tableDebtSel.sel.kind === 'cycle') {
    const periods = installmentPeriods(r, getCards().find(x => x.label === r.method));
    const p = periods && periods.find(pp => pp.ym === tableDebtSel.sel.ym);
    if (p) keys = [`${r.fingerprint}#${p.k}`];
  }
  const set = new Set(ccPaidFps);
  const allPaid = keys.every(k => set.has(k));
  keys.forEach(k => allPaid ? set.delete(k) : set.add(k));
  ccPaidFps = [...set];
  const db = await openDB();
  await putMeta(db, 'ccPaidFps', ccPaidFps);
  db.close();
  render();
  scheduleSyncPush();
}
async function toggleCcNote(id) {
  const r = allData.find(x => x.id === id);
  if (!r) return;
  if (!ccNoteFps || typeof ccNoteFps !== 'object') ccNoteFps = {};
  const fp = r.fingerprint;
  const noted = !!ccNoteFps[fp];
  if (!noted) ccNoteFps[fp] = localDateStr(new Date());
  else delete ccNoteFps[fp];
  const db = await openDB();
  await putMeta(db, 'ccNoteFps', ccNoteFps);
  db.close();
  render();
  scheduleSyncPush();
}
window.ccTick = (id) => toggleCcPaidTxn(id);
window.ccNote = (id) => toggleCcNote(id);
function getPaidAmount(d, fm) {
  if (!d.paidAmounts) return 0;
  return d.isRecurring ? (d.paidAmounts[fm] || 0) : (d.paidAmounts['one-time'] || 0);
}
async function toggleDebtPaid(id) {
  const d = debts.find(x => x.id === id);
  if (!d) return;
  
  const fm = getFocusMonthKey();
  const statusInfo = getDebtStatus(d, fm);
  
  if (d.isRecurring) {
    if (!Array.isArray(d.paidMonths)) d.paidMonths = [];
    if (!d.paidAmounts) d.paidAmounts = {};
    
    if (statusInfo.isPaid) {
      const prevPaidAmt = d.paidAmounts[fm];
      d.paidMonths = d.paidMonths.filter(m => m !== fm);
      delete d.paidAmounts[fm];

      // Auto-log support: find and remove the transaction created on mark-paid (same fingerprint via debtTxRecord).
      if (d.autoLog) {
        const db = await openDB();
        const all = await getAll(db);
        const testRec = debtTxRecord(d, fm, prevPaidAmt);
        const matched = all.find(r => r.fingerprint === testRec.fingerprint);
        if (matched) {
          await deleteRecord(db, matched.id);
          toast(`Removed transaction for: ${d.name}`);
        }
        db.close();
      }

      toast('Debt marked as unpaid', 'info');
    } else {
      const defaultAmt = d.type === 'credit-card' ? getCreditCardBalance(d, fm) : d.amount;
      const inputVal = prompt(`Nhập số tiền đã thanh toán cho "${d.name}":`, defaultAmt);
      if (inputVal === null) return;
      const paidAmt = parseAmount(inputVal);
      if (isNaN(paidAmt) || paidAmt < 0) {
        toast('Số tiền không hợp lệ', 'warn');
        return;
      }
      
      d.paidMonths.push(fm);
      d.paidAmounts[fm] = paidAmt;
      
      if (d.autoLog) {
        await logDebtPaymentTransaction(d, fm, paidAmt);
      }
      toast('Debt marked as paid', 'success');
    }
  } else {
    if (!d.paidAmounts) d.paidAmounts = {};
    if (statusInfo.isPaid) {
      const prevPaidAmt = d.paidAmounts['one-time'];
      d.status = 'active';
      delete d.paidAmounts['one-time'];

      // Auto-log support: find and remove the transaction created on mark-paid (same fingerprint via debtTxRecord).
      if (d.autoLog) {
        const db = await openDB();
        const all = await getAll(db);
        const testRec = debtTxRecord(d, fm, prevPaidAmt);
        const matched = all.find(r => r.fingerprint === testRec.fingerprint);
        if (matched) {
          await deleteRecord(db, matched.id);
          toast(`Removed transaction for: ${d.name}`);
        }
        db.close();
      }

      toast('Debt marked as active', 'info');
    } else {
      const defaultAmt = d.amount;
      const inputVal = prompt(`Nhập số tiền đã thanh toán cho "${d.name}":`, defaultAmt);
      if (inputVal === null) return;
      const paidAmt = parseAmount(inputVal);
      if (isNaN(paidAmt) || paidAmt < 0) {
        toast('Số tiền không hợp lệ', 'warn');
        return;
      }
      
      d.status = 'paid';
      d.paidAmounts['one-time'] = paidAmt;
      
      if (d.autoLog) {
        await logDebtPaymentTransaction(d, fm, paidAmt);
      }
      toast('Debt marked as paid', 'success');
    }
  }
  
  await persistDebts();
  await reloadPreservingFilters();
  scheduleSyncPush();
}

// Set the global month filter from the overview (click a bar); click the active month again to clear.
function selectFocusMonth(mk) {
  if (![...monthFilter.options].some(o => o.value === mk)) return;
  monthFilter.value = (monthFilter.value === mk ? 'all' : mk);
  render();
}

// --- Net-worth "bank card" hero (Overview tab) ---
// Balance = tổng thu − tổng chi over all time = cash still on hand + money moved into investments
// (đầu tư chỉ là dời tiền sang tài sản nên vẫn là tài sản của bạn). Same definition as the goal's "saved".
// The Overview card features your pinned real card (Settings → My cards). Click anywhere to reveal +
// copy the number (the whole point: grab the digits fast). Name on top, EXP/CVV at the bottom; coloured
// True when a card colour is light enough that white ink would be hard to read → caller uses dark ink instead.
// YIQ perceived brightness (0–255); >150 ≈ light. Used by both card visuals so the choice is consistent.
function isLightColor(hex) {
  const n = parseInt(String(hex || '').replace('#', ''), 16);
  if (isNaN(n)) return false;
  const r = (n >> 16) & 255, g = (n >> 8) & 255, b = n & 255;
  return (r * 299 + g * 587 + b * 114) / 1000 > 150;
}
// with the card's chosen colour like the Settings .cc-card. No saved card → an "Add a card" prompt.
function renderBalanceCard() {
  const wrap = document.getElementById('balance-card');
  if (!wrap) return;
  const card = getPinnedCard();
  const wifi = `<svg class="bc-wifi" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M8 9a5 5 0 0 1 0 6"/><path d="M11 6.5a9 9 0 0 1 0 11"/><path d="M14 4a13 13 0 0 1 0 16"/></svg>`;

  if (!card) {
    wrap.className = 'balance-card bc-empty';
    wrap.style.removeProperty('--cc-bg');
    wrap.onclick = () => setView('settings');
    wrap.innerHTML = `<div class="bc-empty-in"><div class="bc-ic">💳</div><div>No card pinned yet.<br>Add one in <b>Settings → My cards</b>.</div></div>`;
    return;
  }

  const revealed = !!window._cardRevealed;
  const num = revealed ? (groupDigits(card.number) || '•••• •••• •••• ••••') : maskNumber(card.number);
  const cvv = revealed && card.cvv ? esc(card.cvv) : '•••';
  wrap.className = 'balance-card bc-real' + (isLightColor(card.color) ? ' bc-light' : '');
  wrap.style.setProperty('--cc-bg', card.color || '#2f5e4f');
  wrap.innerHTML = `
    <div class="bc-row bc-head">
      <span class="bc-brand">${esc(cardBrand(card.number))}</span>
      ${wifi}
    </div>
    <div class="bc-name">${esc(card.holder || card.label || 'Card')}</div>
    <div class="bc-num">${esc(num)}</div>
    <div class="bc-row bc-foot">
      <div class="bc-meta">
        <div><div class="bc-k">EXP</div><div class="bc-v">${esc(card.expiry || '—')}</div></div>
        <div><div class="bc-k">CVV</div><div class="bc-v">${cvv}</div></div>
      </div>
      <span class="bc-copy-hint">${revealed ? 'Tap to hide' : 'Tap to copy'}</span>
    </div>`;
  wrap.onclick = async () => {
    if (!window._cardRevealed) {
      const digits = (card.number || '').replace(/\D/g, '');
      if (digits) {
        const ok = await copyText(digits);
        toast(ok ? 'Card number copied' : 'Card number shown', ok ? 'success' : 'info');
      }
      window._cardRevealed = true;
    } else {
      window._cardRevealed = false;
    }
    renderBalanceCard();
  };
}

// --- Savings goal (pinned at the top of the Overview "Saving Plans" panel; see renderSavingPlans) ---
// "Saved" = tổng thu − tổng chi over all time = tiền mặt còn lại + tiền đã đầu tư.
function openGoal() {
  document.getElementById('goal-input').value = goal > 0 ? goal : '';
  document.getElementById('goal-overlay').style.display = 'flex';
  document.getElementById('goal-input').focus();
}
async function persistGoal() {
  const db = await openDB();
  await putMeta(db, 'goal', goal);
  db.close();
  document.getElementById('goal-overlay').style.display = 'none';
  toast(goal > 0 ? 'Savings goal set' : 'Goal cleared', 'success');
  render();
  scheduleSyncPush();
}
function saveGoal() {
  const v = parseAmount(document.getElementById('goal-input').value);
  goal = v > 0 ? v : 0;
  persistGoal();
}
function clearGoal() { goal = 0; persistGoal(); }

// --- 50/30/20 rule (Overview tab, scoped to the focus month) ---
// base = configured monthly income (incomeBase) if set, else the focus month's actual income.
// Expenses split by catClass into need/want/unclassified; the derived 'save' bucket = base − total spending.
function renderFifty(fm, targetId) {
  const wrap = document.getElementById(targetId);
  if (!wrap) return;
  const setupBtn = `<button class="btn-import fifty-setup-btn">⚙️ Configure</button>`;
  if (!fm) {
    wrap.innerHTML = `<div class="sec-head"><h3>⚖️ 50/30/20</h3>${setupBtn}</div><div class="muted">No expense data to analyze yet.</div>`;
    wrap.querySelector('.fifty-setup-btn').addEventListener('click', openClassify);
    return;
  }

  let need = 0, want = 0, uncl = 0, totalExp = 0;
  allData.forEach(d => {
    if (d.monthKey !== fm || !isExpense(d)) return;
    totalExp += d.amount;
    const b = catClass[d.category];
    if (b === 'need') need += d.amount;
    else if (b === 'want') want += d.amount;
    else uncl += d.amount;
  });
  const actualInc = allData.reduce((s, d) => s + ((d.monthKey === fm && isIncome(d)) ? d.amount : 0), 0);
  const usingBase = incomeBase > 0;
  const base = usingBase ? incomeBase : actualInc;
  const save = base - totalExp; // leftover (cash + invested) — the derived 20% bucket

  let body;
  if (base <= 0) {
    body = `<div class="muted">No base income set and no income recorded this month — click “Configure 50/30/20” to enter your base income.</div>`;
  } else {
    const pct = v => Math.round(v / base * 100);
    const rows = [fiftyBar('need', need, base), fiftyBar('want', want, base), fiftyBar('save', save, base)].join('');
    const unclChip = uncl > 0
      ? `<div class="fifty-uncl">⚠️ ${fmt(uncl)} (${pct(uncl)}%) of spending is unclassified — click to assign buckets</div>`
      : '';
    const baseNote = usingBase
      ? `Base: fixed income ${fmt(base)}/month`
      : `Base: actual income this month ${fmt(base)} · set a fixed amount in Configure for consistency`;
    body = `${rows}${unclChip}<div class="fifty-note">${baseNote}</div>`;
  }
  wrap.innerHTML = `<div class="sec-head"><h3>⚖️ 50/30/20 — ${monthKeyLabel(fm)}</h3>${setupBtn}</div>${body}`;
  wrap.querySelector('.fifty-setup-btn').addEventListener('click', openClassify);
  const uel = wrap.querySelector('.fifty-uncl');
  if (uel) uel.addEventListener('click', openClassify);
}

// One 50/30/20 bar: actual amount + % vs the bucket's target %. need/want over-target is bad; save under-target is bad.
function fiftyBar(bucket, amount, base) {
  const target = FIFTY_TARGET[bucket];
  const actualPct = base > 0 ? amount / base * 100 : 0;
  const width = Math.max(0, Math.min(100, actualPct));
  let color = BUCKET_COLOR[bucket], warn = false;
  if (bucket === 'save') { if (actualPct < target) { warn = true; color = actualPct < target * 0.5 ? '#ef4444' : '#f59e0b'; } }
  else { if (actualPct > target) { warn = true; color = actualPct > target * 1.2 ? '#ef4444' : '#f59e0b'; } }
  return `<div class="bud-row">
    <div class="bud-top"><span>${BUCKET_LABEL[bucket]}${warn ? ' ⚠️' : ''}</span><span class="bud-nums" style="color:${color}">${fmt(amount)} · ${actualPct.toFixed(0)}% <span style="color:var(--text-3)">/ ${target}%</span></span></div>
    <div class="bud-bar fifty-track" style="--target:${target}%"><div class="bud-fill" style="transform:scaleX(${width/100});background:${color}"></div></div>
  </div>`;
}

function openClassify() {
  document.getElementById('class-income').value = incomeBase > 0 ? incomeBase : '';
  const cats = [...new Set(allData.filter(isExpense).map(d => d.category))].sort();
  const fields = document.getElementById('class-fields');
  if (!cats.length) {
    fields.innerHTML = '<div class="muted">No expense categories yet — import or add an expense first.</div>';
  } else {
    fields.innerHTML = cats.map(c => {
      const cur = catClass[c] || '';
      const opt = (v, label) => `<option value="${v}"${cur === v ? ' selected' : ''}>${label}</option>`;
      return `<label title="${esc(c)}">${esc(c)}</label><select data-cat="${esc(c)}">${opt('', '— None —')}${opt('need', 'Need')}${opt('want', 'Want')}</select>`;
    }).join('');
  }
  document.getElementById('class-overlay').style.display = 'flex';
}

// Fill every still-unclassified category with a keyword-based guess; leave the user's existing choices alone.
function suggestClassify() {
  let n = 0;
  document.querySelectorAll('#class-fields select[data-cat]').forEach(sel => {
    if (sel.value) return;
    const g = guessBucket(sel.dataset.cat);
    if (g) { sel.value = g; n++; }
  });
  toast(n ? `Suggested ${n} categories — review then Save` : 'Could not guess any category — choose manually', n ? 'info' : 'warn');
}

async function saveClassify() {
  incomeBase = parseAmount(document.getElementById('class-income').value) || 0;
  // Mutate in place so buckets for categories NOT shown in this modal (e.g. empty registry categories
  // assigned via the Categories manager) are preserved rather than wiped.
  document.querySelectorAll('#class-fields select[data-cat]').forEach(sel => {
    if (sel.value === 'need' || sel.value === 'want') catClass[sel.dataset.cat] = sel.value;
    else delete catClass[sel.dataset.cat];
  });
  const db = await openDB();
  await putMeta(db, 'catClass', catClass);
  await putMeta(db, 'incomeBase', incomeBase);
  db.close();
  document.getElementById('class-overlay').style.display = 'none';
  toast('50/30/20 settings saved', 'success');
  render();
  scheduleSyncPush();
}

// Flag expense transactions whose name keywords imply a different bucket and/or a better-fitting
// existing category than where they're filed. Advisory only — clicking a row opens the editor with the
// suggested category preselected so the user confirms (no silent data changes).
let misclassSuggest = {}; // { [id]: { cat } } — rebuilt each render; read by window.fixCat
function renderMisclass(targetId) {
  const wrap = document.getElementById(targetId);
  if (!wrap) return;
  misclassSuggest = {};
  const flagged = [];
  for (const d of allData) {
    if (!isExpense(d) || d.id == null) continue;
    const g = matchGroup(d.name);
    if (!g) continue;

    const curBucket = catClass[d.category] || null;
    const betterCat = suggestCatForGroup(g, d.category);
    if (!betterCat) continue; // Only flag if there is a suggested better category

    const sugBucket = catClass[betterCat] || null;
    flagged.push({ d, curBucket, sugCat: betterCat, sugBucket: sugBucket || g.bucket });
  }
  if (!flagged.length) { wrap.innerHTML = ''; wrap.style.display = 'none'; return; }
  wrap.style.display = '';
  flagged.sort((a, b) => b.d.amount - a.d.amount);
  const shown = flagged.slice(0, 8);

  const bLabel = b => b ? BUCKET_LABEL[b] : 'unclassified';
  const rows = shown.map(f => {
    misclassSuggest[f.d.id] = { cat: f.sugCat || f.d.category };
    const curPart = `${esc(f.d.category)} <span style="color:var(--text-2)">(${bLabel(f.curBucket)})</span>`;
    const sugPart = f.sugCat
      ? `${esc(f.sugCat)} <span style="color:var(--text-2)">(${bLabel(catClass[f.sugCat] || f.sugBucket)})</span>`
      : `bucket <b style="color:${BUCKET_COLOR[f.sugBucket]}">${BUCKET_LABEL[f.sugBucket]}</b>`;
    return `<div class="mis-row" onclick="window.fixCat(${f.d.id})" title="Click to edit">
      <div class="mis-name">${esc(f.d.name) || '—'} <span class="mis-amt">${fmt(f.d.amount)}</span></div>
      <div class="mis-move">now: ${curPart} <span class="mis-arrow">→</span> suggested: ${sugPart}</div>
    </div>`;
  }).join('');
  const more = flagged.length > shown.length ? `<div class="fifty-note">… and ${flagged.length - shown.length} more transactions</div>` : '';
  wrap.innerHTML = `<div class="sec-head"><h3>⚠️ Possibly miscategorized (${flagged.length})</h3></div>${rows}${more}`;
}
window.fixCat = (id) => { const s = misclassSuggest[id]; openEditor(id, s ? s.cat : undefined); };

// --- Budgets & insights (the "focus month" follows the month filter, else the latest month) ---
function focusMonth() {
  if (monthFilter.value !== 'all') return monthFilter.value;
  const months = [...new Set(allData.filter(isExpense).map(d => d.monthKey))].filter(m => m !== 'Unknown').sort();
  return months[months.length - 1] || null;
}
function prevMonthKey(mk) {
  const [y, m] = mk.split('-').map(Number);
  const d = new Date(y, m - 1, 1); d.setMonth(d.getMonth() - 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}
function monthKeyLabel(mk) {
  if (!mk) return '—';
  const [y, m] = mk.split('-').map(Number);
  return new Date(y, m - 1).toLocaleString('en-US', { month: 'long', year: 'numeric' });
}
function monthName(mk) { return monthKeyLabel(mk).split(' ')[0]; }
// Short month label for chart axes, e.g. "2026-06" -> "Jun".
function monthShort(mk) {
  if (!mk) return '';
  const [y, m] = mk.split('-').map(Number);
  return new Date(y, m - 1).toLocaleString('en-US', { month: 'short' });
}
function spentInMonth(mk, cat) {
  return allData.reduce((s, d) => s + ((d.monthKey === mk && isExpense(d) && (!cat || d.category === cat)) ? d.amount : 0), 0);
}

function budgetBar(label, spent, limit, extraClass = '') {
  const pct = limit ? Math.min(100, spent / limit * 100) : 0;
  const over = spent > limit, near = !over && spent >= limit * 0.8;
  const color = over ? '#ef4444' : near ? '#f59e0b' : '#22c55e';
  return `<div class="bud-row ${extraClass}">
    <div class="bud-top"><span>${label}${over ? ' ⚠️' : ''}</span><span class="bud-nums" style="color:${color}">${fmt(spent)} / ${fmt(limit)}</span></div>
    <div class="bud-bar"><div class="bud-fill" style="transform:scaleX(${pct/100});background:${color}"></div></div>
  </div>`;
}

// `editable` (Settings) renders the inline editor; otherwise (Overview) read-only progress bars.
// Order follows the budgets object's own key order = the user's drag-sorted order (no alpha sort).
function renderBudgets(targetId, editable = false) {
  const wrap = document.getElementById(targetId);
  if (!wrap) return;
  const mk = focusMonth();
  const cats = Object.keys(budgets).filter(c => budgets[c] > 0); // filter guards against stray 0s
  if (editable) { renderBudgetsEditor(wrap, mk, cats); return; }
  let body, footer = '';
  if (!mk || !cats.length) {
    body = `<div class="muted">No budgets yet — set spending limits per category in Settings.</div>`;
  } else {
    // Overview: collapse a long list to the first few (user's drag order) with a "Show all" toggle so
    // the panel can't run miles long. The Total row always reflects the real month-wide figure.
    const COLLAPSE_N = 6;
    const collapsible = targetId === 'ov-budgets' && cats.length > COLLAPSE_N;
    const shown = (collapsible && !ovBudgetsExpanded) ? cats.slice(0, COLLAPSE_N) : cats;
    body = shown.map(c => budgetBar(esc(c), spentInMonth(mk, c), budgets[c])).join('');
    // Total row: total spent this month (all categories) vs the sum of category budgets.
    const totalBudget = cats.reduce((s, c) => s + budgets[c], 0);
    body += budgetBar('Total', spentInMonth(mk), totalBudget, 'bud-total');
    if (collapsible) footer = `<button class="bud-toggle" id="${targetId}-toggle">${ovBudgetsExpanded ? 'Show less' : `Show all ${cats.length} categories`}</button>`;
  }
  wrap.innerHTML = `<div class="sec-head"><h3>Budgets${mk ? ' — ' + monthKeyLabel(mk) : ''}</h3></div><div class="scroll-box">${body}</div>${footer}`;
  const tog = document.getElementById(`${targetId}-toggle`);
  if (tog) tog.addEventListener('click', () => { ovBudgetsExpanded = !ovBudgetsExpanded; renderBudgets(targetId, editable); });
}

// One inline-editable, drag-sortable budget row (Settings only). The limit lives in the input;
// the bar/number show only this month's spend, coloured the same way budgetBar does.
function budgetEditRow(c, mk) {
  const spent = spentInMonth(mk, c), limit = budgets[c];
  const pct = limit ? Math.min(100, spent / limit * 100) : 0;
  const over = spent > limit, near = !over && spent >= limit * 0.8;
  const color = over ? '#ef4444' : near ? '#f59e0b' : '#22c55e';
  return `<div class="bud-erow" data-cat="${esc(c)}">
    <span class="bud-drag" draggable="true" title="Drag to reorder">⠿</span>
    <div class="bud-erow-main">
      <div class="bud-top"><span>${esc(c)}${over ? ' ⚠️' : ''}</span><span class="bud-nums" style="color:${color}">${fmt(spent)}</span></div>
      <div class="bud-bar"><div class="bud-fill" style="transform:scaleX(${pct/100});background:${color}"></div></div>
    </div>
    <input class="bud-elimit" type="number" min="0" step="any" inputmode="numeric" data-cat="${esc(c)}" value="${limit}" title="Monthly limit (đ) — clear to remove">
    <button class="bud-edel" data-cat="${esc(c)}" title="Remove this budget">✕</button>
  </div>`;
}

// Inline budgets editor that replaces the old #budget-overlay modal: edit limits in place,
// drag rows to reorder, ✨ Suggest gap-fills empty categories, and the add-row funds a new one.
function renderBudgetsEditor(wrap, mk, cats) {
  const allExp = [...new Set(allData.filter(isExpense).map(d => d.category))].sort();
  const unbudgeted = allExp.filter(c => !(budgets[c] > 0));
  let rows;
  if (!cats.length) {
    rows = `<div class="muted">No budgets yet — add one below or click “✨ Suggest”.</div>`;
  } else {
    rows = cats.map(c => budgetEditRow(c, mk)).join('');
    const totalBudget = cats.reduce((s, c) => s + budgets[c], 0);
    rows += budgetBar('Total', spentInMonth(mk), totalBudget, 'bud-total');
  }
  const addOpts = unbudgeted.length
    ? '<option value="">Add a category…</option>' + unbudgeted.map(c => `<option value="${esc(c)}">${esc(c)}</option>`).join('')
    : '<option value="">All categories budgeted</option>';
  const dis = unbudgeted.length ? '' : ' disabled';
  wrap.innerHTML =
    `<div class="sec-head"><h3>Budgets${mk ? ' — ' + monthKeyLabel(mk) : ''}</h3><button class="btn-import bud-suggest-btn">✨ Suggest</button></div>` +
    `<div class="scroll-box bud-edit-list">${rows}</div>` +
    `<div class="bud-add"><select class="bud-add-cat"${dis}>${addOpts}</select>` +
    `<input class="bud-add-amt" type="number" min="0" step="any" inputmode="numeric" placeholder="Limit đ"${dis}>` +
    `<button class="side-act bud-add-btn"${dis}>➕ Add</button></div>`;

  wrap.querySelector('.bud-suggest-btn').addEventListener('click', suggestBudgetsInline);
  // Edit a limit on blur; clearing it (→0) removes that budget. Names live in data-cat, not handlers.
  wrap.querySelectorAll('.bud-elimit').forEach(inp =>
    inp.addEventListener('change', () => setBudget(inp.dataset.cat, inp.value)));
  wrap.querySelectorAll('.bud-edel').forEach(btn =>
    btn.addEventListener('click', () => setBudget(btn.dataset.cat, 0)));
  const addBtn = wrap.querySelector('.bud-add-btn');
  if (addBtn && !addBtn.disabled) addBtn.addEventListener('click', () => {
    const cat = wrap.querySelector('.bud-add-cat').value;
    if (!cat) { toast('Pick a category to budget', 'warn'); return; }
    const v = parseAmount(wrap.querySelector('.bud-add-amt').value);
    if (!(v > 0)) { toast('Enter a limit greater than 0', 'warn'); return; }
    setBudget(cat, v);
  });

  // Drag-to-reorder (HTML5 DnD, no library): only the ⠿ handle is the drag source (so the limit
  // input stays fully editable); rows are the drop zones. New order rides in the budgets key order.
  let dragCat = null;
  wrap.querySelectorAll('.bud-drag').forEach(handle => {
    handle.addEventListener('dragstart', e => {
      const row = handle.closest('.bud-erow');
      dragCat = row.dataset.cat;
      row.classList.add('bud-dragging');
      e.dataTransfer.effectAllowed = 'move';
      e.dataTransfer.setData('text/plain', dragCat); // Firefox needs data set to start a drag
    });
    handle.addEventListener('dragend', () => { dragCat = null; wrap.querySelectorAll('.bud-erow').forEach(r => r.classList.remove('bud-dragging', 'bud-drop')); });
  });
  wrap.querySelectorAll('.bud-erow').forEach(row => {
    row.addEventListener('dragover', e => { if (!dragCat) return; e.preventDefault(); e.dataTransfer.dropEffect = 'move'; });
    row.addEventListener('dragenter', () => { if (dragCat && row.dataset.cat !== dragCat) row.classList.add('bud-drop'); });
    row.addEventListener('dragleave', () => row.classList.remove('bud-drop'));
    row.addEventListener('drop', e => { e.preventDefault(); row.classList.remove('bud-drop'); reorderBudget(dragCat, row.dataset.cat); });
  });
}

async function persistBudgets() {
  const db = await openDB();
  await putMeta(db, 'budgets', budgets);
  db.close();
  render();
  scheduleSyncPush();
}

// Set (or clear, when val<=0) one category's monthly limit, then persist + re-render.
async function setBudget(cat, val) {
  const v = parseAmount(val);
  if (v > 0) budgets[cat] = v; else delete budgets[cat];
  await persistBudgets();
}

// Move dragged category `from` to sit in front of drop target `to`, rebuilding budgets' key order.
async function reorderBudget(from, to) {
  if (!from || !to || from === to) return;
  const order = Object.keys(budgets).filter(k => k !== from);
  const at = order.indexOf(to);
  order.splice(at < 0 ? order.length : at, 0, from);
  budgets = Object.fromEntries(order.map(k => [k, budgets[k]]));
  await persistBudgets();
}

// Gap-fill: give each expense category WITHOUT a budget its average monthly spend (rounded to 1.000đ).
// Non-destructive — existing limits are kept, so nothing is overwritten without an explicit edit.
function suggestBudgetsInline() {
  const n = [...new Set(allData.filter(isExpense).map(d => d.monthKey))].filter(m => m !== 'Unknown').length || 1;
  const allExp = [...new Set(allData.filter(isExpense).map(d => d.category))];
  let added = 0;
  allExp.forEach(cat => {
    if (budgets[cat] > 0) return;
    const total = allData.reduce((s, d) => s + ((d.category === cat && isExpense(d)) ? d.amount : 0), 0);
    const avg = Math.round(total / n / 1000) * 1000;
    if (avg > 0) { budgets[cat] = avg; added++; }
  });
  if (!added) { toast('Every category already has a budget — edit any limit inline', 'info'); return; }
  toast(`Suggested budgets for ${added} categor${added === 1 ? 'y' : 'ies'} — edit any inline`, 'success');
  persistBudgets();
}

function openBudgets() {
  const cats = [...new Set(allData.filter(isExpense).map(d => d.category))].sort(); // budgets are spending-only
  const fields = document.getElementById('budget-fields');
  if (!cats.length) {
    fields.innerHTML = '<div class="muted">No categories yet — import or add transactions first.</div>';
  } else {
    fields.innerHTML = cats.map(c =>
      `<label>${esc(c)}</label><input type="number" min="0" step="any" data-cat="${esc(c)}" value="${budgets[c] || ''}" placeholder="0">`
    ).join('');
  }
  document.getElementById('budget-overlay').style.display = 'flex';
}

async function saveBudgetsModal() {
  const next = {};
  document.querySelectorAll('#budget-fields input[data-cat]').forEach(i => {
    const v = parseAmount(i.value);
    if (v > 0) next[i.dataset.cat] = v;
  });
  budgets = next;
  const db = await openDB();
  await putMeta(db, 'budgets', budgets);
  db.close();
  document.getElementById('budget-overlay').style.display = 'none';
  toast('Budgets saved', 'success');
  render();
  scheduleSyncPush();
}

// Fill each budget input with that category's average spend per month (rounded to 1.000đ).
function suggestBudgets() {
  const n = [...new Set(allData.filter(isExpense).map(d => d.monthKey))].filter(m => m !== 'Unknown').length || 1;
  document.querySelectorAll('#budget-fields input[data-cat]').forEach(i => {
    const cat = i.dataset.cat;
    const total = allData.reduce((s, d) => s + ((d.category === cat && isExpense(d)) ? d.amount : 0), 0);
    const avg = Math.round(total / n / 1000) * 1000;
    i.value = avg || '';
  });
  toast(`Suggested from ${n} month(s) of spending — review then Save`, 'info');
}

// --- Categories manager (Settings page) ---
// Inline editable list of every category: rename (edit + blur), merge (Move to…), assign a 50/30/20
// bucket, add a new (possibly empty) category, or delete an empty one. Categories come from the data
// plus the persisted registry (catReg) so empty/user-created ones survive reloads.
function renderCategoriesManager() {
  const box = document.getElementById('cat-manager');
  if (!box) return;
  const stat = {}; // name -> { count, total, type }
  allData.forEach(d => {
    const s = stat[d.category] || (stat[d.category] = { count: 0, total: 0, type: typeOf(d) });
    s.count++; s.total += d.amount;
  });
  Object.keys(catReg).forEach(name => { if (!stat[name]) stat[name] = { count: 0, total: 0, type: catReg[name] }; });
  // Surface the seed suggestions (same lists the Add/Edit dropdown offers) as empty rows too, so old
  // categories can be merged INTO them via "Move to…" and given a 50/30/20 bucket before any data exists.
  const SEED_CATS = { expense: EXPENSE_CATS, income: INCOME_CATS, invest: INVEST_CATS };
  ['expense', 'income', 'invest'].forEach(t => SEED_CATS[t].forEach(name => { if (!stat[name]) stat[name] = { count: 0, total: 0, type: t }; }));

  const groups = { expense: [], income: [], invest: [] };
  Object.keys(stat).forEach(name => { (groups[stat[name].type] || groups.expense).push(name); });
  const GLABEL = { expense: 'Expense', income: 'Income', invest: 'Investment' };

  let html = '';
  ['expense', 'income', 'invest'].forEach(t => {
    const names = groups[t].sort((a, b) => stat[b].total - stat[a].total || a.localeCompare(b));
    html += `<div class="cat-mgr-group"><div class="cat-mgr-gh">${GLABEL[t]} (${names.length})</div>`;
    names.forEach(name => {
      const s = stat[name];
      const mergeOpts = ['<option value="">Move to…</option>']
        .concat(names.filter(n => n !== name).map(n => `<option value="${esc(n)}">→ ${esc(n)}</option>`)).join('');
      const bucket = t === 'expense'
        ? `<select class="cat-bucket" data-cat="${esc(name)}">` +
            ['', 'need', 'want'].map(b => `<option value="${b}"${(catClass[name] || '') === b ? ' selected' : ''}>${b === '' ? '50/30/20…' : b === 'need' ? 'Need' : 'Want'}</option>`).join('') +
          `</select>`
        : '';
      html += `<div class="cat-row">` +
        `<input class="cat-name" data-orig="${esc(name)}" value="${esc(name)}" autocomplete="off">` +
        `<span class="cat-stat">${s.count} txn · ${fmt(s.total)}</span>` +
        bucket +
        `<select class="cat-merge" data-cat="${esc(name)}">${mergeOpts}</select>` +
        `<button class="cat-del" data-cat="${esc(name)}" title="Delete (only when the category is empty)">✕</button>` +
      `</div>`;
    });
    html += `<div class="cat-add"><input class="cat-add-input" data-type="${t}" placeholder="Add ${GLABEL[t].toLowerCase()} category…" autocomplete="off"><button class="side-act cat-add-btn" data-type="${t}">➕ Add</button></div>`;
    html += `</div>`;
  });
  box.innerHTML = html;

  // Summary line on the Settings card (the list itself lives in the #cats-overlay modal).
  const sum = document.getElementById('cats-summary');
  if (sum) sum.textContent = `${groups.expense.length} expense · ${groups.income.length} income · ${groups.invest.length} investment categories.`;

  // Wire via dataset (never embed category names in inline handlers — keeps the XSS surface closed).
  box.querySelectorAll('.cat-name').forEach(inp => inp.addEventListener('change', () => catRename(inp.dataset.orig, inp.value)));
  box.querySelectorAll('.cat-bucket').forEach(sel => sel.addEventListener('change', () => catSetBucket(sel.dataset.cat, sel.value)));
  box.querySelectorAll('.cat-merge').forEach(sel => sel.addEventListener('change', () => { if (sel.value) catMerge(sel.dataset.cat, sel.value); }));
  box.querySelectorAll('.cat-del').forEach(btn => btn.addEventListener('click', () => catDelete(btn.dataset.cat)));
  box.querySelectorAll('.cat-add-btn').forEach(btn => btn.addEventListener('click', () => {
    const inp = box.querySelector('.cat-add-input[data-type="' + btn.dataset.type + '"]');
    catAdd(inp.value, btn.dataset.type);
  }));
  box.querySelectorAll('.cat-add-input').forEach(inp => inp.addEventListener('keydown', e => { if (e.key === 'Enter') catAdd(inp.value, inp.dataset.type); }));
}

async function catSetBucket(name, bucket) {
  if (bucket === 'need' || bucket === 'want') catClass[name] = bucket;
  else delete catClass[name];
  const db = await openDB(); await putMeta(db, 'catClass', catClass); db.close();
  toast('50/30/20 bucket saved', 'success');
  scheduleSyncPush();
}

async function catAdd(rawName, type) {
  const name = (rawName || '').trim();
  if (!name) { toast('Enter a category name', 'warn'); return; }
  if (allData.some(d => d.category === name) || catReg[name]) { toast('Category already exists', 'warn'); return; }
  catReg[name] = (type === 'income' || type === 'invest') ? type : 'expense';
  const db = await openDB(); await putMeta(db, 'cats', catReg); db.close();
  toast(`Added "${name}"`, 'success');
  renderCategoriesManager();
  scheduleSyncPush();
}

async function catDelete(name) {
  const count = allData.filter(d => d.category === name).length;
  if (count > 0) { toast(`"${name}" still has ${count} transactions — use “Move to…” to merge before deleting`, 'warn'); renderCategoriesManager(); return; }
  if (!confirm(`Delete category "${name}"?`)) { renderCategoriesManager(); return; }
  delete catReg[name]; delete catClass[name]; delete budgets[name];
  const db = await openDB();
  await putMeta(db, 'cats', catReg);
  await putMeta(db, 'catClass', catClass);
  await putMeta(db, 'budgets', budgets);
  db.close();
  toast(`Deleted "${name}"`, 'success');
  renderCategoriesManager();
  scheduleSyncPush();
}

async function catRename(oldName, rawNew) {
  const newName = (rawNew || '').trim();
  if (!newName || newName === oldName) { renderCategoriesManager(); return; } // revert empty / no-op
  await applyCategoryRenames([[oldName, newName]]);
}

function catMerge(name, target) {
  if (!target || target === name) { renderCategoriesManager(); return; }
  if (!confirm(`Merge "${name}" into "${target}"? All transactions will move to "${target}".`)) { renderCategoriesManager(); return; }
  applyCategoryRenames([[name, target]]);
}

// Apply category renames/merges across records + registry + budgets + 50/30/20. Clear-then-rewrite so the
// unique fingerprint index never sees a transient collision; identical rows after a rename merge (drop dup).
async function applyCategoryRenames(renames) {
  renames = renames.filter(([o, n]) => n && n !== o);
  if (!renames.length) return;
  const map = new Map(renames);
  const db = await openDB();
  const all = await getAll(db);
  const seen = new Set();
  const out = [];
  let merged = 0;
  for (const r of all) {
    const newCat = map.get(r.category) || r.category;
    const newFp = newCat === r.category ? r.fingerprint
      : fingerprint({ name: r.name, amount: r.amount, category: newCat, dateStr: r.dateStr });
    if (seen.has(newFp)) { merged++; continue; } // identical row after rename → merge (drop dup)
    seen.add(newFp);
    out.push({ ...r, category: newCat, fingerprint: newFp });
  }
  try {
    const tx = db.transaction(STORE, 'readwrite');
    const store = tx.objectStore(STORE);
    store.clear();
    out.forEach(r => store.put(r)); // put keeps each record's id
    await new Promise((res, rej) => { tx.oncomplete = res; tx.onerror = () => rej(tx.error); });
  } catch (e) {
    db.close();
    toast('Rename failed — try again', 'warn');
    return;
  }
  // Carry budgets (sum on merge), 50/30/20 (existing target wins), and registry to the new names.
  for (const [oldN, newN] of renames) {
    if (budgets[oldN] != null) { budgets[newN] = (budgets[newN] || 0) + budgets[oldN]; delete budgets[oldN]; }
    if (catClass[oldN] != null) { if (catClass[newN] == null) catClass[newN] = catClass[oldN]; delete catClass[oldN]; }
    if (catReg[oldN] != null) { if (catReg[newN] == null && !out.some(r => r.category === newN)) catReg[newN] = catReg[oldN]; delete catReg[oldN]; }
  }
  await putMeta(db, 'budgets', budgets);
  await putMeta(db, 'catClass', catClass);
  await putMeta(db, 'cats', catReg);
  db.close();
  toast(`Updated ${renames.length} categories${merged ? ` · merged ${merged} duplicates` : ''}`, 'success');
  await reloadPreservingFilters();
  scheduleSyncPush();
}

// --- Backup / Restore (full JSON snapshot of every record) ---
function getDebts() { return Array.isArray(debts) ? debts : []; }
function backupJSON() {
  if (!allData.length) { toast('No data to back up', 'warn'); return; }
  const records = allData.map(({ id, ...r }) => r); // drop autoincrement id; fingerprint dedups on restore
  const payload = { app: 'spendy', version: 1, records, budgets, goal, catClass, incomeBase, cats: catReg, plans: getPlans(), debts: getDebts(), ccPaidFps, ccNoteFps, cards: getCards(), pinnedCard: pinnedCardId };
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `spendy-backup-${new Date().toISOString().slice(0, 10)}.json`;
  document.body.appendChild(a); a.click(); a.remove();
  URL.revokeObjectURL(url);
  toast(`Backed up ${records.length} records`, 'success');
}

let pendingRestore = null; // parsed-but-not-yet-written restore, awaiting the user's confirmation

// Phase 1: parse + validate the file and stage the merge, then ask the user to confirm.
async function restoreJSON(text) {
  let payload;
  try { payload = JSON.parse(text); } catch (e) { toast('Invalid JSON file', 'warn'); return; }
  const records = Array.isArray(payload) ? payload : (payload && payload.records);
  // Reject anything that isn't recognizably a Spendy backup before touching the DB.
  if (!Array.isArray(records)) { toast('Not a Spendy backup (missing "records" array)', 'warn'); return; }
  if (!records.length) { toast('Backup file has no records', 'warn'); return; }
  if (!Array.isArray(payload) && typeof payload.app === 'string' && payload.app !== 'spendy') {
    toast(`This file belongs to app "${payload.app}", not Spendy`, 'warn'); return;
  }

  const db = await openDB();
  const existing = await getFingerprints(db);
  db.close();
  // Re-derive each record through makeRecord so older/edited backups stay consistent.
  const incoming = records.map(r => makeRecord({
    name: (r.name || '').trim(),
    amount: Number(r.amount) || 0,
    category: r.category || 'Uncategorized',
    method: r.method || '',
    date: parseDate(r.date != null ? r.date : r.dateStr), // parseDate returns null for missing/invalid
    type: r.type,
    image: r.image || null,
    installments: r.installments || null
  }));
  const fresh = incoming.filter(r => !existing.has(r.fingerprint));
  const budgets = (!Array.isArray(payload) && payload.budgets && typeof payload.budgets === 'object') ? payload.budgets : null;
  const goal = (!Array.isArray(payload) && typeof payload.goal === 'number' && payload.goal > 0) ? payload.goal : null;
  const catClass = (!Array.isArray(payload) && payload.catClass && typeof payload.catClass === 'object') ? payload.catClass : null;
  const incomeBase = (!Array.isArray(payload) && typeof payload.incomeBase === 'number' && payload.incomeBase > 0) ? payload.incomeBase : null;
  const cats = (!Array.isArray(payload) && payload.cats && typeof payload.cats === 'object') ? payload.cats : null;
  const plans = (!Array.isArray(payload) && Array.isArray(payload.plans)) ? payload.plans : null;
  const debts = (!Array.isArray(payload) && Array.isArray(payload.debts)) ? payload.debts : null;
  const ccPaid = (!Array.isArray(payload) && Array.isArray(payload.ccPaidFps)) ? payload.ccPaidFps : null;
  const ccNote = (!Array.isArray(payload) && payload.ccNoteFps && typeof payload.ccNoteFps === 'object') ? payload.ccNoteFps : null;
  const cardsList = (!Array.isArray(payload) && Array.isArray(payload.cards)) ? payload.cards : null;
  const pinnedCard = (!Array.isArray(payload) && typeof payload.pinnedCard === 'string') ? payload.pinnedCard : null;
  pendingRestore = { fresh, total: incoming.length, budgets, goal, catClass, incomeBase, cats, plans, debts, ccPaid, ccNote, cards: cardsList, pinnedCard };

  // Summarise exactly what will happen and wait for confirmation (numbers only — safe to innerHTML).
  const lines = [`File has <b>${incoming.length}</b> records: <b style="color:#22c55e">${fresh.length} new</b> will be added, ${incoming.length - fresh.length} already present.`];
  if (budgets) lines.push(`Overwrite <b>budgets</b> (${Object.keys(budgets).length} categories).`);
  if (goal != null) lines.push(`Set <b>savings goal</b> = ${fmt(goal)}.`);
  if (catClass) lines.push(`Overwrite <b>50/30/20 classification</b> (${Object.keys(catClass).length} categories).`);
  if (incomeBase != null) lines.push(`Set <b>base income</b> = ${fmt(incomeBase)}.`);
  if (cats) lines.push(`Overwrite <b>created categories</b> (${Object.keys(cats).length}).`);
  if (plans) lines.push(`Overwrite <b>saving plans</b> (${plans.length} plans).`);
  if (debts) lines.push(`Overwrite <b>debts & credit cards</b> (${debts.length} entries).`);
  if (cardsList) lines.push(`Overwrite <b>saved cards</b> (${cardsList.length}).`);
  if (ccNote) lines.push(`Overwrite <b>credit-card confirm notes</b> (${Object.keys(ccNote).length}).`);
  document.getElementById('restore-summary').innerHTML = lines.join('<br>');
  document.getElementById('restore-overlay').style.display = 'flex';
}

// Phase 2: commit the merge the user confirmed in the dialog.
async function commitRestore() {
  document.getElementById('restore-overlay').style.display = 'none';
  if (!pendingRestore) return;
  const { fresh, total, budgets: b, goal: g, catClass: cc, incomeBase: ib, cats: ct, plans: pl, debts: dt, ccPaid: ccp, ccNote: cn, cards: cds, pinnedCard: pc } = pendingRestore;
  pendingRestore = null;
  const db = await openDB();
  let added = 0;
  if (fresh.length) {
    const tx = db.transaction(STORE, 'readwrite');
    const store = tx.objectStore(STORE);
    for (const r of fresh) {
      const req = store.add(r);
      req.onsuccess = () => added++;
      // Skip a DUPLICATE fingerprint (ConstraintError) without aborting the batch; let any other error
      // (e.g. QuotaExceededError) abort the transaction so it surfaces instead of silently dropping the row.
      req.onerror = e => { if (req.error && req.error.name === 'ConstraintError') e.preventDefault(); };
    }
    // Resolve on oncomplete; reject only on a genuine ABORT. (A preventDefault'd per-request error still BUBBLES
    // to tx.onerror with tx.error === null — rejecting there would throw null on every duplicate-skip.)
    await new Promise((res, rej) => { tx.oncomplete = res; tx.onabort = () => rej(tx.error || new Error('transaction aborted')); });
  }
  if (b) await putMeta(db, 'budgets', b);
  if (g != null) await putMeta(db, 'goal', g);
  if (cc) await putMeta(db, 'catClass', cc);
  if (ib != null) await putMeta(db, 'incomeBase', ib);
  if (ct) await putMeta(db, 'cats', ct);
  if (pl) await putMeta(db, 'plans', pl);
  if (dt) await putMeta(db, 'debts', dt);
  if (ccp) await putMeta(db, 'ccPaidFps', ccp);
  if (cn) await putMeta(db, 'ccNoteFps', cn);
  if (cds) await putMeta(db, 'cards', cds);
  if (pc) await putMeta(db, 'pinnedCard', pc);
  // A restored OLD backup may contain legacy split rows ("Foo (k/N)"). Clear the one-time-merge flag so the
  // following loadFromDB re-runs mergeLegacyInstallments and collapses them (it's a conservative no-op otherwise).
  await putMeta(db, 'mergedInstallments', false);
  db.close();
  toast(`Restored ${added} new · ${total - added} already present`, 'success');
  await loadFromDB();
  scheduleSyncPush();
}

function buildFilters() {
  const months = new Set();
  const pred = view === 'overview' ? (() => true) : matchesView; // overview spans every type
  allData.filter(pred).forEach(d => { if(d.monthKey!=='Unknown') months.add(d.monthKey); });

  const mVal = monthFilter.value;
  monthFilter.innerHTML = '<option value="all">All Months</option>';
  [...months].sort().forEach(m => {
    const [y,mo] = m.split('-');
    monthFilter.innerHTML += `<option value="${m}">${new Date(+y,+mo-1).toLocaleString('en-US',{month:'long',year:'numeric'})}</option>`;
  });
  if ([...monthFilter.options].some(o => o.value === mVal)) {
    monthFilter.value = mVal;
  }

  const methods = new Set();
  let hasBlank = false;
  allData.filter(pred).forEach(d => {
    if (!d.method || !d.method.trim()) hasBlank = true;
    else methods.add(d.method.trim());
  });

  const pmVal = methodFilter.value;
  methodFilter.innerHTML = '<option value="all">All Methods</option>';
  if (hasBlank) {
    methodFilter.innerHTML += '<option value="">None (—)</option>';
  }
  [...methods].sort().forEach(pm => {
    methodFilter.innerHTML += `<option value="${esc(pm)}">${esc(pm)}</option>`;
  });
  if ([...methodFilter.options].some(o => o.value === pmVal)) {
    methodFilter.value = pmVal;
  }
}


// Escapes &<>"' so the result is safe in BOTH text and attribute (value="..."/title="...") contexts.
// (The old textContent-based version did not escape quotes, leaving attribute interpolations injectable.)
function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[c])); }
function fmt(n) {
  // Full number with Vietnamese thousands separators, e.g. 2000000 -> "2.000.000đ" (no M/K abbreviation)
  return Math.round(n).toLocaleString('vi-VN') + 'đ';
}
// Date display dd/mm/yyyy derived from the stored ISO dateStr. Display only — dateStr / monthKey /
// fingerprint stay ISO (changing them would break dedup), so we format here at render time.
function fmtDate(d) {
  const s = d && d.dateStr;
  if (!s) return '—';
  const [y, m, day] = s.split('-');
  return (y && m && day) ? `${day}/${m}/${y}` : '—';
}
// Compact đ for chart AXIS TICKS ONLY (full numbers stay in cards/tables/tooltips): 2,500,000 -> "2.5M".
function fmtShort(n) {
  const a = Math.abs(n);
  if (a >= 1e9) return +(n / 1e9).toFixed(1) + 'B';
  if (a >= 1e6) return +(n / 1e6).toFixed(1) + 'M';
  if (a >= 1e3) return Math.round(n / 1e3) + 'k';
  return '' + Math.round(n);
}
// Resolve a CSS custom property to its current value so charts follow the active light/dark theme.
function cssVar(name) { return getComputedStyle(document.documentElement).getPropertyValue(name).trim() || '#888'; }
// Month-over-month pill for a stat card. upIsGood flips the colour (income up = good, spending up = bad).
function momBadge(cur, prev, upIsGood) {
  if (!(prev > 0)) return '';
  const diff = cur - prev;
  if (diff === 0) return '<span class="badge badge-flat">0%</span>';
  const up = diff > 0;
  const cls = (up === upIsGood) ? 'badge-pos' : 'badge-neg';
  return `<span class="badge ${cls}">${up ? '▲' : '▼'} ${Math.abs(diff / prev * 100).toFixed(0)}%</span>`;
}

// --- Import ---
// `defaultType` = the tab the user imported from; rows without an explicit Type column inherit it.
async function handleCSV(text, defaultType) {
  const result = Papa.parse(text, { header: true, skipEmptyLines: true });
  if (result.errors && result.errors.length) console.warn('CSV parse errors:', result.errors); // log, but keep rows that did parse
  if (!result.data.length) { toast('CSV file is empty', 'warn'); return; }

  // Sanity-check the shape: a Notion/Spendy export has at least Name or Amount.
  const cols = (result.meta && result.meta.fields) || [];
  if (cols.length && !cols.includes('Name') && !cols.includes('Amount')) {
    toast('No Name/Amount column — is this a Notion/Spendy export?', 'warn');
    return;
  }

  // Process every row, tracking why rows get dropped so we can report it instead of silently losing them.
  let droppedEmpty = 0;
  const parsed = [];
  for (const r of result.data) {
    const rec = processRow(r, defaultType);
    if (!rec.name && !(rec.amount > 0)) { droppedEmpty++; continue; } // blank/garbage row: no name and no amount
    parsed.push(rec);
  }
  if (!parsed.length) {
    toast(`No valid rows${droppedEmpty ? ` · ${droppedEmpty} blank/invalid skipped` : ''}`, 'warn');
    return;
  }
  const undated = parsed.filter(r => r.monthKey === 'Unknown').length; // date column couldn't be parsed

  const db = await openDB();
  const existing = await getFingerprints(db);

  const newRecords = parsed.filter(r => !existing.has(r.fingerprint));
  const skipped = parsed.length - newRecords.length;

  if (!newRecords.length) {
    const extra = [];
    if (droppedEmpty) extra.push(`${droppedEmpty} bad rows`);
    if (undated) extra.push(`${undated} missing date`);
    toast(`0 new · ${skipped} duplicates (already imported)${extra.length ? ' · ' + extra.join(' · ') : ''}`, 'warn');
    db.close();
    return;
  }

  // Batch add
  const tx = db.transaction(STORE, 'readwrite');
  const store = tx.objectStore(STORE);
  let added = 0;
  for (const r of newRecords) {
    const req = store.add(r);
    req.onsuccess = () => added++;
    // A duplicate fingerprint (same row twice within one file) rejects this request with ConstraintError;
    // preventDefault keeps it from aborting the whole batch. Any OTHER error (e.g. quota) is left to abort & surface.
    req.onerror = e => { if (req.error && req.error.name === 'ConstraintError') e.preventDefault(); };
  }
  // Resolve on oncomplete; reject only on a genuine ABORT — a preventDefault'd duplicate still bubbles to
  // tx.onerror with tx.error === null, and rejecting there would throw null whenever a within-file dup is skipped.
  await new Promise((res, rej) => { tx.oncomplete = res; tx.onabort = () => rej(tx.error || new Error('transaction aborted')); });
  db.close();

  const tLabel = defaultType === 'income' ? 'income' : defaultType === 'invest' ? 'investment' : 'expense';
  let msg = `${added} new ${tLabel} · ${skipped} duplicates`;
  const extra = [];
  if (droppedEmpty) extra.push(`${droppedEmpty} bad rows skipped`);
  if (undated) extra.push(`${undated} missing/invalid date (excluded from monthly chart)`);
  if (extra.length) msg += ' · ' + extra.join(' · ');
  toast(msg, (droppedEmpty || undated) ? 'warn' : 'success');
  await loadFromDB();
  scheduleSyncPush();
}

// --- Edit / Add / Export ---
// loadFromDB() rebuilds the filter dropdowns (resetting them to "all"); this restores the user's
// current month/category/table selection afterwards so editing doesn't blow away their view.
async function reloadPreservingFilters() {
  const m = monthFilter.value, pm = methodFilter.value, pf = photoFilter.value, t = tableCat;
  await loadFromDB();
  if ([...monthFilter.options].some(o => o.value === m)) monthFilter.value = m;
  if ([...methodFilter.options].some(o => o.value === pm)) methodFilter.value = pm;
  if ([...photoFilter.options].some(o => o.value === pf)) photoFilter.value = pf;
  tableCat = t;
  render();
}

// Wipe everything — clears BOTH object stores (records + all meta: budgets/goal/catClass/incomeBase)
// for a clean re-sync. Irreversible; guarded by the #wipe-overlay confirmation modal.
async function wipeAllData() {
  const db = await openDB();
  try {
    const tx = db.transaction([STORE, 'meta'], 'readwrite');
    tx.objectStore(STORE).clear();
    tx.objectStore('meta').clear();
    await new Promise((res, rej) => { tx.oncomplete = res; tx.onerror = () => rej(tx.error); });
  } catch (e) {
    db.close();
    toast('Delete failed — try again', 'warn');
    return;
  }
  db.close();
  await loadFromDB(); // reloads empty → resets budgets/goal/catClass/incomeBase + shows empty state
  toast('All data deleted', 'success');
  scheduleSyncPush();
}

// Populate a <select> with the distinct existing values plus a "➕ New…" escape hatch that reveals
// the paired free-text input. Shared by Category and Payment Method in the edit/add modal.
function fillSelect(sel, newInput, values, current, allowBlank, allowNew = true) {
  const opts = [...new Set(values)].filter(Boolean).sort();
  if (current && !opts.includes(current)) opts.unshift(current);
  sel.innerHTML = '';
  if (allowBlank) {
    const b = document.createElement('option');
    b.value = ''; b.textContent = '— None —';
    sel.appendChild(b);
  }
  for (const v of opts) {
    const o = document.createElement('option');
    o.value = v; o.textContent = v;
    sel.appendChild(o);
  }
  if (allowNew) {
    const newOpt = document.createElement('option');
    newOpt.value = '__new__'; newOpt.textContent = '➕ New…';
    sel.appendChild(newOpt);
  }
  sel.value = current || (allowBlank ? '' : (opts[0] || (allowNew ? '__new__' : '')));
  if (newInput) toggleNew(sel, newInput);
}

// Category options offered for a given record type: that type's existing categories, plus the
// pre-seeded suggestions per type so the dropdown is useful before any data exists.
function refillCats(current) {
  const t = efType.value;
  let cats = allData.filter(d => typeOf(d) === t).map(d => d.category);
  cats = cats.concat(Object.keys(catReg).filter(c => catReg[c] === t)); // user-registered (incl. empty) categories
  if (t === 'invest') cats = cats.concat(INVEST_CATS);
  else if (t === 'income') cats = cats.concat(INCOME_CATS);
  else cats = cats.concat(EXPENSE_CATS);
  fillSelect(efCategory, efCategoryNew, cats, current, false);
}

// Show a select's paired free-text input only when "➕ New…" is picked.
function toggleNew(sel, newInput) {
  const isNew = sel.value === '__new__';
  newInput.style.display = isNew ? 'block' : 'none';
  if (!isNew) newInput.value = '';
}

// Effective value of a select + new-input pair.
function selectValue(sel, newInput) {
  return (sel.value === '__new__' && newInput) ? newInput.value.trim() : sel.value;
}

// Suggest a category from a transaction NAME. First learns from YOUR OWN history — the category you most
// often used for the same/similar name (so everyday items like "Phở bò" work, not just known brands) —
// then falls back to the keyword groups (KFC / Grab / Shopee…). Returns a category string or null.
function suggestCategory(name) {
  const n = norm(name);
  if (!n || n.length < 2) return null;
  const exact = {}, partial = {};
  for (const d of allData) {
    if (!isExpense(d) || !d.category) continue;
    const dn = norm(d.name);
    if (!dn) continue;
    if (dn === n) exact[d.category] = (exact[d.category] || 0) + 1;
    else if (dn.includes(n) || (dn.length >= 3 && n.includes(dn))) partial[d.category] = (partial[d.category] || 0) + 1;
  }
  const top = obj => (Object.entries(obj).sort((a, b) => b[1] - a[1])[0] || [null])[0];
  const fromHistory = top(exact) || top(partial);
  if (fromHistory) return fromHistory;
  const g = matchGroup(name); // fallback: known merchants / keywords
  if (!g) return null;
  return suggestCatForGroup(g, null) || (g.cat && g.cat[0]) || null;
}
// Inline "💡 Gợi ý: X" chip under the modal Category field — updates as you type the name. Only for
// expense/debt (the keyword groups are expense-oriented); hidden when it matches the chosen category.
function updateCatSuggest() {
  const box = document.getElementById('ef-cat-suggest');
  if (!box) return;
  const t = efType.value;
  const sug = (t === 'expense' || t === 'debt') ? suggestCategory(efName.value) : null;
  const current = selectValue(efCategory, efCategoryNew);
  if (!sug || norm(sug) === norm(current)) { box.style.display = 'none'; box.innerHTML = ''; return; }
  box.style.display = 'flex';
  box.innerHTML = `💡 Gợi ý: <button type="button" class="cat-sug-chip">${esc(sug)}</button>`;
  box.querySelector('.cat-sug-chip').addEventListener('click', () => applyCatSuggest(sug));
}
function applyCatSuggest(cat) {
  if ([...efCategory.options].some(o => o.value === cat)) {
    efCategory.value = cat;
    toggleNew(efCategory, efCategoryNew);
  } else {                                    // not an existing option → create it via the New… path
    efCategory.value = '__new__';
    toggleNew(efCategory, efCategoryNew);
    efCategoryNew.value = cat;
  }
  updateCatSuggest();                         // current now equals the suggestion → chip hides
}
// Warn when the amount looks too small: VND is in thousands, so a value under 1.000đ is almost always a
// missing trailing "000" (e.g. typing 30 instead of 30000). Non-blocking — just a hint, saving still works.
function updateAmountWarn() {
  const box = document.getElementById('ef-amount-warn');
  if (!box) return;
  const v = parseAmount(efAmount.value);
  if (v > 0 && v < 1000) {
    box.style.display = 'flex';
    box.innerHTML = '⚠️ Dưới 1.000đ — có thể bạn quên thêm số 0? (vd 30 → 30.000)';
  } else {
    box.style.display = 'none';
    box.innerHTML = '';
  }
}

// Payment-plan picker — shown when ADDING any credit-card transaction (a saved card OR generic "Credit Card").
// The choice is PER TRANSACTION, not per card: each entry independently picks "Mua trước trả sau" (one txn, due
// at the next statement) or "Trả góp" (N≥2 → split into N txns across consecutive statement cycles).
function getPayMode() {
  const b = document.querySelector('#ef-pay-mode .stat-tab.active');
  return b ? b.dataset.mode : 'once';
}
function setPayMode(mode) {
  document.querySelectorAll('#ef-pay-mode .stat-tab').forEach(b => b.classList.toggle('active', b.dataset.mode === mode));
  const row = document.getElementById('ef-install-row');
  if (row) row.style.display = mode === 'installment' ? 'block' : 'none';
  updateInstallHint();
}
function updateInstallField() {
  const wrap = document.getElementById('ef-install-wrap');
  if (!wrap) return;
  // Per-transaction payment plan — shown for ANY credit-card method, when ADDING *or* EDITING, so existing
  // (e.g. imported) credit-card transactions can be retroactively converted to installment without re-entering.
  // Only for SPENDING types (expense/debt): income/investment are never paid in monthly card installments.
  const isSpendType = efType.value === 'expense' || efType.value === 'debt';
  const show = isCreditCardMethod(selectValue(efMethod, null)) && isSpendType;
  wrap.style.display = show ? 'block' : 'none';
  if (!show) setPayMode('once');
  updateInstallHint();
}
function updateInstallHint() {
  const hint = document.getElementById('ef-install-hint');
  if (!hint) return;
  if (getPayMode() !== 'installment') { hint.textContent = 'Trả 1 lần vào kỳ sao kê tới.'; return; }
  const n = Math.max(2, parseInt(document.getElementById('ef-install').value, 10) || 2);
  const amt = parseAmount(efAmount.value);
  const per = amt > 0 ? Math.floor(amt / n) : 0;
  // One row, full amount — the panel tracks N monthly portions; chi tiêu vẫn tính trọn vào tháng mua.
  hint.textContent = amt > 0 ? `Giữ 1 dòng (${fmt(amt)}); 'Remaining owed' theo dõi ${n} kỳ × ~${fmt(per)}.` : `${n} kỳ — theo dõi ở 'Remaining owed'.`;
}

// presetCat (optional) preselects a category — used by the misclassification "fix" suggestions;
// refillCats() adds it to the dropdown if it isn't already an existing category of this type.
function openEditor(id, presetCat) {
  const d = allData.find(x => x.id === id);
  if (!d) return;
  editingId = id;
  modalTitle.textContent = 'Edit transaction';
  efName.value = d.name || '';
  efAmount.value = d.amount != null ? d.amount : '';
  efType.value = typeOf(d);
  efDate.value = d.dateStr || '';
  refillCats(presetCat || d.category || '');
  fillSelect(efMethod, null, allData.map(x => x.method).concat(getCards().map(c => c.label), 'Credit Card'), d.method || '', true, false);
  setImgPreview(d.image || null);
  document.getElementById('ef-delete').style.display = 'inline-block';
  overlay.style.display = 'flex';
  updateCatSuggest();
  updateAmountWarn();
  // Pre-fill the payment plan from the record so editing it keeps the installment status (instead of silently
  // reverting to "Mua trước trả sau"). A plain record defaults to "once".
  if (Number(d.installments) >= 2) { efInstall.value = d.installments; setPayMode('installment'); }
  else { efInstall.value = 3; setPayMode('once'); }
  updateInstallField();
  efName.focus();
}

function openAdd() {
  editingId = null;
  modalTitle.textContent = 'Add transaction';
  efName.value = ''; efAmount.value = '';
  // Default the new transaction's type to the current tab's type. On the Credit Cards tab a new entry is a
  // normal credit-card expense (type 'expense' + Payment Method 'Credit Card') so it lands in the tab to tick "paid".
  efType.value = (view === 'income' || view === 'invest') ? view : 'expense';
  const today = new Date();
  efDate.value = today.getFullYear() + '-' + String(today.getMonth() + 1).padStart(2, '0') + '-' + String(today.getDate()).padStart(2, '0');
  refillCats('');
  fillSelect(efMethod, null, allData.map(x => x.method).concat(getCards().map(c => c.label), 'Credit Card'), view === 'debts' ? ((getPinnedCard() || {}).label || 'Credit Card') : '', true, false);
  setImgPreview(null);
  document.getElementById('ef-delete').style.display = 'none';
  overlay.style.display = 'flex';
  updateCatSuggest();
  updateAmountWarn();
  efInstall.value = 3; setPayMode('once'); // fresh add → default to "Mua trước trả sau"
  updateInstallField();
  efName.focus();
}

function closeEditor() { editingId = null; pendingImage = null; overlay.style.display = 'none'; }

function setImgPreview(src) {
  pendingImage = src || null;
  const preview = document.getElementById('ef-img-preview');
  const pick = document.getElementById('ef-img-pick');
  const thumb = document.getElementById('ef-img-thumb');
  const input = document.getElementById('ef-img-input');
  if (src) {
    thumb.src = src;
    preview.style.display = 'block';
    pick.style.display = 'none';
  } else {
    thumb.src = '';
    preview.style.display = 'none';
    pick.style.display = 'flex';
    input.value = '';
  }
}

async function saveEdit() {
  const isEdit = editingId != null;
  const name = efName.value.trim();
  const amount = parseAmount(efAmount.value);
  if (!name && !amount) { toast('Enter at least a name or amount', 'warn'); return; }
  const category = selectValue(efCategory, efCategoryNew) || 'Uncategorized';
  const method = selectValue(efMethod, null);
  const baseDate = parseDate(efDate.value);
  const type = efType.value;

  // Installment plan ("Trả góp" N≥2 on a credit-card spending txn): stored as ONE record carrying `installments`
  // — NOT split into N rows. The purchase keeps its real total, original name and date (full amount counts in the
  // purchase month); the "Remaining owed" panel virtualizes the N statement-month portions. "Mua trước trả sau"
  // (or any non-card / income / invest txn) stores installments = null.
  const nInstall = (isCreditCardMethod(method) && (type === 'expense' || type === 'debt') && getPayMode() === 'installment')
    ? Math.max(2, parseInt(efInstall.value, 10) || 2) : 1;
  const rec = makeRecord({ name, amount, category, method, date: baseDate, type, image: pendingImage, installments: nInstall >= 2 ? nInstall : null });
  if (isEdit) rec.id = editingId;

  const db = await openDB();
  const all = await getAll(db);
  // The fingerprint index is unique — reject up front if this edit would collide with another row.
  if (all.some(r => r.id !== editingId && r.fingerprint === rec.fingerprint)) {
    db.close();
    toast('A row with the same name · amount · category · date already exists', 'warn');
    return;
  }
  try {
    await putRecord(db, rec);
  } catch (err) {
    db.close();
    toast('Could not save (' + ((err && err.name) || 'error') + ')', 'warn');
    return;
  }
  // Carry "đã trả" (ccPaidFps) state across the edit: its keys derive from the fingerprint (which changes when
  // name/amount/category/date change) and from the period count. Remap old keys → new keys positionally so a
  // typo-fix or amount tweak doesn't silently reset paid marks (and drop keys for periods that no longer exist).
  if (isEdit && Array.isArray(ccPaidFps) && ccPaidFps.length) {
    const oldRec = all.find(r => r.id === editingId);
    if (oldRec) {
      const oldKeys = paidKeysFor(oldRec), newKeys = paidKeysFor(rec);
      if (oldKeys.join('|') !== newKeys.join('|')) {
        const map = {}; oldKeys.forEach((k, i) => { if (i < newKeys.length) map[k] = newKeys[i]; });
        const oldSet = new Set(oldKeys);
        const next = ccPaidFps.filter(k => !oldSet.has(k) || map[k]).map(k => map[k] || k);
        ccPaidFps = [...new Set(next)];
        await putMeta(db, 'ccPaidFps', ccPaidFps);
      }
    }
  }
  db.close();
  closeEditor();
  // Jump to the tab matching the saved record so the user sees it land.
  const savedView = typeOf(rec) === 'debt' ? 'debts' : typeOf(rec); // type value 'debt' maps to the 'debts' tab key
  // Jump to the matching tab after save (but not from overview, and not when already on the Debts tab).
  if (view !== 'overview' && view !== 'debts' && savedView !== view) setView(savedView);
  toast(isEdit ? 'Saved' : 'Added', 'success');
  await reloadPreservingFilters();
  scheduleSyncPush();
}

async function deleteEdit() {
  if (editingId == null) return;
  if (!confirm('Delete this transaction?')) return;
  const db = await openDB();
  try { await deleteRecord(db, editingId); } catch (e) { /* ignore */ }
  db.close();
  closeEditor();
  toast('Deleted', 'success');
  await reloadPreservingFilters();
  scheduleSyncPush();
}

// Export records back to a CSV in the same shape they were imported (round-trips through handleCSV).
// Two scopes: 'all' = every record/type; 'view' = the current tab honoring its month/category filters.

// Compute the "current view" scope: which rows, a human description, and a filename tag.
function currentExportScope() {
  const m = monthFilter.value;
  let monthName = '';
  if (m !== 'all') { const [y, mo] = m.split('-'); monthName = new Date(+y, +mo - 1).toLocaleString('en-US', { month: 'long', year: 'numeric' }); }
  if (view === 'overview' || view === 'settings') { // overview/settings span all types
    const rows = allData.filter(d => m === 'all' || d.monthKey === m);
    return { rows, desc: 'Overview' + (monthName ? ' · ' + monthName : ''), tag: 'overview' + (m !== 'all' ? '-' + m : '') };
  }
  const rows = allData.filter(d => matchesView(d) && (m === 'all' || d.monthKey === m));
  const desc = VIEW_META[view].sổ + (monthName ? ' · ' + monthName : '');
  const tag = view + (m !== 'all' ? '-' + m : '');
  return { rows, desc, tag };
}

// Open the scope picker, previewing the row count behind each option.
function openExport() {
  if (!allData.length) { toast('No data to export', 'warn'); return; }
  const s = currentExportScope();
  document.getElementById('exp-all-label').textContent = `All · ${allData.length} rows (all types, re-importable)`;
  document.getElementById('exp-view-label').innerHTML = `${esc(s.desc)} <span style="color:var(--text-3)">· ${s.rows.length} rows</span>`;
  document.getElementById('export-overlay').style.display = 'flex';
}

function exportCSV(scope) {
  if (!allData.length) { toast('No data to export', 'warn'); return; }
  let rows, tag;
  if (scope === 'view') { const s = currentExportScope(); rows = s.rows; tag = s.tag; }
  else { rows = allData; tag = 'all'; }
  if (!rows.length) { toast('The selected scope has no rows', 'warn'); return; }
  const out = [...rows]
    .sort((a, b) => (a.date || 0) - (b.date || 0))
    .map(d => ({
      Name: d.name,
      Amount: d.amount,
      Type: typeOf(d),
      Date: d.dateStr || '',
      Categories: d.category,
      'Payment Method': d.method || ''
    }));
  const csv = Papa.unparse(out, { columns: ['Name', 'Amount', 'Type', 'Date', 'Categories', 'Payment Method'] });
  const blob = new Blob(['﻿' + csv], { type: 'text/csv;charset=utf-8;' }); // BOM so Excel reads UTF-8
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `spendy-export-${tag}-${new Date().toISOString().slice(0, 10)}.csv`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
  document.getElementById('export-overlay').style.display = 'none';
  toast(`Exported ${out.length} rows`, 'success');
}

window.editRow = openEditor; // table rows call this via inline onclick
window.viewImage = function(e, id) {
  e.stopPropagation();
  const d = allData.find(x => x.id === id);
  if (d && d.image) {
    document.getElementById('img-lb-img').src = d.image;
    document.getElementById('img-lightbox').classList.add('show');
  }
};

// --- Events ---
document.querySelectorAll('.nav-btn').forEach(b => b.addEventListener('click', () => setView(b.dataset.view)));

document.getElementById('add-btn').addEventListener('click', () => openAdd());
document.getElementById('export-btn').addEventListener('click', openExport);
document.getElementById('ef-save').addEventListener('click', saveEdit);
document.getElementById('ef-cancel').addEventListener('click', closeEditor);
document.getElementById('ef-delete').addEventListener('click', deleteEdit);
document.getElementById('ef-img-pick').addEventListener('click', () => document.getElementById('ef-img-input').click());
document.getElementById('ef-img-input').addEventListener('change', e => {
  const file = e.target.files && e.target.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = ev => setImgPreview(ev.target.result);
  reader.readAsDataURL(file);
});
document.getElementById('ef-img-remove').addEventListener('click', () => setImgPreview(null));
// Lightbox: click thumbnail → view full size; click overlay/close → dismiss
document.getElementById('ef-img-thumb').addEventListener('click', () => {
  const src = document.getElementById('ef-img-thumb').src;
  if (!src) return;
  document.getElementById('img-lb-img').src = src;
  document.getElementById('img-lightbox').classList.add('show');
});
document.getElementById('img-lightbox').addEventListener('click', e => {
  if (e.target === document.getElementById('img-lightbox') || e.target.id === 'img-lb-close')
    document.getElementById('img-lightbox').classList.remove('show');
});
document.getElementById('img-lb-close').addEventListener('click', () => {
  document.getElementById('img-lightbox').classList.remove('show');
});
document.addEventListener('keydown', e => {
  if (e.key === 'Escape' && document.getElementById('img-lightbox').classList.contains('show')) {
    document.getElementById('img-lightbox').classList.remove('show');
    e.stopImmediatePropagation(); // don't close the edit modal too
  }
}, true); // capture phase so it fires before the modal's Escape handler
efType.addEventListener('change', () => { refillCats(''); updateCatSuggest(); updateInstallField(); });
efName.addEventListener('input', updateCatSuggest); // live category suggestion as the name is typed
efAmount.addEventListener('input', () => { updateAmountWarn(); updateInstallHint(); }); // warn on small amounts + installment hint
efMethod.addEventListener('change', updateInstallField); // show the payment-plan picker for any credit-card method
efInstall.addEventListener('input', updateInstallHint);
document.querySelectorAll('#ef-pay-mode .stat-tab').forEach(b => b.addEventListener('click', () => setPayMode(b.dataset.mode)));
efCategory.addEventListener('change', () => { toggleNew(efCategory, efCategoryNew); if (efCategory.value === '__new__') efCategoryNew.focus(); updateCatSuggest(); });
// Dismiss a modal when its backdrop is clicked — but ONLY if the mouse press also STARTED on the backdrop.
// Without the mousedown guard, selecting text inside the modal and releasing the drag on the backdrop fires
// a click whose target is the overlay, wrongly closing the modal.
function dismissOnBackdrop(el, onClose) {
  let downOnBackdrop = false;
  el.addEventListener('mousedown', e => { downOnBackdrop = (e.target === el); });
  el.addEventListener('click', e => { if (e.target === el && downOnBackdrop) onClose(); });
}
dismissOnBackdrop(overlay, closeEditor);
document.addEventListener('keydown', e => {
  if (overlay.style.display === 'none') return;
  if (e.key === 'Escape') closeEditor();
  else if (e.key === 'Enter' && e.target.tagName === 'INPUT') saveEdit();
});

document.getElementById('import-btn').addEventListener('click', () => {
  document.getElementById('file-input').click();
});
document.getElementById('file-input').addEventListener('change', e => {
  const file = e.target.files[0];
  if (!file) return;
  const dt = (view === 'income' || view === 'invest') ? view : 'expense'; // capture the tab at pick time — file read is async
  const reader = new FileReader();
  reader.onload = ev => handleCSV(ev.target.result, dt);
  reader.readAsText(file);
  e.target.value = ''; // reset so same file can be re-picked
});

document.getElementById('backup-btn').addEventListener('click', backupJSON);
document.getElementById('restore-btn').addEventListener('click', () => {
  document.getElementById('json-input').click();
});
document.getElementById('json-input').addEventListener('change', e => {
  const file = e.target.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = ev => restoreJSON(ev.target.result);
  reader.readAsText(file);
  e.target.value = '';
});

// Restore confirmation modal
document.getElementById('restore-confirm').addEventListener('click', commitRestore);
document.getElementById('restore-cancel').addEventListener('click', () => { pendingRestore = null; document.getElementById('restore-overlay').style.display = 'none'; });
dismissOnBackdrop(document.getElementById('restore-overlay'), () => { pendingRestore = null; document.getElementById('restore-overlay').style.display = 'none'; });

// Export scope picker
document.getElementById('exp-all').addEventListener('click', () => exportCSV('all'));
document.getElementById('exp-view').addEventListener('click', () => exportCSV('view'));
document.getElementById('exp-cancel').addEventListener('click', () => { document.getElementById('export-overlay').style.display = 'none'; });
dismissOnBackdrop(document.getElementById('export-overlay'), () => { document.getElementById('export-overlay').style.display = 'none'; });

document.getElementById('bg-save').addEventListener('click', saveBudgetsModal);
document.getElementById('bg-suggest').addEventListener('click', suggestBudgets);
document.getElementById('bg-cancel').addEventListener('click', () => { document.getElementById('budget-overlay').style.display = 'none'; });
dismissOnBackdrop(document.getElementById('budget-overlay'), () => { document.getElementById('budget-overlay').style.display = 'none'; });

// Categories manager lives in the #cats-overlay modal (opened from the Settings card). Each operation
// (rename/merge/bucket/add/delete) persists immediately and re-renders #cat-manager in place, so the
// modal just needs open/close — render() never touches it (it sits outside <main>).
document.getElementById('cats-manage-btn').addEventListener('click', () => {
  renderCategoriesManager();
  document.getElementById('cats-overlay').style.display = 'flex';
});
document.getElementById('cats-done').addEventListener('click', () => { document.getElementById('cats-overlay').style.display = 'none'; });
dismissOnBackdrop(document.getElementById('cats-overlay'), () => { document.getElementById('cats-overlay').style.display = 'none'; });

document.getElementById('goal-save').addEventListener('click', saveGoal);
document.getElementById('goal-clear').addEventListener('click', clearGoal);
document.getElementById('goal-cancel').addEventListener('click', () => { document.getElementById('goal-overlay').style.display = 'none'; });
dismissOnBackdrop(document.getElementById('goal-overlay'), () => { document.getElementById('goal-overlay').style.display = 'none'; });
document.getElementById('goal-input').addEventListener('keydown', e => { if (e.key === 'Enter') saveGoal(); });

// Saving-plan modal
document.getElementById('pf-save').addEventListener('click', savePlan);
document.getElementById('pf-delete').addEventListener('click', deletePlan);
document.getElementById('pf-cancel').addEventListener('click', () => { document.getElementById('plan-overlay').style.display = 'none'; });
dismissOnBackdrop(document.getElementById('plan-overlay'), () => { document.getElementById('plan-overlay').style.display = 'none'; });

// My-cards modal (Settings → My cards)
document.getElementById('card-add-btn').addEventListener('click', () => openCard(null));
document.getElementById('cf-save').addEventListener('click', saveCard);
document.getElementById('cf-delete').addEventListener('click', () => deleteCard());
document.getElementById('cf-cancel').addEventListener('click', () => { document.getElementById('card-overlay').style.display = 'none'; });
dismissOnBackdrop(document.getElementById('card-overlay'), () => { document.getElementById('card-overlay').style.display = 'none'; });

// Debts modal (manual debt entry — currently unused by the Credit Cards ledger, kept dormant)
document.getElementById('df-save').addEventListener('click', saveDebt);
document.getElementById('df-delete').addEventListener('click', deleteDebt);
document.getElementById('df-cancel').addEventListener('click', () => { document.getElementById('debt-overlay').style.display = 'none'; });
dismissOnBackdrop(document.getElementById('debt-overlay'), () => { document.getElementById('debt-overlay').style.display = 'none'; });
document.getElementById('df-type').addEventListener('change', (e) => {
  const isCc = e.target.value === 'credit-card';
  document.getElementById('df-recurring').checked = isCc;
  document.getElementById('df-due-day-wrap').style.display = isCc ? 'block' : 'none';
  document.getElementById('df-due-date-wrap').style.display = isCc ? 'none' : 'block';
});
document.getElementById('df-recurring').addEventListener('change', (e) => {
  const isRec = e.target.checked;
  document.getElementById('df-due-day-wrap').style.display = isRec ? 'block' : 'none';
  document.getElementById('df-due-date-wrap').style.display = isRec ? 'none' : 'block';
});

// (Get Pro removed)

document.getElementById('set-class-btn').addEventListener('click', openClassify);
document.getElementById('class-save').addEventListener('click', saveClassify);
document.getElementById('class-suggest').addEventListener('click', suggestClassify);
document.getElementById('class-cancel').addEventListener('click', () => { document.getElementById('class-overlay').style.display = 'none'; });
dismissOnBackdrop(document.getElementById('class-overlay'), () => { document.getElementById('class-overlay').style.display = 'none'; });

// --- Settings page ---
// Data operations now live on the #settings-view page; the sidebar nav-btn (data-view="settings")
// routes there via setView. The import/export/backup/restore/manage-cat/wipe handlers below bind to
// the same button IDs, which moved from the old modal into the page.

// --- Wipe-all confirmation ---
const wipeOverlay = document.getElementById('wipe-overlay');
document.getElementById('wipe-btn').addEventListener('click', () => {
  document.getElementById('wipe-count').textContent = allData.length
    ? `Will delete ${allData.length} transactions and all settings.`
    : 'No transactions, but budgets / goals / settings (if any) will still be deleted.';
  wipeOverlay.style.display = 'flex';
});
document.getElementById('wipe-cancel').addEventListener('click', () => { wipeOverlay.style.display = 'none'; });
dismissOnBackdrop(wipeOverlay, () => { wipeOverlay.style.display = 'none'; });
document.getElementById('wipe-confirm').addEventListener('click', async () => { wipeOverlay.style.display = 'none'; await wipeAllData(); });

monthFilter.addEventListener('change', render);
methodFilter.addEventListener('change', render);
photoFilter.addEventListener('change', render);

// Table quick-search (Vietnamese accent-insensitive). The input lives in the toolbar (not rebuilt by
// renderTable) so focus survives keystrokes; window.tsf re-renders just the table for the current view.
document.getElementById('table-search').addEventListener('input', e => { if (window.tsf) window.tsf(e.target.value); });

// --- Theme toggle (light / dark) ---
// The saved theme is applied pre-paint by the inline <head> script; here we just flip + persist it.
function currentTheme() { return document.documentElement.getAttribute('data-theme') === 'dark' ? 'dark' : 'light'; }
function applyThemeLabel() {
  const dark = currentTheme() === 'dark';
  document.getElementById('theme-ico').textContent = dark ? '☀️' : '🌙';
  document.getElementById('theme-label').textContent = dark ? 'Light mode' : 'Dark mode';
}
function toggleTheme() {
  const next = currentTheme() === 'dark' ? 'light' : 'dark';
  document.documentElement.setAttribute('data-theme', next);
  try { localStorage.setItem('spendy-theme', next); } catch (e) {}
  applyThemeLabel();
  if (allData.length) render(); // canvas charts are raster — re-render so they pick up the new theme colours
}
document.getElementById('theme-btn').addEventListener('click', toggleTheme);
applyThemeLabel();

// Notification bell: toggle the dropdown; close it on outside click or Escape.
document.getElementById('notif-bell').addEventListener('click', e => { e.stopPropagation(); toggleNotifications(); });
document.getElementById('notif-pop').addEventListener('click', e => e.stopPropagation());
document.addEventListener('click', () => { if (notifOpen) closeNotifications(); });
document.addEventListener('keydown', e => { if (e.key === 'Escape' && notifOpen) closeNotifications(); });

// Sidebar collapsible toggle
document.getElementById('sidebar-toggle').addEventListener('click', () => {
  const sidebar = document.querySelector('.sidebar');
  sidebar.classList.toggle('collapsed');
  const isCollapsed = sidebar.classList.contains('collapsed');
  document.getElementById('sidebar-toggle').title = isCollapsed ? 'Expand sidebar' : 'Collapse sidebar';
  try { localStorage.setItem('spendy-sidebar-collapsed', isCollapsed ? 'true' : 'false'); } catch (e) {}
});
try {
  if (localStorage.getItem('spendy-sidebar-collapsed') === 'true') {
    const sidebar = document.querySelector('.sidebar');
    sidebar.classList.add('collapsed');
    document.getElementById('sidebar-toggle').title = 'Expand sidebar';
  }
} catch (e) {}

// ─── File System Access API Sync ───
// Auto-sync data to/from a local JSON file via the File System Access API.
// The JSON file (e.g. spendy-sync.json) lives in a Google Drive-synced folder.
// Google Drive handles cross-machine sync; this code handles read/write to disk.
//
// SYNC TURNED OFF: set to false to disable file-sync entirely (no auto-connect on load,
// no auto-push on mutation, Sync card hidden in Settings). Flip back to true to re-enable —
// all the sync code below is kept intact/dormant. Disabled per user request (was flaky).
const SYNC_ENABLED = false;

let syncFileHandle = null;  // FileSystemFileHandle, persisted in IndexedDB 'meta'
let syncLinked = false;      // true when handle exists and readwrite permission granted
let syncBusy = false;        // prevent concurrent file writes
let lastSyncedAt = 0;        // timestamp of last sync (avoid re-importing own writes)
let syncPushTimer = null;    // debounce timer for auto-push

// Build the full backup payload (same shape as backupJSON).
function buildSyncPayload() {
  const records = allData.map(({ id, ...r }) => r);
  return {
    app: 'spendy', version: 1, syncedAt: Date.now(),
    records, budgets, goal, catClass, incomeBase,
    cats: catReg, plans: getPlans(), debts: getDebts(), ccPaidFps, ccNoteFps, cards: getCards(), pinnedCard: pinnedCardId
  };
}

// Debounced push — call after every mutation; collapses rapid-fire writes into one.
function scheduleSyncPush() {
  if (!SYNC_ENABLED || !syncFileHandle || !syncLinked) return;
  clearTimeout(syncPushTimer);
  syncPushTimer = setTimeout(fileSyncPush, 500);
}

// Write the current state to the linked sync file.
async function fileSyncPush() {
  if (!syncFileHandle || !syncLinked || syncBusy) return;
  syncBusy = true;
  try {
    if ((await syncFileHandle.queryPermission({ mode: 'readwrite' })) !== 'granted') {
      syncLinked = false; updateSyncUI(); syncBusy = false; return;
    }
    const payload = buildSyncPayload();
    const writable = await syncFileHandle.createWritable();
    await writable.write(JSON.stringify(payload, null, 2));
    await writable.close();
    lastSyncedAt = payload.syncedAt; // only mark "we wrote this" AFTER the write succeeds, so a failed push doesn't make the next pull skip a real update
    const db = await openDB();
    await putMeta(db, 'lastSyncedAt', lastSyncedAt);
    db.close();
    updateSyncUI('synced');
  } catch (e) {
    console.warn('fileSyncPush failed:', e);
    updateSyncUI('error');
  } finally {
    syncBusy = false;
  }
}

// Read the sync file and silently merge new records + meta.
async function fileSyncPull() {
  if (!syncFileHandle || !syncLinked) return false;
  try {
    const file = await syncFileHandle.getFile();
    const text = await file.text();
    if (!text || text.length < 10) return false;

    let payload;
    try { payload = JSON.parse(text); } catch { return false; }
    if (!payload || payload.app !== 'spendy' || !Array.isArray(payload.records)) return false;
    if (payload.syncedAt && payload.syncedAt === lastSyncedAt) return false; // we wrote this ourselves

    const db = await openDB();
    const existing = await getFingerprints(db);

    const incoming = payload.records.map(r => makeRecord({
      name: (r.name || '').trim(),
      amount: Number(r.amount) || 0,
      category: r.category || 'Uncategorized',
      method: r.method || '',
      date: parseDate(r.date != null ? r.date : r.dateStr),
      type: r.type,
      image: r.image || null,
      installments: r.installments || null
    }));
    const fresh = incoming.filter(r => !existing.has(r.fingerprint));

    let changed = false;
    if (fresh.length) {
      const tx = db.transaction(STORE, 'readwrite');
      const store = tx.objectStore(STORE);
      for (const r of fresh) {
        const req = store.add(r);
        // Skip a duplicate fingerprint (ConstraintError); let any other error abort so it doesn't false-toast success.
        req.onerror = e => { if (req.error && req.error.name === 'ConstraintError') e.preventDefault(); };
      }
      // Resolve on complete; reject only on a real abort (a skipped duplicate bubbles to tx.onerror with null error).
      await new Promise((res, rej) => { tx.oncomplete = res; tx.onabort = () => rej(tx.error || new Error('transaction aborted')); });
      changed = true;
    }

    // Overwrite meta if the file is from a different sync session (written by another machine).
    if (payload.syncedAt !== lastSyncedAt) { // import peer meta even when syncedAt is falsy/missing (the && guard silently skipped it before)
      if (payload.budgets && typeof payload.budgets === 'object') await putMeta(db, 'budgets', payload.budgets);
      if (typeof payload.goal === 'number') await putMeta(db, 'goal', payload.goal);
      if (payload.catClass && typeof payload.catClass === 'object') await putMeta(db, 'catClass', payload.catClass);
      if (typeof payload.incomeBase === 'number') await putMeta(db, 'incomeBase', payload.incomeBase);
      if (payload.cats && typeof payload.cats === 'object') await putMeta(db, 'cats', payload.cats);
      if (Array.isArray(payload.plans)) await putMeta(db, 'plans', payload.plans);
      if (Array.isArray(payload.debts)) await putMeta(db, 'debts', payload.debts);
      if (Array.isArray(payload.ccPaidFps)) await putMeta(db, 'ccPaidFps', payload.ccPaidFps);
      if (payload.ccNoteFps && typeof payload.ccNoteFps === 'object') await putMeta(db, 'ccNoteFps', payload.ccNoteFps);
      if (Array.isArray(payload.cards)) await putMeta(db, 'cards', payload.cards);
      if (typeof payload.pinnedCard === 'string' || payload.pinnedCard === null) await putMeta(db, 'pinnedCard', payload.pinnedCard);
      lastSyncedAt = payload.syncedAt;
      await putMeta(db, 'lastSyncedAt', lastSyncedAt);
      changed = true;
    }

    db.close();
    if (changed) {
      await loadFromDB();
      if (fresh.length) toast(`Synced ${fresh.length} new record(s) from file`, 'success');
      else toast('Settings synced from file', 'success');
    }
    return changed;
  } catch (e) {
    console.warn('fileSyncPull failed:', e);
    return false;
  }
}

// Let the user pick (or create) the sync file.
async function linkSyncFile() {
  if (!('showSaveFilePicker' in window)) {
    toast('File sync not supported — use Edge or Chrome', 'warn');
    return;
  }
  try {
    const handle = await window.showSaveFilePicker({
      suggestedName: 'spendy-sync.json',
      types: [{ description: 'JSON', accept: { 'application/json': ['.json'] } }]
    });
    syncFileHandle = handle;
    syncLinked = true;
    const db = await openDB();
    await putMeta(db, 'syncHandle', handle);
    db.close();
    updateSyncUI('synced');
    // If the picked file already has data, pull first
    await fileSyncPull();
    // Then push current (merged) state
    await fileSyncPush();
    toast('Sync file linked ✓', 'success');
    renderSyncSettings();
  } catch (e) {
    if (e.name !== 'AbortError') { // user cancelled the picker
      console.warn('linkSyncFile failed:', e);
      toast('Could not link sync file', 'warn');
    }
  }
}

async function unlinkSyncFile() {
  syncFileHandle = null;
  syncLinked = false;
  const db = await openDB();
  await putMeta(db, 'syncHandle', null);
  db.close();
  updateSyncUI();
  toast('Sync file unlinked', 'success');
  renderSyncSettings();
}

// On app load: retrieve handle from IndexedDB, request permission, pull.
async function initFileSync() {
  if (!('showSaveFilePicker' in window)) return;
  try {
    const db = await openDB();
    const handle = await getMeta(db, 'syncHandle');
    lastSyncedAt = (await getMeta(db, 'lastSyncedAt')) || 0;
    db.close();
    if (!handle || !(handle instanceof FileSystemFileHandle)) return;
    syncFileHandle = handle;

    // Only QUERY at load — requestPermission() requires a user gesture and throws/auto-denies on page load
    // in current Chrome. If not already granted, defer re-granting to the "Reconnect sync" click below.
    const perm = await handle.queryPermission({ mode: 'readwrite' });
    if (perm === 'granted') {
      syncLinked = true;
      updateSyncUI('synced');
      await fileSyncPull();
    } else {
      updateSyncUI('denied');
    }
  } catch (e) {
    console.warn('initFileSync failed:', e);
  }
  renderSyncSettings();
}

// Re-grant permission to an already-linked handle via a user gesture (queryPermission at load can't do this).
async function reconnectSync() {
  if (!syncFileHandle) { linkSyncFile(); return; }
  try {
    const perm = await syncFileHandle.requestPermission({ mode: 'readwrite' });
    if (perm === 'granted') {
      syncLinked = true;
      updateSyncUI('synced');
      await fileSyncPull();
      toast('Sync reconnected ✓', 'success');
    } else {
      updateSyncUI('denied');
      toast('Permission denied', 'warn');
    }
  } catch (e) {
    console.warn('reconnectSync failed:', e);
    toast('Could not reconnect sync', 'warn');
  }
  renderSyncSettings();
}

function updateSyncUI(state) {
  const indicator = document.getElementById('sync-indicator');
  const label = document.getElementById('sync-indicator-label');
  if (!indicator) return;
  if (!syncFileHandle) { indicator.style.display = 'none'; return; }
  indicator.style.display = '';
  const ico = indicator.querySelector('.ico');
  if (state === 'synced')       { ico.textContent = '🔗'; label.textContent = 'Synced'; }
  else if (state === 'error')   { ico.textContent = '⚠️'; label.textContent = 'Sync error'; }
  else if (state === 'denied')  { ico.textContent = '🔒'; label.textContent = 'Sync blocked'; }
  else                          { ico.textContent = '🔗'; label.textContent = 'Linked'; }
}

function renderSyncSettings() {
  const card = document.getElementById('set-sync');
  if (!SYNC_ENABLED) { if (card) card.style.display = 'none'; return; } // sync turned off — hide the whole card
  const status = document.getElementById('sync-status');
  const acts = document.getElementById('sync-acts');
  if (!status || !acts) return;
  if (!('showSaveFilePicker' in window)) {
    status.textContent = 'File sync is not available in this browser. Use Edge or Chrome.';
    acts.innerHTML = '';
    return;
  }
  acts.innerHTML = '';
  if (syncLinked && syncFileHandle) {
    status.innerHTML = `✅ Linked to <b>${esc(syncFileHandle.name)}</b> — changes auto-sync.`;
    const pullBtn = document.createElement('button');
    pullBtn.className = 'side-act'; pullBtn.innerHTML = '<span class="ico">⬇️</span>Pull now';
    pullBtn.addEventListener('click', async () => { const r = await fileSyncPull(); if (!r) toast('Already up to date', 'info'); });
    const pushBtn = document.createElement('button');
    pushBtn.className = 'side-act'; pushBtn.innerHTML = '<span class="ico">⬆️</span>Push now';
    pushBtn.addEventListener('click', async () => { await fileSyncPush(); toast('Pushed to sync file', 'success'); });
    const unlinkBtn = document.createElement('button');
    unlinkBtn.className = 'side-act danger'; unlinkBtn.innerHTML = '<span class="ico">🔓</span>Unlink sync file';
    unlinkBtn.addEventListener('click', unlinkSyncFile);
    acts.append(pullBtn, pushBtn, unlinkBtn);
  } else if (syncFileHandle && !syncLinked) {
    status.innerHTML = `⚠️ Linked to <b>${esc(syncFileHandle.name)}</b> but not connected this session. Click reconnect to resume auto-sync.`;
    const btn = document.createElement('button');
    btn.className = 'side-act accent'; btn.innerHTML = '<span class="ico">🔗</span>Reconnect sync';
    btn.addEventListener('click', reconnectSync);
    acts.appendChild(btn);
  } else {
    status.textContent = 'Link a JSON file in your Google Drive folder to auto-sync data between devices.';
    const btn = document.createElement('button');
    btn.className = 'side-act accent'; btn.innerHTML = '<span class="ico">🔗</span>Link sync file';
    btn.addEventListener('click', linkSyncFile);
    acts.appendChild(btn);
  }
}

// Overview dashboard layout manager (visible / order). Persisted as meta 'overviewWidgets' [{id,visible}].
function renderOvLayoutSettings() {
  const wrap = document.getElementById('ov-layout-manager');
  if (!wrap) return;
  const layout = getOvWidgets();
  const LABELS = {
    card:'Pinned card', plans:'Saving Plans', fifty:'50/30/20', stats:'Stat cards',
    cashflow:'Cashflow', recent:'Recent', stat:'Statistic', budgets:'Budgets', activity:'Activity'
  };
  wrap.innerHTML = layout.map((w,i) => {
    const label = LABELS[w.id] || w.id;
    return `<div class="cat-row ov-layout-row" draggable="true" data-id="${esc(w.id)}">
      <button class="bud-drag" title="Drag to reorder">⠿</button>
      <label class="ov-layout-toggle" title="Show / hide"><input type="checkbox" data-id="${esc(w.id)}"${w.visible?' checked':''}><span>${esc(label)}</span></label>
      <span class="ov-layout-idx">${i + 1}</span>
    </div>`;
  }).join('');
  wrap.querySelectorAll('.ov-layout-toggle input[type="checkbox"]').forEach(inp => {
    inp.addEventListener('change', async () => { await setOvWidgetVisible(inp.dataset.id, inp.checked); renderOverview(); scheduleSyncPush(); });
  });
  setupOvLayoutDnD(wrap);
}

async function setupOvLayoutDnD(root) {
  let dragId = null;
  root.querySelectorAll('.ov-layout-row').forEach(row => {
    row.addEventListener('dragstart', e => {
      dragId = row.dataset.id;
      row.classList.add('bud-dragging');
      e.dataTransfer.effectAllowed = 'move';
      e.dataTransfer.setData('text/plain', dragId);
    });
    row.addEventListener('dragend', () => { dragId = null; root.querySelectorAll('.ov-layout-row').forEach(r => r.classList.remove('bud-dragging', 'bud-drop')); });
  });
  root.querySelectorAll('.ov-layout-row').forEach(row => {
    row.addEventListener('dragover', e => { if (!dragId) return; e.preventDefault(); e.dataTransfer.dropEffect = 'move'; });
    row.addEventListener('dragenter', () => { if (dragId && row.dataset.id !== dragId) row.classList.add('bud-drop'); });
    row.addEventListener('dragleave', () => row.classList.remove('bud-drop'));
    row.addEventListener('drop', async e => {
      e.preventDefault(); row.classList.remove('bud-drop');
      if (!dragId) return;
      const target = row.dataset.id;
      const list = getOvWidgets();
      const fi = list.findIndex(w => w.id === dragId);
      const ti = list.findIndex(w => w.id === target);
      if (fi < 0 || ti < 0 || fi === ti) return;
      [list[fi], list[ti]] = [list[ti], list[fi]];
      ovWidgets = list;
      await persistOvWidgets();
      renderOvLayoutSettings();
      renderOverview();
      scheduleSyncPush();
    });
  });
}

async function setOvWidgetVisible(id, visible) {
  const list = getOvWidgets();
  const i = list.findIndex(w => w.id === id);
  if (i < 0) return;
  list[i].visible = !!visible;
  // Drop hidden widgets from the saved order entirely? keep order stable: keep them so re-enable preserves order.
  await persistOvWidgets();
}

// Init
(async () => {
  await loadFromDB();
  if (SYNC_ENABLED) await initFileSync();
})();
