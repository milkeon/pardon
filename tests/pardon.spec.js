import { test, expect } from '@playwright/test';

const fakeLiveTranscript = '자 이제 잘 되는지 한 번 테스트를 해볼 건데 원문 stt와 녹음 stt에 합치 테스트를 해볼거야';
const fakeRecordedTranscript = '자 이제 잘 되는지 한 번 테스트를 해볼 건데 원문 stt와 녹음 stt에 압치 테스트를 해볼거야';
const fakeVariants = [
  {
    id: 'possibility-1',
    label: '제안 1 · 문맥 교정(보수적)',
    text: '쿠키 세션은 브라우저 상태를 관리합니다.'
  },
  {
    id: 'possibility-2',
    label: '제안 2 · 문맥 교정(균형형)',
    text: '쿠키와 세션은 브라우저에서 상태를 관리합니다.'
  },
  {
    id: 'possibility-3',
    label: '제안 3 · 문맥 교정(과감형)',
    text: '브라우저는 쿠키와 세션으로 상태를 관리합니다.'
  }
];

function installBrowserMocks(page, {
  liveTranscript = fakeLiveTranscript,
  recordedTranscript = fakeRecordedTranscript,
  variants = fakeVariants
} = {}) {
  return page.addInitScript(({ liveTranscript, recordedTranscript, variants }) => {
    const makeEmitter = () => {
      const handlers = new Map();
      return {
        addEventListener(type, handler) {
          if (!handlers.has(type)) handlers.set(type, []);
          handlers.get(type).push(handler);
        },
        dispatch(type, event) {
          for (const handler of handlers.get(type) || []) {
            handler(event);
          }
          const prop = `on${type}`;
          if (typeof this[prop] === 'function') {
            this[prop](event);
          }
        }
      };
    };

    class FakeSpeechRecognition {
      constructor() {
        this.continuous = false;
        this.interimResults = false;
        this.lang = 'ko-KR';
        this.started = false;
      }

      start() {
        this.started = true;
        const event = {
          resultIndex: 0,
          results: [
            {
              0: { transcript: liveTranscript },
              isFinal: true
            }
          ]
        };
        queueMicrotask(() => {
          this.onresult?.(event);
        });
      }

      stop() {
        this.started = false;
        queueMicrotask(() => {
          this.onend?.();
        });
      }

      abort() {
        this.started = false;
      }
    }

    class FakeMediaRecorder {
      constructor(stream, options = {}) {
        this.stream = stream;
        this.options = options;
        this.state = 'inactive';
        this.mimeType = options.mimeType || 'audio/webm';
        this._emitter = makeEmitter();
      }

      addEventListener(type, handler) {
        this._emitter.addEventListener(type, handler);
      }

      start() {
        this.state = 'recording';
        const chunk = new Blob(['fake-audio-chunk'], { type: this.mimeType });
        queueMicrotask(() => {
          this._emitter.dispatch('dataavailable', { data: chunk });
        });
      }

      stop() {
        this.state = 'inactive';
        queueMicrotask(() => {
          this._emitter.dispatch('stop', {});
        });
      }
    }

    FakeMediaRecorder.isTypeSupported = (type) => type === 'audio/flac' || type === 'audio/webm' || type === 'audio/webm;codecs=opus';

    Object.defineProperty(window, '__PARDON_TEST_HOOKS__', {
      value: {
        transcribeAudioBlob: async () => recordedTranscript,
        fetchRewriteVariants: async () => variants,
        fetchConfirmationSummary: async () => ({
          title: '확정 요약',
          summary: '브라우저는 쿠키와 세션으로 상태를 관리합니다.'
        })
      },
      configurable: true
    });

    Object.defineProperty(navigator, 'mediaDevices', {
      value: {
        getUserMedia: async () => ({
          getTracks: () => [{ stop() {} }]
        })
      },
      configurable: true
    });

    window.SpeechRecognition = FakeSpeechRecognition;
    window.webkitSpeechRecognition = FakeSpeechRecognition;
    window.MediaRecorder = FakeMediaRecorder;
  }, { liveTranscript, recordedTranscript, variants });
}

