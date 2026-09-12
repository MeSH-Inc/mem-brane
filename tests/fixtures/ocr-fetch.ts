// Test-process preload only. Every outbound fetch is blocked except this local
// OCR fixture response; the production adapter, worker and admission stay real.
globalThis.fetch = async (input, init) => {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
  if (
    url !== 'https://api.mistral.ai/v1/ocr' ||
    new Headers(init?.headers).get('authorization') !== 'Bearer test-ocr-no-network'
  )
    throw new Error('External network is disabled in the OCR browser fixture');
  const body = JSON.parse(String(init?.body));
  console.log('OCR_FIXTURE_DISPATCH');
  const original = Buffer.from(body.document.document_url.split(',')[1], 'base64');
  if (original.includes(Buffer.from('uncertain fixture')))
    throw new Error('Fixture lost response after dispatch');
  return Response.json({
    model: body.model,
    usage_info: { pages_processed: body.pages.length, doc_size_bytes: original.length },
    pages: body.pages.map((index: number) => ({
      index,
      markdown: `Enhanced scanned text ${index + 1}`,
      dimensions: { width: 600, height: 800 },
      blocks: [
        {
          type: 'text',
          content: `Enhanced scanned text ${index + 1}`,
          top_left_x: 60,
          top_left_y: 80,
          bottom_right_x: 540,
          bottom_right_y: 240,
        },
      ],
    })),
  });
};
