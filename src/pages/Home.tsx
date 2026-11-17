import { Link } from 'react-router-dom';

export function Home() {
  return (
    <main className="home">
      <h1>붉은 말의 대질주</h1>
      <p className="sub">50인 동시 참여 웹 경마 · 개발 3단계</p>
      <nav className="home-links">
        <Link to="/screen" className="card">
          <strong>🖥️ 대형 스크린</strong>
          <span>QR 코드 + 실시간 대기실</span>
        </Link>
        <Link to="/play" className="card">
          <strong>📱 참가자 화면</strong>
          <span>QR 코드로 들어오는 곳 · 닉네임 등록 · 내 말 정보</span>
        </Link>
        <Link to="/demo" className="card">
          <strong>🏇 경주 데모</strong>
          <span>가상 참가자로 경주만 실행 (시드·인원·경주 시간 조정)</span>
        </Link>
        <Link to="/admin" className="card">
          <strong>🔐 관리자</strong>
          <span>참가 마감 · 경주 시작 · 일시정지 · 결과 공개 · 다음 라운드</span>
        </Link>
      </nav>
    </main>
  );
}
