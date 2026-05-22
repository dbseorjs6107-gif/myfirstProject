const express = require('express');
const { chromium } = require('playwright');
const fs = require('fs');
const ExcelJS = require('exceljs');
const cors = require('cors');
require('dotenv').config();

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static('public'));

const DATA_FILE = 'data.json';
const QUEUE_FILE = 'queue.json';
const SESSION_DIR = 'instagram_session';
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;

// ─── 데이터 관리 ───────────────────────────────────────────
function loadData() {
  if (fs.existsSync(DATA_FILE)) return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
  return [];
}
function saveData(data) {
  fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2));
}

// ─── 큐 관리 ───────────────────────────────────────────────
function loadQueue() {
  if (fs.existsSync(QUEUE_FILE)) return JSON.parse(fs.readFileSync(QUEUE_FILE, 'utf8'));
  return { pending: [], processing: null, errors: [] };
}
function saveQueue(q) {
  fs.writeFileSync(QUEUE_FILE, JSON.stringify(q, null, 2));
}

// ─── Instagram 스크래핑 ────────────────────────────────────
async function scrapeInstagram(url) {
  const cleanUrl = url.split('?')[0].split('#')[0];
  if (!cleanUrl.includes('instagram.com')) throw new Error('올바른 Instagram URL이 아닙니다');

  const isHeadless = process.env.NODE_ENV === 'production' || process.env.HEADLESS === 'true';
  const context = await chromium.launchPersistentContext(SESSION_DIR, {
    headless: isHeadless,
    slowMo: isHeadless ? 0 : 300,
    args: [
      '--no-sandbox',
      '--disable-blink-features=AutomationControlled',
    ],
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    viewport: { width: 1280, height: 800 },
    locale: 'ko-KR',
  });

  await context.addInitScript(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
    window.chrome = { runtime: {} };
  });

  const page = await context.newPage();

  try {
    await page.goto(cleanUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForTimeout(3000);

    if (page.url().includes('accounts/login')) {
      console.log('⚠️  로그인이 필요합니다. 브라우저에서 로그인해주세요...');
      await page.waitForURL(url => !url.includes('accounts/login'), { timeout: 120000 });
      console.log('✅ 로그인 완료! 세션이 저장됩니다.');
      await page.waitForTimeout(3000);
      await page.goto(cleanUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
      await page.waitForTimeout(4000);
    }

    const html = await page.content();
    await context.close();
    return html;
  } catch (err) {
    await context.close();
    throw new Error(err.message);
  }
}

// ─── Gemini 분석 ───────────────────────────────────────────
async function analyzeWithGemini(html, url) {
  const username = url.split('instagram.com/')[1]?.replace(/\/$/, '') || '';

  const titleMatch = html.match(/<meta property="og:title" content="([^"]*?)"/i);
  const descMatch = html.match(/<meta property="og:description" content="([^"]*?)"/i);
  const emailMatch = html.match(/[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}/g);

  const metaData = [
    titleMatch ? '제목: ' + titleMatch[1] : '',
    descMatch ? '설명: ' + descMatch[1] : '',
    emailMatch ? '이메일: ' + emailMatch.filter(e =>
      !e.includes('sentry') && !e.includes('instagram') && !e.includes('facebook')
    )[0] : '',
  ].filter(Boolean).join('\n') || '메타데이터 없음';

  const prompt = `당신은 뷰티/코스메틱 인플루언서 분석 전문가입니다. 아래 Instagram 프로필 데이터를 분석하고 JSON 형식으로만 응답해주세요.

프로필 URL: ${url}
사용자명: ${username}
프로필 메타데이터:
${metaData}

다음 JSON 형식으로만 응답하세요:
{"username":"아이디","displayName":"표시명","followers":"팔로워수","email":"이메일 또는 null","bio":"소개글 또는 null","contentType":"메이크업/스킨케어/헤어/네일/라이프스타일/패션/혼합 중 하나","isReelsFocused":true,"isRecentlyActive":true,"confidence":"high/medium/low"}`;

  const response = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash-latest:generateContent?key=${GEMINI_API_KEY}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: { temperature: 0.1, maxOutputTokens: 500 },
      }),
    }
  );

  const data = await response.json();
  console.log('[Gemini] HTTP 상태:', response.status);

  if (data.error) throw new Error(`Gemini API 오류: ${data.error.message}`);
  if (data.promptFeedback?.blockReason) throw new Error(`Gemini 콘텐츠 차단: ${data.promptFeedback.blockReason}`);
  if (!data.candidates?.[0]?.content?.parts?.[0]?.text) throw new Error(`Gemini 응답 없음`);

  const text = data.candidates[0].content.parts[0].text.trim();
  const cleaned = text.replace(/```json/g, '').replace(/```/g, '').trim();
  const jsonMatch = cleaned.match(/\{[\s\S]*\}/);
  if (!jsonMatch) throw new Error('AI 응답 파싱 실패');
  return JSON.parse(jsonMatch[0]);
}

