// 신고가 돌파 종목 수집 → Apps Script 웹앱으로 전송
// 저장된 로그인 세션(쿠키)으로 진짜 브라우저를 띄워 stockeasy 페이지를 연 뒤,
// 서버가 발급한 유효 토큰으로 데이터 API를 호출해 결과를 추출한다.
//
// STOCKEASY_SESSION 형식 두 가지 모두 지원:
//  1) 단순 쿠키 문자열: "session_id=abc; token=xyz; user=...; sk_default_market=..."
//     (브라우저 콘솔에서 copy(document.cookie) 결과를 그대로 붙여넣어도 됨)
//  2) 기존 storageState JSON 형식 (하위 호환)
//
// 실행 성공 시 서버가 갱신해준 최신 쿠키를 new_session.txt로 저장 → update-secret.js가 Secret을 자동 연장.
// 신고가 종목이 0개인 날에도 "종목 없음" 문서를 남기기 위해 웹앱은 항상 호출한다 (Apps Script가 빈 목록을 처리).

const { chromium } = require('playwright');
const fs = require('fs');

const PAGE_URL = 'https://stockeasy.intellio.kr/stock-analysis?tab=high52';
const API_PATH = '/stockdata/api/v1/high52/dashboard-data';
const COOKIE_DOMAIN = 'stockeasy.intellio.kr';

function buildStorageState(sessionRaw) {
  const trimmed = sessionRaw.trim();

  if (trimmed.startsWith('{')) {
    return JSON.parse(trimmed);
  }

  const cookies = trimmed
    .split(';')
    .map(function (pair) { return pair.trim(); })
    .filter(function (pair) { return pair.length > 0; })
    .map(function (pair) {
      const idx = pair.indexOf('=');
      if (idx === -1) return null;
      const name = pair.slice(0, idx).trim();
      const value = pair.slice(idx + 1).trim();
      return {
        name: name,
        value: value,
        domain: COOKIE_DOMAIN,
        path: '/',
        expires: -1,
        httpOnly: false,
        secure: true,
        sameSite: 'Lax'
      };
    })
    .filter(Boolean);

  if (cookies.length === 0) {
    throw new Error('STOCKEASY_SESSION에서 쿠키를 파싱하지 못했습니다. "name=value; name=value" 형식인지 확인하세요.');
  }

  return { cookies: cookies, origins: [] };
}

(async () => {
  const webappUrl = process.env.APPSCRIPT_WEBAPP_URL;
  const sharedSecret = process.env.SHARED_SECRET;
  const sessionRaw = process.env.STOCKEASY_SESSION;

  if (!webappUrl || !sharedSecret || !sessionRaw) {
    console.error('환경변수 누락: APPSCRIPT_WEBAPP_URL / SHARED_SECRET / STOCKEASY_SESSION 중 하나가 없음');
    process.exit(1);
  }

  let storageState;
  try {
    storageState = buildStorageState(sessionRaw);
  } catch (e) {
    console.error('STOCKEASY_SESSION 파싱 실패:', e.message);
    console.error('세션이 손상되었을 수 있음 → 세션 재저장 필요.');
    process.exit(1);
  }

  fs.writeFileSync('storageState.json', JSON.stringify(storageState));

  const browser = await chromium.launch();
  const context = await browser.newContext({ storageState: 'storageState.json' });
  const page = await context.newPage();

  await page.goto(PAGE_URL, { waitUntil: 'load', timeout: 60000 });
  await page.waitForTimeout(2500);

  const result = await page.evaluate(async (apiPath) => {
    const r = await fetch(apiPath, { headers: { accept: 'application/json' } });
    if (r.status !== 200) return { httpStatus: r.status, rows: [] };
    const j = await r.json();
    const meta = j.data.metadata;
    const rows = j.data.high52_list.map(function (x) {
      return {
        name: x[1],
        category: Array.isArray(x[2]) ? x[2].join(', ') : x[2],
        rate: x[4],
        rs: (x[6] === null || x[6] === undefined) ? null : x[6]
      };
    });
    return { httpStatus: 200, target_date: meta.target_date, rows: rows };
  }, API_PATH);

  const freshCookies = await context.cookies();
  await browser.close();

  if (result.httpStatus !== 200) {
    console.error('데이터 API 인증 실패 (status=' + result.httpStatus + '). 세션이 만료됐을 수 있음 → 세션 재저장 필요.');
    process.exit(1);
  }

  const relevant = freshCookies.filter(function (c) { return c.domain.indexOf('intellio.kr') !== -1; });
  const cookieStr = relevant.map(function (c) { return c.name + '=' + c.value; }).join('; ');
  if (cookieStr.indexOf('session_id=') !== -1 && cookieStr.indexOf('token=') !== -1) {
    fs.writeFileSync('new_session.txt', cookieStr);
    console.log('갱신된 세션 확보 완료 (자동 연장 대기)');
  } else {
    console.log('갱신 쿠키에 핵심 값이 없어 세션 파일 저장을 건너뜁니다.');
  }

  if (!result.rows || result.rows.length === 0) {
    console.log('신고가 데이터 없음 → "종목 없음" 문서를 생성하도록 웹앱을 그대로 호출합니다.');
  } else {
    console.log('추출 완료: 기준일 ' + result.target_date + ', 종목 ' + result.rows.length + '개');
  }

  const resp = await fetch(webappUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ secret: sharedSecret, target_date: result.target_date, rows: result.rows || [] }),
    redirect: 'follow'
  });
  const text = await resp.text();
  console.log('웹앱 응답:', text);

  if (!resp.ok) {
    console.error('웹앱 호출 실패 status=' + resp.status);
    process.exit(1);
  }
})().catch(function (e) {
  console.error('실행 중 오류:', e);
  process.exit(1);
});
