const express = require('express');
const { chromium } = require('playwright');
const fs = require('fs');
const XLSX = require('xlsx');
const cors = require('cors');
require('dotenv').config();

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static('public'));

const DATA_FILE = 'data.json';
const SESSION_DIR = 'instagram_session';
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;

function loadData() {
  if (fs.existsSync(DATA_FILE)) return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
  return [];
}

function saveData(data) {
  fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2));
}

async function scrapeInstagram(url) {
  const cleanUrl = url.split('?')[0].split('#')[0];
  if (!cleanUrl.includes('instagram.com')) throw new Error('올바른 Instagram URL이 아닙니다');

  const isFirstTime = !fs.existsSync(SESSION_DIR);

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

    // 로그인 페이지면 사용자가 로그인할 때까지 대기
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
    `https://generativelanguage.googleapis.com/v1beta/models/gemini-3.1-flash-lite:generateContent?key=${GEMINI_API_KEY}`,
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
  console.log('[Gemini] 응답 전체:', JSON.stringify(data, null, 2));

  if (data.error) {
    throw new Error(`Gemini API 오류: ${data.error.message} (코드: ${data.error.code})`);
  }

  if (data.promptFeedback?.blockReason) {
    throw new Error(`Gemini 콘텐츠 차단: ${data.promptFeedback.blockReason}`);
  }

  if (!data.candidates?.[0]) {
    throw new Error('Gemini 응답 없음 - candidates 배열이 비어있음');
  }

  const candidate = data.candidates[0];

  if (!candidate.content?.parts?.[0]?.text) {
    throw new Error(`Gemini 응답 내용 없음 - finishReason: ${candidate.finishReason}`);
  }

  const text = candidate.content.parts[0].text.trim();
  console.log('[Gemini] 응답 텍스트:', text);

  // 마크다운 코드블록 제거
  const cleaned = text.replace(/```json/g, '').replace(/```/g, '').trim();
  const jsonMatch = cleaned.match(/\{[\s\S]*\}/);
  if (!jsonMatch) throw new Error('AI 응답 파싱 실패: ' + cleaned.substring(0, 100));
  try {
    return JSON.parse(jsonMatch[0]);
  } catch (e) {
    throw new Error('JSON 파싱 오류: ' + jsonMatch[0].substring(0, 100));
  }
}

app.get('/api/data', (req, res) => {
  res.json(loadData());
});

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

      const allData = loadData();
      const existingIndex = allData.findIndex(d => d.username === result.username);
      if (existingIndex >= 0) {
        allData[existingIndex] = result;
      } else {
        allData.push(result);
      }
      saveData(allData);
      results.push(result);

      // URL 사이 딜레이 (차단 방지)
      if (urls.indexOf(url) < urls.length - 1) {
        await new Promise(resolve => setTimeout(resolve, 3000));
      }
    } catch (err) {
      errors.push({ url, error: err.message });
    }
  }

  res.json({ success: true, results, errors });
});

app.get('/api/export', (req, res) => {
  const data = loadData();
  const rows = data.map(d => ({
    '아이디': d.username || '',
    '표시명': d.displayName || '',
    '이메일': d.email || '',
  }));

  const wb = XLSX.utils.book_new();
  const ws = XLSX.utils.json_to_sheet(rows);

  // 열 너비 설정
  ws['!cols'] = [
    { wch: 20 },
    { wch: 20 },
    { wch: 30 },
  ];

  // 모든 셀 폰트 사이즈 9pt 설정
  const range = XLSX.utils.decode_range(ws['!ref']);
  for (let R = range.s.r; R <= range.e.r; R++) {
    for (let C = range.s.c; C <= range.e.c; C++) {
      const cellRef = XLSX.utils.encode_cell({ r: R, c: C });
      if (!ws[cellRef]) continue;
      if (!ws[cellRef].s) ws[cellRef].s = {};
      ws[cellRef].s.font = { sz: 9 };
    }
  }

  XLSX.utils.book_append_sheet(wb, ws, '인플루언서 목록');
  const buffer = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx', cellStyles: true });

  res.setHeader('Content-Disposition', 'attachment; filename=influencers.xlsx');
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.send(buffer);
});

app.delete('/api/data/:username', (req, res) => {
  const allData = loadData();
  const filtered = allData.filter(d => d.username !== req.params.username);
  saveData(filtered);
  res.json({ success: true });
});

app.post('/api/reset-session', (req, res) => {
  if (fs.existsSync(SESSION_DIR)) {
    fs.rmSync(SESSION_DIR, { recursive: true });
  }
  res.json({ success: true, message: '세션 초기화 완료. 다음 분석 시 다시 로그인해주세요.' });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`✅ 서버 시작됨! PORT: ${PORT}`);
  console.log(`👉 브라우저에서 http://localhost:${PORT} 접속하세요`);
});