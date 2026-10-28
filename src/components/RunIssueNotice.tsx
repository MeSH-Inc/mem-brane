import { requestAccount } from '../services/account-prompt';
import { runIssueAction, runIssueText, type RunIssue } from '../services/run-issues';

// One place states why Run is refused or blocked, with the one action that helps.
export function RunIssueNotice({
  id,
  issue,
  model,
  models,
  canRunAgain,
  onUseMock,
  onRunAgain,
}: {
  id: string;
  issue: RunIssue;
  model: string;
  models: string[];
  canRunAgain: boolean;
  onUseMock: () => void;
  onRunAgain: () => void;
}) {
  const action = runIssueAction(issue, model, models);
  return (
    <div id={id} role="alert" className="run-issue">
      <p className="error">{runIssueText(issue)}</p>
      {action === 'account' && (
        <button onClick={() => requestAccount({ mode: 'signup', reason: issue.message })}>
          Create a free account
        </button>
      )}
      {action === 'mock_model' && <button onClick={onUseMock}>Use the local mock model</button>}
      {action === 'run_again' && canRunAgain && <button onClick={onRunAgain}>Run again</button>}
    </div>
  );
}
