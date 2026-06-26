import React from 'react';
import { ErrorState } from './ui';

interface Props {
  children: React.ReactNode;
}
interface State {
  error: Error | null;
}

/**
 * Catches render errors anywhere in the tree so a single bad screen shows a
 * recoverable error state instead of white-screening the whole app.
 */
export class ErrorBoundary extends React.Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: React.ErrorInfo): void {
    console.error('[ErrorBoundary]', error, info.componentStack);
  }

  reset = (): void => this.setState({ error: null });

  render(): React.ReactNode {
    if (this.state.error) {
      return (
        <ErrorState
          title="Something broke"
          message={this.state.error.message || 'An unexpected error occurred.'}
          onRetry={this.reset}
        />
      );
    }
    return this.props.children;
  }
}
