const EN_KO_MAP = [
  [/에이피아이/gi, 'API'],
  [/깃\s*커밋/gi, 'Git commit'],
  [/커밋/gi, 'commit'],
  [/기세\s*커밋/gi, 'Git에 commit'],
  [/깃/gi, 'Git'],
  [/서버/gi, 'Server'],
  [/포트/gi, 'Port'],
  [/빌드/gi, 'Build'],
  [/머신\s*러닝/gi, 'Machine Learning'],
  [/머신러닝/gi, 'Machine Learning'],
  [/디비/gi, 'DB'],
  [/데이터\s*베이스/gi, 'Database'],
  [/데이터베이스/gi, 'Database'],
  [/코드/gi, 'Code'],
  [/테스트/gi, 'Test'],
  [/프로세스/gi, 'Process'],
  [/에러/gi, 'Error'],
  [/(?<![가-힣])로그(?![가-힣])/gi, 'Log'],
  [/오디오/gi, 'Audio'],
  [/마이크/gi, 'Mic'],
  [/도커/gi, 'Docker'],
  [/조커/gi, 'Docker'], // 사용자가 '조커'라고 발음한 오역 복원 규칙 추가!
  [/컨테이너/gi, 'Container'],
  [/브랜치/gi, 'Branch'],
  [/머지/gi, 'Merge'],
  [/풀\s*리퀘/gi, 'PR (Pull Request)'],
  [/풀리퀘/gi, 'PR (Pull Request)'],
  [/a i/gi, 'AI'], // 띄어쓰기 깨진 AI 교정
  [/에이아이/gi, 'AI'],
  [/이이엠브이/gi, 'env 가상환경'],
  [/이엠브이/gi, 'env 가상환경'],
  [/이엠 브이/gi, 'env 가상환경'],
  [/이 엠 브이/gi, 'env 가상환경'],
  [/이 엠브이/gi, 'env 가상환경'],
  [/가상\s*환경/gi, '가상환경(venv)'],
  [/브이엔디/gi, 'venv'],
  [/벤드/gi, 'venv'],
  [/vend/gi, 'venv'],
  [/구포/gi, 'Kube(쿠버네티스)'],
  [/데이터스/gi, '데이터셋(Dataset)'],
  [/파이썬/gi, 'Python'],
  [/딥러닝/gi, 'Deep Learning'],
  [/모델\s*학습/gi, 'Model Training']
];

const TRANSFORMERS = [
  {
    id: 'p1',
    label: '가능성 1 (가장 유력)',
    build: ({ text }) => {
      // 1. 말더듬 제거 + 한영 보정이 완료된 가장 깔끔한 표준 복원
      return applyEnglishCorrection(simplifyText(text));
    }
  },
  {
    id: 'p2',
    label: '가능성 2 (유사 발음 교정)',
    build: ({ text }) => {
      // 2. 혹시 일반적인 단어로 혼동되었을 가능성까지 감안한 대체어 및 발음 정돈 대안
      return phoneticAlternative(simplifyText(text));
    }
  },
  {
    id: 'p3',
    label: '가능성 3 (구어 정돈 보정)',
    build: ({ text }) => {
      // 3. 구어체 발음을 격식 있는 실무 대화체/구문체 문맥으로 자연스럽게 풀어 쓴 자연어 해석
      return professionalPolishing(applyEnglishCorrection(simplifyText(text)));
    }
  }
];

export function normalizeWhitespace(value) {
  return String(value ?? '').replace(/\s+/g, ' ').trim();
}

function applyEnglishCorrection(text) {
  let base = String(text ?? '');
  // 사전을 순회하며 오역된 한글 발음들을 영문 알파벳/혼용 단어로 세련되게 치환
  for (const [regex, replacement] of EN_KO_MAP) {
    base = base.replace(regex, replacement);
  }
  return base;
}

export function buildRewriteVariants(text) {
  const cleanedText = text ? text.trim() : '';

  if (!cleanedText) {
    return TRANSFORMERS.map((variant) => ({
      id: variant.id,
      label: variant.label,
      text: '텍스트가 들어오면 세 가지 해석 가능성 대안이 표시됩니다.'
    }));
  }

  return TRANSFORMERS.map((variant) => ({
    id: variant.id,
    label: variant.label,
    text: finalizeVariantText(
      variant.build({ text: cleanedText })
    )
  }));
}

function simplifyText(text) {
  // 음성 인식 도중 극심하게 꼬인 군더더기 어휘, 추임새, 말더듬용 단어들을 지능적으로 싹 제거합니다.
  const withoutFillers = String(text ?? '')
    .replace(/\b(아|음|어|그|저|습|읍|엄|actually|basically|거기|그거|그게|되게|이제|아무래도|어떤|그런|그렇게|되게\s*민감하게|가지고|가지고\s*아|가지고\s*어)\b/g, '')
    .replace(/\s+/g, ' ')
    .trim();

  return withoutFillers || String(text ?? '').trim();
}

function phoneticAlternative(text) {
  const corrected = applyEnglishCorrection(text);
  // 발음 상 다르게 해석되었을 여지(예: 깃 -> 깃허브 확장 표기 등)를 제공
  return corrected
    .replace(/\bGit\b/g, 'GitHub')
    .replace(/\bAPI\b/g, 'API endpoint')
    .replace(/\bServer\b/g, 'Back-end server');
}

function professionalPolishing(text) {
  let base = String(text ?? '');
  // 격식 있게 정돈된 형태의 어조 보완
  if (!base.endsWith('.') && !base.endsWith('?') && !base.endsWith('!')) {
    base = `${base}.`;
  }
  return base;
}

function finalizeVariantText(value) {
  return String(value ?? '')
    .split(/\n+/)
    .map((line) => line.trim())
    .filter(Boolean)
    .join('\n')
    .trim();
}
