import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { deflateRawSync, crc32 } from 'node:zlib';
import { createApp } from '../src/app.js';
import { openDb } from '../src/db.js';
import { createAi, cleanQuestions, materialBlocks, aiConfigFromEnv, MODEL } from '../src/ai.js';
import { unzip, pptxSlides, docxText, kindOf } from '../src/slides.js';

const NOW = Date.UTC(2026, 10, 14, 12, 0, 0);

// Minimal zip writer, enough to build .pptx/.docx fixtures.
function zip(entries) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const [name, content] of Object.entries(entries)) {
    const raw = Buffer.from(content);
    const packed = deflateRawSync(raw);
    const nameBuf = Buffer.from(name);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(8, 8);
    local.writeUInt32LE(crc32(raw), 14);
    local.writeUInt32LE(packed.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(8, 10);
    central.writeUInt32LE(crc32(raw), 16);
    central.writeUInt32LE(packed.length, 20);
    central.writeUInt32LE(raw.length, 24);
    central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt32LE(offset, 42);
    locals.push(local, nameBuf, packed);
    centrals.push(central, nameBuf);
    offset += 30 + nameBuf.length + packed.length;
  }
  const dir = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(centrals.length / 2, 8);
  end.writeUInt16LE(centrals.length / 2, 10);
  end.writeUInt32LE(dir.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, dir, end]);
}

const slideXml = (...paragraphs) => `<?xml version="1.0"?><p:sld><p:cSld><p:spTree>${
  paragraphs.map((p) => `<a:p><a:r><a:rPr lang="uk"/><a:t>${p}</a:t></a:r></a:p>`).join('')
}</p:spTree></p:cSld></p:sld>`;

const PPTX = zip({
  '[Content_Types].xml': '<Types/>',
  'ppt/slides/slide2.xml': slideXml('Big O', 'Nested loops over n items take O(n&#178;) time'),
  'ppt/slides/slide1.xml': slideXml('Complexity &amp; recursion'),
  'ppt/slides/slide10.xml': slideXml('Summary'),
});

test('slides: unzip, pptx slides in order with entities decoded, docx text', () => {
  assert.deepEqual([...unzip(PPTX, (n) => n.startsWith('ppt/')).keys()].sort(), [
    'ppt/slides/slide1.xml', 'ppt/slides/slide10.xml', 'ppt/slides/slide2.xml',
  ]);
  assert.deepEqual(pptxSlides(PPTX), [
    { slide: 1, text: 'Complexity & recursion' },
    { slide: 2, text: 'Big O\nNested loops over n items take O(n²) time' },
    { slide: 10, text: 'Summary' },
  ]);
  const docx = zip({ 'word/document.xml': '<w:document><w:body><w:p><w:r><w:t xml:space="preserve">Hash </w:t></w:r><w:r><w:t>tables</w:t></w:r></w:p></w:body></w:document>' });
  assert.equal(docxText(docx), 'Hash tables');
  assert.throws(() => unzip(Buffer.from('not a zip at all, definitely not')), /Not a zip/);
  assert.equal(kindOf('Lecture 3.PDF'), 'pdf');
  assert.equal(kindOf('slides.ppt'), null);
});

