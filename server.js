import http from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// 외부 의존성 없이 로컬 .env 파일의 환경변수를 process.env에 주입하는 초경량 수동 로더
try {
  const envText = readFileSync('.env', 'utf8');
  for (const line of envText.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const [key, ...val] = trimmed.split('=');
    if (key && val.length) {
      process.env[key.trim()] = val.join('=').trim();
    }
  }
} catch {
  // .env 파일이 없으면 시스템 환경변수(Windows OS)를 그대로 활용
}

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const root = __dirname;
const port = Number(process.env.PORT || 3000);

const mimeTypes = new Map([
  ['.html', 'text/html; charset=utf-8'],
  ['.css', 'text/css; charset=utf-8'],
  ['.js', 'text/javascript; charset=utf-8'],
  ['.json', 'application/json; charset=utf-8'],
  ['.svg', 'image/svg+xml'],
  ['.png', 'image/png'],
  ['.jpg', 'image/jpeg'],
  ['.jpeg', 'image/jpeg'],
  ['.webp', 'image/webp'],
  ['.ico', 'image/x-icon']
]);

function contentTypeFor(filePath) {
  return mimeTypes.get(path.extname(filePath).toLowerCase()) || 'application/octet-stream';
}

function resolvePath(urlPath) {
  const cleanPath = decodeURIComponent(urlPath.split('?')[0] || '/');
  const safeRelative = path
    .normalize(cleanPath)
    .replace(/^([.]{2}[\/\\])+/, '')
    .replace(/^[\/\\]+/, '');
  const resolved = path.resolve(root, safeRelative || 'index.html');
  return resolved.toLowerCase().startsWith(root.toLowerCase()) ? resolved : null;
}

async function pickAsset(urlPath) {
  const resolved = resolvePath(urlPath);
  if (!resolved) return null;

  try {
    const fileStat = await stat(resolved);
    if (fileStat.isDirectory()) {
      return path.join(resolved, 'index.html');
    }
    return resolved;
  } catch {
    if (path.extname(resolved)) {
      return null;
    }
    return path.join(root, 'index.html');
  }
}

