import { Component, type ReactNode } from 'react';
import { useI18n } from './i18n';
import { EmptyState } from './States';

/**
 * A screen that crashes while drawing must not leave the whole app blank. This catches the error, says something went wrong
 * (the same words every error uses) and offers the way back. `resetKey` (the chat id) clears it when the person opens another chat.
 */
function Fallback({ onBack }: { onBack: () => void }) {
  const { t } = useI18n();
  return (
    <div role="alert" className="p-4 sm:p-6">
      <EmptyState icon="alert" title={t.errors.generic} action={<button className="btn btn-primary" onClick={onBack}>{t.back}</button>} />
    </div>
  );
}

interface Props { children: ReactNode; onBack: () => void; resetKey?: unknown }
export class ScreenGuard extends Component<Props, { failed: boolean; key: unknown }> {
  state = { failed: false, key: this.props.resetKey };
  static getDerivedStateFromError() { return { failed: true }; }
  static getDerivedStateFromProps(p: Props, s: { failed: boolean; key: unknown }) { return p.resetKey !== s.key ? { failed: false, key: p.resetKey } : null; }
  componentDidCatch(error: unknown) { console.error('[screen crashed]', error); }
  render() { return this.state.failed ? <Fallback onBack={this.props.onBack} /> : this.props.children; }
}
