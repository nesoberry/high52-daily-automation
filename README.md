# 신고가 종목 일일 자동 수집

매일 오후 4시 30분(한국시간), stockeasy.intellio.kr의 "신고가 돌파 종목"을 자동으로 수집해
구글 드라이브의 "신고가 종목" 폴더에 표 형태 구글 문서로 저장합니다.

## 구조
- **GitHub Actions** (`.github/workflows/high52.yml`): 매일 정해진 시각에 무인 실행.
- **extract.js**: 저장된 로그인 세션으로 stockeasy 페이지를 열어 데이터(종목명·분류·상승률·RS)를 추출하고, Apps Script 웹앱으로 전송.
- **Apps Script 웹앱**: 받은 데이터로 구글 문서를 만들어 드라이브 폴더에 저장.

## 필요한 GitHub Secrets (Settings → Secrets and variables → Actions)
| 이름 | 내용 |
|---|---|
| `STOCKEASY_SESSION` | 로그인 세션(storageState JSON 전체) |
| `APPSCRIPT_WEBAPP_URL` | Apps Script 웹앱 배포 URL (.../exec) |
| `SHARED_SECRET` | Apps Script 코드의 비밀문구와 동일한 값 |

## 수동 실행(테스트)
GitHub 저장소 → **Actions** 탭 → "신고가 종목 일일 수집" → **Run workflow**.

## 로그인 세션 만료 시 (약 한 달 주기 예상)
세션(`session_id` 쿠키)이 만료되면 수집이 실패합니다. 그때는 세션을 다시 저장하세요:
1. 크롬에서 stockeasy.intellio.kr 에 로그인.
2. Cookie-Editor 확장프로그램 → Export → Export as JSON 으로 쿠키 복사.
3. 그 값을 storageState 형식으로 변환해 `STOCKEASY_SESSION` Secret을 업데이트.

수집이 실패하면 GitHub가 등록된 이메일로 실패 알림을 보냅니다.
