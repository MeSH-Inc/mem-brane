// Shown on an empty brane: the three ideas that make mem-brane different,
// taught through the first actions rather than sample data.
export function FirstSteps({ canvas }: { canvas: boolean }) {
  return (
    <ol className="first-steps">
      <li>
        <strong>Write.</strong>{' '}
        {canvas ? 'Double-click anywhere, or drop an image or PDF.' : 'Add a thought or a file.'}
      </li>
      <li>
        <strong>Choose what the AI sees.</strong> Develop one card, or add cards to the prompt. Only
        what you pick is sent, and each response shows what it was based on.
      </li>
      <li>
        <strong>Keep going.</strong> Edit a source later and its responses say it changed; Continue
        a response to branch the conversation.
      </li>
    </ol>
  );
}
