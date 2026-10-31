// 배포에서는 화면을 GitHub Pages가, Gemini 호출을 Cloud Run 서버가 맡는다(키는 서버에만 있다).
// 로컬에서 npm start로 열면 같은 서버의 /api를 그대로 쓴다.
const CLOUD_RUN_URL = 'https://ai-investment-committee-1081397156656.asia-northeast3.run.app';

export const API_BASE = location.hostname.endsWith('github.io') ? CLOUD_RUN_URL : '';
