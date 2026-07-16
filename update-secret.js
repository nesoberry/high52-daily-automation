// 세션 자동 연장: extract.js가 저장한 최신 쿠키(new_session.txt)를
// GitHub Secret(STOCKEASY_SESSION)에 다시 써넣는다.
// GH_PAT(Secrets 쓰기 권한이 있는 Fine-grained PAT)가 필요하다.

const fs = require('fs');
const sodium = require('libsodium-wrappers');

const SECRET_NAME = 'STOCKEASY_SESSION';

(async () => {
  const pat = process.env.GH_PAT;
  const repo = process.env.REPO; // 예: nesoberry/high52-daily-automation

  if (!pat || !repo) {
    console.log('GH_PAT 또는 REPO 환경변수가 없어 세션 자동 연장을 건너뜁니다.');
    process.exit(0);
  }

  if (!fs.existsSync('new_session.txt')) {
    console.log('new_session.txt 없음 → 갱신할 세션이 없어 건너뜁니다.');
    process.exit(0);
  }

  const newSession = fs.readFileSync('new_session.txt', 'utf8').trim();
  if (!newSession.includes('session_id=') || !newSession.includes('token=')) {
    console.log('갱신된 쿠키에 핵심 값이 없어 Secret 갱신을 건너뜁니다 (기존 Secret 유지).');
    process.exit(0);
  }

  const headers = {
    Authorization: 'Bearer ' + pat,
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28'
  };

  // 1) 저장소의 Secret 암호화용 공개키 가져오기
  const keyResp = await fetch('https://api.github.com/repos/' + repo + '/actions/secrets/public-key', { headers });
  if (!keyResp.ok) {
    console.error('공개키 조회 실패 status=' + keyResp.status + ' (GH_PAT 권한을 확인하세요: Secrets Read/Write)');
    process.exit(1);
  }
  const publicKey = await keyResp.json();

  // 2) libsodium sealed box로 암호화 (GitHub Secret 규격)
  await sodium.ready;
  const binKey = sodium.from_base64(publicKey.key, sodium.base64_variants.ORIGINAL);
  const binSecret = sodium.from_string(newSession);
  const encrypted = sodium.to_base64(sodium.crypto_box_seal(binSecret, binKey), sodium.base64_variants.ORIGINAL);

  // 3) Secret 갱신
  const putResp = await fetch('https://api.github.com/repos/' + repo + '/actions/secrets/' + SECRET_NAME, {
    method: 'PUT',
    headers: Object.assign({ 'Content-Type': 'application/json' }, headers),
    body: JSON.stringify({ encrypted_value: encrypted, key_id: publicKey.key_id })
  });

  if (putResp.status === 201 || putResp.status === 204) {
    console.log('세션 자동 연장 완료: ' + SECRET_NAME + ' Secret이 최신 쿠키로 갱신되었습니다.');
  } else {
    console.error('Secret 갱신 실패 status=' + putResp.status);
    process.exit(1);
  }
})().catch(function (e) {
  console.error('세션 자동 연장 중 오류:', e);
  process.exit(1);
});
