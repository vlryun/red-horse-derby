import { Component, type ReactNode } from 'react';

/** 화면 일부가 터져도 전체가 하얗게 죽지 않도록 + 복구 버튼 제공 */
export class ErrorBoundary extends Component<{ children: ReactNode }, { error: Error | null }> {
  state = { error: null as Error | null };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  componentDidCatch(error: Error) {
    console.error('[ErrorBoundary]', error);
  }

  render() {
    if (this.state.error) {
      return (
        <div className="fatal">
          <h1>문제가 발생했어요</h1>
          <p>{this.state.error.message}</p>
          <button onClick={() => location.reload()}>새로고침</button>
        </div>
      );
    }
    return this.props.children;
  }
}