test('Pardon은 콘솔 에러 없이 기본 UI를 렌더한다', async ({ page }) => {
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text());
  });

  await page.goto('/');

  await expect(page.getByRole('heading', { name: 'Pardon' })).toBeVisible();
  await expect(page.getByRole('button', { name: '녹음 시작' })).toBeVisible();
  await expect(page.getByRole('button', { name: '변환' })).toBeVisible();
  await expect(page.getByText('MediaRecorder: 지원됨')).toBeVisible();
  await expect(page.getByText('SpeechRecognition: 지원됨')).toBeVisible();

  expect(errors).toEqual([]);
});

test('Pardon은 녹음 → 정지 → STT → 변환 → 확정 흐름을 테스트 더블로 실행한다', async ({ page }) => {
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text());
  });

  await installBrowserMocks(page);
  await page.goto('/');

  await page.getByRole('button', { name: '녹음 시작' }).click();
  await expect(page.getByRole('button', { name: '정지' })).toBeEnabled();
  await expect(page.getByRole('textbox', { name: '실시간 원문' })).toHaveValue(fakeLiveTranscript);

  await page.getByRole('button', { name: '정지' }).click();
  const sttButton = page.getByRole('button', { name: 'STT', exact: true });
  await expect(sttButton).toBeEnabled();

  await sttButton.click();
  await expect(page.locator('#recorded-transcript')).toContainText('압치');
  await expect(page.locator('#recovered-transcript')).toContainText('합치');

  await page.getByRole('button', { name: '변환' }).click();
  await expect(page.locator('#variant-list .variant-card')).toHaveCount(3);
  await expect(page.locator('.variant-card__label').nth(0)).toHaveText('제안 1 · 문맥 교정(보수적)');
  await expect(page.locator('.variant-card__label').nth(1)).toHaveText('제안 2 · 문맥 교정(균형형)');
  await expect(page.locator('.variant-card__label').nth(2)).toHaveText('제안 3 · 문맥 교정(과감형)');
  await expect(page.locator('#confirmed-summary')).toContainText('쿠키 세션은 브라우저 상태를 관리합니다.');

  await page.locator('[data-action="choose-variant"]').nth(1).click();
  await expect(page.locator('[data-action="choose-variant"]').nth(1)).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('#confirmed-summary')).toContainText('쿠키와 세션은 브라우저에서 상태를 관리합니다.');

  await page.locator('[data-action="choose-variant"]').nth(2).click();
  await expect(page.locator('[data-action="choose-variant"]').nth(2)).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('#confirmed-summary')).toContainText('브라우저는 쿠키와 세션으로 상태를 관리합니다.');

  expect(errors).toEqual([]);
});

test('Pardon은 녹음 STT가 무의미하면 실시간 원문을 기준으로 복구해 보여준다', async ({ page }) => {
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text());
  });

  const liveTranscript = '보통 검색은 어디서 하냐면 목록 보기에서 하잖아요. 이런 UI에서는 검색바가 추가되겠죠.';
  await installBrowserMocks(page, {
    liveTranscript,
    recordedTranscript: '[냉냉]',
    variants: [
      { id: 'possibility-1', label: '제안 1 · 문맥 교정(보수적)', text: '보통 검색은 목록 보기에서 하고 이런 UI에서는 검색바가 추가되겠죠.' },
      { id: 'possibility-2', label: '제안 2 · 문맥 교정(균형형)', text: '보통 검색은 목록 보기에서 하고 이런 UI에는 검색바를 추가하면 되겠죠.' },
      { id: 'possibility-3', label: '제안 3 · 문맥 교정(과감형)', text: '이런 UI에서는 목록 보기 옆에 검색바를 추가하면 됩니다.' }
    ]
  });
  await page.goto('/');

  await page.getByRole('button', { name: '녹음 시작' }).click();
  await page.getByRole('button', { name: '정지' }).click();
  await page.getByRole('button', { name: 'STT', exact: true }).click();

  await expect(page.locator('#recorded-transcript')).toContainText('[냉냉]');
  await expect(page.locator('#recovered-transcript')).toContainText('검색바');
  await expect(page.locator('#recovered-transcript')).not.toContainText('[냉냉]');
  await expect(page.locator('#transcript-status')).toContainText('복구했습니다');

  expect(errors).toEqual([]);
});
