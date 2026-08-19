// 스탁이지 "신고가 후보" 수집 → 텔레그램 발송
// 실행: node candidates.js
//
// 필요한 환경변수 (GitHub Secrets)
//   STOCKEASY_SESSION   기존 봇과 동일한 쿠키 문자열 (예: "session_id=xxx; token=yyy; ...")
//   TELEGRAM_BOT_TOKEN  텔레그램 봇 토큰
//   TELEGRAM_CHAT_ID    받을 채팅 ID

const { chromium } = require('playwright');

const URL = 'https://stockeasy.intellio.kr/stock-analysis/new-high-candidates';
const DOMAIN = 'stockeasy.intellio.kr';

function parseCookies(raw) {
  if (!raw) return [];
  let s = raw.trim();

  // JSON 배열 형식도 허용 (기존 봇 호환)
  if (s.startsWith('[')) {
    try {
      return JSON.parse(s).map((c) => ({
        name: c.name,
        value: c.value,
        domain: c.domain || DOMAIN,
        path: c.path || '/',
      }));
    } catch (e) { /* 아래 단순 파싱으로 진행 */ }
  }

  return s
    .split(';')
    .map((p) => p.trim())
    .filter(Boolean)
    .map((p) => {
      const i = p.indexOf('=');
      return {
        name: p.slice(0, i).trim(),
        value: p.slice(i + 1).trim(),
        domain: DOMAIN,
        path: '/',
      };
    })
    .filter((c) => c.name && c.value);
}

// "891M 100" / ["89", "1M 100"] → { rs: 89, rs1m: 100 }
function parseRs(cell) {
  const lines = cell.lines.filter(Boolean);
  if (lines.length >= 2) {
    const rs = parseInt(lines[0].replace(/[^0-9]/g, ''), 10);
    // "1M 100" 처럼 앞의 1M 표기를 먼저 떼어낸다
    const m1 = lines[1].match(/1M\s*(\d+)/);
    const rs1m = m1 ? parseInt(m1[1], 10) : parseInt(lines[1].replace(/[^0-9]/g, ''), 10);
    if (!isNaN(rs)) return { rs, rs1m: isNaN(rs1m) ? null : rs1m };
  }
  const m = cell.text.match(/^(\d+)\s*1M\s*(\d+)$/);
  if (m) return { rs: +m[1], rs1m: +m[2] };
  const n = parseInt(cell.text.replace(/[^0-9]/g, ''), 10);
  return { rs: isNaN(n) ? null : n, rs1m: null };
}

function parseNameCode(cell) {
  const lines = cell.lines.filter(Boolean);
  const joined = lines.join(' ');
  const m = joined.match(/(\d{6})\s*(KOSPI|KOSDAQ|KONEX)?/);
  const code = m ? m[1] : null;
  const market = m && m[2] ? m[2] : '';
  let name = lines[0] || cell.text;
  if (code) name = name.replace(code, '').replace(/(KOSPI|KOSDAQ|KONEX)/, '').trim();
  return { name, code, market };
}

function parsePrices(cell) {
  const nums = cell.text.match(/[\d,]+원/g) || [];
  return {
    price: nums[0] ? nums[0].replace('원', '') : '',
    high52: nums[1] ? nums[1].replace('원', '') : '',
  };
}

function parseGap(cell) {
  const t = cell.text.replace(/\s+/g, ' ').trim();
  const m = t.match(/(-?[\d.]+)%\s*(돌파|남음)?/);
  if (!m) return { pct: null, label: t };
  return { pct: parseFloat(m[1]), label: m[2] || '' };
}