// 순수 Node.js만으로 WebM 바이너리 파일을 FormData 규격에 맞게 빌드해 OpenAI Whisper API로 쏘는 헬퍼
async function callOpenAIWhisper(audioBuffer) {
  const apiKey = process.env.OPENAI_API_KEY || '';
  if (!apiKey) throw new Error('서버에 OpenAI API Key 설정이 필요합니다. (.env 확인)');

  const boundary = '----WebKitFormBoundaryPardonSTT' + Math.random().toString(36).substring(2);
  
  const header = 
    `--${boundary}\r\n` +
    `Content-Disposition: form-data; name="file"; filename="recording.webm"\r\n` +
    `Content-Type: audio/webm\r\n\r\n`;
  const modelPart = 
    `\r\n--${boundary}\r\n` +
    `Content-Disposition: form-data; name="model"\r\n\r\nwhisper-1`;
  const languagePart = 
    `\r\n--${boundary}\r\n` +
    `Content-Disposition: form-data; name="language"\r\n\r\nko`;
  const promptPart = 
    `\r\n--${boundary}\r\n` +
    `Content-Disposition: form-data; name="prompt"\r\n\r\nSQLD, ADsP, 블로그, API, Git, commit, Docker, Database, 포트, 서버, 깃 커밋`;
  const footer = `\r\n--${boundary}--\r\n`;

  const multipartBody = Buffer.concat([
    Buffer.from(header),
    audioBuffer,
    Buffer.from(modelPart),
    Buffer.from(languagePart),
    Buffer.from(promptPart),
    Buffer.from(footer)
  ]);

  const response = await fetch('https://api.openai.com/v1/audio/transcriptions', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': `multipart/form-data; boundary=${boundary}`
    },
    body: multipartBody
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Whisper API Error: ${text}`);
  }

  const data = await response.json();
  return data.text || '';
}

// OpenAI Chat Completion API를 호출하여 지능형 문맥 및 영한 혼용 3가지 가능성을 빌드하는 헬퍼
async function callOpenAIGPT(transcript, hint) {
  const apiKey = process.env.OPENAI_API_KEY || '';
  if (!apiKey) throw new Error('서버에 OpenAI API Key 설정이 필요합니다. (.env 확인)');

  const systemContent = `화자는 한국어와 영어를 수시로 혼용하는 IT 엔지니어/개발자입니다.
브라우저 무료 STT의 한계로 인해, 전문 기술 영단어들이 무차별적으로 억지스러운 한국어 발음(예: "조커" -> "Docker", "이엠브이/EM v" -> "env", "벤드/vend/브이엔디" -> "venv", "에이아이/a i" -> "AI", "구포" -> "Kube/쿠버네티스", "디비" -> "DB", "입원" -> "이번")이나 띄어쓰기 오류로 엉망진창 깨져서 오인식되었을 확률이 100%입니다.

[분석 핵심 임무]
입력된 원문에서 이러한 억지 발음 오류나 오타를 귀신같이 간파하여, 화자가 원래 의도했던 "올바른 전문 IT 기술 영단어가 세련되게 혼용된 고급 자연어 문장"으로 재구성해야 합니다.

${hint ? `[중요 주제/용어 힌트 적용]: "${hint}"
위 힌트 주제와 적극 부합하는 기술 전문 지식(예: SQLD, Docker, venv 가상환경, API, Git 등)을 총동원하여 문맥을 날카롭게 특정하고 복원하십시오.` : ''}

반환 양식은 아래의 3가지 대안을 지닌 엄격한 JSON 형태입니다. (키: p1, p2, p3)

- p1 (가능성 1: 가장 유력): 원래의 문장 형태나 맥락 흐름을 훼손하지 않는 범위 내에서, 오직 꼬인 발음 에러(조커->Docker, a i->AI, vend->venv 등)와 오타만 올바른 원어 믹스 형태로 정확하게 복구한 정통 교정 문장
- p2 (가능성 2: 유사 발음 교정): 꼬여서 깨진 발음들을 음성학적 유사성(귀로 들리는 발음 소리) 관점에서 힌트 단어들과 결합하여, 실무적인 한영 믹스체로 교정해 낸 문장
- p3 (가능성 3: 구어 정돈 보정): 중언부언하거나 횡설수설 꼬인 비격식 구어체(예: "~되게 민감하게 얘기가 여기 있는걸...", "~거기 그걸...")의 쓸모없는 군더더기(말더듬, 무의미한 중복 표현)를 싹 제거하고, 힌트 주제에 걸맞은 매끄럽고 극도로 전문적인 비즈니스 실무 문체로 유연하게 요약 정돈한 완성형 문장

설명은 절대로 덧붙이지 말고 오직 JSON(p1, p2, p3)만 리턴하십시오.`;

  const response = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`
    },
    body: JSON.stringify({
      model: 'gpt-4o-mini',
      temperature: 0.3,
      response_format: { type: 'json_object' },
      messages: [
        {
          role: 'system',
          content: systemContent
        },
        {
          role: 'user',
          content: JSON.stringify({ transcript })
        }
      ]
    })
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`GPT API Error: ${text}`);
  }

  const payload = await response.json();
  const content = payload?.choices?.[0]?.message?.content;
  const parsed = JSON.parse(content);

  // 로컬 폴백 텍스트 (API 오류 등으로 대처가 필요할 시 사용)
  const cleanFallback = String(transcript ?? '').trim();

  return [
    { id: 'p1', label: '가능성 1 (가장 유력)', text: parsed?.p1 || cleanFallback },
    { id: 'p2', label: '가능성 2 (유사 발음 교정)', text: parsed?.p2 || cleanFallback },
    { id: 'p3', label: '가능성 3 (구어 정돈 보정)', text: parsed?.p3 || cleanFallback }
  ];
}

const server = http.createServer(async (req, res) => {
  try {
    // 1. Whisper STT 분석 API 엔드포인트
    if (req.url === '/api/transcribe' && req.method === 'POST') {
      const chunks = [];
      req.on('data', (chunk) => chunks.push(chunk));
      req.on('end', async () => {
        try {
          const audioBuffer = Buffer.concat(chunks);
          const whisperText = await callOpenAIWhisper(audioBuffer);
          res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({ text: whisperText }));
        } catch (err) {
          console.error('Whisper API 프록시 오류:', err);
          res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
          res.end(err.message || 'Whisper Proxy Error');
        }
      });
      return;
    }

    // 2. GPT 문맥 해석 API 엔드포인트
    if (req.url === '/api/analyze' && req.method === 'POST') {
      const chunks = [];
      req.on('data', (chunk) => chunks.push(chunk));
      req.on('end', async () => {
        try {
          const body = Buffer.concat(chunks).toString('utf8');
          const { transcript, hint } = JSON.parse(body);
          const variants = await callOpenAIGPT(transcript, hint);
          res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify(variants));
        } catch (err) {
          console.error('GPT API 프록시 오류:', err);
          res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
          res.end(err.message || 'GPT Proxy Error');
        }
      });
      return;
    }

    // 3. 기존 정적 에셋 서빙
    const target = await pickAsset(req.url || '/');

    if (!target) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Not Found');
      return;
    }

    const data = await readFile(target);
    res.writeHead(200, { 'Content-Type': contentTypeFor(target), 'Cache-Control': 'no-store' });
    res.end(data);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end(`Server error: ${message}`);
  }
});

server.listen(port, () => {
  console.log(`Pardon is serving on http://localhost:${port}`);
});