test('ai: material blocks label every file and skip what cannot be read', () => {
  const { blocks, slideCount, skipped } = materialBlocks([
    { id: 1, filename: 'l1.pptx', data: PPTX },
    { id: 2, filename: 'l2.pdf', data: Buffer.from('%PDF-1.4 fake') },
    { id: 3, filename: 'notes.md', data: Buffer.from('# Graphs\nBFS uses a queue') },
    { id: 4, filename: 'photo.png', data: Buffer.from('png') },
    { id: 5, filename: 'broken.pptx', data: Buffer.from('nope') },
  ]);
  assert.match(blocks[0].text, /^Material 1: l1\.pptx\n--- slide 1 ---\nComplexity & recursion/);
  assert.equal(blocks[2].type, 'document');
  assert.equal(blocks[2].source.media_type, 'application/pdf');
  assert.equal(Buffer.from(blocks[2].source.data, 'base64').toString(), '%PDF-1.4 fake');
  assert.match(blocks[3].text, /^Material 3: notes\.md \(no slides; slide = 0\)\n# Graphs/);
  assert.deepEqual([...slideCount.entries()], [[1, 10], [2, Infinity], [3, 0]]);
  assert.deepEqual(skipped.map((s) => s.filename), ['photo.png', 'broken.pptx']);
});

test('ai: clean questions drops malformed ones and stops at the asked count', () => {
  const slideCount = new Map([[1, 10], [3, 0]]);
  const good = (extra = {}) => ({
    topic: ' Big  O ', prompt: ' A loop inside a loop over 1000 items runs how many times? ', options: ['1000', '1 000 000', '2000'],
    answer_index: 1, material_id: 1, slide: 2, quote: 'Nested loops take O(n²)', ...extra,
  });
  const raw = [
    good(),
    good({ topic: '  ' }), // no topic name
    good({ material_id: 2 }), // file that was not sent
    good({ slide: 11 }), // past the last slide
    good({ answer_index: 3 }),
    good({ options: ['same', 'same'] }),
    good({ options: ['only one'] }),
    good({ prompt: '' }),
    ...Array.from({ length: 6 }, (_, i) => good({ prompt: `Variant ${i}`, topic: i % 2 ? 'Recursion' : 'Big O' })),
  ];
  const cleaned = cleanQuestions(raw, 4, slideCount);
  assert.equal(cleaned.length, 4, 'stops at the asked count');
  assert.deepEqual(cleaned[0], {
    topic: 'Big O', prompt: 'A loop inside a loop over 1000 items runs how many times?', options: ['1000', '1 000 000', '2000'],
    answerIndex: 1, explanation: '', materialId: 1, slide: 2, quote: 'Nested loops take O(n²)',
  });
  assert.deepEqual(cleaned.map((q) => q.topic), ['Big O', 'Big O', 'Recursion', 'Big O']);
  assert.deepEqual(cleanQuestions(raw, 30, slideCount).length, 7);
  assert.deepEqual(
    cleanQuestions([good({ material_id: 3, slide: 2 })], 5, slideCount).map((q) => q.slide),
    [0], 'notes without slides keep the question, with slide 0',
  );
  assert.deepEqual(cleanQuestions('nonsense', 5, slideCount), []);
});

function fakeClaude(reply, status = 200) {
  const requests = [];
  const fetchImpl = async (url, init) => {
    requests.push({ url, headers: init.headers, body: JSON.parse(init.body) });
    return new Response(JSON.stringify(typeof reply === 'function' ? reply(requests.at(-1).body) : reply), { status });
  };
  return { requests, fetchImpl };
}

async function start(ai) {
  const telegram = { enabled: false, botName: async () => null, send: async () => {} };
  const app = createApp({ db: openDb(':memory:'), now: () => NOW, telegram, ai });
  const server = createServer(app.handler);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  let cookie = '';
  const call = async (method, path, body) => {
    const headers = body === undefined ? {} : { 'content-type': 'application/json' };
    if (cookie) headers.cookie = cookie;
    const res = await fetch(base + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    const setCookie = res.headers.get('set-cookie');
    if (setCookie) cookie = setCookie.split(';')[0];
    return { status: res.status, data: await res.json() };
  };
  const close = () => {
    server.closeAllConnections();
    return new Promise((resolve) => server.close(resolve));
  };
  return { call, close };
}

async function examWithSlides(call) {
  await call('POST', '/api/register', { username: 'olena', password: 'correct horse' });
  const exam = (await call('POST', '/api/exams', { title: 'Algorithms', course: 'CS', examAt: NOW + 10 * 86_400_000 })).data;
  const topic = (await call('POST', `/api/exams/${exam.id}/topics`, { name: 'Big O' })).data;
  const material = (await call('POST', `/api/exams/${exam.id}/materials`, { filename: 'l1.pptx', data: PPTX.toString('base64') })).data;
  return { exam, topic, material };
}

test('ai: generate stores questions with their slide and shows the source', async (t) => {
  let topicId;
  let materialId;
  const claude = fakeClaude(() => ({
    stop_reason: 'end_turn',
    content: [
      { type: 'thinking', thinking: '' },
      { type: 'text', text: JSON.stringify({ questions: [
        { topic: 'Big O', prompt: 'Two nested loops over 50 items: how many steps?', options: ['100', '2500', '50'], answer_index: 1, explanation: '50 × 50 = 2500: the inner loop runs fully for each outer step.', material_id: materialId, slide: 2, quote: 'Nested loops' },
        { topic: 'Big O', prompt: 'Bad slide', options: ['a', 'b'], answer_index: 0, material_id: materialId, slide: 42, quote: '' },
      ] }) },
    ],
  }));
  const { call, close } = await start(createAi({ apiKey: 'test-key', fetchImpl: claude.fetchImpl }));
  t.after(close);
  const { exam, topic, material } = await examWithSlides(call);
  topicId = topic.id;
  materialId = material.id;

  assert.deepEqual((await call('GET', `/api/exams/${exam.id}`)).data.ai, { enabled: true, model: MODEL, label: 'Claude' });
  const r = await call('POST', `/api/exams/${exam.id}/generate`, {});
  assert.equal(r.status, 200);
  assert.equal(r.data.added, 1);
  assert.deepEqual(r.data.skipped, []);
  const [q] = r.data.topics[0].questions;
  assert.equal(q.prompt, 'Two nested loops over 50 items: how many steps?');
  assert.deepEqual(q.source, { materialId: material.id, filename: 'l1.pptx', slide: 2, quote: 'Nested loops' });

  const [request] = claude.requests;
  assert.equal(request.url, 'https://api.anthropic.com/v1/messages');
  assert.equal(request.headers['x-api-key'], 'test-key');
  assert.equal(request.body.model, MODEL);
  assert.equal(request.body.output_config.format.type, 'json_schema');
  assert.match(request.body.system, /practical/);
  assert.match(request.body.messages[0].content.at(-1).text, /Write 10 questions\.[\s\S]*- Big O/);

  // A second run tells Claude which questions already exist, and the test uses the generated question.
  await call('POST', `/api/exams/${exam.id}/generate`, {});
  assert.match(claude.requests[1].body.messages[0].content.at(-1).text, /already has: Two nested loops/);
  const testQuestions = (await call('GET', `/api/exams/${exam.id}/test`)).data.questions;
  assert.equal(testQuestions.length, 2);

  // Deleting the slides keeps the question and the file name it came from.
  await call('DELETE', `/api/materials/${material.id}`);
  const after = (await call('GET', `/api/exams/${exam.id}`)).data.topics[0].questions[0];
  assert.deepEqual(after.source, { materialId: null, filename: 'l1.pptx', slide: 2, quote: 'Nested loops' });
});

test('ai: generate needs a key and slides, checks the count; errors and refusals are reported', async (t) => {
  const off = await start(createAi({}));
  t.after(off.close);
  const { exam: offExam } = await examWithSlides(off.call);
  assert.equal((await off.call('GET', `/api/exams/${offExam.id}`)).data.ai.enabled, false);
  assert.equal((await off.call('POST', `/api/exams/${offExam.id}/generate`, {})).status, 503);

  const refusing = fakeClaude({ stop_reason: 'refusal', content: [] });
  const on = await start(createAi({ apiKey: 'k', fetchImpl: refusing.fetchImpl }));
  t.after(on.close);
  await on.call('POST', '/api/register', { username: 'taras', password: 'correct horse' });
  const exam = (await on.call('POST', '/api/exams', { title: 'Calculus', examAt: NOW + 5 * 86_400_000 })).data;
  assert.match((await on.call('POST', `/api/exams/${exam.id}/generate`, {})).data.error, /слайди лекцій/);
  await on.call('POST', `/api/exams/${exam.id}/materials`, { filename: 'photo.png', data: Buffer.from('png').toString('base64') });
  assert.match((await on.call('POST', `/api/exams/${exam.id}/generate`, {})).data.error, /PDF або PPTX/);
  await on.call('POST', `/api/exams/${exam.id}/materials`, { filename: 'l1.pptx', data: PPTX.toString('base64') });
  for (const count of [0, 31, 2.5, '5']) {
    assert.match((await on.call('POST', `/api/exams/${exam.id}/generate`, { count })).data.error, /від 1 до 30 питань/);
  }
  assert.equal(refusing.requests.length, 0);
  const refused = await on.call('POST', `/api/exams/${exam.id}/generate`, {});
  assert.equal(refused.status, 422);
  assert.equal(refusing.requests.length, 1);

  const failing = fakeClaude({ type: 'error', error: { type: 'overloaded_error', message: 'Overloaded' } }, 529);
  const busy = await start(createAi({ apiKey: 'k', fetchImpl: failing.fetchImpl }));
  t.after(busy.close);
  const { exam: busyExam } = await examWithSlides(busy.call);
  assert.equal((await busy.call('POST', `/api/exams/${busyExam.id}/generate`, {})).status, 503);
});

test('ai: asks for the chosen number of questions and files them under the topics the model names', async (t) => {
  let materialId;
  const q = (topic, prompt) => ({ topic, prompt, options: ['a', 'b', 'c'], answer_index: 0, material_id: materialId, slide: 1, quote: '' });
  const claude = fakeClaude(() => ({
    stop_reason: 'end_turn',
    content: [{ type: 'text', text: JSON.stringify({ questions: [
      q('big o', 'Q1'), q('Recursion', 'Q2'), q('Recursion', 'Q3'), q('Big O', 'Q4'), q('Sorting', 'Q5 over the count'),
    ] }) }],
  }));
  const { call, close } = await start(createAi({ apiKey: 'k', fetchImpl: claude.fetchImpl }));
  t.after(close);
  const { exam, material } = await examWithSlides(call); // has the topic "Big O"
  materialId = material.id;

  const r = await call('POST', `/api/exams/${exam.id}/generate`, { count: 4 });
  assert.equal(r.status, 200);
  assert.equal(r.data.added, 4);
  assert.match(claude.requests[0].body.messages[0].content.at(-1).text, /Write 4 questions\./);
  assert.deepEqual(
    r.data.topics.map((tp) => [tp.name, tp.questions.map((x) => x.prompt)]),
    [['Big O', ['Q1', 'Q4']], ['Recursion', ['Q2', 'Q3']]],
    'reuses an existing topic whatever its case, creates the new one, stops at 4',
  );

  // Without any topics the model names them all.
  await call('DELETE', `/api/topics/${r.data.topics[0].id}`);
  await call('DELETE', `/api/topics/${r.data.topics[1].id}`);
  const fresh = await call('POST', `/api/exams/${exam.id}/generate`, { count: 2 });
  assert.match(claude.requests[1].body.messages[0].content.at(-1).text, /no topics yet/);
  assert.deepEqual(fresh.data.topics.map((tp) => tp.name), ['big o', 'Recursion']);
});

test('ai: generation is limited per day', async (t) => {
  const claude = fakeClaude({ stop_reason: 'end_turn', content: [{ type: 'text', text: '{"questions":[]}' }] });
  const { call, close } = await start(createAi({ apiKey: 'k', fetchImpl: claude.fetchImpl }));
  t.after(close);
  const { exam } = await examWithSlides(call);
  for (let i = 0; i < 10; i++) assert.equal((await call('POST', `/api/exams/${exam.id}/generate`, {})).status, 200);
  const limited = await call('POST', `/api/exams/${exam.id}/generate`, {});
  assert.equal(limited.status, 429);
  assert.equal(claude.requests.length, 10);
});

test('ai: provider comes from AI_PROVIDER or the shape of the key', () => {
  assert.equal(aiConfigFromEnv({}).provider, 'claude');
  assert.deepEqual(aiConfigFromEnv({ ANTHROPIC_API_KEY: 'sk-ant-1' }), { provider: 'claude', apiKey: 'sk-ant-1', model: undefined });
  assert.equal(aiConfigFromEnv({ AI_API_KEY: 'sk-ant-api03-x' }).provider, 'claude');
  assert.equal(aiConfigFromEnv({ AI_API_KEY: 'AIzaSyX' }).provider, 'gemini');
  assert.equal(aiConfigFromEnv({ AI_API_KEY: 'AQ.Ab8x' }).provider, 'gemini');
  assert.equal(aiConfigFromEnv({ AI_API_KEY: 'sk-0123abc' }).provider, 'deepseek');
  assert.deepEqual(aiConfigFromEnv({ AI_PROVIDER: 'Gemini', AI_API_KEY: 'k', AI_MODEL: 'gemini-4-hydrogen' }),
    { provider: 'gemini', apiKey: 'k', model: 'gemini-4-hydrogen' });
  assert.throws(() => aiConfigFromEnv({ AI_PROVIDER: 'gpt', AI_API_KEY: 'k' }), /claude, gemini, deepseek/);
});

const ONE_QUESTION = (topicId, materialId) => JSON.stringify({ questions: [
  { topic: 'Loops', prompt: 'Loop over 10 items twice: steps?', options: ['20', '100'], answer_index: 0, material_id: materialId, slide: 1, quote: 'loops' },
] });

test('ai: Gemini through the Interactions API, PDF sent inline', async (t) => {
  let ids;
  const requests = [];
  const fetchImpl = async (url, init) => {
    requests.push({ url, headers: init.headers, body: JSON.parse(init.body) });
    if (requests.length === 1) return Response.json({ error: { message: 'high demand', code: 'service_unavailable' } }, { status: 503 });
    return Response.json({ id: 'int_1', status: 'completed', steps: [
      { type: 'thought', summary: [] },
      { type: 'model_output', content: [{ type: 'text', text: ONE_QUESTION(ids.topic, ids.material) }] },
    ] });
  };
  const { call, close } = await start(createAi({ provider: 'gemini', apiKey: 'AIza-test', fetchImpl }));
  t.after(close);
  const { exam, topic, material } = await examWithSlides(call);
  ids = { topic: topic.id, material: material.id };
  await call('POST', `/api/exams/${exam.id}/materials`, { filename: 'l2.pdf', data: Buffer.from('%PDF-1.4').toString('base64') });

  assert.deepEqual((await call('GET', `/api/exams/${exam.id}`)).data.ai, { enabled: true, model: 'gemini-3-flash-preview', label: 'Gemini' });
  const r = await call('POST', `/api/exams/${exam.id}/generate`, {});
  assert.equal(r.status, 200);
  assert.equal(r.data.added, 1);
  assert.deepEqual(requests.map((q) => q.body.model), ['gemini-3-flash-preview', 'gemini-3.8-flash'], 'a busy model falls back');
  const [req] = requests;
  assert.equal(req.url, 'https://generativelanguage.googleapis.com/v1beta/interactions');
  assert.equal(req.headers['x-goog-api-key'], 'AIza-test');
  assert.equal(req.body.response_format.mime_type, 'application/json');
  assert.match(req.body.system_instruction, /practical/);
  const pdf = req.body.input.find((i) => i.type === 'document');
  assert.equal(pdf.mime_type, 'application/pdf');
  assert.equal(Buffer.from(pdf.data, 'base64').toString(), '%PDF-1.4');
  assert.match(req.body.input.at(-1).text, /Write 10 questions/);
});

test('ai: DeepSeek uploads PDFs to its Files API and uses JSON mode', async (t) => {
  let ids;
  const requests = [];
  const fetchImpl = async (url, init) => {
    if (url.endsWith('/files')) {
      requests.push({ url, form: init.body });
      return Response.json({ id: 'file-abc' });
    }
    requests.push({ url, headers: init.headers, body: JSON.parse(init.body) });
    return Response.json({ choices: [{ finish_reason: 'stop', message: { content: ONE_QUESTION(ids.topic, ids.material) } }] });
  };
  const { call, close } = await start(createAi({ provider: 'deepseek', apiKey: 'sk-ds', fetchImpl }));
  t.after(close);
  const { exam, topic, material } = await examWithSlides(call);
  ids = { topic: topic.id, material: material.id };
  await call('POST', `/api/exams/${exam.id}/materials`, { filename: 'l2.pdf', data: Buffer.from('%PDF-1.4').toString('base64') });

  const r = await call('POST', `/api/exams/${exam.id}/generate`, {});
  assert.equal(r.status, 200);
  assert.equal(r.data.added, 1);
  const [upload, chat] = requests;
  assert.equal(upload.url, 'https://api.deepseek.com/files');
  assert.equal(upload.form.get('purpose'), 'text_recognition');
  assert.equal(chat.url, 'https://api.deepseek.com/chat/completions');
  assert.equal(chat.headers.authorization, 'Bearer sk-ds');
  assert.deepEqual(chat.body.response_format, { type: 'json_object' });
  assert.match(chat.body.messages[0].content, /json/);
  assert.deepEqual(chat.body.messages[1].content.find((c) => c.type === 'file'), { type: 'file', file_id: 'file-abc' });

  // A cut-off answer gives a clear error instead of a broken question list.
  const cut = await start(createAi({ provider: 'deepseek', apiKey: 'k', fetchImpl: async () => Response.json({ choices: [{ finish_reason: 'length', message: { content: '{"questions":[' } }] }) }));
  t.after(cut.close);
  const e = await examWithSlides(cut.call);
  const res = await cut.call('POST', `/api/exams/${e.exam.id}/generate`, {});
  assert.equal(res.status, 502);
  assert.match(res.data.error, /обірвалася/);
});

test('ai: a model that never answers falls back, and a final timeout is a clear error', async (t) => {
  t.mock.method(console, 'error', () => {});
  const timeout = () => { throw Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError' }); };
  let ids;
  const models = [];
  const hangsOnce = async (url, init) => {
    const body = JSON.parse(init.body);
    models.push(body.model);
    if (models.length === 1) timeout();
    return Response.json({ status: 'completed', steps: [{ type: 'model_output', content: [{ type: 'text', text: ONE_QUESTION(ids.topic, ids.material) }] }] });
  };
  const ok = await start(createAi({ provider: 'gemini', apiKey: 'k', fetchImpl: hangsOnce }));
  t.after(ok.close);
  const a = await examWithSlides(ok.call);
  ids = { topic: a.topic.id, material: a.material.id };
  assert.equal((await ok.call('POST', `/api/exams/${a.exam.id}/generate`, { count: 1 })).data.added, 1);
  assert.deepEqual(models, ['gemini-3-flash-preview', 'gemini-3.8-flash']);

  const never = await start(createAi({ provider: 'deepseek', apiKey: 'k', fetchImpl: async () => timeout() }));
  t.after(never.close);
  const b = await examWithSlides(never.call);
  const r = await never.call('POST', `/api/exams/${b.exam.id}/generate`, { count: 1 });
  assert.equal(r.status, 504);
  assert.match(r.data.error, /надто довго/);
});

test('slides: a slide full of unclosed paragraphs is read in linear time', () => {
  const slide = `<p:sld>${'<a:p>'.repeat(200_000)}<a:p><a:r><a:t>Real text</a:t></a:r></a:p></p:sld>`;
  const started = Date.now();
  const slides = pptxSlides(zip({ 'ppt/slides/slide1.xml': slide }));
  assert.ok(Date.now() - started < 1000, `took ${Date.now() - started} ms`);
  assert.equal(slides[0].text, 'Real text');
});

test('ai: explanations come with generated questions and on demand for the rest, once', async (t) => {
  let materialId;
  const claude = fakeClaude((body) => {
    if (/explain one practice exam question/.test(body.system)) {
      return { stop_reason: 'end_turn', content: [{ type: 'text', text: JSON.stringify({ explanation: 'Because sin x ≈ x near 0.' }) }] };
    }
    return { stop_reason: 'end_turn', content: [{ type: 'text', text: JSON.stringify({ questions: [
      { topic: 'Big O', prompt: 'AI question', options: ['a', 'b'], answer_index: 0, explanation: 'Because a.', material_id: materialId, slide: 1, quote: 'q' },
    ] }) }] };
  });
  const { call, close } = await start(createAi({ apiKey: 'k', fetchImpl: claude.fetchImpl }));
  t.after(close);
  const { exam, topic, material } = await examWithSlides(call);
  materialId = material.id;

  await call('POST', `/api/exams/${exam.id}/generate`, { count: 1 });
  assert.match(claude.requests[0].body.system, /explanation/);
  const manual = (await call('POST', `/api/topics/${topic.id}/questions`, { prompt: 'lim sin(x)/x at 0?', options: ['0', '1'], answerIndex: 1 })).data;
  const own = (await call('POST', `/api/topics/${topic.id}/questions`, { prompt: 'Own', options: ['x', 'y'], answerIndex: 0, explanation: 'My own words.' })).data;

  const byPrompt = (qs) => Object.fromEntries(qs.map((q) => [q.prompt, q.explanation]));
  const test = (await call('GET', `/api/exams/${exam.id}/test`)).data.questions;
  assert.deepEqual(byPrompt(test), { 'AI question': 'Because a.', 'lim sin(x)/x at 0?': '', Own: 'My own words.' });

  // A question without one gets it from the AI once; the second ask is served from the database.
  const first = await call('POST', `/api/questions/${manual.id}/explain`, {});
  assert.deepEqual(first.data, { explanation: 'Because sin x ≈ x near 0.' });
  const explainCalls = () => claude.requests.filter((r) => /explain one practice/.test(r.body.system)).length;
  assert.equal(explainCalls(), 1);
  assert.match(claude.requests.at(-1).body.messages[0].content.at(-1).text, /Correct answer: B\) 1/);
  await call('POST', `/api/questions/${manual.id}/explain`, {});
  assert.equal(explainCalls(), 1, 'cached');
  assert.equal((await call('POST', `/api/questions/${own.id}/explain`, {})).data.explanation, 'My own words.');
  assert.equal(explainCalls(), 1, 'a written explanation is never replaced');

  // Changing the answer drops an explanation that may be wrong now; sending one keeps it.
  await call('PUT', `/api/questions/${manual.id}`, { prompt: 'lim sin(x)/x at 0?', options: ['0', '1'], answerIndex: 0 });
  assert.equal(byPrompt((await call('GET', `/api/exams/${exam.id}/test`)).data.questions)['lim sin(x)/x at 0?'], '');
  await call('PUT', `/api/questions/${own.id}`, { prompt: 'Own', options: ['x', 'y'], answerIndex: 1, explanation: 'Now y.' });
  assert.equal(byPrompt((await call('GET', `/api/exams/${exam.id}/test`)).data.questions).Own, 'Now y.');

});

test('ai: deadlines from a message, dated from when it was sent, with the answer cleaned up', async () => {
  const requests = [];
  const fetchImpl = async (url, init) => {
    requests.push(JSON.parse(init.body));
    return Response.json({ status: 'completed', steps: [{ type: 'model_output', content: [{ type: 'text', text: JSON.stringify({ deadlines: [
      { title: '  Есе   з етики ', course: 'Етика', url: 'https://learn.example/a/7', date: '2026-11-20', time: '23:59' },
      { title: 'Тест', course: '', url: 'not a link', date: '20.11', time: 'вечір' },
      { title: '', course: '', url: '', date: '2026-11-21', time: '' },
    ] }) }] }] });
  };
  const ai = createAi({ provider: 'gemini', apiKey: 'k', fetchImpl });
  const found = await ai.extractDeadlines({ text: 'Есе до п’ятниці', sentAt: Date.UTC(2026, 10, 14, 12, 0) });
  assert.deepEqual(found, [
    { title: 'Есе з етики', course: 'Етика', url: 'https://learn.example/a/7', date: '2026-11-20', time: '23:59' },
    { title: 'Тест', course: '', url: '', date: '', time: '' },
  ], 'bad links and dates are dropped, never guessed; a deadline without a title is skipped');
  assert.match(requests[0].input.at(-1).text, /^Message sent: Saturday, 2026-11-14 14:00 \(Kyiv time\)\n\nMessage:\nЕсе до п’ятниці/);
  assert.match(requests[0].system_instruction, /Never invent a date/);
  assert.deepEqual(requests[0].response_format.schema.required, ['deadlines']);
});
