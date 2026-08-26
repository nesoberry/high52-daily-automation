// 스탁이지 "스크리너" 프리셋 수집 → 텔레그램 발송
// 실행: node screener.js
//
// 필요한 환경변수 (GitHub Secrets)
//   STOCKEASY_SESSION   기존 봇과 동일한 쿠키 문자열
//   TELEGRAM_BOT_TOKEN  텔레그램 봇 토큰
//   TELEGRAM_CHAT_ID    받을 채팅 ID

const { chromium } = require('playwright');

const BASE = 'https://stockeasy.intellio.kr/stock-analysis/screener?preset=';
const DOMAIN = 'stockeasy.intellio.kr';

// ── 프리셋 설정 ─────────────────────────────
// filter: 표에서 뽑은 값으로 남길지 판단
// sortKey: 정렬 기준 (배열 순서대로 오름차순, '-' 접두사는 내림차순)
// format: 텔레그램에 출력할 줄 (프리셋마다 보여줄 항목이 다름)
const PRESETS = [
  {
    id: 'momentum_leader',
    name: '강세 선두',
    desc: '지금 가장 강하게 달리는 종목',
    filter: (r) => r.rs >= 90 && r.rs1m >= 90,
    filterText: 'RS≥90 & RS(1M)≥90',
    sortKey: ['sector', '-rs'],
    format: (r) => [
      `· ${r.name}{DUP} — RS ${r.rs}/${r.rs1m}`,
      `고점갭 ${r.gap}% · 시가총액 ${r.cap}`,
    ],
  },
  {
    id: 'trend_template',
    name: '추세 시작',
    desc: '막 상승을 시작한 종목 (Stage 2 초입)',
    filter: (r) => r.rs1m >= 80 && r.gap >= -15,
    filterText: 'RS(1M)≥80 & 52주 고점갭≥-15%',
    sortKey: ['sector', '-gap'],
    format: (r) => [
      `· ${r.name}{DUP} — 고점갭 ${r.gap}%`,
      `  RS ${r.rs}/${r.rs1m} · ${r.cap}`,
    ],
  },
];

function parseCookies(raw) {
  if (!raw) return [];
  const s = raw.trim();
  if (s.startsWith('[')) {
    try {
      return JSON.parse(s).map((c) => ({
        name: c.name, value: c.value,
        domain: c.domain || DOMAIN, path: c.path || '/',
      }));
    } catch (e) { /* fallthrough */ }
  }
  return s.split(';').map((p) => p.trim()).filter(Boolean).map((p) => {
    const i = p.indexOf('=');
    return { name: p.slice(0, i).trim(), value: p.slice(i + 1).trim(), domain: DOMAIN, path: '/' };
  }).filter((c) => c.name && c.value);
}

const num = (t) => {
  if (t === undefined || t === null) return null;
  const m = String(t).replace(/,/g, '').match(/-?[\d.]+/);
  return m ? parseFloat(m[0]) : null;
};

// 표 헤더 이름으로 컬럼 위치를 찾는다 (프리셋마다 컬럼이 다르므로)
function pick(headers, ...cands) {
  for (const c of cands) {
    const i = headers.findIndex((h) => h.replace(/\s/g, '').includes(c.replace(/\s/g, '')));
    if (i !== -1) return i;
  }
  return -1;
}

async function scrapePreset(page, preset) {
  await page.goto(BASE + preset.id, { waitUntil: 'networkidle', timeout: 60000 });
  try {
    await page.waitForSelector('tbody tr', { timeout: 20000 });
  } catch (e) {
    return { rows: [], total: 0 };
  }

  const table = await page.evaluate(() => {
    const clean = (el) => (el.innerText || '').replace(/\s+/g, ' ').trim();
    const headers = [...document.querySelectorAll('thead th')].map(clean);
    const rows = [...document.querySelectorAll('tbody tr')].map((tr) =>
      [...tr.querySelectorAll('td')].map(clean)
    );
    return { headers, rows };
  });

  const H = table.headers;
  const iName = pick(H, '종목명');
  const iSec = pick(H, '중분류', '섹터');
  const iCap = pick(H, '시가총액');
  const iRs = H.findIndex((h) => h.replace(/\s/g, '') === 'RS' || h.replace(/\s/g, '') === 'RS↓');
  const iRs1 = pick(H, 'RS(1M)');
  const iGap = pick(H, '52주 고점갭', '고점갭', '고점 대비', '피봇 대비');
  const iPrice = pick(H, '현재가');
  const iChg = pick(H, '등락률');

  const rows = [];
  for (const td of table.rows) {
    if (!td[iName]) continue;
    rows.push({
      name: td[iName],
      sector: iSec >= 0 ? td[iSec] : '',
      cap: iCap >= 0 ? td[iCap] : '',
      rs: num(td[iRs]),
      rs1m: num(td[iRs1]),
      gap: num(td[iGap]),
      price: iPrice >= 0 ? td[iPrice] : '',
      change: iChg >= 0 ? td[iChg] : '',
    });
  }
  return { rows, total: rows.length };
}