async function scrape() {
  const browser = await chromium.launch({ args: ['--no-sandbox'] });
  const ctx = await browser.newContext({
    locale: 'ko-KR',
    userAgent:
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/151.0.0.0 Safari/537.36',
  });

  const cookies = parseCookies(process.env.STOCKEASY_SESSION);
  if (cookies.length === 0) throw new Error('STOCKEASY_SESSION 이 비어 있습니다.');
  await ctx.addCookies(cookies);

  const page = await ctx.newPage();
  await page.goto(URL, { waitUntil: 'networkidle', timeout: 60000 });

  // 표가 그려질 때까지 대기 (후보가 0개인 날도 있으므로 실패해도 계속 진행)
  try {
    await page.waitForSelector('tbody tr', { timeout: 20000 });
  } catch (e) {
    console.log('표를 찾지 못했습니다 (후보 0개일 수 있음)');
  }

  const raw = await page.evaluate(() => {
    const rows = [...document.querySelectorAll('tbody tr')];
    return rows.map((tr) =>
      [...tr.querySelectorAll('td')].map((td) => ({
        text: (td.innerText || '').replace(/\s+/g, ' ').trim(),
        lines: (td.innerText || '')
          .split('\n')
          .map((s) => s.trim())
          .filter(Boolean),
      }))
    );
  });

  const updated = await page
    .evaluate(() => {
      const m = document.body.innerText.match(/(\d{4}-\d{2}-\d{2} \d{2}:\d{2})\s*갱신/);
      return m ? m[1] : null;
    })
    .catch(() => null);

  await browser.close();

  const items = [];
  for (const tds of raw) {
    if (tds.length < 9) continue;
    const nc = parseNameCode(tds[2]);
    if (!nc.code) continue;
    const gap = parseGap(tds[5]);
    const pr = parsePrices(tds[6]);
    const rs = parseRs(tds[tds.length - 1]);
    items.push({
      rank: parseInt(tds[1].text, 10) || items.length + 1,
      name: nc.name,
      code: nc.code,
      market: nc.market,
      sector: tds[3].text,
      status: tds[4].text,
      gapPct: gap.pct,
      gapLabel: gap.label,
      price: pr.price,
      high52: pr.high52,
      change: tds[7].text,
      amount: tds[8].text.replace(/\s+/g, ' ').trim(),
      rs: rs.rs,
      rs1m: rs.rs1m,
    });
  }

  return { items, updated };
}

function buildMessage({ items, updated }) {
  const today = new Date().toLocaleDateString('ko-KR', {
    timeZone: 'Asia/Seoul', month: '2-digit', day: '2-digit',
  });

  if (items.length === 0) {
    return `📊 신고가 후보 (${today})\n\n오늘은 해당 종목이 없습니다.`;
  }

  const lines = [`📊 신고가 후보 (${today}) · ${items.length}종목`];
  if (updated) lines.push(`갱신 ${updated}`);
  lines.push('');

  for (const it of items) {
    const gap =
      it.gapPct === null ? '' :
      it.gapLabel === '돌파' ? `${it.gapPct}% 돌파` : `${it.gapPct}% 남음`;
    const rs = it.rs1m === null ? `RS ${it.rs}` : `RS ${it.rs}/${it.rs1m}`;
    lines.push(`▪️ ${it.name} (${it.code})`);
    lines.push(`   [${it.status}] ${gap} · ${it.sector}`);
    lines.push(`   ${it.price}원 · ${it.change} · ${rs}`);
    lines.push(`   ${it.amount}`);
    lines.push('');
  }

  lines.push('https://stockeasy.intellio.kr/stock-analysis/new-high-candidates');
  return lines.join('\n');
}

async function sendTelegram(text) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;
  if (!token || !chatId) {
    console.log('텔레그램 설정 없음 — 콘솔 출력만 합니다.\n');
    console.log(text);
    return;
  }

  // 텔레그램 메시지 길이 제한(4096자) 대응
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
      body: JSON.stringify({
        chat_id: chatId,
        text: c,
        disable_web_page_preview: true,
      }),
    });
    if (!res.ok) throw new Error(`텔레그램 전송 실패: ${res.status} ${await res.text()}`);
  }
  console.log(`텔레그램 전송 완료 (${chunks.length}건)`);
}

(async () => {
  try {
    const data = await scrape();
    console.log(`수집 완료: ${data.items.length}종목`);
    await sendTelegram(buildMessage(data));
  } catch (e) {
    console.error('실패:', e.message);
    process.exit(1);
  }
})();
