import type { FinishRecord } from '../engine';
import { hex, horseColor, textOn } from '../game/palette';

function fmt(ms: number | null): string {
  return ms === null ? '—' : `${(ms / 1000).toFixed(2)}초`;
}

interface Props {
  standings: FinishRecord[];
  hash: string;
  /** 공식(서버 공개) 결과인지 */
  official?: boolean;
  /** 결과표 위 안내 문구 (예: 서버 연결 끊김) */
  note?: string;
  onClose?: () => void;
}

/** 최종 순위표 — 1·2등 크게 강조, 나머지는 격자 */
export function ResultsBoard({ standings, hash, official, note, onClose }: Props) {
  const sorted = [...standings].sort((a, b) => a.rank - b.rank);
  const [first, second, ...rest] = sorted;

  return (
    <div className="results" role="dialog" aria-label="최종 순위">
      <h1 className="results-title">🏁 {official ? '공식 결과' : '최종 순위'}</h1>
      {note && <p className="results-note">{note}</p>}
      <div className="podium">
        {[first, second].map(
          (s, i) =>
            s && (
              <div key={s.id} className={`podium-card ${i === 0 ? 'gold' : 'silver'}`}>
                <div className="podium-rank">{i === 0 ? '🏆 1등' : '🥈 2등'}</div>
                <div className="podium-name">{s.name}</div>
                <div className="podium-meta">
                  <span className="chip" style={{ background: hex(horseColor(s.id)), color: textOn(horseColor(s.id)) }}>
                    {s.id}
                  </span>
                  {fmt(s.finishMs)}
                </div>
              </div>
            ),
        )}
      </div>
      <ol className="results-grid" start={3}>
        {rest.map((s) => (
          <li key={s.id}>
            <span className="r">{s.rank}</span>
            <span className="chip" style={{ background: hex(horseColor(s.id)), color: textOn(horseColor(s.id)) }}>
              {s.id}
            </span>
            <span className="n">{s.name}</span>
            <span className="t">{fmt(s.finishMs)}</span>
          </li>
        ))}
      </ol>
      <div className="results-foot">
        결과 해시 {hash}
        {onClose && (
          <button onClick={onClose} className="ghost">
            닫기
          </button>
        )}
      </div>
    </div>
  );
}