function sortRows(rows, keys) {
  return [...rows].sort((a, b) => {
    for (const k of keys) {
      const desc = k.startsWith('-');
      const key = desc ? k.slice(1) : k;
      let av = a[key], bv = b[key];
      if (av === null || av === undefined) av = desc ? -Infinity : Infinity;
      if (bv === null || bv === undefined) bv = desc ? -Infinity : Infinity;
      let c = typeof av === 'string' ? av.localeCompare(bv, 'ko') : av - bv;
      if (desc) c = -c;
      if (c !== 0) return c;
    }
    return 0;
  });
}

function buildMessage(results, updated) {
  const today = new Date().toLocaleDateString('ko-KR', {
    timeZone: 'Asia/Seoul', month: '2-digit', day: '2-digit',
  });
  const LINE = '━━━━━━━━━━━━━━━━';

  // 중복 집계
  const seen = {};
  for (const r of results) {
    for (const row of r.rows) {
      (seen[row.name] = seen[row.name] || []).push(r.preset.name);
    }
  }

  const out = [`📊 스크리너 (${today})`];
  if (updated) out.push(`기준 ${updated}`);

  for (const r of results) {
    out.push('');
    out.push(LINE);
    out.push(`${r.preset.name} · ${r.rows.length}/${r.total}종목`);
    out.push(`(${r.preset.filterText})`);
    out.push(LINE);
    out.push('');

    if (r.rows.length === 0) {
      out.push('조건 충족 종목 없음');
      continue;
    }

    let lastSector = null;
    for (const row of r.rows) {
      if (row.sector !== lastSector) {
        if (lastSector !== null) out.push('');
        out.push(`[${row.sector}]`);
        lastSector = row.sector;
      }
      const n = seen[row.name].length;
      const dup = n > 1 ? ` ⭐${n}` : '';
      for (const line of r.preset.format(row)) {
        out.push(line.replace('{DUP}', dup));
      }
    }
  }

  const dups = Object.entries(seen).filter(([, v]) => v.length > 1);
  if (dups.length > 0) {
    out.push('');
    out.push(LINE);
    out.push('⭐ 중복 종목');
    out.push(LINE);
    out.push('');
    for (const [name, list] of dups.sort((a, b) => b[1].length - a[1].length)) {
      out.push(`· ${name} — ${list.join(' + ')}`);
    }
  }

  out.push('');
  out.push('https://stockeasy.intellio.kr/stock-analysis/screener');
  return out.join('\n');
}

async function sendTelegram(text) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;
  if (!token || !chatId) {
    console.log('텔레그램 설정 없음 — 콘솔 출력만 합니다.\n');
    console.log(text);
    return;
  }
  const chunks = [];
  let buf = '';
  for (const block of text.split('\n\n')) {
    if ((buf + block).length > 3800) { chunks.push(buf); buf = ''; }
    buf += (buf ? '\n\n' : '') + block;
  }
  if (buf) chunks.push(buf);

  for (const c of chunks) {
    const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text: c, disable_web_page_preview: true }),
    });
    if (!res.ok) throw new Error(`텔레그램 전송 실패: ${res.status} ${await res.text()}`);
  }
  console.log(`텔레그램 전송 완료 (${chunks.length}건)`);
}

(async () => {
  const browser = await chromium.launch({ args: ['--no-sandbox'] });
  try {
    const ctx = await browser.newContext({
      locale: 'ko-KR',
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/151.0.0.0 Safari/537.36',
    });
    const cookies = parseCookies(process.env.STOCKEASY_SESSION);
    if (cookies.length === 0) throw new Error('STOCKEASY_SESSION 이 비어 있습니다.');
    await ctx.addCookies(cookies);

    const page = await ctx.newPage();
    const results = [];
    let updated = null;

    for (const preset of PRESETS) {
      const { rows, total } = await scrapePreset(page, preset);
      const filtered = sortRows(rows.filter(preset.filter), preset.sortKey);
      results.push({ preset, rows: filtered, total });
      console.log(`${preset.name}: ${filtered.length}/${total}종목`);

      if (!updated) {
        updated = await page.evaluate(() => {
          const m = document.body.innerText.match(/기준:\s*([\d.]+\s*[\d:]+)/);
          return m ? m[1].trim() : null;
        }).catch(() => null);
      }
    }

    await sendTelegram(buildMessage(results, updated));
  } catch (e) {
    console.error('실패:', e.message);
    process.exitCode = 1;
  } finally {
    await browser.close();
  }
})();
