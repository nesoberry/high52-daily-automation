// 신고가 돌파 종목 수집 → Apps Script 웹앱으로 전송
// 저장된 로그인 세션(storageState)으로 진짜 브라우저를 띄워 stockeasy 페이지를 연 뒤,
// 서버가 발급한 유효 토큰으로 데이터 API를 호출해 결과를 추출한다.

const { chromium } = require('playwright');
const fs = require('fs');

const PAGE_URL = 'https://stockeasy.intellio.kr/stock-analysis?tab=high52';
const API_PATH = '/stockdata/api/v1/high52/dashboard-data';

(async () => {
  const webappUrl = process.env.APPSCRIPT_WEBAPP_URL;
  const sharedSecret = process.env.SHARED_SECRET;
  const sessionJson = process.env.STOCKEASY_SESSION;

  if (!webappUrl || !sharedSecret || !sessionJson) {
    console.error('환경변수 누락: APPSCRIPT_WEBAPP_URL / SHARED_SECRET / STOCKEASY_SESSION 중 하나가 없음');
    process.exit(1);
  }

  // GitHub Secret으로 받은 세션을 임시 파일로 저장
  fs.writeFileSync('storageState.json', sessionJson);

  const browser = await chromium.launch();
  const context = await browser.newContext({ storageState: 'storageState.json' });
  const page = await context.newPage();

  // 페이지 로드 → 서버가 session_id로 새 token을 발급(쿠키 갱신)
  await page.goto(PAGE_URL, { waitUntil: 'load', timeout: 60000 });
  await page.waitForTimeout(2500); // 토큰 갱신/초기화 여유

  // 같은 출처(브라우저)에서 데이터 API 호출 → 추출
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

  await browser.close();

  // 인증 실패(세션 만료 등)
  if (result.httpStatus !== 200) {
    console.error('데이터 API 인증 실패 (status=' + result.httpStatus + '). 세션이 만료됐을 수 있음 → 세션 재저장 필요.');
    process.exit(1);
  }

  // 데이터 없음(장 미개장 등) → 조용히 종료
  if (!result.rows || result.rows.length === 0) {
    console.log('신고가 데이터 없음 → 문서 생성 생략, 정상 종료.');
    process.exit(0);
  }

  console.log('추출 완료: 기준일 ' + result.target_date + ', 종목 ' + result.rows.length + '개');

  // Apps Script 웹앱으로 전송 → 구글 문서 생성
  const resp = await fetch(webappUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ secret: sharedSecret, target_date: result.target_date, rows: result.rows }),
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
