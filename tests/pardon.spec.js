import { test, expect } from '@playwright/test';

const fakeTranscript = '쿠키 세션은\n브라우저 상태를 관리합니다.';
const fakeVariants = [
  {
    id: 'possibility-1',
    label: '제안 1 · 오인식 보정',
    text: '쿠키 세션은 브라우저 상태를 관리합니다.'
  },
  {
    id: 'possibility-2',
    label: '제안 2 · 문맥 교정',
    text: '쿠키와 세션은 브라우저에서 상태를 관리합니다.'
  },
  {
    id: 'possibility-3',
    label: '제안 3 · 매끄러운 문장',
    text: '브라우저는 쿠키와 세션으로 상태를 관리합니다.'
  }
];

function installBrowserMocks(page) {
  return page.addInitScript(({ fakeTranscript, fakeVariants }) => {
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
              0: { transcript: fakeTranscript },
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
        transcribeAudioBlob: async () => fakeTranscript,
        fetchRewriteVariants: async () => fakeVariants,
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
  }, { fakeTranscript, fakeVariants });
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
  await expect(page.getByRole('textbox', { name: '실시간 원문' })).toHaveValue(fakeTranscript);

  await page.getByRole('button', { name: '정지' }).click();
  const sttButton = page.getByRole('button', { name: 'STT', exact: true });
  await expect(sttButton).toBeEnabled();

  await sttButton.click();
  await expect(page.locator('#recorded-transcript')).toHaveText(fakeTranscript);
  await expect(page.locator('#comparison-recorded .transcript-surface__text')).toHaveText(fakeTranscript);


  await page.getByRole('button', { name: '변환' }).click();
  await expect(page.getByText('제안 1 · 오인식 보정')).toBeVisible();
  await expect(page.getByText('제안 2 · 문맥 교정')).toBeVisible();
  await expect(page.getByText('제안 3 · 매끄러운 문장')).toBeVisible();

  await page.getByRole('button', { name: '확정' }).first().click();
  await expect(page.getByText('브라우저는 쿠키와 세션으로 상태를 관리합니다.')).toBeVisible();

  expect(errors).toEqual([]);
});
