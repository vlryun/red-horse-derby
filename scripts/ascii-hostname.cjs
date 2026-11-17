// Vercel CLI 는 컴퓨터 이름을 HTTP 헤더로 보내는데, 이름에 한글이 있으면
// "Cannot convert argument to a ByteString" 오류로 로그인/배포가 실패한다.
// 이 파일을 미리 불러와(NODE_OPTIONS=--require) 그 명령에서만 영문 이름을 쓰게 한다. PC 설정은 바꾸지 않음.
const os = require('os');
const original = os.hostname;
os.hostname = () => {
  const name = original.call(os);
  return /^[\x20-\x7e]*$/.test(name) ? name : 'rhd-dev-pc';
};