// ─── 결과 저장 공통 함수 ───────────────────────────────────
function saveResult(result) {
  const allData = loadData();
  const idx = allData.findIndex(d => d.username === result.username);
  if (idx >= 0) allData[idx] = result; else allData.push(result);
  saveData(allData);
}

// ─── 백그라운드 큐 워커 ────────────────────────────────────
let isProcessing = false;

async function processNext() {
  if (isProcessing) return;
  const queue = loadQueue();
  if (queue.pending.length === 0) return;

  isProcessing = true;
  const url = queue.pending.shift();
  queue.processing = url;
  saveQueue(queue);
  console.log(`[큐] 처리 시작: ${url} (남은 대기: ${queue.pending.length}개)`);

  try {
    const html = await scrapeInstagram(url);
    const result = await analyzeWithGemini(html, url.split('?')[0]);
    result.url = url.split('?')[0];
    result.analyzedAt = new Date().toLocaleDateString('ko-KR');
    saveResult(result);
    console.log(`[큐] 완료: @${result.username}`);
  } catch (err) {
    console.error(`[큐] 오류: ${url} - ${err.message}`);
    const q = loadQueue();
    q.errors.push({ url, error: err.message, time: new Date().toISOString() });
    saveQueue(q);
  } finally {
    const q = loadQueue();
    q.processing = null;
    saveQueue(q);
    isProcessing = false;
  }
}

// 60초마다 큐에서 하나씩 처리
setInterval(processNext, 60000);

// ─── API 엔드포인트 ────────────────────────────────────────

// 완료된 데이터 조회
app.get('/api/data', (req, res) => {
  res.json(loadData());
});

// 큐에 URL 추가
app.post('/api/queue', (req, res) => {
  const { urls } = req.body;
  if (!urls || urls.length === 0) return res.status(400).json({ error: 'URL이 필요합니다' });

  const queue = loadQueue();
  const newUrls = urls.filter(u => !queue.pending.includes(u) && queue.processing !== u);
  queue.pending.push(...newUrls);
  saveQueue(queue);
  console.log(`[큐] ${newUrls.length}개 추가됨. 총 대기: ${queue.pending.length}개`);

  res.json({ success: true, added: newUrls.length, total: queue.pending.length });
});

// 큐 상태 조회
app.get('/api/queue/status', (req, res) => {
  const queue = loadQueue();
  const data = loadData();
  res.json({
    pending: queue.pending.length,
    processing: queue.processing,
    completed: data.length,
    errors: (queue.errors || []).length,
  });
});

// 큐 초기화
app.delete('/api/queue', (req, res) => {
  saveQueue({ pending: [], processing: null, errors: [] });
  res.json({ success: true });
});

// 즉시 분석 (로컬 개발용)
app.post('/api/analyze', async (req, res) => {
  const { urls } = req.body;
  if (!urls || urls.length === 0) return res.status(400).json({ error: 'URL이 필요합니다' });

  const results = [];
  const errors = [];

  for (const url of urls) {
    try {
      const html = await scrapeInstagram(url);
      const result = await analyzeWithGemini(html, url.split('?')[0]);
      result.url = url.split('?')[0];
      result.analyzedAt = new Date().toLocaleDateString('ko-KR');
      saveResult(result);
      results.push(result);
      if (urls.indexOf(url) < urls.length - 1) {
        await new Promise(resolve => setTimeout(resolve, 3000));
      }
    } catch (err) {
      errors.push({ url, error: err.message });
    }
  }
  res.json({ success: true, results, errors });
});

// 엑셀 다운로드
app.get('/api/export', async (req, res) => {
  const data = loadData();
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('인플루언서 목록');

  ws.columns = [
    { header: '아이디', key: 'username', width: 20 },
    { header: '표시명', key: 'displayName', width: 20 },
    { header: '이메일', key: 'email', width: 30 },
  ];

  data.forEach(d => {
    ws.addRow({ username: d.username || '', displayName: d.displayName || '', email: d.email || '' });
  });

  ws.eachRow(row => { row.eachCell(cell => { cell.font = { size: 9 }; }); });

  res.setHeader('Content-Disposition', 'attachment; filename=influencers.xlsx');
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  await wb.xlsx.write(res);
  res.end();
});

// 개별 삭제
app.delete('/api/data/:username', (req, res) => {
  const allData = loadData();
  saveData(allData.filter(d => d.username !== req.params.username));
  res.json({ success: true });
});

// 전체 삭제
app.delete('/api/data', (req, res) => {
  saveData([]);
  res.json({ success: true });
});

// 세션 초기화
app.post('/api/reset-session', (req, res) => {
  if (fs.existsSync(SESSION_DIR)) fs.rmSync(SESSION_DIR, { recursive: true });
  res.json({ success: true, message: '세션 초기화 완료. 다음 분석 시 다시 로그인해주세요.' });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`✅ 서버 시작됨! PORT: ${PORT}`);
  console.log(`👉 브라우저에서 http://localhost:${PORT} 접속하세요`);
});
