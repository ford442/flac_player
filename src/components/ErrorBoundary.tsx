import React from 'react';

interface ErrorBoundaryState {
  error: Error | null;
}

/**
 * Top-level render-error boundary (#258): a component that throws shows this
 * panel instead of unmounting the whole app to a blank page.
 */
export class ErrorBoundary extends React.Component<{ children?: React.ReactNode }, ErrorBoundaryState> {
  state: ErrorBoundaryState = { error: null };

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { error };
  }

  componentDidCatch(error: Error, info: React.ErrorInfo): void {
    console.error('[ErrorBoundary] render failed', error, info.componentStack);
  }

  private retry = () => this.setState({ error: null });

  render() {
    const { error } = this.state;
    if (!error) return this.props.children;
    return (
      <div role="alert" className="min-h-screen flex items-center justify-center bg-surface text-white p-6">
        <div className="max-w-md w-full rounded-xl border border-red-500/40 bg-red-950/40 p-6 space-y-4">
          <h1 className="text-lg font-semibold text-red-200">Something went wrong</h1>
          <p className="text-sm text-red-100/80 break-words">{error.message || String(error)}</p>
          <div className="flex gap-3">
            <button onClick={this.retry} className="px-4 py-2 rounded bg-white/10 hover:bg-white/20 text-sm">Try again</button>
            <button onClick={() => window.location.reload()} className="px-4 py-2 rounded bg-red-500/80 hover:bg-red-500 text-sm">Reload</button>
          </div>
        </div>
      </div>
    );
  }
}
