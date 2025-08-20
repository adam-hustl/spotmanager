const fs = require('fs');
const path = require('path');

// Reuse same data dir pattern as server.js
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data-local');
try { fs.mkdirSync(DATA_DIR, { recursive: true }); } catch (e) {}

const FINANCE_FILE = path.join(DATA_DIR, 'finance.json');

// Initialize file if missing
function ensureFile() {
  if (!fs.existsSync(FINANCE_FILE)) {
    const seed = { entries: [], settings: { currency: 'PHP' } };
    fs.writeFileSync(FINANCE_FILE, JSON.stringify(seed, null, 2));
  }
}

function load() {
  ensureFile();
  try {
    const raw = fs.readFileSync(FINANCE_FILE, 'utf8') || '{}';
    const json = JSON.parse(raw);
    if (!json.entries) json.entries = [];
    if (!json.settings) json.settings = { currency: 'PHP' };
    return json;
  } catch {
    return { entries: [], settings: { currency: 'PHP' } };
  }
}

function save(data) {
  fs.writeFileSync(FINANCE_FILE, JSON.stringify(data, null, 2));
}

function uid() {
  return 'fin_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

function toMonthKey(dateStr) {
  const d = new Date(dateStr);
  const y = d.getFullYear();
  const m = (d.getMonth() + 1).toString().padStart(2, '0');
  return `${y}-${m}`;
}

// ---- Public API ----
function addIncome(entry) {
  const data = load();
  const e = {
    id: uid(),
    type: 'income',
    date: entry.date,
    platform: entry.platform || '',
    bookingTimestamp: entry.bookingTimestamp || '',
    guestName: entry.guestName || '',
    gross: Number(entry.gross || 0),
    platformFee: Number(entry.platformFee || 0),
    cleaningCost: Number(entry.cleaningCost || 0),
    otherCost: Number(entry.otherCost || 0),
    notes: entry.notes || ''
  };
  data.entries.push(e);
  save(data);
  return e;
}

function addExpense(entry) {
  const data = load();
  const e = {
    id: uid(),
    type: 'expense',
    date: entry.date,
    category: entry.category || '',
    amount: Number(entry.amount || 0),
    notes: entry.notes || ''
  };
  data.entries.push(e);
  save(data);
  return e;
}

function listEntries() {
  return load().entries.sort((a, b) => new Date(b.date) - new Date(a.date));
}

function monthSummary(monthKey) {
  const entries = load().entries;
  const subset = entries.filter(e => toMonthKey(e.date) === monthKey);
  let incomeGross = 0, platformFees = 0, cleaning = 0, other = 0, expense = 0;
  for (const e of subset) {
    if (e.type === 'income') {
      incomeGross += e.gross || 0;
      platformFees += e.platformFee || 0;
      cleaning += e.cleaningCost || 0;
      other += e.otherCost || 0;
    } else if (e.type === 'expense') {
      expense += e.amount || 0;
    }
  }
  const net = incomeGross - platformFees - cleaning - other - expense;
  return {
    month: monthKey,
    incomeGross,
    platformFees,
    cleaning,
    other,
    expense,
    net,
    countIncome: subset.filter(e => e.type==='income').length,
    countExpense: subset.filter(e => e.type==='expense').length
  };
}

function allMonthsSummary() {
  const entries = load().entries;
  const keys = new Set(entries.map(e => toMonthKey(e.date)));
  return Array.from(keys).sort().map(monthSummary);
}

module.exports = {
  FINANCE_FILE,
  addIncome,
  addExpense,
  listEntries,
  monthSummary,
  allMonthsSummary
};
